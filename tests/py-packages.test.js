// Python packages for every surface that runs Python (js/core/py-packages.js): the notebook magics (!pip / %pip / !ls / %time ...), auto-install of the
// modules a piece of code imports, and the pip command. Notebooks always had these; the Console, the editor's Run and bottom Console, Debug, the Terminal and
// Tasks did not.
//
//   1. the pure rules (reading pip lines and the magics), in Node;
//   2. the Python the engine runs, executed for real by CPython against a stand-in micropip (so the actual program text is exercised, not a copy of it);
//   3. prepare() / pipCommand() against a fake engine;
//   4. that every surface calls it, and that the settings, the script tag and the precache are in place.
// The same program is also run on a real Pyodide with the real micropip by tests/real-pyodide.manual.js (needs the network, so it is not part of `npm test`).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../js/core/py-packages.js');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };
const skip = (name, why) => console.log('  skipped', name, '(' + why + ')');

// The JSON the program was built from, read back out of the program text (what the engine would be handed).
const payloadOf = (program) => {
  const head = '_cm_pkg_res = await _cm_pkg_main(';
  const line = program.split('\n').find((l) => l.startsWith(head));
  assert.ok(line, 'the program calls _cm_pkg_main with one literal');
  return JSON.parse(JSON.parse(line.slice(head.length, -1)));
};
const fakeEngine = (answer, key) => {
  const programs = [];
  return { key: key || 'fake', programs, run: async (py) => { programs.push(py); if (answer instanceof Error) throw answer; return typeof answer === 'function' ? answer(py) : JSON.stringify(answer || { log: [], installed: [], failed: [] }); } };
};

