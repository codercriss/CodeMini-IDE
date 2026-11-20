// The Source Control diff popup must work offline: jsdiff is vendored (js/vendor/diff-9.0.0.js) and precached,
// and git.js must load it from there, not from a CDN. These checks keep those four facts in step.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };
const VENDORED = '/js/vendor/diff-9.0.0.js';

(async () => {
  console.log('vendored library');
  // Node reads a .js file as CommonJS unless told otherwise (the browser does not care), so load a .mjs copy.
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'diff-vendor-')), 'diff.mjs');
  fs.copyFileSync(path.join(root, VENDORED), tmp);
  const mod = await import(require('url').pathToFileURL(tmp).href);
  t('exports the functions the app uses and behaves like diffLines', () => {
    assert.strictEqual(typeof mod.diffLines, 'function');
    const parts = mod.diffLines('a\nb\nc\n', 'a\nB\nc\nd\n');
    assert.deepStrictEqual(parts.map((p) => [!!p.added, !!p.removed, p.value]), [
      [false, false, 'a\n'], [false, true, 'b\n'], [true, false, 'B\n'], [false, false, 'c\n'], [true, false, 'd\n'],
    ]);
  });
  t('keeps its license beside it and in the notices', () => {
    assert.ok(/BSD 3-Clause License/.test(read('js/vendor/diff-LICENSE.txt')));
    assert.ok(/diff-LICENSE\.txt/.test(read(VENDORED.slice(1))), 'the file header must point at the license');
    assert.ok(/vendored/.test(read('THIRD_PARTY_NOTICES.md')));
  });

  console.log('wiring');
  const git = read('js/git/git.js');
  t('git.js loads the diff engine from the vendored file, not a CDN', () => {
    assert.ok(git.includes(`'${VENDORED}'`), 'git.js does not point at the vendored file');
    assert.ok(!/import\(\s*['"`]https?:[^)]*diff/.test(git), 'git.js still imports diff from a CDN');
  });
  t('the service worker precaches it, so it is there offline', () => {
    assert.ok(read('sw.js').includes(`'${VENDORED}'`));
  });
  console.log(`\n${n} diff-vendor checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
