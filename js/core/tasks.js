// ==========================================
// tasks.js: runnable build and test commands from `.codemini/tasks.json`, UI/UX specs feature 2
// ==========================================
// A task is a named thing to run, kept in the workspace's `.codemini/tasks.json` (see codemini-config.js) so it travels with the project:
//
//   { "$schema": "codemini://schema/tasks.json", "version": 1, "tasks": [
//       { "label": "Build", "group": "build", "default": true, "command": "node scripts/build.js" },
//       { "label": "Test",  "group": "test",  "command": "python tests/run.py" },
//       { "label": "Hello", "lang": "python", "script": "print('hi')" } ] }
//
// What "command" can be: there is no shell and no npm here, so a command is `<interpreter> <file>` with the interpreter one of node, python,
// python3, php, ruby, Rscript, sql, and the file a path in the workspace. `script` (with `lang`) is code to run as it stands. Both run in the
// isolated runner, on the same host as the Terminal and Console, and nowhere else: a task never runs inside CodeMini's own page.
//
// Safety (spec): in Restricted Mode (an untrusted workspace) tasks are listed but never run. One task runs at a time. Output is plain text.
//
// The pure rules and the run core (which works on an injected environment) are exported for Node (tests/tasks.test.js); the browser half draws the
// sidebar, the Tasks tab of the bottom panel, the status-bar item and the commands.
(function (root) {
    'use strict';
    const W = root;

    // ---------------------------------------------------------------------------------------------
    // Pure
    // ---------------------------------------------------------------------------------------------
    const GROUPS = { build: { label: 'BUILD', icon: 'ri-hammer-line' }, test: { label: 'TEST', icon: 'ri-test-tube-line' }, custom: { label: 'CUSTOM', icon: 'ri-terminal-box-line' } };
    const GROUP_ORDER = ['build', 'test', 'custom'];
    // interpreter -> the language the isolated host runs
    const INTERPRETERS = { node: 'javascript', python: 'python', python3: 'python', py: 'python', php: 'php', ruby: 'ruby', rscript: 'r', sql: 'sql' };
    const LANG_ALIASES = { js: 'javascript', javascript: 'javascript', py: 'python', python: 'python', php: 'php', rb: 'ruby', ruby: 'ruby', r: 'r', sql: 'sql' };
    const EXT_LANG = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', php: 'php', rb: 'ruby', r: 'r', sql: 'sql' };
    const KNOWN_FIELDS = ['$schema', 'version', 'tasks'];
    const TASK_FIELDS = ['label', 'group', 'command', 'script', 'lang', 'default', 'detail'];
    const LABEL_MAX = 80;

    // `node "my dir/build.js"` -> ['node', 'my dir/build.js']. Single or double quotes group; nothing else is special (no escapes, no pipes, no variables).
    function tokenize(str) {
        const out = []; let cur = '', quote = null, any = false;
        for (const c of String(str)) {
            if (quote) { if (c === quote) quote = null; else cur += c; continue; }
            if (c === '"' || c === "'") { quote = c; any = true; continue; }
            if (/\s/.test(c)) { if (cur || any) { out.push(cur); cur = ''; any = false; } continue; }
            cur += c;
        }
        if (quote) return null; // an unclosed quote
        if (cur || any) out.push(cur);
        return out;
    }

    // -> { ok: true, interpreter, lang, file } or { ok: false, message }
    // `pip install requests` and `python -m pip install requests` are a command too: -> { ok: true, interpreter: 'pip', lang: 'python', file: '', pip: ['install', 'requests'] }
    // (no file; the packages are installed into the isolated Python by js/core/py-packages.js, and a later task or script can import them).
    function parseCommand(str) {
        const t = typeof str === 'string' ? tokenize(str) : [];
        if (t === null) return { ok: false, message: 'The command has an unclosed quote.' };
        if (!t.length) return { ok: false, message: 'The command is empty.' };
        const interp = t[0].toLowerCase();
        const isPip = interp === 'pip' || interp === 'pip3' || (/^(python|python3|py)$/.test(interp) && t[1] === '-m' && String(t[2] || '').toLowerCase() === 'pip');
        if (isPip) {
            const args = (interp === 'pip' || interp === 'pip3') ? t.slice(1) : t.slice(3);
            if (!args.length) return { ok: false, message: 'Say what pip should do, for example: pip install requests.' };
            return { ok: true, interpreter: 'pip', lang: 'python', file: '', pip: args };
        }
        if (!Object.prototype.hasOwnProperty.call(INTERPRETERS, interp)) {
            const hint = /^(npm|npx|yarn|pnpm|bash|sh|zsh|make|git|cd|echo|ls|cat)$/.test(interp) ? t[0] + ' is not available here. ' : '';
            return { ok: false, message: hint + 'A task command is "node", "python", "php", "ruby", "Rscript" or "sql" followed by a file in the workspace, or "pip install <package>" (or use "script" with "lang" to run code as it stands).' };
        }
        if (t.length < 2) return { ok: false, message: 'Say which file to run: ' + t[0] + ' path/to/file.' };
        if (t.length > 2) return { ok: false, message: 'Arguments are not supported yet: a command is the interpreter and one file.' };
        return { ok: true, interpreter: interp, lang: INTERPRETERS[interp], file: t[1] };
    }

    // The file a command names, in a list of records: relative to the top of the workspace, "./" and ".." allowed, never above the top.
    function resolvePath(records, rootParentId, path) {
        const segs = String(path).replace(/\\/g, '/').split('/');
        let parent = rootParentId || 'root'; const stack = [];
        for (let i = 0; i < segs.length; i++) {
            const seg = segs[i];
            if (seg === '' || seg === '.') continue;
            if (seg === '..') { if (!stack.length) return null; stack.pop(); parent = stack.length ? stack[stack.length - 1] : (rootParentId || 'root'); continue; }
            const last = segs.slice(i + 1).every((x) => x === '' || x === '.');
            const hit = (records || []).find((r) => (r.parentId || 'root') === parent && r.name === seg && (last ? r.type === 'file' : r.type === 'folder'));
            if (!hit) return null;
            if (last) return hit;
            stack.push(hit.id); parent = hit.id;
        }
        return null;
    }

    const isText = (v) => typeof v === 'string' && v.trim().length > 0;

    // Reads the value of tasks.json: -> { tasks: [...], problems: [{ level: 'error'|'warning', where, message }] }
    // A task that cannot be understood is KEPT with an `error` (shown in the list, play disabled) rather than dropped, so it is visible why. A task with
    // an invalid label, group or shape is the exception: it cannot be shown or run, so it is reported and skipped.
    function parseTasks(value) {
        const tasks = [], problems = [];
        const bad = (where, message, level) => problems.push({ level: level || 'error', where, message });
        if (value === null || typeof value !== 'object' || Array.isArray(value)) { bad('', 'tasks.json must be an object with a "tasks" list.'); return { tasks, problems }; }
        Object.keys(value).forEach((k) => { if (!KNOWN_FIELDS.includes(k)) bad('', 'Unknown field "' + k + '" is ignored.', 'warning'); });
        if (value.version !== undefined && value.version !== 1) bad('', '"version" should be 1.', 'warning');
        if (!Array.isArray(value.tasks)) { bad('', '"tasks" must be a list.'); return { tasks, problems }; }
        const seen = new Set(), defaults = {};
        value.tasks.forEach((t, i) => {
            const nameFor = (t && typeof t === 'object' && isText(t.label)) ? '"' + t.label.trim() + '"' : 'task ' + (i + 1);
            if (t === null || typeof t !== 'object' || Array.isArray(t)) { bad(nameFor, 'is not an object.'); return; }
            if (!isText(t.label)) { bad(nameFor, 'needs a "label".'); return; }
            const label = t.label.trim();
            if (label.length > LABEL_MAX) { bad(nameFor, 'has a label longer than ' + LABEL_MAX + ' characters.'); return; }
            if (seen.has(label)) { bad(nameFor, 'repeats a label that is already used; the first one is kept.'); return; }
            const group = t.group === undefined ? 'custom' : t.group;
            if (!GROUPS[group]) { bad(nameFor, 'has group "' + String(t.group) + '": use "build", "test" or "custom".'); return; }
            seen.add(label);
            Object.keys(t).forEach((k) => { if (!TASK_FIELDS.includes(k)) bad(nameFor, 'has an unknown field "' + k + '", which is ignored.', 'warning'); });
            const task = { label, group, isDefault: t.default === true, detail: typeof t.detail === 'string' ? t.detail : '', command: '', script: '', lang: '', file: '', pip: null, display: '', error: '' };
            if (t.default !== undefined && typeof t.default !== 'boolean') bad(nameFor, '"default" must be true or false.', 'warning');
            const hasCmd = t.command !== undefined, hasScript = t.script !== undefined;
            if (hasCmd === hasScript) task.error = 'Needs either "command" or "script" (not both).';
            else if (hasCmd) {
                task.command = typeof t.command === 'string' ? t.command.trim() : '';
                task.display = task.command;
                const c = parseCommand(t.command);
                if (!c.ok) task.error = c.message; else { task.lang = c.lang; task.file = c.file; task.pip = c.pip || null; }
            } else {
                const lang = typeof t.lang === 'string' ? LANG_ALIASES[t.lang.toLowerCase()] : undefined;
                if (!isText(t.script)) task.error = '"script" must be some code.';
                else if (!lang) task.error = 'A "script" needs "lang": "javascript", "python", "php", "ruby", "r" or "sql".';
                else { task.script = t.script; task.lang = lang; }
                task.display = isText(t.script) ? String(t.script).trim().split('\n')[0].slice(0, 80) : '';
            }
            if (task.error) bad(nameFor, task.error, 'error');
            if (task.isDefault) { if (defaults[group]) { bad(nameFor, 'is also marked "default" in ' + group + '; "' + defaults[group] + '" is used.', 'warning'); task.isDefault = false; } else defaults[group] = label; }
            tasks.push(task);
        });
        return { tasks, problems };
    }

    // -> { exists, error: {message,line,column} | null, tasks, problems }, from the record of .codemini/tasks.json (or null)
    function loadFromRecord(rec, parseJsonc) {
        if (!rec) return { exists: false, error: null, tasks: [], problems: [] };
        if (rec.isLocked) return { exists: true, error: { message: 'The file is locked.', line: 1, column: 1 }, tasks: [], problems: [] };
        const p = parseJsonc(rec.content);
        if (!p.ok) return { exists: true, error: { message: p.message, line: p.line, column: p.column }, tasks: [], problems: [] };
        const r = parseTasks(p.value);
        return { exists: true, error: null, tasks: r.tasks, problems: r.problems };
    }

    function groupTasks(tasks, pinned) {
        const pin = new Set(pinned || []);
        const out = { pinned: [], build: [], test: [], custom: [] };
        (tasks || []).forEach((t) => { if (pin.has(t.label)) out.pinned.push(t); else out[t.group].push(t); });
        return out;
    }
    // The task Ctrl+Shift+B (build) or its test twin runs: the one marked default, else the first of the group, else none.
    function defaultTask(tasks, group) {
        const inGroup = (tasks || []).filter((t) => t.group === group);
        return inGroup.find((t) => t.isDefault) || inGroup[0] || null;
    }

    // Places in a line of output that name a file and a line: "src/app.js:12:5", "app.py:3", `File "x.py", line 7`. A web address is not a file.
    const SRC_EXT = 'js|mjs|cjs|ts|tsx|jsx|py|php|rb|r|sql|html|css|json|md|txt|java|c|cpp|h|go|rs|sh|yaml|yml|xml';
    function detectLocations(line) {
        const text = String(line == null ? '' : line), out = [];
        const taken = (a, b) => out.some((o) => a < o.end && b > o.start);
        let m;
        const py = /File "([^"\n]+)", line (\d+)/g;
        while ((m = py.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, file: m[1], line: Number(m[2]), col: 0 });
        const gen = new RegExp('([\\w@.\\-/\\\\]+\\.(?:' + SRC_EXT + ')):(\\d+)(?::(\\d+))?', 'g');
        while ((m = gen.exec(text))) {
            const start = m.index, end = start + m[0].length;
            if (taken(start, end)) continue;
            // A web address is not a file: its path pattern starts at the "//" (a "/" is allowed in a path), or just after "scheme:".
            if (m[0].startsWith('//') || text.slice(Math.max(0, start - 1), start) === ':' || text.slice(Math.max(0, start - 3), start).includes('//') || /[\w]$/.test(text.slice(Math.max(0, start - 1), start))) continue;
            out.push({ start, end, file: m[1], line: Number(m[2]), col: m[3] ? Number(m[3]) : 0 });
        }
        return out.sort((a, b) => a.start - b.start);
    }

    const pad2 = (n) => String(n).padStart(2, '0');
    const clock = (ts) => { const d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); };
    const took = (ms) => (ms < 1000 ? Math.max(1, Math.round(ms)) + ' ms' : ms < 60000 ? (ms / 1000).toFixed(1) + ' s' : Math.floor(ms / 60000) + ' min ' + Math.round((ms % 60000) / 1000) + ' s');

    // ---- templates: each runs as it is (inline scripts), because a template that points at files nobody has written would fail at once ----
    const SCHEMA_URI = 'codemini://schema/tasks.json';
    const tpl = (tasks) => JSON.stringify({ $schema: SCHEMA_URI, version: 1, tasks }, null, 2) + '\n';
    const TEMPLATES = {
        empty: { name: 'Empty', text: tpl([]) },
        javascript: { name: 'JavaScript scripts', text: tpl([
            { label: 'Build', group: 'build', default: true, lang: 'javascript', script: "console.log('Building...');\nconsole.log('Done.');", detail: 'Replace the script with node scripts/build.js once you have one.' },
            { label: 'Test', group: 'test', default: true, lang: 'javascript', script: "const assert = (c, m) => { if (!c) throw new Error(m); };\nassert(1 + 1 === 2, 'math works');\nconsole.log('1 test passed');" }
        ]) },
        python: { name: 'Python', text: tpl([
            { label: 'Build', group: 'build', default: true, lang: 'python', script: "print('Building...')\nprint('Done.')" },
            { label: 'Test', group: 'test', default: true, lang: 'python', script: "import unittest\n\nclass Basics(unittest.TestCase):\n    def test_sum(self):\n        self.assertEqual(1 + 1, 2)\n\nunittest.main(argv=['tasks'], exit=False)" }
        ]) },
        sql: { name: 'SQL', text: tpl([
            { label: 'Check SQLite', group: 'custom', lang: 'sql', script: 'select sqlite_version() as version;' },
            { label: 'Run schema', group: 'build', default: true, command: 'sql db/schema.sql', detail: 'Create db/schema.sql first.' }
        ]) }
    };

    const SCHEMA = {
        type: 'object', additionalProperties: false,
        description: 'Tasks for this workspace: things to build, test or run. They run in the isolated runner.',
        properties: {
            $schema: { type: 'string', description: 'Where the schema for this file comes from. Leave it as it is.' },
            version: { type: 'number', enum: [1], description: 'The format version.' },
            tasks: { type: 'array', description: 'The tasks, in the order they are listed.', items: {
                type: 'object', additionalProperties: false, required: ['label'],
                properties: {
                    label: { type: 'string', maxLength: LABEL_MAX, description: 'The name shown in the Tasks list. Each label must be different.' },
                    group: { type: 'string', enum: ['build', 'test', 'custom'], description: 'Where it is listed. "build" and "test" tasks can be run from a shortcut. Default: custom.' },
                    default: { type: 'boolean', description: 'The one that runs from Ctrl+Shift+B (build) or its test twin. Only one per group.' },
                    command: { type: 'string', description: 'An interpreter and a file in the workspace: node, python, python3, php, ruby, Rscript or sql, then a path. Example: python tests/run.py. Or install Python packages: pip install requests' },
                    script: { type: 'string', description: 'Code to run as it stands, instead of "command". Needs "lang".' },
                    lang: { type: 'string', enum: ['javascript', 'python', 'php', 'ruby', 'r', 'sql'], description: 'The language of "script".' },
                    detail: { type: 'string', description: 'A note shown under the task.' }
                }
            } }
        }
    };

    // ---------------------------------------------------------------------------------------------
    // The run core: runs ONE task against an injected environment (so it can be tested without a browser)
    // ---------------------------------------------------------------------------------------------
    // env: { now, trusted(): bool, getRecords(): Promise<records>, rootParent(): string, execUse(): Promise<bool>, execNotice(): string,
    //        execRun(req, onOut, ask): Promise<{error?}>, kill(), bgStart(opts) -> handle | null, ask(text),
    //        pyPrepare(code, { onLine, isStopped, local }): Promise<{ code, timed, logs: [{ kind, text }] }>   (optional: !pip magics + auto-install for Python code)
    //        pipRun(tokens, onLine): Promise<{ ok, logs }>                                                    (optional: a `pip install ...` command) }
    // sink: { line(text, stream), state(name) }  stream: 'out' | 'err' | 'sys'
    function createRunner(env) {
        let current = null; // { label, interrupted }
        const result = (state, text) => ({ state, text: text || '' });

        async function run(task, sink) {
            if (current) { sink.line('"' + current.label + '" is still running. Stop it first.', 'err'); return result('blocked', 'Another task is running.'); }
            if (task.error) { sink.line(task.label + ': ' + task.error, 'err'); return result('error', task.error); }
            if (!env.trusted()) { sink.line('Restricted Mode: trust this workspace to run tasks.', 'err'); return result('blocked', 'Restricted Mode.'); }
            current = { label: task.label, interrupted: false };
            const me = current;
            let bg = null;
            try {
                // 1. what to run
                let code = task.script, lang = task.lang, local = [];
                if (task.command && !task.pip) {
                    const rec = resolvePath(await env.getRecords(), env.rootParent(), task.file);
                    if (!rec) { sink.line('File not found: ' + task.file, 'err'); return result('error', 'File not found: ' + task.file); }
                    if (rec.isLocked) { sink.line(task.file + ' is locked, so it cannot be run.', 'err'); return result('error', task.file + ' is locked.'); }
                    if (rec.encoding === 'base64') { sink.line(task.file + ' is a binary file, not code.', 'err'); return result('error', task.file + ' is not code.'); }
                    const ext = String(rec.name).split('.').pop().toLowerCase();
                    if (EXT_LANG[ext] && EXT_LANG[ext] !== lang) { sink.line('Note: ' + task.file + ' looks like ' + EXT_LANG[ext] + ' but the command runs it as ' + lang + '.', 'sys'); }
                    code = String(rec.content || '');
                    // the person's own Python modules next to the file (and at the top of the workspace): never looked up on PyPI
                    const all = await env.getRecords(), top = env.rootParent() || 'root';
                    local = (all || []).filter((r) => [rec.parentId || 'root', top].includes(r.parentId || 'root') && (r.type === 'folder' || /\.py$/i.test(r.name))).map((r) => String(r.name).replace(/\.py$/i, ''));
                }
                if (lang === 'php' && !code.trim().startsWith('<?php')) code = '<?php\nerror_reporting(E_ALL);\nini_set(\'display_errors\', 1);\n' + code.trim() + '\n?>';
                // 2. where: the isolated runner only
                if (!(await env.execUse())) {
                    const why = String((env.execNotice && env.execNotice()) || '').trim().replace(/[.\s]+$/, '');
                    sink.line('Tasks run in the isolated runner, which is not available' + (why ? ': ' + why : '') + '. Turn on Isolation for the Terminal in Settings > Security.', 'err');
                    return result('error', 'The isolated runner is not available.');
                }
                // 3. go
                bg = env.bgStart ? env.bgStart({ onStop: () => { me.interrupted = true; env.kill(); } }) : null;
                sink.state('running');
                sink.line('> ' + (task.command || task.display) + '   (' + lang + ')', 'sys');
                const t0 = env.now();
                let failure = '';
                try {
                    // the lines a package step produced (!pip, auto-install, pip): errors are errors, results are output, notes are system lines
                    const showLogs = (logs) => (logs || []).forEach((l) => { sink.line(l.text, l.kind === 'err' ? 'err' : (l.kind === 'ok' || l.kind === 'out') ? 'out' : 'sys'); if (bg) bg.log(l.text, l.kind === 'err' ? 'err' : 'out'); });
                    if (task.pip) {
                        // `pip install x`: no file runs, the packages are installed
                        if (!env.pipRun) { failure = 'pip is not available here.'; sink.line(failure, 'err'); }
                        else {
                            const r = await env.pipRun(task.pip, (t) => sink.line(t, 'sys'));
                            showLogs(r.logs);
                            if (!r.ok) failure = String(((r.logs || []).filter((l) => l.kind === 'err').pop() || {}).text || 'pip failed').replace(/^ERROR:\s*/, '');
                        }
                    } else {
                        let timed = false;
                        if (lang === 'python' && env.pyPrepare) {
                            const prep = await env.pyPrepare(code, { onLine: (t) => sink.line(t, 'sys'), isStopped: () => me.interrupted, local });
                            code = prep.code; timed = prep.timed; showLogs(prep.logs);
                        }
                        const tRun = env.now();
                        const res = await env.execRun({ lang, code, opts: { trusted: true, autoInstall: false, sep: ' ' } }, (e) => {
                            if (!e || e.kind === 'html') return;
                            const text = String(e.text).replace(/\n$/, ''), err = e.kind === 'error' || e.kind === 'stderr';
                            sink.line(text, err ? 'err' : (e.kind === 'warn' || e.kind === 'info') ? 'sys' : 'out');
                            if (bg) bg.log(String(e.text), err ? 'err' : 'out');
                        }, env.ask);
                        if (res && res.error) { failure = String(res.error.message || res.error.text || 'The code ended with an error'); sink.line(String(res.error.text || (res.error.name ? res.error.name + ': ' : '') + res.error.message), 'err'); }
                        else if (timed) sink.line('Wall time: ' + (env.now() - tRun).toFixed(2) + ' ms', 'sys');
                    }
                } catch (e) {
                    if (me.interrupted) { sink.line("Stopped: this window's isolated host was shut down, so its variables were reset.", 'sys'); }
                    else { failure = e.message; sink.line('System error: ' + e.message, 'err'); }
                }
                const ms = env.now() - t0;
                if (me.interrupted) { if (bg) bg.finish('stopped', 'Stopped'); sink.line('Stopped after ' + took(ms), 'sys'); return Object.assign(result('stopped', 'Stopped'), { ms }); }
                if (failure) { if (bg) bg.fail(failure); sink.line('Failed after ' + took(ms), 'err'); return Object.assign(result('error', failure), { ms }); }
                if (bg) bg.finish('success', 'Done in ' + took(ms));
                sink.line('Done in ' + took(ms), 'sys');
                return Object.assign(result('success', 'Done in ' + took(ms)), { ms });
            } finally {
                // Whatever happened, the Now Island entry must not be left running: it is ended above on every normal path, so this only fires if something threw.
                if (bg && typeof bg.isRunning === 'function' && bg.isRunning()) bg.fail('The task ended unexpectedly.');
                if (current === me) current = null;
            }
        }
        return { run, isRunning: () => !!current, runningLabel: () => (current ? current.label : null), stop: () => { if (current) { current.interrupted = true; env.kill(); return true; } return false; } };
    }

    const api = { GROUPS, GROUP_ORDER, INTERPRETERS, TEMPLATES, SCHEMA, SCHEMA_URI, tokenize, parseCommand, resolvePath, parseTasks, loadFromRecord, groupTasks, defaultTask, detectLocations, clock, took, createRunner };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof document === 'undefined') return; // Node: rules and the run core only
    W.CodeMiniTasks = api; // completed below

    // ---------------------------------------------------------------------------------------------
    // Browser
    // ---------------------------------------------------------------------------------------------
    const $ = (id) => document.getElementById(id);
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const icon = (cls) => { const i = document.createElement('i'); i.className = cls; return i; };
    const toast = (m) => { if (typeof W.showSuccessToast === 'function') W.showSuccessToast(m); };
    const winId = () => { try { return localStorage.getItem('codemini_active_window') || 'win_default'; } catch (e) { return 'win_default'; } };
    const curDb = () => (typeof db !== 'undefined' && db ? db : null);
    const OUT_MAX = 2000;

    const state = {
        file: { exists: false, error: null, tasks: [], problems: [] }, sig: '', dbName: '',
        results: {},            // label -> { state, at, ms }
        output: [],             // { at, text, stream }
        outTitle: '', outState: 'idle', lastLabel: '',
        menu: false, pinned: []
    };

    // ---- pins: per workspace database, per profile ----
    const pinKey = () => (typeof W.getPrefixedKey === 'function' ? W.getPrefixedKey('tasksPinned') : 'codemini_tasksPinned');
    function loadPins() {
        try { const all = JSON.parse(localStorage.getItem(pinKey()) || '{}'); state.pinned = Array.isArray(all[state.dbName]) ? all[state.dbName] : []; } catch (e) { state.pinned = []; }
    }
    function togglePin(label) {
        try {
            const all = JSON.parse(localStorage.getItem(pinKey()) || '{}');
            const cur = Array.isArray(all[state.dbName]) ? all[state.dbName] : [];
            all[state.dbName] = cur.includes(label) ? cur.filter((x) => x !== label) : cur.concat(label);
            localStorage.setItem(pinKey(), JSON.stringify(all));
        } catch (e) { /* storage unavailable: pins just do not persist */ }
        loadPins(); renderSidebar();
    }

    // ---- loading the file (from the records Explorer loads: no extra read) ----
    function noteRecords(records) {
        const C = W.CodeMiniConfig; if (!C) return;
        const rec = C.findConfigRecord(records, 'tasks.json'), dbName = curDb() ? curDb().name : '';
        const sig = C.overlaySignature(dbName, rec);
        if (sig === state.sig) return;
        const workspaceChanged = dbName !== state.dbName;
        state.sig = sig; state.dbName = dbName;
        state.file = loadFromRecord(rec, C.parseJsonc);
        if (workspaceChanged) { state.results = {}; loadPins(); }
        renderSidebar(); renderStatus();
    }

    // ---- running ----
    const env = {
        now: () => Date.now(),
        trusted: () => !W.CodeMiniConfig || W.CodeMiniConfig.canRun('tasks.json'),
        getRecords: () => new Promise((resolve, reject) => {
            const d = curDb(); if (!d) { resolve([]); return; }
            try { const rq = d.transaction('filesystem', 'readonly').objectStore('filesystem').getAll(); rq.onsuccess = () => resolve(rq.result || []); rq.onerror = () => reject(rq.error); } catch (e) { reject(e); }
        }),
        rootParent: () => (W.CodeMiniConfig ? W.CodeMiniConfig.rootParentId(typeof folderStack !== 'undefined' ? folderStack : null) : 'root'),
        execUse: async () => !!(W.CodeMiniExec && await W.CodeMiniExec.use('terminal', winId())),
        execNotice: () => (W.CodeMiniExec ? W.CodeMiniExec.fallbackNotice('terminal') : ''),
        execRun: (req, onOut, ask) => W.CodeMiniExec.run(winId(), req, onOut, ask),
        kill: () => { if (W.CodeMiniExec) W.CodeMiniExec.kill(winId()); },
        // Python packages (js/core/py-packages.js): the !pip / %pip magics and auto-install (Settings > Terminal > Auto-Install Python Packages), on this window's host.
        pyPrepare: async (code, o) => {
            const P = W.CodeMiniPyPkgs;
            if (!P) return { code, timed: false, logs: [] };
            return P.prepare(code, { autoInstall: !W.appSettings || W.appSettings.terminalAutoInstall !== false, engine: P.hostEngine(winId()), local: o.local, onStatus: o.onLine, isStopped: o.isStopped });
        },
        pipRun: async (tokens, onLine) => {
            const P = W.CodeMiniPyPkgs;
            if (!P) return { ok: false, logs: [{ kind: 'err', text: 'ERROR: the package module did not load.' }] };
            return P.pipCommand(tokens, { engine: P.hostEngine(winId()), onStatus: onLine });
        },
        ask: (text) => (W.inlineInputPrompt ? W.inlineInputPrompt(text) : Promise.resolve(W.prompt(text) || '')),
        bgStart: null // set per run: it needs the task's label
    };
    const runner = createRunner(Object.assign({}, env, { bgStart: (o) => (env.currentBg ? env.currentBg(o) : null) }));
    let runningWin = null;

    function openPanelTab() {
        const panel = $('problemsPanel');
        if (panel && panel.style.display === 'none') panel.style.display = 'flex';
        const tab = document.querySelector('.bottom-panel-tab[data-target="tasksPanelContent"]');
        if (tab && !tab.classList.contains('active')) tab.click();
    }
    const sidebarOpen = () => !!($('tasksSidebar') && $('tasksSidebar').classList.contains('open'));
    const panelOnTasks = () => { const p = $('problemsPanel'), t = document.querySelector('.bottom-panel-tab[data-target="tasksPanelContent"]'); return !!(p && p.style.display !== 'none' && t && t.classList.contains('active')); };

    function pushLine(text, stream) {
        state.output.push({ at: Date.now(), text: String(text), stream });
        if (state.output.length > OUT_MAX) state.output.splice(0, state.output.length - OUT_MAX);
        appendOutputLine(state.output[state.output.length - 1]);
    }

    async function runTask(task) {
        if (!task) return null;
        if (runner.isRunning()) { toast('"' + runner.runningLabel() + '" is still running. Stop it first.'); return null; }
        if (W.WorkspaceTrust && !task.error && !env.trusted()) { if (typeof W.WorkspaceTrust.guard === 'function') W.WorkspaceTrust.guard('Running a task'); }
        state.output = []; state.outTitle = task.label; state.lastLabel = task.label; state.outState = 'idle';
        renderOutputAll(); openPanelTab();
        runningWin = winId();
        env.currentBg = (o) => (W.CodeMiniBackground ? W.CodeMiniBackground.start({
            kind: 'task', title: 'Task: ' + task.label, source: 'Tasks', winId: runningWin, onStop: o.onStop,
            isHidden: () => !panelOnTasks() && !sidebarOpen(),
            onGoto: () => openPanelTab()
        }) : null);
        const sink = { line: pushLine, state: (s) => { state.outState = s; state.results[task.label] = { state: 'running', at: Date.now(), ms: 0 }; renderSidebar(); renderStatus(); renderOutputHead(); } };
        const p = runner.run(task, sink);
        renderStatus(); renderSidebar(); renderOutputHead();
        const r = await p;
        env.currentBg = null;
        state.outState = r.state === 'blocked' ? 'idle' : r.state;
        if (r.state !== 'blocked') state.results[task.label] = { state: r.state, at: Date.now(), ms: r.ms || 0 };
        renderSidebar(); renderStatus(); renderOutputHead();
        return r;
    }
    const runByLabel = (label) => runTask(state.file.tasks.find((t) => t.label === label));
    function runDefault(group) {
        const t = defaultTask(state.file.tasks, group);
        if (!t) { toast('No ' + group + ' task yet. Open Tasks to add one.'); openSidebar(); return null; }
        return runTask(t);
    }
    const stopRunning = () => { runner.stop(); };

    // ---- opening a file at a line (links in the output) ----
    async function openAt(path, line, col) {
        const records = await env.getRecords();
        let rec = resolvePath(records, env.rootParent(), path);
        if (!rec) { // output often shows a path relative to somewhere else: accept a file that is the only one with that ending
            const norm = String(path).replace(/\\/g, '/').replace(/^\.?\//, '');
            const byId = new Map(records.map((r) => [r.id, r]));
            const pathOf = (r) => { const parts = [r.name]; let cur = r.parentId, g = 0; while (cur && byId.has(cur) && g++ < 64) { const p = byId.get(cur); parts.unshift(p.name); cur = p.parentId; } return parts.join('/'); };
            const hits = records.filter((r) => r.type === 'file' && (pathOf(r) === norm || pathOf(r).endsWith('/' + norm)));
            if (hits.length === 1) rec = hits[0];
        }
        if (!rec) { toast('Could not find ' + path + ' in this workspace.'); return false; }
        if (typeof W.handleFileClick !== 'function') return false;
        W.handleFileClick(rec, document.createElement('div'));
        if (line) setTimeout(() => {
            const ed = typeof W.getActiveMonacoEditor === 'function' ? W.getActiveMonacoEditor() : null; if (!ed) return;
            const m = ed.getModel(), ln = Math.max(1, Math.min(line, m ? m.getLineCount() : line));
            ed.revealLineInCenter(ln); ed.setPosition({ lineNumber: ln, column: Math.max(1, col || 1) }); ed.focus();
        }, 200);
        return true;
    }

    // ---- the Tasks tab of the bottom panel ----
    const outBody = () => $('tasksOutputBody');
    function lineNode(entry) {
        const row = el('div', 'tk-line tk-' + entry.stream);
        row.appendChild(el('span', 'tk-time', clock(entry.at)));
        const body = el('span', 'tk-text');
        const locs = entry.stream === 'sys' ? [] : detectLocations(entry.text);
        let at = 0;
        locs.forEach((l) => {
            if (l.start > at) body.appendChild(document.createTextNode(entry.text.slice(at, l.start)));
            const a = el('span', 'tk-link', entry.text.slice(l.start, l.end));
            a.setAttribute('role', 'link'); a.tabIndex = 0; a.title = 'Open ' + l.file + (l.line ? ' at line ' + l.line : '');
            const go = () => { openAt(l.file, l.line, l.col); };
            a.addEventListener('click', go);
            a.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
            body.appendChild(a); at = l.end;
        });
        if (at < entry.text.length) body.appendChild(document.createTextNode(entry.text.slice(at)));
        if (!entry.text) body.appendChild(document.createTextNode('\u00a0'));
        row.appendChild(body);
        return row;
    }
    function appendOutputLine(entry) {
        const b = outBody(); if (!b) return;
        const empty = b.querySelector('.tk-empty'); if (empty) empty.remove();
        const atEnd = b.scrollHeight - b.scrollTop - b.clientHeight < 30;
        b.appendChild(lineNode(entry));
        while (b.children.length > OUT_MAX) b.removeChild(b.firstChild);
        if (atEnd) b.scrollTop = b.scrollHeight;
    }
    function renderOutputAll() {
        const b = outBody(); if (!b) return;
        b.textContent = '';
        if (!state.output.length) b.appendChild(el('div', 'tk-empty', 'Task output appears here. Run one from the Tasks list.'));
        else state.output.forEach((e) => b.appendChild(lineNode(e)));
        b.scrollTop = b.scrollHeight;
        renderOutputHead();
    }
    function renderOutputHead() {
        const head = $('tasksOutputHead'); if (!head) return;
        head.textContent = '';
        const st = state.outState;
        const ic = st === 'running' ? 'ri-loader-4-line tk-spin' : st === 'success' ? 'ri-checkbox-circle-fill tk-ok' : st === 'error' ? 'ri-close-circle-fill tk-bad' : st === 'stopped' ? 'ri-stop-circle-line' : 'ri-checkbox-blank-circle-line';
        head.appendChild(icon(ic));
        head.appendChild(el('span', 'tk-out-title', state.outTitle || 'Tasks'));
        head.appendChild(el('span', 'tk-out-state', st === 'idle' && !state.outTitle ? 'No task has run' : st === 'running' ? 'Running' : st === 'success' ? 'Done' : st === 'error' ? 'Failed' : st === 'stopped' ? 'Stopped' : ''));
        const sp = el('span'); sp.style.flex = '1'; head.appendChild(sp);
        const mk = (label, cls, fn, disabled) => { const b = el('button', 'tk-icon-btn tk-out-btn', ''); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.appendChild(icon(cls)); b.disabled = !!disabled; b.addEventListener('click', fn); return b; };
        head.appendChild(mk('Run again', 'ri-restart-line', () => { if (state.lastLabel) runByLabel(state.lastLabel); }, st === 'running' || !state.lastLabel));
        head.appendChild(mk('Stop', 'ri-stop-mini-fill', stopRunning, st !== 'running'));
        head.appendChild(mk('Clear', 'ri-delete-bin-line', () => { state.output = []; renderOutputAll(); }, false));
    }

    // ---- the status-bar item ----
    function renderStatus() {
        const item = $('statusTasksToggle'); if (!item) return;
        const running = runner.isRunning(), label = running ? runner.runningLabel() : state.lastLabel;
        const r = label ? state.results[label] : null;
        const show = running || !!r || state.file.tasks.length > 0;
        item.style.display = show ? '' : 'none';
        item.textContent = '';
        const st = running ? 'running' : r ? r.state : 'idle';
        item.dataset.state = st;
        item.appendChild(icon(st === 'running' ? 'ri-loader-4-line tk-spin' : st === 'success' ? 'ri-checkbox-circle-fill tk-ok' : st === 'error' ? 'ri-close-circle-fill tk-bad' : 'ri-list-check-2'));
        if (label && (running || r)) item.appendChild(el('span', 'tk-status-name', label));
        item.title = running ? 'Running: ' + label + ' (click to open Tasks)' : r ? label + ': ' + (st === 'success' ? 'done' : st) + ' (click to open Tasks)' : 'Tasks';
    }

    // ---- the sidebar ----
    function openSidebar() {
        const sb = $('tasksSidebar'), mi = $('menuTasks'); if (!sb) return;
        if (!sb.classList.contains('open')) { if (W.closeAllSidebars) W.closeAllSidebars(); sb.classList.add('open'); if (mi) mi.classList.add('active'); if (W.saveCurrentUIState) W.saveCurrentUIState(); }
        renderSidebar();
    }
    function iconBtn(cls, label, fn, extra) {
        const b = el('button', 'sb-icon-btn' + (extra ? ' ' + extra : ''), ''); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.appendChild(icon(cls));
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(e); });
        return b;
    }
    function textLink(text, fn) { const b = el('button', 'tk-action', text); b.type = 'button'; b.addEventListener('click', (e) => { e.stopPropagation(); fn(e); }); return b; }

    async function createFromTemplate(key) {
        const C = W.CodeMiniConfig; if (!C) return;
        state.menu = false;
        try { const r = await C.ensure('tasks.json', TEMPLATES[key].text); if (typeof W.openFileInTab === 'function') W.openFileInTab(r.record); toast(r.created ? 'Created .codemini/tasks.json' : 'tasks.json already exists, so it was opened.'); }
        catch (e) { toast('Could not create it: ' + e.message); }
        renderSidebar();
    }
    function configureTasks() {
        const C = W.CodeMiniConfig;
        if (state.file.exists && C) { C.open('tasks.json').catch((e) => toast('Could not open it: ' + e.message)); return; }
        openSidebar(); state.menu = true; renderSidebar();
    }

    function taskRow(t, ctx) {
        const running = runner.isRunning() && runner.runningLabel() === t.label;
        const r = state.results[t.label];
        const li = el('li', 'tk-row'); li.dataset.label = t.label; li.dataset.state = running ? 'running' : (r ? r.state : 'idle'); if (t.error) li.classList.add('tk-invalid');
        const top = el('div', 'tk-row-top');
        const lead = icon(running ? 'ri-loader-4-line tk-spin' : t.error ? 'ri-error-warning-line tk-warn' : r && r.state === 'success' ? 'ri-checkbox-circle-fill tk-ok' : r && r.state === 'error' ? 'ri-close-circle-fill tk-bad' : GROUPS[t.group].icon);
        lead.classList.add('tk-lead');
        const name = el('div', 'tk-name', t.label);
        top.append(lead, name);
        if (t.isDefault) top.appendChild(el('span', 'tk-pill', 'DEFAULT'));
        const actions = el('div', 'tk-actions');
        actions.appendChild(iconBtn(ctx.pinned ? 'ri-star-fill' : 'ri-star-line', ctx.pinned ? 'Unpin ' + t.label : 'Pin ' + t.label, () => togglePin(t.label), 'tk-pin' + (ctx.pinned ? ' on' : '')));
        if (running) actions.appendChild(iconBtn('ri-stop-mini-fill', 'Stop ' + t.label, stopRunning, 'tk-stop'));
        else {
            const locked = !env.trusted();
            const b = iconBtn(locked ? 'ri-lock-line' : 'ri-play-line', locked ? 'Trust this workspace to run tasks' : 'Run ' + t.label, () => runTask(t), 'tk-play');
            if (locked || t.error || runner.isRunning()) b.disabled = true;
            if (!locked && t.error) b.title = t.error; else if (!locked && runner.isRunning()) b.title = 'Another task is running';
            actions.appendChild(b);
        }
        top.appendChild(actions);
        li.appendChild(top);
        li.appendChild(el('div', 'tk-cmd', t.error ? t.error : (t.display || '')));
        if (t.detail && !t.error) li.appendChild(el('div', 'tk-detail', t.detail));
        return li;
    }

    function sectionOf(title, tasks, pinned) {
        const wrap = el('div', 'tk-sec');
        const head = el('div', 'sb-section-header');
        const left = el('span'); left.append(document.createTextNode(title), el('span', 'sb-count-badge', String(tasks.length)));
        head.appendChild(left);
        const ul = el('ul', 'tk-list'); ul.setAttribute('aria-label', title + ' tasks');
        tasks.forEach((t) => ul.appendChild(taskRow(t, { pinned })));
        wrap.append(head, ul);
        return wrap;
    }

    function renderSidebar() {
        const root = $('tkRoot'); if (!root) return;
        root.textContent = '';
        const head = el('div', 'sb-header');
        head.appendChild(el('div', 'sb-title', 'TASKS'));
        const tools = el('div', 'sb-tools');
        tools.append(iconBtn('ri-refresh-line', 'Refresh tasks', () => { state.sig = ''; env.getRecords().then(noteRecords).catch(() => {}); }),
            iconBtn('ri-add-line', state.file.exists ? 'Open tasks.json' : 'Create tasks.json', () => { if (state.file.exists) configureTasks(); else { state.menu = !state.menu; renderSidebar(); } }),
            iconBtn('ri-close-line', 'Close', () => { $('tasksSidebar').classList.remove('open'); $('menuTasks')?.classList.remove('active'); if (W.saveCurrentUIState) W.saveCurrentUIState(); }));
        head.appendChild(tools);
        root.appendChild(head);
        const body = el('div', 'sb-body');

        if (!env.trusted()) {
            const row = el('div', 'tk-banner tk-banner-lock');
            row.append(icon('ri-lock-line'), el('span', null, 'Restricted Mode: tasks are listed but will not run until you trust this workspace.'));
            if (W.WorkspaceTrust && typeof W.WorkspaceTrust.requestTrust === 'function') row.appendChild(textLink('Trust', () => W.WorkspaceTrust.requestTrust()));
            body.appendChild(row);
        }
        if (state.file.error) {
            const row = el('div', 'tk-banner tk-banner-bad');
            row.append(icon('ri-error-warning-line'), el('span', null, 'tasks.json is not valid: ' + state.file.error.message + ' (line ' + state.file.error.line + ').'), textLink('Open file', configureTasks));
            body.appendChild(row);
        }
        state.file.problems.filter((p) => p.level === 'error' && !(p.where && state.file.tasks.some((t) => t.error && p.where === '"' + t.label + '"'))).slice(0, 4).forEach((p) => {
            const row = el('div', 'tk-banner tk-banner-bad'); row.append(icon('ri-error-warning-line'), el('span', null, (p.where ? p.where + ' ' : '') + p.message)); body.appendChild(row);
        });

        if (state.menu && !state.file.exists) {
            const menu = el('div', 'tk-menu');
            menu.appendChild(el('div', 'sb-section-header', 'CREATE .codemini/tasks.json FROM'));
            Object.keys(TEMPLATES).forEach((k) => { const b = el('button', 'tk-menu-item', TEMPLATES[k].name); b.type = 'button'; b.dataset.template = k; b.addEventListener('click', () => createFromTemplate(k)); menu.appendChild(b); });
            body.appendChild(menu);
        }

        const g = groupTasks(state.file.tasks, state.pinned);
        if (g.pinned.length) body.appendChild(sectionOf('PINNED', g.pinned, true));
        GROUP_ORDER.forEach((k) => { if (g[k].length) body.appendChild(sectionOf(GROUPS[k].label, g[k], false)); });

        if (!state.file.tasks.length && !state.file.error) {
            const empty = el('div', 'tk-emptystate');
            empty.append(icon('ri-list-check-2'), el('div', 'tk-empty-title', 'No tasks yet'),
                el('div', 'tk-empty-text', state.file.exists ? 'tasks.json has no tasks. Add one, or start from a template.' : 'Tasks are commands to build or test your project, kept in .codemini/tasks.json.'));
            const btn = el('button', 'tk-btn primary', state.file.exists ? 'Open tasks.json' : 'Configure Tasks'); btn.type = 'button';
            btn.addEventListener('click', configureTasks); empty.appendChild(btn);
            body.appendChild(empty);
        }
        root.appendChild(body);
    }

    // ---- commands in the palette ----
    function paletteCommands() {
        const out = [
            { name: 'Run Task...', icon: 'ri-list-check-2', run: () => { if (W.openQuickOpen) W.openQuickOpen('>Run Task: '); } },
            { name: 'Run Build Task', icon: 'ri-hammer-line', run: () => runDefault('build') },
            { name: 'Run Test Task', icon: 'ri-test-tube-line', run: () => runDefault('test') },
            { name: 'Configure Tasks', icon: 'ri-settings-3-line', run: configureTasks },
            { name: 'Open Tasks', icon: 'ri-list-check-2', run: openSidebar }
        ];
        state.file.tasks.forEach((t) => out.push({ name: 'Run Task: ' + t.label, icon: GROUPS[t.group].icon, run: () => runTask(t) }));
        return out;
    }

    function init() {
        const sb = $('tasksSidebar'); if (!sb) return;
        if (!$('tkRoot')) { const r = el('div', 'tk-root'); r.id = 'tkRoot'; sb.insertBefore(r, sb.firstChild); }
        const mi = $('menuTasks');
        // Bound on the element itself: the main menu stops clicks from reaching the document, and the same element is moved between the menu and the activity bar.
        if (mi) mi.addEventListener('click', () => {
            $('mainMenuDropdown')?.classList.remove('show');
            const wasOpen = sidebarOpen();
            if (W.closeAllSidebars) W.closeAllSidebars();
            if (!wasOpen) { sb.classList.add('open'); mi.classList.add('active'); }
            if (W.saveCurrentUIState) W.saveCurrentUIState();
        });
        const st = $('statusTasksToggle'); if (st) st.addEventListener('click', openSidebar);
        new MutationObserver(() => { if (sidebarOpen()) renderSidebar(); }).observe(sb, { attributes: true, attributeFilter: ['class'] });
        const out = $('tasksPanelContent');
        if (out && !$('tasksOutputHead')) {
            const h = el('div', 'tk-out-head'); h.id = 'tasksOutputHead'; const b = el('div', 'tk-out-body'); b.id = 'tasksOutputBody'; b.tabIndex = 0; b.setAttribute('role', 'log');
            out.append(h, b); renderOutputAll();
        }
        if (W.CodeMiniConfig) {
            W.CodeMiniConfig.registerTemplate('tasks.json', TEMPLATES.javascript.text);
            W.CodeMiniConfig.registerSchema('tasks.json', SCHEMA);
            W.CodeMiniConfig.subscribe(noteRecords);
        }
        if (W.CodeMiniQuickOpen && typeof W.CodeMiniQuickOpen.registerCommands === 'function') W.CodeMiniQuickOpen.registerCommands(paletteCommands);
        window.addEventListener('workspacetrustchange', () => { renderSidebar(); renderStatus(); });
        renderSidebar(); renderStatus();
    }

    Object.assign(api, { runTask, runByLabel, runDefault, stop: stopRunning, openSidebar, configureTasks, state: () => ({ file: state.file, results: Object.assign({}, state.results), pinned: state.pinned.slice(), running: runner.runningLabel(), outState: state.outState, output: state.output.slice() }), noteRecords, paletteCommands, openAt });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : globalThis);
