// Test Explorer (UI/UX specs feature 18): js/core/test-explorer.js. The rules, the two harnesses and the run core run here in Node; the JavaScript
// runtime is run for real (through a stand-in for runner/exec.js's runJs). The Python harness is syntax-checked here and run on a real
// Pyodide by tests/real-pyodide-tests.manual.js. The browser half is covered by tests/e2e/test-explorer.e2e.js.
const fs = require('fs'), path = require('path'), assert = require('assert'), cp = require('child_process');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0; const queue = []; const t = (name, fn) => queue.push([name, fn]);
const T = require('../js/core/test-explorer.js');

const rec = (id, parentId, name, type, content, extra) => Object.assign({ id, parentId, name, type, content: content || '', isLocked: false, timestamp: 1 }, extra || {});

// A stand-in for the runner's JavaScript engine: code with `await` runs as an async function, console.* is captured line by line.
async function jsHost(code, onOut) {
  const AF = Object.getPrototypeOf(async function () {}).constructor, orig = console.log;
  console.log = (...a) => onOut({ kind: 'log', text: a.join(' ') });
  try { await new AF(code)(); return { error: null }; } catch (e) { return { error: { name: e.name, message: e.message, text: e.stack } }; } finally { console.log = orig; }
}
async function runJs(files, entry, filter, timeoutMs) {
  const mods = T.collectJsModules(entry, (p) => (p in files ? files[p] : null));
  assert.strictEqual(mods.error, '', mods.error);
  const nonce = 'nn' + Math.random().toString(36).slice(2);
  const prog = T.jsProgram({ nonce, entry, modules: mods.modules, filter, timeoutMs: timeoutMs || 500 });
  const events = [], out = [];
  const res = await jsHost(prog.code, (e) => { const ev = T.parseMarkerLine(e.text, nonce); if (ev) events.push(ev); else out.push(e.text); });
  return { events, out, res, results: events.filter((e) => e.t === 'result'), byName: Object.fromEntries(events.filter((e) => e.t === 'result').map((e) => [e.path.join(T.SEP), e])) };
}

console.log('patterns and files');
t('globs: * stays in a folder, ** crosses folders, ? is one character', () => {
  assert.ok(T.globToRegExp('*.test.js').test('a.test.js')); assert.ok(!T.globToRegExp('*.test.js').test('x/a.test.js'));
  assert.ok(T.globToRegExp('**/*.test.js').test('x/y/a.test.js')); assert.ok(T.globToRegExp('**/*.test.js').test('a.test.js'));
  assert.ok(T.globToRegExp('t?st.py').test('test.py')); assert.ok(!T.globToRegExp('t?st.py').test('teest.py'));
  assert.ok(T.globToRegExp('a.b').test('a.b') && !T.globToRegExp('a.b').test('axb'), 'a dot is a dot');
});
t('a pattern without a slash matches the file name at any depth; with a slash, the whole path', () => {
  assert.ok(T.matchesPattern('src/deep/a.test.js', '*.test.js'));
  assert.ok(T.matchesPattern('tests/a.js', 'tests/*.js')); assert.ok(!T.matchesPattern('src/tests/a.js', 'tests/*.js'));
});
t('exclude: a name at any depth, or a path; node_modules, .git and .codemini are always out', () => {
  assert.ok(T.isExcluded('vendor/a.test.js', ['vendor'])); assert.ok(T.isExcluded('src/vendor/a.test.js', ['vendor']));
  assert.ok(T.isExcluded('legacy/x/a.test.js', ['legacy/**'])); assert.ok(!T.isExcluded('src/a.test.js', ['legacy/**']));
  ['node_modules', '.git', '.codemini'].forEach((d) => assert.ok(T.DEFAULT_EXCLUDE.includes(d)));
});
t('listFiles walks from the workspace top, skips node_modules and .git, and gives paths', () => {
  const recs = [rec('a', 'ws', 'src', 'folder'), rec('b', 'a', 'x.test.js', 'file'), rec('c', 'ws', 'node_modules', 'folder'), rec('d', 'c', 'y.test.js', 'file'), rec('e', 'ws', 'top.test.js', 'file'), rec('f', 'other', 'z.test.js', 'file')];
  assert.deepStrictEqual(T.listFiles(recs, 'ws').map((e) => e.path), ['src/x.test.js', 'top.test.js']);
});
t('discoverFiles finds js and python tests by the default patterns and skips locked, binary and excluded files', () => {
  const e = (p, extra) => ({ path: p, rec: rec(p, 'r', p.split('/').pop(), 'file', 'x', extra) });
  const found = T.discoverFiles([e('a.test.js'), e('b.spec.js'), e('test_c.py'), e('d_test.py'), e('e.js'), e('f.test.js', { isLocked: true }), e('g.test.js', { encoding: 'base64' }), e('node_modules/h.test.js'), e('docs/i.test.js')], T.parseTestConfig({ exclude: ['docs'] }).config);
  assert.deepStrictEqual(found.map((f) => f.path + ':' + f.lang), ['a.test.js:javascript', 'b.spec.js:javascript', 'test_c.py:python', 'd_test.py:python']);
});
t('sigOf changes with the text and is stable for the same text', () => {
  assert.strictEqual(T.sigOf('abc'), T.sigOf('abc')); assert.notStrictEqual(T.sigOf('abc'), T.sigOf('abd')); assert.notStrictEqual(T.sigOf(''), T.sigOf(' '));
});

