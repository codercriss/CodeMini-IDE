// The workspace config folder (feature 23) in the real app with a real IndexedDB: Explorer dims or hides it, Quick Open and Search skip it unless the
// query asks, files are created lazily and never overwritten, Restricted Mode gates running, and a schema is attached to a config file's model.
// Monaco is stubbed (its CDN is blocked here): the schema check uses a stand-in editor and the real CodeMiniJsonSchemas registry.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const NOISE = /monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i;

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { setTimeout(() => { window.monaco = mk(); cb(); }, 0); }; window.require.config = () => {};
  });
  await page.goto('http://localhost:8765/index.html'); await sleep(2600);
  const ev = (f, a) => page.evaluate(f, a);
  const names = () => ev(() => [...document.querySelectorAll('#fileList .file-item .file-name-wrap')].map(e => e.title));
  const reload = async () => { await ev(() => loadFilesFromDB()); await sleep(250); };

  // ---- a project: a .codemini folder (tasks, local state), source code, and a NESTED folder with the same name
  await ev(() => new Promise(res => {
    const tx = db.transaction('filesystem', 'readwrite'), st = tx.objectStore('filesystem'); const now = Date.now();
    const folder = (id, name, parentId) => st.put({ id, parentId, name, type: 'folder', isLocked: false, timestamp: now });
    const file = (id, name, parentId, content) => st.put({ id, parentId, name, type: 'file', isLocked: false, content, timestamp: now });
    folder('cfg', '.codemini', 'root'); folder('cfg-local', 'local', 'cfg'); folder('src', 'src', 'root'); folder('nested', '.codemini', 'src');
    file('cfg-tasks', 'tasks.json', 'cfg', '{ "note": "SECRETWORD see .codemini/local/ for state" }');
    file('cfg-state', 'state.json', 'cfg-local', '{"SECRETWORD": 1}');
    file('src-app', 'app.js', 'src', 'const SECRETWORD = 1;\n'); file('nested-x', 'x.json', 'nested', '{"SECRETWORD": 2}');
    file('readme', 'README.md', 'root', 'hello\n');
    tx.oncomplete = res;
  }));
  await reload();

  console.log('\n[1] Explorer');
  ok(await ev(() => !!window.CodeMiniConfig && typeof window.CodeMiniConfig.ensure === 'function'), 'the module is on window');
  ok((await names()).includes('.codemini'), 'the folder is listed by default');
  const dim = await ev(() => {
    const row = [...document.querySelectorAll('#fileList .file-item')].find(r => r.querySelector('.file-name-wrap').title === '.codemini');
    const other = [...document.querySelectorAll('#fileList .file-item')].find(r => r.querySelector('.file-name-wrap').title === 'src');
    return { cls: row.classList.contains('codemini-config'), color: getComputedStyle(row.querySelector('.file-name-wrap')).color, otherColor: getComputedStyle(other.querySelector('.file-name-wrap')).color, otherCls: other.classList.contains('codemini-config'), muted: getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() };
  });
  ok(dim.cls && !dim.otherCls, 'only the config folder is marked', dim);
  ok(dim.color !== dim.otherColor, 'and its name is dimmed compared with a normal folder', dim);
  await ev(() => saveSetting('hideCodeminiFolder', true)); await sleep(300);
  ok(!(await names()).includes('.codemini') && (await names()).includes('src'), 'with "Hide .codemini Folder" on it is gone and the rest stays', await names());
  ok(await ev(() => localStorage.getItem(Object.keys(localStorage).find(k => /hideCodeminiFolder$/.test(k))) === 'true'), 'the choice is stored');
  // the nested folder with the same name is not configuration: it is still there inside src
  await ev(() => { folderStack.push({ id: 'src', name: 'src' }); loadFilesFromDB(); }); await sleep(300);
  ok((await names()).includes('.codemini'), 'a folder with the same name deeper down is just a folder: still listed, even while hidden at the top');
  ok(await ev(() => [...document.querySelectorAll('#fileList .file-item')].every(r => !r.classList.contains('codemini-config'))), 'and not dimmed');
  await ev(() => { folderStack.pop(); loadFilesFromDB(); }); await sleep(250);
  // tree view: the folder cannot be reached by expanding either
  await ev(() => { window.isTreeViewMode = true; window.expandedFolders.add('cfg'); loadFilesFromDB(); }); await sleep(300);
  ok(!(await names()).includes('tasks.json') && !(await names()).includes('.codemini'), 'in tree view the hidden folder and its contents stay out even if it was expanded', await names());
  await ev(() => { window.isTreeViewMode = false; saveSetting('hideCodeminiFolder', false); }); await sleep(300);
  ok((await names()).includes('.codemini'), 'turning it off brings it back');

  console.log('\n[2] Quick Open');
  const input = '.top-center .search-bar input';
  const rows = () => ev(() => [...document.querySelectorAll('#topSearchIsland .qo-item')].map(r => ({ label: r.querySelector('.qo-label').textContent, detail: (r.querySelector('.qo-detail') || {}).textContent || '' })));
  const type = async (t) => { await page.fill(input, t); await sleep(300); };
  await page.keyboard.press('Control+P'); await sleep(400);
  let r = await rows();
  ok(!r.some(x => x.label === 'tasks.json' || x.label === 'state.json' || x.detail === '.codemini' || x.detail.startsWith('.codemini/')), 'the empty box does not list the config folder or its files', r.map(x => x.label + '|' + x.detail));
  ok(!r.some(x => x.label === 'local') && r.some(x => x.label === '.codemini' && x.detail === 'src/.codemini'), 'nor its subfolder, while the nested folder with the same name is listed as the ordinary folder it is', r.map(x => x.label + '|' + x.detail));
  await type('tasks'); r = await rows();
  ok(!r.some(x => x.label === 'tasks.json'), '"tasks" does not find .codemini/tasks.json', r.map(x => x.label + '|' + x.detail));
  await type('state'); r = await rows();
  ok(!r.some(x => x.label === 'state.json'), '"state" does not find .codemini/local/state.json');
  await type('app'); r = await rows();
  ok(r.some(x => x.label === 'app.js'), 'ordinary files are found as before', r.map(x => x.label));
  await type('x.json'); r = await rows();
  ok(r.some(x => x.label === 'x.json' && /src\/\.codemini/.test(x.detail)), 'a file in a nested folder named .codemini is an ordinary file', r.map(x => x.label + '|' + x.detail));
  await type('.codemini/tasks'); r = await rows();
  ok(r.some(x => x.label === 'tasks.json' && /\.codemini/.test(x.detail)), 'typing .codemini asks for it on purpose: tasks.json is found', r.map(x => x.label + '|' + x.detail));
  await type('.codemini/local'); r = await rows();
  ok(r.some(x => x.label === 'state.json'), 'and so is the file in its local/ folder', r.map(x => x.label));
  await page.keyboard.press('Escape'); await sleep(150);

  console.log('\n[3] Search');
  await ev(() => document.getElementById('searchIconItem').click()); await sleep(300);
  const search = async (q) => { await ev((q) => { const i = document.getElementById('globalSearchInput'); i.value = q; document.getElementById('runSearchBtn').click(); }, q); await sleep(500); return ev(() => [...document.querySelectorAll('#searchResultsContainer .search-result-item .search-result-file span')].map(s => s.textContent)); };
  let found = await search('SECRETWORD');
  ok(found.includes('app.js') && found.includes('x.json'), 'a content search finds ordinary files, including the nested folder\'s', found);
  ok(!found.includes('tasks.json') && !found.includes('state.json'), 'but not the config folder\'s', found);
  found = await search('.codemini/local');
  ok(found.includes('tasks.json'), 'a query that starts with .codemini searches it', found);
  await ev(() => document.getElementById('closeSearchBtn').click()); await sleep(150);

  console.log('\n[4] created lazily, never overwritten');
  ok(await ev(async () => { const r = await window.CodeMiniConfig.read('tests.json'); return !r.exists; }), 'tests.json does not exist yet');
  const made = await ev(async () => { const a = await window.CodeMiniConfig.ensure('tests.json', '{ "patterns": [] }'); return { created: a.created, parent: a.record.parentId, name: a.record.name }; });
  ok(made.created && made.name === 'tests.json' && made.parent === 'cfg', 'ensure creates the file inside the existing .codemini folder', made);
  const again = await ev(async () => { const a = await window.CodeMiniConfig.ensure('tests.json', 'OVERWRITTEN'); return { created: a.created, content: a.record.content }; });
  ok(!again.created && again.content === '{ "patterns": [] }', 'a second call leaves it alone', again);
  await sleep(300);
  const nested = await ev(async () => { const a = await window.CodeMiniConfig.ensure('snippets/python.json', '{}'); return { created: a.created, folders: a.createdFolders }; });
  ok(nested.created && JSON.stringify(nested.folders) === '["snippets"]', 'a nested name makes only the folder that was missing', nested);
  ok(await ev(() => window.CodeMiniConfig.read('../x').then(() => false, () => true)), 'a name that climbs out is refused');
  ok(await ev(async () => (await window.CodeMiniConfig.read('state.json')).exists === false), 'files are found by their place: state.json is in local/, not at the top');

  console.log('\n[5] reading config');
  await ev(() => new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put({ id: 'cfg-launch', parentId: 'cfg', name: 'launch.json', type: 'file', isLocked: false, content: '{\n // comment\n "a": 1,\n}\n', timestamp: 1 }); tx.objectStore('filesystem').put({ id: 'cfg-bad', parentId: 'cfg', name: 'deploy.json', type: 'file', isLocked: false, content: '{\n "a": 1\n "b": 2\n}', timestamp: 1 }); tx.objectStore('filesystem').put({ id: 'cfg-lock', parentId: 'cfg', name: 'extensions.json', type: 'file', isLocked: true, content: 'ENCRYPTEDBLOB', timestamp: 1 }); tx.oncomplete = res; }));
  const j1 = await ev(() => window.CodeMiniConfig.readJson('launch.json'));
  ok(j1.exists && j1.error === null && j1.value.a === 1, 'comments and a trailing comma are accepted', j1);
  const j2 = await ev(() => window.CodeMiniConfig.readJson('deploy.json'));
  ok(j2.exists && j2.value === null && j2.error && j2.error.line === 3, 'a broken file reports the line', j2);
  const j3 = await ev(() => window.CodeMiniConfig.readJson('extensions.json'));
  ok(j3.locked && j3.value === null && !JSON.stringify(j3).includes('ENCRYPTEDBLOB'), 'a locked file is reported as locked and its content is not handed out', j3);
  ok((await ev(() => window.CodeMiniConfig.readJson('agent.md.json'))).exists === false, 'a file that is not there is exists:false');

  console.log('\n[6] Restricted Mode');
  ok(await ev(() => window.CodeMiniConfig.canRun('tasks.json')), 'trusted: tasks.json may run');
  await ev(() => window.WorkspaceTrust.setTrust(undefined, false)); await sleep(150);
  const gate = await ev(() => ({ trusted: window.WorkspaceTrust.isTrusted(), tasks: window.CodeMiniConfig.canRun('tasks.json'), tests: window.CodeMiniConfig.canRun('tests.json'), launch: window.CodeMiniConfig.canRun('launch.json'), settings: window.CodeMiniConfig.canRun('settings.json'), agent: window.CodeMiniConfig.canRun('agent.md'), unknown: window.CodeMiniConfig.canRun('whatever.json') }));
  ok(!gate.trusted && !gate.tasks && !gate.tests && !gate.launch, 'restricted: files that can run something are not run', gate);
  ok(gate.settings && gate.agent && gate.unknown, 'while plain settings, notes and unknown files are not gated', gate);
  await ev(() => window.WorkspaceTrust.setTrust(undefined, true)); await sleep(150);
  ok(await ev(() => window.CodeMiniConfig.canRun('tasks.json')), 'trusting the workspace again allows it');

  console.log('\n[7] schemas attach to the config file\'s model');
  const sch = await ev(async () => {
    const calls = []; const realAdd = window.CodeMiniJsonSchemas.add;
    window.CodeMiniJsonSchemas.add = (uri, match, schema) => { calls.push({ uri, match, tag: schema && schema.title }); return true; };
    window.CodeMiniConfig.registerSchema('tasks.json', { title: 'tasks-schema', type: 'object' });
    const registered = calls.splice(0);
    const editor = (u) => ({ getModel: () => ({ uri: { toString: () => u } }) });
    const tab = (id) => ({ dataset: { fileId: id } });
    const out = {
      registered,
      tasks: await window.CodeMiniConfig.attachEditor(editor('inmemory://model/7'), tab('cfg-tasks')),
      afterTasks: calls.splice(0),
      ordinary: await window.CodeMiniConfig.attachEditor(editor('inmemory://model/8'), tab('src-app')),
      nested: await window.CodeMiniConfig.attachEditor(editor('inmemory://model/9'), tab('nested-x')),
      noSchema: await window.CodeMiniConfig.attachEditor(editor('inmemory://model/10'), tab('cfg-launch')),
      deeper: await window.CodeMiniConfig.attachEditor(editor('inmemory://model/11'), tab('cfg-state')),
      missing: await window.CodeMiniConfig.attachEditor(editor('inmemory://model/12'), tab('nope')),
      noTab: await window.CodeMiniConfig.attachEditor(editor('x'), null),
      noModel: await window.CodeMiniConfig.attachEditor({ getModel: () => null }, tab('cfg-tasks')),
      afterRest: calls.splice(0)
    };
    window.CodeMiniJsonSchemas.add = realAdd;
    return out;
  });
  ok(sch.registered.length === 1 && sch.registered[0].uri === 'codemini://schema/tasks.json' && sch.registered[0].match.length === 0, 'registering a schema makes it known by its codemini:// address (so $schema resolves with no network)', sch.registered);
  ok(sch.tasks === true && sch.afterTasks.length === 1 && sch.afterTasks[0].uri === 'codemini://schema/tasks.json' && JSON.stringify(sch.afterTasks[0].match) === '["inmemory://model/7"]', 'tasks.json: the schema is attached to that tab\'s model address', sch.afterTasks);
  ok(sch.ordinary === false && sch.nested === false && sch.noSchema === false && sch.deeper === false && sch.missing === false && sch.noTab === false && sch.noModel === false, 'nothing else gets one: an ordinary file, a nested .codemini, a config file with no schema registered, a file in local/, a missing id, no tab, no model', sch);
  ok(sch.afterRest.length === 0, 'and none of those called the registry', sch.afterRest);
  ok(await ev(() => window.CodeMiniJsonSchemas.list().some(s => s.uri === 'codemini://schema/tasks.json') === false), 'the stubbed registry did not leak into the real one');
  ok(await ev(() => { window.CodeMiniConfig.registerSchema('tests.json', { title: 'real' }); return window.CodeMiniJsonSchemas.list().some(s => s.uri === 'codemini://schema/tests.json'); }), 'with the real registry it is stored there');

  console.log('\n[9] Initialize .codemini');
  await ev(() => { window.__modals = []; const real = window.showCustomModal; window.__realModal = real; window.showCustomModal = (o, cb) => { window.__modals.push({ o, cb }); }; });
  const init = await ev(async () => window.CodeMiniConfig.initialize());
  ok(JSON.stringify(init) === '["settings.json"]', 'it creates only what is missing: the settings file (tasks.json and local/ were already there and are left alone)', init);
  const st = await ev(async () => { const r = await window.CodeMiniConfig.read('settings.json'); return { text: r.text, local: await new Promise(res => { db.transaction('filesystem').objectStore('filesystem').getAll().onsuccess = e => res(e.target.result.some(x => x.name === 'local' && x.parentId === 'cfg' && x.type === 'folder')); }) }; });
  ok(st.text === '{\n  "$schema": "codemini://schema/settings.json"\n}\n' && st.local, 'the starter settings file names its schema and does nothing else', st);
  const offer = await ev(() => window.__modals.map(m => m.o.title));
  ok(offer.length === 1 && offer[0] === 'Keep local state out of Git?', 'it offers to keep .codemini/local/ out of Git', offer);
  await ev(async () => { await window.__modals[0].cb(); }); await sleep(500);
  const gi = await ev(() => new Promise(res => { db.transaction('filesystem').objectStore('filesystem').getAll().onsuccess = e => { const g = e.target.result.find(x => x.name === '.gitignore' && x.parentId === 'root'); res(g ? g.content : null); }; }));
  ok(gi && /\.codemini\/local\//.test(gi), 'accepting creates .gitignore with the line', gi);
  await ev(async () => { window.__modals.length = 0; await window.CodeMiniConfig.initialize(); });
  ok(await ev(() => window.__modals.length === 0), 'a second Initialize creates nothing and does not ask again');
  await ev(() => { window.showCustomModal = window.__realModal; });

  console.log('\n[10] every setting is decided');
  const dec = await ev(() => { const d = Object.keys(window.getDefaultSettings()), C = window.CodeMiniConfig; return { all: d, allowedMissing: Array.from(C.WORKSPACE_ALLOWED).filter(k => !d.includes(k)), nonScalar: Array.from(C.WORKSPACE_ALLOWED).filter(k => !['boolean', 'number', 'string'].includes(typeof window.getDefaultSettings()[k])), personal: d.filter(k => !C.isSecurityKey(k) && !C.WORKSPACE_ALLOWED.has(k)).sort() }; });
  ok(dec.allowedMissing.length === 0 && dec.nonScalar.length === 0, 'every allowed setting exists and is a plain value', dec);
  const PERSONAL = ['activityBar', 'autoCheckUpdates', 'clearTrashOnExit', 'confirmBeforeExit', 'consoleAutoClear', 'consoleAutoInstall', 'consoleMaxHistory', 'consoleShowTimestamps', 'enableTrashBin', 'historyMaxDays', 'historyMaxEntries', 'hotExit', 'localHistory', 'maxMemory',
    'nbAutoInstall', 'nbClearOnRestart', 'nbConfirmDelete', 'performanceMode', 'profileAccentTint', 'restoreSession', 'showWindowBar', 'sidebarPosition', 'termHistorySize', 'windowOpacity'];
  ok(JSON.stringify(dec.personal) === JSON.stringify(PERSONAL), 'each setting is allowed, a security setting, or on the reviewed personal list: a NEW setting fails here until someone decides whether a workspace may set it', { notDecided: dec.personal.filter(k => !PERSONAL.includes(k)), gone: PERSONAL.filter(k => !dec.personal.includes(k)) });

  console.log('\n[11] the workspace settings overlay');
  await ev(() => { window.__notes = []; window.CodeMiniNotifications.onChange(l => { window.__notes = l; }); window.__monacoUpdates = 0; window.updateMonacoGlobalSettings = () => { window.__monacoUpdates++; }; window.__opened = []; window.openFileInTab = (f) => { window.__opened.push(f.name); }; });
  const userKey = (k) => ev((k) => Object.keys(localStorage).filter(x => new RegExp('(^|_)' + k + '$').test(x)).map(x => localStorage.getItem(x)), k);
  await ev(() => { saveSetting('fontSize', 14); saveSetting('tabSize', 4); saveSetting('enableTrashBin', true); });
  // Overwrites the settings file Initialize made (one file, one id), as saving it in an editor tab would.
  const putSettings = (text) => ev((text) => new Promise(res => { const st0 = db.transaction('filesystem').objectStore('filesystem').getAll(); st0.onsuccess = () => { const cur = st0.result.find(x => x.name === 'settings.json' && x.parentId === 'cfg'); const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put(Object.assign({ id: 'cfg-settings', parentId: 'cfg', name: 'settings.json', type: 'file', isLocked: false, timestamp: 1 }, cur || {}, { content: text, timestamp: Date.now() })); tx.oncomplete = () => { loadFilesFromDB(); res(); }; }; }), text);
  await putSettings('{\n // project style\n "$schema": "codemini://schema/settings.json",\n "fontSize": 17,\n "wordWrap": "on",\n "enableTrashBin": false,\n "isolationMode": "Normal",\n "tabSize": "two",\n}\n');
  await sleep(500);
  let eff = await ev(() => ({ fontSize: appSettings.fontSize, wordWrap: appSettings.wordWrap, trash: appSettings.enableTrashBin, iso: appSettings.isolationMode, tab: appSettings.tabSize, monaco: window.__monacoUpdates, over: window.CodeMiniConfig.isOverridden('fontSize'), notOver: window.CodeMiniConfig.isOverridden('tabSize') }));
  ok(eff.fontSize === 17 && eff.wordWrap === 'on' && eff.over, 'the workspace\'s display settings are what the app uses', eff);
  ok(eff.trash === true && eff.iso !== 'Normal' && eff.tab === 4 && !eff.notOver, 'a personal setting, a security setting and a wrongly typed value are NOT applied', eff);
  ok(eff.monaco >= 1, 'the editor is told (the usual side effect of changing the setting ran)', eff);
  ok((await userKey('fontSize')).every(v => v === '14'), 'and nothing was written into the person\'s own settings', await userKey('fontSize'));
  const note = await ev(() => window.__notes.find(n => n.id === 'ws-settings-problems'));
  ok(note && /enableTrashBin/.test(note.text) && /isolationMode/.test(note.text) && /tabSize/.test(note.text) && /personal setting/.test(note.text) && /security setting/.test(note.text), 'a notification says which lines were not applied, and why', note);
  ok(await ev(() => window.CodeMiniConfig.userSettingsView(appSettings).fontSize === 14 && window.CodeMiniConfig.userSettingsView(appSettings).wordWrap !== 'on'), 'the person\'s own view (what the User settings.json shows) still has their value, not the workspace\'s');

  console.log('\n[12] the Settings screen');
  await ev(() => window.openSettingsTab('editor')); await sleep(600);
  const ui = await ev(() => {
    const c = document.querySelector('.settings-container'), input = c.querySelector('[data-setting="fontSize"]'), row = input.closest('.settings-item'), other = c.querySelector('[data-setting="tabSize"]');
    const badge = row.querySelector('.ws-badge');
    return { value: input.value, disabled: input.disabled, locked: row.classList.contains('ws-locked'), badge: badge && badge.textContent, tag: badge && badge.tagName, title: badge && badge.title, otherDisabled: other.disabled, otherBadge: !!other.closest('.settings-item').querySelector('.ws-badge'), badges: c.querySelectorAll('.ws-badge').length };
  });
  ok(ui.value === '17' && ui.disabled && ui.locked, 'an overridden control shows the workspace\'s value and is locked', ui);
  ok(ui.badge === 'Set by workspace' && ui.tag === 'BUTTON' && /settings\.json/.test(ui.title), 'with a "Set by workspace" badge (a button) that explains and leads to the file', ui);
  ok(!ui.otherDisabled && !ui.otherBadge, 'other settings are untouched', ui);
  const wordWrapBadge = await ev(() => !!document.querySelector('[data-setting="wordWrap"]').closest('.settings-item').querySelector('.ws-badge'));
  ok(wordWrapBadge && (await ev(() => document.querySelectorAll('.ws-badge').length)) === 2, 'one badge per overridden setting (two here), and syncing again does not stack more', await ev(() => document.querySelectorAll('.ws-badge').length));
  await ev(() => { syncUI(); syncUI(); });
  ok((await ev(() => document.querySelectorAll('.ws-badge').length)) === 2, 'repeated syncs keep exactly one badge each');
  await ev(() => { window.__opened.length = 0; document.querySelector('[data-setting="fontSize"]').closest('.settings-item').querySelector('.ws-badge').click(); }); await sleep(400);
  ok(await ev(() => window.__opened.includes('settings.json')), 'the badge opens .codemini/settings.json', await ev(() => window.__opened));
  // saving the person's own value while it is overridden: kept for them, not used
  await ev(() => saveSetting('fontSize', 20)); await sleep(100);
  ok(await ev(() => appSettings.fontSize === 17) && (await userKey('fontSize')).every(v => v === '20'), 'saving the setting meanwhile stores THEIR value and keeps using the workspace\'s');

  console.log('\n[13] taking it back');
  await putSettings('{ "wordWrap": "on" }'); await sleep(500);
  const back = await ev(() => { const input = document.querySelector('[data-setting="fontSize"]'), row = input.closest('.settings-item'); return { fontSize: appSettings.fontSize, disabled: input.disabled, badge: !!row.querySelector('.ws-badge'), locked: row.classList.contains('ws-locked'), wrap: appSettings.wordWrap, over: window.CodeMiniConfig.isOverridden('fontSize') }; });
  ok(back.fontSize === 20 && !back.over, 'removing the line gives the person\'s own value back (the one they saved meanwhile)', back);
  ok(!back.disabled && !back.badge && !back.locked && back.wrap === 'on', 'the control is unlocked and the badge gone, while the other override stays', back);
  const brk = await (async () => { await putSettings('{\n "fontSize": 30\n "wordWrap": "on"\n}'); await sleep(500); return ev(() => ({ fontSize: appSettings.fontSize, wrap: appSettings.wordWrap, note: (window.__notes.find(n => n.id === 'ws-settings-problems') || {}).title, text: (window.__notes.find(n => n.id === 'ws-settings-problems') || {}).text })); })();
  ok(brk.fontSize === 20 && brk.wrap !== 'on' && /not applied/i.test(brk.note) && /line 3/.test(brk.text), 'a broken file applies NOTHING (not half of it), and the notification gives the line', brk);
  await putSettings('{ "fontSize": 25 }'); await sleep(500);
  ok(await ev(() => appSettings.fontSize === 25), 'fixing the file applies it');
  await putSettings('{ "fontSize": 25, "wordWrap": "banana" }'); await sleep(500);
  ok(await ev(() => appSettings.wordWrap !== 'banana' && appSettings.fontSize === 25 && /must be one of "off", "on"/.test((window.__notes.find(n => n.id === 'ws-settings-problems') || {}).text)), 'a value that is not one of the Settings screen\'s options is refused, with the options (the valid line beside it still applies)', await ev(() => (window.__notes.find(n => n.id === 'ws-settings-problems') || {}).text));

  console.log('\n[14] another workspace, and coming back');
  await putSettings('{ "fontSize": 18 }'); await sleep(500);
  ok(await ev(() => appSettings.fontSize === 18), 'back to a file that applies');
  await ev(() => new Promise(res => { window.__rootDb = db.name; window.__rootStack = folderStack; initDatabase('CodeMiniDB_WS_cfgtest', () => { folderStack = [{ id: 'wsx', name: 'X', isWorkspaceRoot: true, parentDb: cellActiveWindow.db }]; loadFilesFromDB(); res(); }); })); await sleep(600);
  const other = await ev(() => ({ fontSize: appSettings.fontSize, over: window.CodeMiniConfig.isOverridden('fontSize') }));
  ok(other.fontSize === 20 && !other.over, 'inside a workspace with no settings file, the other workspace\'s value is gone', other);
  await ev(() => new Promise(res => { initDatabase(window.__rootDb, () => { folderStack = window.__rootStack; loadFilesFromDB(); res(); }); })); await sleep(600);
  ok(await ev(() => appSettings.fontSize === 18), 'and it applies again when that workspace is open');
  await ev(() => new Promise(res => { const st0 = db.transaction('filesystem').objectStore('filesystem').getAll(); st0.onsuccess = () => { const cur = st0.result.find(x => x.name === 'settings.json' && x.parentId === 'cfg'); const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').delete(cur.id); tx.oncomplete = () => { loadFilesFromDB(); res(); }; }; })); await sleep(500);
  ok(await ev(() => appSettings.fontSize === 20 && !window.CodeMiniConfig.isOverridden('fontSize')), 'deleting the file removes every override');

  console.log('\n[15] the workspace settings schema');
  const wsch = await ev(() => { const sc = window.CodeMiniConfig.schemaFor('settings.json'); return sc && { has: Object.keys(sc.properties), extra: sc.additionalProperties, fontSize: sc.properties.fontSize, wordWrap: sc.properties.wordWrap }; });
  ok(wsch && wsch.has.includes('$schema') && wsch.has.includes('fontSize') && wsch.has.includes('wordWrap'), 'it offers $schema and the settings a workspace may set', wsch && wsch.has.length);
  ok(wsch && !wsch.has.includes('enableTrashBin') && !wsch.has.includes('isolationMode') && !wsch.has.includes('hotExit') && wsch.extra === false, 'and not the personal or security ones: Monaco flags them as not allowed', wsch && wsch.extra);
  ok(wsch && wsch.fontSize.type === 'number' && Array.isArray(wsch.wordWrap.enum) && wsch.wordWrap.enum.includes('on'), 'with the Settings screen\'s own types and options (so Monaco offers "on" and "off" for wordWrap)', wsch);

  console.log('\n[16] commands and the menu entry');
  await ev(() => { window.openFileInTab = (f) => { window.__opened.push(f.name); }; window.__opened.length = 0; });
  await page.keyboard.press('Control+P'); await sleep(400);
  await page.fill(input, '>workspace'); await sleep(350);
  const cmds = await rows();
  ok(cmds.some(x => x.label === 'Open Workspace Settings (JSON)'), 'the palette has "Open Workspace Settings (JSON)"', cmds.map(x => x.label));
  await page.fill(input, '>initialize'); await sleep(350);
  ok((await rows()).some(x => x.label === 'Initialize .codemini'), 'and "Initialize .codemini"');
  await page.fill(input, '>workspace'); await sleep(350);
  await page.keyboard.press('Enter'); await sleep(700);
  ok(await ev(() => window.__opened.includes('settings.json')), 'running it opens (and creates, if needed) .codemini/settings.json', await ev(() => window.__opened));
  await ev(() => document.getElementById('workspaceMenuBtn').click()); await sleep(700);
  const menu = await ev(() => { const e = document.querySelector('#workspaceDropdown .ws-config-entry'); return { has: !!e, text: e && e.textContent.trim(), last: e && e === e.parentNode.lastElementChild }; });
  ok(menu.has && menu.text === 'Workspace settings' && menu.last, 'the workspace menu ends with "Workspace settings"', menu);
  await ev(() => document.getElementById('workspaceMenuBtn').click()); await sleep(500);
  ok(await ev(() => document.querySelectorAll('#workspaceDropdown .ws-config-entry').length) === 1, 'opening the menu again does not add a second one');
  await ev(() => { window.__opened.length = 0; document.querySelector('#workspaceDropdown .ws-config-entry').click(); }); await sleep(500);
  ok(await ev(() => window.__opened.includes('settings.json') && !document.getElementById('workspaceDropdown').classList.contains('show')), 'clicking it opens the file and closes the menu');

  console.log('\n[8] the setting');
  ok(await ev(() => window.getDefaultSettings().hideCodeminiFolder === false && typeof window.appSettings.hideCodeminiFolder === 'boolean'), 'a default of false, loaded as a boolean');
  ok(await ev(() => window.CodeMiniSettingsJson && (() => { const d = window.CodeMiniSettingsJson.buildDocument(window.getDefaultSettings(), window.appSettings); return 'hideCodeminiFolder' in d; })()), 'and it is a normal (non-security) entry in the User settings.json');

  const rel = errors.filter(e => !NOISE.test(e));
  ok(rel.length === 0, 'no unexpected page errors', rel);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
