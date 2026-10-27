// How the app respects workspaces (each has its own isolated IndexedDB), run against fakes - no browser.
// Reported: "create a document in a created workspace and type in it - it refuses to save". The cause: a file's
// id only exists in ONE database, and the save looked it up in the wrong one (the window's outer database) and
// silently did nothing. These tests cover that and the other places that had the same mix-up.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const editorSrc = read('js/core/editor.js'), appSrc = read('js/core/app.js'), stacksSrc = read('js/git/stacks.js');
const docsSrc = read('js/viewers/docs.js'), searchSrc = read('js/core/search.js'), scriptSrc = read('js/core/script.js');
const termWinSrc = read('js/terminal/terminal-window.js'), termCmdSrc = read('js/terminal/terminal-commands.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };
const slice = (src, from, to) => { const i = src.indexOf(from); const j = src.indexOf(to, i + 1); assert(i >= 0 && j > i, `cannot find ${from}`); return src.slice(i, j); };
const plain = (x) => JSON.parse(JSON.stringify(x));
const tick = () => new Promise((r) => setImmediate(r));

// ---- a tiny fake IndexedDB: a registry of databases, each with a 'filesystem' store ----------------------------
function makeIdb(initial = {}) {
  const dbs = {}; Object.entries(initial).forEach(([name, recs]) => { dbs[name] = { version: 4, records: Object.assign({}, recs) }; });
  const handle = (name) => ({
    name, closed: false, close() { this.closed = true; },
    objectStoreNames: { contains: () => true },
    transaction() {
      const staged = []; const tx = { oncomplete: null, onerror: null, onabort: null };
      tx.objectStore = () => ({
        getAll() { const req = {}; setImmediate(() => { req.result = Object.values(dbs[name].records); req.onsuccess && req.onsuccess({ target: req }); setImmediate(() => { if (indexedDB.failing.has(name)) { tx.onabort && tx.onabort(); return; } staged.forEach((r) => { dbs[name].records[r.id] = r; }); tx.oncomplete && tx.oncomplete(); }); }); return req; },
        get(id) { const req = {}; setImmediate(() => { req.result = dbs[name].records[id]; req.onsuccess && req.onsuccess({ target: req }); setImmediate(() => { staged.forEach((r) => { dbs[name].records[r.id] = r; }); tx.oncomplete && tx.oncomplete(); }); }); return req; },
        put(rec) { staged.push(JSON.parse(JSON.stringify(rec))); const req = {}; setImmediate(() => req.onsuccess && req.onsuccess({ target: req })); return req; }
      });
      return tx;
    }
  });
  const created = [], failing = new Set();
  const indexedDB = {
    created, dbs, failing,
    open(name, version) {
      const req = {};
      setImmediate(() => {
        if (!dbs[name]) {
          // A missing database: the upgrade that would create it runs with oldVersion 0. If the page aborts it, no database results.
          let aborted = false;
          const txn = { abort() { aborted = true; } };
          req.result = handle(name);
          req.onupgradeneeded && req.onupgradeneeded({ oldVersion: 0, target: { result: req.result, transaction: txn } });
          if (aborted) { req.error = new Error('AbortError'); req.onerror && req.onerror({ preventDefault() {} }); return; }
          dbs[name] = { version, records: {} }; created.push(name);
        } else if (dbs[name].version < version) {
          req.result = handle(name); req.onupgradeneeded && req.onupgradeneeded({ oldVersion: dbs[name].version, target: { result: req.result, transaction: {} } }); dbs[name].version = version;
        }
        req.result = handle(name); req.onsuccess && req.onsuccess({ target: req });
      });
      return req;
    }
  };
  indexedDB.handle = handle;
  return indexedDB;
}

const editorCode = slice(editorSrc, 'window.resolveSaveDbName = function', 'window.autoSaveFile = function(');
const tabCode = slice(editorSrc, 'window.tabsBoundToDatabase = function', 'window.saveAllUnsavedTabs = function() {');
const appCode = slice(appSrc, '// Pure: what a Paste has to do.', 'async function transferToExternalDBDeep(') + '\n' + slice(appSrc, 'function dbNameForStack(', 'function openWindowRoot(');
const stacksCode = slice(stacksSrc, 'window.groupBinItemsByDb = function', 'window.reportBinRestoreFailures = function');

const mkTab = (o) => ({ dataset: Object.assign({}, o.dataset), classList: { contains: (c) => (o.cls || []).includes(c) }, _pendingAutoSaveTimeout: o.pending,
  closest: () => o.group || {}, id: o.id });

(async () => {
  console.log('which database a save goes to (resolveSaveDbName)');
  const resolveEnv = (extra = {}) => {
    const ls = { codemini_active_window: 'win_default', codemini_windows: JSON.stringify([{ id: 'win_default', db: 'CodeMiniDB' }]) };
    const ctx = vm.createContext(Object.assign({ window: {}, JSON, localStorage: { getItem: (k) => (k in ls ? ls[k] : null) }, db: undefined }, extra));
    vm.runInContext('var window = this.window;', ctx);
    ctx.window = ctx; vm.runInContext(editorCode, ctx); return ctx;
  };
  await t('a Document tab stamped with a workspace database saves THERE even though the window record names the outer one (the reported bug)', () => {
    const c = resolveEnv({ db: { name: 'CodeMiniDB_WS_1' } });
    assert.strictEqual(c.window.resolveSaveDbName({ dataset: { dbName: 'CodeMiniDB_WS_1' } }), 'CodeMiniDB_WS_1');
  });
  await t('the tab\'s own database wins over whatever is open now (tab left open while the open database changed)', () => {
    const c = resolveEnv({ db: { name: 'CodeMiniDB' } });
    assert.strictEqual(c.window.resolveSaveDbName({ dataset: { dbName: 'CodeMiniDB_WS_1' } }), 'CodeMiniDB_WS_1');
  });
  await t('an explicit name (captured before an await) wins over everything', () => {
    const c = resolveEnv({ db: { name: 'x' } });
    assert.strictEqual(c.window.resolveSaveDbName({ dataset: { dbName: 'a' } }, 'explicit'), 'explicit');
  });
  await t('a tab without a stamp uses the open database, then the window\'s', () => {
    assert.strictEqual(resolveEnv({ db: { name: 'CodeMiniDB_WS_9' } }).window.resolveSaveDbName({ dataset: {} }), 'CodeMiniDB_WS_9');
    assert.strictEqual(resolveEnv({ db: null }).window.resolveSaveDbName(null), 'CodeMiniDB');
  });

  console.log('opening a database only if it exists (openExistingCodeMiniDb)');
  const openEnv = (idb) => { const ctx = vm.createContext({ window: { CODEMINI_DB_VERSION: 4, ensureCodeMiniSchema() { ctx.schemaRuns = (ctx.schemaRuns || 0) + 1; } }, indexedDB: idb, JSON }); ctx.window.window = ctx.window; vm.runInContext(editorCode.replace(/\bwindow\./g, 'window.'), ctx); return ctx; };
  await t('a missing database is NOT created (a save to a deleted workspace used to resurrect it as an empty ghost)', async () => {
    const idb = makeIdb({ CodeMiniDB: {} }); const c = openEnv(idb); let missing = 0, opened = 0;
    c.window.openExistingCodeMiniDb('CodeMiniDB_WS_gone', () => opened++, () => missing++);
    await tick(); await tick();
    assert.strictEqual(missing, 1); assert.strictEqual(opened, 0);
    assert.deepStrictEqual(plain(idb.created), []); assert.strictEqual(idb.dbs.CodeMiniDB_WS_gone, undefined);
  });
  await t('an existing database opens normally', async () => {
    const idb = makeIdb({ WS: { a: { id: 'a' } } }); const c = openEnv(idb); let got = null;
    c.window.openExistingCodeMiniDb('WS', (d) => { got = d; }, () => assert.fail('exists'));
    await tick(); await tick(); assert.strictEqual(got.name, 'WS');
  });
  await t('an older existing database is still upgraded to the current schema', async () => {
    const idb = makeIdb({ WS: {} }); idb.dbs.WS.version = 3; const c = openEnv(idb);
    c.window.openExistingCodeMiniDb('WS', () => {}, () => assert.fail('exists'));
    await tick(); await tick(); assert.strictEqual(c.schemaRuns, 1);
  });

  console.log('tabs and database switches (tabsBoundToDatabase / closeTabsForDatabase / closeTabsForMovedFiles)');
  const tabEnv = (tabs) => {
    const log = []; const group = { id: 'editorGroup1' };
    tabs.forEach((x) => { x.group = group; });
    const els = tabs.map(mkTab);
    const ctx = vm.createContext({
      window: { monaco: { editor: { getEditors: () => [{ getContainerDomNode: () => 'dom', getValue: () => 'TEXT' }] } }, autoSaveFile: (id, val, tab) => log.push(['save', id, val, tab.dataset.dbName]),
        triggerDocumentSave: (pane) => log.push(['docsave', pane.id]), saveAllUnsavedTabs: () => log.push(['SAVE-ALL-UNSAVED-USED']) },
      document: { querySelectorAll: () => els, getElementById: (id) => ({ id, querySelector: () => ({ contains: () => true }) }) },
      closeTab: (tab) => log.push(['close', tab.dataset.fileId]), triggerNotebookSave: (p) => log.push(['nbsave', p.id]), console, Array, Set });
    ctx.window.window = ctx.window; vm.runInContext(tabCode, ctx);
    els.forEach((e, i) => { e.dataset.target = tabs[i].id; });
    return { ctx, log };
  };
  await t('only file tabs of the given database are selected', () => {
    const { ctx } = tabEnv([{ id: 'p1', dataset: { fileId: 'f1', dbName: 'WS1', type: 'monaco' } }, { id: 'p2', dataset: { fileId: 'f2', dbName: 'ROOT', type: 'monaco' } },
      { id: 'p3', dataset: { type: 'workspace' } }, { id: 'p4', dataset: { fileId: 'f4', type: 'monaco' } }]);
    const els = [mkTab({ dataset: { fileId: 'a', dbName: 'WS1' } }), mkTab({ dataset: { fileId: 'b', dbName: 'ROOT' } }), mkTab({ dataset: {} }), mkTab({ dataset: { fileId: 'c' } })];
    assert.deepStrictEqual(plain(ctx.window.tabsBoundToDatabase(els, 'WS1').map((x) => x.dataset.fileId)), ['a']);
  });
  await t('leaving a workspace: unsaved edits are saved to that workspace FIRST, then its tabs close; other tabs are untouched', () => {
    const { ctx, log } = tabEnv([
      { id: 'p1', dataset: { fileId: 'f1', dbName: 'WS1', type: 'monaco' }, cls: ['unsaved-blink'] },
      { id: 'p2', dataset: { fileId: 'f2', dbName: 'WS1', type: 'monaco' }, cls: [] },
      { id: 'p3', dataset: { fileId: 'f3', dbName: 'ROOT', type: 'monaco' }, cls: ['unsaved-blink'] },
      { id: 'p4', dataset: { type: 'workspace' } }]);
    assert.strictEqual(ctx.window.closeTabsForDatabase('WS1'), 2);
    assert.deepStrictEqual(plain(log), [['save', 'f1', 'TEXT', 'WS1'], ['close', 'f1'], ['close', 'f2']]);
  });
  await t('it never goes through saveAllUnsavedTabs (its async format-on-save would save an empty file after the editor is closed)', () => {
    const { ctx, log } = tabEnv([{ id: 'p1', dataset: { fileId: 'f1', dbName: 'WS1', type: 'monaco' }, cls: ['unsaved-blink'] }]);
    ctx.window.closeTabsForDatabase('WS1'); assert(!log.some((l) => l[0] === 'SAVE-ALL-UNSAVED-USED'));
  });
  await t('a Document with unsaved changes is flushed through its own save, notebooks through theirs', () => {
    const { ctx, log } = tabEnv([{ id: 'pd', dataset: { fileId: 'd', dbName: 'WS1', type: 'document' }, cls: ['unsaved-blink'] }, { id: 'pn', dataset: { fileId: 'n', dbName: 'WS1', type: 'notebook' }, cls: ['unsaved-blink'] }]);
    ctx.window.closeTabsForDatabase('WS1');
    assert.deepStrictEqual(plain(log.filter((l) => l[0] !== 'close')), [['docsave', 'pd'], ['nbsave', 'pn']]);
  });
  await t('nothing to close: returns 0 and does nothing', () => {
    const { ctx, log } = tabEnv([{ id: 'p', dataset: { fileId: 'f', dbName: 'ROOT', type: 'monaco' } }]);
    assert.strictEqual(ctx.window.closeTabsForDatabase('WS1'), 0); assert.deepStrictEqual(plain(log), []);
  });
  await t('after a cross-database move, the moved files\' tabs close (their record left that database)', () => {
    const { ctx, log } = tabEnv([{ id: 'p1', dataset: { fileId: 'f1', dbName: 'A', type: 'monaco' } }, { id: 'p2', dataset: { fileId: 'f2', dbName: 'A', type: 'monaco' } }, { id: 'p3', dataset: { fileId: 'f1', dbName: 'B', type: 'monaco' } }]);
    ctx.window.closeTabsForMovedFiles(['f1'], 'A'); assert.deepStrictEqual(plain(log), [['close', 'f1']]);
  });

  console.log('locations: Back/Forward and Paste (dbNameForStack / showLocation / clipboardPlan)');
  const locEnv = ({ dbName, workspaces }) => {
    const ctx = vm.createContext({ window: { workspacesList: workspaces }, cellActiveWindow: { db: 'CodeMiniDB' }, db: { name: dbName }, folderStack: null, JSON, setTimeout, loaded: 0, inits: [] });
    ctx.window.window = ctx.window;
    ctx.loadFilesFromDB = () => { ctx.loaded++; };
    ctx.initDatabase = (name, cb) => { ctx.inits.push(name); ctx.db = { name }; setImmediate(cb); };
    vm.runInContext(appCode, ctx); return ctx;
  };
  const WS = [{ id: 'w1', name: 'W1', db: 'CodeMiniDB_WS_1' }, { id: 'w2', name: 'W2' }];
  await t('dbNameForStack: root stack -> the window\'s database; workspace stack -> its own; legacy record without .db -> CodeMiniDB_WS_<id>', () => {
    const c = locEnv({ dbName: 'CodeMiniDB', workspaces: WS });
    assert.strictEqual(c.dbNameForStack([{ id: 'root' }], WS, 'CodeMiniDB'), 'CodeMiniDB');
    assert.strictEqual(c.dbNameForStack([{ id: 'w1' }, { id: 'sub' }], WS, 'CodeMiniDB'), 'CodeMiniDB_WS_1');
    assert.strictEqual(c.dbNameForStack([{ id: 'w2' }], WS, 'CodeMiniDB'), 'CodeMiniDB_WS_w2');
  });
  await t('dbNameForStack: a deleted workspace -> null', () => { assert.strictEqual(locEnv({ dbName: 'x', workspaces: [] }).dbNameForStack([{ id: 'w1' }], [], 'R'), null); });
  await t('Back into a workspace from CodeMini switches to the workspace\'s database before showing it', async () => {
    const c = locEnv({ dbName: 'CodeMiniDB', workspaces: WS });
    c.showLocation([{ id: 'w1', name: 'W1', isWorkspaceRoot: true }]);
    assert.strictEqual(c.window._locationSwitching, true, 'history pushes are held back during the switch');
    await tick(); await tick();
    assert.deepStrictEqual(plain(c.inits), ['CodeMiniDB_WS_1']); assert.strictEqual(c.folderStack[0].id, 'w1'); assert.strictEqual(c.loaded, 1);
    assert.strictEqual(c.window._locationSwitching, false);
  });
  await t('Forward out of a workspace to CodeMini switches back to the window\'s database', async () => {
    const c = locEnv({ dbName: 'CodeMiniDB_WS_1', workspaces: WS });
    c.showLocation([{ id: 'root', name: 'CodeMini' }]); await tick(); await tick();
    assert.deepStrictEqual(plain(c.inits), ['CodeMiniDB']); assert.strictEqual(c.folderStack[0].id, 'root');
  });
  await t('Back to a workspace that has since been deleted lands on CodeMini, not an empty phantom', async () => {
    const c = locEnv({ dbName: 'CodeMiniDB', workspaces: [] });
    c.showLocation([{ id: 'w1', name: 'W1', isWorkspaceRoot: true }]); await tick();
    assert.deepStrictEqual(plain(c.folderStack), [{ id: 'root', name: 'CodeMini' }]); assert.strictEqual(c.inits.length, 0, 'already on the root database');
  });
  await t('moving within the open database does not reopen it', async () => {
    const c = locEnv({ dbName: 'CodeMiniDB_WS_1', workspaces: WS });
    c.showLocation([{ id: 'w1', name: 'W1', isWorkspaceRoot: true }, { id: 'sub', name: 'sub' }]);
    assert.strictEqual(c.inits.length, 0); assert.strictEqual(c.loaded, 1);
  });
  await t('Paste: items from the same database are a plain paste; from another database a cross-database transfer', () => {
    const c = locEnv({ dbName: 'x', workspaces: [] });
    assert.deepStrictEqual(plain(c.clipboardPlan({ action: 'copy', sourceDb: 'WS1' }, 'WS1')), { crossDb: false, action: 'copy' });
    assert.deepStrictEqual(plain(c.clipboardPlan({ action: 'copy', sourceDb: 'CodeMiniDB' }, 'WS1')), { crossDb: true, action: 'copy' });
  });
  await t('Paste: the clipboard\'s "cut" is the transfer\'s "move" (otherwise the original is never removed)', () => {
    const c = locEnv({ dbName: 'x', workspaces: [] });
    assert.strictEqual(c.clipboardPlan({ action: 'cut', sourceDb: 'A' }, 'B').action, 'move');
    assert.strictEqual(c.clipboardPlan({ action: 'cut', sourceDb: 'A' }, 'A').action, 'move');
  });
  await t('Paste: an old clipboard entry with no sourceDb is treated as same-database, as before', () => {
    assert.strictEqual(locEnv({ dbName: 'x', workspaces: [] }).clipboardPlan({ action: 'copy' }, 'A').crossDb, false);
  });

  console.log('recycle bin restore (groupBinItemsByDb / restoreItemsToDB)');
  const binEnv = (idb) => {
    const ctx = vm.createContext({ window: { getUniqueFileName: (live, parent, name) => (live.some((f) => f.parentId === parent && f.name === name) ? name.replace('.', '(1).') : name), openExistingCodeMiniDb: null }, Object, Map, Set, JSON, Array });
    ctx.window.window = ctx.window;
    ctx.window.openExistingCodeMiniDb = (name, onOpen, onMissing) => { setImmediate(() => (idb.dbs[name] ? onOpen(idb.handle(name)) : onMissing())); };
    vm.runInContext(stacksCode, ctx); return ctx;
  };
  await t('items are grouped by the database they came out of; unstamped (older) items belong to the open one', () => {
    const c = binEnv(makeIdb());
    const g = c.window.groupBinItemsByDb([{ id: 1, _db: 'WS1' }, { id: 2 }, { id: 3, _db: 'WS1' }, { id: 4, _db: 'ROOT' }], 'ROOT');
    assert.deepStrictEqual(plain([...g.entries()].map(([k, v]) => [k, v.map((x) => x.id)])), [['WS1', [1, 3]], ['ROOT', [2, 4]]]);
  });
  await t('a file deleted inside a workspace is restored INTO that workspace even when you are back in CodeMini (it used to become an invisible orphan)', async () => {
    const idb = makeIdb({ CodeMiniDB: {}, WS1: {} }); const c = binEnv(idb);
    const bin = [{ id: 'f1', parentId: 'w1', name: 'notes.md', type: 'file', _db: 'WS1', deletedAt: 5, _daysLeft: 3 }]; let res;
    c.window.restoreItemsToDB(bin, idb.handle('CodeMiniDB'), (r, f) => { res = { r, f }; });
    await tick(); await tick(); await tick(); await tick();
    assert.deepStrictEqual(Object.keys(idb.dbs.WS1.records), ['f1']); assert.deepStrictEqual(Object.keys(idb.dbs.CodeMiniDB.records), []);
    const rec = idb.dbs.WS1.records.f1; assert(!('_db' in rec) && !('deletedAt' in rec) && !('_daysLeft' in rec), 'bookkeeping fields are not stored');
    assert.strictEqual(res.r.length, 1); assert.strictEqual(res.f.length, 0);
  });
  await t('a restore into a deleted workspace fails cleanly: nothing is created, the item stays intact in the bin', async () => {
    const idb = makeIdb({ CodeMiniDB: {} }); const c = binEnv(idb);
    const item = { id: 'f1', parentId: 'w1', name: 'a.txt', type: 'file', _db: 'WS_GONE', deletedAt: 7 }; let res;
    c.window.restoreItemsToDB([item], idb.handle('CodeMiniDB'), (r, f) => { res = { r, f }; });
    await tick(); await tick();
    assert.strictEqual(res.r.length, 0); assert.strictEqual(res.f.length, 1);
    assert.deepStrictEqual(plain(idb.created), []); assert.strictEqual(item.deletedAt, 7); assert.strictEqual(item._db, 'WS_GONE');
  });
  await t('a mixed batch restores what it can and reports the rest', async () => {
    const idb = makeIdb({ CodeMiniDB: {}, WS1: {} }); const c = binEnv(idb); let res;
    c.window.restoreItemsToDB([{ id: 'a', parentId: 'root', name: 'a', type: 'file' }, { id: 'b', parentId: 'w', name: 'b', type: 'file', _db: 'WS1' }, { id: 'c', parentId: 'w', name: 'c', type: 'file', _db: 'GONE' }],
      idb.handle('CodeMiniDB'), (r, f) => { res = { r, f }; });
    for (let i = 0; i < 8; i++) await tick();
    assert.deepStrictEqual(plain(res.r.map((x) => x.id).sort()), ['a', 'b']); assert.deepStrictEqual(plain(res.f.map((x) => x.id)), ['c']);
  });
  await t('a write that fails leaves the item in the bin (reported as failed, not restored)', async () => {
    const idb = makeIdb({ CodeMiniDB: {}, WS1: {} }); idb.failing.add('WS1'); const c = binEnv(idb);
    const item = { id: 'f1', parentId: 'w1', name: 'a.txt', type: 'file', _db: 'WS1', deletedAt: 9 }; let res;
    c.window.restoreItemsToDB([item], idb.handle('CodeMiniDB'), (r, f) => { res = { r, f }; });
    for (let i = 0; i < 6; i++) await tick();
    assert.strictEqual(res.r.length, 0); assert.strictEqual(res.f.length, 1); assert.deepStrictEqual(Object.keys(idb.dbs.WS1.records), []);
  });
  await t('a restored item that clashes with a name already there is auto-numbered, as before', async () => {
    const idb = makeIdb({ CodeMiniDB: { x: { id: 'x', parentId: 'root', name: 'index.html', type: 'file' } } }); const c = binEnv(idb); let done = false;
    c.window.restoreItemsToDB([{ id: 'y', parentId: 'root', name: 'index.html', type: 'file' }], idb.handle('CodeMiniDB'), () => { done = true; });
    for (let i = 0; i < 6; i++) await tick();
    assert(done); assert.strictEqual(idb.dbs.CodeMiniDB.records.y.name, 'index(1).html');
  });

  console.log('wiring (source checks)');
  await t('Documents save to the tab\'s database, not the window record\'s (the reported bug)', () => {
    const body = slice(docsSrc, 'window.triggerDocumentSave = async function', 'function _docMarkUnsaved');
    assert(/const targetDbName = window\.resolveSaveDbName\(tabEl\);/.test(body));
    assert(!/codemini_windows/.test(body), 'must not read the window record');
  });
  await t('every file tab is stamped with its database when it is created', () => {
    assert(/if \(fileId && typeof db !== 'undefined' && db && db\.name\) tab\.dataset\.dbName = db\.name;/.test(editorSrc));
  });
  await t('autoSaveFile resolves its database through the shared helper and never creates one', () => {
    const body = slice(editorSrc, 'window.autoSaveFile = function(', 'window.tabsBoundToDatabase');
    assert(/window\.resolveSaveDbName\(tabEl, explicitDbName\)/.test(body)); assert(/window\.openExistingCodeMiniDb\(targetDbName/.test(body));
    assert(!/indexedDB\.open\(/.test(body), 'a plain open would re-create a deleted workspace');
  });
  await t('initDatabase saves and closes the old location\'s tabs when the database really changes', () => {
    const body = slice(appSrc, 'function initDatabase(', 'function persistExplorerLocation');
    assert(/db\.name !== dbName && typeof window\.closeTabsForDatabase === 'function'/.test(body));
    assert(body.indexOf('closeTabsForDatabase') < body.indexOf('db.close()'), 'before the old database is closed');
  });
  await t('Back/Forward go through showLocation', () => { assert(/showLocation\(state\.folderStack\)/.test(slice(scriptSrc, 'function applyNavState', 'document.getElementById(\'menuHistBack\')'))); });
  await t('pushNavState is held while a cross-database switch finishes', () => { assert(/function pushNavState\(\) \{\s*if \(isNavigating \|\| window\._locationSwitching\) return;/.test(appSrc)); });
  await t('Cut/Copy record the open database as the source; Paste uses it and the planner', () => {
    assert(/action: 'cut', files: targets, sourceDb: db\.name/.test(appSrc)); assert(/action: 'copy', files: targets, sourceDb: db\.name/.test(appSrc));
    assert(/const plan = window\.clipboardPlan\(clip, db\.name\);/.test(appSrc));
    assert(/transferToExternalDBDeep\(clip\.files, db\.name, plan\.action, file\.id, clip\.sourceDb\)/.test(appSrc));
    assert(!/transferToExternalDBDeep\(clip\.files, cellActiveWindow\.db/.test(appSrc));
  });
  await t('a transfer can name its source database (paste from another database)', () => {
    assert(/async function transferToExternalDBDeep\(targets, targetDbName, action, targetRootId = 'root', sourceDbOverride\) \{\s*const sourceDbName = sourceDbOverride \|\| db\.name;/.test(appSrc));
  });
  await t('a cross-database move closes the moved files\' tabs', () => { assert(/closeTabsForMovedFiles\(allToDelete\.map\(f => f\.id\), sourceDbName\)/.test(appSrc)); });
  await t('global search looks at the open database and closes its connection', () => {
    assert(/function getDbName\(\) \{[\s\S]*?if \(typeof db !== 'undefined' && db && db\.name\) return db\.name;/.test(searchSrc));
    assert((searchSrc.match(/dbInstance\.close\(\)/g) || []).length >= 2);
  });
  await t('creating a workspace: refuses a duplicate name, closes the connection it opens, saves the record in the window\'s database', () => {
    const body = slice(appSrc, "if (creationMode === 'workspace') {", 'const targetParentId = window.creationTargetFolderId');
    assert(/already exists/.test(body)); assert(/e\.target\.result\.close\(\)/.test(body));
    assert(/cellActiveWindow\.db/.test(body) && /openExistingCodeMiniDb\(cellActiveWindow\.db/.test(body));
  });
  await t('deleting a workspace also forgets its trust record and drops its recycle-bin entries', () => {
    const body = slice(scriptSrc, "title: 'Delete Workspace'", 'actionsContainer.appendChild(editIcon)');
    assert(/WorkspaceTrust\.forget\(wsDbName\)/.test(body)); assert(/_db === wsDbName/.test(body));
  });
  await t('trashed items remember their database (explorer delete and terminal rm)', () => {
    assert(/t\._db = db\.name;/.test(appSrc)); assert(/c\._db = fromDb/.test(termCmdSrc) && /found\._db = fromDb/.test(termCmdSrc));
    assert(/setIsolatedDb, \(\) => isolatedDbName/.test(termWinSrc));
  });
  await t('the terminal no longer re-creates a deleted workspace\'s database', () => {
    const body = slice(termWinSrc, 'const getIsolatedDbTx = (mode)', 'const dbGetAll = async');
    assert(/openExistingCodeMiniDb\(isolatedDbName/.test(body)); assert(!/indexedDB\.open\(/.test(body));
  });

  console.log(`\n${n} passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