console.log('tests.json');
t('defaults when the file is missing or empty', () => {
  const d = T.loadConfigFromRecord(null, null);
  assert.strictEqual(d.exists, false); assert.deepStrictEqual(d.config.patterns.javascript, ['*.test.js', '*.spec.js']); assert.deepStrictEqual(d.config.patterns.python, ['test_*.py', '*_test.py']); assert.strictEqual(d.config.pythonFramework, 'auto'); assert.strictEqual(d.config.timeoutMs, 5000);
});
t('patterns replace the defaults per language; exclude adds to the always-excluded names', () => {
  const c = T.parseTestConfig({ patterns: { python: ['check_*.py'] }, exclude: ['vendor'] }).config;
  assert.deepStrictEqual(c.patterns.python, ['check_*.py']); assert.deepStrictEqual(c.patterns.javascript, ['*.test.js', '*.spec.js']);
  assert.ok(c.exclude.includes('vendor') && c.exclude.includes('node_modules'));
});
t('bad values are reported and ignored, never thrown', () => {
  const r = T.parseTestConfig({ version: 2, patterns: { ruby: ['*.rb'], javascript: 'x' }, exclude: [1, ' ', 'ok'], pythonFramework: 'nose', timeoutMs: 5, extra: 1 });
  const msgs = r.problems.map((p) => p.message).join(' | ');
  assert.ok(/version/.test(msgs) && /ruby/.test(msgs) && /javascript/.test(msgs) && /pythonFramework/.test(msgs) && /timeoutMs/.test(msgs) && /extra/.test(msgs), msgs);
  assert.strictEqual(r.config.pythonFramework, 'auto'); assert.strictEqual(r.config.timeoutMs, 5000); assert.ok(r.config.exclude.includes('ok'));
  assert.strictEqual(T.parseTestConfig([]).problems[0].level, 'error'); assert.strictEqual(T.parseTestConfig(null).problems.length, 1);
});
t('a locked or unparsable tests.json gives an error and keeps the defaults', () => {
  assert.strictEqual(T.loadConfigFromRecord({ isLocked: true }, null).error.message, 'The file is locked.');
  const bad = T.loadConfigFromRecord({ content: '{' }, () => ({ ok: false, message: 'Unexpected end', line: 1, column: 2 }));
  assert.strictEqual(bad.error.line, 1); assert.deepStrictEqual(bad.config.patterns.javascript, ['*.test.js', '*.spec.js']);
});
t('the template and the schema agree with the parser: the template has no problems, the schema lists exactly the known fields', () => {
  const v = JSON.parse(T.TEMPLATE); assert.deepStrictEqual(T.parseTestConfig(v).problems, []);
  assert.deepStrictEqual(Object.keys(T.SCHEMA.properties).sort(), ['$schema', 'exclude', 'patterns', 'pythonFramework', 'timeoutMs', 'version']);
});

console.log('finding tests in text');
const JS_SRC = `// describe('commented out', () => { it('no', () => {}); });
const s = "describe('in a string', () => {})";
const tpl = \`it('in a template', () => {})\`;
describe('outer', () => {
  it('first', () => { const x = { a: 1 }; expect(x).toEqual({ a: 1 }); });
  describe('inner', () => {
    test('second', () => {});
    it.skip('skipped one', () => {});
    it.only('only one', () => {});
    it.todo('todo one');
  });
  xit('x-skipped', () => {});
  it(\`dynamic \${1}\`, () => {});
  it('a' + 'b', () => {});
});
it('top level', () => {});
`;
t('scanJs: names, nesting by braces, lines, and the .skip / .only / .todo / x forms', () => {
  const tree = T.scanJs(JS_SRC);
  assert.deepStrictEqual(tree.map((x) => x.name), ['outer', 'top level']);
  const outer = tree[0]; assert.strictEqual(outer.kind, 'suite'); assert.strictEqual(outer.line, 4);
  assert.deepStrictEqual(outer.children.map((x) => x.name), ['first', 'inner', 'x-skipped']);
  const inner = outer.children[1]; assert.deepStrictEqual(inner.children.map((x) => x.name + ':' + x.line), ['second:7', 'skipped one:8', 'only one:9', 'todo one:10']);
  assert.ok(inner.children[1].skipped && inner.children[2].only && inner.children[3].todo && outer.children[2].skipped);
});
t('scanJs: comments, strings and template literals are not tests; a name built at run time is not found', () => {
  const names = JSON.stringify(T.scanJs(JS_SRC));
  ['commented out', 'in a string', 'in a template', 'dynamic', 'ab'].forEach((x) => assert.ok(!names.includes(x), x));
});
t('scanJs: braces inside strings do not break nesting', () => {
  const tree = T.scanJs("describe('a', () => {\n  const s = '}}}';\n  it('x', () => {});\n});\nit('after', () => {});");
  assert.deepStrictEqual(tree.map((x) => x.name), ['a', 'after']); assert.deepStrictEqual(tree[0].children.map((x) => x.name), ['x']);
});
const PY_SRC = `import unittest
import pytest

def helper():
    pass

def test_top():
    assert True

@pytest.mark.skip(reason="later")
def test_skipped():
    pass

class TestGroup:
    def test_in_class(self):
        pass
    def helper(self):
        pass

class Plain:
    def test_not_collected(self):
        pass

class Cases(unittest.TestCase):
    """doc
    def test_in_docstring(self): pass
    """
    def test_a(self):
        pass
    async def test_b(self):
        pass

x = 1
`;
t('scanPython: unittest classes, pytest classes and functions, skip decorators, docstrings, plain classes ignored', () => {
  const tree = T.scanPython(PY_SRC);
  assert.deepStrictEqual(tree.map((x) => x.kind + ':' + x.name + ':' + x.line), ['test:test_top:7', 'test:test_skipped:11', 'suite:TestGroup:14', 'suite:Cases:24']);
  assert.ok(tree[1].skipped); assert.deepStrictEqual(tree[2].children.map((x) => x.name), ['test_in_class']); assert.deepStrictEqual(tree[3].children.map((x) => x.name), ['test_a', 'test_b']);
  assert.strictEqual(tree[3].framework, 'unittest'); assert.strictEqual(tree[2].framework, 'pytest');
});
t('pythonFramework: the configured one wins; else pytest when imported or used, else unittest', () => {
  const u = T.scanPython('import unittest\nclass A(unittest.TestCase):\n    def test_x(self): pass\n');
  assert.strictEqual(T.pythonFramework('import unittest', u, 'auto'), 'unittest'); assert.strictEqual(T.pythonFramework('x', u, 'pytest'), 'pytest'); assert.strictEqual(T.pythonFramework('import pytest', u, 'auto'), 'pytest');
  assert.strictEqual(T.pythonFramework('def test_a(): pass', T.scanPython('def test_a(): pass'), 'auto'), 'pytest'); assert.strictEqual(T.pythonFramework('', [], 'unittest'), 'unittest');
});

