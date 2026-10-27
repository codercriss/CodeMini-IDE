// Explorer location in js/core/app.js, run against fakes (no browser): the saved location must follow you around,
// and a saved workspace/folder that no longer exists must never be reopened.
// Regression for: open workspace 1, go back to CodeMini, close and reopen the app -> workspace 1 opened again,
// even after it was deleted.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'js/core/app.js'), 'utf8');
const scriptSrc = fs.readFileSync(path.join(__dirname, '..', 'js/core/script.js'), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };

// Pull the code under test out of app.js (from persistExplorerLocation through openWindowRoot).
const start = src.indexOf('function persistExplorerLocation()');
// ...up to where the workspace-location helpers begin (those are covered by workspace-db.test.js)
const end = src.indexOf('// Which database a folderStack lives in');
assert(start > 0 && end > start, 'could not find the functions under test in app.js');
const code = src.slice(start, end);

const ROOT = { id: 'root', name: 'CodeMini' };

// A fake IndexedDB-ish database: { name, records } with just transaction().objectStore().get().
const makeDb = (name, records) => ({
  name,
  transaction: () => ({ objectStore: () => ({ get: (id) => {
    const req = {}; setImmediate(() => { req.result = records[id]; if (req.onsuccess) req.onsuccess(); }); return req;
  } }) })
});

function makeEnv({ stored, folderStack, rootRecords = {}, wsRecords = {}, winId = 'win_default' }) {
  const ls = {}; if (stored !== undefined) ls.codemini_profile_states = JSON.stringify(stored);
  const dbs = { CodeMiniDB: makeDb('CodeMiniDB', rootRecords) };
  const opened = [];
  const ctx = vm.createContext({
    console, Promise, JSON, Object, Array, Error, setImmediate,
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } },
    cellActiveWinId: winId, cellActiveWindow: { id: winId, db: 'CodeMiniDB', profile: false },
    folderStack, navHistory: [{ stale: true }], navIndex: 0, profileStates: JSON.parse(JSON.stringify(stored || {})),
    db: dbs.CodeMiniDB, loadFilesFromDB() { ctx.loaded = (ctx.loaded || 0) + 1; },
    // initDatabase as app.js has it: swaps `db`, calls back once open, and drops the callback if superseded.
    initDatabase(name, cb) {
      opened.push(name); ctx.expectedDbName = name;
      setImmediate(() => {
        if (ctx.expectedDbName !== name) return;
        ctx.db = dbs[name] || (dbs[name] = makeDb(name, wsRecords)); if (cb) cb();
      });
    }
  });
  vm.runInContext(code, ctx);
  return { ctx, ls, opened, saved: () => JSON.parse(ls.codemini_profile_states || '{}')[winId] };
}
const plain = (x) => JSON.parse(JSON.stringify(x)); // values built inside the vm context have another Array prototype
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));
const ws1 = { id: 'ws1', name: 'Workspace 1', isWorkspaceRoot: true, parentDb: 'CodeMiniDB' };

