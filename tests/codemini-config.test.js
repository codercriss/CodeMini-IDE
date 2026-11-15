// The workspace config folder (UI/UX specs feature 23): js/core/codemini-config.js. The rules and the store logic run here in Node, the store logic
// against an in-memory { getAll, putMany } adapter. What Explorer, Quick Open and Search show with a real database is in tests/e2e/codemini-config.e2e.js.
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const C = require('../js/core/codemini-config.js');
const SJ = require('../js/core/settings-json.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };

// An in-memory file store with the same two calls the app's adapter has.
function memStore(initial) {
  const rows = new Map((initial || []).map((r) => [r.id, r]));
  const s = { writes: 0, getAll: async () => Array.from(rows.values()).map((r) => Object.assign({}, r)), putMany: async (recs) => { s.writes++; recs.forEach((r) => rows.set(r.id, Object.assign({}, r))); }, rows };
  return s;
}
const folder = (id, name, parentId) => ({ id, parentId, name, type: 'folder', content: '' });
const file = (id, name, parentId, content, extra) => Object.assign({ id, parentId, name, type: 'file', content: content || '' }, extra || {});

(async () => {
  console.log('where the folder is');
  await t('a workspace\'s top level is the workspace id; a window with no workspace is \'root\'', () => {
    assert.strictEqual(C.rootParentId([{ id: 'ws1', isWorkspaceRoot: true }]), 'ws1');
    assert.strictEqual(C.rootParentId([{ id: 'root', name: 'CodeMini' }]), 'root');
    assert.strictEqual(C.rootParentId([{ id: 'f1' }, { id: 'f2' }]), 'root', 'a plain folder is not a workspace root');
    assert.strictEqual(C.rootParentId(null), 'root'); assert.strictEqual(C.rootParentId([]), 'root');
  });
  await t('only the .codemini folder at the top of the database is configuration; the same name deeper down is just a folder', () => {
    const recs = [folder('c', '.codemini', 'ws1'), folder('d', 'src', 'ws1'), folder('n', '.codemini', 'd'), file('t', 'tasks.json', 'c')];
    assert.deepStrictEqual(Array.from(C.configFolderIds(recs)), ['c']);
    assert.deepStrictEqual(Array.from(C.configFolderIds([file('x', '.codemini', 'root')])), [], 'a FILE with that name is not it');
    assert.deepStrictEqual(Array.from(C.configFolderIds([])), []);
  });
  await t('"in config" covers the folder, its files and anything nested, at any depth, and nothing else', () => {
    const recs = [folder('c', '.codemini', 'root'), folder('l', 'local', 'c'), file('s', 'state.json', 'l'), folder('src', 'src', 'root'), file('a', 'a.js', 'src'), folder('n', '.codemini', 'src')];
    const byId = new Map(recs.map((r) => [r.id, r])), ids = C.configFolderIds(recs);
    const inside = recs.filter((r) => C.isInConfig(r, byId, ids)).map((r) => r.id).sort();
    assert.deepStrictEqual(inside, ['c', 'l', 's']);
  });
  await t('a parent loop cannot hang it', () => {
    const recs = [folder('a', 'a', 'b'), folder('b', 'b', 'a')];
    const byId = new Map(recs.map((r) => [r.id, r]));
    assert.strictEqual(C.isInConfig(recs[0], byId, new Set(['zzz'])), false);
  });
  await t('Quick Open paths: the first segment decides', () => {
    assert.strictEqual(C.isConfigPath('.codemini/tasks.json'), true);
    assert.strictEqual(C.isConfigPath('.codemini'), true);
    assert.strictEqual(C.isConfigPath('src/.codemini/x.json'), false);
    assert.strictEqual(C.isConfigPath('.codeminiX/a'), false);
    assert.strictEqual(C.isConfigPath(''), false); assert.strictEqual(C.isConfigPath(undefined), false);
  });
  await t('a query asks for the folder on purpose when it starts with .codemini (any case, leading space)', () => {
    ['.codemini', '.codemini/tasks', '  .CodeMini', '.codemini local'].forEach((q) => assert.strictEqual(C.wantsConfig(q), true, q));
    ['tasks', 'codemini', 'x.codemini', '', null].forEach((q) => assert.strictEqual(C.wantsConfig(q), false, String(q)));
  });
  await t('Search and Quick Open: records inside .codemini are dropped unless the query asks, and the list is untouched when there is no such folder', () => {
    const recs = [folder('c', '.codemini', 'root'), file('t', 'tasks.json', 'c', 'x'), file('a', 'a.js', 'root', 'x')];
    assert.deepStrictEqual(C.withoutConfig(recs, 'x').map((r) => r.id), ['a']);
    assert.strictEqual(C.withoutConfig(recs, '.codemini/x').length, 3);
    const plain = [file('a', 'a.js', 'root')];
    assert.strictEqual(C.withoutConfig(plain, 'x'), plain, 'the same array: nothing was copied');
  });

  console.log('names');
  await t('a name inside the folder has no empty, dot or dot-dot parts, no backslash, nothing absolute', () => {
    ['tasks.json', 'local/state.json', 'snippets/python.json', 'a/b/c.txt'].forEach((x) => assert.strictEqual(C.validName(x), true, x));
    ['', '/x', 'x/', 'a//b', '../x', 'a/../b', './x', 'a\\b', 'a\0b', 'x'.repeat(201), null, 5].forEach((x) => assert.strictEqual(C.validName(x), false, String(x)));
  });

  console.log('reading JSON that came from another editor');
  await t('comments and trailing commas are allowed', () => {
    const r = C.parseJsonc('{\n // a comment\n "a": 1, /* block */ "b": [1, 2,],\n}\n');
    assert.deepStrictEqual([r.ok, r.value], [true, { a: 1, b: [1, 2] }]);
  });
  await t('what looks like a comment or a trailing comma INSIDE a string is left alone', () => {
    const r = C.parseJsonc('{"url": "http://x.y/*not*/", "s": "a,}", "e": "q\\"//still"}');
    assert.deepStrictEqual(r.value, { url: 'http://x.y/*not*/', s: 'a,}', e: 'q"//still' });
  });
  await t('plain JSON, scalars and arrays parse; an empty file is an error, not a crash', () => {
    assert.deepStrictEqual(C.parseJsonc('[1,2]').value, [1, 2]);
    assert.strictEqual(C.parseJsonc('7').value, 7);
    const e = C.parseJsonc('  \n '); assert.strictEqual(e.ok, false); assert.match(e.message, /empty/);
  });
  await t('an error carries a line and column in the ORIGINAL text, even with comments before it', () => {
    const src = '{\n  // note\n  "a": 1\n  "b": 2\n}';
    const r = C.parseJsonc(src);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.line, 4, JSON.stringify(r)); assert.ok(r.column >= 1);
    assert.ok(!/position \d+/.test(r.message), 'the message does not repeat the raw offset: ' + r.message);
  });
  await t('an unterminated comment or string is an error, not a hang', () => {
    assert.strictEqual(C.parseJsonc('{ /* never closed').ok, false);
    assert.strictEqual(C.parseJsonc('{"a": "never closed').ok, false);
  });

  console.log('.gitignore');
  await t('.codemini/local/ is added once, with a comment, and a missing final newline is handled', () => {
    const a = C.gitignoreWithLocal('node_modules/\ndist');
    assert.strictEqual(a.changed, true);
    assert.strictEqual(a.text, 'node_modules/\ndist\n\n# CodeMini: private to this machine\n.codemini/local/\n');
    const b = C.gitignoreWithLocal(a.text); assert.strictEqual(b.changed, false); assert.strictEqual(b.text, a.text);
    assert.strictEqual(C.gitignoreWithLocal('').text, '# CodeMini: private to this machine\n.codemini/local/\n');
    assert.strictEqual(C.gitignoreWithLocal(null).changed, true);
  });
  await t('an existing rule that already covers it counts (the whole folder, with or without a slash or a leading /)', () => {
    ['.codemini/local/', '/.codemini/local/', '.codemini/local', '.codemini/', '.codemini', '  .codemini/local/  ', 'a\r\n.codemini/local/\r\nb'].forEach((x) => assert.strictEqual(C.gitignoreWithLocal(x).changed, false, JSON.stringify(x)));
    assert.strictEqual(C.gitignoreWithLocal('.codemini/tasks.json').changed, true, 'a rule for one file does not cover local/');
  });

  console.log('workspace settings can never loosen security');
  const defaults = { fontSize: 13, wordWrap: 'off', minimap: false, isolationMode: 'Isolated', isolationPreview: 'Use global', workspaceTrustEnabled: true, workspaceTrustBanner: 'Always', syncProfileSettings: false };
  await t('security settings are rejected with the reason; ordinary ones with the right type pass; $schema is ignored', () => {
    const r = C.filterWorkspaceSettings({ $schema: 'x', fontSize: 15, wordWrap: 'on', isolationMode: 'Normal', workspaceTrustEnabled: false, syncProfileSettings: true }, defaults);
    assert.deepStrictEqual(r.accepted, { fontSize: 15, wordWrap: 'on' });
    assert.deepStrictEqual(r.rejected.map((x) => x.key).sort(), ['isolationMode', 'syncProfileSettings', 'workspaceTrustEnabled']);
    assert.ok(r.rejected.every((x) => /security setting/.test(x.reason)));
  });
  await t('unknown names and wrong types are rejected, not coerced', () => {
    const r = C.filterWorkspaceSettings({ fontSize: '15', minimap: 'yes', nonsense: 1 }, defaults);
    assert.deepStrictEqual(r.accepted, {});
    assert.deepStrictEqual(r.rejected.map((x) => x.key).sort(), ['fontSize', 'minimap', 'nonsense']);
  });
  await t('something that is not an object is one clear rejection', () => {
    [null, [], 'x', 3].forEach((v) => { const r = C.filterWorkspaceSettings(v, defaults); assert.deepStrictEqual(r.accepted, {}); assert.strictEqual(r.rejected.length, 1); });
  });
  await t('every security key the User settings.json refuses, a workspace refuses too (the two lists cannot drift apart)', () => {
    const keys = ['isolationMode', 'isolationPreview', 'isolationConsole', 'isolationTerminal', 'isolationNotebooks', 'workspaceTrustEnabled', 'workspaceTrustUntrustedFiles', 'workspaceTrustEmptyWindow',
      'workspaceTrustStartupPrompt', 'workspaceTrustBanner', 'syncProfileSettings', 'fontSize', 'autoSave', 'hideCodeminiFolder', 'isolation', 'workspaceTrust', 'myKeysAutoLock'];
    keys.forEach((k) => assert.strictEqual(C.isSecurityKey(k), SJ.isSecurity(k), k));
  });

  console.log('the store: created lazily, never overwritten');
  await t('the first file creates the folder and the file, in one write, under the workspace', async () => {
    const s = memStore();
    const r = await C._store.ensureFile(s, 'ws1', 'tasks.json', '{"tasks":[]}');
    assert.strictEqual(r.created, true); assert.strictEqual(s.writes, 1);
    const all = await s.getAll();
    const dir = all.find((x) => x.name === '.codemini'), f = all.find((x) => x.name === 'tasks.json');
    assert.deepStrictEqual([dir.type, dir.parentId, f.type, f.parentId, f.content, f.isLocked], ['folder', 'ws1', 'file', dir.id, '{"tasks":[]}', false]);
    assert.strictEqual(all.length, 2, 'nothing else was made (no settings.json, no local/)');
  });
  await t('a file that exists is returned as it is and never overwritten; a second file reuses the folder', async () => {
    const s = memStore();
    const a = await C._store.ensureFile(s, 'root', 'tasks.json', 'one');
    const again = await C._store.ensureFile(s, 'root', 'tasks.json', 'TWO');
    assert.deepStrictEqual([again.created, again.record.id, again.record.content], [false, a.record.id, 'one']);
    const b = await C._store.ensureFile(s, 'root', 'tests.json', '{}');
    assert.strictEqual(b.created, true);
    assert.strictEqual((await s.getAll()).filter((x) => x.name === '.codemini').length, 1);
    assert.strictEqual(s.writes, 2, 'the repeat wrote nothing');
  });
  await t('a nested name creates the folders in between, and reports them', async () => {
    const s = memStore();
    const r = await C._store.ensureFile(s, 'root', 'snippets/python.json', '{}');
    assert.deepStrictEqual(r.createdFolders, ['.codemini', 'snippets']);
    const all = await s.getAll(), sn = all.find((x) => x.name === 'snippets');
    assert.strictEqual(all.find((x) => x.name === 'python.json').parentId, sn.id);
  });
  await t('another workspace\'s top level is a different place: the same name there is created separately', async () => {
    const s = memStore();
    await C._store.ensureFile(s, 'ws1', 'tasks.json', 'a'); const b = await C._store.ensureFile(s, 'ws2', 'tasks.json', 'b');
    assert.strictEqual(b.created, true);
  });
  await t('a FILE in the way is an error with a clear message, and nothing is written', async () => {
    const s = memStore([file('x', '.codemini', 'root', 'oops')]);
    await assert.rejects(() => C._store.ensureFile(s, 'root', 'tasks.json', '{}'), /\.codemini is a file/);
    assert.strictEqual(s.writes, 0);
    const s2 = memStore([folder('c', '.codemini', 'root'), file('l', 'local', 'c')]);
    await assert.rejects(() => C._store.ensureFolder(s2, 'root', 'local'), /local is a file/);
    const s3 = memStore([folder('c', '.codemini', 'root'), folder('t', 'tasks.json', 'c')]);
    await assert.rejects(() => C._store.ensureFile(s3, 'root', 'tasks.json', '{}'), /tasks\.json is a folder/);
    assert.strictEqual(s3.writes, 0);
  });
  await t('an invalid name is refused before anything is read or written', async () => {
    const s = memStore();
    for (const bad of ['../x', '', '/a', 'a\\b']) await assert.rejects(() => C._store.ensureFile(s, 'root', bad, ''), /Not a valid name/);
    await assert.rejects(() => C._store.readFile(s, 'root', '../x'), /Not a valid name/);
    assert.strictEqual(s.writes, 0);
  });
  await t('reading: a missing file, a present one, a locked one (its text is not given out) and a folder of that name', async () => {
    const s = memStore([folder('c', '.codemini', 'root'), file('t', 'tasks.json', 'c', '{"a":1}'), file('k', 'tests.json', 'c', 'SECRETBLOB', { isLocked: true }), folder('d', 'deploy.json', 'c')]);
    assert.deepStrictEqual(await C._store.readFile(s, 'root', 'nope.json'), { exists: false, record: null, text: '', locked: false });
    const ok = await C._store.readFile(s, 'root', 'tasks.json'); assert.deepStrictEqual([ok.exists, ok.text, ok.locked], [true, '{"a":1}', false]);
    const lk = await C._store.readFile(s, 'root', 'tests.json'); assert.deepStrictEqual([lk.exists, lk.text, lk.locked], [true, '', true]);
    assert.strictEqual((await C._store.readFile(s, 'root', 'deploy.json')).exists, false, 'a folder is not a file');
    assert.strictEqual((await C._store.readFile(memStore(), 'root', 'tasks.json')).exists, false, 'no .codemini at all');
  });
  await t('an empty folder can be made (local/) and is not made twice', async () => {
    const s = memStore();
    const a = await C._store.ensureFolder(s, 'root', 'local'); const b = await C._store.ensureFolder(s, 'root', 'local');
    assert.deepStrictEqual([a.created, b.created, b.record.id === a.record.id], [true, false, true]);
    assert.deepStrictEqual((await s.getAll()).map((x) => x.name).sort(), ['.codemini', 'local']);
  });

  console.log('.gitignore in the store');
  await t('no .gitignore: one is created; an existing one is extended once; a locked one is left alone', async () => {
    const s = memStore();
    assert.deepStrictEqual(await C._store.addLocalToGitignore(s, 'root'), { changed: true, created: true, skipped: null });
    assert.match((await s.getAll())[0].content, /\.codemini\/local\//);
    assert.deepStrictEqual(await C._store.addLocalToGitignore(s, 'root'), { changed: false, created: false, skipped: null });
    const s2 = memStore([file('g', '.gitignore', 'root', 'dist\n')]);
    assert.deepStrictEqual(await C._store.addLocalToGitignore(s2, 'root'), { changed: true, created: false, skipped: null });
    assert.strictEqual((await s2.getAll()).length, 1); assert.match((await s2.getAll())[0].content, /^dist\n\n# CodeMini/);
    const s3 = memStore([file('g', '.gitignore', 'root', 'dist\n', { isLocked: true })]);
    assert.deepStrictEqual(await C._store.addLocalToGitignore(s3, 'root'), { changed: false, created: false, skipped: 'locked' });
    assert.strictEqual(s3.writes, 0);
  });
  await t('a .gitignore in a SUBFOLDER is not the workspace\'s', async () => {
    const s = memStore([folder('src', 'src', 'root'), file('g', '.gitignore', 'src', 'x\n')]);
    const r = await C._store.addLocalToGitignore(s, 'root');
    assert.strictEqual(r.created, true);
    assert.strictEqual((await s.getAll()).find((x) => x.id === 'g').content, 'x\n');
  });

  console.log('wiring');
  const html = read('index.html'), sw = read('sw.js');
  await t('the script loads after json-schemas.js (it registers schemas there) and is precached', () => {
    const tags = Array.from(html.matchAll(/<script src="([^"]+)"/g), (m) => m[1]);
    assert.ok(tags.indexOf('js/core/codemini-config.js') > tags.indexOf('js/core/json-schemas.js'));
    assert.ok(sw.includes("'/js/core/codemini-config.js'"));
  });
  await t('it writes no HTML and builds no DOM of its own', () => {
    const src = read('js/core/codemini-config.js').replace(/\/\/.*$/gm, '');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createElement/.test(src));
  });
  await t('Explorer leaves out hidden records and dims the folder; Quick Open and Search skip it unless asked', () => {
    const app = read('js/core/app.js');
    assert.ok(app.includes('window.CodeMiniConfig.explorerHiddenIds(allFiles)') && app.includes("classList.add('codemini-config')"));
    assert.ok(read('js/core/quick-open.js').includes('W.CodeMiniConfig.wantsConfig(query)') && read('js/core/quick-open.js').includes('isConfigPath(x.path)'));
    assert.ok(read('js/core/search.js').includes('window.CodeMiniConfig.withoutConfig(files, query)'));
    assert.ok(read('css/style.css').includes('.file-item.codemini-config'));
  });
  await t('the editor attaches a schema when a file tab opens, guarded so it can never break opening a file', () => {
    assert.match(read('js/core/editor.js'), /window\.CodeMiniConfig\.attachEditor\(editor, tab\); \} catch \(e\)/);
  });
  await t('"Hide .codemini Folder" is a default, a loaded value, a Settings row and redraws Explorer when changed', () => {
    const sp = read('js/core/settings-profile.js');
    assert.ok(/hideCodeminiFolder: false/.test(sp));
    assert.ok(sp.includes("hideCodeminiFolder: localStorage.getItem(getPrefixedKey('hideCodeminiFolder')) === 'true'"));
    assert.ok(sp.includes('data-setting="hideCodeminiFolder"'));
    assert.ok(/key === 'hideCodeminiFolder'\) && typeof loadFilesFromDB/.test(sp));
  });
  await t('the hide setting is a plain boolean in the User settings.json (it is not a security setting)', () => {
    const doc = SJ.buildDocument({ hideCodeminiFolder: false, fontSize: 13 }, { hideCodeminiFolder: true });
    assert.strictEqual(doc.hideCodeminiFolder, true);
  });
  console.log(n + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