console.log('results and the tree');
t('buildFileTree lays results over the static nodes, and adds tests only the run knew of', () => {
  const nodes = T.scanJs("describe('s', () => {\n  it('a', () => {});\n  it('b', () => {});\n  it.skip('c', () => {});\n});");
  const r = { byName: { 's > a': { state: 'passed', ms: 3 }, 's > b': { state: 'failed', ms: 1, error: { message: 'no' } }, 's > dyn 1': { state: 'passed', ms: 2 }, 'new > deep > z': { state: 'passed', ms: 1 } } };
  const tree = T.buildFileTree(nodes, r);
  assert.deepStrictEqual(tree[0].children.map((x) => x.name + ':' + x.state), ['a:passed', 'b:failed', 'c:skipped', 'dyn 1:passed']);
  assert.strictEqual(tree[0].state, 'failed'); assert.strictEqual(tree[0].ms, 6);
  assert.deepStrictEqual(tree[1].children[0].children.map((x) => x.name), ['z']); assert.ok(tree[1].dynamic);
});
t('buildFileTree: no results means idle; pytest parameters and unittest subtests become cases under their test', () => {
  const idle = T.buildFileTree(T.scanPython('def test_p(): pass\nclass TestC(unittest.TestCase):\n    def test_s(self): pass'), undefined);
  assert.deepStrictEqual([idle[0].state, idle[1].state, idle[1].children[0].state], ['idle', 'idle', 'idle']);
  const tree = T.buildFileTree(T.scanPython('def test_p(): pass\nclass C(unittest.TestCase):\n    def test_s(self): pass'), { byName: { 'test_p[1]': { state: 'passed', ms: 1 }, 'test_p[2]': { state: 'failed', ms: 1, error: { message: 'bad' } }, 'C > test_s > (i=1)': { state: 'failed', ms: 1, error: { message: 'sub' } } } });
  assert.strictEqual(tree[0].children.length, 2); assert.strictEqual(tree[0].state, 'failed'); assert.strictEqual(tree[0].error.message, 'bad');
  assert.strictEqual(tree[1].children.length, 1, 'the subtest is under test_s, not a second suite'); assert.strictEqual(tree[1].children[0].children[0].name, '(i=1)');
});
t('summarize counts leaves (a test with cases counts its cases) and a file that could not load as one failure', () => {
  const tree = T.buildFileTree(T.scanPython('def test_p(): pass\ndef test_q(): pass'), { byName: { 'test_p[1]': { state: 'passed', ms: 2 }, 'test_p[2]': { state: 'passed', ms: 2 }, 'test_q': { state: 'skipped', ms: 0 } } });
  const s = T.summarize([{ children: tree }, { children: [], fileError: { message: 'x' } }]);
  assert.deepStrictEqual([s.passed, s.skipped, s.failed, s.total, s.ms], [2, 1, 1, 4, 4]);
});
t('filterTree: by text (full name or file), by All / Failed / Passed, keeping the path down to each match', () => {
  const tree = T.buildFileTree(T.scanJs("describe('math', () => {\n  it('adds', () => {});\n  it('subtracts', () => {});\n});"), { byName: { 'math > adds': { state: 'passed', ms: 1 }, 'math > subtracts': { state: 'failed', ms: 1, error: { message: 'x' } } } });
  const files = [{ path: 'a.test.js', children: tree }];
  const names = (f) => JSON.stringify(f.map((x) => T.leaves(x.children).map((l) => l.name)));
  assert.strictEqual(names(T.filterTree(files, 'sub', 'all')), '[["subtracts"]]'); assert.strictEqual(names(T.filterTree(files, '', 'failed')), '[["subtracts"]]'); assert.strictEqual(names(T.filterTree(files, '', 'passed')), '[["adds"]]');
  assert.strictEqual(names(T.filterTree(files, 'math', 'all')), '[["adds","subtracts"]]', 'a suite name keeps its tests'); assert.strictEqual(T.filterTree(files, 'nothing', 'all').length, 0);
  assert.strictEqual(T.filterTree(files, 'a.test', 'passed').length, 1, 'a file name matches');
  const broken = [{ path: 'b.test.js', children: [], fileError: { message: 'x' } }];
  assert.strictEqual(T.filterTree(broken, '', 'failed').length, 1); assert.strictEqual(T.filterTree(broken, '', 'passed').length, 0);
});