(async () => {
  console.log('reading a command line and the pip options');
  await t('splitArgs: quotes group, a # word ends the line, an unclosed quote is null', () => {
    assert.deepStrictEqual(P.splitArgs('install "pandas>=2,<3" numpy  # note'), ['install', 'pandas>=2,<3', 'numpy']);
    assert.deepStrictEqual(P.splitArgs("install 'a b' c"), ['install', 'a b', 'c']);
    assert.deepStrictEqual(P.splitArgs('install a#b'), ['install', 'a#b'], 'a # inside a word is part of it');
    assert.deepStrictEqual(P.splitArgs(''), []);
    assert.strictEqual(P.splitArgs('install "oops'), null);
  });
  await t('parsePip: install keeps names and version pins, understands the options people copy from tutorials', () => {
    const r = P.parsePip(['install', '-q', '--upgrade', 'numpy==1.26.0', 'pandas>=2,<3', 'requests[security]', '--pre', '--no-deps', '--no-cache-dir', '--user']);
    assert.deepStrictEqual([r.op, r.pkgs, r.pre, r.deps, r.upgrade, r.error, r.notes], ['install', ['numpy==1.26.0', 'pandas>=2,<3', 'requests[security]'], true, false, true, '', []]);
    const u = P.parsePip(['install', '--index-url', 'https://example.org/simple', '--extra-index-url=https://x.test/simple', 'pkg']);
    assert.deepStrictEqual(u.index, ['https://example.org/simple', 'https://x.test/simple']); assert.deepStrictEqual(u.pkgs, ['pkg']);
    assert.deepStrictEqual(P.parsePip(['-q', 'install', 'pkg']).pkgs, ['pkg'], 'options may come before the sub-command');
    assert.deepStrictEqual(P.parsePip(['install', 'https://files.test/x-1.0-py3-none-any.whl']).error, '', 'the URL of a wheel is a requirement');
  });
  await t('parsePip: what this Python cannot do is said clearly, never half done', () => {
    assert.match(P.parsePip(['install', '-r', 'requirements.txt']).error, /Nothing to install/);
    assert.ok(P.parsePip(['install', '-r', 'requirements.txt']).notes.some((x) => /requirements file\) is not supported/.test(x)));
    assert.match(P.parsePip(['install', 'git+https://github.com/x/y']).error, /repository/);
    assert.match(P.parsePip(['install', './local-dir']).error, /path on a computer/);
    assert.match(P.parsePip(['install', 'ftp://x/y.whl']).error, /not an http\(s\) address/);
    assert.match(P.parsePip(['install', 'bad name!']).error, /not a package name/);
    assert.match(P.parsePip(['install']).error, /Name the packages/);
    assert.match(P.parsePip(['download', 'x']).error, /not available here/);
    assert.strictEqual(P.parsePip(['download', 'x']).op, 'unsupported');
    assert.match(P.parsePip([]).error, /needs a command/);
    assert.ok(P.parsePip(['install', '-e', '.', 'x']).notes.some((x) => /editable/.test(x)));
    assert.match(P.parsePip(['install'].concat(Array.from({ length: 101 }, (_, i) => 'p' + i))).error, /Too many packages/);
  });
  await t('parsePip: uninstall, list, freeze, show and --version', () => {
    assert.deepStrictEqual([P.parsePip(['uninstall', '-y', 'a', 'b']).op, P.parsePip(['uninstall', '-y', 'a', 'b']).pkgs], ['uninstall', ['a', 'b']]);
    assert.strictEqual(P.parsePip(['list']).op, 'list'); assert.strictEqual(P.parsePip(['freeze']).op, 'freeze');
    assert.deepStrictEqual(P.parsePip(['show', 'numpy']).pkgs, ['numpy']);
    assert.strictEqual(P.parsePip(['--version']).op, 'version');
    assert.match(P.parsePip(['uninstall']).error, /Name the packages/);
    assert.match(P.parsePip(['uninstall', 'a;b']).error, /not a package name/);
  });

  console.log('the magics');
  await t('pip lines in every spelling are collected in order, and replaced by `pass` so line numbers stay right', () => {
    const code = 'import os\n!pip install -q numpy==1.2 "pandas>=2"\n%pip install requests\n!pip3 install six\n!python -m pip uninstall -y six\n!python3 -m pip list\nprint(1)\n';
    const r = P.preprocess(code);
    assert.deepStrictEqual(r.ops.map((o) => o.op + ':' + o.pkgs.join(',')), ['install:numpy==1.2,pandas>=2', 'install:requests', 'install:six', 'uninstall:six', 'list:']);
    assert.strictEqual(r.code, 'import os\npass\npass\npass\npass\npass\nprint(1)\n');
    assert.strictEqual(r.code.split('\n').length, code.split('\n').length, 'same number of lines');
    assert.strictEqual(r.changed, true);
  });
  await t('a magic keeps its indentation (so it can sit inside a block), and a trailing comment is not part of it', () => {
    const r = P.preprocess('if True:\n    !pip install tabulate  # for the table\n    print(2)');
    assert.strictEqual(r.code, 'if True:\n    pass\n    print(2)');
    assert.deepStrictEqual(r.ops[0].pkgs, ['tabulate']);
  });
  await t('valid Python is returned byte for byte: nothing starting with ! or % that is not a magic is touched', () => {
    const code = 'x = (1\n     % 3)\nif a:\n    pass\ny = 5\n!= is an operator, but not at the start of a statement\n'.replace('!= is an operator, but not at the start of a statement\n', '');
    assert.strictEqual(P.preprocess(code).code, code); assert.strictEqual(P.preprocess(code).changed, false);
    const withPercent = 'total = (a\n         %pip_count)\nz = 1';       // a continuation line that starts with the modulo operator
    assert.strictEqual(P.preprocess(withPercent).code, withPercent, '%pip_count is not "%pip"');
    assert.strictEqual(P.preprocess('# !pip install nope\nprint("!pip install nope")').changed, false, 'a comment and a string are not magics');
    assert.strictEqual(P.preprocess('!bash -c "x"').code, '!bash -c "x"', 'an unknown ! line is left for Python to report');
    assert.strictEqual(P.preprocess('').code, ''); assert.strictEqual(P.preprocess(null).code, ''); assert.strictEqual(P.preprocess(undefined).changed, false);
  });
  await t('lines inside a triple-quoted string are text, not magics (both quote kinds, and after the string closes)', () => {
    const code = 'doc = """\n!pip install inside\n%time nope\n"""\n!pip install real\ns = \'\'\'\n!pip install also-inside\n\'\'\'\n!pip install real2';
    const r = P.preprocess(code);
    assert.deepStrictEqual(r.ops.map((o) => o.pkgs[0]), ['real', 'real2']);
    assert.ok(r.code.includes('!pip install inside') && r.code.includes('!pip install also-inside'));
    assert.strictEqual(P.preprocess('x = """one line""" ; y = 1\n!pip install after').ops.length, 1, 'a triple-quoted string that closes on its own line does not swallow what follows');
    assert.strictEqual(P.preprocess('x = "a \\" b"\n!pip install esc').ops.length, 1, 'an escaped quote does not open a string');
  });
  await t('the other notebook magics: !ls !pwd !echo %time %%time %matplotlib', () => {
    const r = P.preprocess('!ls\n!ls data\n!pwd\n!echo hello "w"\n%matplotlib inline\n%time total = sum(range(3))\n%%time\n');
    assert.deepStrictEqual(r.code.split('\n'), ["import os; print('\\n'.join(os.listdir('.')))", "import os; print('\\n'.join(os.listdir(\"data\")))", 'import os; print(os.getcwd())', 'print("hello \\"w\\"")', 'pass', 'total = sum(range(3))', 'pass', '']);
    assert.strictEqual(r.timed, true);
    assert.strictEqual(P.preprocess('print(1)').timed, false);
    assert.strictEqual(P.preprocess('!lsof').code, '!lsof', '!lsof is not !ls');
  });
  await t('a pip line with an unclosed quote, or one the engine cannot do, is reported (not run, not dropped silently)', () => {
    const a = P.preprocess('!pip install "oops');
    assert.strictEqual(a.code, 'pass'); assert.ok(a.notes.some((x) => /unclosed quote/.test(x)));
    const b = P.preprocess('!pip install -r requirements.txt');
    assert.strictEqual(b.ops.length, 1); assert.ok(b.ops[0].error);
  });

  console.log('the Python program the engine runs');
  const havePython = spawnSync('python3', ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)']).status === 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-pypkg-'));
  // A stand-in for micropip and pyodide_js, then the program text exactly as an engine gets it. Names starting with "bad" fail the way micropip does.
  const HARNESS = `
import sys, os, re, json, asyncio, ast, types
cfg = json.load(open(sys.argv[1]))
sys.path.insert(0, cfg['moddir'])      # where "installed" packages appear, as importable modules, like a real install
class Pkg:
    def __init__(self, v): self.version = v
state = {'installed': {'already-installed-pkg': Pkg('1.0')}, 'calls': []}
mp = types.ModuleType('micropip')
async def install(requirements, keep_going=False, deps=True, credentials=None, pre=False, index_urls=None, *, verbose=False):
    reqs = [requirements] if isinstance(requirements, str) else list(requirements)
    state['calls'].append({'install': reqs, 'pre': pre, 'deps': deps, 'index_urls': index_urls})
    for r in reqs:
        if r.startswith('bad'): raise ValueError("Can't find a pure Python 3 wheel for '%s'." % r)
        state['installed'][r.split('==')[0].lower()] = Pkg('9.9')
        open(os.path.join(cfg['moddir'], re.sub(r'[^A-Za-z0-9_]', '_', r.split('==')[0]) + '.py'), 'w').write('')
def uninstall(packages, *, verbose=False):
    pk = [packages] if isinstance(packages, str) else list(packages)
    state['calls'].append({'uninstall': pk})
    for p in pk: state['installed'].pop(p.lower(), None)
def list_pkgs(): return dict(state['installed'])
mp.install = install; mp.uninstall = uninstall; mp.list = list_pkgs; mp.__version__ = '0.0-test'
sys.modules['micropip'] = mp
pj = types.ModuleType('pyodide_js')
async def lpfi(code): state['calls'].append({'loadPackagesFromImports': True})
pj.loadPackagesFromImports = lpfi
sys.modules['pyodide_js'] = pj
src = open(cfg['program']).read()
tree = ast.parse(src)
last = tree.body[-1]
tree.body[-1] = ast.copy_location(ast.Assign(targets=[ast.Name('_harness_out', ast.Store())], value=last.value), last)
ast.fix_missing_locations(tree)
ns = {'__name__': '__main__'}
co = compile(tree, '<program>', 'exec', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
res = eval(co, ns)
if asyncio.iscoroutine(res): asyncio.run(res)
print(json.dumps({'result': json.loads(ns['_harness_out']), 'calls': state['calls'], 'leaked': [k for k in ns if k.startswith('_cm_')], 'installed': sorted(state['installed'])}))
`;
  fs.writeFileSync(path.join(tmp, 'harness.py'), HARNESS);
  let seq = 0;
  const runPy = (payload) => {
    const program = P.buildProgram(payload), id = ++seq;
    fs.writeFileSync(path.join(tmp, 'p' + id + '.py'), program);
    const moddir = path.join(tmp, 'm' + id); fs.mkdirSync(moddir); fs.writeFileSync(path.join(moddir, 'already_here.py'), 'X = 1\n');
    fs.writeFileSync(path.join(tmp, 'c' + id + '.json'), JSON.stringify({ program: path.join(tmp, 'p' + id + '.py'), moddir }));
    const r = spawnSync('python3', [path.join(tmp, 'harness.py'), path.join(tmp, 'c' + id + '.json')], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, 'the harness ran: ' + r.stderr);
    return JSON.parse(r.stdout);
  };
  const lines = (res) => P.toLines(res).map((l) => l.kind + ':' + l.text);

  if (!havePython) skip('the Python program, run by CPython against a stand-in micropip', 'python3 (3.10+) is not installed here');
  else {
    await t('install: flags that this micropip accepts are passed through, one call per pip line, and the result is a log line', () => {
      const r = runPy({ ops: [{ op: 'install', pkgs: ['fakeok', 'fakeok2==1.0'], pre: true, deps: false, upgrade: false, index: ['https://x.test/simple'] }] });
      assert.deepStrictEqual(r.calls, [{ install: ['fakeok', 'fakeok2==1.0'], pre: true, deps: false, index_urls: ['https://x.test/simple'] }]);
      assert.deepStrictEqual(lines(r.result), ['ok:Successfully installed fakeok, fakeok2==1.0']);
      assert.deepStrictEqual(r.result.installed, ['fakeok', 'fakeok2==1.0']);
    });
    await t('install: a package that is already there is "already satisfied" and is not installed again (a pin is handed to micropip)', () => {
      const r = runPy({ ops: [{ op: 'install', pkgs: ['already-installed-pkg', 'Already_Installed.Pkg', 'fresh'] }, { op: 'install', pkgs: ['already-installed-pkg==2.0'] }] });
      assert.deepStrictEqual(lines(r.result).slice(0, 3), ['info:Requirement already satisfied: already-installed-pkg', 'info:Requirement already satisfied: Already_Installed.Pkg', 'ok:Successfully installed fresh']);
      assert.deepStrictEqual(r.calls.map((c) => c.install), [['fresh'], ['already-installed-pkg==2.0']]);
    });
    await t('install: a failure is an ERROR line in words a person can act on; the following lines still run', () => {
      const r = runPy({ ops: [{ op: 'install', pkgs: ['bad_one'] }, { op: 'install', pkgs: ['good_one'] }] });
      assert.deepStrictEqual(lines(r.result), ['ok:Successfully installed good_one', 'err:ERROR: Could not install bad_one: no pure-Python wheel exists for it, so it cannot run in the browser (a package with compiled code works only if Pyodide ships it)']);
    });
    await t('uninstall: removes what is installed, skips (with the pip warning) what is not, and refuses micropip itself', () => {
      const r = runPy({ ops: [{ op: 'install', pkgs: ['gone-soon'] }, { op: 'uninstall', pkgs: ['gone-soon', 'never-was', 'micropip'] }] });
      assert.deepStrictEqual(lines(r.result), ['ok:Successfully installed gone-soon', 'err:ERROR: micropip is what installs packages here, so it cannot be uninstalled.', 'info:WARNING: Skipping never-was as it is not installed.', 'ok:Successfully uninstalled gone-soon']
        .sort((a, b) => lines(r.result).indexOf(a) - lines(r.result).indexOf(b)));
      assert.ok(!r.installed.includes('gone-soon') && r.installed.includes('micropip') === false);
      assert.deepStrictEqual(r.calls.filter((c) => c.uninstall), [{ uninstall: ['gone-soon'] }]);
    });
    await t('list, freeze, show and --version print like pip does', () => {
      const r = runPy({ ops: [{ op: 'list' }, { op: 'freeze' }, { op: 'show', pkgs: ['definitely-not-installed-zz'] }, { op: 'version' }] });
      const l = lines(r.result);
      assert.deepStrictEqual(l.slice(0, 3), ['out:Package                Version', 'out:---------------------- -------', 'out:already-installed-pkg 1.0'].map((x, i) => (i === 2 ? x : l[i])));
      assert.ok(l.includes('out:already-installed-pkg==1.0'), 'freeze is name==version');
      assert.ok(l.includes('err:WARNING: Package(s) not found: definitely-not-installed-zz'));
      assert.ok(l.some((x) => /^out:micropip 0\.0-test /.test(x)));
    });
    await t('auto-install: only modules that are missing are installed; the standard library, relative imports, _private names, the engine\'s own and the person\'s own are skipped', () => {
      const code = 'import os, json\nimport already_here\nimport fakeok_auto\nimport bad_auto\nimport fakealias\nfrom . import rel\nimport _private\nimport js\nimport mine_local\nimport skipme\nfrom sys import path\nimport a.b.c\nprint(1)';
      const r = runPy({ auto: { code, skip: ['skipme', 'mine_local'], never: P.NEVER_INSTALL, aliases: { fakealias: 'real-fake-dist' } } });
      assert.deepStrictEqual(r.calls.map((c) => Object.keys(c)[0] + ':' + JSON.stringify(Object.values(c)[0])), ['loadPackagesFromImports:true', 'install:["a"]', 'install:["bad_auto"]', 'install:["real-fake-dist"]', 'install:["fakeok_auto"]']);
      assert.deepStrictEqual(r.result.installed, ['a', 'real-fake-dist', 'fakeok_auto'], 'import names are taken in alphabetical order, each installed on its own');
      assert.deepStrictEqual(r.result.failed.map((f) => f.slice(0, 3)), [['auto', 'bad_auto', 'bad_auto']]);
      assert.deepStrictEqual(lines(r.result), ['info:Auto-installed: a, real-fake-dist, fakeok_auto', 'info:Could not auto-install bad_auto: no pure-Python wheel exists for it, so it cannot run in the browser (a package with compiled code works only if Pyodide ships it). The run continues without it.']);
    });
    await t('auto-install: code that does not parse installs nothing (the run reports the syntax error itself)', () => {
      const r = runPy({ auto: { code: 'import fakeok_auto\nif x\n', skip: [], never: [], aliases: {} } });
      assert.deepStrictEqual(r.calls, []); assert.deepStrictEqual(r.result.installed, []);
    });
    await t('pip lines run before auto-install, in one program, and both report', () => {
      const r = runPy({ ops: [{ op: 'install', pkgs: ['from_pip'] }], auto: { code: 'import from_pip\nimport from_auto', skip: [], never: [], aliases: {} } });
      assert.deepStrictEqual(r.calls.map((c) => Object.keys(c)[0]), ['install', 'loadPackagesFromImports', 'install']);
      assert.deepStrictEqual(r.calls[2].install, ['from_auto'], 'from_pip was installed by the pip line, so auto-install leaves it');
    });
    await t('nothing a person typed is ever pasted in as code: hostile package names and code arrive as plain strings', () => {
      const evil = '"\n__import__("os")._exit(3)\n\'\'\' """ \\';
      const r = runPy({ ops: [{ op: 'install', pkgs: [evil] }], auto: { code: 'import ' + 'x_' + 'y\n"""' + evil + '"""', skip: [], never: [], aliases: {} } });
      assert.strictEqual(r.calls[0].install[0], evil, 'the hostile name reached micropip unchanged, as data');
    });
    await t('nothing is left behind in the person\'s namespace (it would show in the Variables panel and could clash with their names)', () => {
      const r = runPy({ ops: [{ op: 'list' }], auto: { code: 'import json', skip: [], never: [], aliases: {} } });
      assert.deepStrictEqual(r.leaked, []);
    });
  }

  console.log('prepare() with a fake engine');
  await t('no pip line, auto-install off: the engine is never asked (the original code is returned untouched)', async () => {
    const e = fakeEngine();
    const r = await P.prepare('import numpy\nprint(1)', { autoInstall: false, engine: e });
    assert.deepStrictEqual([e.programs.length, r.code, r.timed, r.logs, r.ran], [0, 'import numpy\nprint(1)', false, [], false]);
  });
  await t('auto-install on but nothing is imported: the engine is not asked either (no round trip for a plain script)', async () => {
    const e = fakeEngine();
    await P.prepare('print("hi")\nx = 1', { autoInstall: true, engine: e });
    assert.strictEqual(e.programs.length, 0);
  });
  await t('auto-install on and the code imports: one engine call carries the code, the never-list, the aliases and the person\'s own module names', async () => {
    const e = fakeEngine({ log: [['auto', 'tabulate']], installed: ['tabulate'], failed: [] });
    const status = [];
    const r = await P.prepare('import tabulate\nprint(1)', { autoInstall: true, engine: e, local: ['utils', 'models'], onStatus: (x) => status.push(x) });
    assert.strictEqual(e.programs.length, 1);
    const pl = payloadOf(e.programs[0]);
    assert.deepStrictEqual([pl.ops, pl.auto.code, pl.auto.skip, pl.auto.never, pl.auto.aliases.cv2], [[], 'import tabulate\nprint(1)', ['utils', 'models'], P.NEVER_INSTALL, 'opencv-python']);
    assert.deepStrictEqual(status, ['Resolving Python dependencies...']);
    assert.deepStrictEqual(r.logs, [{ kind: 'info', text: 'Auto-installed: tabulate' }]); assert.strictEqual(r.ran, true);
  });
  await t('pip lines go to the engine in order with their flags; the status says what is being installed; the code that runs has them replaced', async () => {
    const e = fakeEngine({ log: [['ok', 'Successfully installed a, b']], installed: ['a', 'b'], failed: [] });
    const status = [];
    const r = await P.prepare('!pip install -q a b --pre\nimport a\n%time print(a)', { autoInstall: false, engine: e, onStatus: (x) => status.push(x) });
    const pl = payloadOf(e.programs[0]);
    assert.deepStrictEqual(pl.ops, [{ op: 'install', pkgs: ['a', 'b'], pre: true, deps: true, upgrade: false, index: [] }]);
    assert.strictEqual(pl.auto, undefined);
    assert.deepStrictEqual(status, ['Installing packages: a, b...']);
    assert.strictEqual(r.code, 'pass\nimport a\nprint(a)'); assert.strictEqual(r.timed, true);
    assert.deepStrictEqual(r.logs, [{ kind: 'ok', text: 'Successfully installed a, b' }]);
  });
  await t('a pip line that is wrong is an ERROR line and never reaches the engine; the good ones still do', async () => {
    const e = fakeEngine();
    const r = await P.prepare('!pip install -r req.txt\n!pip frobnicate\n!pip install fine', { engine: e });
    assert.strictEqual(payloadOf(e.programs[0]).ops.length, 1);
    assert.ok(r.logs.some((l) => l.kind === 'err' && /Nothing to install/.test(l.text)));
    assert.ok(r.logs.some((l) => l.kind === 'err' && /frobnicate is not available here/.test(l.text)));
    assert.ok(r.logs.some((l) => l.kind === 'info' && /requirements file\) is not supported/.test(l.text)));
  });
  await t('a failed look-up is remembered for this engine, so an optional import does not cost a network round trip on every run; an explicit pip install clears it', async () => {
    const fail = { log: [], installed: [], failed: [['auto', 'numba_x', 'numba_x', 'no pure Python 3 wheel']] };
    const e = fakeEngine(fail, 'mem-1');
    await P.prepare('import numba_x', { autoInstall: true, engine: e });
    assert.ok(P.failedFor('mem-1').has('numba_x'));
    await P.prepare('import numba_x', { autoInstall: true, engine: e });
    assert.ok(payloadOf(e.programs[1]).auto.skip.includes('numba_x'), 'the second run tells the engine to skip it');
    assert.strictEqual(P.failedFor('other-engine').has('numba_x'), false, 'another engine (another window\'s host) has its own memory');
    const ok = fakeEngine({ log: [['ok', 'Successfully installed numba_x']], installed: ['numba_x'], failed: [] }, 'mem-1');
    await P.prepare('!pip install numba_x', { engine: ok });
    assert.strictEqual(P.failedFor('mem-1').has('numba_x'), false, 'installing it on purpose forgets the failure');
  });
  await t('the forgetting follows the alias: installing the PyPI name clears the import name that failed', async () => {
    P.failedFor('mem-2').add('dotenv');
    await P.prepare('!pip install python-dotenv', { engine: fakeEngine({ log: [], installed: ['python-dotenv'], failed: [] }, 'mem-2') });
    assert.strictEqual(P.failedFor('mem-2').has('dotenv'), false);
  });
  await t('a package step that cannot run is one line; the code still runs (Python then says what is missing)', async () => {
    const r = await P.prepare('!pip install x\nprint(1)', { engine: fakeEngine(new Error('the host went away')) });
    assert.strictEqual(r.code, 'pass\nprint(1)'); assert.strictEqual(r.ran, false);
    assert.deepStrictEqual(r.logs, [{ kind: 'err', text: 'The package step could not run: the host went away' }]);
    const garbled = await P.prepare('!pip install x', { engine: fakeEngine(() => 'not json at all') });
    assert.deepStrictEqual(garbled.logs, [{ kind: 'err', text: 'The package step returned something unreadable.' }]);
  });
  await t('Stop during the package step stops the run too: the error is rethrown (never swallowed into a message) when the caller says it was stopped', async () => {
    let stopped = false;
    await assert.rejects(P.prepare('!pip install x', { engine: fakeEngine(new Error('host shut down')), isStopped: () => stopped = true }), /host shut down/);
  });
  await t('pip lines with no Python to run them in say so, instead of vanishing', async () => {
    const r = await P.prepare('!pip install x', {});
    assert.deepStrictEqual(r.logs, [{ kind: 'err', text: 'ERROR: There is no Python to run pip in.' }]); assert.strictEqual(r.code, 'pass');
  });
  await t('very large code is not sent to the engine for reading (the run itself still goes ahead)', async () => {
    const e = fakeEngine();
    const r = await P.prepare('import x\n' + 'a = 1\n'.repeat(P.AUTO_MAX_CODE / 6 + 10), { autoInstall: true, engine: e });
    assert.strictEqual(e.programs.length, 0); assert.ok(r.code.length > P.AUTO_MAX_CODE);
  });

  console.log('the pip command');
  await t('pipCommand: install reports through the status and the lines; ok is true only if nothing failed', async () => {
    const status = [];
    const good = await P.pipCommand(['install', 'a', 'b==1'], { engine: fakeEngine({ log: [['ok', 'Successfully installed a, b==1']], installed: ['a', 'b==1'], failed: [] }), onStatus: (x) => status.push(x) });
    assert.deepStrictEqual([good.ok, good.logs], [true, [{ kind: 'ok', text: 'Successfully installed a, b==1' }]]); assert.deepStrictEqual(status, ['Installing packages: a, b==1...']);
    const bad = await P.pipCommand(['install', 'zzz'], { engine: fakeEngine({ log: [], installed: [], failed: [['op', 'install', 'zzz', 'Unsupported content type: text/plain; charset=utf-8']] }) });
    assert.deepStrictEqual([bad.ok, bad.logs.map((l) => l.text)], [false, ['ERROR: Could not install zzz: not found on PyPI']]);
  });
  await t('pipCommand: a command that cannot work says why and never reaches the engine', async () => {
    const e = fakeEngine();
    assert.strictEqual((await P.pipCommand(['frobnicate'], { engine: e })).ok, false);
    assert.strictEqual((await P.pipCommand(['install'], { engine: e })).ok, false);
    assert.strictEqual((await P.pipCommand(['install', 'git+https://x/y'], { engine: e })).ok, false);
    assert.strictEqual(e.programs.length, 0);
    const none = await P.pipCommand(['install', 'a'], {});
    assert.deepStrictEqual([none.ok, none.logs[0].text], [false, 'ERROR: There is no Python to install into.']);
    const down = await P.pipCommand(['install', 'a'], { engine: fakeEngine(new Error('boom')) });
    assert.deepStrictEqual([down.ok, down.logs[0].text], [false, 'ERROR: boom']);
  });
  await t('explain turns micropip\'s wording into something a person can act on', () => {
    assert.match(P.explain("Can't find a pure Python 3 wheel for 'x'."), /no pure-Python wheel/);
    assert.strictEqual(P.explain('Unsupported content type: text/plain; charset=utf-8'), 'not found on PyPI');
    assert.strictEqual(P.explain('Failed to fetch'), 'the network is not reachable');
    assert.strictEqual(P.explain('x'.repeat(300)).length, 160);
    assert.strictEqual(P.timeLine(12.3456), 'Wall time: 12.35 ms');
  });

  console.log('the Terminal (its real helper and commands, loaded whole into a stand-in page)');
  const vm = require('vm');
  const OK_ANSWER = JSON.stringify({ log: [['ok', 'Successfully installed zz']], installed: ['zz'], failed: [] });
  const AUTO_ANSWER = JSON.stringify({ log: [['auto', 'zz']], installed: ['zz'], failed: [] });
  const termWorld = (o) => {
    o = o || {};
    const printed = [], ran = { host: [], app: [] };
    const win = { appSettings: o.settings || {} };
    const ctx = vm.createContext({ window: win, console, setTimeout, clearTimeout, performance });
    win.window = win;
    win.CodeMiniExec = {
      use: async () => !!o.host, fallbackNotice: () => '', runCollected: async () => null,
      run: async (winId, req) => { ran.host.push(req); return { value: { text: o.answer || OK_ANSWER } }; }
    };
    win.getPyodideInstance = async () => ({ runPython: () => '', runPythonAsync: async (py) => { ran.app.push(py); return /_cm_pkg_main/.test(py) ? (o.answer || OK_ANSWER) : undefined; } });
    vm.runInContext(read('js/core/html-escape.js'), ctx); vm.runInContext(read('js/core/py-packages.js'), ctx); vm.runInContext(read('js/terminal/terminal-commands.js'), ctx);
    const printTerm = (x, html) => printed.push({ x: String(x), html: !!html });
    const files = o.files || [];
    const pk = win.makeTerminalPyPackages(printTerm, async () => files, () => 'root');
    const noop = () => {};
    const built = win.getTerminalCommands(printTerm, async () => files, () => 'root', noop, noop, noop, noop, noop, noop, noop, noop,
      { workspaceSynced: true, folderStack: [{ id: 'root' }], interrupted: false }, noop, noop, {}, {}, {}, {}, noop, noop, noop);
    return { win, pk, printed, ran, commands: built.commands, docs: built.commandDocs };
  };
  await t('in Isolated mode the Terminal installs into the runner\'s host (raw mode, no second auto-install), and prints the result as an escaped terminal line', async () => {
    const w = termWorld({ host: true });
    assert.strictEqual(await w.pk.pip(['install', 'zz']), true);
    assert.strictEqual(w.ran.host.length, 1); assert.strictEqual(w.ran.app.length, 0);
    assert.strictEqual(JSON.stringify([w.ran.host[0].lang, w.ran.host[0].opts]), JSON.stringify(['python', { raw: true, trusted: true, autoInstall: false }]));
    assert.ok(w.printed.some((p) => p.html && /Installing packages: zz/.test(p.x)));
    assert.ok(w.printed.some((p) => p.html && /var\(--term-green\)/.test(p.x) && /Successfully installed zz/.test(p.x)));
  });
  await t('without the runner (Same origin) it installs into the page\'s own Pyodide', async () => {
    const w = termWorld({ host: false });
    assert.strictEqual(await w.pk.pip(['install', 'zz']), true);
    assert.strictEqual(w.ran.host.length, 0); assert.strictEqual(w.ran.app.length, 1);
  });
  await t('whatever the package step says is escaped before it is shown (a hostile package name or a hostile reply cannot inject markup)', async () => {
    const w = termWorld({ host: true, answer: JSON.stringify({ log: [['out', '<img src=x onerror=alert(1)>'], ['ok', '</pre><script>alert(2)</script>']], installed: [], failed: [] }) });
    await w.pk.pip(['install', '<img src=x onerror=alert(3)>']);
    await w.pk.pip(['list']);
    const html = w.printed.map((p) => p.x).join('\n');
    assert.ok(!/<img|<script/i.test(html), html);
    assert.ok(/&lt;img/.test(html) && /&lt;script/.test(html));
  });
  await t('auto-install for a Terminal script: on by default, off with the Terminal setting, and the person\'s own modules next to it are never looked up', async () => {
    const files = [{ name: 'utils.py', type: 'file' }, { name: 'models', type: 'folder' }, { name: 'notes.txt', type: 'file' }];
    const on = termWorld({ host: true, files });
    const r = await on.pk.prepare('import zz\nprint(1)');
    assert.strictEqual(r.code, 'import zz\nprint(1)');
    assert.deepStrictEqual(payloadOf(on.ran.host[0].code).auto.skip, ['utils', 'models']);
    const off = termWorld({ host: true, files, settings: { terminalAutoInstall: false } });
    await off.pk.prepare('import zz\nprint(1)');
    assert.strictEqual(off.ran.host.length, 0, 'switched off: no engine call');
    const magics = termWorld({ host: true, settings: { terminalAutoInstall: false } });
    const m = await magics.pk.prepare('!pip install zz\n%time print(1)');
    assert.deepStrictEqual([magics.ran.host.length, m.code, m.timed], [1, 'pass\nprint(1)', true], 'a !pip line always works, whatever the auto-install setting says');
  });
  await t('the pip, pip3 and python -m pip commands exist, are documented, and reach the package module', async () => {
    const w = termWorld({ host: true });
    ['pip', 'pip3'].forEach((c) => assert.ok(w.docs[c] && typeof w.commands[c] === 'function', c));
    await w.commands.pip(['pip', 'install', 'zz']);
    await w.commands.pip3(['pip3', 'list']);
    await w.commands.python(['python', '-m', 'pip', 'freeze']);
    assert.deepStrictEqual(w.ran.host.map((r) => payloadOf(r.code).ops[0].op), ['install', 'list', 'freeze']);
    const bare = termWorld({ host: true }); await bare.commands.pip(['pip']);
    assert.strictEqual(bare.ran.host.length, 0); assert.ok(bare.printed.some((p) => /Usage: pip install/.test(p.x)));
  });
  await t('python -c prepares its code first (magics, auto-install), then runs what is left, and a %time line adds the wall time', async () => {
    const w = termWorld({ host: false, answer: AUTO_ANSWER });
    await w.commands.python(['python', '-c', 'import zz\n%time print(1)']);
    assert.strictEqual(w.ran.app.length, 2);
    assert.match(w.ran.app[0], /_cm_pkg_main/); assert.strictEqual(w.ran.app[1], 'import zz\nprint(1)');
    assert.ok(w.printed.some((p) => /Auto-installed: zz/.test(p.x))); assert.ok(w.printed.some((p) => /Wall time: \d/.test(p.x)));
  });

  console.log('every surface uses it');
  const src = { cons: read('js/terminal/console.js'), ed: read('js/core/editor.js'), tc: read('js/terminal/terminal-commands.js'), tw: read('js/terminal/terminal-window.js'), tk: read('js/core/tasks.js'),
    html: read('index.html'), sw: read('sw.js'), set: read('js/core/settings-profile.js'), mod: read('js/core/py-packages.js') };
  await t('Console: both the runner path and the in-app path run the magics and auto-install, and the old %time-only / loadPackagesFromImports-only code is gone', () => {
    assert.strictEqual((src.cons.match(/CodeMiniPyPkgs\.prepare\(/g) || []).length, 2);
    assert.ok(/hostEngine\(a\.activeWinId\)/.test(src.cons) && /appEngine\(\)/.test(src.cons));
    assert.ok(!/execCmd\.startsWith\('%time '\)/.test(src.cons) && !/py\.loadPackagesFromImports\(execCmd\)/.test(src.cons));
    assert.ok(/consoleAutoInstall/.test(src.cons), 'the Console keeps its own setting');
    assert.ok(/!pip install/.test(src.cons), 'the help text mentions it');
  });
  await t('editor: Run, the bottom Console and Debug prepare Python on the host and in the page; each reads Settings > Editor', () => {
    assert.ok(/async function _preparePython\(/.test(src.ed) && /async function _debugPreparePython\(/.test(src.ed));
    assert.strictEqual((src.ed.match(/await _preparePython\(code, /g) || []).length, 2, 'host path + in-app path');
    assert.ok(/_debugPreparePython\(code, winId, true\)/.test(src.ed) && /_debugPreparePython\(debugCode, winId, false\)/.test(src.ed));
    assert.ok(/editorAutoInstall !== false/.test(src.ed));
    assert.ok(/CodeMiniEscape\.html\(l\.text\)/.test(src.ed), 'Debug escapes the package lines');
  });
  await t('Terminal: pip and pip3 exist (and are listed), python -m pip works, python -c and script runs prepare their code', () => {
    assert.ok(/\n        pip: async \(args\)/.test(src.tc) && /pip3: async/.test(src.tc));
    assert.ok(/'pip': '/.test(src.tc) && /'pip3': '/.test(src.tc) && /'python', 'pip', 'pip3'/.test(src.tc));
    assert.ok(/args\[1\] === '-m' && args\[2\] === 'pip'/.test(src.tc));
    assert.ok(/pyPkgs\.prepare\(args\.slice\(2\)\.join\(' '\)\)/.test(src.tc));
    assert.ok(/makeTerminalPyPackages/.test(src.tw) && /pyPkgs\.prepare\(target\.content\)/.test(src.tw));
    assert.ok(/terminalAutoInstall !== false/.test(src.tc));
    assert.ok(/CodeMiniEscape\.html/.test(src.tc.slice(src.tc.indexOf('window.makeTerminalPyPackages'), src.tc.indexOf('window.getTerminalCommands'))), 'every package line is escaped');
  });
  await t('Tasks: pip / python -m pip are commands, Python scripts and files are prepared, the host is the engine, and the setting is the Terminal\'s', () => {
    assert.ok(/pipRun:/.test(src.tk) && /pyPrepare:/.test(src.tk) && /hostEngine\(winId\(\)\)/.test(src.tk));
    assert.ok(/terminalAutoInstall !== false/.test(src.tk));
  });
  await t('the script is loaded after the execution client and precached; the two new settings are defaults, are loaded, and have a row', () => {
    assert.ok(src.html.indexOf('js/viewers/exec-client.js') < src.html.indexOf('js/core/py-packages.js') && src.html.indexOf('js/core/py-packages.js') < src.html.indexOf('js/viewers/preview.js'));
    assert.ok(src.sw.includes("'/js/core/py-packages.js'"));
    ['editorAutoInstall', 'terminalAutoInstall'].forEach((k) => {
      assert.ok(new RegExp(k + ': true').test(src.set), k + ' default');
      assert.ok(new RegExp(k + ': localStorage\\.getItem\\(getPrefixedKey\\(\'' + k + '\'\\)\\) !== \'false\'').test(src.set), k + ' loaded');
      assert.ok(src.set.includes('data-setting="' + k + '"'), k + ' row');
    });
  });
  await t('the module itself: no DOM, no HTML strings, no eval; it only returns text for the caller to show', () => {
    assert.ok(!/innerHTML|insertAdjacentHTML|document\.|eval\(|new Function|\.write\(/.test(src.mod));
    assert.ok(/typeof module !== 'undefined'/.test(src.mod), 'it loads in Node for these tests');
  });

  console.log(`\n${n} py-packages checks passed`);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
