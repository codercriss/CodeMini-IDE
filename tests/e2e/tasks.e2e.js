// Tasks (feature 2) in the real app with a real IndexedDB. The isolated runner is not available here (it is a second origin on the network), so
// window.CodeMiniExec is replaced by a controllable stand-in that behaves like the host: it streams events and ends, fails, or waits to be killed.
// The icon font is blocked in this harness (no network), so icon-only buttons have no size: they are clicked through the DOM.
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
  const S = '#tasksSidebar';

  // ---- stand-ins: the host, the opener, the toast
  await ev(() => {
    window.__runs = []; window.__kills = 0; window.__killRej = null; window.__opened = []; window.__clicked = []; window.__toasts = [];
    window.CodeMiniExec = { use: async () => window.__useOk !== false, fallbackNotice: () => 'Isolation is off for the Terminal', kill() { window.__kills++; if (window.__killRej) window.__killRej(new Error('host killed')); }, run: (w, req, onOut) => { window.__runs.push(req); return window.__impl(req, onOut); } };
    window.__impl = async () => ({});
    window.openFileInTab = (f) => { window.__opened.push(f.name); };
    window.handleFileClick = (f) => { window.__clicked.push(f.name); };
    window.showSuccessToast = (m) => { window.__toasts.push(m); };
    window.__chatty = (ms) => async (req, onOut) => { onOut({ kind: 'stdout', text: 'building\n' }); onOut({ kind: 'stderr', text: 'oops at src/app.js:12:5\n' }); await new Promise(r => setTimeout(r, ms)); return {}; };
  });
  const records = () => ev(() => new Promise(res => { db.transaction('filesystem').objectStore('filesystem').getAll().onsuccess = e => res(e.target.result); }));
  const putTasks = (value) => ev((value) => new Promise(res => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const st0 = db.transaction('filesystem').objectStore('filesystem').getAll();
    st0.onsuccess = () => {
      const all = st0.result, cfg = all.find(x => x.name === '.codemini' && x.parentId === 'root'), cur = all.find(x => x.name === 'tasks.json' && cfg && x.parentId === cfg.id);
      const tx = db.transaction('filesystem', 'readwrite'), st = tx.objectStore('filesystem');
      if (!cfg) st.put({ id: 'cfg', parentId: 'root', name: '.codemini', type: 'folder', isLocked: false, timestamp: 1 });
      st.put(Object.assign({ id: 'tk-file', parentId: cfg ? cfg.id : 'cfg', name: 'tasks.json', type: 'file', isLocked: false, timestamp: 1 }, cur || {}, { content: text, timestamp: Date.now() }));
      tx.oncomplete = () => { loadFilesFromDB(); res(); };
    };
  }), value);
  const removeTasks = () => ev(() => new Promise(res => { const g = db.transaction('filesystem').objectStore('filesystem').getAll(); g.onsuccess = () => { const cur = g.result.find(x => x.name === 'tasks.json'); if (!cur) { res(); return; } const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').delete(cur.id); tx.oncomplete = () => { loadFilesFromDB(); res(); }; }; }));
  const rows = () => ev(() => [...document.querySelectorAll('#tasksSidebar .tk-row')].map(r => ({ label: r.dataset.label, state: r.dataset.state, cmd: r.querySelector('.tk-cmd').textContent, pill: !!r.querySelector('.tk-pill'), invalid: r.classList.contains('tk-invalid'), playDisabled: (r.querySelector('.tk-play') || { disabled: null }).disabled, playTitle: (r.querySelector('.tk-play') || {}).title, sec: r.closest('.tk-sec').querySelector('.sb-section-header span').firstChild.textContent })));
  const sections = () => ev(() => [...document.querySelectorAll('#tasksSidebar .tk-sec .sb-section-header')].map(h => h.querySelector('span').firstChild.textContent + ':' + h.querySelector('.sb-count-badge').textContent));
  const click = (sel) => ev((sel) => document.querySelector(sel).click(), sel);
  const settle = (ms) => sleep(ms || 350);
  // seed the workspace: source files a task can run and a link can open
  await ev(() => new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'), st = tx.objectStore('filesystem'), now = Date.now();
    st.put({ id: 'src', parentId: 'root', name: 'src', type: 'folder', isLocked: false, timestamp: now }); st.put({ id: 'src-app', parentId: 'src', name: 'app.js', type: 'file', isLocked: false, content: 'const a = 1;\n', timestamp: now });
    st.put({ id: 'tests', parentId: 'root', name: 'tests', type: 'folder', isLocked: false, timestamp: now }); st.put({ id: 'tests-run', parentId: 'tests', name: 'run.py', type: 'file', isLocked: false, content: 'print("tests")\n', timestamp: now });
    tx.oncomplete = res; }));

  console.log('\n[1] the entry points, with no tasks');
  ok(await ev(() => { const m = document.getElementById('menuTasks'), t = document.getElementById('menuTests'); return !!m && m.parentNode === t.parentNode && m.nextElementSibling === t && m.parentNode.id === 'mainMenuDropdown'; }), '"Tasks" is in the overflow menu, right before Test Explorer');
  ok(await ev(() => document.querySelector('#menuTasks i').className === 'ri-list-check-2' && /Tasks/.test(document.getElementById('menuTasks').textContent)), 'with the list-check icon');
  ok(await ev(() => getComputedStyle(document.getElementById('statusTasksToggle')).display === 'none'), 'the status bar item is hidden while there is nothing to show');
  await ev(() => document.getElementById('menuTasks').click()); await settle(500);
  const open1 = await ev(() => { const s = document.getElementById('tasksSidebar'); return { open: s.classList.contains('open'), w: s.offsetWidth, active: document.getElementById('menuTasks').classList.contains('active'), resizer: !!s.querySelector('.sidebar-resizer'), title: s.querySelector('.sb-title').textContent, menuShown: document.getElementById('mainMenuDropdown').classList.contains('show') }; });
  ok(open1.open && open1.w === 300 && open1.active && !open1.menuShown, 'clicking it opens a 300px sidebar and closes the menu', open1);
  ok(open1.title === 'Tasks' && open1.resizer, 'titled Tasks, with the usual resize handle', open1);
  ok(await ev(() => !!document.querySelector('#tasksSidebar .tk-emptystate') && /No tasks yet/.test(document.querySelector('#tasksSidebar .tk-emptystate').textContent) && document.querySelector('#tasksSidebar .tk-emptystate .tk-btn').textContent === 'Configure Tasks'), 'with no file it says "No tasks yet" and offers Configure Tasks');
  const hdr = await ev(() => [...document.querySelectorAll('#tasksSidebar .sb-header button')].map(b => b.getAttribute('aria-label')));
  ok(JSON.stringify(hdr) === JSON.stringify(['Refresh tasks', 'Create tasks.json', 'Close']), 'the header has refresh, "+" (create) and close', hdr);
  ok(await ev(() => localStorage.length > 0 && Object.keys(localStorage).some(k => { try { return JSON.parse(localStorage.getItem(k)).sidebar === 'tasks'; } catch (e) { return false; } })), 'the open sidebar is remembered for Restore Session');
  await ev(() => document.querySelector('#tasksSidebar .sb-header button[aria-label="Close"]').click()); await settle(400);
  ok(await ev(() => !document.getElementById('tasksSidebar').classList.contains('open') && !document.getElementById('menuTasks').classList.contains('active')), 'Close closes it');
  await ev(() => document.getElementById('menuTasks').click()); await settle(300);
  await ev(() => document.getElementById('menuTasks').click()); await settle(300);
  ok(await ev(() => !document.getElementById('tasksSidebar').classList.contains('open')), 'the menu item toggles it');
  await ev(() => document.getElementById('folderIconItem').click()); await settle(300);
  ok(await ev(() => !document.getElementById('tasksSidebar').classList.contains('open') && document.getElementById('explorerSidebar').classList.contains('open')), 'opening another sidebar closes it');

  console.log('\n[2] Configure Tasks: create from a template');
  await ev(() => document.getElementById('menuTasks').click()); await settle(300);
  await click('#tasksSidebar .sb-header button[aria-label="Create tasks.json"]'); await settle(250);
  const tm = await ev(() => [...document.querySelectorAll('#tasksSidebar .tk-menu-item')].map(b => b.textContent));
  ok(JSON.stringify(tm) === JSON.stringify(['Empty', 'JavaScript scripts', 'Python', 'SQL']), '"+" offers Empty, JavaScript scripts, Python and SQL', tm);
  await click('#tasksSidebar .tk-menu-item[data-template="python"]'); await settle(700);
  const created = (await records()).find(r => r.name === 'tasks.json');
  ok(created && /"lang": "python"/.test(created.content) && /codemini:\/\/schema\/tasks\.json/.test(created.content), 'choosing Python creates .codemini/tasks.json from that template', created && created.content.slice(0, 80));
  ok(await ev(() => window.__opened.includes('tasks.json')), 'and opens it in an editor tab');
  ok(JSON.stringify(await sections()) === '["BUILD:1","TEST:1"]', 'the list fills in at once: BUILD and TEST', await sections());
  ok(await ev(() => !document.querySelector('#tasksSidebar .tk-menu')), 'and the template menu is gone');
  await removeTasks(); await settle(400);
  ok(await ev(() => !!document.querySelector('#tasksSidebar .tk-emptystate')), 'deleting the file empties the list');
  await ev(() => { window.__opened.length = 0; }); await click('#tasksSidebar .tk-emptystate .tk-btn'); await settle(250);
  ok(await ev(() => !!document.querySelector('#tasksSidebar .tk-menu')), '"Configure Tasks" with no file opens the template menu');
  await click('#tasksSidebar .tk-menu-item[data-template="empty"]'); await settle(600);
  ok(await ev(() => /No tasks yet/.test(document.querySelector('#tasksSidebar .tk-emptystate').textContent) && /has no tasks/.test(document.querySelector('#tasksSidebar .tk-emptystate').textContent) && document.querySelector('#tasksSidebar .tk-emptystate .tk-btn').textContent === 'Open tasks.json'), 'an empty file says so and offers to open it');
  await ev(() => { window.__opened.length = 0; }); await click('#tasksSidebar .tk-emptystate .tk-btn'); await settle(500);
  ok(await ev(() => window.__opened.includes('tasks.json')), 'which opens the file');

  console.log('\n[3] the list');
  await putTasks({ version: 1, tasks: [
    { label: 'Build', group: 'build', default: true, lang: 'javascript', script: "console.log('building');\nconsole.log(2)" },
    { label: 'Test', group: 'test', command: 'python tests/run.py', detail: 'Runs the suite.' },
    { label: 'Hello', lang: 'python', script: 'print("hi")' },
    { label: 'Broken', command: 'npm test' }
  ] }); await settle(500);
  ok(JSON.stringify(await sections()) === '["BUILD:1","TEST:1","CUSTOM:2"]', 'tasks are grouped Build, Test, Custom, each with a count', await sections());
  let r = await rows();
  ok(r.map(x => x.label).join() === 'Build,Test,Hello,Broken', 'in file order within each group', r.map(x => x.label));
  ok(r[0].cmd === "console.log('building');" && r[1].cmd === 'python tests/run.py', 'each shows its command in the mono line (a script shows its first line)', r.map(x => x.cmd));
  ok(r[0].pill && !r[1].pill, 'the default task carries a DEFAULT pill', r);
  ok(r[3].invalid && /npm is not available here/.test(r[3].cmd) && r[3].playDisabled === true, 'a task that cannot run shows why, and its play button is disabled', r[3]);
  ok(r[0].playDisabled === false && r[0].playTitle === 'Run Build', 'a good one has an enabled play button named for it', r[0]);
  ok(await ev(() => { const row = document.querySelector('#tasksSidebar .tk-row'), play = row.querySelector('.tk-play'); return getComputedStyle(play).opacity === '0'; }), 'play is hidden until you hover the row');
  await page.hover('#tasksSidebar .tk-row'); await sleep(150);
  ok(await ev(() => Number(getComputedStyle(document.querySelector('#tasksSidebar .tk-row .tk-play')).opacity) > 0.5), 'and appears on hover');
  ok(await ev(() => { const d = document.querySelector('#tasksSidebar .tk-row[data-label="Build"] .tk-detail'); const t = document.querySelector('#tasksSidebar .tk-row[data-label="Test"] .tk-detail'); return !d && t && t.textContent === 'Runs the suite.'; }), 'a "detail" note shows under its task, and only under that one');
  ok(await ev(() => { const cmd = document.querySelector('#tasksSidebar .tk-row .tk-cmd'); return getComputedStyle(cmd).fontFamily !== getComputedStyle(document.body).fontFamily && getComputedStyle(cmd).fontSize === '11px'; }), 'the command is in the mono font (not the body font), 11px');
  ok(await ev(() => { const row = document.querySelector('#tasksSidebar .tk-row'); return getComputedStyle(row).borderBottomStyle === 'dashed'; }), 'rows are flat with a dashed bottom border, like Notifications');
  ok(await ev(() => document.querySelectorAll('#tasksSidebar .tk-row').length === 4 && document.querySelector('#tasksSidebar .tk-banner') === null), 'no banner when the file is fine');
  ok(await ev(() => { const s = window.CodeMiniTasks.state(); return s.file.tasks.length === 4 && s.file.problems.some(p => /npm is not available/.test(p.message)); }), 'the problem is in the state too (for the palette and the shortcut)');

  console.log('\n[4] running a task');
  await ev(() => { window.__runs.length = 0; window.__impl = window.__chatty(1300); });
  await page.hover('#tasksSidebar .tk-row'); await click('#tasksSidebar .tk-row[data-label="Build"] .tk-play'); await sleep(250);
  const run1 = await ev(() => { const row = document.querySelector('#tasksSidebar .tk-row[data-label="Build"]'), st = document.getElementById('statusTasksToggle'), other = document.querySelector('#tasksSidebar .tk-row[data-label="Test"] .tk-play'); return { rowState: row.dataset.state, stop: !!row.querySelector('.tk-stop'), play: !!row.querySelector('.tk-play'), spin: !!row.querySelector('.tk-lead.tk-spin'), status: st.textContent, statusState: st.dataset.state, statusShown: getComputedStyle(st).display !== 'none', statusTitle: st.title, otherDisabled: other.disabled, otherTitle: other.title, panel: document.getElementById('problemsPanel').style.display, tab: document.querySelector('.bottom-panel-tab[data-target="tasksPanelContent"]').classList.contains('active'), outShown: getComputedStyle(document.getElementById('tasksPanelContent')).display, head: document.getElementById('tasksOutputHead').textContent, runs: window.__runs.length, running: window.CodeMiniTasks.state().running }; });
  ok(run1.rowState === 'running' && run1.stop && !run1.play && run1.spin, 'the row shows a spinner and a Stop button instead of play', run1);
  ok(run1.statusShown && run1.statusState === 'running' && /Build/.test(run1.status) && /Running: Build/.test(run1.statusTitle), 'the status bar item (after the bug icon) shows the spinner and the name', run1);
  ok(run1.otherDisabled && /Another task is running/.test(run1.otherTitle), 'other tasks cannot start meanwhile, and say why', run1);
  ok(run1.panel === 'flex' && run1.tab && run1.outShown === 'flex', 'the bottom panel opens on its Tasks tab', run1);
  ok(/Build/.test(run1.head) && /Running/.test(run1.head), 'whose header names the task and says Running', run1.head);
  ok(await ev(() => window.__runs[0].lang === 'javascript' && window.__runs[0].code.startsWith("console.log('building');")), 'the host got the script as JavaScript', await ev(() => window.__runs[0]));
  const lines = await ev(() => [...document.querySelectorAll('#tasksOutputBody .tk-line')].map(l => ({ time: l.querySelector('.tk-time').textContent, text: l.querySelector('.tk-text').textContent, cls: l.className })));
  ok(lines.length >= 3 && lines.every(l => /^\d\d:\d\d:\d\d$/.test(l.time)), 'output lines carry a timestamp', lines);
  ok(lines[0].text === '> console.log(\'building\');   (javascript)' && lines[0].cls.includes('tk-sys') && lines[1].text === 'building' && lines[2].cls.includes('tk-err'), 'the command, then stdout, then stderr in red', lines);
  const link = await ev(() => [...document.querySelectorAll('#tasksOutputBody .tk-link')].map(a => ({ text: a.textContent, role: a.getAttribute('role'), tab: a.tabIndex, title: a.title, color: getComputedStyle(a).color })));
  ok(link.length === 1 && link[0].text === 'src/app.js:12:5' && link[0].role === 'link' && link[0].tab === 0 && /Open src\/app\.js at line 12/.test(link[0].title), 'a file:line in the output is a link, reachable by keyboard', link);
  await sleep(900);
  const reg = await ev(() => window.CodeMiniBackground.running().map(x => ({ kind: x.kind, title: x.title, stoppable: x.stoppable })));
  ok(reg.length === 1 && reg[0].kind === 'task' && reg[0].title === 'Task: Build' && reg[0].stoppable, 'a run that lasts is in the Now Island RUNNING list, with Stop', reg);
  await sleep(700);
  const done1 = await ev(() => { const row = document.querySelector('#tasksSidebar .tk-row[data-label="Build"]'), st = document.getElementById('statusTasksToggle'); return { rowState: row.dataset.state, lead: row.querySelector('.tk-lead').className, status: st.textContent, statusState: st.dataset.state, icon: st.querySelector('i').className, head: document.getElementById('tasksOutputHead').textContent, last: [...document.querySelectorAll('#tasksOutputBody .tk-line .tk-text')].pop().textContent, play: !!row.querySelector('.tk-play'), otherDisabled: document.querySelector('#tasksSidebar .tk-row[data-label="Test"] .tk-play').disabled, fin: window.CodeMiniBackground.finished().map(x => x.title + ':' + x.state) }; });
  ok(done1.rowState === 'success' && /tk-ok/.test(done1.lead) && done1.play, 'afterwards the row shows a green check and play is back', done1);
  ok(done1.statusState === 'success' && /tk-ok/.test(done1.icon) && /Build/.test(done1.status), 'the status bar item shows a green check and the name, and keeps it', done1);
  ok(/Done/.test(done1.head) && /^Done in /.test(done1.last), 'the tab says Done and the last line says how long it took', done1);
  ok(!done1.otherDisabled, 'other tasks can run again', done1);
  ok(done1.fin.includes('Task: Build:success'), 'and it is in RECENTLY FINISHED', done1.fin);

  console.log('\n[5] the shortcut, "Run again", and a second run clears the output');
  await ev(() => { window.__runs.length = 0; window.__impl = window.__chatty(100); });
  await page.keyboard.press('Control+Shift+B'); await sleep(600);
  ok(await ev(() => window.__runs.length === 1 && window.__runs[0].code.startsWith("console.log('building');")), 'Ctrl+Shift+B runs the default build task', await ev(() => window.__runs.length));
  ok(await ev(() => document.querySelectorAll('#tasksOutputBody .tk-line').length <= 5 && /^> console/.test(document.querySelector('#tasksOutputBody .tk-line .tk-text').textContent)), 'the output starts afresh for each run');
  await ev(() => { window.__runs.length = 0; }); await click('#tasksOutputHead button[aria-label="Run again"]'); await sleep(500);
  ok(await ev(() => window.__runs.length === 1), '"Run again" in the tab runs the same task');
  await ev(() => { window.__runs.length = 0; }); await click('#tasksOutputHead button[aria-label="Clear"]'); await sleep(100);
  ok(await ev(() => document.querySelectorAll('#tasksOutputBody .tk-line').length === 0 && !!document.querySelector('#tasksOutputBody .tk-empty')), '"Clear" empties the output');

  console.log('\n[6] a task that fails, and a command task that reads a file');
  await ev(() => { window.__runs.length = 0; window.__impl = async (req, onOut) => { onOut({ kind: 'stdout', text: 'running tests\n' }); await new Promise(r => setTimeout(r, 1000)); return { error: { name: 'AssertionError', message: 'expected 1 to equal 2', text: 'AssertionError: expected 1 to equal 2\n  at tests/run.py:7' } }; }; });
  await page.hover('#tasksSidebar .tk-row[data-label="Test"]'); await click('#tasksSidebar .tk-row[data-label="Test"] .tk-play'); await sleep(1500);
  const f1 = await ev(() => ({ req: window.__runs[0], row: document.querySelector('#tasksSidebar .tk-row[data-label="Test"]').dataset.state, lead: document.querySelector('#tasksSidebar .tk-row[data-label="Test"] .tk-lead').className, statusIcon: document.querySelector('#statusTasksToggle i').className, statusState: document.getElementById('statusTasksToggle').dataset.state, head: document.getElementById('tasksOutputHead').textContent, texts: [...document.querySelectorAll('#tasksOutputBody .tk-line')].map(l => l.className + '|' + l.querySelector('.tk-text').textContent), link: [...document.querySelectorAll('#tasksOutputBody .tk-link')].map(a => a.textContent) }));
  ok(f1.req.lang === 'python' && f1.req.code === 'print("tests")\n', 'a command task ran the workspace file tests/run.py as Python', f1.req);
  ok(f1.row === 'error' && /tk-bad/.test(f1.lead) && f1.statusState === 'error' && /tk-bad/.test(f1.statusIcon) && /Failed/.test(f1.head), 'a red cross on the row and in the status bar, and the tab says Failed', f1);
  ok(f1.texts.some(t => /tk-err\|AssertionError: expected 1 to equal 2/.test(t)) && f1.texts.some(t => /tk-err\|Failed after/.test(t)), 'the error is in red, then "Failed after ..."', f1.texts);
  ok(JSON.stringify(f1.link) === '["tests/run.py:7"]', 'and the line in the traceback is a link', f1.link);
  ok(await ev(() => window.CodeMiniBackground.finished().some(x => x.title === 'Task: Test' && x.state === 'error')), 'the failed run is in RECENTLY FINISHED as failed');
  await ev(() => { window.__runs.length = 0; }); await putTasks({ tasks: [{ label: 'Gone', command: 'node nowhere/x.js' }, { label: 'Hello', lang: 'python', script: 'print(1)' }] }); await settle(400);
  await page.hover('#tasksSidebar .tk-row[data-label="Gone"]'); await click('#tasksSidebar .tk-row[data-label="Gone"] .tk-play'); await sleep(400);
  ok(await ev(() => window.__runs.length === 0 && [...document.querySelectorAll('#tasksOutputBody .tk-line .tk-text')].some(t => /File not found: nowhere\/x\.js/.test(t.textContent))), 'a command naming a missing file runs nothing and says so in the tab', await ev(() => [...document.querySelectorAll('#tasksOutputBody .tk-line .tk-text')].map(t => t.textContent)));
  ok(await ev(() => document.querySelector('#statusTasksToggle').dataset.state !== 'running'), 'and does not leave the status bar spinning');
  await ev(() => { window.__useOk = false; window.__runs.length = 0; }); await page.hover('#tasksSidebar .tk-row[data-label="Hello"]'); await click('#tasksSidebar .tk-row[data-label="Hello"] .tk-play'); await sleep(400);
  ok(await ev(() => window.__runs.length === 0 && [...document.querySelectorAll('#tasksOutputBody .tk-line .tk-text')].some(t => /isolated runner, which is not available: Isolation is off for the Terminal\. Turn on Isolation/.test(t.textContent))), 'with no isolated runner it says how to fix that, and never runs in the page', await ev(() => [...document.querySelectorAll('#tasksOutputBody .tk-line .tk-text')].map(t => t.textContent)));
  await ev(() => { window.__useOk = true; });

  console.log('\n[7] Stop');
  await ev(() => { window.__runs.length = 0; window.__kills = 0; window.__impl = (req, onOut) => new Promise((res, rej) => { window.__killRej = rej; onOut({ kind: 'stdout', text: 'waiting\n' }); }); });
  await page.hover('#tasksSidebar .tk-row[data-label="Hello"]'); await click('#tasksSidebar .tk-row[data-label="Hello"] .tk-play'); await sleep(400);
  ok(await ev(() => !!document.querySelector('#tasksSidebar .tk-row[data-label="Hello"] .tk-stop') && !document.querySelector('#tasksOutputHead button[aria-label="Stop"]').disabled), 'while it runs, Stop is offered on the row and in the tab');
  await click('#tasksSidebar .tk-row[data-label="Hello"] .tk-stop'); await sleep(500);
  const stp = await ev(() => ({ kills: window.__kills, row: document.querySelector('#tasksSidebar .tk-row[data-label="Hello"]').dataset.state, statusState: document.getElementById('statusTasksToggle').dataset.state, head: document.getElementById('tasksOutputHead').textContent, texts: [...document.querySelectorAll('#tasksOutputBody .tk-line .tk-text')].map(t => t.textContent), play: !!document.querySelector('#tasksSidebar .tk-row[data-label="Hello"] .tk-play') }));
  ok(stp.kills === 1 && stp.row === 'stopped' && /Stopped/.test(stp.head) && stp.play, 'Stop kills the host once and the task is "stopped", not failed', stp);
  ok(stp.texts.some(t => /isolated host was shut down, so its variables were reset/.test(t)) && stp.texts.some(t => /^Stopped after /.test(t)), 'and the tab says what that cost (variables reset)', stp.texts);
  ok(stp.statusState === 'stopped', 'the status bar item is neither a check nor a cross', stp);
  await ev(() => { window.__kills = 0; window.__impl = (req, onOut) => new Promise((res, rej) => { window.__killRej = rej; }); });
  await page.hover('#tasksSidebar .tk-row[data-label="Hello"]'); await click('#tasksSidebar .tk-row[data-label="Hello"] .tk-play'); await sleep(300);
  await click('#tasksOutputHead button[aria-label="Stop"]'); await sleep(400);
  ok(await ev(() => window.__kills === 1 && document.querySelector('#tasksSidebar .tk-row[data-label="Hello"]').dataset.state === 'stopped'), 'the Stop in the Tasks tab does the same');
  await ev(() => { window.__runs.length = 0; window.__impl = (req, onOut) => new Promise((res, rej) => { window.__killRej = rej; window.__finish = res; }); });
  await page.hover('#tasksSidebar .tk-row[data-label="Hello"]'); await click('#tasksSidebar .tk-row[data-label="Hello"] .tk-play'); await sleep(300);
  await ev(() => { window.__toasts.length = 0; window.CodeMiniTasks.runByLabel('Gone'); }); await sleep(200);
  ok(await ev(() => window.__runs.length === 1 && window.__toasts.some(m => /"Hello" is still running\. Stop it first\./.test(m))), 'starting another while one runs is refused with a message naming the one that is running', await ev(() => window.__toasts));
  await ev(() => { window.__finish({}); }); await sleep(400);
  ok(await ev(() => !window.CodeMiniTasks.state().running), 'and when it ends, nothing is left running');

  console.log('\n[8] links in the output');
  await ev(() => { window.__clicked.length = 0; window.__toasts.length = 0; window.__impl = async (req, onOut) => { onOut({ kind: 'stderr', text: 'at src/app.js:3:1\n' }); onOut({ kind: 'stderr', text: 'at app.js:2\n' }); onOut({ kind: 'stderr', text: 'at missing/file.js:9\n' }); onOut({ kind: 'stdout', text: 'see https://example.com/a.js:80\n' }); return {}; }; });
  await page.hover('#tasksSidebar .tk-row[data-label="Hello"]'); await click('#tasksSidebar .tk-row[data-label="Hello"] .tk-play'); await sleep(500);
  const linkTexts = await ev(() => [...document.querySelectorAll('#tasksOutputBody .tk-link')].map(a => a.textContent));
  ok(JSON.stringify(linkTexts) === '["src/app.js:3:1","app.js:2","missing/file.js:9"]', 'three links, and the web address is not one', linkTexts);
  await ev(() => document.querySelectorAll('#tasksOutputBody .tk-link')[0].click()); await sleep(400);
  ok(await ev(() => window.__clicked.join() === 'app.js'), 'a link to a workspace path opens that file', await ev(() => window.__clicked));
  await ev(() => { window.__clicked.length = 0; document.querySelectorAll('#tasksOutputBody .tk-link')[1].click(); }); await sleep(400);
  ok(await ev(() => window.__clicked.join() === 'app.js'), 'a shorter path opens the one file it can only mean (src/app.js)', await ev(() => window.__clicked));
  await ev(() => { window.__clicked.length = 0; window.__toasts.length = 0; document.querySelectorAll('#tasksOutputBody .tk-link')[2].click(); }); await sleep(400);
  ok(await ev(() => window.__clicked.length === 0 && window.__toasts.some(m => /Could not find missing\/file\.js in this workspace/.test(m))), 'a path that is not there says so instead of doing nothing', await ev(() => window.__toasts));
  await ev(() => { window.__clicked.length = 0; const a = document.querySelectorAll('#tasksOutputBody .tk-link')[0]; a.focus(); a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }); await sleep(300);
  ok(await ev(() => window.__clicked.join() === 'app.js'), 'Enter on a focused link opens it too');
  await ev(() => { window.__clicked.length = 0; });

  console.log('\n[9] Restricted Mode');
  await ev(() => { window.__runs.length = 0; window.__impl = async () => ({}); window.WorkspaceTrust.setTrust(undefined, false); }); await sleep(400);
  const rs = await ev(() => ({ banner: (document.querySelector('#tasksSidebar .tk-banner-lock') || {}).textContent, trustLink: !!document.querySelector('#tasksSidebar .tk-banner-lock .tk-action'), plays: [...document.querySelectorAll('#tasksSidebar .tk-play')].map(b => [b.disabled, b.title, b.querySelector('i').className]) }));
  ok(/Restricted Mode: tasks are listed but will not run until you trust this workspace/.test(rs.banner) && rs.trustLink, 'the list says Restricted Mode and offers Trust', rs);
  ok(rs.plays.length >= 1 && rs.plays.every(p => p[0] && p[1] === 'Trust this workspace to run tasks' && /ri-lock-line/.test(p[2])), 'every play button is disabled, with a lock and the spec\'s tooltip', rs.plays);
  await page.keyboard.press('Control+Shift+B'); await sleep(400);
  ok(await ev(() => window.__runs.length === 0), 'Ctrl+Shift+B does not run anything either');
  await ev(() => { window.CodeMiniTasks.runByLabel('Hello'); }); await sleep(300);
  ok(await ev(() => window.__runs.length === 0 && [...document.querySelectorAll('#tasksOutputBody .tk-line .tk-text')].some(t => /Restricted Mode: trust this workspace to run tasks/.test(t.textContent))), 'running from the API is blocked too, and the tab says why');
  ok(await ev(() => document.getElementById('statusTasksToggle').dataset.state !== 'running' && !window.CodeMiniTasks.state().running), 'a blocked run is not shown as running');
  await ev(() => window.WorkspaceTrust.setTrust(undefined, true)); await sleep(400);
  ok(await ev(() => !document.querySelector('#tasksSidebar .tk-banner-lock') && [...document.querySelectorAll('#tasksSidebar .tk-play')].some(b => !b.disabled)), 'trusting the workspace lifts it');

  console.log('\n[10] pins');
  await putTasks({ tasks: [{ label: 'A', group: 'build', lang: 'python', script: '1' }, { label: 'B', group: 'build', lang: 'python', script: '2' }, { label: 'C', group: 'test', lang: 'python', script: '3' }] }); await settle(400);
  await ev(() => document.querySelector('#tasksSidebar .tk-row[data-label="B"] .tk-pin').click()); await settle(250);
  ok(JSON.stringify(await sections()) === '["PINNED:1","BUILD:1","TEST:1"]', 'pinning moves a task to a PINNED section at the top (and out of its group)', await sections());
  ok(await ev(() => { const b = document.querySelector('#tasksSidebar .tk-sec:first-of-type .tk-row .tk-pin'); return b.classList.contains('on') && b.getAttribute('aria-label') === 'Unpin B' && getComputedStyle(b).opacity !== '0'; }), 'its star stays visible, filled, and offers to unpin');
  ok(await ev(() => Object.values(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => /tasksPinned$/.test(k))))).some(a => a.includes('B'))), 'pins are kept per workspace in the person\'s storage');
  await ev(() => document.querySelector('#tasksSidebar .tk-row[data-label="B"] .tk-pin').click()); await settle(250);
  ok(JSON.stringify(await sections()) === '["BUILD:2","TEST:1"]', 'unpinning puts it back');

  console.log('\n[11] a broken tasks.json');
  await putTasks('{\n "tasks": [\n  { "label": "A", "lang": "python", "script": "1" }\n  { "label": "B" }\n ]\n}'); await settle(400);
  const bk = await ev(() => ({ banner: (document.querySelector('#tasksSidebar .tk-banner-bad') || {}).textContent, rows: document.querySelectorAll('#tasksSidebar .tk-row').length, empty: !!document.querySelector('#tasksSidebar .tk-emptystate') }));
  ok(/tasks\.json is not valid/.test(bk.banner) && /line 4/.test(bk.banner) && bk.rows === 0, 'a syntax error shows a banner with the line, and lists nothing half-understood', bk);
  ok(!bk.empty, 'and does not also say "No tasks yet"', bk);
  await ev(() => { window.__opened.length = 0; }); await click('#tasksSidebar .tk-banner-bad .tk-action'); await settle(500);
  ok(await ev(() => window.__opened.includes('tasks.json')), 'its Open file link opens the file');
  await putTasks({ tasks: [{ label: 'ok', lang: 'python', script: '1' }, { label: 'x', group: 'deploy', lang: 'python', script: '2' }, { label: 'ok', lang: 'python', script: '3' }] }); await settle(400);
  const pb = await ev(() => ({ banners: [...document.querySelectorAll('#tasksSidebar .tk-banner-bad')].map(b => b.textContent), rows: [...document.querySelectorAll('#tasksSidebar .tk-row')].map(r => r.dataset.label) }));
  ok(pb.rows.join() === 'ok' && pb.banners.length === 2 && pb.banners.some(b => /use "build", "test" or "custom"/.test(b)) && pb.banners.some(b => /repeats a label/.test(b)), 'tasks that cannot be shown are named in banners, and the good one is still listed', pb);
  await putTasks({ tasks: [{ label: 'A', lang: 'python', script: '1' }] }); await settle(400);
  ok(await ev(() => !document.querySelector('#tasksSidebar .tk-banner') && document.querySelectorAll('#tasksSidebar .tk-row').length === 1), 'fixing the file clears the banners');
  await ev(() => { window.__opened.length = 0; document.querySelector('#tasksSidebar .sb-header button[aria-label="Open tasks.json"]').click(); }); await settle(400);
  ok(await ev(() => window.__opened.includes('tasks.json')), 'with a file, "+" in the header opens it instead of the template menu');

  console.log('\n[12] the palette');
  await putTasks({ tasks: [{ label: 'Build', group: 'build', default: true, lang: 'python', script: 'print("b")' }, { label: 'Lint', lang: 'python', script: 'print("l")' }] }); await settle(400);
  const inp = '.top-center .search-bar input';
  const qrows = () => ev(() => [...document.querySelectorAll('#topSearchIsland .qo-item .qo-label')].map(x => x.textContent));
  await page.keyboard.press('Control+P'); await sleep(350); await page.fill(inp, '>task'); await sleep(350);
  const q1 = await qrows();
  ok(['Run Task...', 'Run Build Task', 'Run Test Task', 'Configure Tasks', 'Open Tasks', 'Run Task: Build', 'Run Task: Lint'].every(x => q1.includes(x)), 'the palette lists Run Task..., Run Build/Test Task, Configure Tasks, Open Tasks and one "Run Task: <label>" per task', q1);
  await page.fill(inp, '>Run Task: Lint'); await sleep(350);
  await ev(() => { window.__runs.length = 0; window.__impl = async () => ({}); });
  await page.keyboard.press('Enter'); await sleep(600);
  ok(await ev(() => window.__runs.length === 1 && window.__runs[0].code === 'print("l")'), 'choosing "Run Task: Lint" runs that task', await ev(() => window.__runs));
  await page.keyboard.press('Control+P'); await sleep(350); await page.fill(inp, '>Run Task...'); await sleep(300);
  await page.keyboard.press('Enter'); await sleep(500);
  ok(await ev(() => document.querySelector('.top-center .search-bar input').value === '>Run Task: '), '"Run Task..." reopens the palette filtered to the task commands', await ev(() => document.querySelector('.top-center .search-bar input').value));
  const q2 = await qrows();
  ok(q2.length >= 2 && q2.every(x => /^Run Task: /.test(x)), 'showing only the tasks to pick from', q2);
  await page.keyboard.press('Escape'); await sleep(200);
  await ev(() => { window.__runs.length = 0; }); await page.keyboard.press('Control+P'); await sleep(350); await page.fill(inp, '>Run Test Task'); await sleep(300);
  await ev(() => { window.__toasts.length = 0; }); await page.keyboard.press('Enter'); await sleep(500);
  ok(await ev(() => window.__runs.length === 0 && window.__toasts.some(m => /No test task yet/.test(m))), 'with no test task, "Run Test Task" says so (and opens Tasks) instead of failing quietly', await ev(() => window.__toasts));
  await ev(() => { window.__opened.length = 0; }); await page.keyboard.press('Control+P'); await sleep(350); await page.fill(inp, '>Configure Tasks'); await sleep(300); await page.keyboard.press('Enter'); await sleep(600);
  ok(await ev(() => window.__opened.includes('tasks.json')), '"Configure Tasks" opens the file when there is one');
  await page.keyboard.press('Escape');

  console.log('\n[13] config: schema, template, Initialize');
  const cfg = await ev(() => { const C = window.CodeMiniConfig; const sc = C.schemaFor('tasks.json'); return { schema: sc && Object.keys(sc.properties.tasks.items.properties).sort().join(), tpl: C.templates()['tasks.json'].includes('"label": "Build"'), registered: window.CodeMiniJsonSchemas.list().some(s => s.uri === 'codemini://schema/tasks.json') }; });
  ok(cfg.schema === 'command,default,detail,group,label,lang,script' && cfg.tpl && cfg.registered, 'the schema and the starter template are registered with the config module (so Initialize creates tasks.json and the editor validates it)', cfg);
  const att = await ev(async () => { const calls = []; const real = window.CodeMiniJsonSchemas.add; window.CodeMiniJsonSchemas.add = (u, m) => { calls.push([u, m]); return true; }; const ok1 = await window.CodeMiniConfig.attachEditor({ getModel: () => ({ uri: { toString: () => 'inmemory://model/9' } }) }, { dataset: { fileId: (await new Promise(r => { db.transaction('filesystem').objectStore('filesystem').getAll().onsuccess = e => r(e.target.result.find(x => x.name === 'tasks.json').id); })) } }); window.CodeMiniJsonSchemas.add = real; return { ok1, calls }; });
  ok(att.ok1 && att.calls.length === 1 && att.calls[0][0] === 'codemini://schema/tasks.json', 'opening tasks.json in a tab attaches the schema to its editor', att);

  console.log('\n[13b] hostile text is only ever text');
  await putTasks({ tasks: [{ label: '<img src=x onerror="window.__pwn=1">Build', group: 'build', lang: 'python', script: '1', detail: '<b onmouseover="window.__pwn=2">detail</b>' }, { label: 'cmd', command: 'node "<svg onload=window.__pwn=3>.js"' }] }); await settle(500);
  await ev(() => { window.__impl = async (req, onOut) => { onOut({ kind: 'stdout', text: '<img src=x onerror="window.__pwn=4"> and <script>window.__pwn=5</script>\n' }); onOut({ kind: 'stderr', text: '<a href="javascript:window.__pwn=6">x.js:1</a> <svg onload=window.__pwn=7>' }); return {}; }; });
  await ev(() => { window.CodeMiniTasks.runByLabel('<img src=x onerror="window.__pwn=1">Build'); }); await sleep(600);
  const hostile = await ev(() => ({ pwn: window.__pwn, imgs: document.querySelectorAll('#tasksSidebar img, #tasksPanelContent img, #tasksSidebar svg[onload], #tasksPanelContent svg[onload], #tasksPanelContent script').length, anchors: document.querySelectorAll('#tasksPanelContent a, #tasksSidebar a').length, label: document.querySelector('#tasksSidebar .tk-row .tk-name').textContent, detail: document.querySelector('#tasksSidebar .tk-detail').textContent, out: [...document.querySelectorAll('#tasksOutputBody .tk-text')].map(t => t.textContent), cmdRow: [...document.querySelectorAll('#tasksSidebar .tk-row[data-label="cmd"] .tk-cmd')].map(c => c.textContent) }));
  ok(hostile.pwn === undefined && hostile.imgs === 0 && hostile.anchors === 0, 'nothing in a label, a detail, a command or the output was run or became markup', hostile);
  ok(hostile.label.startsWith('<img src=x onerror=') && hostile.detail === '<b onmouseover="window.__pwn=2">detail</b>', 'the label and detail are shown exactly as written', hostile);
  ok(hostile.out.some(t => t === '<img src=x onerror="window.__pwn=4"> and <script>window.__pwn=5</script>') && hostile.out.some(t => t.startsWith('<a href="javascript:window.__pwn=6">')), 'and so is the output', hostile.out);
  ok(await ev(() => !!document.querySelector('#tasksOutputBody .tk-link') && document.querySelector('#tasksOutputBody .tk-link').tagName === 'SPAN'), 'a file link in hostile output is a span with a handler, never an <a href>');
  await putTasks({ tasks: [{ label: 'Build', group: 'build', default: true, lang: 'python', script: 'print("b")' }, { label: 'Lint', lang: 'python', script: 'print("l")' }] }); await settle(400);

  console.log('\n[14] another workspace');
  await ev(() => new Promise(res => { window.__rootDb = db.name; window.__rootStack = folderStack; initDatabase('CodeMiniDB_WS_taskstest', () => { folderStack = [{ id: 'wsx', name: 'X', isWorkspaceRoot: true, parentDb: cellActiveWindow.db }]; loadFilesFromDB(); res(); }); })); await settle(700);
  const other = await ev(() => ({ rows: document.querySelectorAll('#tasksSidebar .tk-row').length, empty: !!document.querySelector('#tasksSidebar .tk-emptystate'), status: getComputedStyle(document.getElementById('statusTasksToggle')).display, results: Object.keys(window.CodeMiniTasks.state().results).length }));
  ok(other.rows === 0 && other.empty && other.status === 'none' && other.results === 0, 'another workspace has its own tasks: none here, no leftover results, no status item', other);
  await ev(() => new Promise(res => { initDatabase(window.__rootDb, () => { folderStack = window.__rootStack; loadFilesFromDB(); res(); }); })); await settle(700);
  ok(await ev(() => document.querySelectorAll('#tasksSidebar .tk-row').length === 2), 'and coming back brings this workspace\'s tasks back');

  console.log('\n[15] phone layout and reduced motion');
  await page.setViewportSize({ width: 390, height: 844 }); await sleep(300);
  await ev(() => { window.__impl = (req, onOut) => new Promise(() => {}); window.CodeMiniTasks.runByLabel('Build'); }); await sleep(300);
  const mob = await ev(() => { const s = document.getElementById('tasksSidebar'), name = document.querySelector('#statusTasksToggle .tk-status-name'); return { sbW: s.offsetWidth, vw: innerWidth, nameShown: name && getComputedStyle(name).display !== 'none', iconShown: getComputedStyle(document.getElementById('statusTasksToggle')).display !== 'none' }; });
  ok(mob.iconShown && !mob.nameShown, 'on a phone the status item keeps its icon and drops the name', mob);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await sleep(100);
  ok(await ev(() => getComputedStyle(document.querySelector('#statusTasksToggle .tk-spin')).animationName === 'none'), 'under reduced motion the spinner does not turn');
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await sleep(100);
  ok(await ev(() => getComputedStyle(document.querySelector('#statusTasksToggle .tk-spin')).animationName === 'tkSpin'), 'otherwise it does');
  await ev(() => { window.CodeMiniTasks.stop(); }); await sleep(200);
  await page.setViewportSize({ width: 1280, height: 800 }); await sleep(200);

  const rel = errors.filter(e => !NOISE.test(e));
  ok(rel.length === 0, 'no unexpected page errors', rel);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