console.log('the JavaScript runtime, run for real');
const SRC_FILES = {
  'src/calc.js': "module.exports = { add: (a, b) => a + b, boom() { throw new Error('kaput'); } };",
  'data.json': '{"n": 5}',
  'tests/calc.test.js': `const { add, boom } = require('../src/calc');
const data = require('../data.json');
const assert = require('assert');
const order = [];
describe('calc', () => {
  beforeAll(() => order.push('beforeAll'));
  beforeEach(() => order.push('beforeEach'));
  afterEach(() => order.push('afterEach'));
  afterAll(() => console.log('order: ' + order.join(',')));
  it('adds', () => { console.log('hello'); expect(add(1, 2)).toBe(3); });
  it('fails with a compare', () => {
    expect(add(1, 2)).toBe(4);
  });
  it.skip('is skipped', () => { throw new Error('must not run'); });
  it.todo('later');
  describe('nested', () => {
    test('async', async () => { await new Promise((r) => setTimeout(r, 5)); expect(data.n).toBe(5); });
    test('throws', () => { expect(() => boom()).toThrow('kaput'); expect(() => boom()).not.toThrow('other'); });
    test('assert deep', () => { assert.deepStrictEqual({ a: [1, 2] }, { a: [1, 3] }); });
    test('times out', () => new Promise(() => {}), 40);
    test('done callback', (done) => { setTimeout(done, 1); });
    test('rejects', async () => { await expect(Promise.reject(new Error('r'))).rejects.toThrow('r'); });
  });
});`
};
let runAllResult;
t('collect, run and report: pass, fail, skip, todo, async, timeout, done callback, rejects, hooks in order', async () => {
  const r = runAllResult = await runJs(SRC_FILES, 'tests/calc.test.js', null);
  assert.strictEqual(r.res.error, null);
  const st = Object.fromEntries(Object.entries(r.byName).map(([k, v]) => [k, v.state]));
  assert.deepStrictEqual(st, { 'calc > adds': 'passed', 'calc > fails with a compare': 'failed', 'calc > is skipped': 'skipped', 'calc > later': 'todo', 'calc > nested > async': 'passed', 'calc > nested > throws': 'passed', 'calc > nested > assert deep': 'failed', 'calc > nested > times out': 'failed', 'calc > nested > done callback': 'passed', 'calc > nested > rejects': 'passed' });
  assert.ok(/Timed out after 40 ms/.test(r.byName['calc > nested > times out'].error.message));
  assert.ok(r.events.some((e) => e.t === 'done'), 'a done event ends the run');
});
t('console output of a test comes through as ordinary lines, and hooks ran before / after each test and once per suite', async () => {
  const r = runAllResult || await runJs(SRC_FILES, 'tests/calc.test.js', null);
  assert.ok(r.out.includes('hello'));
  const line = r.out.find((l) => l.startsWith('order: ')); assert.ok(line.startsWith('order: beforeAll,beforeEach,afterEach,beforeEach,afterEach'), line); assert.strictEqual((line.match(/beforeAll/g) || []).length, 1);
});
t('a failed expect carries expected and actual; a failed assert.deepStrictEqual does too', async () => {
  const r = runAllResult || await runJs(SRC_FILES, 'tests/calc.test.js', null);
  const e = r.byName['calc > fails with a compare'].error; assert.strictEqual(e.message, 'Expected 3 to be 4'); assert.strictEqual(e.expected, '4'); assert.strictEqual(e.actual, '3');
  const d = r.byName['calc > nested > assert deep'].error; assert.strictEqual(d.expected, '{a: [1, 3]}'); assert.strictEqual(d.actual, '{a: [1, 2]}');
});
t('stack frames come back as file:line:col in the person\'s own files (line 12 is the expect that failed)', async () => {
  const r = runAllResult || await runJs(SRC_FILES, 'tests/calc.test.js', null);
  const f = r.byName['calc > fails with a compare'].error.frames; assert.ok(f.length >= 1);
  assert.deepStrictEqual([f[0].file, f[0].line], ['tests/calc.test.js', 12]);
});
t('a filter runs one test, one suite, or a whole file; the others are not run or reported', async () => {
  const one = await runJs(SRC_FILES, 'tests/calc.test.js', [['calc', 'nested', 'throws']]); assert.deepStrictEqual(Object.keys(one.byName), ['calc > nested > throws']);
  const suite = await runJs(SRC_FILES, 'tests/calc.test.js', [['calc', 'nested']]); assert.strictEqual(suite.results.length, 6); assert.ok(suite.results.every((x) => x.path[1] === 'nested'));
  const two = await runJs(SRC_FILES, 'tests/calc.test.js', [['calc', 'adds'], ['calc', 'nested', 'async']]); assert.deepStrictEqual(Object.keys(two.byName).sort(), ['calc > adds', 'calc > nested > async']);
});
t('.only limits the run to the marked tests; a skipped suite skips what is inside it', async () => {
  const r = await runJs({ 'a.test.js': "describe('s', () => { it('a', () => {}); it.only('b', () => {}); });\ndescribe.skip('k', () => { it('c', () => { throw new Error('no'); }); });" }, 'a.test.js', null);
  assert.deepStrictEqual(Object.keys(r.byName), ['s > b']);
  const k = await runJs({ 'a.test.js': "describe.skip('k', () => { it('c', () => { throw new Error('no'); }); });" }, 'a.test.js', null); assert.strictEqual(k.byName['k > c'].state, 'skipped');
});
t('matchers: equality, strict equality, closeness, containment, length, match, property, instance, asymmetric', async () => {
  const body = `describe('m', () => {
    it('ok', () => {
      expect(1).toBe(1); expect({ a: 1, b: undefined }).toEqual({ a: 1 }); expect([1, [2, { c: 3 }]]).toStrictEqual([1, [2, { c: 3 }]]);
      expect(0.1 + 0.2).toBeCloseTo(0.3); expect('hello').toContain('ell'); expect([1, 2]).toContain(2); expect([{ a: 1 }]).toContainEqual({ a: 1 });
      expect([1, 2, 3]).toHaveLength(3); expect('abc').toMatch(/b/); expect({ a: { b: 2 } }).toHaveProperty('a.b', 2); expect(new Date()).toBeInstanceOf(Date);
      expect({ a: 1, b: 2 }).toMatchObject({ a: 1 }); expect({ a: 'x', n: 5 }).toEqual({ a: expect.any(String), n: expect.anything() });
      expect(5).toBeGreaterThan(4); expect(5).toBeLessThanOrEqual(5); expect(NaN).toBeNaN(); expect(null).toBeNull(); expect(undefined).toBeUndefined();
      expect(1).not.toBe(2); expect([1]).not.toContain(3); expect(new Map([[1, 2]])).toEqual(new Map([[1, 2]])); expect(new Set([1])).toEqual(new Set([1]));
    });
    it('strict differs', () => { expect({ a: undefined }).toStrictEqual({}); });
    it('not fails when it holds', () => { expect(1).not.toBe(1); });
    it('wrong length', () => { expect([1]).toHaveLength(2); });
  });`;
  const r = await runJs({ 'm.test.js': body }, 'm.test.js', null);
  assert.strictEqual(r.byName['m > ok'].state, 'passed', JSON.stringify(r.byName['m > ok'].error));
  ['m > strict differs', 'm > not fails when it holds', 'm > wrong length'].forEach((k) => assert.strictEqual(r.byName[k].state, 'failed', k));
  assert.ok(/to have length 2 \(it has 1\)/.test(r.byName['m > wrong length'].error.message));
});
t('require: relative files resolve with or without the extension and index.js; a package or a missing file fails with a clear message', async () => {
  const files = { 'lib/index.js': 'module.exports = { v: 1 };', 'lib/util.js': "exports.double = (x) => x * 2;", 'a.test.js': "const lib = require('./lib'); const u = require('./lib/util'); it('works', () => { expect(lib.v + u.double(2)).toBe(5); });" };
  assert.strictEqual((await runJs(files, 'a.test.js', null)).byName['works'].state, 'passed');
  const pkg = await runJs({ 'b.test.js': "require('lodash');" }, 'b.test.js', null);
  const le = pkg.events.find((e) => e.t === 'load-error'); assert.ok(/Cannot find module 'lodash'.*relative path/.test(le.error.message));
  const miss = T.collectJsModules('c.test.js', (p) => (p === 'c.test.js' ? "require('./nope');" : null));
  assert.strictEqual(miss.error, ''); // a require that cannot be found fails when it runs, not here
});
t('import / export syntax is refused with a message that says what to use; so is a missing or too-large require tree', () => {
  assert.ok(/import \/ export/.test(T.collectJsModules('a.test.js', () => "import x from './y';\n").error));
  assert.ok(/import \/ export/.test(T.collectJsModules('a.test.js', () => 'export const a = 1;').error));
  assert.strictEqual(T.collectJsModules('a.test.js', () => "const s = 'import me'; module.exports = 1;").error, '', 'the word import in a string is fine');
  assert.ok(/not found/i.test(T.collectJsModules('zzz.js', () => null).error));
  const deep = T.collectJsModules('m0.js', (p) => { const mm = /^m(\d+)\.js$/.exec(p); if (!mm) return null; const i = Number(mm[1]); return i < 70 ? "require('./m" + (i + 1) + "');" : ''; }); assert.ok(/Too many files/.test(deep.error));
});
t('a syntax error in a test file, or an error thrown while it loads, is one load-error event, not a crash', async () => {
  const thrown = await runJs({ 'a.test.js': "throw new Error('at load');" }, 'a.test.js', null);
  assert.strictEqual(thrown.events.find((e) => e.t === 'load-error').error.message, 'at load'); assert.ok(thrown.events.some((e) => e.t === 'done'));
  const mods = T.collectJsModules('b.test.js', () => 'it(', ); const prog = T.jsProgram({ nonce: 'x', entry: 'b.test.js', modules: mods.modules, timeoutMs: 100 });
  const r = await jsHost(prog.code, () => {}); assert.ok(r.error && r.error.name === 'SyntaxError', 'the host reports a syntax error, which the run core turns into a file error');
});
t('the program is built from text only: ranges tell which lines belong to which file, and the program never calls eval or new Function', () => {
  const p = T.jsProgram({ nonce: 'q', entry: 'a.test.js', modules: [{ path: 'a.test.js', text: 'one\ntwo' }, { path: 'd.json', text: '{"a":1}' }], timeoutMs: 100 });
  assert.strictEqual(p.ranges.length, 2); assert.strictEqual(p.ranges[0].end - p.ranges[0].start, 1);
  const lines = p.code.split('\n'); assert.strictEqual(lines[p.ranges[0].start - 1], 'one'); assert.strictEqual(lines[p.ranges[0].end - 1], 'two');
  assert.ok(/\bawait\b/.test(p.code), 'the word await sends it down the host\'s async path');
  assert.ok(!/\beval\s*\(|new Function\s*\(/.test(read('js/core/test-explorer.js').replace(/\/\/.*$/gm, '')), 'no eval or new Function in this file');
});

console.log('the Python harness');
t('the harness is valid Python (checked with python3 when it is there) and keeps its promises', () => {
  const src = T.PY_HARNESS;
  assert.ok(/_out = sys\.stdout/.test(src) && /file=_out/.test(src), 'events go to the stdout captured at the start, not the one pytest redirects');
  assert.ok(/shutil\.rmtree\(_root/.test(src) && /_purge\(\)/.test(src), 'it cleans up the temporary folder and the modules it imported');
  assert.ok(/-p", "no:cacheprovider"/.test(src) && /--capture=sys/.test(src));
  const r = cp.spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: src.replace('__CM_B64__', 'AA=='), encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') { console.log('    (python3 not found: syntax check skipped)'); return; }
  assert.strictEqual(r.status, 0, r.stderr);
});
t('pyProgram: a small program that execs the harness in a namespace of its own; the config rides along as base64 (any Unicode)', () => {
  const files = { 'tests/test_é.py': 'x = "日本語 🎉"\n' };
  const code = T.pyProgram({ nonce: 'zz', entry: 'tests/test_é.py', framework: 'unittest', filter: [['A', 'test_x']], files });
  assert.ok(code.startsWith('import base64 as _cm_b\nexec(compile(') && code.endsWith('del _cm_b\n') && code.split('\n').length <= 4, 'three lines, nothing else lands in the person\'s Python');
  const harness = Buffer.from(/b64decode\("([^"]+)"\)/.exec(code)[1], 'base64').toString('utf8');
  const cfg = JSON.parse(Buffer.from(/b64decode\("([^"]+)"\)\.decode\("utf-8"\)\)\n_MARK/.exec(harness)[1], 'base64').toString('utf8'));
  assert.deepStrictEqual([cfg.nonce, cfg.rel, cfg.framework, cfg.filter, cfg.files['tests/test_é.py']], ['zz', 'tests/test_é.py', 'unittest', [['A', 'test_x']], 'x = "日本語 🎉"\n']);
});
t('pyFiles: the test file first, then .py files, then the rest; locked, binary and oversized files are left out; a total size cap holds', () => {
  const e = (p, c, extra) => ({ path: p, rec: rec(p, 'r', p, 'file', c, extra) });
  const f = T.pyFiles([e('data.txt', 'd'), e('lib.py', 'l'), e('tests/test_a.py', 't'), e('secret.py', 's', { isLocked: true }), e('img.png', 'x', { encoding: 'base64' }), e('big.py', 'x'.repeat(200001))], 'tests/test_a.py');
  assert.deepStrictEqual(Object.keys(f), ['tests/test_a.py', 'lib.py', 'data.txt']);
  const many = Array.from({ length: 20 }, (_, i) => e('f' + i + '.py', 'x'.repeat(150000))); assert.ok(Object.keys(T.pyFiles(many, 'f0.py')).length <= 10, 'about 1.5 MB at most');
});

console.log('what a run prints is untrusted');
t('parseMarkerLine accepts only lines with this run\'s nonce, and checks every field', () => {
  const P = (ev, nonce) => T.parseMarkerLine('@@cm-test:' + (nonce || 'n1') + '@@ ' + JSON.stringify(ev), 'n1');
  assert.strictEqual(P({ t: 'result', path: ['a'], state: 'passed', ms: 1 }, 'other'), null, 'a line with another nonce is just output');
  assert.strictEqual(P({ t: 'result', path: ['a'], state: 'passed', ms: 1 }, 'n2'), null, 'also when the wrong nonce has the same length (a forged result)');
  assert.strictEqual(P({ t: 'result', path: ['a'], state: 'passed', ms: 1 }, 'n1').state, 'passed');
  assert.strictEqual(T.parseMarkerLine('plain output', 'n1'), null); assert.strictEqual(T.parseMarkerLine('@@cm-test:n1@@ {not json', 'n1'), null);
  assert.strictEqual(P({ t: 'result', path: ['a'], state: 'exploded', ms: 1 }), null); assert.strictEqual(P({ t: 'result', path: [], state: 'passed' }), null); assert.strictEqual(P({ t: 'result', path: 'a', state: 'passed' }), null);
  assert.strictEqual(P({ t: 'nope' }), null); assert.strictEqual(P({ t: 'need', pkg: 'evil' }), null); assert.deepStrictEqual(P({ t: 'need', pkg: 'pytest' }), { t: 'need', pkg: 'pytest' });
  const big = P({ t: 'result', path: ['x'.repeat(1000)], state: 'failed', ms: 'abc', error: { name: 'N'.repeat(500), message: 'm'.repeat(10000), expected: 5, frames: [{ file: 'f.js', line: 3 }, { file: 5, line: 1 }, { file: 'g', line: 'x' }, { file: 'h.js', line: -4, col: 'z' }] } });
  assert.ok(big.path[0].length <= 304 && big.error.name.length <= 84 && big.error.message.length <= 3004, 'text is clipped'); assert.strictEqual(big.ms, 0);
  assert.strictEqual(big.error.expected, undefined, 'expected and actual are only taken as text'); assert.deepStrictEqual(big.error.frames.map((f) => f.file + ':' + f.line), ['f.js:3', 'h.js:1']);
  assert.deepStrictEqual(Object.keys(P({ t: 'result', path: ['a'], state: 'passed', ms: 1, __proto__: { x: 1 }, constructor: 'x' })).sort(), ['error', 'ms', 'path', 'state', 't']);
});

console.log('the run core');
const baseRecords = () => [rec('d', 'ws', 'tests', 'folder'), rec('f1', 'd', 'a.test.js', 'file', "it('one', () => { expect(1).toBe(1); });\nit('two', () => { expect(1).toBe(2); });"), rec('f2', 'd', 'test_b.py', 'file', 'import unittest\nclass T(unittest.TestCase):\n    def test_x(self): pass\n')];
function mkEnv(over) {
  const log = { bg: [], killed: 0, lines: [] };
  const env = Object.assign({
    now: () => Date.now(), nonce: () => 'run' + (mkEnv.seq = (mkEnv.seq || 0) + 1), trusted: () => true, getRecords: async () => baseRecords(), rootParent: () => 'ws', config: () => T.parseTestConfig({}).config,
    execUse: async () => true, execNotice: () => '', execRun: (req, onOut) => jsHost(req.code, onOut), kill: () => { log.killed++; }, ask: () => '',
    bgStart: () => ({ log() {}, finish: (s, x) => log.bg.push(['finish', s, x]), fail: (m) => log.bg.push(['fail', m]), isRunning: () => false })
  }, over || {});
  return { env, log };
}
function mkSink() {
  const s = { calls: [], results: {}, fileErrors: {}, lines: [] };
  Object.assign(s, { state: (x) => s.calls.push('state:' + x), line: (x, y) => s.lines.push([y, x]), fileStart: (p) => s.calls.push('start:' + p), start: () => {}, result: (p, names, st) => { s.results[p + '#' + names.join(T.SEP)] = st; }, fileError: (p, e) => { s.fileErrors[p] = e; }, fileEnd: (p, i) => s.calls.push('end:' + p + (i.stopped ? ':stopped' : '')) });
  return s;
}
t('runs the files one after the other and reports results as they arrive', async () => {
  const { env, log } = mkEnv(); const sink = mkSink(); const r = T.createRunner(env);
  const res = await r.run({ label: 'x', targets: [{ path: 'tests/a.test.js', lang: 'javascript', filter: null }] }, sink);
  assert.strictEqual(res.state, 'done'); assert.deepStrictEqual(sink.results, { 'tests/a.test.js#one': 'passed', 'tests/a.test.js#two': 'failed' });
  assert.deepStrictEqual(sink.calls, ['state:running', 'start:tests/a.test.js', 'end:tests/a.test.js']); assert.deepStrictEqual(log.bg[0].slice(0, 2), ['finish', 'success']); assert.strictEqual(r.isRunning(), false);
});
t('Restricted Mode: nothing runs; Isolation off: it says where to turn it on; a second run while one is going is refused', async () => {
  let r = T.createRunner(mkEnv({ trusted: () => false }).env), sink = mkSink();
  assert.strictEqual((await r.run({ targets: [{ path: 'tests/a.test.js', lang: 'javascript' }] }, sink)).state, 'blocked'); assert.ok(/Restricted Mode/.test(sink.lines[0][1]));
  const off = mkEnv({ execUse: async () => false, execNotice: () => 'the runner could not be reached.' }); sink = mkSink(); r = T.createRunner(off.env);
  const res = await r.run({ targets: [{ path: 'tests/a.test.js', lang: 'javascript' }] }, sink); assert.strictEqual(res.state, 'error'); assert.ok(/isolated runner.*reached.*Settings > Security/.test(sink.lines[0][1]));
  let release; const slow = mkEnv({ execRun: () => new Promise((resolve) => { release = () => resolve({ error: null }); }) }); r = T.createRunner(slow.env); sink = mkSink();
  const first = r.run({ targets: [{ path: 'tests/a.test.js', lang: 'javascript' }] }, sink); await new Promise((x) => setTimeout(x, 5));
  assert.strictEqual(r.isRunning(), true); assert.strictEqual((await r.run({ targets: [] }, mkSink())).state, 'blocked'); release(); await first;
});
t('a file that is missing, locked, binary or uses import syntax is a file error (one per file), and the run goes on', async () => {
  const recs = baseRecords().concat([rec('f3', 'd', 'l.test.js', 'file', 'x', { isLocked: true }), rec('f4', 'd', 'e.test.js', 'file', "import a from './a';\n")]);
  const { env } = mkEnv({ getRecords: async () => recs }); const sink = mkSink();
  const res = await T.createRunner(env).run({ targets: ['gone.test.js', 'tests/l.test.js', 'tests/e.test.js', 'tests/a.test.js'].map((p) => ({ path: p, lang: 'javascript' })) }, sink);
  assert.strictEqual(res.fileErrors, 3); assert.ok(/not found/i.test(sink.fileErrors['gone.test.js'].message) && /locked/.test(sink.fileErrors['tests/l.test.js'].message) && /import \/ export/.test(sink.fileErrors['tests/e.test.js'].message));
  assert.strictEqual(sink.results['tests/a.test.js#one'], 'passed'); assert.strictEqual(res.state, 'error');
});
t('a load error the file reports (it threw while loading) is that file\'s error, with its frames', async () => {
  const recs = [rec('f1', 'ws', 'a.test.js', 'file', "const x = 1;\nthrow new Error('boom at load');")]; const sink = mkSink();
  await T.createRunner(mkEnv({ getRecords: async () => recs }).env).run({ targets: [{ path: 'a.test.js', lang: 'javascript' }] }, sink);
  assert.strictEqual(sink.fileErrors['a.test.js'].message, 'boom at load'); assert.deepStrictEqual([sink.fileErrors['a.test.js'].frames[0].file, sink.fileErrors['a.test.js'].frames[0].line], ['a.test.js', 2]);
});
t('a host error with no done event (a syntax error in the file) becomes a file error; a run that just stops is reported too', async () => {
  const recs = [rec('f1', 'ws', 'a.test.js', 'file', 'it(')]; let sink = mkSink();
  await T.createRunner(mkEnv({ getRecords: async () => recs }).env).run({ targets: [{ path: 'a.test.js', lang: 'javascript' }] }, sink);
  assert.strictEqual(sink.fileErrors['a.test.js'].name, 'SyntaxError');
  sink = mkSink(); await T.createRunner(mkEnv({ getRecords: async () => recs, execRun: async () => ({ error: null }) }).env).run({ targets: [{ path: 'a.test.js', lang: 'javascript' }] }, sink);
  assert.ok(/ended before the tests finished/.test(sink.fileErrors['a.test.js'].message));
});
t('a file that runs too long is stopped: the host is shut down and the file is reported as timed out', async () => {
  const timers = []; const { env, log } = mkEnv({ execRun: () => new Promise(() => {}), setTimer: (f, ms) => { timers.push([f, ms]); return timers.length; }, clearTimer() {}, fileTimeoutMs: 1234 });
  const sink = mkSink(); const p = T.createRunner(env).run({ targets: [{ path: 'tests/a.test.js', lang: 'javascript' }] }, sink);
  await new Promise((x) => setTimeout(x, 10)); assert.strictEqual(timers[0][1], 1234); timers[0][0](); await p;
  assert.strictEqual(log.killed, 1); assert.strictEqual(sink.fileErrors['tests/a.test.js'].name, 'Timeout'); assert.ok(/Timed out after 1 s/.test(sink.fileErrors['tests/a.test.js'].message));
});
t('Stop: the host is shut down, the run ends as stopped, and the Now Island entry ends as stopped', async () => {
  let started; const g = new Promise((x) => { started = x; }); let onStop;
  const { env, log } = mkEnv({ execRun: () => { started(); return new Promise(() => {}); }, bgStart: (o) => { onStop = o.onStop; return { log() {}, finish: (s, x) => log.bg.push(['finish', s, x]), fail: (m) => log.bg.push(['fail', m]), isRunning: () => false }; } });
  const r = T.createRunner(env), sink = mkSink(); const p = r.run({ targets: [{ path: 'tests/a.test.js', lang: 'javascript' }, { path: 'tests/test_b.py', lang: 'python' }] }, sink);
  await g; assert.strictEqual(r.stop(), true); const res = await p;
  assert.strictEqual(res.state, 'stopped'); assert.strictEqual(log.killed, 1); assert.deepStrictEqual(log.bg[0].slice(0, 2), ['finish', 'stopped']); assert.ok(!sink.calls.includes('start:tests/test_b.py'), 'the next file does not start');
  assert.strictEqual(typeof onStop, 'function'); assert.strictEqual(r.stop(), false);
});
t('pytest that is not installed: it is installed once, then the file runs again; if the install fails the file says so', async () => {
  const seen = []; let installed = false;
  const py = (ok) => mkEnv({
    execRun: async (req, onOut) => { seen.push(req.lang); const harness = Buffer.from(/b64decode\("([^"]+)"\)\.decode/.exec(req.code)[1], 'base64').toString(); const nonce = JSON.parse(Buffer.from(/b64decode\("([^"]+)"\)\.decode\("utf-8"\)\)\n_MARK/.exec(harness)[1], 'base64').toString()).nonce; const mk = (ev) => '@@cm-test:' + nonce + '@@ ' + JSON.stringify(ev); if (!installed) onOut({ kind: 'stdout', text: mk({ t: 'need', pkg: 'pytest' }) + '\n' + mk({ t: 'done', ms: 1 }) + '\n' }); else onOut({ kind: 'stdout', text: mk({ t: 'result', path: ['test_a'], state: 'passed', ms: 1 }) + '\n' + mk({ t: 'done', ms: 1 }) + '\n' }); return { error: null }; },
    pipRun: async (tokens) => { seen.push(tokens.join(' ')); installed = ok; return { ok, logs: ok ? [] : [{ kind: 'err', text: 'ERROR: no network' }] }; },
    getRecords: async () => [rec('f', 'ws', 'test_a.py', 'file', 'import pytest\ndef test_a(): pass\n')]
  });
  let sink = mkSink(); await T.createRunner(py(true).env).run({ targets: [{ path: 'test_a.py', lang: 'python' }] }, sink);
  assert.deepStrictEqual(seen, ['python', 'install pytest', 'python']); assert.strictEqual(sink.results['test_a.py#test_a'], 'passed');
  seen.length = 0; installed = false; sink = mkSink(); await T.createRunner(py(false).env).run({ targets: [{ path: 'test_a.py', lang: 'python' }] }, sink);
  assert.deepStrictEqual(seen, ['python', 'install pytest']); assert.ok(/pytest could not be installed/.test(sink.fileErrors['test_a.py'].message));
});
t('the Now Island entry ends as failed when a file could not run, and never stays running', async () => {
  const { env, log } = mkEnv({ getRecords: async () => [] }); await T.createRunner(env).run({ targets: [{ path: 'gone.test.js', lang: 'javascript' }] }, mkSink());
  assert.strictEqual(log.bg[0][0], 'fail'); assert.ok(/could not run/.test(log.bg[0][1]));
  const stuck = mkEnv({ bgStart: () => ({ log() {}, finish() {}, fail: (m) => { stuck.log.bg.push(['fail', m]); }, isRunning: () => true }) });
  await T.createRunner(stuck.env).run({ targets: [{ path: 'tests/a.test.js', lang: 'javascript' }] }, mkSink()); assert.ok(stuck.log.bg.some((x) => /ended unexpectedly/.test(x[1])), 'the finally block ends an entry that was left running');
});

console.log('wiring');
t('index.html has the sidebar, the Test Output tab and panel, and the status item after Problems; the script loads after tasks.js and is precached', () => {
  const html = read('index.html'), at = (s) => html.indexOf(s);
  ['id="testSidebar"', 'data-target="testPanelContent">Test Output', 'id="testPanelContent"', 'id="statusTestsToggle"', 'id="menuTests"'].forEach((s) => assert.ok(at(s) > -1, s));
  assert.ok(at('id="statusProblemsToggle"') < at('id="statusTestsToggle"') && at('id="statusTestsToggle"') < at('id="statusConsoleToggle"'));
  assert.ok(at('data-target="tasksPanelContent"') < at('data-target="testPanelContent"') && at('data-target="debugPanelContent"') < at('data-target="testPanelContent"'));
  assert.ok(at('js/core/tasks.js') > -1 && at('js/core/tasks.js') < at('js/core/test-explorer.js')); ['codemini-config', 'quick-open', 'background-tasks'].forEach((f) => assert.ok(at('js/core/' + f + '.js') < at('js/core/test-explorer.js'), f + ' loads first'));
  assert.ok(read('sw.js').includes("'/js/core/test-explorer.js'"));
});
t('the sidebar is remembered, restored and closed with the others (script.js), and the editor hands its editors over', () => {
  const s = read('js/core/script.js');
  assert.ok(/testSidebar'\)\?\.classList\.contains\('open'\) \? 'tests'/.test(s)); assert.ok(/uiState\.sidebar === 'tests'/.test(s)); assert.ok(/testSidebar'\)\?\.classList\.remove\('open'\)/.test(s) && /menuTests'\)\?\.classList\.remove\('active'\)/.test(s));
  const e = read('js/core/editor.js');
  assert.ok(/CodeMiniTests\.attachEditor\(editorInstance\)/.test(e) && /try \{ window\.CodeMiniTests\.attachEditor/.test(e), 'guarded');
  assert.ok(/te-glyph/.test(e.slice(e.indexOf('editorInstance.onMouseDown'), e.indexOf('editorInstance.onMouseDown') + 500)), 'a click on a test glyph is not a breakpoint');
});
t('the test glyph classes are separate from the breakpoint glyph, and the CSS has them all', () => {
  const css = read('css/style.css');
  ['te-glyph-idle', 'te-glyph-pass', 'te-glyph-fail', 'te-glyph-run', 'te-glyph-skip', 'te-summary', 'te-bar', 'te-err-msg', 'te-cmp', 'sb-segmented'].forEach((c) => assert.ok(css.includes('.' + c), c));
  assert.ok(!/\.te-glyph[^{]*debug-breakpoint-glyph|debug-breakpoint-glyph[^{]*te-glyph/.test(css));
  assert.ok(/\.te-err-msg[^}]*border-left: 3px solid var\(--color-danger\)/.test(css), 'the error strip has the 3px danger edge');
});
t('it registers tests.json (template and schema), commands in Quick Open, and a "tests" kind on the Now Island', () => {
  const src = read('js/core/test-explorer.js');
  assert.ok(/registerTemplate\('tests\.json'/.test(src) && /registerSchema\('tests\.json'/.test(src) && /registerCommands\(paletteCommands\)/.test(src) && /subscribe\(noteRecords\)/.test(src));
  assert.ok(/tests: \{ icon: 'ri-test-tube-line'/.test(read('js/core/background-tasks.js')));
  const names = ['Run All Tests', 'Run Tests in Current File', 'Run Failed Tests', 'Open Test Explorer', 'Configure Test Patterns']; names.forEach((x) => assert.ok(src.includes("name: '" + x + "'"), x));
});
t('tests run only through the isolated runner and only when the workspace is trusted', () => {
  const src = read('js/core/test-explorer.js');
  assert.ok(/CodeMiniExec\.use\('terminal'/.test(src) && /canRun\('tests\.json'\)/.test(src)); assert.ok(!/\bPyodide\b|runPython|loadPyodide/.test(src.replace(/\/\/.*$/gm, '').replace(/PY_HARNESS[\s\S]*?`;/, '')), 'no Python engine of its own');
  assert.strictEqual(T.createRunner.length, 1);
});
t('it builds no HTML from names or output: no innerHTML, outerHTML, insertAdjacentHTML or document.write', () => {
  const src = read('js/core/test-explorer.js').replace(/\/\/.*$/gm, '');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src));
});
t('Test Explorer is in npm test and documented in the README tests table', () => {
  assert.ok(/node tests\/test-explorer\.test\.js/.test(JSON.parse(read('package.json')).scripts.test)); assert.ok(/test-explorer\.test\.js/.test(read('README.md')));
});

(async () => { for (const [name, fn] of queue) { await fn(); n++; console.log('  ok', name); } console.log(`\n${n} test-explorer checks passed`); })().catch((e) => { console.error(e); process.exit(1); });
