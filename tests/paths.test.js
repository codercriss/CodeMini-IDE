// tests/lib/paths.js: finds the runner inside the app folder (GitHub repository layout) or beside it (hand-over zip layout), and says
// plainly what is missing. Each case builds a small throw-away tree and loads a copy of the helper from inside it, because the helper
// works out its location from where the file itself sits.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok', name); };
const SRC = fs.readFileSync(path.join(__dirname, 'lib', 'paths.js'), 'utf8');

function tree(layout) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-paths-'));
  const app = layout === 'beside' || layout === 'none' ? path.join(base, 'app') : base;
  fs.mkdirSync(path.join(app, 'tests', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(app, 'tests', 'lib', 'paths.js'), SRC);
  fs.writeFileSync(path.join(app, 'index.html'), '<!doctype html>');
  const runner = layout === 'inside' ? path.join(app, 'runner') : layout === 'beside' ? path.join(base, 'runner') : null;
  if (runner) { fs.mkdirSync(runner); fs.writeFileSync(path.join(runner, 'exec.js'), '// host'); fs.writeFileSync(path.join(runner, 'config.js'), '// config'); }
  const load = () => { const p = path.join(app, 'tests', 'lib', 'paths.js'); delete require.cache[require.resolve(p)]; return require(p); };
  return { base, app, runner, load };
}

console.log('paths helper');
t('finds the runner INSIDE the app folder (the GitHub repository layout)', () => {
  const x = tree('inside'), P = x.load();
  assert.strictEqual(P.runnerDir(), x.runner);
  assert.strictEqual(P.read('runner/config.js'), '// config');
  assert.ok(P.exists('runner/exec.js') && P.exists('index.html'));
});
t('finds the runner BESIDE the app folder (the hand-over zip layout)', () => {
  const x = tree('beside'), P = x.load();
  assert.strictEqual(P.runnerDir(), x.runner);
  assert.strictEqual(P.read('runner/exec.js'), '// host');
  assert.strictEqual(P.resolve('runner/config.js'), path.join(x.runner, 'config.js'));
});
t('files that are not in the runner are read from the app folder in both layouts', () => {
  for (const layout of ['inside', 'beside']) assert.strictEqual(tree(layout).load().read('index.html'), '<!doctype html>');
});
t('a runner that is nowhere is reported with the places it looked and where it has to be', () => {
  const P = tree('none').load();
  assert.throws(() => P.runnerDir(), (e) => /was not found/.test(e.message) && /inside the app folder/.test(e.message) && /next to the app folder/.test(e.message));
  assert.throws(() => P.read('runner/exec.js'), /was not found/);
  assert.strictEqual(P.exists('runner/exec.js'), false);   // exists() never throws
});
t('a missing hidden file says that iOS hides dot-files, and how to create it', () => {
  const P = tree('inside').load();
  assert.throws(() => P.read('.vercelignore'), (e) => /\.vercelignore is missing from the repository/.test(e.message) && /hidden in the iOS Files app/.test(e.message) && e.code === 'ENOENT');
  assert.throws(() => P.read('.github/dependabot.yml'), /\.github\/dependabot\.yml is missing from the repository/);
});
t('a missing ordinary file keeps the plain error (no hidden-file explanation)', () => {
  const P = tree('inside').load();
  assert.throws(() => P.read('nope.txt'), (e) => e.code === 'ENOENT' && !/iOS/.test(e.message));
});
t('every test reads through this helper (no private copy of the runner lookup is left behind)', () => {
  const dir = __dirname, offenders = [];
  const files = fs.readdirSync(dir).filter((f) => /\.test\.js$/.test(f) && f !== 'paths.test.js').map((f) => path.join(dir, f))
    .concat(fs.readdirSync(path.join(dir, 'e2e')).filter((f) => /\.e2e\.js$/.test(f)).map((f) => path.join(dir, 'e2e', f)));
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    if (/path\.(resolve|join)\([^)]*['"]runner['"]/.test(s) || /'\.\.\/runner/.test(s)) offenders.push(path.relative(dir, f));
  }
  assert.deepStrictEqual(offenders, []);
});
console.log(`\n${n} checks passed`);
