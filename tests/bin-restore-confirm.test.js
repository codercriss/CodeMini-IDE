// Stacks > Recycle Bin: restoring (one item, or Restore All) asks first, and nothing leaves the bin until the person confirms.
// Run against the real functions in js/git/stacks.js with a fake dialog - no browser.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'js/git/stacks.js'), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

const i = src.indexOf('window.confirmBinRestore = function'), j = src.indexOf('window.deleteBinItem = function');
assert(i > -1 && j > i, 'cannot find the restore code in stacks.js');
const code = src.slice(i, j);

// A fresh page: a dialog that records what it was asked and lets the test press Confirm or Cancel.
function page(bin, opts = {}) {
  const win = { recycleBin: bin, dialogs: [], restored: [], rendered: 0, reported: [] };
  if (!opts.noDialog) win.showCustomModal = (o, cb) => win.dialogs.push({ o, confirm: cb });
  win.restoreItemsToDB = (items, db, done) => { win.restored.push(items.slice()); done(items.slice(), []); };
  win.renderStacks = () => { win.rendered++; };
  win.reportBinRestoreFailures = (f) => win.reported.push(f);
  const ctx = vm.createContext({ window: win, db: { name: 'root' }, confirm: (m) => { win.confirmAsked = m; return !!opts.confirmAnswer; } });
  vm.runInContext(code, ctx);
  return win;
}
// Arrays made inside the vm context have another prototype, which deepStrictEqual rejects: compare plain host arrays of ids.
const ids = (a) => Array.from(a, (x) => x.id);
const file = (id, name, parentId = 'root', type = 'file') => ({ id, name, parentId, type });

console.log('Restore All');
t('opens a confirmation first and restores nothing yet', () => {
  const w = page([file('a', 'a.txt'), file('b', 'b.txt')]);
  w.restoreAllBin();
  assert.strictEqual(w.dialogs.length, 1);
  assert.strictEqual(w.dialogs[0].o.title, 'Restore All Items');
  assert.strictEqual(w.dialogs[0].o.submitText, 'Restore All');
  assert.strictEqual(w.restored.length, 0, 'restored before the person confirmed');
  assert.strictEqual(w.recycleBin.length, 2);
});
t('says how many items: plural, and the singular form', () => {
  assert.strictEqual(page([file('a', 'a'), file('b', 'b'), file('c', 'c')]).binRestoreAllText(3), 'Restore all 3 items in the Recycle Bin to where they were deleted from?');
  assert.strictEqual(page([]).binRestoreAllText(1), 'Restore the 1 item in the Recycle Bin to where it was deleted from?');
});
t('Cancel (the callback never runs) leaves the bin exactly as it was', () => {
  const w = page([file('a', 'a.txt')]);
  w.restoreAllBin();
  assert.strictEqual(w.restored.length, 0); assert.strictEqual(w.recycleBin.length, 1); assert.strictEqual(w.rendered, 0);
});
t('Confirm restores every item and the bin empties', () => {
  const w = page([file('a', 'a.txt'), file('b', 'b.txt')]);
  w.restoreAllBin(); w.dialogs[0].confirm();
  assert.strictEqual(w.restored.length, 1); assert.deepStrictEqual(ids(w.restored[0]), ['a', 'b']);
  assert.strictEqual(w.recycleBin.length, 0); assert.ok(w.rendered >= 1);
});
t('an empty bin asks nothing', () => { const w = page([]); w.restoreAllBin(); assert.strictEqual(w.dialogs.length, 0); });
t('the question counts the bin as it is when the dialog opens, the restore uses it as it is when confirmed', () => {
  const w = page([file('a', 'a.txt'), file('b', 'b.txt')]);
  w.restoreAllBin(); w.recycleBin.pop(); w.dialogs[0].confirm();
  assert.deepStrictEqual(ids(w.restored[0]), ['a']);
});

