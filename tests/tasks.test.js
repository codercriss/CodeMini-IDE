// Tasks (UI/UX specs feature 2): js/core/tasks.js. The rules (what tasks.json may say, what a command may be, where output links point) and the run
// core (trust, files, the isolated runner, Stop, one at a time) run here in Node against fakes. The sidebar, the Tasks tab, the status bar item and
// the commands are in tests/e2e/tasks.e2e.js.
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const T = require('../js/core/tasks.js');
const C = require('../js/core/codemini-config.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };
// An async test that waits on a promise which never settles lets Node exit with code 0 and no output. Make that a failure.
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.error('FAIL: the test stopped before it finished (a promise never settled)'); process.exitCode = 1; } });
const file = (id, name, parentId, content, extra) => Object.assign({ id, parentId, name, type: 'file', content: content || '' }, extra || {});
const folder = (id, name, parentId) => ({ id, parentId, name, type: 'folder', content: '' });
const parse = (v) => T.parseTasks(v);

(async () => {
  console.log('a command');
  await t('it is an interpreter and a file: node, python, python3, php, ruby, Rscript, sql', () => {
    const ok = [['node build.js', 'javascript', 'build.js'], ['python tests/run.py', 'python', 'tests/run.py'], ['python3 a.py', 'python', 'a.py'], ['php x.php', 'php', 'x.php'], ['ruby r.rb', 'ruby', 'r.rb'], ['Rscript m.R', 'r', 'm.R'], ['sql db/schema.sql', 'sql', 'db/schema.sql'], ['NODE build.js', 'javascript', 'build.js']];
    ok.forEach(([cmd, lang, f]) => { const r = T.parseCommand(cmd); assert.deepStrictEqual([r.ok, r.lang, r.file], [true, lang, f], cmd); });
  });
  await t('quotes let a path have spaces; nothing else is special (no pipes, variables or escapes)', () => {
    assert.strictEqual(T.parseCommand('node "my dir/build.js"').file, 'my dir/build.js');
    assert.strictEqual(T.parseCommand("python 'a b/c.py'").file, 'a b/c.py');
    assert.strictEqual(T.parseCommand('node a.js | cat').ok, false, 'a pipe is an extra argument, which is refused');
    assert.deepStrictEqual(T.tokenize('a  "b c"   \'\' d'), ['a', 'b c', '', 'd']);
    assert.strictEqual(T.tokenize('node "oops'), null);
  });
  await t('what it is not: a shell command, no file, extra arguments, empty, not text, an unclosed quote - each with a message that says what to do', () => {
    const bad = (cmd) => { const r = T.parseCommand(cmd); assert.strictEqual(r.ok, false, String(cmd)); return r.message; };
    assert.match(bad('npm test'), /npm is not available here\. A task command is/);
    ['npx x', 'yarn build', 'bash run.sh', 'make', 'git status', 'cd src', 'echo hi', 'ls', 'cat a'].forEach((c) => assert.match(bad(c), /is not available here/, c));
    assert.doesNotMatch(bad('foobar x.js'), /is not available here\. A/);
    assert.match(bad('foobar x.js'), /A task command is "node"/);
    assert.match(bad('node'), /Say which file/);
    assert.match(bad('node a.js b.js'), /Arguments are not supported/);
    assert.match(bad(''), /empty/); assert.match(bad('   '), /empty/); assert.match(bad(null), /empty/); assert.match(bad(5), /empty/);
    assert.match(bad('node "x'), /unclosed quote/);
  });

  console.log('tasks.json');
  await t('a normal file: labels, groups, default, command or script', () => {
    const r = parse({ version: 1, tasks: [{ label: 'Build', group: 'build', default: true, command: 'node b.js' }, { label: 'Test', group: 'test', lang: 'py', script: 'print(1)' }, { label: 'Misc', lang: 'JS', script: 'x' }] });
    assert.deepStrictEqual(r.problems, []);
    assert.deepStrictEqual(r.tasks.map((x) => [x.label, x.group, x.isDefault, x.lang, x.error]), [['Build', 'build', true, 'javascript', ''], ['Test', 'test', false, 'python', ''], ['Misc', 'custom', false, 'javascript', '']]);
    assert.strictEqual(r.tasks[0].file, 'b.js'); assert.strictEqual(r.tasks[1].display, 'print(1)');
  });
  await t('the displayed command of a script is its first line, cut at 80 characters', () => {
    const r = parse({ tasks: [{ label: 'a', lang: 'python', script: 'x = 1\ny = 2' }, { label: 'b', lang: 'python', script: 'z'.repeat(200) }] });
    assert.strictEqual(r.tasks[0].display, 'x = 1'); assert.strictEqual(r.tasks[1].display.length, 80);
  });
  await t('a task that cannot be run is KEPT, with the reason, so the list shows why; the others still work', () => {
    const r = parse({ tasks: [{ label: 'ok', lang: 'python', script: 'print(1)' }, { label: 'npm', command: 'npm test' }, { label: 'both', command: 'node a.js', script: 'x', lang: 'python' }, { label: 'neither' }, { label: 'nolang', script: 'print(1)' }, { label: 'badlang', script: 'x', lang: 'cobol' }, { label: 'emptyscript', script: '  ', lang: 'python' }] });
    const by = Object.fromEntries(r.tasks.map((x) => [x.label, x.error]));
    assert.strictEqual(by.ok, ''); assert.match(by.npm, /npm is not available/); assert.match(by.both, /either "command" or "script"/); assert.match(by.neither, /either "command" or "script"/);
    assert.match(by.nolang, /needs "lang"/); assert.match(by.badlang, /needs "lang"/); assert.match(by.emptyscript, /must be some code/);
    assert.strictEqual(r.problems.filter((p) => p.level === 'error').length, 6);
  });
  await t('a task that cannot even be shown is reported and skipped: no label, a long label, a repeated label, a wrong group, not an object', () => {
    const r = parse({ tasks: [{ lang: 'python', script: 'x' }, { label: 'x'.repeat(81), lang: 'python', script: 'x' }, { label: 'A', lang: 'python', script: '1' }, { label: ' A ', lang: 'python', script: '2' }, { label: 'g', group: 'deploy', lang: 'python', script: 'x' }, 5, null, [], { label: 7 }] });
    assert.deepStrictEqual(r.tasks.map((x) => x.label), ['A']);
    assert.strictEqual(r.tasks[0].script, '1', 'the FIRST of two with the same label is kept');
    const msgs = r.problems.map((p) => p.message).join('|');
    ['needs a "label"', 'longer than 80', 'repeats a label', 'use "build", "test" or "custom"', 'is not an object'].forEach((m) => assert.ok(msgs.includes(m), m));
  });
  await t('only one default per group: the first wins and the other is told; unknown fields are warnings, not errors', () => {
    const r = parse({ version: 2, extra: 1, tasks: [{ label: 'a', group: 'build', default: true, lang: 'python', script: '1' }, { label: 'b', group: 'build', default: true, lang: 'python', script: '2', colour: 'red' }, { label: 'c', group: 'test', default: 'yes', lang: 'python', script: '3' }] });
    assert.deepStrictEqual(r.tasks.map((x) => x.isDefault), [true, false, false]);
    const w = r.problems.filter((p) => p.level === 'warning').map((p) => p.message).join('|');
    ['Unknown field "extra"', '"version" should be 1', 'is also marked "default"', 'unknown field "colour"', '"default" must be true or false'].forEach((m) => assert.ok(w.includes(m), m));
    assert.strictEqual(r.problems.filter((p) => p.level === 'error').length, 0);
  });
  await t('not an object, or "tasks" not a list, is one error and no tasks', () => {
    [null, [], 'x', 5].forEach((v) => { const r = parse(v); assert.strictEqual(r.tasks.length, 0); assert.strictEqual(r.problems.length, 1); });
    const r = parse({ tasks: 'x' }); assert.strictEqual(r.tasks.length, 0); assert.match(r.problems[0].message, /must be a list/);
  });
  await t('from a record: no file, a locked file, broken JSON (with its line), comments and trailing commas, and a good file', () => {
    const lp = (rec) => T.loadFromRecord(rec, C.parseJsonc);
    assert.deepStrictEqual(lp(null), { exists: false, error: null, tasks: [], problems: [] });
    assert.strictEqual(lp(file('t', 'tasks.json', 'c', '{}', { isLocked: true })).error.message, 'The file is locked.');
    const bad = lp(file('t', 'tasks.json', 'c', '{\n "tasks": [\n  {"label": "a"}\n  {"label": "b"}\n ]\n}')); assert.strictEqual(bad.tasks.length, 0); assert.strictEqual(bad.error.line, 4);
    const ok = lp(file('t', 'tasks.json', 'c', '{ // note\n "tasks": [ {"label": "a", "lang": "python", "script": "1",}, ],\n}'));
    assert.deepStrictEqual([ok.error, ok.tasks.length, ok.tasks[0].error], [null, 1, '']);
  });
  await t('grouping puts pinned ones first (only there), keeps file order, and the default is the marked one, else the first of its group', () => {
    const tasks = parse({ tasks: [{ label: 'b1', group: 'build', lang: 'python', script: '1' }, { label: 'b2', group: 'build', default: true, lang: 'python', script: '1' }, { label: 't1', group: 'test', lang: 'python', script: '1' }, { label: 'c1', lang: 'python', script: '1' }] }).tasks;
    const g = T.groupTasks(tasks, ['b1', 'nope']);
    assert.deepStrictEqual([g.pinned.map((x) => x.label), g.build.map((x) => x.label), g.test.map((x) => x.label), g.custom.map((x) => x.label)], [['b1'], ['b2'], ['t1'], ['c1']]);
    assert.strictEqual(T.defaultTask(tasks, 'build').label, 'b2'); assert.strictEqual(T.defaultTask(tasks, 'test').label, 't1');
    assert.strictEqual(T.defaultTask(tasks.filter((x) => x.group !== 'test'), 'test'), null); assert.strictEqual(T.defaultTask([], 'build'), null);
  });

  console.log('finding the file a command names');
  const recs = [folder('src', 'src', 'ws'), file('a', 'a.js', 'ws', 'A'), file('b', 'b.js', 'src', 'B'), folder('deep', 'deep', 'src'), file('c', 'c.py', 'deep', 'C'), file('other', 'a.js', 'elsewhere', 'X')];
  await t('relative to the top of the workspace, with ./ and .. and either slash, never above the top', () => {
    const f = (p) => { const r = T.resolvePath(recs, 'ws', p); return r && r.id; };
    assert.strictEqual(f('a.js'), 'a'); assert.strictEqual(f('./a.js'), 'a'); assert.strictEqual(f('src/b.js'), 'b'); assert.strictEqual(f('src\\b.js'), 'b');
    assert.strictEqual(f('src/deep/c.py'), 'c'); assert.strictEqual(f('src/deep/../b.js'), 'b'); assert.strictEqual(f('src/../a.js'), 'a');
    assert.strictEqual(f('../a.js'), null); assert.strictEqual(f('src/../../a.js'), null);
  });
  await t('a folder is not a file, a file is not a folder, a missing one is null, and another workspace\'s files are not seen', () => {
    const f = (p) => T.resolvePath(recs, 'ws', p);
    assert.strictEqual(f('src'), null); assert.strictEqual(f('a.js/x'), null); assert.strictEqual(f('nope.js'), null); assert.strictEqual(f('src/nope/c.py'), null); assert.strictEqual(f(''), null);
    assert.strictEqual(T.resolvePath(recs, 'elsewhere', 'a.js').id, 'other');
    assert.strictEqual(T.resolvePath([file('r', 'r.js', undefined, '')], 'root', 'r.js').id, 'r', 'a record with no parent is at the top of a window with no workspace');
  });

  console.log('links in output');
  const locs = (s) => T.detectLocations(s).map((l) => [s.slice(l.start, l.end), l.file, l.line, l.col]);
  await t('file:line and file:line:col, in the middle of a sentence', () => {
    assert.deepStrictEqual(locs('error at src/app.js:12:5 unexpected'), [['src/app.js:12:5', 'src/app.js', 12, 5]]);
    assert.deepStrictEqual(locs('tests/test_a.py:7: failed'), [['tests/test_a.py:7', 'tests/test_a.py', 7, 0]]);
    assert.deepStrictEqual(locs('at fn (build.js:3:9)'), [['build.js:3:9', 'build.js', 3, 9]]);
    assert.deepStrictEqual(locs('a.js:1 and b.py:2'), [['a.js:1', 'a.js', 1, 0], ['b.py:2', 'b.py', 2, 0]]);
  });
  await t('a Python traceback line: File "x.py", line 7', () => {
    assert.deepStrictEqual(locs('  File "tests/run.py", line 7, in <module>'), [['File "tests/run.py", line 7', 'tests/run.py', 7, 0]]);
    assert.deepStrictEqual(locs('File "<exec>", line 3'), [['File "<exec>", line 3', '<exec>', 3, 0]], 'detected; opening it finds no such file and says so');
  });
  await t('not a link: a web address, a number with no file, a file with no line, a word that merely ends like a file', () => {
    [['see https://example.com/a.js:80 now'], ['http://x.js:3'], ['took 12:30 today'], ['open src/app.js please'], ['version 1.2.3:4'], ['file.unknown:3'], ['notes.md'], ['xapp.js:3'.replace('x', 'x/')]].forEach(([s]) => { const r = locs(s); if (s === 'x/app.js:3') assert.strictEqual(r.length, 1, s); else assert.deepStrictEqual(r, [], s); });
  });
  await t('no overlap: a Python File "..." line is one link, not two', () => {
    assert.strictEqual(T.detectLocations('File "a.py", line 3').length, 1);
    assert.deepStrictEqual(T.detectLocations(''), []); assert.deepStrictEqual(T.detectLocations(null), []);
  });
  await t('time and duration read as a person would', () => {
    assert.match(T.clock(Date.now()), /^\d\d:\d\d:\d\d$/);
    assert.deepStrictEqual([T.took(5), T.took(999), T.took(1500), T.took(59000), T.took(61000), T.took(125000)], ['5 ms', '999 ms', '1.5 s', '59.0 s', '1 min 1 s', '2 min 5 s']);
  });

  console.log('templates and schema');
  await t('every template is valid JSON that parses to tasks with no errors, each runnable as it stands (inline scripts, or a file the template says to create)', () => {
    Object.keys(T.TEMPLATES).forEach((k) => {
      const p = C.parseJsonc(T.TEMPLATES[k].text); assert.ok(p.ok, k);
      assert.strictEqual(p.value.$schema, 'codemini://schema/tasks.json', k);
      const r = parse(p.value);
      assert.deepStrictEqual(r.problems.filter((x) => x.level === 'error'), [], k);
      assert.deepStrictEqual(r.tasks.filter((x) => x.error), [], k);
      if (k !== 'sql' && k !== 'empty') r.tasks.forEach((x) => assert.ok(x.script, k + ' ' + x.label + ' runs without any other file'));
    });
    assert.strictEqual(parse(C.parseJsonc(T.TEMPLATES.empty.text).value).tasks.length, 0);
    assert.ok(Object.keys(T.TEMPLATES).length === 4 && T.TEMPLATES.sql.name === 'SQL' && T.TEMPLATES.python.name === 'Python');
  });
  await t('the templates have a build and a test default where they have both, so Ctrl+Shift+B works straight away', () => {
    ['javascript', 'python'].forEach((k) => { const tk = parse(C.parseJsonc(T.TEMPLATES[k].text).value).tasks; assert.ok(T.defaultTask(tk, 'build') && T.defaultTask(tk, 'test'), k); });
  });
  await t('the schema describes exactly the fields the parser knows, with the same groups and languages', () => {
    const item = T.SCHEMA.properties.tasks.items.properties;
    assert.deepStrictEqual(Object.keys(item).sort(), ['command', 'default', 'detail', 'group', 'label', 'lang', 'script']);
    assert.deepStrictEqual(item.group.enum, ['build', 'test', 'custom']);
    assert.deepStrictEqual(item.lang.enum, ['javascript', 'python', 'php', 'ruby', 'r', 'sql']);
    assert.deepStrictEqual(Object.keys(T.SCHEMA.properties).sort(), ['$schema', 'tasks', 'version']);
    assert.strictEqual(T.SCHEMA.additionalProperties, false); assert.strictEqual(T.SCHEMA.properties.tasks.items.additionalProperties, false);
  });

  console.log('the run core');
  // A fake environment. `host` plays the isolated runner: it calls onOut for each event and returns, or throws, or waits for kill().
  function fakeEnv(o) {
    o = o || {};
    const log = { bg: [], bgLog: [], kills: 0, runs: [] };
    let release = null;
    const env = {
      now: (() => { let tt = 1000; return () => (tt += 250); })(),
      trusted: () => (o.trusted === undefined ? true : o.trusted),
      getRecords: async () => o.records || recs,
      rootParent: () => 'ws',
      execUse: async () => (o.noHost ? false : true),
      execNotice: () => o.notice || '',
      execRun: async (req, onOut) => {
        log.runs.push(req);
        if (o.host) return o.host(req, onOut, () => new Promise((r) => { release = r; }));
        (o.events || []).forEach((e) => onOut(e));
        return o.result || {};
      },
      kill: () => { log.kills++; if (release) release(); if (o.rejectOnKill) { o.rejectOnKill(); } },
      ask: () => Promise.resolve(''),
      bgStart: (opts) => { const h = { id: 'bg1', log: (x, s) => log.bgLog.push([x, s]), finish: (st, tx) => log.bg.push(['finish', st, tx]), fail: (m) => log.bg.push(['fail', m]), isRunning: () => !log.bg.length, onStop: opts.onStop }; log.handle = h; return h; }
    };
    return { env, log };
  }
  const sinkOf = () => { const lines = [], states = []; return { lines, states, line: (x, s) => lines.push([s, x]), state: (s) => states.push(s) }; };
  const script = (extra) => Object.assign({ label: 'T', group: 'custom', lang: 'python', script: 'print(1)', command: '', file: '', display: 'print(1)', error: '', isDefault: false, detail: '' }, extra || {});
  const cmdTask = (cmd) => { const c = T.parseCommand(cmd); return script({ script: '', command: cmd, display: cmd, lang: c.lang, file: c.file }); };

  await t('a script task runs its code in the host as that language; output is streamed to the sink and to the Now Island task; success says how long', async () => {
    const f = fakeEnv({ events: [{ kind: 'stdout', text: 'hello\n' }, { kind: 'stderr', text: 'warn\n' }, { kind: 'warn', text: 'careful' }, { kind: 'html', text: '<b>x</b>' }] });
    const s = sinkOf(); const r = T.createRunner(f.env);
    const out = await r.run(script(), s);
    assert.deepStrictEqual([out.state, /^Done in \d+ ms$/.test(out.text)], ['success', true]);
    assert.deepStrictEqual(f.log.runs[0], { lang: 'python', code: 'print(1)', opts: { trusted: true, autoInstall: false, sep: ' ' } });
    assert.deepStrictEqual(s.lines.map((x) => x[0] + ':' + x[1]).slice(0, 4), ['sys:> print(1)   (python)', 'out:hello', 'err:warn', 'sys:careful']);
    assert.ok(!s.lines.some((x) => x[1].includes('<b>')), 'html output is not text and is not shown');
    assert.deepStrictEqual(s.states, ['running']);
    assert.deepStrictEqual(f.log.bgLog.map((x) => x[1]), ['out', 'err', 'out'], 'the Now Island task gets every text line (stdout, stderr, and the warning), not the html');
    assert.strictEqual(f.log.bg[0][0] + ':' + f.log.bg[0][1], 'finish:success');
    assert.strictEqual(r.isRunning(), false);
  });
  await t('a command task reads the file from the workspace and runs it; a note when the file looks like another language', async () => {
    const f = fakeEnv(); const s = sinkOf();
    await T.createRunner(f.env).run(cmdTask('node src/b.js'), s);
    assert.deepStrictEqual([f.log.runs[0].lang, f.log.runs[0].code], ['javascript', 'B']);
    const f2 = fakeEnv(); const s2 = sinkOf();
    await T.createRunner(f2.env).run(cmdTask('python src/b.js'), s2);
    assert.ok(s2.lines.some((x) => x[0] === 'sys' && /looks like javascript but the command runs it as python/.test(x[1])));
    assert.strictEqual(f2.log.runs[0].lang, 'python', 'the command decides');
  });
  await t('php code is wrapped like the editor\'s Run does, unless it already starts with <?php', async () => {
    const a = fakeEnv(); await T.createRunner(a.env).run(script({ lang: 'php', script: 'echo 1;' }), sinkOf());
    assert.match(a.log.runs[0].code, /^<\?php\nerror_reporting\(E_ALL\);/); assert.match(a.log.runs[0].code, /echo 1;\n\?>$/);
    const b = fakeEnv(); await T.createRunner(b.env).run(script({ lang: 'php', script: '<?php echo 1;' }), sinkOf());
    assert.strictEqual(b.log.runs[0].code, '<?php echo 1;');
  });
  await t('a file that is missing, locked, or binary is an error that says so, and nothing runs', async () => {
    const records = recs.concat([file('lk', 'lk.py', 'ws', 'secret', { isLocked: true }), file('bin', 'bin.py', 'ws', 'AAAA', { encoding: 'base64' })]);
    for (const [cmd, rx] of [['node nope.js', /File not found: nope\.js/], ['python lk.py', /lk\.py is locked/], ['python bin.py', /bin\.py is a binary file/]]) {
      const f = fakeEnv({ records }); const s = sinkOf();
      const out = await T.createRunner(f.env).run(cmdTask(cmd), s);
      assert.strictEqual(out.state, 'error', cmd); assert.match(s.lines[0][1], rx); assert.ok(out.text.length > 0); assert.strictEqual(f.log.runs.length, 0, cmd); assert.deepStrictEqual(f.log.bg, [], 'no Now Island task for something that never started');
      assert.ok(!s.lines.some((x) => x[1].includes('secret')), 'a locked file\'s text is never printed');
    }
  });
  await t('a task with an error does not run (the list already says why)', async () => {
    const f = fakeEnv(); const s = sinkOf();
    const out = await T.createRunner(f.env).run(script({ error: 'Needs either "command" or "script".' }), s);
    assert.strictEqual(out.state, 'error'); assert.strictEqual(f.log.runs.length, 0);
  });
  await t('Restricted Mode: nothing runs, and it is "blocked", not "failed"', async () => {
    const f = fakeEnv({ trusted: false }); const s = sinkOf();
    const out = await T.createRunner(f.env).run(script(), s);
    assert.strictEqual(out.state, 'blocked'); assert.strictEqual(f.log.runs.length, 0); assert.match(s.lines[0][1], /Restricted Mode: trust this workspace/);
  });
  await t('no isolated runner: it says so and how to fix it, and runs nowhere else', async () => {
    const f = fakeEnv({ noHost: true, notice: 'Isolation is off for the Terminal' }); const s = sinkOf();
    const out = await T.createRunner(f.env).run(script(), s);
    assert.strictEqual(out.state, 'error'); assert.strictEqual(f.log.runs.length, 0);
    assert.match(s.lines[0][1], /isolated runner, which is not available: Isolation is off for the Terminal\. Turn on Isolation for the Terminal in Settings > Security/);
    const g = fakeEnv({ noHost: true }); const s2 = sinkOf(); await T.createRunner(g.env).run(script(), s2);
    assert.match(s2.lines[0][1], /not available\. Turn on Isolation/);
  });
  await t('code that ends in an error is a failed task, with the error text shown in red and its message as the result', async () => {
    const f = fakeEnv({ result: { error: { name: 'ZeroDivisionError', message: 'division by zero', text: 'Traceback...\nZeroDivisionError: division by zero' } } }); const s = sinkOf();
    const out = await T.createRunner(f.env).run(script(), s);
    assert.deepStrictEqual([out.state, out.text], ['error', 'division by zero']);
    assert.ok(s.lines.some((x) => x[0] === 'err' && /Traceback/.test(x[1]))); assert.ok(s.lines.some((x) => x[0] === 'err' && /^Failed after /.test(x[1])));
    assert.deepStrictEqual(f.log.bg[0], ['fail', 'division by zero']);
  });
  await t('a host that throws is a failed task and the run core never throws', async () => {
    const f = fakeEnv({ host: async () => { throw new Error('host gone'); } }); const s = sinkOf();
    const out = await T.createRunner(f.env).run(script(), s);
    assert.deepStrictEqual([out.state, out.text], ['error', 'host gone']); assert.ok(s.lines.some((x) => /System error: host gone/.test(x[1])));
  });
  await t('Stop: the Now Island Stop and the runner\'s own stop both kill the host, and the result is "stopped", not "failed"', async () => {
    let rejectRun;
    const f = fakeEnv({ host: (req, onOut) => new Promise((res, rej) => { rejectRun = rej; }), rejectOnKill: () => rejectRun(new Error('host killed')) });
    const s = sinkOf(); const r = T.createRunner(f.env);
    const p = r.run(script(), s); await new Promise((x) => setTimeout(x, 5));
    assert.strictEqual(r.isRunning(), true); assert.strictEqual(r.runningLabel(), 'T');
    assert.strictEqual(r.stop(), true);
    const out = await p;
    assert.deepStrictEqual([out.state, f.log.kills, f.log.bg[0][0] + ':' + f.log.bg[0][1]], ['stopped', 1, 'finish:stopped']);
    assert.ok(s.lines.some((x) => /isolated host was shut down, so its variables were reset/.test(x[1])));
    assert.strictEqual(r.isRunning(), false); assert.strictEqual(r.stop(), false, 'nothing to stop now');
    // and from the Now Island's Stop
    let rej2; const g = fakeEnv({ host: () => new Promise((res, rej) => { rej2 = rej; }), rejectOnKill: () => rej2(new Error('killed')) });
    const r2 = T.createRunner(g.env); const p2 = r2.run(script(), sinkOf()); await new Promise((x) => setTimeout(x, 5));
    g.log.handle.onStop(); const o2 = await p2; assert.strictEqual(o2.state, 'stopped');
  });
  await t('one task at a time: a second run is blocked and says which is running; after the first ends the next can run', async () => {
    let finish;
    const f = fakeEnv({ host: () => new Promise((res) => { finish = res; }) });
    const r = T.createRunner(f.env);
    const first = r.run(script({ label: 'First' }), sinkOf()); await new Promise((x) => setTimeout(x, 5));
    const s = sinkOf(); const second = await r.run(script({ label: 'Second' }), s);
    assert.strictEqual(second.state, 'blocked'); assert.match(s.lines[0][1], /"First" is still running/);
    finish({}); await first;
    f.env.execRun = async () => ({}); const third = await r.run(script({ label: 'Third' }), sinkOf());
    assert.strictEqual(third.state, 'success');
  });
  await t('whatever goes wrong, the Now Island task is ended (a sink that throws mid-run cannot leave it "running")', async () => {
    const f = fakeEnv({ events: [{ kind: 'stdout', text: 'x' }] });
    const bad = { line: (x) => { if (/^Done/.test(x)) throw new Error('sink broke'); }, state() {} };
    await assert.rejects(() => T.createRunner(f.env).run(script(), bad), /sink broke/);
    assert.ok(f.log.bg.length >= 1 && f.log.bg[0][0] === 'finish', 'it had already been finished before the sink broke');
    const g = fakeEnv({ events: [{ kind: 'stdout', text: 'x' }] });
    const bad2 = { line: (x) => { if (/^> /.test(x)) throw new Error('first line broke'); }, state() {} };
    await assert.rejects(() => T.createRunner(g.env).run(script(), bad2), /first line broke/);
    assert.deepStrictEqual(g.log.bg[0], ['fail', 'The task ended unexpectedly.']);
    assert.strictEqual(T.createRunner(g.env).isRunning(), false);
  });

  console.log('wiring');
  const html = read('index.html'), sw = read('sw.js'), sc = read('js/core/script.js');
  await t('the menu item, the sidebar, the Tasks tab, its panel and the status item are in the page, in the places the spec gives', () => {
    assert.ok(html.indexOf('id="menuTasks"') > 0 && html.indexOf('id="menuTasks"') < html.indexOf('id="menuTests"'), 'in the overflow menu, next to Test Explorer');
    assert.ok(html.includes('<div class="sidebar" id="tasksSidebar"></div>'));
    assert.ok(html.indexOf('data-target="tasksPanelContent">Tasks</div>') > html.indexOf('data-target="debugPanelContent">Debug Console</div>'), 'the tab is after Debug Console');
    assert.ok(html.includes('id="tasksPanelContent"'));
    assert.ok(html.indexOf('id="statusTasksToggle"') > html.indexOf('id="statusDebugToggle"') && html.indexOf('id="statusTasksToggle"') < html.indexOf('id="activeFileStatus"'), 'the status item is after the bug icon');
    assert.ok(html.indexOf('js/core/tasks.js') > html.indexOf('js/core/codemini-config.js') && html.indexOf('js/core/tasks.js') > html.indexOf('js/core/quick-open.js'), 'loads after the modules it registers with');
    assert.ok(sw.includes("'/js/core/tasks.js'"));
  });
  await t('script.js knows the sidebar everywhere it knows the others: saved, restored, closed with the rest, draggable onto the activity bar', () => {
    assert.ok(sc.includes("document.getElementById('tasksSidebar')?.classList.contains('open') ? 'tasks'"));
    assert.ok(sc.includes("uiState.sidebar === 'tasks'") && sc.includes("getElementById('menuTasks')?.classList.add('active')"));
    assert.ok(sc.includes("document.getElementById('tasksSidebar')?.classList.remove('open')"));
    assert.ok(sc.includes("'menuTasks': { icon: 'ri-list-check-2', name: 'Tasks' }") && /let dropIds = \[[^\]]*'menuTasks'/.test(sc));
  });
  await t('Ctrl+Shift+B is the default for "Run Build Task" and runs the default build task', () => {
    const kb = read('js/core/keybindings.js');
    assert.ok(/id: 'tasks\.runBuild'[^}]*defaults: \['Ctrl\+Shift\+B'\]/.test(kb));
    assert.ok(kb.includes("'tasks.runBuild': () => { if (W.CodeMiniTasks) W.CodeMiniTasks.runDefault('build'); }"));
  });
  await t('the palette can take commands from features, and Tasks adds Run Task..., Run Build/Test Task, Configure Tasks and one per task', () => {
    const qo = read('js/core/quick-open.js');
    assert.ok(qo.includes('api.registerCommands') && qo.includes('base.concat(contributedCommands())'));
    const src = read('js/core/tasks.js');
    ['Run Task...', 'Run Build Task', 'Run Test Task', 'Configure Tasks', "'Run Task: ' + t.label"].forEach((x) => assert.ok(src.includes(x), x));
  });
  await t('Tasks uses its own classes (not the island\'s or Git\'s), builds no HTML strings, and its handlers match its own attributes', () => {
    const src = read('js/core/tasks.js').replace(/\/\/.*$/gm, '');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src));
    assert.ok(!/'ni-|"ni-|git-|data-git-action/.test(src));
    assert.ok(read('css/style.css').includes('.tk-row') && read('css/style.css').includes('.sb-header'));
  });
  await t('it registers its template and schema with the config module, so Initialize creates tasks.json and the editor validates it', () => {
    const src = read('js/core/tasks.js');
    assert.ok(src.includes("registerTemplate('tasks.json'") && src.includes("registerSchema('tasks.json', SCHEMA)") && src.includes('W.CodeMiniConfig.subscribe(noteRecords)'));
  });
  finished = true;
  console.log(n + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
