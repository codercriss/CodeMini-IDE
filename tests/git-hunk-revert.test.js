// Source Control: reverting one hunk (js/git/git.js), run against the real code cut out of git.js, a fake file store and a
// fake editor tab (no browser). What matters: the right parts of the diff go back, a file that changed since the diff was
// loaded is refused (line numbers mean nothing against other text), unsaved edits are never overwritten, and only the
// working-tree diff offers Revert at all.
const vm = require('vm'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'js/git/git.js'), 'utf8');
const CodeMiniDiff = require('../js/core/diff-editor.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };
const grab = (from, to) => { const i = src.indexOf(from); const j = src.indexOf(to, i + from.length); assert(i >= 0 && j > i, `cannot find ${from}`); return src.slice(i, j); };

(async () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'git-hunk-')), 'diff.mjs');
  fs.copyFileSync(path.join(__dirname, '..', 'js/vendor/diff-9.0.0.js'), tmp);
  const { diffLines } = await import(require('url').pathToFileURL(tmp).href);

  // ---- the code under test ---------------------------------------------------------------------------------------
  const code = [
    grab('function gitEsc(', 'function gitRelativeTime('),
    grab('function gitBuildHunks(', 'async function gitRenderDiffHtml('),
    grab('// --- Revert one change', 'async function gitLoadChangeDiff('),
  ].join('\n');

  // ---- fakes -----------------------------------------------------------------------------------------------------
  function world({ files = {}, tabs = [], pendingMerge = null, saves = true } = {}) {
    const calls = { saved: [], panel: 0, logs: [], explorer: 0 };
    let clock = 0;
    const database = { name: 'ws1', transaction: () => ({ objectStore: () => ({ get: (id) => { const rq = {}; setTimeout(() => { rq.result = files[id]; if (rq.onsuccess) rq.onsuccess(); }, 0); return rq; } }) }) };
    const ctx = {
      window: { CodeMiniDiff, autoSaveFile: (id, text, tab, enc, dbName) => { calls.saved.push({ id, text, tab, enc, dbName }); if (saves) setTimeout(() => { files[id].content = text; }, 5); }, renderGitPanel: () => { calls.panel++; } },
      document: { querySelectorAll: () => tabs },
      gitGetPendingMerge: () => pendingMerge, gitGetPendingRebase: () => null,
      gitLog: (a, m) => { calls.logs.push([a, m]); }, loadFilesFromDB: () => { calls.explorer++; },
      setTimeout, console,
      Date: { now: () => (clock += 400) }, // time runs fast, so "never saved" gives up at once
    };
    vm.createContext(ctx); vm.runInContext(code, ctx);
    return { ctx, calls, files, database };
  }
  const fileOf = (content, extra) => Object.assign({ id: 'f1', type: 'file', name: 'a.txt', content }, extra);
  const fakeTab = (text) => {
    const ed = { text, edits: [], getValue: () => ed.text, getModel: () => ({ getFullModelRange: () => 'ALL' }), pushUndoStop() {}, executeEdits(src_, e) { ed.edits.push(e[0]); ed.text = e[0].text; } };
    return { dataset: { type: 'monaco', fileId: 'f1', dbName: 'ws1' }, _cmEditor: ed };
  };

  console.log('hunks know which parts they change');
  const A = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen'].join('\n') + '\n';
  const B = A.replace('two\n', 'TWO\n').replace('thirteen\n', 'THIRTEEN\nextra\n'); // two changes far apart: two hunks
  const parts = diffLines(A, B);
  await t('each hunk lists its own changed parts, never a context part', async () => {
    const w = world(); const { hunks } = w.ctx.gitBuildHunks(parts, 3);
    assert.strictEqual(hunks.length, 2);
    for (const h of hunks) {
      assert.ok(h.changedParts.length >= 1);
      for (const pi of h.changedParts) assert.ok(parts[pi].added || parts[pi].removed, 'a context part is not a change');
    }
    assert.strictEqual(new Set([...hunks[0].changedParts, ...hunks[1].changedParts]).size, hunks[0].changedParts.length + hunks[1].changedParts.length, 'a part belongs to one hunk');
  });
  await t('reverting hunk 1 puts only that hunk back and keeps the other change', async () => {
    const w = world(); const { hunks } = w.ctx.gitBuildHunks(parts, 3);
    assert.strictEqual(CodeMiniDiff.revertParts(parts, hunks[0].changedParts), B.replace('TWO\n', 'two\n'));
    assert.strictEqual(CodeMiniDiff.revertParts(parts, hunks[1].changedParts), B.replace('THIRTEEN\nextra\n', 'thirteen\n'));
    assert.strictEqual(CodeMiniDiff.revertParts(parts, hunks.flatMap((h) => h.changedParts)), A);
  });
  await t('two changes close together share a hunk, and one Revert puts both back', async () => {
    const w = world(); const C = A.replace('two\n', 'TWO\n').replace('five\n', 'FIVE\n');
    const p2 = diffLines(A, C); const { hunks } = w.ctx.gitBuildHunks(p2, 3);
    assert.strictEqual(hunks.length, 1); assert.strictEqual(hunks[0].changedParts.length, 4);
    assert.strictEqual(CodeMiniDiff.revertParts(p2, hunks[0].changedParts), A);
  });

  console.log('the hunk header');
  await t('without Revert it is exactly what it was', () => {
    const w = world(); const h = { oldStart: 3, oldLines: 7, newStart: 3, newLines: 8 };
    assert.strictEqual(w.ctx.gitDiffHunkHeaderHtml(h, 0, false), '<div class="git-diff-hunk-header">@@ -3,7 +3,8 @@</div>');
    assert.strictEqual(w.ctx.gitDiffHunkHeaderHtml(h, 0, undefined), '<div class="git-diff-hunk-header">@@ -3,7 +3,8 @@</div>');
  });
  await t('with Revert it adds one labelled button that names its hunk', () => {
    const w = world(); const h = { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 };
    const html = w.ctx.gitDiffHunkHeaderHtml(h, 4, true);
    assert.ok(html.includes('data-git-diff-action="revert-hunk"') && html.includes('data-hunk="4"') && html.includes('aria-label="Revert this hunk"'));
    assert.strictEqual((html.match(/<button/g) || []).length, 1);
  });
  await t('both layouts draw the button on every hunk, and only when asked', () => {
    const w = world(); const count = (html) => (html.match(/data-git-diff-action="revert-hunk"/g) || []).length;
    assert.strictEqual(count(w.ctx.gitRenderUnifiedHtml(parts, 3, true)), 2);
    assert.strictEqual(count(w.ctx.gitRenderSideBySideHtml(parts, 3, true)), 2);
    assert.strictEqual(count(w.ctx.gitRenderUnifiedHtml(parts, 3, false)), 0);
    assert.strictEqual(count(w.ctx.gitRenderSideBySideHtml(parts, 3)), 0);
  });

  console.log('writing the revert back');
  await t('a closed file is saved through autoSaveFile, once, and the panel and Explorer refresh', async () => {
    const w = world({ files: { f1: fileOf('hello\nworld\n') } });
    const r = await w.ctx.gitRevertWorkingText(w.database, '/a.txt', 'f1', { base: 'hello\nworld\n', newText: 'hello\n' });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: true });
    assert.strictEqual(w.calls.saved.length, 1);
    const s = w.calls.saved[0]; assert.deepStrictEqual([s.id, s.text, s.tab, s.enc, s.dbName], ['f1', 'hello\n', null, undefined, 'ws1']);
    assert.strictEqual(w.files.f1.content, 'hello\n'); assert.strictEqual(w.calls.panel, 1); assert.strictEqual(w.calls.explorer, 1);
    assert.strictEqual(w.calls.logs.length, 1);
  });
  await t('a file that changed since the diff was loaded is refused and nothing is written', async () => {
    const w = world({ files: { f1: fileOf('hello\nCHANGED\n') } });
    const r = await w.ctx.gitRevertWorkingText(w.database, '/a.txt', 'f1', { base: 'hello\nworld\n', newText: 'hello\n' });
    assert.strictEqual(r.ok, false); assert.ok(/changed since/.test(r.message));
    assert.strictEqual(w.calls.saved.length, 0); assert.strictEqual(w.files.f1.content, 'hello\nCHANGED\n');
  });
  await t('a deleted file, a locked file and a conflicted path are refused', async () => {
    let w = world({ files: {} });
    assert.ok(/no longer exists/.test((await w.ctx.gitRevertWorkingText(w.database, '/a.txt', 'f1', { base: 'x', newText: 'y' })).message));
    w = world({ files: { f1: fileOf('x', { isLocked: true }) } });
    assert.ok(/locked/.test((await w.ctx.gitRevertWorkingText(w.database, '/a.txt', 'f1', { base: 'x', newText: 'y' })).message));
    w = world({ files: { f1: fileOf('x') }, pendingMerge: { conflictPaths: ['/a.txt'] } });
    assert.ok(/conflict/.test((await w.ctx.gitRevertWorkingText(w.database, '/a.txt', 'f1', { base: 'x', newText: 'y' })).message));
    assert.strictEqual(w.calls.saved.length, 0);
  });
  await t('a file open in a tab with unsaved edits is refused: the edits are not overwritten', async () => {
    const tab = fakeTab('hello\nworld\nTYPED BUT NOT SAVED\n');
    const w = world({ files: { f1: fileOf('hello\nworld\n') }, tabs: [tab] });
    const r = await w.ctx.gitRevertWorkingText(w.database, '/a.txt', 'f1', { base: 'hello\nworld\n', newText: 'hello\n' });
    assert.strictEqual(r.ok, false); assert.ok(/unsaved edits/.test(r.message));
    assert.strictEqual(tab._cmEditor.edits.length, 0); assert.strictEqual(w.calls.saved.length, 0);
  });
  await t('a file open in a clean tab is changed through the editor (undoable) and saved with that tab', async () => {
    const tab = fakeTab('hello\nworld\n');
    const w = world({ files: { f1: fileOf('hello\nworld\n') }, tabs: [tab] });
    const r = await w.ctx.gitRevertWorkingText(w.database, '/a.txt', 'f1', { base: 'hello\nworld\n', newText: 'hello\n' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(tab._cmEditor.edits.length, 1); assert.strictEqual(tab._cmEditor.edits[0].text, 'hello\n');
    assert.strictEqual(w.calls.saved[0].tab, tab);
  });
  await t('a tab for another file, or another workspace, is not touched', async () => {
    const other = fakeTab('whatever'); other.dataset.fileId = 'f2';
    const elsewhere = fakeTab('hello\nworld\nUNSAVED'); elsewhere.dataset.dbName = 'ws2';
    const w = world({ files: { f1: fileOf('hello\nworld\n') }, tabs: [other, elsewhere] });
    const r = await w.ctx.gitRevertWorkingText(w.database, '/a.txt', 'f1', { base: 'hello\nworld\n', newText: 'hello\n' });
    assert.strictEqual(r.ok, true); assert.strictEqual(other._cmEditor.edits.length + elsewhere._cmEditor.edits.length, 0);
    assert.strictEqual(w.calls.saved[0].tab, null);
  });
  await t('CRLF text is compared as the same text the editor shows, so a clean CRLF tab is not mistaken for unsaved edits', async () => {
    const tab = fakeTab('a\nb\n'); // Monaco hands back its own line endings
    const w = world({ files: { f1: fileOf('a\r\nb\r\n') }, tabs: [tab] });
    const r = await w.ctx.gitRevertWorkingText(w.database, '/a.txt', 'f1', { base: 'a\r\nb\r\n', newText: 'a\r\n' });
    assert.strictEqual(r.ok, true);
  });
  await t('if the save never lands it says so instead of claiming success', async () => {
    const w = world({ files: { f1: fileOf('x\n') }, saves: false });
    const r = await w.ctx.gitRevertWorkingText(w.database, '/a.txt', 'f1', { base: 'x\n', newText: 'y\n' });
    assert.strictEqual(r.ok, false); assert.ok(/could not be saved/.test(r.message)); assert.strictEqual(w.calls.panel, 0);
  });
  await t('missing or non-text input is refused', async () => {
    const w = world({ files: { f1: fileOf('x') } });
    assert.strictEqual((await w.ctx.gitRevertWorkingText(w.database, '/a.txt', 'f1', { base: 'x' })).ok, false);
    assert.strictEqual((await w.ctx.gitRevertWorkingText(w.database, '/a.txt', 'f1', { newText: 'y' })).ok, false);
    assert.strictEqual(w.calls.saved.length, 0);
  });

  console.log('who offers Revert');
  const block = (from, to) => grab(from, to);
  await t('only the working-tree diff passes revert: not commit diffs, not conflict diffs', () => {
    assert.ok(/revert: canRevert \?/.test(block('async function gitOpenChangeDiff(', '// Shows "mine"')));
    assert.ok(!/revert/.test(block('async function gitOpenConflictDiff(', 'function gitOpenCommitFileDiff(')));
    assert.ok(!/revert/.test(block('function gitOpenCommitFileDiff(', '// --- Staging & committing')));
  });
  await t('and only for a file that is in HEAD, in the working tree, and not binary', () => {
    const body = block('async function gitOpenChangeDiff(', '// Shows "mine"');
    assert.ok(/d\.fileId && d\.inHead && d\.encoding !== 'base64'/.test(body));
  });
  await t('the popup and the tab both hand the revert function on', () => {
    assert.ok(/canRevert = !!\(meta && typeof meta\.revert === 'function' && meta\.load/.test(src));
    assert.ok(/load: meta\.load, revert: meta\.revert/.test(src));
  });
  console.log(`\n${n} git-hunk-revert checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
