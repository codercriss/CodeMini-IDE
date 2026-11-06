// The diff editor's pure helpers (js/core/diff-editor.js). The tab itself, with a real Monaco diff editor, is covered in
// a browser by tests/e2e/diff-editor.e2e.js.
const assert = require('assert');
const { changeTargets, nextIndex, counterLabel, languageForName, labelFor, describeSides } = require('../js/core/diff-editor.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

console.log('where each change is');
t('a change goes to its first line in the modified side', () => {
  assert.deepStrictEqual(changeTargets([{ modifiedStartLineNumber: 5, modifiedEndLineNumber: 7 }, { modifiedStartLineNumber: 12, modifiedEndLineNumber: 12 }]), [{ line: 5 }, { line: 12 }]);
});
t('a change that only deletes lines (end 0) goes to the line it happened after, never to line 0', () => {
  assert.deepStrictEqual(changeTargets([{ modifiedStartLineNumber: 4, modifiedEndLineNumber: 0 }]), [{ line: 4 }]);
  assert.deepStrictEqual(changeTargets([{ modifiedStartLineNumber: 0, modifiedEndLineNumber: 0 }]), [{ line: 1 }]);
});
t('no changes (or none computed yet) is an empty list', () => {
  assert.deepStrictEqual(changeTargets([]), []); assert.deepStrictEqual(changeTargets(null), []); assert.deepStrictEqual(changeTargets(undefined), []);
});

console.log('stepping through changes');
t('next from nothing goes to the first, previous from nothing to the last', () => {
  assert.strictEqual(nextIndex(-1, 5, 1), 0); assert.strictEqual(nextIndex(-1, 5, -1), 4);
});
t('it wraps at both ends', () => {
  assert.strictEqual(nextIndex(4, 5, 1), 0); assert.strictEqual(nextIndex(0, 5, -1), 4);
  assert.strictEqual(nextIndex(2, 5, 1), 3); assert.strictEqual(nextIndex(2, 5, -1), 1);
});
t('with one change it stays on it, and with none it stays at -1', () => {
  assert.strictEqual(nextIndex(0, 1, 1), 0); assert.strictEqual(nextIndex(0, 1, -1), 0);
  assert.strictEqual(nextIndex(-1, 0, 1), -1); assert.strictEqual(nextIndex(3, 0, -1), -1);
});
t('an index that is stale (the list got shorter after a refresh) starts over instead of failing', () => {
  assert.strictEqual(nextIndex(9, 3, 1), 0); assert.strictEqual(nextIndex(9, 3, -1), 2);
});

console.log('the counter');
t('before stepping it says how many; while stepping, which one', () => {
  assert.strictEqual(counterLabel(-1, 12), '12 changes'); assert.strictEqual(counterLabel(-1, 1), '1 change');
  assert.strictEqual(counterLabel(2, 12), '3 of 12'); assert.strictEqual(counterLabel(0, 1), '1 of 1');
  assert.strictEqual(counterLabel(-1, 0), 'No changes'); assert.strictEqual(counterLabel(3, 0), 'No changes');
});

console.log('naming things');
const LANGS = [{ id: 'javascript', extensions: ['.js', '.mjs'] }, { id: 'python', extensions: ['.py'] }, { id: 'dockerfile', extensions: ['.dockerfile'], filenames: ['Dockerfile'] }, { id: 'markdown', extensions: ['.md'] }];
t('the language comes from the file extension, using the languages Monaco lists', () => {
  assert.strictEqual(languageForName('app.js', LANGS), 'javascript'); assert.strictEqual(languageForName('tool.PY', LANGS), 'python');
  assert.strictEqual(languageForName('a.b.c.md', LANGS), 'markdown');
});
t('whole file names count too, and an unknown type is plain text', () => {
  assert.strictEqual(languageForName('Dockerfile', LANGS), 'dockerfile');
  assert.strictEqual(languageForName('data.xyz', LANGS), 'plaintext'); assert.strictEqual(languageForName('README', LANGS), 'plaintext');
  assert.strictEqual(languageForName('x.js', []), 'plaintext'); assert.strictEqual(languageForName(undefined, LANGS), 'plaintext');
});
t('a label shows the folder when there is one', () => {
  assert.strictEqual(labelFor('app.js', 'src'), 'src/app.js'); assert.strictEqual(labelFor('app.js', ''), 'app.js'); assert.strictEqual(labelFor('app.js'), 'app.js');
});
t('tab titles for each kind of comparison', () => {
  assert.deepStrictEqual(describeSides('saved', 'app.js'), { title: 'app.js (Saved \u2194 Editor)', left: 'Saved', right: 'Editor' });
  assert.strictEqual(describeSides('compare', 'x', 'a.js', 'b.js').title, 'a.js \u2194 b.js');
  assert.strictEqual(describeSides('git', 'app.js', 'HEAD', 'Working tree').title, 'app.js (HEAD \u2194 Working tree)');
});

console.log(`\n${n} diff-editor checks passed`);
