// Local History and hot exit: the pure rules (js/core/file-history.js), run against its in-memory store.
// The real IndexedDB store, the Timeline, recovery after a reload and the editor hooks are covered in a browser by
// tests/e2e/file-history.e2e.js.
const assert = require('assert');
const H = require('../js/core/file-history.js');
const { LIMITS, clampHeight, fnv1a, fileKey, lineDelta, formatSize, relativeTime, canKeep, shouldMerge, planPrune, planSweep, planRecovery, memoryStore, createHistory } = H;
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };
const MIN = 60000, DAY = 86400000;

(async () => {
  console.log('fingerprint and line counts');
  await t('same text gives the same fingerprint, any change gives another, and length counts', () => {
    assert.strictEqual(fnv1a('abc'), fnv1a('abc'));
    assert.notStrictEqual(fnv1a('abc'), fnv1a('abd'));
    assert.notStrictEqual(fnv1a('a'), fnv1a('a\n'));
    assert.strictEqual(fnv1a(''), fnv1a(null));
  });
  await t('lines added and removed are counted, duplicates included', () => {
    assert.deepStrictEqual(lineDelta('a\nb\nc', 'a\nb\nc'), { added: 0, removed: 0 });
    assert.deepStrictEqual(lineDelta('a\nb\nc', 'a\nX\nY\nc'), { added: 2, removed: 1 });
    assert.deepStrictEqual(lineDelta('x\nx', 'x'), { added: 0, removed: 1 });
    assert.deepStrictEqual(lineDelta('x', 'x\nx\nx'), { added: 2, removed: 0 });
    assert.deepStrictEqual(lineDelta('', 'one'), { added: 1, removed: 1 }); // "" is one empty line
  });
  await t('moving a line is not counted (it is a hint, the diff tab is the truth)', () => {
    assert.deepStrictEqual(lineDelta('a\nb\nc', 'c\nb\na'), { added: 0, removed: 0 });
  });
  await t('sizes and relative times read naturally', () => {
    assert.strictEqual(formatSize(812), '812 B'); assert.strictEqual(formatSize(3277), '3.2 KB'); assert.strictEqual(formatSize(2 * 1024 * 1024), '2.0 MB');
    const now = 1e12;
    assert.strictEqual(relativeTime(now - 20000, now), 'Just now');
    assert.strictEqual(relativeTime(now - 5 * MIN, now), '5 min ago');
    assert.strictEqual(relativeTime(now - 3 * 60 * MIN, now), '3 h ago');
    assert.strictEqual(relativeTime(now - 30 * 60 * MIN, now), 'Yesterday');
    assert.strictEqual(relativeTime(now - 4 * DAY, now), '4 days ago');
  });

  console.log('what may be copied');
  await t('a locked file is never kept, and neither are binary files, folders or non-text', () => {
    assert.strictEqual(canKeep({ type: 'file', isLocked: true }, 'secret'), false);
    assert.strictEqual(canKeep({ type: 'file', encoding: 'base64' }, 'AAAA'), false);
    assert.strictEqual(canKeep({ type: 'folder' }, ''), false);
    assert.strictEqual(canKeep(null, 'x'), false);
    assert.strictEqual(canKeep({ type: 'file' }, 123), false);
  });
  await t('plain text up to the size limit is kept, one character over is not', () => {
    assert.strictEqual(canKeep({ type: 'file' }, 'hello'), true);
    assert.strictEqual(canKeep({ type: 'file' }, 'x'.repeat(LIMITS.maxSnapshotChars)), true);
    assert.strictEqual(canKeep({ type: 'file' }, 'x'.repeat(LIMITS.maxSnapshotChars + 1)), false);
    assert.strictEqual(canKeep({ type: 'file' }, 'x'.repeat(LIMITS.maxBackupChars), LIMITS.maxBackupChars), true);
  });

  console.log('resizing the Timeline');
  await t('a Timeline height is kept between the minimum and what leaves the file list its own minimum', () => {
    // body 200 + list 400: the pair is 600 while dragging, and the list must keep 120, so the body can reach 480.
    assert.strictEqual(clampHeight(300, 200, 400, 56, 120), 300);
    assert.strictEqual(clampHeight(480, 200, 400, 56, 120), 480);
    assert.strictEqual(clampHeight(481, 200, 400, 56, 120), 480, 'one pixel more would take the list under 120');
    assert.strictEqual(clampHeight(9999, 200, 400, 56, 120), 480);
    assert.strictEqual(clampHeight(56, 200, 400, 56, 120), 56);
    assert.strictEqual(clampHeight(10, 200, 400, 56, 120), 56, 'never smaller than the minimum');
    assert.strictEqual(clampHeight(-50, 200, 400, 56, 120), 56);
  });
  await t('in a window too small for both minimums the minimum wins, and junk input is the minimum', () => {
    assert.strictEqual(clampHeight(300, 60, 40, 56, 120), 56, 'there is no room to grow: stay at the minimum');
    assert.strictEqual(clampHeight(NaN, 200, 400, 56, 120), 56);
    assert.strictEqual(clampHeight(undefined, 200, 400, 56, 120), 56);
    assert.strictEqual(clampHeight('250', 200, 400, 56, 120), 250, 'a stored string is a number');
    assert.strictEqual(clampHeight(250.6, 200, 400, 56, 120), 251, 'whole pixels');
  });

  console.log('merging, pruning, sweeping');
  await t('two auto saves close together merge; a manual save or a closed tab never does', () => {
    const prev = { kind: 'auto', time: 1000 };
    assert.strictEqual(shouldMerge(prev, 'auto', 1000 + LIMITS.mergeMs, LIMITS.mergeMs), true);
    assert.strictEqual(shouldMerge(prev, 'auto', 1001 + LIMITS.mergeMs, LIMITS.mergeMs), false);
    assert.strictEqual(shouldMerge(prev, 'manual', 1500, LIMITS.mergeMs), false);
    assert.strictEqual(shouldMerge({ kind: 'manual', time: 1000 }, 'auto', 1500, LIMITS.mergeMs), false);
    assert.strictEqual(shouldMerge({ kind: 'closed', time: 1000 }, 'auto', 1500, LIMITS.mergeMs), false);
    assert.strictEqual(shouldMerge(null, 'auto', 1500, LIMITS.mergeMs), false);
  });
  await t('pruning keeps the newest N and drops what is too old', () => {
    const now = 100 * DAY;
    const metas = [1, 2, 3, 4, 5].map((i) => ({ id: 'm' + i, time: now - i * DAY }));
    assert.deepStrictEqual(planPrune(metas, { maxEntries: 3, maxAgeMs: 30 * DAY, now }).sort(), ['m4', 'm5']);
    assert.deepStrictEqual(planPrune(metas, { maxEntries: 50, maxAgeMs: 2.5 * DAY, now }).sort(), ['m3', 'm4', 'm5']);
    assert.deepStrictEqual(planPrune(metas, { maxEntries: 50, maxAgeMs: 30 * DAY, now }), []);
  });
  await t('the global sweep drops old entries, then the oldest ones only until the total fits', () => {
    const now = 100 * DAY;
    const metas = [{ id: 'old', time: now - 20 * DAY, size: 10 }, { id: 'a', time: now - 3 * DAY, size: 40 }, { id: 'b', time: now - 2 * DAY, size: 40 }, { id: 'c', time: now - 1 * DAY, size: 40 }];
    assert.deepStrictEqual(planSweep(metas, { maxAgeMs: 14 * DAY, totalChars: 1000, now }), ['old']);
    assert.deepStrictEqual(planSweep(metas, { maxAgeMs: 14 * DAY, totalChars: 100, now }).sort(), ['a', 'old']);
    assert.deepStrictEqual(planSweep(metas, { maxAgeMs: 14 * DAY, totalChars: 0, now }).sort(), ['a', 'b', 'c', 'old']);
  });

  console.log('hot exit planning');
  const ctx = (over) => Object.assign({ pageId: 'now', alive: new Set(), files: new Map([['f1', { id: 'f1', content: 'saved text' }]]) }, over);
  const entry = (over) => Object.assign({ key: 'db|f1', dbName: 'db', fileId: 'f1', name: 'a.js', content: 'typed text', baseHash: fnv1a('saved text'), pageId: 'dead' }, over);
  await t('unsaved text from a page that is gone is recovered', () => {
    const [p] = planRecovery([entry()], ctx());
    assert.strictEqual(p.action, 'recover'); assert.strictEqual(p.conflict, false);
  });
  await t('what this page wrote itself, or another open window wrote, is left alone', () => {
    assert.strictEqual(planRecovery([entry({ pageId: 'now' })], ctx())[0].action, 'skip');
    assert.strictEqual(planRecovery([entry({ pageId: 'other' })], ctx({ alive: new Set(['other']) }))[0].action, 'skip');
  });
  await t('a backup of a deleted, locked or binary file is dropped, and so is one that matches the saved file', () => {
    assert.strictEqual(planRecovery([entry({ fileId: 'gone' })], ctx())[0].action, 'drop');
    assert.strictEqual(planRecovery([entry()], ctx({ files: new Map([['f1', { id: 'f1', content: 'x', isLocked: true }]]) }))[0].action, 'drop');
    assert.strictEqual(planRecovery([entry()], ctx({ files: new Map([['f1', { id: 'f1', content: 'x', encoding: 'base64' }]]) }))[0].action, 'drop');
    assert.strictEqual(planRecovery([entry({ content: 'saved text' })], ctx())[0].action, 'drop');
  });
  await t('a file that changed after the backup is still recovered, but flagged', () => {
    const files = new Map([['f1', { id: 'f1', content: 'changed by a pull' }]]);
    const [p] = planRecovery([entry()], ctx({ files }));
    assert.strictEqual(p.action, 'recover'); assert.strictEqual(p.conflict, true);
    assert.strictEqual(planRecovery([entry({ baseHash: null })], ctx({ files }))[0].conflict, false, 'no base recorded: nothing to compare');
  });

  console.log('history over a store');
  const mk = (cfg) => { const store = memoryStore(); return { store, h: createHistory(store, () => cfg || {}) }; };
  const rec = (h, content, kind, now, over) => h.record(Object.assign({ dbName: 'db', fileId: 'f1', name: 'a.js', content, kind, now }, over));
  const T0 = 1e12;
  await t('the first save has no change figure, the next one counts its lines', async () => {
    const { h } = mk();
    const a = await rec(h, 'one\ntwo', 'manual', T0);
    assert.strictEqual(a.added, null); assert.strictEqual(a.removed, null);
    const b = await rec(h, 'one\ntwo\nthree', 'manual', T0 + MIN);
    assert.deepStrictEqual([b.added, b.removed], [1, 0]);
    assert.deepStrictEqual((await h.list('db', 'f1')).map((m) => m.id), [b.id, a.id], 'newest first');
    assert.strictEqual(await h.getContent(a.id), 'one\ntwo');
  });
  await t('saving the same text again adds nothing; a deliberate save upgrades the label of an auto save', async () => {
    const { h } = mk();
    await rec(h, 'x', 'auto', T0);
    assert.strictEqual(await rec(h, 'x', 'auto', T0 + MIN), null);
    assert.strictEqual((await h.list('db', 'f1')).length, 1);
    await rec(h, 'x', 'manual', T0 + 2 * MIN);
    const list = await h.list('db', 'f1');
    assert.strictEqual(list.length, 1); assert.strictEqual(list[0].kind, 'manual');
    await rec(h, 'x', 'auto', T0 + 3 * MIN);
    assert.strictEqual((await h.list('db', 'f1'))[0].kind, 'manual', 'a weaker label never replaces a stronger one');
  });
  await t('text that was closed unsaved but then turns out to be saved is labelled as saved', async () => {
    const { h } = mk();
    await rec(h, 'typed', 'closed', T0);
    await rec(h, 'typed', 'auto', T0 + 1000);
    const list = await h.list('db', 'f1');
    assert.strictEqual(list.length, 1); assert.strictEqual(list[0].kind, 'auto');
  });
  await t('auto saves a few seconds apart share one entry (the newer text), 30 seconds apart do not', async () => {
    const { h } = mk();
    await rec(h, 'v1', 'manual', T0);
    await rec(h, 'v1\nv2', 'auto', T0 + 5000);
    const m = await rec(h, 'v1\nv2\nv3', 'auto', T0 + 9000);
    let list = await h.list('db', 'f1');
    assert.strictEqual(list.length, 2, 'the manual one and one merged auto entry');
    assert.strictEqual(await h.getContent(list[0].id), 'v1\nv2\nv3');
    assert.deepStrictEqual([m.added, m.removed], [2, 0], 'counted against the entry before the merged one, not against the one it replaced');
    await rec(h, 'v1\nv2\nv3\nv4', 'auto', T0 + 9000 + 30000);
    list = await h.list('db', 'f1');
    assert.strictEqual(list.length, 3);
  });
  await t('a manual save never merges into an auto entry', async () => {
    const { h } = mk();
    await rec(h, 'a', 'auto', T0); await rec(h, 'b', 'manual', T0 + 1000);
    assert.strictEqual((await h.list('db', 'f1')).length, 2);
  });
  await t('only the newest N versions per file are kept', async () => {
    const { h } = mk({ maxEntries: 3 });
    for (let i = 1; i <= 6; i++) await rec(h, 'v' + i, 'manual', T0 + i * MIN);
    const list = await h.list('db', 'f1');
    assert.strictEqual(list.length, 3);
    assert.deepStrictEqual(await Promise.all(list.map((m) => h.getContent(m.id))), ['v6', 'v5', 'v4']);
  });
  await t('versions older than the age limit are removed on the next save', async () => {
    const { h } = mk({ maxDays: 2 });
    await rec(h, 'old', 'manual', T0);
    await rec(h, 'new', 'manual', T0 + 3 * DAY);
    const list = await h.list('db', 'f1');
    assert.strictEqual(list.length, 1); assert.strictEqual(await h.getContent(list[0].id), 'new');
  });
  await t('with Local History off nothing is stored', async () => {
    const { h } = mk({ enabled: false });
    assert.strictEqual(await rec(h, 'x', 'manual', T0), null);
    assert.strictEqual((await h.list('db', 'f1')).length, 0);
  });
  await t('text over the size limit, or not text, is not stored', async () => {
    const { h } = mk();
    assert.strictEqual(await rec(h, 'x'.repeat(LIMITS.maxSnapshotChars + 1), 'manual', T0), null);
    assert.strictEqual(await rec(h, null, 'manual', T0), null);
    assert.strictEqual(await rec(h, 42, 'manual', T0), null);
    assert.strictEqual((await h.list('db', 'f1')).length, 0);
  });
  await t('the same file id in two databases, and two files in one, keep separate histories', async () => {
    const { h } = mk();
    await rec(h, 'in db one', 'manual', T0, { dbName: 'db1' });
    await rec(h, 'in db two', 'manual', T0, { dbName: 'db2' });
    await rec(h, 'other file', 'manual', T0, { fileId: 'f2' });
    assert.strictEqual((await h.list('db1', 'f1')).length, 1); assert.strictEqual((await h.list('db2', 'f1')).length, 1);
    assert.strictEqual(await h.getContent((await h.list('db2', 'f1'))[0].id), 'in db two');
    assert.strictEqual(fileKey('db1', 'f1') === fileKey('db2', 'f1'), false);
  });
  await t('deleting one entry, or clearing a file, leaves everything else', async () => {
    const { h } = mk();
    const a = await rec(h, 'a', 'manual', T0); await rec(h, 'b', 'manual', T0 + MIN);
    await rec(h, 'z', 'manual', T0, { fileId: 'f2' });
    await h.remove([a.id]);
    assert.strictEqual((await h.list('db', 'f1')).length, 1); assert.strictEqual(await h.getContent(a.id), null, 'its text goes with it');
    await h.clearFile('db', 'f1');
    assert.strictEqual((await h.list('db', 'f1')).length, 0); assert.strictEqual((await h.list('db', 'f2')).length, 1);
  });
  await t('the start-up sweep removes aged entries across files', async () => {
    const { h } = mk({ maxDays: 5 });
    await rec(h, 'old', 'manual', T0); await rec(h, 'old2', 'manual', T0, { fileId: 'f2' });
    await rec(h, 'fresh', 'manual', T0 + 9 * DAY, { fileId: 'f3' });
    assert.strictEqual(await h.sweep(T0 + 9 * DAY), 2);
    assert.strictEqual((await h.list('db', 'f1')).length + (await h.list('db', 'f2')).length, 0);
    assert.strictEqual((await h.list('db', 'f3')).length, 1);
  });
  await t('purging a database removes its history and its hot-exit copies, and no other database', async () => {
    const { store, h } = mk();
    await rec(h, 'a', 'manual', T0, { dbName: 'gone' }); await rec(h, 'b', 'manual', T0, { dbName: 'kept' });
    await store.putBackup({ key: 'gone|f1', dbName: 'gone', fileId: 'f1', content: 'x' });
    await store.putBackup({ key: 'kept|f1', dbName: 'kept', fileId: 'f1', content: 'y' });
    assert.strictEqual(await store.deleteByDb(['gone']), 2);
    assert.strictEqual((await h.list('gone', 'f1')).length, 0); assert.strictEqual((await h.list('kept', 'f1')).length, 1);
    assert.strictEqual((await store.backupsByDb('gone')).length, 0); assert.strictEqual((await store.backupsByDb('kept')).length, 1);
  });

  console.log('wiring (source checks)');
  const fs = require('fs'), path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const count = (src, re) => (src.match(re) || []).length;
  await t('the editor reports opening, typing, saving, closing and switching to Local History', () => {
    const ed = read('js/core/editor.js');
    for (const m of ['noteOpened', 'noteEdit', 'noteSaved', 'tabClosing']) assert.strictEqual(count(ed, new RegExp('CodeMiniHistory\\.' + m + '\\(', 'g')), 1, m);
    assert.strictEqual(count(ed, /CodeMiniHistory\.noteActiveChanged\(/g), 2, 'switchTab and closeTab');
    const teardown = ed.slice(ed.indexOf('function teardownPaneResources'));
    assert(teardown.slice(0, 500).includes('CodeMiniHistory.tabClosing'), 'tabClosing runs first in teardownPaneResources, before the editor is disposed');
  });
  await t('a save is reported only from the unlocked write, never from the locked-file branch', () => {
    const ed = read('js/core/editor.js');
    const put = ed.indexOf('store.put(file).onsuccess'), locked = ed.indexOf('CodeMiniLock.setContent'), hook = ed.indexOf('CodeMiniHistory.noteSaved(');
    assert(put > 0 && locked > 0 && locked < put, 'the locked branch comes before the normal write');
    assert(hook > put, 'noteSaved is inside the normal write');
  });
  await t('Ctrl+S marks its save as deliberate, and the Explorer, tab menu, Quick Open and notifications reach the feature', () => {
    assert(/CodeMiniHistory\.markManual\(activeTab\.dataset\.fileId\)/.test(read('js/core/script.js')));
    assert(/CodeMiniHistory\.explorerOptions\(file\)/.test(read('js/core/app.js')));
    assert(/Local History\.\.\./.test(read('js/core/diff-editor.js')));
    assert(/Show Local History for Active File/.test(read('js/core/quick-open.js')));
    assert(/'review-recovered'/.test(read('js/core/now-island.js')));
  });
  await t('the Timeline handle uses the app\'s own makeResizable and a per-window saved height', () => {
    const fh = read('js/core/file-history.js');
    assert(/W\.makeResizable\(resizerEl, \{/.test(fh), 'one handle helper for the whole app: mouse and touch');
    assert(/'codemini_timeline_height_' \+ winKey\(\)/.test(fh), 'saved per window, like codemini_sidebar_width_ and codemini_bottom_panel_height_');
    assert(/role', 'separator'/.test(fh) && /aria-orientation', 'horizontal'/.test(fh), 'keyboard and screen-reader users get a separator too');
    const css = read('css/style.css');
    assert(/\.tl-resizer \{[^}]*height: 6px;[^}]*cursor: ns-resize;/.test(css), 'the same 6px ns-resize strip as .panel-resizer-horizontal');
    assert(/\.tl-body\.tl-sized \{[^}]*box-sizing: border-box;/.test(css), 'border-box, or each repaint would add the padding again');
  });
  await t('recovery runs after saved tabs are restored', () => {
    const app = read('js/core/app.js');
    assert(app.indexOf('CodeMiniHistory.recoverFor(db.name)') > app.indexOf("window.openedTabs.length === 0"), 'after the session restore block');
  });
  await t('every place that deletes a database also purges its history (a new one must too)', () => {
    for (const [f, deletes, purges] of [['js/core/app.js', 2, 2], ['js/core/script.js', 1, 1]]) {
      const src = read(f);
      assert.strictEqual(count(src, /indexedDB\.deleteDatabase\(/g), deletes, f + ': a database delete was added or removed. If it holds files, call CodeMiniHistory.purgeDatabases([name]) beside it, then update this count');
      assert.strictEqual(count(src, /purgeDatabases\(/g), purges, f);
    }
    const sp = read('js/core/settings-profile.js');
    assert(sp.indexOf('purgeDatabases([...workspaceDbs, dbName])') > 0 && sp.indexOf('purgeDatabases([...workspaceDbs, dbName])') < sp.indexOf('[...workspaceDbs, dbName].map(deleteDbAndWait)'), 'Factory Reset purges before it deletes');
  });
  await t('the script is loaded and precached, and the settings have explicit values', () => {
    assert(/<script src="js\/core\/file-history\.js"><\/script>/.test(read('index.html')));
    assert(/'\/js\/core\/file-history\.js'/.test(read('sw.js')));
    const sp = read('js/core/settings-profile.js');
    assert(/pickOption\('hotExit', \['On', 'Off'\], 'On'\)/.test(sp) && /pickOption\('localHistory', \['On', 'Off'\], 'On'\)/.test(sp));
    assert(/<select data-setting="hotExit"><option value="On">On<\/option><option value="Off">Off<\/option>/.test(sp));
    assert(/window\.CodeMiniHistory\.onSettingChanged\(key\)/.test(sp));
  });

  console.log(`\n${n} file-history checks passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
