// Manual check of Python packages on a REAL Pyodide with the REAL micropip (not part of `npm test`: it needs the network, to reach PyPI).
//
//   npm install --no-save pyodide@0.24.1        (the version index.html loads)
//   node tests/real-pyodide.manual.js
//
// It runs the program js/core/py-packages.js generates on a real engine, then drives the real Terminal commands (js/terminal/terminal-commands.js, loaded
// whole into a stand-in page) and the real Tasks runner (js/core/tasks.js) against that same engine, so what the unit tests (tests/py-packages.test.js)
// prove against stand-ins is also shown to work end to end. The Console and the editor call the same two functions (prepare / pipCommand); only their
// output code is browser-only, and that is covered by the browser suites (npm run test:e2e).
//
// Environment: PYODIDE_DIR = the folder holding pyodide.js (default: where `require.resolve('pyodide')` finds it). If this machine cannot reach
// Pyodide's CDN, put micropip-0.5.0-py3-none-any.whl and packaging-23.1-py3-none-any.whl (from PyPI) in that folder and they are loaded from there.
// The packages used are on PyPI and not in Pyodide's own list (tabulate, colorama, humanize, python-dotenv), so only PyPI is needed.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { performance } = require('perf_hooks');
const P = require('../js/core/py-packages.js');
const T = require('../js/core/tasks.js');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

let dir = process.env.PYODIDE_DIR;
try { dir = dir || path.dirname(require.resolve('pyodide')); } catch (e) { /* handled below */ }
if (!dir || !fs.existsSync(path.join(dir, 'pyodide.js'))) { console.error('Pyodide was not found. Run: npm install --no-save pyodide@0.24.1  (or set PYODIDE_DIR)'); process.exit(2); }
const { loadPyodide } = require(path.join(dir, 'pyodide.js'));

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };

(async () => {
  const py = await loadPyodide({ indexURL: dir });
  await py.loadPackage('micropip');
  console.log('Python', py.runPython('import sys; sys.version.split()[0]'), '| micropip', py.runPython('import micropip; micropip.__version__'));
  const engine = { key: 'real', run: async (src) => { const r = await py.runPythonAsync(src); return r === undefined || r === null ? '' : String(r); } };
  const text = (r) => r.logs.map((l) => l.kind + ':' + l.text);
  const importable = (name) => py.runPython(`import importlib, importlib.util; importlib.invalidate_caches(); importlib.util.find_spec(${JSON.stringify(name)}) is not None`);

  console.log('the generated program, on a real engine');
  await t('!pip install installs a real package from PyPI, and the code that follows can import it', async () => {
    const r = await P.prepare('!pip install tabulate\nimport tabulate\nprint(tabulate.tabulate([[1, 2]]))', { engine, autoInstall: false });
    assert.deepStrictEqual(text(r), ['ok:Successfully installed tabulate']);
    assert.strictEqual(r.code, 'pass\nimport tabulate\nprint(tabulate.tabulate([[1, 2]]))');
    assert.ok(/1\s+2/.test(py.runPython('import tabulate; tabulate.tabulate([[1, 2]])')));
  });
  await t('a second install says "already satisfied"; list, freeze and show describe it', async () => {
    assert.deepStrictEqual(text(await P.prepare('%pip install tabulate', { engine })), ['info:Requirement already satisfied: tabulate']);
    const out = text(await P.prepare('!pip list\n!pip freeze\n!pip show tabulate', { engine })).join('\n');
    assert.ok(/out:Package\s+Version/.test(out) && /out:tabulate\s+\d/.test(out), out);
    assert.ok(/out:tabulate==\d/.test(out), out);
    assert.ok(/out:Name: tabulate/.test(out) && /out:Version: \d/.test(out), out);
  });
  await t('a name that does not exist is an error in plain words, not micropip\'s raw text', async () => {
    const r = text(await P.prepare('!pip install definitely_not_a_package_zz_12345', { engine }));
    assert.deepStrictEqual(r, ['err:ERROR: Could not install definitely_not_a_package_zz_12345: not found on PyPI']);
  });
  await t('auto-install: the standard library is skipped, a real missing module is installed (its import works afterwards), an unknown one is a note and the run goes on', async () => {
    const r = await P.prepare('import os, sys, json\nimport colorama\nimport not_a_module_zz_98765\nfrom . import sibling\nprint(1)', { engine, autoInstall: true });
    assert.deepStrictEqual(text(r), ['info:Auto-installed: colorama', 'info:Could not auto-install not_a_module_zz_98765: not found on PyPI. The run continues without it.']);
    assert.ok(importable('colorama'));
    py.runPython('import colorama');
  });
  await t('the failed look-up is remembered (no second network round trip), and installing it on purpose is still possible', async () => {
    const again = await P.prepare('import not_a_module_zz_98765', { engine, autoInstall: true });
    assert.deepStrictEqual(again.logs, [], 'nothing was tried again');
    assert.ok(P.failedFor('real').has('not_a_module_zz_98765'));
  });
  await t('an import name that differs from the PyPI name is mapped (dotenv -> python-dotenv)', async () => {
    const r = await P.prepare('from dotenv import dotenv_values\nprint(1)', { engine, autoInstall: true });
    assert.deepStrictEqual(text(r), ['info:Auto-installed: python-dotenv']);
    assert.ok(importable('dotenv'));
  });
  await t('uninstall removes it from the package list, and nothing is left behind in the namespace', async () => {
    assert.deepStrictEqual(text(await P.prepare('!pip uninstall -y tabulate', { engine })), ['ok:Successfully uninstalled tabulate']);
    assert.ok(!/out:tabulate/.test(text(await P.prepare('!pip list', { engine })).join('\n')));
    assert.deepStrictEqual(text(await P.prepare('!pip uninstall tabulate', { engine })), ['info:WARNING: Skipping tabulate as it is not installed.']);
    assert.strictEqual(py.runPython("str([n for n in dir() if n.startswith('_cm_')])"), '[]');
  });

  console.log('the real Terminal commands, on this engine');
  const printed = [];
  const win = { appSettings: {} };
  const ctx = vm.createContext({ window: win, console, setTimeout, clearTimeout, performance });
  win.window = win;
  win.CodeMiniExec = { use: async () => false, runCollected: async () => null, fallbackNotice: () => '', run: async () => { throw new Error('no host here'); } };
  win.getPyodideInstance = async () => py;
  vm.runInContext(read('js/core/html-escape.js'), ctx); vm.runInContext(read('js/core/py-packages.js'), ctx); vm.runInContext(read('js/terminal/terminal-commands.js'), ctx);
  const noop = () => {};
  const files = [{ name: 'mine.py', type: 'file' }];
  const term = win.getTerminalCommands((x) => printed.push(String(x).replace(/<[^>]+>/g, '')), async () => files, () => 'root', noop, noop, noop, noop, noop, noop, noop, noop,
    { workspaceSynced: true, folderStack: [{ id: 'root' }], interrupted: false }, noop, noop, {}, {}, {}, {}, noop, noop, noop).commands;
  await t('pip install / list / uninstall in the Terminal, and `python -m pip` is the same thing', async () => {
    printed.length = 0; await term.pip(['pip', 'install', 'humanize']);
    assert.ok(printed.some((l) => /Successfully installed humanize/.test(l)), printed.join('|'));
    printed.length = 0; await term.pip3(['pip3', 'list']);
    assert.ok(printed.some((l) => /humanize\s+\d/.test(l)), printed.join('|'));
    printed.length = 0; await term.python(['python', '-m', 'pip', 'uninstall', 'humanize']);
    assert.ok(printed.some((l) => /Successfully uninstalled humanize/.test(l)), printed.join('|'));
    printed.length = 0; await term.pip(['pip', 'install', 'nope_zz_' + Date.now()]);
    assert.ok(printed.some((l) => /ERROR: Could not install .*not found on PyPI/.test(l)), printed.join('|'));
  });
  await t('python -c with a !pip line and an import: installs, runs, prints the program\'s own output', async () => {
    printed.length = 0;
    await term.python(['python', '-c', '!pip install tabulate\nimport tabulate\nprint(tabulate.tabulate([["a", "b"]]))']);
    assert.ok(printed.some((l) => /Successfully installed tabulate/.test(l)) && printed.some((l) => /a\s+b/.test(l)), printed.join('|'));
  });

  console.log('the real Tasks runner, on this engine');
  const records = [{ id: 'ws-a', parentId: 'ws', name: 'app.py', type: 'file', content: 'import humanize\nprint(humanize.intcomma(1234567))' }];
  const env = {
    now: () => performance.now(), trusted: () => true, getRecords: async () => records, rootParent: () => 'ws', execUse: async () => true, execNotice: () => '', kill: () => {}, ask: async () => '', bgStart: () => null,
    execRun: async (req, onOut) => {
      py.runPython('import sys, io\nsys.stdout = io.StringIO(); sys.stderr = io.StringIO()');
      try { await py.runPythonAsync(req.code); } catch (e) { return { error: { name: 'Error', message: String(e.message).trim().split('\n').pop(), text: String(e.message) } }; }
      const out = py.runPython('sys.stdout.getvalue()'); if (out) onOut({ kind: 'stdout', text: out });
      return {};
    },
    pyPrepare: (code, o) => P.prepare(code, { autoInstall: true, engine, local: o.local, onStatus: o.onLine, isStopped: o.isStopped }),
    pipRun: (tokens, onLine) => P.pipCommand(tokens, { engine, onStatus: onLine })
  };
  const runTask = async (task) => { const lines = []; const out = await T.createRunner(env).run(task, { line: (x, s) => lines.push(s + ':' + x), state() {} }); return { out, lines }; };
  const taskOf = (o) => Object.assign({ label: 'T', group: 'custom', lang: 'python', script: '', command: '', file: '', pip: null, display: '', error: '', isDefault: false, detail: '' }, o);
  await t('a task whose command is "pip install humanize" installs it, and a second task that runs app.py (which imports it) then works', async () => {
    const a = T.parseCommand('pip install humanize'); assert.strictEqual(a.ok, true);
    const r1 = await runTask(taskOf({ command: 'pip install humanize', display: 'pip install humanize', file: a.file, pip: a.pip }));
    assert.strictEqual(r1.out.state, 'success', r1.lines.join('\n')); assert.ok(r1.lines.some((l) => /out:Successfully installed humanize/.test(l)), r1.lines.join('\n'));
    const b = T.parseCommand('python app.py');
    const r2 = await runTask(taskOf({ command: 'python app.py', display: 'python app.py', file: b.file }));
    assert.strictEqual(r2.out.state, 'success', r2.lines.join('\n')); assert.ok(r2.lines.some((l) => /out:1,234,567/.test(l)), r2.lines.join('\n'));
  });
  await t('a script task with !pip and an auto-installed import runs, and a failing pip task is a failed task with the reason', async () => {
    const r = await runTask(taskOf({ script: '!pip install tabulate\nimport tabulate, wcwidth\nprint("ok", tabulate.__name__, wcwidth.__name__)', display: '!pip install tabulate' }));
    assert.strictEqual(r.out.state, 'success', r.lines.join('\n'));
    assert.ok(r.lines.some((l) => /out:ok tabulate wcwidth/.test(l)) && r.lines.some((l) => /Auto-installed: wcwidth/.test(l)), r.lines.join('\n'));
    const bad = await runTask(taskOf({ command: 'pip install nope_zz_1', display: 'pip install nope_zz_1', pip: ['install', 'nope_zz_1'] }));
    assert.deepStrictEqual([bad.out.state, bad.out.text], ['error', 'Could not install nope_zz_1: not found on PyPI']);
  });

  console.log(`\n${n} real-Pyodide checks passed`);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