console.log('Restore one item');
t('opens a confirmation naming the item and restores nothing yet', () => {
  const w = page([file('a', 'notes.txt'), file('b', 'other.txt')]);
  w.restoreBinItem(1);
  assert.strictEqual(w.dialogs.length, 1);
  assert.strictEqual(w.dialogs[0].o.title, 'Restore Item');
  assert.strictEqual(w.dialogs[0].o.text, 'Restore "other.txt" to where it was deleted from?');
  assert.strictEqual(w.restored.length, 0); assert.strictEqual(w.recycleBin.length, 2);
});
t('Confirm restores that item only', () => {
  const w = page([file('a', 'notes.txt'), file('b', 'other.txt')]);
  w.restoreBinItem(1); w.dialogs[0].confirm();
  assert.deepStrictEqual(ids(w.restored[0]), ['b']);
  assert.deepStrictEqual(ids(w.recycleBin), ['a']);
});
t('a folder says its contents come back too, and they do', () => {
  const w = page([file('f', 'src', 'root', 'folder'), file('x', 'x.js', 'f'), file('y', 'y.js', 'f'), file('z', 'z.txt')]);
  w.restoreBinItem(0);
  assert.ok(/The 2 items inside it in the bin will be restored too\./.test(w.dialogs[0].o.text), w.dialogs[0].o.text);
  w.dialogs[0].confirm();
  assert.deepStrictEqual(ids(w.restored[0]).sort(), ['f', 'x', 'y']);
  assert.deepStrictEqual(ids(w.recycleBin), ['z']);
});
t('a single item inside a folder still in the bin says the folder comes back with it', () => {
  const w = page([file('f', 'src', 'root', 'folder'), file('x', 'x.js', 'f')]);
  w.restoreBinItem(1);
  assert.ok(/Its folder "src" is also in the bin and will be restored with it\./.test(w.dialogs[0].o.text), w.dialogs[0].o.text);
  w.dialogs[0].confirm();
  assert.deepStrictEqual(ids(w.restored[0]).sort(), ['f', 'x']);
});
t('several trashed parent folders are counted', () => {
  const w = page([file('a', 'a', 'root', 'folder'), file('b', 'b', 'a', 'folder'), file('c', 'c.txt', 'b')]);
  w.restoreBinItem(2);
  assert.ok(/Its 2 parent folders are also in the bin/.test(w.dialogs[0].o.text), w.dialogs[0].o.text);
});
t('an item that left the bin while the dialog was open is not restored (no stale index)', () => {
  const w = page([file('a', 'a.txt'), file('b', 'b.txt')]);
  w.restoreBinItem(1); w.recycleBin.splice(1, 1); w.dialogs[0].confirm();
  assert.strictEqual(w.restored.length, 0);
});
t('a stale index from before the bin changed still restores the item that was asked about', () => {
  const w = page([file('a', 'a.txt'), file('b', 'b.txt')]);
  w.restoreBinItem(1); w.recycleBin.splice(0, 1); w.dialogs[0].confirm();
  assert.deepStrictEqual(ids(w.restored[0]), ['b']);
});
t('a bad index asks nothing', () => { const w = page([file('a', 'a.txt')]); w.restoreBinItem(5); assert.strictEqual(w.dialogs.length, 0); });
t('hostile names go into the dialog as plain text (the dialog uses textContent), never as markup built here', () => {
  const w = page([file('a', '<img src=x onerror=alert(1)>.txt')]);
  w.restoreBinItem(0);
  assert.strictEqual(w.dialogs[0].o.text, 'Restore "<img src=x onerror=alert(1)>.txt" to where it was deleted from?');
  assert.ok(!('html' in w.dialogs[0].o));
});

console.log('without the dialog (confirm() fallback)');
t('declining restores nothing, accepting restores', () => {
  const no = page([file('a', 'a.txt')], { noDialog: true, confirmAnswer: false });
  no.restoreAllBin(); no.restoreBinItem(0);
  assert.strictEqual(no.restored.length, 0); assert.ok(no.confirmAsked);
  const yes = page([file('a', 'a.txt')], { noDialog: true, confirmAnswer: true });
  yes.restoreBinItem(0);
  assert.strictEqual(yes.restored.length, 1);
});

console.log('wiring');
t('the bin\'s buttons call the asking functions, not the ones that restore at once', () => {
  assert.ok(/onclick="window\.restoreBinItem\(\$\{idx\}, event\)"/.test(src));
  assert.ok(/onclick="event\.stopPropagation\(\); window\.restoreAllBin\(\);"/.test(src));
  assert.ok(!/onclick="[^"]*doRestore/.test(src), 'a button calls doRestore* directly, which skips the confirmation');
});
console.log(`\n${n} bin-restore-confirm checks passed`);