(async () => {
  console.log('persistExplorerLocation');
  await t('nothing saved and at the root: writes nothing', () => {
    const e = makeEnv({ folderStack: [ROOT] });
    e.ctx.persistExplorerLocation();
    assert.strictEqual(e.ls.codemini_profile_states, undefined);
  });
  await t('entering a workspace is saved', () => {
    const e = makeEnv({ folderStack: [ws1] });
    e.ctx.persistExplorerLocation();
    assert.strictEqual(e.saved().folderStack[0].id, 'ws1');
  });
  await t('going back to CodeMini overwrites the saved workspace (the reported bug)', () => {
    // switchWindow() had saved "inside workspace 1"; the user then returned to CodeMini.
    const e = makeEnv({ stored: { win_default: { folderStack: [ws1], currentExplorerSearch: 'abc', expandedFolders: ['x'] } }, folderStack: [ROOT] });
    e.ctx.persistExplorerLocation();
    assert.deepStrictEqual(plain(e.saved().folderStack), [ROOT]);
  });
  await t('only folderStack is touched; the rest of the saved state is kept', () => {
    const e = makeEnv({ stored: { win_default: { folderStack: [ws1], currentExplorerSearch: 'abc', expandedFolders: ['x'], currentSortOrder: 'desc' } }, folderStack: [ROOT] });
    e.ctx.persistExplorerLocation();
    const s = e.saved();
    assert.strictEqual(s.currentExplorerSearch, 'abc'); assert.deepStrictEqual(plain(s.expandedFolders), ['x']); assert.strictEqual(s.currentSortOrder, 'desc');
  });
  await t('other windows\' saved states are left alone', () => {
    const other = { folderStack: [{ id: 'wsZ', name: 'Z' }] };
    const e = makeEnv({ stored: { win_default: { folderStack: [ws1] }, win_2: other }, folderStack: [ROOT] });
    e.ctx.persistExplorerLocation();
    assert.deepStrictEqual(JSON.parse(e.ls.codemini_profile_states).win_2, other);
  });
  await t('an unchanged location does not rewrite storage', () => {
    const e = makeEnv({ stored: { win_default: { folderStack: [ROOT] } }, folderStack: [ROOT] });
    const before = e.ls.codemini_profile_states; e.ctx.persistExplorerLocation();
    assert.strictEqual(e.ls.codemini_profile_states, before);
  });
  await t('blocked storage does not throw', () => {
    const e = makeEnv({ folderStack: [ws1] });
    e.ctx.localStorage.setItem = () => { throw new Error('quota'); };
    e.ctx.persistExplorerLocation();
  });

  console.log('resolveRestoredLocation');
  await t('workspace was deleted: falls back to CodeMini, history cleared, no workspace database opened', async () => {
    const e = makeEnv({ folderStack: [ws1], rootRecords: {} });
    assert.strictEqual(await e.ctx.resolveRestoredLocation(), true);
    assert.deepStrictEqual(plain(e.ctx.folderStack), [ROOT]);
    assert.deepStrictEqual(plain(e.ctx.navHistory), []); assert.strictEqual(e.ctx.navIndex, -1);
    assert.deepStrictEqual(plain(e.opened), []); assert.strictEqual(e.ctx.db.name, 'CodeMiniDB');
  });
  await t('the id now belongs to something that is not a workspace: falls back to CodeMini', async () => {
    const e = makeEnv({ folderStack: [ws1], rootRecords: { ws1: { id: 'ws1', type: 'folder', name: 'x' } } });
    await e.ctx.resolveRestoredLocation();
    assert.deepStrictEqual(plain(e.ctx.folderStack), [ROOT]);
  });
  await t('workspace still exists: its own database is reopened and the stack is rebuilt from the record', async () => {
    const e = makeEnv({ folderStack: [{ id: 'ws1', name: 'Old name' }],
      rootRecords: { ws1: { id: 'ws1', type: 'workspace', name: 'Renamed', db: 'CodeMiniDB_WS_9' } } });
    assert.strictEqual(await e.ctx.resolveRestoredLocation(), true);
    assert.deepStrictEqual(plain(e.opened), ['CodeMiniDB_WS_9']); assert.strictEqual(e.ctx.db.name, 'CodeMiniDB_WS_9');
    assert.deepStrictEqual(plain(e.ctx.folderStack), [{ id: 'ws1', name: 'Renamed', isWorkspaceRoot: true, parentDb: 'CodeMiniDB' }]);
  });
  await t('a workspace record without .db uses CodeMiniDB_WS_<id>', async () => {
    const e = makeEnv({ folderStack: [ws1], rootRecords: { ws1: { id: 'ws1', type: 'workspace', name: 'W' } } });
    await e.ctx.resolveRestoredLocation();
    assert.deepStrictEqual(plain(e.opened), ['CodeMiniDB_WS_ws1']);
  });
  await t('app launch: an EXISTING workspace is not reopened either - always starts on CodeMini', async () => {
    const e = makeEnv({ folderStack: [ws1], rootRecords: { ws1: { id: 'ws1', type: 'workspace', name: 'W', db: 'WSDB' } } });
    assert.strictEqual(await e.ctx.resolveRestoredLocation(true), true);
    assert.deepStrictEqual(plain(e.ctx.folderStack), [ROOT]);
    assert.deepStrictEqual(plain(e.opened), []); assert.strictEqual(e.ctx.db.name, 'CodeMiniDB');
  });
  await t('app launch: folders inside CodeMini that still exist are kept', async () => {
    const e = makeEnv({ folderStack: [ROOT, { id: 'a', name: 'a' }], rootRecords: { a: { id: 'a', type: 'folder' } } });
    await e.ctx.resolveRestoredLocation(true);
    assert.deepStrictEqual(plain(e.ctx.folderStack.map((f) => f.id)), ['root', 'a']);
  });
  await t('folders: the stack is cut at the first one that no longer exists', async () => {
    const e = makeEnv({ folderStack: [ROOT, { id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }],
      rootRecords: { a: { id: 'a', type: 'folder' }, c: { id: 'c', type: 'folder' } } });
    await e.ctx.resolveRestoredLocation();
    assert.deepStrictEqual(plain(e.ctx.folderStack.map((f) => f.id)), ['root', 'a']);
  });
  await t('folders inside a workspace are checked against the workspace database', async () => {
    const e = makeEnv({ folderStack: [ws1, { id: 'src', name: 'src' }],
      rootRecords: { ws1: { id: 'ws1', type: 'workspace', name: 'W', db: 'WSDB' } }, wsRecords: { src: { id: 'src', type: 'folder' } } });
    await e.ctx.resolveRestoredLocation();
    assert.deepStrictEqual(plain(e.ctx.folderStack.map((f) => f.id)), ['ws1', 'src']);
  });
  await t('a healthy root location is left exactly as it was', async () => {
    const e = makeEnv({ folderStack: [ROOT], rootRecords: {} });
    e.ctx.navHistory = [{ keep: 1 }];
    await e.ctx.resolveRestoredLocation();
    assert.deepStrictEqual(plain(e.ctx.folderStack), [ROOT]); assert.deepStrictEqual(plain(e.ctx.navHistory), [{ keep: 1 }]);
  });
  await t('another database opened meanwhile: resolves false so the caller does not render over it', async () => {
    const e = makeEnv({ folderStack: [ws1], rootRecords: { ws1: { id: 'ws1', type: 'workspace', name: 'W', db: 'WSDB' } } });
    const p = e.ctx.resolveRestoredLocation();
    e.ctx.db = makeDb('SomethingElse', {}); // e.g. the person switched window while the check was running
    assert.strictEqual(await p, false);
  });

  console.log('whole scenario');
  await t('enter workspace 1, window switch saves it, back to CodeMini, delete it, reopen: lands on CodeMini', async () => {
    // 1. switchWindow() wrote "inside workspace 1".  2. Person returns to CodeMini (loadFilesFromDB -> persist).
    let e = makeEnv({ stored: { win_default: { folderStack: [ws1] } }, folderStack: [ROOT] });
    e.ctx.persistExplorerLocation();
    // 3. Reopen the app: startup reads the saved state (workspace 1 already deleted from the root database).
    const saved = e.saved();
    const e2 = makeEnv({ stored: { win_default: saved }, folderStack: saved.folderStack, rootRecords: {} });
    await e2.ctx.resolveRestoredLocation();
    assert.deepStrictEqual(plain(e2.ctx.folderStack), [ROOT]);
  });
  await t('...and even if they never went back to CodeMini, a deleted workspace is not reopened', async () => {
    const e = makeEnv({ stored: { win_default: { folderStack: [ws1] } }, folderStack: [ws1], rootRecords: {} });
    await e.ctx.resolveRestoredLocation();
    assert.deepStrictEqual(plain(e.ctx.folderStack), [ROOT]);
    e.ctx.persistExplorerLocation(); // the load that follows rewrites the stale saved copy
    assert.deepStrictEqual(plain(e.saved().folderStack), [ROOT]);
  });

  console.log('wiring (source checks)');
  await t('loadFilesFromDB saves the location before anything else', () => {
    assert(/function loadFilesFromDB\(\) \{\s*persistExplorerLocation\(\);/.test(src));
  });
  await t('startup and window switch both go through openWindowRoot()', () => {
    assert.strictEqual((src.match(/openWindowRoot\(\);/g) || []).length, 1, 'window switch');
    assert.strictEqual((src.match(/openWindowRoot\(true\);/g) || []).length, 1, 'app launch');
    assert(!/initDatabase\(cellActiveWindow\.db, \(\) => loadFilesFromDB\(\)\)/.test(src), 'a path still renders the saved location unchecked');
  });
  await t('Delete Workspace removes the record from the root database and always refreshes', () => {
    const i = scriptSrc.indexOf("title: 'Delete Workspace'"); const block = scriptSrc.slice(i, i + 2500);
    assert(/indexedDB\.open\(cellActiveWindow\.db/.test(block), 'must open the root database');
    assert(!/db\.transaction\('filesystem', 'readwrite'\)/.test(block), 'must not delete through whichever db is open');
    assert(/loadFilesFromDB\(\)/.test(block));
  });

  console.log(`\n${n} passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
