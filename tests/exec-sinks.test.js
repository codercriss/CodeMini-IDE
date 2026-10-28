// Where user code can be executed inside the app, and what the Settings and My Keys screens tell people about it.
//
// Phase 3 moved every surface that runs user code (Console, Terminal, editor Run and Debug, Python/R/SQL notebooks) onto
// the runner when Isolation is on. What is left in the app is the Normal-mode / fallback path of each surface, plus the
// code the Preview injects into the previewed page. docs/PHASE3.md section 10 lists every site and says why it is fine.
//
// This test is a ratchet, like tests/html-sinks.test.js: it counts, per file, the lines that can run code
// (eval, new Function, AsyncFunction, Pyodide runPython*, Opal.eval, webR evalR*, php-wasm run). A NEW such line in any
// file fails here, so it has to be reviewed on purpose: is it on the Normal/fallback path behind the host check, or is it
// a way to run user code in the app's origin while Isolation is on? Then update PINNED and PHASE3.md section 10.
// (Nothing needs to run in a browser.)
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

const SINKS = [
  /\beval\s*\(/, /\beval\.call\b/, /new Function\s*\(/, /AsyncFunction\s*\(/,
  /\.runPython(Async)?\s*\(/, /Opal\.eval\s*\(/, /\.evalR(Void)?\s*\(/, /\bphpWeb\w*\.run\s*\(/,
];
const PINNED = {
  'js/core/editor.js': 16,
  'js/notebook/notebook-kernels.js': 16,   // +1: webr.evalR(list.files(...)) in _rListFiles, a fixed file listing (reviewed 2026-10-27)
  'js/notebook/notebook-ui.js': 5,
  'js/terminal/console.js': 10,
  'js/terminal/terminal-commands.js': 8,
  'js/terminal/terminal-window.js': 8,
  'js/viewers/preview.js': 2,
};

function walk(dir, out) {
  for (const f of fs.readdirSync(path.join(root, dir))) {
    const rel = dir + '/' + f;
    if (fs.statSync(path.join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.js$/.test(f)) out.push(rel);
  }
  return out;
}
function count(src) {
  let c = 0;
  for (const line of src.split('\n')) {
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    if (SINKS.some((re) => re.test(line))) c++;
  }
  return c;
}

console.log('code-execution sinks');
t('no file gained a line that can run code (see the header: review it, then update PINNED and docs/PHASE3.md section 10)', () => {
  const found = {};
  for (const f of walk('js', [])) { const c = count(read(f)); if (c) found[f] = c; }
  assert.deepStrictEqual(found, PINNED);
});
t('the counter sees a new sink (it is not blind)', () => {
  assert.strictEqual(count('a();\n// eval(x)\n * new Function(y)\nconst r = eval(code);\nawait new AsyncFunction(c)();\n'), 2);
  assert.strictEqual(count('py.runPythonAsync(s); Opal.eval(s); webr.evalR(s); phpWebX.run(s);'), 1, 'counted per line');
});
t('the Terminal calculator only ever evaluates digits and arithmetic operators', () => {
  const src = read('js/terminal/terminal-commands.js');
  const i = src.indexOf('calc: async');
  assert.ok(i > 0);
  const body = src.slice(i, i + 500);
  assert.ok(/replace\(\/\[\^0-9\+\\-\*\/\(\)\.\]\/g, ''\)/.test(body), 'calc must strip everything but [0-9+-*/().] before new Function');
  assert.ok(body.indexOf('replace(') < body.indexOf('new Function'));
});
t('the notebook formatter hands the code to Python as data, never inside the source it runs', () => {
  const src = read('js/notebook/notebook-ui.js');
  assert.ok(/py\.globals\.set\('_fmt_code', code\)/.test(src));
  assert.ok(/ast\.unparse\(ast\.parse\(_fmt_code\)\)/.test(src));
});
t('every in-app branch of the editor Run and Debug sits behind the host check', () => {
  const src = read('js/core/editor.js');
  const run = src.indexOf('window.runInBottomConsole = async function');
  assert.ok(run > 0);
  const hostCall = src.indexOf('if (await _runOnHost(code, ext, winId)) return;', run);
  assert.ok(hostCall > run);
  // the first in-app engine after the function starts must come after the host call
  const firstEngine = src.slice(run).search(/phpWebInstanceBottom|window\.Opal|eval\.call\(window|new AsyncFunction|getPyodideInstance/);
  assert.ok(run + firstEngine > hostCall, 'an in-app engine is reachable before _runOnHost');
  const dbg = src.indexOf("if (await _debugOnHost('javascript', debugCode, winId)) return;");
  assert.ok(dbg > 0 && dbg < src.indexOf('await (new AsyncFunction(debugCode))()'));
});

console.log('R plots');
t('every webR captureR call turns captureGraphics off, so plots go to the png device and not to webR\'s canvas device', () => {
  // Real phone result (iOS, 2026-10-27): with the default, `plot(1:10)` through the host ended in "(Completed with no output)" and the same
  // call in the app reloaded the page. The png file is what the app reads, so the canvas device must not be opened.
  // Each site: file, how many captureR calls it has, and a pattern for the options object that call really uses (a comment cannot satisfy it).
  const sites = [
    ['../runner/exec.js', 1, /var capOpts = \{[^}]*captureGraphics:\s*false[^}]*\}/],
    ['js/notebook/notebook-kernels.js', 1, /captureR\(execCode,\s*\{[^}]*captureGraphics:\s*false/],
    ['js/notebook/notebook-ui.js', 1, /captureR\(code,\s*\{[^}]*captureGraphics:\s*false/],
  ];
  for (const [f, calls, re] of sites) {
    const src = read(f);
    assert.strictEqual((src.match(/\.captureR\(/g) || []).length, calls, f + ': the number of captureR calls changed, review each one');
    assert.ok(re.test(src), f + ': its captureR options must include captureGraphics: false');
  }
});
t('a plot that cannot be read is reported in the cell, in the host and in the app (it used to be swallowed as "no output")', () => {
  const hostAll = read('../runner/exec.js'), app = read('js/notebook/notebook-kernels.js');
  const a = hostAll.indexOf('async function runR('), b = hostAll.indexOf('// ---- dispatch');
  assert.ok(a > 0 && b > a);
  const host = hostAll.slice(a, b);    // the R function only (the Python plot catch above it is a different, deliberate one)
  assert.ok(!/catch \(e\) \{ \/\* no plots \*\/ \}/.test(host), 'the host must not swallow a plot read error');
  assert.ok(/out\(id, 'stderr', '\[R plot not read: '/.test(host));
  assert.ok(/errorText \+= '\[R plot not read: '/.test(app));
  assert.ok(/is empty\]/.test(host) && /is empty\]/.test(app), 'an empty plot file is reported too');
});
t('nothing calls webR\'s FS.readdir (it does not exist: "w.FS.readdir is not a function" on a phone), and the stand-in webR does not invent it', () => {
  const files = walk('js', []).concat(['../runner/exec.js']);
  for (const f of files) {
    const code = read(f).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(!/\bFS\.readdir\s*\(/.test(code), f + ' calls FS.readdir');
  }
  const fake = read('tests/e2e/lib/fake-webr.mjs').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/readdir\s*:/.test(fake), 'the fake webR must not define FS.readdir');
  for (const f of ['js/notebook/notebook-kernels.js', '../runner/exec.js']) assert.ok(/list\.files\(/.test(read(f)), f + ' must list files through R');
});

console.log('what the screens say');
t('Settings > Security: each isolation dropdown names its own surface (the Notebooks row once said "Terminal")', () => {
  const lines = read('js/core/settings-profile.js').split('\n');
  const row = (key) => lines.find((l) => l.includes('data-setting="' + key + '"'));
  for (const [key, word] of [['isolationPreview', /preview/i], ['isolationConsole', /console/i], ['isolationTerminal', /terminal/i], ['isolationNotebooks', /notebook/i]]) {
    const l = row(key);
    assert.ok(l, key + ' row exists');
    const titles = [...l.matchAll(/title="([^"]*)"/g)].map((m) => m[1]).filter((x) => /isolate/i.test(x));
    assert.strictEqual(titles.length, 2, key + ' has the Isolated and Normal tooltips');
    for (const x of titles) assert.ok(word.test(x), key + ' tooltip names the wrong surface: ' + x);
  }
});
t('Settings > Security > Console says that the editor Run, the bottom Console input and Debug follow it', () => {
  const l = read('js/core/settings-profile.js').split('\n').find((x) => x.includes('data-setting="isolationConsole"'));
  assert.ok(/editor's Run button/.test(l) && /Debug/.test(l));
});
t('My Keys > Config no longer says that code always shares the app page; it names Normal mode and Isolated mode', () => {
  const src = read('js/core/my-keys.js');
  assert.ok(!/Code you run inside CodeMini \(previews, notebooks, terminal\) shares the app's page\./.test(src));
  const i = src.indexOf('What it cannot protect against');
  const note = src.slice(i, i + 900);
  assert.ok(/Normal mode/.test(note) && /Isolated mode/.test(note));
});
t('SECURITY.md has none of the statements that phase 3 made false', () => {
  const s = read('SECURITY.md');
  for (const stale of [
    'Notebooks (Python, R, SQL, PHP, JavaScript cells) still run inside the app',
    'listed there as not yet available',
    'Console and Terminal code (work in progress)',
    'the Terminal path was not yet verified in a browser',
    'Because previews, notebooks and the terminal run in the same page as the app',
  ]) assert.ok(!s.includes(stale), 'stale: ' + stale);
  assert.ok(/Code you run: Console, Terminal, editor and notebooks/.test(s));
});

console.log(`\n${n} checks passed`);
