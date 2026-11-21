// MANUAL, not part of npm test: runs the Test Explorer's Python harness on a real Pyodide (the same one the app's isolated runner loads).
//   npm i --no-save pyodide@0.24.1            (in a scratch folder; this repo has no dependencies)
//   PYODIDE_DIR=/path/to/node_modules/pyodide node tests/real-pyodide-tests.manual.js
// For the pytest half, also put the wheels of pytest, pluggy, iniconfig, packaging and pygments in a folder and set PYWHEELS=/that/folder
// (`pip download pytest pluggy iniconfig packaging pygments --no-deps --only-binary=:all: -d wheels`). In the app, micropip does that install.
const fs = require('fs'), path = require('path'), assert = require('assert');
const T = require('../js/core/test-explorer.js');
const dir = process.env.PYODIDE_DIR; if (!dir) { console.log('Set PYODIDE_DIR to a pyodide@0.24.1 folder (see the top of this file).'); process.exit(0); }
const { loadPyodide } = require(path.join(dir, 'pyodide.js'));
(async () => {
  const py = await loadPyodide({ indexURL: dir });
  const run = async (o) => {
    py.runPython('import sys, io\nsys.stdout = io.StringIO()\nsys.stderr = io.StringIO()');
    let err = null; try { await py.runPythonAsync(T.pyProgram(o)); } catch (e) { err = String(e.message).split('\n').slice(-2).join(' | '); }
    const events = [], lines = [];
    py.runPython('sys.stdout.getvalue()').split('\n').forEach((l) => { const ev = T.parseMarkerLine(l, o.nonce); if (ev) events.push(ev); else if (l) lines.push(l); });
    return { err, events, lines, by: Object.fromEntries(events.filter((e) => e.t === 'result').map((e) => [e.path.join(T.SEP), e])) };
  };
  let n = 0; const ok = (m) => { n++; console.log('  ok', m); };
  const files = { 'calc.py': 'def add(a, b):\n    return a + b\n', 'tests/test_calc.py': 'import unittest\nfrom calc import add\n\nclass AddTests(unittest.TestCase):\n    def test_ok(self):\n        print("hello from test")\n        self.assertEqual(add(1, 2), 3)\n    def test_bad(self):\n        self.assertEqual(add(1, 2), 4)\n    def test_boom(self):\n        raise ValueError("nope")\n    @unittest.skip("later")\n    def test_skip(self):\n        pass\n    def test_sub(self):\n        for i in range(2):\n            with self.subTest(i=i):\n                self.assertEqual(i, 0)\n' };
  let r = await run({ nonce: 'u1', entry: 'tests/test_calc.py', framework: 'unittest', filter: null, files });
  assert.strictEqual(r.err, null); assert.ok(r.events.some((e) => e.t === 'done'));
  assert.deepStrictEqual(['AddTests > test_ok', 'AddTests > test_bad', 'AddTests > test_boom', 'AddTests > test_skip'].map((k) => r.by[k].state), ['passed', 'failed', 'failed', 'skipped']); ok('unittest: pass, fail, error, skip');
  assert.deepStrictEqual([r.by['AddTests > test_bad'].error.actual, r.by['AddTests > test_bad'].error.expected], ['3', '4']); assert.strictEqual(r.by['AddTests > test_bad'].error.frames[0].file, 'tests/test_calc.py'); ok('unittest: assertEqual gives actual / expected, and the frame is in the person\'s file');
  assert.ok(r.lines.includes('hello from test')); assert.strictEqual(r.by['AddTests > test_sub > (i=1)'].state, 'failed'); ok('unittest: print output comes through; a failing subTest is its own case');
  r = await run({ nonce: 'u2', entry: 'tests/test_calc.py', framework: 'unittest', filter: [['AddTests', 'test_ok']], files }); assert.deepStrictEqual(Object.keys(r.by), ['AddTests > test_ok']); ok('unittest: a filter runs one test');
  r = await run({ nonce: 'u3', entry: 'tests/test_bad.py', framework: 'unittest', filter: null, files: { 'tests/test_bad.py': 'def x(:\n  pass\n' } });
  const le = r.events.find((e) => e.t === 'load-error'); assert.strictEqual(le.error.name, 'SyntaxError'); assert.deepStrictEqual([le.error.frames[0].file, le.error.frames[0].line], ['tests/test_bad.py', 1]); assert.ok(le.error.frames.every((f) => !f.file.startsWith('<'))); ok('a syntax error is one load-error with the file and line');
  assert.strictEqual(py.runPython('"_cm" in globals() or "_emit" in globals()'), false); assert.strictEqual(py.runPython('import os; any(x.startswith("cm_ws_") for x in os.listdir("/tmp"))'), false); ok('nothing is left in the person\'s Python, and the temporary folder is gone');
  r = await run({ nonce: 'u4', entry: 'tests/test_p.py', framework: 'pytest', filter: null, files: { 'tests/test_p.py': 'import pytest\ndef test_a(): pass\n' } });
  if (!process.env.PYWHEELS) {
    assert.deepStrictEqual(r.events.filter((e) => e.t === 'need'), [{ t: 'need', pkg: 'pytest' }]); ok('pytest missing: the harness asks for it (the app installs it and runs again)');
    console.log('  (PYWHEELS not set: the pytest half is skipped)');
  } else {
    for (const w of fs.readdirSync(process.env.PYWHEELS)) py.unpackArchive(new Uint8Array(fs.readFileSync(path.join(process.env.PYWHEELS, w))), 'zip', { extractDir: '/lib/python3.11/site-packages' });
    const pf = { 'app.py': 'def inc(x):\n    return x + 1\n', 'tests/test_app.py': 'import pytest\nfrom app import inc\n\ndef test_ok():\n    print("said hi")\n    assert inc(1) == 2\n\ndef test_bad():\n    assert inc(1) == 5\n\n@pytest.mark.parametrize("a,b", [(1, 2), (2, 4)])\ndef test_param(a, b):\n    assert inc(a) == b\n\n@pytest.mark.skip(reason="later")\ndef test_skipped():\n    pass\n\nclass TestGroup:\n    def test_in_class(self):\n        assert True\n' };
    r = await run({ nonce: 'p1', entry: 'tests/test_app.py', framework: 'pytest', filter: null, files: pf });
    assert.deepStrictEqual(['test_ok', 'test_bad', 'test_param[1-2]', 'test_param[2-4]', 'test_skipped', 'TestGroup > test_in_class'].map((k) => r.by[k].state), ['passed', 'failed', 'passed', 'failed', 'skipped', 'passed']); ok('pytest: pass, fail, parameters, skip, class');
    assert.deepStrictEqual([r.by['test_bad'].error.actual, r.by['test_bad'].error.expected], ['2', '5']); assert.ok(r.events.some((e) => e.t === 'log' && e.text === 'said hi')); ok('pytest: "assert a == b" gives actual / expected; print output comes through');
    r = await run({ nonce: 'p2', entry: 'tests/test_app.py', framework: 'pytest', filter: [['TestGroup', 'test_in_class']], files: pf }); assert.deepStrictEqual(Object.keys(r.by), ['TestGroup > test_in_class']); ok('pytest: a filter runs one test by node id');
    r = await run({ nonce: 'p3', entry: 'tests/test_x.py', framework: 'pytest', filter: null, files: { 'tests/test_x.py': 'import nosuchmodule\ndef test_a(): pass\n' } }); assert.strictEqual(r.events.find((e) => e.t === 'load-error').error.name, 'CollectError'); ok('pytest: an import error is a collect error');
  }
  console.log('\n' + n + ' real-Pyodide checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
