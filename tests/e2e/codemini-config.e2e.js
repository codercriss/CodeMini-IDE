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

  console.log('\n[8] the setting');
  ok(await ev(() => window.getDefaultSettings().hideCodeminiFolder === false && typeof window.appSettings.hideCodeminiFolder === 'boolean'), 'a default of false, loaded as a boolean');
  ok(await ev(() => window.CodeMiniSettingsJson && (() => { const d = window.CodeMiniSettingsJson.buildDocument(window.getDefaultSettings(), window.appSettings); return 'hideCodeminiFolder' in d; })()), 'and it is a normal (non-security) entry in the User settings.json');

  const rel = errors.filter(e => !NOISE.test(e));
  ok(rel.length === 0, 'no unexpected page errors', rel);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
