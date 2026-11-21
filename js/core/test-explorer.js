// ==========================================
// test-explorer.js: the Test Explorer, UI/UX specs feature 18
// ==========================================
// Finds the tests in a workspace (JavaScript and Python), runs them in the isolated runner and shows the result as a tree:
// file > suite > test, with a summary bar, an inline error block under each failure, a play/check/cross glyph on every test line
// in the editor, a status-bar item and a Test Output tab in the bottom panel.
//
//   JavaScript   a small describe / it / test / expect runner (jest-style matchers) plus `require('assert')`. A test file may
//                require() other files of the workspace by a relative path (CommonJS); import/export syntax and npm packages are not available.
//   Python       `unittest` (standard library) and `pytest` (installed into the isolated Python the first time it is needed).
//
// Files are found by name: `*.test.js`, `*.spec.js`, `test_*.py`, `*_test.py`, changeable in `.codemini/tests.json`:
//   { "$schema": "codemini://schema/tests.json", "version": 1,
//     "patterns": { "javascript": ["*.test.js"], "python": ["test_*.py"] }, "exclude": ["vendor"], "pythonFramework": "auto", "timeoutMs": 5000 }
//
// Safety (spec): tests run only in the isolated runner, on the same host and under the same Isolation setting as the Terminal and Tasks,
// never in CodeMini's own page, and never in Restricted Mode (the tree is still shown: finding tests only reads text). This file builds
// the PROGRAM a test file runs inside, as text (nothing in it calls eval or new Function); the host runs it.
//
// The pure rules, the two harnesses and the run core (which works on an injected environment) are exported for Node
// (tests/test-explorer.test.js); the browser half draws the sidebar, the Test Output tab, the status item and the editor glyphs.
(function (root) {
    'use strict';
    const W = root;

    // ---------------------------------------------------------------------------------------------
    // Pure: patterns and the workspace's files
    // ---------------------------------------------------------------------------------------------
    const DEFAULT_PATTERNS = { javascript: ['*.test.js', '*.spec.js'], python: ['test_*.py', '*_test.py'] };
    const DEFAULT_EXCLUDE = ['node_modules', '.git', '.codemini', '__pycache__', '.venv', 'venv'];
    const LANGS = ['javascript', 'python'];
    const KNOWN_FIELDS = ['$schema', 'version', 'patterns', 'exclude', 'pythonFramework', 'timeoutMs'];
    const PY_FRAMEWORKS = ['auto', 'unittest', 'pytest'];
    const SEP = ' > ';
    const TOTAL_FILES_MAX = 1500000, ONE_FILE_MAX = 200000, FILES_COUNT_MAX = 600;

    // A glob: `*` is anything but a slash, `**` crosses folders, `?` is one character. A pattern with no slash is matched against the file name
    // wherever it sits (like a .gitignore line); a pattern with a slash is matched against the whole path from the top of the workspace.
    function globToRegExp(glob) {
        const g = String(glob).replace(/\\/g, '/'); let re = '', i = 0;
        while (i < g.length) {
            const c = g[i];
            if (c === '*') {
                if (g[i + 1] === '*') { i += 2; if (g[i] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; } else { re += '[^/]*'; i++; }
            } else if (c === '?') { re += '[^/]'; i++; } else { re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&'); i++; }
        }
        return new RegExp('^' + re + '$');
    }
    function matchesPattern(path, pattern) {
        const p = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
        if (!p) return false;
        const re = globToRegExp(p);
        return p.includes('/') ? re.test(path) : re.test(path.split('/').pop());
    }
    // An exclude entry is a folder or file name at any depth ("vendor"), or a path pattern ("legacy/**", "src/old").
    function isExcluded(path, exclude) {
        const segs = path.split('/');
        return (exclude || []).some((raw) => {
            const p = String(raw).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
            if (!p) return false;
            if (!p.includes('/')) { const re = globToRegExp(p); return segs.some((s) => re.test(s)); }
            return globToRegExp(p).test(path) || globToRegExp(p + '/**').test(path);
        });
    }

    // The files of a workspace with their paths, from the records Explorer loads: [{ rec, path }].
    function listFiles(records, rootParentId) {
        const top = rootParentId || 'root', kids = new Map(); let budget = 20000;
        (records || []).forEach((r) => { const p = r.parentId || 'root'; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(r); });
        const out = [];
        (function walk(parent, prefix, depth) {
            if (depth > 40) return;
            (kids.get(parent) || []).slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).forEach((r) => {
                if (budget-- <= 0) return;
                const path = prefix ? prefix + '/' + r.name : r.name;
                if (r.type === 'folder') { if (r.name !== 'node_modules' && r.name !== '.git') walk(r.id, path, depth + 1); } else if (r.type === 'file') out.push({ rec: r, path });
            });
        })(top, '', 0);
        return out;
    }

    // -> { config: { patterns, exclude, pythonFramework, timeoutMs }, problems: [{ level, message }] }
    function parseTestConfig(value) {
        const config = { patterns: { javascript: DEFAULT_PATTERNS.javascript.slice(), python: DEFAULT_PATTERNS.python.slice() }, exclude: DEFAULT_EXCLUDE.slice(), pythonFramework: 'auto', timeoutMs: 5000 }, problems = [];
        const bad = (message, level) => problems.push({ level: level || 'error', message });
        if (value === null || typeof value !== 'object' || Array.isArray(value)) { bad('tests.json must be an object.'); return { config, problems }; }
        Object.keys(value).forEach((k) => { if (!KNOWN_FIELDS.includes(k)) bad('Unknown field "' + k + '" is ignored.', 'warning'); });
        if (value.version !== undefined && value.version !== 1) bad('"version" should be 1.', 'warning');
        const list = (v, what) => {
            if (!Array.isArray(v)) { bad(what + ' must be a list of text patterns.'); return null; }
            const out = v.filter((x) => typeof x === 'string' && x.trim() && x.length <= 200).map((x) => x.trim()).slice(0, 50);
            if (out.length !== v.length) bad(what + ' has entries that are not text, are empty, or are longer than 200 characters; they are ignored.', 'warning');
            return out;
        };
        if (value.patterns !== undefined) {
            if (value.patterns === null || typeof value.patterns !== 'object' || Array.isArray(value.patterns)) bad('"patterns" must be an object with "javascript" and "python" lists.');
            else {
                Object.keys(value.patterns).forEach((k) => {
                    if (!LANGS.includes(k)) { bad('"patterns" has an unknown language "' + k + '": use "javascript" or "python".', 'warning'); return; }
                    const l = list(value.patterns[k], '"patterns.' + k + '"'); if (l) config.patterns[k] = l;
                });
            }
        }
        if (value.exclude !== undefined) { const l = list(value.exclude, '"exclude"'); if (l) config.exclude = DEFAULT_EXCLUDE.concat(l.filter((x) => !DEFAULT_EXCLUDE.includes(x))); }
        if (value.pythonFramework !== undefined) { if (PY_FRAMEWORKS.includes(value.pythonFramework)) config.pythonFramework = value.pythonFramework; else bad('"pythonFramework" must be "auto", "unittest" or "pytest".'); }
        if (value.timeoutMs !== undefined) { if (typeof value.timeoutMs === 'number' && value.timeoutMs >= 100 && value.timeoutMs <= 60000) config.timeoutMs = Math.round(value.timeoutMs); else bad('"timeoutMs" must be a number from 100 to 60000.'); }
        return { config, problems };
    }
    // -> { exists, error: {message,line,column} | null, config, problems }, from the record of .codemini/tests.json (or null: the defaults)
    function loadConfigFromRecord(rec, parseJsonc) {
        const defaults = parseTestConfig({}).config;
        if (!rec) return { exists: false, error: null, config: defaults, problems: [] };
        if (rec.isLocked) return { exists: true, error: { message: 'The file is locked.', line: 1, column: 1 }, config: defaults, problems: [] };
        const p = parseJsonc(rec.content);
        if (!p.ok) return { exists: true, error: { message: p.message, line: p.line, column: p.column }, config: defaults, problems: [] };
        const r = parseTestConfig(p.value);
        return { exists: true, error: null, config: r.config, problems: r.problems };
    }

    // The test files among the workspace's files: [{ path, lang, rec }]. Locked and binary files are never read.
    function discoverFiles(entries, config) {
        const cfg = config || parseTestConfig({}).config, out = [];
        (entries || []).forEach((e) => {
            if (e.rec.isLocked || e.rec.encoding === 'base64' || isExcluded(e.path, cfg.exclude)) return;
            const lang = LANGS.find((l) => (cfg.patterns[l] || []).some((p) => matchesPattern(e.path, p)));
            if (lang) out.push({ path: e.path, lang, rec: e.rec });
        });
        return out;
    }

    // A fast fingerprint of a file's text, to tell whether it changed since a run (a stale marker). Not a security hash.
    function sigOf(text) {
        const s = String(text == null ? '' : text); let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return s.length + ':' + (h >>> 0).toString(36);
    }

    // ---------------------------------------------------------------------------------------------
    // Pure: finding the tests in a file's text (static: nothing runs). Results that the run reports and this did not find are added later.
    // ---------------------------------------------------------------------------------------------
    // JavaScript: describe / context / suite / it / test / specify with a plain string name, and their .skip / .only / .todo forms and x- or f- prefixes.
    // Nesting follows the braces of each describe's callback; comments, strings and template literals are skipped. A name that is built at run time
    // (a template with ${}, a variable, it.each) is not found here: it appears after a run.
    function scanJs(src) {
        const text = String(src), n = text.length, rootNode = { children: [] };
        const stack = [{ node: rootNode, depth: 0 }];
        let depth = 0, line = 1, i = 0, pending = null;
        const CALL = /^(describe|context|suite|it|test|specify|xdescribe|xit|xtest|fdescribe|fit|ftest)(?:\.(skip|only|todo))?\s*\(\s*(['"`])/;
        const isId = (c) => /[A-Za-z0-9_$.]/.test(c || '');
        while (i < n) {
            const c = text[i], c2 = text[i + 1];
            if (c === '\n') { line++; i++; continue; }
            if (c === '/' && c2 === '/') { while (i < n && text[i] !== '\n') i++; continue; }
            if (c === '/' && c2 === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') line++; i++; } i += 2; continue; }
            if (c === '\'' || c === '"') { i++; while (i < n && text[i] !== c && text[i] !== '\n') { if (text[i] === '\\') i++; i++; } i++; continue; }
            if (c === '`') {
                i++; let d = 0;
                while (i < n) {
                    const ch = text[i];
                    if (ch === '\\') { i += 2; continue; }
                    if (ch === '\n') line++;
                    if (ch === '$' && text[i + 1] === '{') { d++; i += 2; continue; }
                    if (ch === '}' && d > 0) { d--; i++; continue; }
                    if (ch === '`' && d === 0) break;
                    i++;
                }
                i++; continue;
            }
            if (c === '{') { depth++; if (pending) { stack.push({ node: pending, depth }); pending = null; } i++; continue; }
            if (c === '}') { if (stack.length > 1 && stack[stack.length - 1].depth === depth) stack.pop(); depth--; i++; continue; }
            if (/[A-Za-z_$]/.test(c) && !isId(text[i - 1])) {
                const m = CALL.exec(text.slice(i, i + 60));
                if (m) {
                    const word = m[1], mod = m[2] || '', q = m[3];
                    const isSuite = /describe|context|suite/.test(word), at = i + m[0].length - 1;
                    // read the literal name
                    let j = at + 1, name = '', dynamic = false;
                    while (j < n && text[j] !== q) {
                        if (text[j] === '\\') { name += text[j + 1] === 'n' ? ' ' : text[j + 1]; j += 2; continue; }
                        if (q === '`' && text[j] === '$' && text[j + 1] === '{') { dynamic = true; break; }
                        if (text[j] === '\n' && q !== '`') { dynamic = true; break; }
                        name += text[j]; j++;
                    }
                    // a name followed by something other than a comma or a closing parenthesis is an expression ("a" + b): not a plain name
                    const after = text.slice(j + 1, j + 40).trimStart()[0];
                    if (!dynamic && name && (after === ',' || after === ')')) {
                        const node = { kind: isSuite ? 'suite' : 'test', name, line, skipped: mod === 'skip' || /^x/.test(word), only: mod === 'only' || /^f/.test(word), todo: mod === 'todo', children: [] };
                        stack[stack.length - 1].node.children.push(node);
                        if (isSuite) pending = node;
                    }
                    i += m[1].length; continue;
                }
            }
            i++;
        }
        return rootNode.children;
    }

    // Python: unittest.TestCase classes and `def test*` methods; pytest-style `class Test*` and top-level `def test*`. Indentation decides nesting.
    function scanPython(src) {
        const lines = String(src).split(/\r?\n/), out = [];
        let cls = null, skipNext = false, inTriple = null;
        for (let idx = 0; idx < lines.length; idx++) {
            const raw = lines[idx];
            if (inTriple) { if (raw.includes(inTriple)) inTriple = null; continue; }
            const trimmed = raw.trim();
            const trip = /("""|''')/.exec(raw);
            if (trip && (raw.split(trip[1]).length - 1) % 2 === 1) inTriple = trip[1];
            if (!trimmed || trimmed[0] === '#') continue;
            const indent = raw.length - raw.trimStart().length;
            const dec = /^@(.+)/.exec(trimmed);
            if (dec) { if (/\bskip\b(?!If|Unless)/.test(dec[1]) || /\.skip\b/.test(dec[1])) skipNext = true; continue; }
            if (indent === 0 && !/^[)\]}]/.test(trimmed)) cls = null; // a top-level statement ends the class that was open (a class line below starts a new one)
            const m = /^(async\s+def|def|class)\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?/.exec(trimmed);
            if (!m) continue;
            const kind = m[1] === 'class' ? 'class' : 'def', name = m[2], bases = m[3] || '', line = idx + 1, skipped = skipNext;
            skipNext = false;
            if (kind === 'class') {
                if (indent === 0) {
                    const unit = /TestCase\b/.test(bases);
                    cls = (unit || /^Test/.test(name)) ? { kind: 'suite', name, line, skipped, framework: unit ? 'unittest' : 'pytest', children: [] } : null;
                    if (cls) out.push(cls);
                }
            } else if (/^test/.test(name)) {
                if (indent === 0) out.push({ kind: 'test', name, line, skipped, framework: 'pytest', children: [] }); else if (cls) cls.children.push({ kind: 'test', name, line, skipped, children: [] });
            }
        }
        return out;
    }
    // Which Python framework runs a file: the configured one, else pytest when the file imports it or has pytest-style tests, else unittest.
    function pythonFramework(src, nodes, choice) {
        if (choice === 'unittest' || choice === 'pytest') return choice;
        if (/^\s*(?:import|from)\s+pytest\b/m.test(String(src))) return 'pytest';
        return (nodes || []).some((n) => n.framework === 'pytest') ? 'pytest' : 'unittest';
    }
    const scanFile = (lang, src) => (lang === 'python' ? scanPython(src) : scanJs(src));

    // ---------------------------------------------------------------------------------------------
    // Pure: results and the tree
    // ---------------------------------------------------------------------------------------------
    const fullName = (names) => names.join(SEP);
    const baseName = (s) => String(s).replace(/\[.*$/s, '');
    const STATES = ['passed', 'failed', 'skipped', 'running', 'todo'];

    // The tree of one file: static nodes with the results laid over them, plus tests that only the run knew of.
    // result: { byName: { 'Suite > test': { state, ms, error } }, fileError } or undefined. Node: { kind, name, names, line, state, ms, error, children, dynamic }.
    function buildFileTree(staticNodes, result) {
        const byName = (result && result.byName) || {}, used = new Set();
        const conv = (n, names) => {
            const nm = names.concat(n.name), key = fullName(nm), r = byName[key];
            const node = { kind: n.kind, name: n.name, names: nm, line: n.line || 0, state: 'idle', ms: 0, error: null, skippedStatic: !!n.skipped, todo: !!n.todo, dynamic: false, children: [] };
            if (r) { used.add(key); node.state = r.state; node.ms = r.ms || 0; node.error = r.error || null; }
            else if (n.kind === 'test' && (n.skipped || n.todo)) node.state = n.todo ? 'todo' : 'skipped';
            node.children = (n.children || []).map((c) => conv(c, nm));
            return node;
        };
        const nodes = (staticNodes || []).map((n) => conv(n, []));
        const find = (list, name, kind) => list.find((x) => x.name === name && (!kind || x.kind === kind));
        Object.keys(byName).forEach((key) => {
            if (used.has(key)) return;
            const names = key.split(SEP), r = byName[key];
            let list = nodes, acc = [];
            for (let i = 0; i < names.length - 1; i++) {
                acc = acc.concat(names[i]);
                let s = find(list, names[i]);
                if (!s) { s = { kind: 'suite', name: names[i], names: acc.slice(), line: 0, state: 'idle', ms: 0, error: null, dynamic: true, children: [] }; list.push(s); }
                list = s.children;
            }
            const last = names[names.length - 1], parentTest = last.includes('[') ? find(list, baseName(last), 'test') : null;
            const leaf = { kind: 'test', name: last, names, line: parentTest ? parentTest.line : 0, state: r.state, ms: r.ms || 0, error: r.error || null, dynamic: true, children: [] };
            (parentTest ? parentTest.children : list).push(leaf);
        });
        const settle = (node) => {
            node.children.forEach(settle);
            if (!node.children.length) return;
            const kids = node.children.map((c) => c.state);
            node.ms = node.children.reduce((a, c) => a + (c.ms || 0), 0);
            if (node.kind === 'test') { // a test with cases (pytest parameters)
                if (kids.includes('failed')) node.state = 'failed'; else if (kids.includes('running')) node.state = 'running'; else if (kids.every((s) => s === 'skipped')) node.state = 'skipped'; else if (kids.every((s) => s === 'passed' || s === 'skipped')) node.state = 'passed';
                const bad = node.children.find((c) => c.state === 'failed'); if (bad) node.error = bad.error;
                return;
            }
            node.state = kids.includes('failed') ? 'failed' : kids.includes('running') ? 'running' : kids.every((s) => s === 'idle') ? 'idle' : kids.every((s) => s === 'skipped' || s === 'todo' || s === 'idle') && !kids.includes('passed') ? (kids.includes('skipped') ? 'skipped' : 'idle') : kids.includes('idle') && !kids.includes('passed') ? 'idle' : 'passed';
        };
        nodes.forEach(settle);
        return nodes;
    }
    // Every test that actually runs (a leaf): a test with cases counts its cases, not itself.
    function leaves(nodes, out) {
        out = out || [];
        (nodes || []).forEach((n) => { if (n.kind === 'test' && !n.children.length) out.push(n); else leaves(n.children, out); });
        return out;
    }
    // Totals for the summary bar. `files` is a list of file nodes: { children }.
    function summarize(files) {
        const s = { passed: 0, failed: 0, skipped: 0, running: 0, idle: 0, todo: 0, total: 0, ms: 0 };
        (files || []).forEach((f) => {
            leaves(f.children).forEach((t) => { s.total++; s[t.state] = (s[t.state] || 0) + 1; s.ms += t.ms || 0; });
            if (f.fileError) { s.failed++; s.total++; }
        });
        return s;
    }
    const took = (ms) => (ms < 1000 ? Math.max(0, Math.round(ms)) + ' ms' : ms < 60000 ? (ms / 1000).toFixed(1) + ' s' : Math.floor(ms / 60000) + ' min ' + Math.round((ms % 60000) / 1000) + ' s');

    // The search box and the All / Failed / Passed control. A test is kept when its full name has the query and its state fits; a suite or file whose own name
    // matches keeps every test that fits the state.
    function filterTree(files, q, mode) {
        const query = String(q || '').trim().toLowerCase(), want = mode === 'failed' ? ['failed'] : mode === 'passed' ? ['passed'] : null;
        const fits = (n) => !want || want.includes(n.state);
        const keep = (n, ownMatch, file) => {
            const nameHit = ownMatch || !query || (file + ' ' + n.names.join(' ')).toLowerCase().includes(query);
            if (n.kind === 'test' && !n.children.length) return nameHit && fits(n) ? Object.assign({}, n) : null;
            const hit = ownMatch || !query || n.name.toLowerCase().includes(query);
            const kids = n.children.map((c) => keep(c, hit, file)).filter(Boolean);
            return kids.length ? Object.assign({}, n, { children: kids }) : null;
        };
        return (files || []).map((f) => {
            const fileHit = !query || f.path.toLowerCase().includes(query);
            const kids = f.children.map((c) => keep(c, fileHit, f.path)).filter(Boolean);
            if (kids.length) return Object.assign({}, f, { children: kids });
            // a file that failed to load has no tests to show, but it is a failure
            return f.fileError && (!want || want.includes('failed')) && (!query || fileHit) ? Object.assign({}, f, { children: [] }) : null;
        }).filter(Boolean);
    }

    // ---------------------------------------------------------------------------------------------
    // The JavaScript runtime. This function is SENT AS TEXT to the isolated host (Function.prototype.toString), so it must use nothing from
    // outside itself. It collects the tests a file registers, runs them one by one and reports each as a line of `@@cm-test:<nonce>@@ {json}` on the
    // console. Everything else the tests print goes to the console as it is.
    //   cfg:  { nonce, entry, filter: null | [[names]], timeoutMs, ranges: [{ path, start, end }] }
    //   defs: { 'path/to/file.js': function (module, exports, require, __filename, __dirname, <the test globals>) { <the file's own text> } }
    //   calib: the stack of an Error made on line 1 of the program, to learn how this engine numbers lines
    // ---------------------------------------------------------------------------------------------
    async function jsRuntime(cfg, defs, calib) {
        const MARK = '@@cm-test:' + cfg.nonce + '@@ ';
        const emit = (ev) => { console.log(MARK + JSON.stringify(ev)); };
        const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

        // ---- stack frames in the person's files ----
        const tail = /(\d+):(\d+)\)?\s*$/;
        let offset = null;
        try { const l = String(calib || '').split('\n').slice(1).map((x) => tail.exec(x)).find(Boolean); if (l) offset = Number(l[1]) - 1; } catch (e) { /* no line numbers on this engine */ }
        const framesOf = (err) => {
            const out = [];
            if (offset === null || !err || typeof err.stack !== 'string') return out;
            err.stack.split('\n').forEach((ln) => {
                const m = tail.exec(ln); if (!m) return;
                const pl = Number(m[1]) - offset, r = cfg.ranges.find((x) => pl >= x.start && pl <= x.end);
                if (r && out.length < 12) out.push({ file: r.path, line: pl - r.start + 1, col: Number(m[2]) });
            });
            return out;
        };

        // ---- showing values ----
        const fmt = (v, d, seen) => {
            d = d || 0; seen = seen || [];
            const t = typeof v;
            if (v === null) return 'null';
            if (v === undefined) return 'undefined';
            if (t === 'string') return JSON.stringify(v);
            if (t === 'number') return Object.is(v, -0) ? '-0' : String(v);
            if (t === 'bigint') return String(v) + 'n';
            if (t === 'boolean' || t === 'symbol') return String(v);
            if (t === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
            if (v instanceof Date) return isNaN(v) ? 'Invalid Date' : v.toISOString();
            if (v instanceof RegExp) return String(v);
            if (v instanceof Error) return v.name + ': ' + v.message;
            if (seen.indexOf(v) > -1) return '[Circular]';
            if (d > 5) return Array.isArray(v) ? '[Array]' : '[Object]';
            seen = seen.concat([v]);
            let s;
            if (Array.isArray(v)) s = '[' + v.slice(0, 40).map((x) => fmt(x, d + 1, seen)).join(', ') + (v.length > 40 ? ', ... ' + (v.length - 40) + ' more' : '') + ']';
            else if (v instanceof Map) s = 'Map {' + Array.from(v.entries()).slice(0, 30).map((e) => fmt(e[0], d + 1, seen) + ' => ' + fmt(e[1], d + 1, seen)).join(', ') + '}';
            else if (v instanceof Set) s = 'Set {' + Array.from(v.values()).slice(0, 30).map((x) => fmt(x, d + 1, seen)).join(', ') + '}';
            else {
                const keys = Object.keys(v), ctor = v.constructor && v.constructor.name && v.constructor.name !== 'Object' ? v.constructor.name + ' ' : '';
                s = ctor + '{' + keys.slice(0, 40).map((k) => k + ': ' + fmt(v[k], d + 1, seen)).join(', ') + (keys.length > 40 ? ', ...' : '') + '}';
            }
            return s.length > 3000 ? s.slice(0, 3000) + '...' : s;
        };

        // ---- equality (toEqual ignores properties that are undefined; strict does not, and also compares types) ----
        const asym = (x) => x && typeof x === 'object' && typeof x.$$asym === 'function';
        const same = (a, b, strict, seen) => {
            if (asym(b)) return b.$$asym(a, (x, y) => same(x, y, strict, seen));
            if (asym(a)) return a.$$asym(b, (x, y) => same(x, y, strict, seen));
            if (Object.is(a, b)) return true;
            if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
            seen = seen || [];
            if (seen.some((p) => p[0] === a && p[1] === b)) return true;
            if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
            if (a instanceof RegExp || b instanceof RegExp) return String(a) === String(b);
            if (Array.isArray(a) !== Array.isArray(b)) return false;
            if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
            seen = seen.concat([[a, b]]);
            if (a instanceof Map && b instanceof Map) return a.size === b.size && Array.from(a).every((e) => b.has(e[0]) && same(e[1], b.get(e[0]), strict, seen));
            if (a instanceof Set && b instanceof Set) return a.size === b.size && Array.from(a).every((x) => b.has(x) || Array.from(b).some((y) => same(x, y, strict, seen)));
            const ka = Object.keys(a).filter((k) => strict || a[k] !== undefined), kb = Object.keys(b).filter((k) => strict || b[k] !== undefined);
            if (ka.length !== kb.length) return false;
            return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && same(a[k], b[k], strict, seen));
        };

        // ---- failures ----
        class AssertionError extends Error {
            constructor(message, o) { super(message); this.name = 'AssertionError'; if (o) { this.expected = o.expected; this.actual = o.actual; this.hasCompare = true; this.operator = o.operator; } }
        }
        const failCmp = (message, actual, expected, operator) => { throw new AssertionError(message, { actual: fmt(actual), expected: fmt(expected), operator }); };

        // ---- expect ----
        const asymmetric = (fn, label) => ({ $$asym: fn, toString: () => label });
        const matchObj = (got, want, eq) => got !== null && typeof got === 'object' && Object.keys(want).every((k) => k in got && eq(got[k], want[k]));
        const expect = (actual) => {
            const make = (negate, mode) => {
                const m = {};
                const lift = (f) => (...args) => {
                    if (mode === 'resolves' || mode === 'rejects') {
                        return Promise.resolve(actual).then((v) => { if (mode === 'rejects') throw new AssertionError('Expected the promise to reject, but it resolved with ' + fmt(v)); return f(v, args); },
                            (e) => { if (mode === 'resolves') throw new AssertionError('Expected the promise to resolve, but it rejected with ' + fmt(e)); return f(e, args); });
                    }
                    return f(actual, args);
                };
                const def = (name, f) => { m[name] = lift(f); };
                const chk = (a, pass, what, exp, cmp) => {
                    if (pass !== negate) return;
                    const msg = 'Expected ' + fmt(a) + (negate ? ' not ' : ' ') + what;
                    if (cmp && !negate) failCmp(msg, a, exp, 'expect');
                    throw new AssertionError(msg);
                };
                def('toBe', (a, [e]) => chk(a, Object.is(a, e), 'to be ' + fmt(e), e, true));
                def('toEqual', (a, [e]) => chk(a, same(a, e, false), 'to equal ' + fmt(e), e, true));
                def('toStrictEqual', (a, [e]) => chk(a, same(a, e, true), 'to strictly equal ' + fmt(e), e, true));
                def('toBeTruthy', (a) => chk(a, !!a, 'to be truthy'));
                def('toBeFalsy', (a) => chk(a, !a, 'to be falsy'));
                def('toBeNull', (a) => chk(a, a === null, 'to be null'));
                def('toBeUndefined', (a) => chk(a, a === undefined, 'to be undefined'));
                def('toBeDefined', (a) => chk(a, a !== undefined, 'to be defined'));
                def('toBeNaN', (a) => chk(a, Number.isNaN(a), 'to be NaN'));
                def('toBeGreaterThan', (a, [e]) => chk(a, a > e, 'to be greater than ' + fmt(e)));
                def('toBeGreaterThanOrEqual', (a, [e]) => chk(a, a >= e, 'to be at least ' + fmt(e)));
                def('toBeLessThan', (a, [e]) => chk(a, a < e, 'to be less than ' + fmt(e)));
                def('toBeLessThanOrEqual', (a, [e]) => chk(a, a <= e, 'to be at most ' + fmt(e)));
                def('toBeCloseTo', (a, [e, digits]) => chk(a, Math.abs(a - e) < Math.pow(10, -(digits === undefined ? 2 : digits)) / 2, 'to be close to ' + fmt(e), e, true));
                def('toBeInstanceOf', (a, [C]) => chk(a, a instanceof C, 'to be an instance of ' + (C && C.name)));
                def('toContain', (a, [e]) => chk(a, typeof a === 'string' ? a.indexOf(e) > -1 : a != null && typeof a[Symbol.iterator] === 'function' && Array.from(a).indexOf(e) > -1, 'to contain ' + fmt(e)));
                def('toContainEqual', (a, [e]) => chk(a, a != null && Array.from(a).some((x) => same(x, e, false)), 'to contain an item equal to ' + fmt(e)));
                def('toHaveLength', (a, [e]) => chk(a, a != null && a.length === e, 'to have length ' + e + ' (it has ' + (a == null ? 'none' : a.length) + ')'));
                def('toMatch', (a, [e]) => chk(a, typeof a === 'string' && (e instanceof RegExp ? e.test(a) : a.indexOf(e) > -1), 'to match ' + fmt(e)));
                def('toMatchObject', (a, [e]) => chk(a, matchObj(a, e, (x, y) => (y && typeof y === 'object' && !asym(y) && !Array.isArray(y) ? matchObj(x, y, same) : same(x, y, false))), 'to match object ' + fmt(e), e, true));
                def('toHaveProperty', (a, args) => {
                    const path = Array.isArray(args[0]) ? args[0] : String(args[0]).split('.'); let cur = a, ok = a != null;
                    for (let i = 0; i < path.length && ok; i++) { if (cur != null && Object(cur) === cur && path[i] in cur) cur = cur[path[i]]; else ok = false; }
                    chk(a, ok && (args.length < 2 || same(cur, args[1], false)), 'to have property ' + path.join('.') + (args.length > 1 ? ' = ' + fmt(args[1]) : ''));
                });
                def('toThrow', (f, [e]) => {
                    let thrown = null, did = false;
                    if (mode === 'rejects') { did = true; thrown = f; } // the rejected value is what is checked, as in jest
                    else { try { f(); } catch (x) { did = true; thrown = x; } }
                    let pass = did;
                    if (did && e !== undefined) {
                        const msg = thrown && thrown.message !== undefined ? String(thrown.message) : String(thrown);
                        pass = typeof e === 'string' ? msg.indexOf(e) > -1 : e instanceof RegExp ? e.test(msg) : typeof e === 'function' ? thrown instanceof e : false;
                    }
                    if (pass === negate) throw new AssertionError((negate ? 'Expected the function not to throw' : 'Expected the function to throw' + (e !== undefined ? ' ' + fmt(e) : '')) + (did ? ', but it threw ' + fmt(thrown) : ', but it did not'));
                });
                return m;
            };
            const base = make(false);
            base.not = make(true);
            base.resolves = make(false, 'resolves'); base.resolves.not = make(true, 'resolves');
            base.rejects = make(false, 'rejects'); base.rejects.not = make(true, 'rejects');
            return base;
        };
        expect.any = (C) => asymmetric((a) => (C === String ? typeof a === 'string' : C === Number ? typeof a === 'number' : C === Boolean ? typeof a === 'boolean' : C === Function ? typeof a === 'function' : a instanceof C), 'Any<' + (C && C.name) + '>');
        expect.anything = () => asymmetric((a) => a !== null && a !== undefined, 'Anything');
        expect.objectContaining = (o) => asymmetric((a, eq) => matchObj(a, o, eq), 'ObjectContaining');
        expect.arrayContaining = (arr) => asymmetric((a, eq) => Array.isArray(a) && arr.every((x) => a.some((y) => eq(y, x))), 'ArrayContaining');
        expect.stringContaining = (s) => asymmetric((a) => typeof a === 'string' && a.indexOf(s) > -1, 'StringContaining');
        expect.stringMatching = (r) => asymmetric((a) => typeof a === 'string' && new RegExp(r).test(a), 'StringMatching');

        // ---- require('assert') ----
        const assertFn = (v, msg) => { if (!v) throw new AssertionError(msg || 'The expression is falsy: ' + fmt(v), { actual: fmt(v), expected: 'true', operator: '==' }); };
        const A = Object.assign(assertFn, {
            ok: assertFn, AssertionError,
            equal: (a, b, msg) => { if (!(a == b)) failCmp(msg || 'Expected values to be loosely equal: ' + fmt(a) + ' != ' + fmt(b), a, b, '=='); },
            notEqual: (a, b, msg) => { if (a == b) failCmp(msg || 'Expected values to differ: ' + fmt(a) + ' == ' + fmt(b), a, b, '!='); },
            strictEqual: (a, b, msg) => { if (!Object.is(a, b)) failCmp(msg || 'Expected values to be strictly equal: ' + fmt(a) + ' !== ' + fmt(b), a, b, 'strictEqual'); },
            notStrictEqual: (a, b, msg) => { if (Object.is(a, b)) failCmp(msg || 'Expected "actual" to be strictly unequal to ' + fmt(b), a, b, 'notStrictEqual'); },
            deepEqual: (a, b, msg) => { if (!same(a, b, false)) failCmp(msg || 'Expected values to be loosely deep-equal', a, b, 'deepEqual'); },
            deepStrictEqual: (a, b, msg) => { if (!same(a, b, true)) failCmp(msg || 'Expected values to be strictly deep-equal', a, b, 'deepStrictEqual'); },
            notDeepStrictEqual: (a, b, msg) => { if (same(a, b, true)) failCmp(msg || 'Expected "actual" not to be strictly deep-equal to ' + fmt(b), a, b, 'notDeepStrictEqual'); },
            throws: (f, exp, msg) => {
                let thrown, did = false; try { f(); } catch (e) { did = true; thrown = e; }
                if (!did) throw new AssertionError(typeof exp === 'string' ? exp : msg || 'Missing expected exception.');
                if (exp instanceof RegExp && !exp.test(String(thrown && thrown.message !== undefined ? thrown.message : thrown))) throw new AssertionError('The error message does not match ' + fmt(exp) + ': ' + fmt(thrown));
                if (typeof exp === 'function' && exp.prototype !== undefined && !(thrown instanceof exp)) throw new AssertionError('The error is not an instance of ' + exp.name + ': ' + fmt(thrown));
            },
            doesNotThrow: (f, msg) => { try { f(); } catch (e) { throw new AssertionError(msg || 'Got unwanted exception: ' + fmt(e)); } },
            rejects: async (p, exp, msg) => { let did = false; try { await (typeof p === 'function' ? p() : p); } catch (e) { did = true; } if (!did) throw new AssertionError(msg || 'Missing expected rejection.'); },
            match: (s, re, msg) => { if (!(re instanceof RegExp && re.test(s))) failCmp(msg || 'The input did not match the regular expression ' + fmt(re), s, re, 'match'); },
            fail: (msg) => { throw new AssertionError(msg || 'Failed'); },
            ifError: (v) => { if (v !== null && v !== undefined) throw v; }
        });
        A.strict = A; A.default = A;

        // ---- collecting: a suite holds its items in the order they were written, plus its four kinds of hook ----
        const mkSuite = (name, parent) => ({ name, parent, items: [], bA: [], aA: [], bE: [], aE: [], skip: false, only: false, started: false, hooked: false });
        const top = mkSuite(null, null);
        let cur = top, hasOnly = false;
        const addSuite = (name, fn, mod) => {
            const s = mkSuite(String(name), cur); s.skip = mod === 'skip' || cur.skip; s.only = mod === 'only'; if (s.only) hasOnly = true;
            cur.items.push({ suite: s });
            const prev = cur; cur = s; try { fn(); } finally { cur = prev; }
        };
        const addTest = (name, fn, timeout, mod) => {
            if (mod === 'only') hasOnly = true;
            cur.items.push({ test: { name: String(name), fn, timeout: typeof timeout === 'number' ? timeout : 0, skip: mod === 'skip' || cur.skip, todo: mod === 'todo', only: mod === 'only', parent: cur } });
        };
        const kinds = (add) => {
            const f = (name, fn, timeout) => add(name, fn, timeout, '');
            f.skip = (name, fn, timeout) => add(name, fn, timeout, 'skip');
            f.only = (name, fn, timeout) => add(name, fn, timeout, 'only');
            f.todo = (name) => add(name, () => {}, 0, 'todo');
            return f;
        };
        const describe = kinds((name, fn, _t, mod) => addSuite(name, fn, mod));
        const it = kinds((name, fn, timeout, mod) => addTest(name, fn, timeout, mod));
        const beforeAll = (fn) => { cur.bA.push(fn); }, afterAll = (fn) => { cur.aA.push(fn); };
        const beforeEach = (fn) => { cur.bE.push(fn); }, afterEach = (fn) => { cur.aE.push(fn); };

        // ---- require: the person's own files (relative paths) and assert ----
        const cache = Object.create(null);
        const norm = (p) => { const out = []; p.split('/').forEach((s) => { if (s === '' || s === '.') return; if (s === '..') out.pop(); else out.push(s); }); return out.join('/'); };
        const dirOf = (p) => p.split('/').slice(0, -1).join('/');
        const resolve = (from, spec) => {
            const base = norm((dirOf(from) ? dirOf(from) + '/' : '') + spec);
            return [base, base + '.js', base + '.json', base + '/index.js'].find((c) => Object.prototype.hasOwnProperty.call(defs, c)) || null;
        };
        const load = (path) => {
            if (cache[path]) return cache[path].exports;
            const module = { exports: {}, id: path, filename: path }; cache[path] = module;
            const req = (spec) => {
                spec = String(spec);
                if (spec === 'assert' || spec === 'node:assert' || spec === 'assert/strict') return A;
                if (spec[0] !== '.') throw new Error("Cannot find module '" + spec + "'. Tests can require 'assert' and files of this workspace by a relative path; other packages are not available here.");
                const hit = resolve(path, spec);
                if (!hit) throw new Error("Cannot find module '" + spec + "' from " + path);
                return load(hit);
            };
            defs[path].call(module.exports, module, module.exports, req, path, dirOf(path), describe, describe, it, it, it, expect, beforeAll, afterAll, beforeEach, afterEach);
            return module.exports;
        };

        // ---- running ----
        const t0 = now();
        try { load(cfg.entry); } catch (e) {
            emit({ t: 'load-error', message: String(e && e.message !== undefined ? e.message : e), name: String(e && e.name || 'Error'), frames: framesOf(e), stack: String(e && e.stack || '').slice(0, 1500) });
            emit({ t: 'done', ms: now() - t0, count: 0 });
            return;
        }
        const wanted = (names) => !cfg.filter || cfg.filter.some((f) => f.length <= names.length && f.every((x, i) => x === names[i]));
        const mayHold = (names) => !cfg.filter || cfg.filter.some((f) => f.every((x, i) => i >= names.length || x === names[i]));
        const inOnly = (s) => { for (let x = s; x; x = x.parent) if (x.only) return true; return false; };
        const call = (fn, ms) => {
            let timer;
            const work = new Promise((resolve, reject) => {
                try {
                    if (fn.length >= 1) { fn((err) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve())); return; }
                    Promise.resolve(fn()).then(resolve, reject);
                } catch (e) { reject(e); }
            });
            const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out after ' + ms + ' ms (a test that neither returns nor calls done in time fails)')), ms); });
            return Promise.race([work, limit]).finally(() => clearTimeout(timer));
        };
        const errInfo = (e) => {
            const o = { name: String(e && e.name || 'Error'), message: String(e && e.message !== undefined ? e.message : fmt(e)), frames: framesOf(e), stack: String(e && e.stack || '').slice(0, 1500) };
            if (e && e.hasCompare) { o.expected = e.expected; o.actual = e.actual; }
            return o;
        };
        const lineage = (s) => { const out = []; for (let x = s; x; x = x.parent) out.unshift(x); return out; }; // the file's top, then each suite down to this one
        let count = 0;
        const runSuite = async (s, names) => {
            for (const item of s.items) {
                if (item.suite) { const nm = names.concat(item.suite.name); if (mayHold(nm)) await runSuite(item.suite, nm); continue; }
                const t = item.test, nm = names.concat(t.name);
                if (!wanted(nm)) continue;
                if (hasOnly && !t.only && !inOnly(t.parent)) continue;
                if (t.todo) { emit({ t: 'result', path: nm, state: 'todo', ms: 0 }); count++; continue; }
                if (t.skip) { emit({ t: 'result', path: nm, state: 'skipped', ms: 0 }); count++; continue; }
                emit({ t: 'start', path: nm });
                const ms = t.timeout || cfg.timeoutMs, t1 = now(), chain = lineage(t.parent);
                let err = null;
                try {
                    for (const st of chain) { st.started = true; if (!st.hooked) { st.hooked = true; for (const h of st.bA) await call(h, ms); } }
                    for (const st of chain) for (const h of st.bE) await call(h, ms);
                    await call(t.fn, ms);
                } catch (e) { err = e; }
                try { for (const st of chain.slice().reverse()) for (const h of st.aE) await call(h, ms); } catch (e) { err = err || e; }
                const took = now() - t1;
                emit(err ? { t: 'result', path: nm, state: 'failed', ms: took, error: errInfo(err) } : { t: 'result', path: nm, state: 'passed', ms: took });
                count++;
            }
            if (s.started) { try { for (const h of s.aA) await call(h, cfg.timeoutMs); } catch (e) { emit({ t: 'log', text: 'afterAll failed' + (s.name ? ' in "' + s.name + '"' : '') + ': ' + fmt(e) }); } }
        };
        await runSuite(top, []);
        emit({ t: 'done', ms: now() - t0, count });
    }

    // ---------------------------------------------------------------------------------------------
    // Pure: building the program a test file runs inside, and reading what it reports
    // ---------------------------------------------------------------------------------------------
    const MODULE_PARAMS = 'module, exports, require, __filename, __dirname, describe, context, it, test, specify, expect, beforeAll, afterAll, beforeEach, afterEach';
    const REQ_RE = /\brequire\s*\(\s*(['"])(\.{1,2}(?:\/[^'"\n]*)?)\1\s*\)/g;
    const ESM_RE = /^\s*(?:import\s+(?:[\w*${][^;\n]*\sfrom\s+)?['"]|import\s+[\w*${][^;\n]*\sfrom\s+['"]|export\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|async\b|\{|\*))/m;
    const normPath = (p) => { const out = []; String(p).split('/').forEach((s) => { if (s === '' || s === '.') return; if (s === '..') out.pop(); else out.push(s); }); return out.join('/'); };
    const dirOf = (p) => String(p).split('/').slice(0, -1).join('/');

    // The entry file and every workspace file it require()s by a relative path, found by reading the text (no running). readText(path) -> string | null.
    // -> { modules: [{ path, text }], error: '' }
    function collectJsModules(entry, readText) {
        const modules = [], seen = new Set(); let total = 0, error = '';
        const resolve = (from, spec) => {
            const base = normPath((dirOf(from) ? dirOf(from) + '/' : '') + spec);
            return [base, base + '.js', base + '.json', base + '/index.js'].find((c) => readText(c) !== null) || null;
        };
        (function visit(path, depth) {
            if (error || seen.has(path)) return;
            if (modules.length >= 60 || depth > 20) { error = 'Too many files are required (the limit is 60 files, 20 levels deep).'; return; }
            const text = readText(path);
            if (text === null) { error = 'File not found: ' + path; return; }
            total += text.length;
            if (total > TOTAL_FILES_MAX) { error = 'The files this test requires are larger than 1.5 MB together.'; return; }
            if (!/\.json$/i.test(path) && ESM_RE.test(text)) { error = path + ' uses import / export syntax. Tests here are CommonJS: use require() and module.exports.'; return; }
            seen.add(path); modules.push({ path, text });
            if (/\.json$/i.test(path)) return;
            let m; REQ_RE.lastIndex = 0;
            const specs = []; while ((m = REQ_RE.exec(text))) specs.push(m[2]);
            specs.forEach((spec) => { const hit = resolve(path, spec); if (hit) visit(hit, depth + 1); /* a require that cannot be found fails when the test runs, with the usual message */ });
        })(entry, 0);
        return { modules, error };
    }

    // -> { code, ranges }. The program: one expression that awaits the runtime above, with the test file and its requires as functions in an object.
    // ranges say which program lines belong to which file, so a stack frame can be turned back into "file:line". Nothing here runs anything.
    function jsProgram(o) {
        const cfgBase = { nonce: o.nonce, entry: o.entry, filter: o.filter || null, timeoutMs: o.timeoutMs || 5000 };
        const head = (ranges) => 'const __cmCalib = new Error(\'calib\').stack;\nawait (' + jsRuntime.toString() + ')(' + JSON.stringify(Object.assign({}, cfgBase, { ranges })) + ', {\n';
        const nl = (s) => (s.match(/\n/g) || []).length;
        const headLines = nl(head([])); // the config is one line whatever it holds, so this does not depend on the ranges
        const ranges = []; let line = headLines + 1, body = '';
        o.modules.forEach((m) => {
            const isJson = /\.json$/i.test(m.path);
            const text = isJson ? 'module.exports = JSON.parse(' + JSON.stringify(m.text) + ');' : String(m.text).replace(/^#!.*/, '//');
            const count = text.split('\n').length;
            body += JSON.stringify(m.path) + ': function (' + MODULE_PARAMS + ') {\n' + text + '\n},\n';
            ranges.push({ path: m.path, start: line + 1, end: line + count });
            line += count + 2;
        });
        return { code: head(ranges) + body + '}, __cmCalib);\n', ranges };
    }

    function b64utf8(str) {
        const bytes = new TextEncoder().encode(String(str)); let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
    }

    // The Python harness. It runs in a namespace of its own (the program below execs it), so nothing it defines lands in the person's Python.
    // It writes the workspace's text files to a temporary folder, runs unittest or pytest on the test file, and reports like the JavaScript runtime.
    const PY_HARNESS = String.raw`
import sys, os, re, json, time, base64, importlib, importlib.util, traceback, shutil, io, contextlib
_cm = json.loads(base64.b64decode("__CM_B64__").decode("utf-8"))
_MARK = "@@cm-test:" + _cm["nonce"] + "@@ "
_out = sys.stdout
def _emit(ev):
    print(_MARK + json.dumps(ev, ensure_ascii=True), file=_out, flush=True)
_root = "/tmp/cm_ws_" + _cm["nonce"]
_old_path, _old_cwd = list(sys.path), os.getcwd()
def _purge():
    for _k, _m in list(sys.modules.items()):
        _f = getattr(_m, "__file__", None)
        if _f and str(_f).startswith(_root):
            sys.modules.pop(_k, None)
def _rel(fn, relative_ok=False):
    fn = str(fn)
    if not fn.startswith("/"):
        if not relative_ok:
            return None
        fn = os.path.join(_root, fn)
    return fn[len(_root) + 1:] if fn.startswith(_root + "/") else None
def _frames(tb):
    out = []
    for fs in traceback.extract_tb(tb):
        r = _rel(fs.filename)
        if r is not None and len(out) < 12:
            out.append({"file": r, "line": fs.lineno, "text": (fs.line or "")[:200]})
    return out
def _err_info(et, ev, tb):
    d = {"name": et.__name__, "message": (str(ev) or et.__name__)[:2000], "frames": _frames(tb), "stack": "".join(traceback.format_exception(et, ev, tb))[-2500:]}
    # assertEqual and its relatives say "3 != 4" (or "Lists differ: [1] != [2]") on the first line; unittest trims its own frames from the traceback,
    # so the message is what there is to read. By the usual call order the first value is the actual one.
    if issubclass(et, AssertionError):
        m = re.match(r"^(?:[A-Za-z ]+ differ: )?(.+?) != (.+)$", str(ev).split("\n")[0])
        if m:
            d["actual"], d["expected"] = m.group(1)[:3000], m.group(2)[:3000]
    return d
def _match(names, flt):
    return flt is None or any(len(f) <= len(names) and names[:len(f)] == f for f in flt)

def _run_unittest(rel, flt):
    import unittest
    path = os.path.join(_root, rel)
    name = os.path.splitext(os.path.basename(rel))[0]
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    found = []
    def walk(s):
        for t in s:
            if isinstance(t, unittest.TestSuite):
                walk(t)
            else:
                found.append(t)
    walk(unittest.defaultTestLoader.loadTestsFromModule(mod))
    def names_of(t):
        return [type(t).__name__, getattr(t, "_testMethodName", "?")]
    class _Result(unittest.TestResult):
        def __init__(self):
            super().__init__()
            self._t0 = 0.0
            self._sub = set()
        def _ms(self):
            return round((time.perf_counter() - self._t0) * 1000, 2)
        def startTest(self, test):
            super().startTest(test)
            self._t0 = time.perf_counter()
            _emit({"t": "start", "path": names_of(test)})
        def addSuccess(self, test):
            super().addSuccess(test)
            if test.id() in self._sub:
                _emit({"t": "result", "path": names_of(test), "state": "failed", "ms": self._ms(), "error": {"name": "SubTestFailure", "message": "One or more subtests failed.", "frames": []}})
            else:
                _emit({"t": "result", "path": names_of(test), "state": "passed", "ms": self._ms()})
        def _bad(self, test, err):
            names = [str(test.description)] if type(test).__name__ == "_ErrorHolder" else names_of(test)
            _emit({"t": "result", "path": names, "state": "failed", "ms": self._ms(), "error": _err_info(*err)})
        def addFailure(self, test, err):
            super().addFailure(test, err)
            self._bad(test, err)
        def addError(self, test, err):
            super().addError(test, err)
            self._bad(test, err)
        def addSkip(self, test, reason):
            super().addSkip(test, reason)
            _emit({"t": "result", "path": names_of(test), "state": "skipped", "ms": 0, "error": {"name": "Skipped", "message": str(reason), "frames": []}})
        def addExpectedFailure(self, test, err):
            super().addExpectedFailure(test, err)
            _emit({"t": "result", "path": names_of(test), "state": "passed", "ms": self._ms()})
        def addUnexpectedSuccess(self, test):
            super().addUnexpectedSuccess(test)
            _emit({"t": "result", "path": names_of(test), "state": "failed", "ms": self._ms(), "error": {"name": "UnexpectedSuccess", "message": "The test was expected to fail but passed.", "frames": []}})
        def addSubTest(self, test, subtest, err):
            super().addSubTest(test, subtest, err)
            if err is not None:
                self._sub.add(test.id())
                _emit({"t": "result", "path": names_of(test) + [str(subtest._subDescription())], "state": "failed", "ms": self._ms(), "error": _err_info(*err)})
    picked = [t for t in found if _match(names_of(t), flt)]
    s = unittest.TestSuite(picked)
    s.run(_Result())

def _run_pytest(rel, flt):
    try:
        import pytest
    except ImportError:
        _emit({"t": "need", "pkg": "pytest"})
        return
    def names_of(nodeid):
        return nodeid.split("::")[1:]
    def pt_error(report):
        lr = report.longrepr
        crash = getattr(lr, "reprcrash", None)
        msg = (getattr(crash, "message", "") or str(lr))[:2000]
        frames = []
        try:
            for e in lr.reprtraceback.reprentries:
                loc = getattr(e, "reprfileloc", None)
                r = _rel(loc.path, True) if loc is not None else None
                if r is not None and len(frames) < 12:
                    frames.append({"file": r, "line": loc.lineno, "text": ""})
        except Exception:
            pass
        d = {"name": "AssertionError" if msg.lstrip().startswith(("assert", "AssertionError")) else "Error", "message": msg, "frames": frames, "stack": str(lr)[-2500:]}
        first = msg.split("\n")[0]
        if first.startswith("AssertionError: "):
            first = first[len("AssertionError: "):]
        m = None
        if first.startswith("assert "):
            import re
            m = re.match(r"^assert\s+(.*?)\s+==\s+(.*)$", first)
        if m:
            d["actual"], d["expected"] = m.group(1)[:3000], m.group(2)[:3000]
        return d
    class _P:
        def pytest_runtest_logstart(self, nodeid, location):
            _emit({"t": "start", "path": names_of(nodeid)})
        def pytest_runtest_logreport(self, report):
            names, ms = names_of(report.nodeid), round((report.duration or 0) * 1000, 2)
            if report.when == "call":
                out = getattr(report, "capstdout", "")
                if out:
                    _emit({"t": "log", "text": out.rstrip("\n")})
                if report.passed:
                    _emit({"t": "result", "path": names, "state": "passed", "ms": ms})
                elif report.skipped:
                    _emit({"t": "result", "path": names, "state": "skipped", "ms": ms})
                else:
                    _emit({"t": "result", "path": names, "state": "failed", "ms": ms, "error": pt_error(report)})
            elif report.failed:
                _emit({"t": "result", "path": names, "state": "failed", "ms": ms, "error": pt_error(report)})
            elif report.skipped and report.when == "setup":
                _emit({"t": "result", "path": names, "state": "skipped", "ms": 0})
        def pytest_collectreport(self, report):
            if report.failed:
                _emit({"t": "load-error", "message": str(report.longrepr)[-1500:], "name": "CollectError", "frames": []})
    targets = [rel] if flt is None else ["::".join([rel] + f) for f in flt]
    args = ["-p", "no:cacheprovider", "-p", "no:faulthandler", "--capture=sys", "-q", "--no-header", "-rN", "--rootdir=" + _root, "-c", os.path.join(_root, "_cm_pytest.ini")] + targets
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = pytest.main(args, plugins=[_P()])
    if int(code) in (3, 4):
        _emit({"t": "load-error", "message": buf.getvalue()[-1500:] or "pytest stopped with an internal error.", "name": "PytestError", "frames": []})

_t_start = time.perf_counter()
try:
    for _p, _text in _cm["files"].items():
        _full = os.path.join(_root, _p)
        os.makedirs(os.path.dirname(_full), exist_ok=True)
        with open(_full, "w", encoding="utf-8") as _fh:
            _fh.write(_text)
    with open(os.path.join(_root, "_cm_pytest.ini"), "w") as _fh:
        _fh.write("[pytest]\n")
    sys.path.insert(0, _root)
    _d = os.path.dirname(os.path.join(_root, _cm["rel"]))
    if _d != _root:
        sys.path.insert(0, _d)
    os.chdir(_root)
    _purge()
    if _cm["framework"] == "pytest":
        _run_pytest(_cm["rel"], _cm["filter"])
    else:
        _run_unittest(_cm["rel"], _cm["filter"])
except SystemExit:
    pass
except BaseException as _e:
    _frs = _frames(_e.__traceback__)
    _fn = getattr(_e, "filename", None)
    if isinstance(_e, SyntaxError) and _fn and _rel(_fn) is not None:
        _frs.insert(0, {"file": _rel(_fn), "line": _e.lineno or 1, "text": (_e.text or "").strip()[:200]})
    _emit({"t": "load-error", "message": (str(_e) or type(_e).__name__)[:1500], "name": type(_e).__name__, "frames": _frs})
finally:
    sys.path[:] = _old_path
    os.chdir(_old_cwd)
    _purge()
    shutil.rmtree(_root, ignore_errors=True)
    _emit({"t": "done", "ms": round((time.perf_counter() - _t_start) * 1000, 2)})
`;

    // The text files of the workspace a Python test may read or import: the test file first, then the .py files, then the rest, within size limits.
    function pyFiles(entries, entryPath) {
        const files = {}; let total = 0, count = 0;
        const rank = (e) => (e.path === entryPath ? 0 : /\.py$/i.test(e.path) ? 1 : 2);
        (entries || []).filter((e) => !e.rec.isLocked && e.rec.encoding !== 'base64' && typeof e.rec.content === 'string' && e.rec.content.length <= ONE_FILE_MAX)
            .sort((a, b) => rank(a) - rank(b)).forEach((e) => {
                if (count >= FILES_COUNT_MAX || total + e.rec.content.length > TOTAL_FILES_MAX) return;
                if (e.path.split('/').some((s) => s === '..' || s === '')) return;
                files[e.path] = e.rec.content; total += e.rec.content.length; count++;
            });
        return files;
    }
    // -> the code to run. The harness is sent as base64 and exec'd in a namespace of its own.
    function pyProgram(o) {
        const cfg = { nonce: o.nonce, rel: o.entry, framework: o.framework, filter: o.filter || null, files: o.files };
        const harness = PY_HARNESS.replace('__CM_B64__', b64utf8(JSON.stringify(cfg)));
        return 'import base64 as _cm_b\nexec(compile(_cm_b.b64decode("' + b64utf8(harness) + '").decode("utf-8"), "<codemini-tests>", "exec"), {"__name__": "__cm_tests__"})\ndel _cm_b\n';
    }

    // ---- reading the lines a run prints. Everything in an event is untrusted text: it is clipped and checked before it is used. ----
    const markerPrefix = (nonce) => '@@cm-test:' + nonce + '@@ ';
    const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '...' : s; };
    function cleanError(e) {
        if (!e || typeof e !== 'object') return null;
        const out = { name: clip(e.name || 'Error', 80), message: clip(e.message, 3000), stack: clip(e.stack, 3000), frames: [] };
        if (typeof e.expected === 'string' || typeof e.actual === 'string') { out.expected = clip(e.expected, 4000); out.actual = clip(e.actual, 4000); }
        if (Array.isArray(e.frames)) e.frames.slice(0, 12).forEach((f) => { if (f && typeof f.file === 'string' && Number.isFinite(Number(f.line))) out.frames.push({ file: clip(f.file, 300), line: Math.max(1, Math.floor(Number(f.line))), col: Math.max(0, Math.floor(Number(f.col) || 0)), text: clip(f.text || '', 200) }); });
        return out;
    }
    const cleanPath = (p) => (Array.isArray(p) && p.length && p.length <= 20 ? p.map((x) => clip(x, 300)) : null);
    // -> a checked event, or null when the line is not one of ours (or does not hold up)
    function parseMarkerLine(line, nonce) {
        const pre = markerPrefix(nonce), s = String(line);
        if (!s.startsWith(pre)) return null;
        let ev; try { ev = JSON.parse(s.slice(pre.length)); } catch (e) { return null; }
        if (!ev || typeof ev !== 'object') return null;
        if (ev.t === 'result') { const path = cleanPath(ev.path); if (!path || !STATES.includes(ev.state)) return null; return { t: 'result', path, state: ev.state, ms: Number.isFinite(Number(ev.ms)) ? Math.max(0, Number(ev.ms)) : 0, error: cleanError(ev.error) }; }
        if (ev.t === 'start') { const path = cleanPath(ev.path); return path ? { t: 'start', path } : null; }
        if (ev.t === 'load-error') return { t: 'load-error', error: cleanError({ name: ev.name, message: ev.message, stack: ev.stack, frames: ev.frames }) };
        if (ev.t === 'need') return ev.pkg === 'pytest' ? { t: 'need', pkg: 'pytest' } : null;
        if (ev.t === 'done') return { t: 'done', ms: Number.isFinite(Number(ev.ms)) ? Number(ev.ms) : 0 };
        if (ev.t === 'log') return { t: 'log', text: clip(ev.text, 4000) };
        return null;
    }

    // ---------------------------------------------------------------------------------------------
    // The run core: runs a list of test files, one after the other, against an injected environment (so it can be tested without a browser)
    // ---------------------------------------------------------------------------------------------
    // env: { now, nonce(), trusted(): bool, getRecords(): Promise<records>, rootParent(): string, config(): config, execUse(): Promise<bool>, execNotice(): string,
    //        execRun(req, onOut, ask): Promise<{error?}>, kill(), bgStart(opts) -> handle | null, ask(text), pipRun(tokens, onLine): Promise<{ ok, logs }> (optional),
    //        setTimer(fn, ms) / clearTimer(id) (optional, for tests), fileTimeoutMs (optional) }
    // plan: { label, targets: [{ path, lang, filter: null | [[names]] }] }
    // sink: { state(name), line(text, stream), fileStart(path), start(path, names), result(path, names, state, ms, error), fileError(path, error), fileEnd(path, info) }
    function createRunner(env) {
        let current = null; // { interrupted }
        const result = (state, text) => ({ state, text: text || '' });

        async function runFile(target, sink, me) {
            const records = await env.getRecords();
            const entries = listFiles(records, env.rootParent());
            const entry = entries.find((e) => e.path === target.path);
            if (!entry) return { error: 'File not found: ' + target.path };
            if (entry.rec.isLocked) return { error: target.path + ' is locked, so it cannot be run.' };
            if (entry.rec.encoding === 'base64' || typeof entry.rec.content !== 'string') return { error: target.path + ' is not a text file.' };
            const cfg = env.config(), byPath = new Map(entries.map((e) => [e.path, e.rec]));
            let framework = '';
            if (target.lang === 'python') framework = pythonFramework(entry.rec.content, scanPython(entry.rec.content), cfg.pythonFramework);
            let attempt = 0;
            for (;;) {
                const nonce = env.nonce();
                let code;
                if (target.lang === 'javascript') {
                    const mods = collectJsModules(target.path, (p) => { const r = byPath.get(p); return r && !r.isLocked && r.encoding !== 'base64' && typeof r.content === 'string' ? r.content : null; });
                    if (mods.error) return { error: mods.error };
                    code = jsProgram({ nonce, entry: target.path, modules: mods.modules, filter: target.filter, timeoutMs: cfg.timeoutMs }).code;
                } else code = pyProgram({ nonce, entry: target.path, framework, filter: target.filter, files: pyFiles(entries, target.path) });
                const seen = { done: false, need: false, loadError: null, results: 0 };
                const onOut = (e) => {
                    if (!e || e.kind === 'html') return;
                    const stream = (e.kind === 'error' || e.kind === 'stderr') ? 'err' : (e.kind === 'warn' || e.kind === 'info') ? 'sys' : 'out';
                    String(e.text).split('\n').forEach((ln, i, all) => {
                        if (i === all.length - 1 && ln === '' && all.length > 1) return; // the newline that ends the text
                        const ev = parseMarkerLine(ln, nonce);
                        if (!ev) { sink.line(ln, stream); return; }
                        if (ev.t === 'start') sink.start(target.path, ev.path);
                        else if (ev.t === 'result') { seen.results++; sink.result(target.path, ev.path, ev.state, ev.ms, ev.error); }
                        else if (ev.t === 'load-error') seen.loadError = ev.error;
                        else if (ev.t === 'need') seen.need = true;
                        else if (ev.t === 'done') seen.done = true;
                        else if (ev.t === 'log') ev.text.split('\n').forEach((l) => sink.line(l, 'out'));
                    });
                };
                let timer = null, timedOut = false;
                const limitMs = env.fileTimeoutMs || 60000;
                const setT = env.setTimer || ((f, ms) => setTimeout(f, ms)), clearT = env.clearTimer || ((id) => clearTimeout(id));
                const limit = new Promise((resolve) => { timer = setT(() => { timedOut = true; env.kill(); resolve({ error: { message: 'Timed out after ' + Math.round(limitMs / 1000) + ' s. The isolated host was shut down, so its variables were reset.' } }); }, limitMs); });
                const run = env.execRun({ lang: target.lang, code, opts: { trusted: true, autoInstall: false, sep: ' ' } }, onOut, env.ask).catch((e) => ({ error: { message: (e && e.message) || String(e) } }));
                const stopWait = new Promise((resolve) => { me.wake = () => resolve({ error: null }); }); // Stop ends the wait at once, whatever the host does
                const res = await Promise.race([run, limit, stopWait]);
                me.wake = null;
                clearT(timer);
                if (me.interrupted) return { stopped: true };
                if (seen.need && attempt === 0) {
                    attempt++;
                    if (!env.pipRun) return { error: 'pytest is needed but packages cannot be installed here.' };
                    sink.line('Installing pytest into the isolated Python (first run only)...', 'sys');
                    const r = await env.pipRun(['install', 'pytest'], (t) => sink.line(t, 'sys'));
                    (r.logs || []).forEach((l) => { if (l.kind === 'err') sink.line(l.text, 'err'); });
                    if (me.interrupted) return { stopped: true };
                    if (!r.ok) return { error: 'pytest could not be installed. Check the connection, or set "pythonFramework": "unittest" in .codemini/tests.json.' };
                    continue;
                }
                if (seen.loadError) return { error: seen.loadError };
                if (timedOut) return { error: { name: 'Timeout', message: res.error.message, frames: [] } };
                if (res && res.error && !seen.done) return { error: { name: String(res.error.name || 'Error'), message: String(res.error.message || res.error.text || 'The run ended with an error'), stack: String(res.error.text || ''), frames: [] } };
                if (!seen.done) return { error: 'The run ended before the tests finished.' };
                return { count: seen.results };
            }
        }

        async function run(plan, sink) {
            if (current) { sink.line('Tests are already running. Stop them first.', 'err'); return result('blocked', 'Another run is in progress.'); }
            if (!env.trusted()) { sink.line('Restricted Mode: trust this workspace to run tests.', 'err'); return result('blocked', 'Restricted Mode.'); }
            if (!(await env.execUse())) {
                const why = String((env.execNotice && env.execNotice()) || '').trim().replace(/[.\s]+$/, '');
                sink.line('Tests run in the isolated runner, which is not available' + (why ? ': ' + why : '') + '. Turn on Isolation for the Terminal in Settings > Security.', 'err');
                return result('error', 'The isolated runner is not available.');
            }
            current = { interrupted: false, wake: null };
            const me = current;
            let bg = null;
            try {
                bg = env.bgStart ? env.bgStart({ onStop: () => { me.interrupted = true; env.kill(); if (me.wake) me.wake(); } }) : null;
                sink.state('running');
                const t0 = env.now(); let fileErrors = 0;
                for (const target of plan.targets) {
                    if (me.interrupted) break;
                    sink.fileStart(target.path);
                    sink.line('> ' + target.path + '   (' + target.lang + ')', 'sys');
                    const f0 = env.now(); let r;
                    try { r = await runFile(target, sink, me); } catch (e) { r = { error: 'System error: ' + ((e && e.message) || e) }; }
                    if (r.error) { fileErrors++; const err = typeof r.error === 'string' ? { name: 'Error', message: r.error, frames: [], stack: '' } : r.error; sink.fileError(target.path, err); sink.line(target.path + ': ' + err.message, 'err'); }
                    sink.fileEnd(target.path, { ms: env.now() - f0, stopped: !!r.stopped });
                    if (bg) bg.log(target.path + (r.error ? ' failed to run' : ' done') + '\n', r.error ? 'err' : 'out');
                }
                const ms = env.now() - t0;
                if (me.interrupted) { if (bg) bg.finish('stopped', 'Stopped'); sink.line('Stopped after ' + took(ms), 'sys'); return Object.assign(result('stopped', 'Stopped'), { ms }); }
                if (bg) { if (fileErrors) bg.fail(fileErrors + ' test file' + (fileErrors === 1 ? '' : 's') + ' could not run'); else bg.finish('success', 'Done in ' + took(ms)); }
                return Object.assign(result(fileErrors ? 'error' : 'done', fileErrors ? 'Some files could not run.' : 'Done in ' + took(ms)), { ms, fileErrors });
            } finally {
                if (bg && typeof bg.isRunning === 'function' && bg.isRunning()) bg.fail('The test run ended unexpectedly.');
                if (current === me) current = null;
            }
        }
        return { run, isRunning: () => !!current, stop: () => { if (current) { current.interrupted = true; env.kill(); if (current.wake) current.wake(); return true; } return false; } };
    }

    // ---- templates ----
    const SCHEMA_URI = 'codemini://schema/tests.json';
    const TEMPLATE = JSON.stringify({ $schema: SCHEMA_URI, version: 1, patterns: DEFAULT_PATTERNS, exclude: ['vendor'], pythonFramework: 'auto', timeoutMs: 5000 }, null, 2) + '\n';
    const SAMPLES = {
        javascript: { path: 'tests/math.test.js', text: "// A Test Explorer file: describe / it / expect, and require('assert') both work.\nconst add = (a, b) => a + b;\n\ndescribe('add', () => {\n  it('adds two numbers', () => {\n    expect(add(1, 2)).toBe(3);\n  });\n  it('adds negatives', () => {\n    expect(add(-1, -2)).toBe(-3);\n  });\n});\n" },
        python: { path: 'tests/test_math.py', text: "import unittest\n\n\ndef add(a, b):\n    return a + b\n\n\nclass AddTests(unittest.TestCase):\n    def test_adds_two_numbers(self):\n        self.assertEqual(add(1, 2), 3)\n\n    def test_adds_negatives(self):\n        self.assertEqual(add(-1, -2), -3)\n\n\nif __name__ == '__main__':\n    unittest.main()\n" }
    };
    const SCHEMA = {
        type: 'object', additionalProperties: false,
        description: 'Where Test Explorer looks for tests in this workspace, and how it runs them. The tests run in the isolated runner.',
        properties: {
            $schema: { type: 'string', description: 'Where the schema for this file comes from. Leave it as it is.' },
            version: { type: 'number', enum: [1], description: 'The format version.' },
            patterns: { type: 'object', additionalProperties: false, description: 'File name patterns that mark a test file. * is anything but a slash, ** crosses folders. A pattern with no slash is matched against the file name at any depth.', properties: {
                javascript: { type: 'array', items: { type: 'string' }, description: 'Default: *.test.js and *.spec.js.' },
                python: { type: 'array', items: { type: 'string' }, description: 'Default: test_*.py and *_test.py.' } } },
            exclude: { type: 'array', items: { type: 'string' }, description: 'Folders or files to skip, by name at any depth ("vendor") or by path ("legacy/**"). node_modules, .git, .codemini and virtual environments are always skipped.' },
            pythonFramework: { type: 'string', enum: ['auto', 'unittest', 'pytest'], description: 'auto: pytest when the file imports it or uses pytest-style tests, otherwise unittest.' },
            timeoutMs: { type: 'number', minimum: 100, maximum: 60000, description: 'How long one JavaScript test may take before it fails. Default 5000.' }
        }
    };

    const api = {
        DEFAULT_PATTERNS, DEFAULT_EXCLUDE, SCHEMA, SCHEMA_URI, TEMPLATE, SAMPLES, SEP, MODULE_PARAMS, PY_HARNESS,
        globToRegExp, matchesPattern, isExcluded, listFiles, parseTestConfig, loadConfigFromRecord, discoverFiles, sigOf,
        scanJs, scanPython, scanFile, pythonFramework, fullName, buildFileTree, leaves, summarize, filterTree, took,
        collectJsModules, jsRuntime, jsProgram, pyFiles, pyProgram, b64utf8, parseMarkerLine, createRunner
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof document === 'undefined') return; // Node: rules, harnesses and the run core only
    W.CodeMiniTests = api; // completed below

    // ---------------------------------------------------------------------------------------------
    // Browser
    // ---------------------------------------------------------------------------------------------
    const $ = (id) => document.getElementById(id);
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const icon = (cls) => { const i = document.createElement('i'); i.className = cls; return i; };
    const toast = (m) => { if (typeof W.showSuccessToast === 'function') W.showSuccessToast(m); };
    const winId = () => { try { return localStorage.getItem('codemini_active_window') || 'win_default'; } catch (e) { return 'win_default'; } };
    const curDb = () => (typeof db !== 'undefined' && db ? db : null);
    const OUT_MAX = 3000;
    const STATE_ICON = { passed: 'ri-checkbox-circle-fill te-ok', failed: 'ri-close-circle-fill te-bad', skipped: 'ri-skip-forward-mini-line te-skip', todo: 'ri-edit-box-line te-skip', running: 'ri-loader-4-line te-spin', idle: 'ri-checkbox-blank-circle-line te-idle' };

    const state = {
        cfg: loadConfigFromRecord(null, () => ({ ok: true, value: {} })), sig: '', dbName: '', cache: new Map(), // cache: path -> { sig, nodes }
        files: [],       // { path, lang, id, sig, nodes, framework }
        results: {},     // path -> { byName, fileError, sig, ranAt, ms }
        running: false, currentPath: '', lastPlan: null,
        output: [], outTitle: '', outState: 'idle',
        q: '', mode: 'all', filterOpen: false, collapsed: new Set(), errClosed: new Set(), menu: false, startedAt: 0
    };
    let renderQueued = false;

    // ---- finding the tests (from the records Explorer loads: no extra read) ----
    function noteRecords(records) {
        const C = W.CodeMiniConfig; if (!C) return;
        const rec = C.findConfigRecord(records, 'tests.json'), dbName = curDb() ? curDb().name : '';
        const entries = listFiles(records, C.rootParentId(typeof folderStack !== 'undefined' ? folderStack : null));
        const cfgSig = C.overlaySignature(dbName, rec);
        const loaded = loadConfigFromRecord(rec, C.parseJsonc);
        const found = discoverFiles(entries, loaded.config);
        const sigs = found.map((f) => f.path + '@' + sigOf(f.rec.content));
        const sig = dbName + '|' + cfgSig + '|' + sigs.join('|');
        if (sig === state.sig) return;
        const workspaceChanged = dbName !== state.dbName;
        state.sig = sig; state.dbName = dbName; state.cfg = loaded;
        if (workspaceChanged) { state.results = {}; state.cache.clear(); state.collapsed.clear(); state.errClosed.clear(); }
        state.files = found.map((f) => {
            const s = sigOf(f.rec.content), hit = state.cache.get(f.path);
            const nodes = hit && hit.sig === s ? hit.nodes : scanFile(f.lang, f.rec.content);
            state.cache.set(f.path, { sig: s, nodes });
            return { path: f.path, lang: f.lang, id: f.rec.id, sig: s, nodes, framework: f.lang === 'python' ? pythonFramework(f.rec.content, nodes, loaded.config.pythonFramework) : '' };
        });
        scheduleRender();
    }

    // ---- the tree, with results laid over it ----
    function fileNodes() {
        return state.files.map((f) => {
            const r = state.results[f.path];
            const kids = buildFileTree(f.nodes, r);
            const node = { kind: 'file', name: f.path, path: f.path, names: [], lang: f.lang, id: f.id, children: kids, fileError: r ? r.fileError : null, stale: !!(r && r.sig !== f.sig), ms: 0, state: 'idle' };
            const lv = leaves(kids);
            node.ms = lv.reduce((a, t) => a + (t.ms || 0), 0);
            node.state = node.fileError || lv.some((t) => t.state === 'failed') ? 'failed' : lv.some((t) => t.state === 'running') ? 'running' : lv.length && lv.every((t) => t.state === 'idle') ? 'idle' : lv.some((t) => t.state === 'passed') ? 'passed' : lv.length && lv.every((t) => t.state === 'skipped' || t.state === 'todo') ? 'skipped' : 'idle';
            return node;
        });
    }
    const trusted = () => !W.CodeMiniConfig || W.CodeMiniConfig.canRun('tests.json');

    // ---- running ----
    const env = {
        now: () => Date.now(),
        nonce: () => { try { const a = new Uint32Array(3); crypto.getRandomValues(a); return Array.from(a).map((x) => x.toString(36)).join(''); } catch (e) { return Math.random().toString(36).slice(2) + Date.now().toString(36); } },
        trusted,
        config: () => state.cfg.config,
        getRecords: () => new Promise((resolve, reject) => {
            const d = curDb(); if (!d) { resolve([]); return; }
            try { const rq = d.transaction('filesystem', 'readonly').objectStore('filesystem').getAll(); rq.onsuccess = () => resolve(rq.result || []); rq.onerror = () => reject(rq.error); } catch (e) { reject(e); }
        }),
        rootParent: () => (W.CodeMiniConfig ? W.CodeMiniConfig.rootParentId(typeof folderStack !== 'undefined' ? folderStack : null) : 'root'),
        execUse: async () => !!(W.CodeMiniExec && await W.CodeMiniExec.use('terminal', winId())),
        execNotice: () => (W.CodeMiniExec ? W.CodeMiniExec.fallbackNotice('terminal') : ''),
        execRun: (req, onOut, ask) => W.CodeMiniExec.run(winId(), req, onOut, ask),
        kill: () => { if (W.CodeMiniExec) W.CodeMiniExec.kill(winId()); },
        pipRun: async (tokens, onLine) => {
            const P = W.CodeMiniPyPkgs;
            if (!P) return { ok: false, logs: [{ kind: 'err', text: 'ERROR: the package module did not load.' }] };
            return P.pipCommand(tokens, { engine: P.hostEngine(winId()), onStatus: onLine });
        },
        ask: (text) => (W.inlineInputPrompt ? W.inlineInputPrompt(text) : Promise.resolve(W.prompt(text) || '')),
        currentBg: null,
        bgStart: (o) => (env.currentBg ? env.currentBg(o) : null)
    };
    const runner = createRunner(env);

    const sidebarOpen = () => !!($('testSidebar') && $('testSidebar').classList.contains('open'));
    function openPanelTab() {
        const panel = $('problemsPanel');
        if (panel && panel.style.display === 'none') panel.style.display = 'flex';
        const tab = document.querySelector('.bottom-panel-tab[data-target="testPanelContent"]');
        if (tab && !tab.classList.contains('active')) tab.click();
    }
    const panelOnTests = () => { const p = $('problemsPanel'), t = document.querySelector('.bottom-panel-tab[data-target="testPanelContent"]'); return !!(p && p.style.display !== 'none' && t && t.classList.contains('active')); };

    function pushLine(text, stream) {
        state.output.push({ at: Date.now(), text: String(text), stream });
        if (state.output.length > OUT_MAX) state.output.splice(0, state.output.length - OUT_MAX);
        appendOutputLine(state.output[state.output.length - 1]);
    }
    const resultOf = (path) => (state.results[path] = state.results[path] || { byName: {}, fileError: null, sig: '', ranAt: 0 });
    const sink = {
        state: (s) => { state.outState = s; renderOutputHead(); },
        line: pushLine,
        fileStart: (path) => { state.currentPath = path; const f = state.files.find((x) => x.path === path); resultOf(path).sig = f ? f.sig : ''; scheduleRender(); },
        start: (path, names) => { resultOf(path).byName[fullName(names)] = { state: 'running', ms: 0, error: null }; scheduleRender(); },
        result: (path, names, st, ms, error) => {
            resultOf(path).byName[fullName(names)] = { state: st, ms, error };
            const label = fullName(names);
            pushLine((st === 'passed' ? '\u2713 ' : st === 'failed' ? '\u2717 ' : st === 'skipped' || st === 'todo' ? '- ' : '') + label + (ms ? '  (' + took(ms) + ')' : '') + (st === 'failed' && error ? '\n    ' + error.message.split('\n')[0] : ''), st === 'failed' ? 'err' : st === 'passed' ? 'out' : 'sys');
            scheduleRender();
        },
        fileError: (path, err) => { resultOf(path).fileError = err; scheduleRender(); },
        fileEnd: (path, info) => {
            const r = resultOf(path); r.ranAt = Date.now(); r.ms = info.ms;
            Object.keys(r.byName).forEach((k) => { if (r.byName[k].state === 'running') { if (info.stopped) delete r.byName[k]; else r.byName[k].state = 'idle'; } }); // started and never reported (a parent of subtests, or the run was cut short)
            state.currentPath = ''; scheduleRender();
        }
    };

    // plan from what the person picked: everything, one file, a suite or test, or the failed tests
    const targetOf = (f, filter) => ({ path: f.path, lang: f.lang, filter: filter || null });
    function forget(path, filter) { // clear the results the next run replaces
        const r = state.results[path]; if (!r) return;
        r.fileError = null;
        if (!filter) { r.byName = {}; return; }
        Object.keys(r.byName).forEach((k) => { const names = k.split(SEP); if (filter.some((f) => f.length <= names.length && f.every((x, i) => x === names[i]))) delete r.byName[k]; });
    }
    async function start(plan) {
        if (runner.isRunning()) { toast('Tests are already running. Stop them first.'); return null; }
        if (!plan.targets.length) { toast('No tests to run.'); return null; }
        if (W.WorkspaceTrust && !trusted() && typeof W.WorkspaceTrust.guard === 'function') W.WorkspaceTrust.guard('Running tests');
        state.lastPlan = plan;
        state.output = []; state.outTitle = plan.label; state.outState = 'idle'; renderOutputAll(); openPanelTab();
        plan.targets.forEach((t) => forget(t.path, t.filter));
        const win = winId(); state.startedAt = Date.now(); state.running = true;
        env.currentBg = (o) => (W.CodeMiniBackground ? W.CodeMiniBackground.start({ kind: 'tests', title: 'Tests: ' + plan.label, source: 'Test Explorer', winId: win, onStop: o.onStop, isHidden: () => !panelOnTests() && !sidebarOpen(), onGoto: () => openPanelTab() }) : null);
        scheduleRender();
        const r = await runner.run(plan, sink);
        env.currentBg = null; state.running = false;
        state.outState = r.state === 'blocked' ? 'idle' : r.state === 'stopped' ? 'stopped' : r.state === 'error' ? 'error' : 'done';
        if (r.state !== 'blocked') { const s = summarize(fileNodes()); pushLine((r.state === 'stopped' ? 'Stopped. ' : '') + s.passed + ' passed, ' + s.failed + ' failed' + (s.skipped ? ', ' + s.skipped + ' skipped' : '') + ' in ' + took(r.ms || 0), s.failed ? 'err' : 'sys'); }
        scheduleRender(); renderOutputHead();
        return r;
    }
    const runAll = () => start({ label: 'all tests', targets: state.files.map((f) => targetOf(f)) });
    const runFileAt = (path) => { const f = state.files.find((x) => x.path === path); return f ? start({ label: path, targets: [targetOf(f)] }) : null; };
    function runNode(file, node) { const f = state.files.find((x) => x.path === file); if (!f) return null; return start({ label: node.names.join(SEP), targets: [targetOf(f, [node.names])] }); }
    function runFailed() {
        const targets = [];
        fileNodes().forEach((fn) => {
            if (fn.fileError) { const f = state.files.find((x) => x.path === fn.path); if (f) targets.push(targetOf(f)); return; }
            const bad = leaves(fn.children).filter((t) => t.state === 'failed').map((t) => t.names);
            const f = state.files.find((x) => x.path === fn.path); if (f && bad.length) targets.push(targetOf(f, bad));
        });
        if (!targets.length) { toast('No failed tests to run.'); return null; }
        return start({ label: 'failed tests', targets });
    }
    const rerun = () => (state.lastPlan ? start(state.lastPlan) : runAll());
    const stopRun = () => { runner.stop(); };
    function runCurrentFile() {
        const ed = typeof W.getActiveMonacoEditor === 'function' ? W.getActiveMonacoEditor() : null;
        const ctx = ed && typeof getFileContextFromEditor === 'function' ? getFileContextFromEditor(ed) : null;
        const f = ctx && state.files.find((x) => x.id === ctx.fileId);
        if (!f) { toast('The open file is not a test file.'); openSidebar(); return null; }
        return runFileAt(f.path);
    }

    // ---- opening a file at a line ----
    async function openAt(path, line, col) {
        const records = await env.getRecords();
        const hit = listFiles(records, env.rootParent()).find((e) => e.path === path || e.path.endsWith('/' + path));
        if (!hit) { toast('Could not find ' + path + ' in this workspace.'); return false; }
        if (typeof W.handleFileClick !== 'function') return false;
        W.handleFileClick(hit.rec, document.createElement('div'));
        if (line) setTimeout(() => {
            const ed = typeof W.getActiveMonacoEditor === 'function' ? W.getActiveMonacoEditor() : null; if (!ed) return;
            const m = ed.getModel(), ln = Math.max(1, Math.min(line, m ? m.getLineCount() : line));
            ed.revealLineInCenter(ln); ed.setPosition({ lineNumber: ln, column: Math.max(1, col || 1) }); ed.focus();
        }, 200);
        return true;
    }
    function viewDiff(file, node) {
        const e = node.error; if (!e || e.expected === undefined || !W.CodeMiniDiff || typeof W.CodeMiniDiff.openStatic !== 'function') return;
        W.CodeMiniDiff.openStatic({ key: 'test:' + file + ':' + node.names.join(SEP), name: node.name, original: e.expected, modified: e.actual, originalLabel: 'Expected', modifiedLabel: 'Actual', kind: 'tests' });
    }

    // ---- the Test Output tab ----
    const outBody = () => $('testOutputBody');
    function lineNode(entry) {
        const row = el('div', 'te-line te-s-' + entry.stream);
        row.appendChild(el('span', 'te-time', clock(entry.at)));
        const body = el('span', 'te-text');
        const locs = entry.stream === 'sys' || !W.CodeMiniTasks ? [] : W.CodeMiniTasks.detectLocations(entry.text);
        let at = 0;
        locs.forEach((l) => {
            if (l.start > at) body.appendChild(document.createTextNode(entry.text.slice(at, l.start)));
            const a = el('span', 'te-link', entry.text.slice(l.start, l.end)); a.setAttribute('role', 'link'); a.tabIndex = 0; a.title = 'Open ' + l.file;
            const go = () => { openAt(l.file, l.line, l.col); };
            a.addEventListener('click', go); a.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
            body.appendChild(a); at = l.end;
        });
        if (at < entry.text.length) body.appendChild(document.createTextNode(entry.text.slice(at)));
        if (!entry.text) body.appendChild(document.createTextNode('\u00a0'));
        row.appendChild(body);
        return row;
    }
    function clock(ts) { const d = new Date(ts), p = (n) => String(n).padStart(2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
    function appendOutputLine(entry) {
        const b = outBody(); if (!b) return;
        const empty = b.querySelector('.te-empty'); if (empty) empty.remove();
        const atEnd = b.scrollHeight - b.scrollTop - b.clientHeight < 30;
        b.appendChild(lineNode(entry));
        while (b.children.length > OUT_MAX) b.removeChild(b.firstChild);
        if (atEnd) b.scrollTop = b.scrollHeight;
    }
    function renderOutputAll() {
        const b = outBody(); if (!b) return;
        b.textContent = '';
        if (!state.output.length) b.appendChild(el('div', 'te-empty', 'Test output appears here. Run tests from the Test Explorer.'));
        else state.output.forEach((e) => b.appendChild(lineNode(e)));
        b.scrollTop = b.scrollHeight; renderOutputHead();
    }
    function renderOutputHead() {
        const head = $('testOutputHead'); if (!head) return;
        head.textContent = '';
        const st = state.running ? 'running' : state.outState;
        head.appendChild(icon(st === 'running' ? STATE_ICON.running : st === 'done' ? STATE_ICON.passed : st === 'error' ? STATE_ICON.failed : st === 'stopped' ? 'ri-stop-circle-line' : STATE_ICON.idle));
        head.appendChild(el('span', 'te-out-title', state.outTitle || 'Test Output'));
        head.appendChild(el('span', 'te-out-state', st === 'running' ? 'Running' : st === 'done' ? 'Done' : st === 'error' ? 'Could not run everything' : st === 'stopped' ? 'Stopped' : (state.outTitle ? '' : 'No run yet')));
        const sp = el('span'); sp.style.flex = '1'; head.appendChild(sp);
        const mk = (label, cls, fn, disabled) => { const b = el('button', 'te-icon-btn', ''); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.appendChild(icon(cls)); b.disabled = !!disabled; b.addEventListener('click', fn); return b; };
        head.append(mk('Run again', 'ri-restart-line', () => rerun(), st === 'running' || !state.lastPlan), mk('Stop', 'ri-stop-mini-fill', stopRun, st !== 'running'), mk('Clear', 'ri-delete-bin-line', () => { state.output = []; renderOutputAll(); }, false));
    }

    // ---- the status-bar item ----
    function renderStatus() {
        const item = $('statusTestsToggle'); if (!item) return;
        const s = summarize(fileNodes());
        item.style.display = state.files.length || s.total ? '' : 'none';
        item.textContent = '';
        item.dataset.state = state.running ? 'running' : s.failed ? 'failed' : s.passed ? 'passed' : 'idle';
        item.appendChild(icon(state.running ? STATE_ICON.running : 'ri-test-tube-line'));
        if (s.passed || s.failed || state.running) {
            const a = el('span', 'te-status-n te-ok', '\u2713 ' + s.passed), b = el('span', 'te-status-n' + (s.failed ? ' te-bad' : ''), '\u2717 ' + s.failed);
            item.append(a, b);
        }
        item.title = state.running ? 'Running tests (click to open Test Explorer)' : s.total ? s.passed + ' passed, ' + s.failed + ' failed' + (s.skipped ? ', ' + s.skipped + ' skipped' : '') + ' (click to open Test Explorer)' : 'Test Explorer';
    }

    // ---- the sidebar ----
    function openSidebar() {
        const sb = $('testSidebar'), mi = $('menuTests'); if (!sb) return;
        if (!sb.classList.contains('open')) { if (W.closeAllSidebars) W.closeAllSidebars(); sb.classList.add('open'); if (mi) mi.classList.add('active'); if (W.saveCurrentUIState) W.saveCurrentUIState(); }
        renderSidebar();
    }
    function iconBtn(cls, label, fn, extra) {
        const b = el('button', 'sb-icon-btn' + (extra ? ' ' + extra : ''), ''); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.appendChild(icon(cls));
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(e); });
        return b;
    }
    function textLink(text, fn) { const b = el('button', 'te-action', text); b.type = 'button'; b.addEventListener('click', (e) => { e.stopPropagation(); fn(e); }); return b; }

    async function createSample(lang) {
        state.menu = false;
        const d = curDb(), sample = SAMPLES[lang]; if (!d || !sample) return;
        try {
            const records = await env.getRecords(), top = env.rootParent();
            const parts = sample.path.split('/'), fresh = []; let parent = top;
            const dir = records.find((r) => (r.parentId || 'root') === top && r.type === 'folder' && r.name === parts[0]);
            if (dir) parent = dir.id; else { const f = { id: 'te' + Date.now() + 'd', parentId: top, name: parts[0], type: 'folder', isLocked: false, password: null, content: '', timestamp: Date.now() }; fresh.push(f); parent = f.id; }
            const exists = records.find((r) => r.parentId === parent && r.name === parts[1]);
            if (exists) { toast(sample.path + ' already exists.'); return; }
            const file = { id: 'te' + Date.now() + 'f', parentId: parent, name: parts[1], type: 'file', isLocked: false, password: null, content: sample.text, timestamp: Date.now() };
            fresh.push(file);
            await new Promise((resolve, reject) => { const tx = d.transaction('filesystem', 'readwrite'); fresh.forEach((r) => tx.objectStore('filesystem').put(r)); tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); });
            if (typeof loadFilesFromDB === 'function') loadFilesFromDB();
            if (typeof W.openFileInTab === 'function') W.openFileInTab(file);
            toast('Created ' + sample.path);
        } catch (e) { toast('Could not create it: ' + e.message); }
        renderSidebar();
    }
    function configurePatterns() {
        const C = W.CodeMiniConfig; if (!C) return;
        C.open('tests.json', TEMPLATE).catch((e) => toast('Could not open it: ' + e.message));
    }

    function testRow(file, n, depth) {
        const isFile = n.kind === 'file', hasKids = n.children.length > 0;
        const key = file + '::' + n.names.join(SEP), openKey = isFile ? file : key;
        const li = el('li', 'te-row te-' + n.kind); li.dataset.state = n.state; li.dataset.name = isFile ? n.path : n.names.join(SEP); li.style.paddingLeft = (8 + depth * 14) + 'px';
        const chev = icon(hasKids ? (state.collapsed.has(openKey) ? 'ri-arrow-right-s-line' : 'ri-arrow-down-s-line') : 'te-nochev'); chev.classList.add('te-chev');
        const lead = icon(STATE_ICON[n.fileError ? 'failed' : n.state] || STATE_ICON.idle); lead.classList.add('te-lead');
        const name = el('div', 'te-name', isFile ? n.path : n.name);
        li.append(chev, lead, name);
        if (isFile && n.stale) { const p = el('span', 'te-stale', 'STALE'); p.title = 'This file changed since the last run'; li.appendChild(p); }
        const ms = el('span', 'te-ms', n.state === 'running' ? '' : n.ms ? took(n.ms) : ''); li.appendChild(ms);
        const actions = el('div', 'te-actions');
        const can = trusted() && !state.running;
        const play = iconBtn(trusted() ? 'ri-play-line' : 'ri-lock-line', trusted() ? 'Run ' + (isFile ? n.path : n.name) : 'Trust this workspace to run tests', () => (isFile ? runFileAt(n.path) : runNode(file, n)), 'te-play');
        play.disabled = !can; if (trusted() && state.running) play.title = 'Tests are running';
        actions.appendChild(play);
        const goLine = n.line || 0;
        actions.appendChild(iconBtn('ri-code-line', 'Go to source', () => openAt(file, goLine), 'te-src'));
        li.appendChild(actions);
        const toggle = () => { if (!hasKids) return; if (state.collapsed.has(openKey)) state.collapsed.delete(openKey); else state.collapsed.add(openKey); renderSidebar(); };
        chev.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
        li.addEventListener('click', () => { if (isFile) toggle(); else openAt(file, goLine); });
        return li;
    }
    function errorBlock(file, n, depth) {
        const e = n.error, box = el('li', 'te-err'); box.style.paddingLeft = (30 + depth * 14) + 'px';
        box.appendChild(el('div', 'te-err-msg', e.message));
        if (e.expected !== undefined) {
            const cmp = el('div', 'te-cmp');
            const row = (label, cls, text) => { const r = el('div', 'te-cmp-row ' + cls); r.append(el('span', 'te-cmp-label', label), el('span', 'te-cmp-val', text)); return r; };
            cmp.append(row('Expected', 'te-exp', e.expected), row('Actual', 'te-act', e.actual));
            const d = el('button', 'te-action', 'View diff'); d.type = 'button'; d.addEventListener('click', (ev) => { ev.stopPropagation(); viewDiff(file, n); }); cmp.appendChild(d);
            box.appendChild(cmp);
        }
        if (e.frames && e.frames.length) {
            const fr = el('div', 'te-frames');
            e.frames.forEach((f) => { const a = el('span', 'te-link', f.file + ':' + f.line + (f.col ? ':' + f.col : '')); a.setAttribute('role', 'link'); a.tabIndex = 0; const go = () => { openAt(f.file, f.line, f.col); }; a.addEventListener('click', go); a.addEventListener('keydown', (k) => { if (k.key === 'Enter' || k.key === ' ') { k.preventDefault(); go(); } }); fr.appendChild(a); });
            box.appendChild(fr);
        }
        return box;
    }
    function drawNodes(list, file, depth, ul) {
        list.forEach((n) => {
            ul.appendChild(testRow(file, n, depth));
            const closed = state.collapsed.has(file + '::' + n.names.join(SEP));
            if (n.kind === 'test' && n.state === 'failed' && n.error && !n.children.length && !state.errClosed.has(file + '::' + n.names.join(SEP))) ul.appendChild(errorBlock(file, n, depth));
            if (n.children.length && !closed) drawNodes(n.children, file, depth + 1, ul);
        });
    }
    function summaryBar(s) {
        const wrap = el('div', 'te-summary');
        const pills = el('div', 'te-pills');
        const pill = (cls, ic, n) => { const p = el('span', 'te-pill ' + cls); p.append(icon(ic), document.createTextNode(String(n))); return p; };
        pills.append(pill('te-ok', 'ri-checkbox-circle-fill', s.passed), pill('te-bad', 'ri-close-circle-fill', s.failed), pill('te-skip', 'ri-skip-forward-mini-line', s.skipped + s.todo));
        const tm = el('span', 'te-total', state.running ? 'Running...' : s.ms ? took(s.ms) : ''); pills.appendChild(tm);
        const bar = el('div', 'te-bar'); bar.setAttribute('aria-hidden', 'true');
        const done = Math.max(1, s.passed + s.failed + s.skipped + s.todo);
        [['te-bar-ok', s.passed], ['te-bar-bad', s.failed], ['te-bar-skip', s.skipped + s.todo]].forEach((x) => { const seg = el('span', x[0]); seg.style.width = (x[1] / done * 100) + '%'; bar.appendChild(seg); });
        wrap.append(pills, bar);
        return wrap;
    }
    function renderSidebar() {
        const root = $('teRoot'); if (!root) return;
        const keepScroll = root.querySelector('.sb-body') ? root.querySelector('.sb-body').scrollTop : 0;
        root.textContent = '';
        const head = el('div', 'sb-header');
        head.appendChild(el('div', 'sb-title', 'TEST EXPLORER'));
        const tools = el('div', 'sb-tools');
        tools.append(iconBtn('ri-play-line', 'Run all tests', runAll, 'te-run-all'), iconBtn('ri-stop-mini-fill', 'Stop', stopRun, 'te-stop'),
            iconBtn('ri-refresh-line', 'Refresh: find tests again', () => { state.sig = ''; env.getRecords().then(noteRecords).catch(() => {}); }),
            iconBtn('ri-filter-3-line', 'Filter', () => { state.filterOpen = !state.filterOpen; renderSidebar(); }, state.filterOpen || state.q ? 'on' : ''),
            iconBtn('ri-close-line', 'Close', () => { $('testSidebar').classList.remove('open'); $('menuTests')?.classList.remove('active'); if (W.saveCurrentUIState) W.saveCurrentUIState(); }));
        tools.querySelector('.te-run-all').disabled = !trusted() || state.running || !state.files.length;
        tools.querySelector('.te-stop').disabled = !state.running;
        head.appendChild(tools); root.appendChild(head);

        const all = fileNodes(), s = summarize(all);
        root.appendChild(summaryBar(s));
        if (state.filterOpen || state.q || state.mode !== 'all') {
            const row = el('div', 'te-filter');
            const input = el('input', 'te-search'); input.type = 'search'; input.placeholder = 'Filter tests'; input.value = state.q; input.setAttribute('aria-label', 'Filter tests');
            input.addEventListener('input', () => { state.q = input.value; const pos = input.selectionStart; renderSidebar(); const n = $('teRoot').querySelector('.te-search'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* not a text input here */ } } });
            const seg = el('div', 'sb-segmented');
            [['all', 'All'], ['failed', 'Failed'], ['passed', 'Passed']].forEach((m) => { const b = el('button', 'sb-seg' + (state.mode === m[0] ? ' active' : ''), m[1]); b.type = 'button'; b.dataset.mode = m[0]; b.addEventListener('click', () => { state.mode = m[0]; renderSidebar(); }); seg.appendChild(b); });
            row.append(input, seg); root.appendChild(row);
        }
        const body = el('div', 'sb-body');
        if (!trusted()) {
            const b = el('div', 'te-banner te-banner-lock'); b.append(icon('ri-lock-line'), el('span', null, 'Restricted Mode: tests are listed but will not run until you trust this workspace.'));
            if (W.WorkspaceTrust && typeof W.WorkspaceTrust.requestTrust === 'function') b.appendChild(textLink('Trust', () => W.WorkspaceTrust.requestTrust()));
            body.appendChild(b);
        }
        if (state.cfg.error) { const b = el('div', 'te-banner te-banner-bad'); b.append(icon('ri-error-warning-line'), el('span', null, 'tests.json is not valid: ' + state.cfg.error.message + ' (line ' + state.cfg.error.line + '). Default patterns are used.'), textLink('Open file', configurePatterns)); body.appendChild(b); }
        state.cfg.problems.filter((p) => p.level === 'error').slice(0, 3).forEach((p) => { const b = el('div', 'te-banner te-banner-bad'); b.append(icon('ri-error-warning-line'), el('span', null, 'tests.json: ' + p.message)); body.appendChild(b); });
        if (state.menu) {
            const menu = el('div', 'te-menu'); menu.appendChild(el('div', 'sb-section-header', 'CREATE A TEST FILE'));
            [['javascript', 'JavaScript (' + SAMPLES.javascript.path + ')'], ['python', 'Python (' + SAMPLES.python.path + ')']].forEach((x) => { const b = el('button', 'te-menu-item', x[1]); b.type = 'button'; b.dataset.sample = x[0]; b.addEventListener('click', () => createSample(x[0])); menu.appendChild(b); });
            body.appendChild(menu);
        }
        const shown = filterTree(all, state.q, state.mode);
        if (state.files.length && !shown.length) body.appendChild(el('div', 'te-none', state.q || state.mode !== 'all' ? 'No tests match the filter.' : 'Nothing to show.'));
        if (shown.length) {
            const ul = el('ul', 'te-list'); ul.setAttribute('role', 'tree'); ul.setAttribute('aria-label', 'Tests');
            shown.forEach((f) => {
                ul.appendChild(testRow(f.path, f, 0));
                if (f.fileError && !state.collapsed.has(f.path)) ul.appendChild(errorBlock(f.path, { name: f.path, names: [], error: f.fileError }, 0));
                if (!state.collapsed.has(f.path)) drawNodes(f.children, f.path, 1, ul);
            });
            body.appendChild(ul);
        }
        if (!state.files.length) {
            const empty = el('div', 'te-emptystate');
            empty.append(icon('ri-test-tube-line'), el('div', 'te-empty-title', 'No tests found'),
                el('div', 'te-empty-text', 'Test files are found by name: ' + state.cfg.config.patterns.javascript.concat(state.cfg.config.patterns.python).join(', ') + '.'));
            const b1 = el('button', 'te-btn primary', 'Create a test file'); b1.type = 'button'; b1.addEventListener('click', () => { state.menu = !state.menu; renderSidebar(); });
            const b2 = el('button', 'te-btn', 'Configure patterns'); b2.type = 'button'; b2.addEventListener('click', configurePatterns);
            const bar = el('div', 'te-empty-actions'); bar.append(b1, b2); empty.appendChild(bar); body.appendChild(empty);
        }
        root.appendChild(body);
        body.scrollTop = keepScroll;
    }

    // ---- the editor: a glyph on every test line ----
    const editors = new Set();
    const glyphFor = (st) => 'te-glyph te-glyph-' + (st === 'passed' ? 'pass' : st === 'failed' ? 'fail' : st === 'running' ? 'run' : st === 'skipped' || st === 'todo' ? 'skip' : 'idle');
    function fileForEditor(ed) {
        const ctx = typeof getFileContextFromEditor === 'function' ? getFileContextFromEditor(ed) : null;
        return ctx && ctx.fileId ? state.files.find((x) => x.id === ctx.fileId) : null;
    }
    // [{ line, node }] for a file's tests (live: read from the model's current text, so lines follow edits)
    function testLines(file, text) {
        const nodes = buildFileTree(text === undefined ? file.nodes : scanFile(file.lang, text), state.results[file.path]);
        const out = []; (function walk(list) { list.forEach((n) => { if (n.line) out.push({ line: n.line, node: n }); walk(n.children); }); })(nodes);
        return out.filter((x) => x.node.kind === 'test' || x.node.kind === 'suite');
    }
    function decorate(entry) {
        const m = typeof monaco !== 'undefined' ? monaco : null; if (!m || !entry.editor) return;
        const file = fileForEditor(entry.editor);
        let decos = [];
        if (file) {
            const model = entry.editor.getModel();
            const items = testLines(file, model ? model.getValue() : undefined);
            entry.items = items;
            decos = items.map((x) => ({ range: new m.Range(x.line, 1, x.line, 1), options: { isWholeLine: false, glyphMarginClassName: glyphFor(x.node.state), glyphMarginHoverMessage: { value: (x.node.kind === 'suite' ? 'Run suite' : 'Run test') + ': ' + x.node.name } } }));
        } else entry.items = [];
        entry.ids = entry.editor.deltaDecorations(entry.ids || [], decos);
    }
    function attachEditor(editor) {
        if (!editor || editors.size > 40) return;
        const entry = { editor, ids: [], items: [], timer: 0 };
        editors.add(entry);
        decorate(entry);
        const again = () => { clearTimeout(entry.timer); entry.timer = setTimeout(() => { try { decorate(entry); } catch (e) { /* a disposed editor */ } }, 300); };
        try {
            editor.onDidChangeModelContent(again); editor.onDidChangeModel(again);
            editor.onMouseDown((e) => {
                if (!e.target || !e.target.element || !/\bte-glyph\b/.test(e.target.element.className || '') || !e.target.position) return;
                const hit = entry.items.find((x) => x.line === e.target.position.lineNumber), file = fileForEditor(editor);
                if (hit && file && trusted() && !state.running) runNode(file.path, hit.node);
            });
            editor.onDidDispose(() => { clearTimeout(entry.timer); editors.delete(entry); });
        } catch (e) { /* an editor without these events */ }
    }
    function decorateAll() { editors.forEach((en) => { try { decorate(en); } catch (e) { editors.delete(en); } }); }

    // ---- redraw, at most once a frame ----
    function scheduleRender() {
        if (renderQueued) return; renderQueued = true;
        const go = () => { renderQueued = false; renderStatus(); decorateAll(); if (sidebarOpen()) renderSidebar(); renderOutputHead(); };
        (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(f, 16))(go);
    }

    // ---- commands in the palette ----
    function paletteCommands() {
        return [
            { name: 'Run All Tests', icon: 'ri-play-line', run: runAll },
            { name: 'Run Tests in Current File', icon: 'ri-file-code-line', run: runCurrentFile },
            { name: 'Run Failed Tests', icon: 'ri-close-circle-line', run: runFailed },
            { name: 'Re-run Last Tests', icon: 'ri-restart-line', run: rerun },
            { name: 'Stop Tests', icon: 'ri-stop-mini-fill', run: stopRun },
            { name: 'Open Test Explorer', icon: 'ri-test-tube-line', run: openSidebar },
            { name: 'Configure Test Patterns', icon: 'ri-settings-3-line', run: configurePatterns }
        ];
    }

    function init() {
        const sb = $('testSidebar'); if (!sb) return;
        if (!$('teRoot')) { const r = el('div', 'te-root'); r.id = 'teRoot'; sb.insertBefore(r, sb.firstChild); }
        const mi = $('menuTests');
        // Bound on the element itself: the main menu stops clicks from reaching the document, and the same element is moved between the menu and the activity bar.
        if (mi) mi.addEventListener('click', () => {
            $('mainMenuDropdown')?.classList.remove('show');
            const wasOpen = sidebarOpen();
            if (W.closeAllSidebars) W.closeAllSidebars();
            if (!wasOpen) { sb.classList.add('open'); mi.classList.add('active'); }
            if (W.saveCurrentUIState) W.saveCurrentUIState();
        });
        const st = $('statusTestsToggle'); if (st) st.addEventListener('click', openSidebar);
        new MutationObserver(() => { if (sidebarOpen()) renderSidebar(); }).observe(sb, { attributes: true, attributeFilter: ['class'] });
        const out = $('testPanelContent');
        if (out && !$('testOutputHead')) {
            const h = el('div', 'te-out-head'); h.id = 'testOutputHead'; const b = el('div', 'te-out-body'); b.id = 'testOutputBody'; b.tabIndex = 0; b.setAttribute('role', 'log');
            out.append(h, b); renderOutputAll();
        }
        if (W.CodeMiniConfig) {
            W.CodeMiniConfig.registerTemplate('tests.json', TEMPLATE);
            W.CodeMiniConfig.registerSchema('tests.json', SCHEMA);
            W.CodeMiniConfig.subscribe(noteRecords);
        }
        if (W.CodeMiniQuickOpen && typeof W.CodeMiniQuickOpen.registerCommands === 'function') W.CodeMiniQuickOpen.registerCommands(paletteCommands);
        window.addEventListener('workspacetrustchange', () => { scheduleRender(); });
        renderSidebar(); renderStatus();
    }

    Object.assign(api, { runAll, runFile: runFileAt, runFailed, rerun, stop: stopRun, openSidebar, attachEditor, configure: configurePatterns, createSample, state: () => ({ files: state.files.slice(), results: JSON.parse(JSON.stringify(state.results)), config: state.cfg, running: state.running }) });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : globalThis);
