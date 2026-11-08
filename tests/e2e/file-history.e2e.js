// Local History, hot exit and the Auto Save switch (js/core/file-history.js) in the real app, on the real IndexedDB.
// Needs a real Monaco for most checks (MONACO_DIR, see tests/e2e/lib/monaco-local.js); without one it runs the checks
// that do not need an editor and reports the rest as SKIP.
const { chromium } = require('playwright');
const monacoLocal = require('./lib/monaco-local');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0, skipped = 0;
const REAL = monacoLocal.available();
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const real = (c, n, x) => { if (REAL) ok(c, n, x); else { skipped++; console.log('  SKIP', n, '(needs MONACO_DIR)'); } };
const URL = 'http://localhost:8765/index.html';
const BOOT = REAL ? 6500 : 5200;

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: REAL ? 'block' : 'allow' });
  const prepare = async (p) => {
    const errors = []; p.on('pageerror', e => errors.push(e.message)); p.errors = errors;
    if (!REAL) await p.addInitScript(() => {
      const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
      window.require = (deps, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); };
      window.require.config = () => {};
    });
    await p.addInitScript(() => {
      window.__toastNodes = [];
      const start = () => new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.classList && n.classList.contains('nt-toast')) window.__toastNodes.push(n); }))).observe(document.documentElement, { childList: true, subtree: true });
      if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
    });
    await p.route(/^https?:\/\/(?!localhost)/, r => r.abort());
    if (REAL) await monacoLocal.install(p);
  };
  let page = await context.newPage();
  await prepare(page);
  await page.goto(URL); await sleep(BOOT);
  let cur = page;
  const ev = (f, a) => cur.evaluate(f, a);
  console.log(REAL ? '\n(real Monaco)' : '\n(no MONACO_DIR: editor checks are skipped)');
  const ensureExplorer = async () => { if (!(await ev(() => document.getElementById('explorerSidebar').offsetWidth > 100))) { await ev(() => document.getElementById('folderIconItem').click()); await sleep(900); } };
  await ensureExplorer();

  const dbName = await ev(() => db.name);
  const FILES = () => ([
    { id: 'fa', parentId: 'root', name: 'a.js', type: 'file', content: 'one\ntwo\nthree\n' },
    { id: 'fb', parentId: 'root', name: 'b.js', type: 'file', content: 'alpha\nbeta\n' },
    { id: 'fl', parentId: 'root', name: 'secret.js', type: 'file', content: 'ENC', isLocked: true }
  ]);
  const seed = async () => {
    await ev(async (files) => {
      await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').clear(); tx.oncomplete = res; });
      const t = Date.now();
      await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); files.forEach(r => tx.objectStore('filesystem').put(Object.assign({ timestamp: t }, r))); tx.oncomplete = res; });
      Array.from(document.querySelectorAll('.tab')).forEach(tab => { const b = tab.querySelector('.tab-close'); if (b) b.click(); });
      folderStack = [folderStack[0]]; loadFilesFromDB();
      window.appSettings.autoSave = 'Off'; window.appSettings.hotExit = 'On'; window.appSettings.localHistory = 'On';
      window.appSettings.historyMaxEntries = 50; window.appSettings.historyMaxDays = 14;
      await CodeMiniHistory.store.clearHistory(); await CodeMiniHistory.store.clearBackups();
    }, FILES());
    await sleep(600);
  };
  const open = async (id) => {
    const f = FILES().find(x => x.id === id);
    await ev((f) => handleFileClick(Object.assign({ timestamp: 1 }, f), document.createElement('div')), f);
    await sleep(1600);
  };
  const setText = (t) => ev((t) => { const ed = getActiveMonacoEditor(); ed.executeEdits('t', [{ range: ed.getModel().getFullModelRange(), text: t, forceMoveMarkers: true }]); }, t);
  const text = () => ev(() => getActiveMonacoEditor().getValue());
  const file = (id) => ev((id) => new Promise(res => { const rq = db.transaction('filesystem', 'readonly').objectStore('filesystem').get(id); rq.onsuccess = () => res(rq.result || null); }), id);
  const hist = (id) => ev(async ([n, f]) => (await CodeMiniHistory.history.list(n, f)).map(m => ({ kind: m.kind, added: m.added, removed: m.removed, size: m.size, id: m.id })), [dbName, id]);
  const histText = (id) => ev((id) => CodeMiniHistory.history.getContent(id), id);
  const backups = () => ev(async (n) => (await CodeMiniHistory.store.backupsByDb(n)).map(b => ({ fileId: b.fileId, content: b.content, pageId: b.pageId })), dbName);
  const tabs = () => ev(() => Array.from(document.querySelectorAll('.tab')).map(t => ({ name: t.querySelector('span').textContent, type: t.dataset.type, dirty: t.classList.contains('unsaved-blink') })));
  const diffTabs = () => ev(() => Array.from(document.querySelectorAll('.tab[data-type="diff"]')).map(t => t.querySelector('span').textContent));
  const save = async () => { await ev(() => window.performActiveSave()); await sleep(700); };
  const setSaved = (k, v) => ev(([k, v]) => window.saveSetting(k, v), [k, v]);
  const reload = async (p) => { await (p || cur).reload(); await sleep(BOOT); };

  // ------------------------------------------------------------------------------------------------
  console.log('\n[Auto Save switch in the status bar]');
  await seed();
  const asInfo = () => ev(() => { const e = document.getElementById('statusAutoSave'); return e ? { label: e.querySelector('.as-label').textContent, pressed: e.getAttribute('aria-pressed'), title: e.title, beforeNow: e.nextElementSibling && e.nextElementSibling.id } : null; });
  await setSaved('autoSave', 'After Delay'); await sleep(100);
  let a = await asInfo();
  ok(!!a, 'the status bar has an Auto Save item');
  ok(a && a.beforeNow === 'nowIsland', 'it sits in the right group, just before the Now Island button', a);
  ok(a && a.label === 'Auto Save' && a.pressed === 'true', 'it reads "Auto Save" while auto save is on', a);
  await cur.click('#statusAutoSave'); await sleep(200);
  a = await asInfo();
  ok(await ev(() => window.appSettings.autoSave) === 'Off' && a.label === 'Auto Save: Off' && a.pressed === 'false', 'a click turns it off and the item says so', a);
  ok(await ev(() => localStorage.getItem('codemini_autoSave') || localStorage.getItem(Object.keys(localStorage).find(k => /autoSave$/.test(k) && !/Delay/.test(k)))) === 'Off', 'and the choice is saved like any other setting');
  await cur.click('#statusAutoSave'); await sleep(200);
  ok(await ev(() => window.appSettings.autoSave) === 'After Delay', 'clicking again turns it back on');
  await setSaved('autoSave', 'On Tab Change'); await cur.click('#statusAutoSave'); await sleep(150);
  await cur.click('#statusAutoSave'); await sleep(150);
  ok(await ev(() => window.appSettings.autoSave) === 'On Tab Change', 'it returns to the mode that was on (On Tab Change), not to a default', await ev(() => window.appSettings.autoSave));
  await setSaved('autoSave', 'After Delay');
  await ev(() => document.getElementById('settingsIconItem').click()); await sleep(1200);
  await cur.click('#statusAutoSave'); await sleep(300);
  ok(await ev(() => { const s = document.querySelector('select[data-setting="autoSave"]'); return s ? s.value : null; }) === 'Off', 'an open Settings screen shows the new value', await ev(() => { const s = document.querySelector('select[data-setting="autoSave"]'); return s ? s.value : null; }));
  ok(await ev(() => !!document.querySelector('select[data-setting="hotExit"]') && Array.from(document.querySelector('select[data-setting="hotExit"]').options).map(o => o.value + ':' + o.textContent).join() === 'On:On,Off:Off'), 'Settings > General has Hot Exit with explicit On / Off values');
  ok(await ev(() => !!document.querySelector('select[data-setting="localHistory"]') && !!document.querySelector('input[data-setting="historyMaxEntries"]') && !!document.querySelector('input[data-setting="historyMaxDays"]') && !!document.getElementById('btnClearLocalHistory')), 'Settings > Application has Local History, versions per file, days to keep and Clear History');
  await ev(() => Array.from(document.querySelectorAll('.tab')).forEach(t => { if (t.dataset.type === 'settings') t.querySelector('.tab-close').click(); }));
  await setSaved('autoSave', 'Off');

  // ------------------------------------------------------------------------------------------------
  console.log('\n[Timeline section in the Explorer]');
  await seed();
  const tl = () => ev(() => { const s = document.getElementById('explorerTimeline'); if (!s) return null; const bar = document.querySelector('.explorer-status-bar'); return { before: s.nextElementSibling === bar, open: s.classList.contains('tl-open'), expanded: s.querySelector('.tl-toggle').getAttribute('aria-expanded'), bodyHidden: s.querySelector('.tl-body').hidden, file: s.querySelector('.tl-file').textContent, count: s.querySelector('.tl-count').textContent, rows: Array.from(s.querySelectorAll('.tl-row')).map(r => ({ time: r.querySelector('.tl-time').textContent, meta: r.querySelector('.tl-meta').textContent, kind: r.querySelector('.tl-dot').className })), empty: (s.querySelector('.tl-empty') || {}).textContent || null }; });
  let s = await tl();
  ok(!!s && s.before, 'a Timeline section sits above the Explorer status line');
  ok(s && !s.open && s.expanded === 'false' && s.bodyHidden, 'it is collapsed by default', s);
  await cur.click('#explorerTimeline .tl-toggle'); await sleep(300);
  s = await tl();
  ok(s.open && s.expanded === 'true' && !s.bodyHidden, 'the header opens it');
  ok(/Open a code file/.test(s.empty || ''), 'with no file open it says to open one', s);
  await cur.click('#explorerTimeline .tl-toggle'); await sleep(200);
  ok((await tl()).bodyHidden, 'and closes it again');

  if (REAL) {
    // ------------------------------------------------------------------------------------------------
    console.log('\n[History: what a save leaves behind]');
    await seed(); await open('fa');
    ok((await tabs()).some(t => t.name === 'a.js' && t.type === 'monaco'), 'a.js is open in the real editor');
    await setText('one\ntwo\nthree\nfour\n'); await save();
    let h = await hist('fa');
    ok(h.length === 1 && h[0].kind === 'manual', 'Ctrl+S leaves a "manual" version', h);
    ok(h[0] && h[0].added === null, 'the first version has no change figure');
    await setText('one\nTWO\nthree\nfour\nfive\n'); await save();
    h = await hist('fa');
    ok(h.length === 2 && h[0].added === 2 && h[0].removed === 1, 'the next save counts +2 \u22121 against the one before', h);
    ok(await histText(h[1].id) === 'one\ntwo\nthree\nfour\n' && await histText(h[0].id) === 'one\nTWO\nthree\nfour\nfive\n', 'each version holds the text that was saved');
    await save();
    ok((await hist('fa')).length === 2, 'saving unchanged text again adds nothing');

    await seed(); await open('fb');
    await ev(() => { window.appSettings.autoSave = 'After Delay'; window.appSettings.autoSaveDelay = 300; });
    await setText('alpha\nbeta\ngamma\n'); await sleep(1200);
    h = await hist('fb');
    ok(h.length === 1 && h[0].kind === 'auto', 'an automatic save leaves an "auto" version', h);
    await setText('alpha\nbeta\ngamma\ndelta\n'); await sleep(1200);
    h = await hist('fb');
    ok(h.length === 1 && await histText(h[0].id) === 'alpha\nbeta\ngamma\ndelta\n', 'a second auto save moments later replaces it instead of piling up', h);
    await ev(() => { window.appSettings.autoSave = 'Off'; });

    await seed(); await open('fa');
    await ev(() => { window.appSettings.localHistory = 'Off'; });
    await setText('changed\n'); await save();
    ok((await hist('fa')).length === 0, 'with Local History off a save leaves nothing');
    ok((await file('fa')).content === 'changed\n', 'and the file itself is still saved');
    await ev(() => { window.appSettings.localHistory = 'On'; });

    await seed();
    const kept = await ev(async ([n]) => {
      const H = CodeMiniHistory; const out = [];
      window.appSettings.historyMaxEntries = 3;
      for (let i = 1; i <= 6; i++) await H.history.record({ dbName: n, fileId: 'fa', name: 'a.js', content: 'v' + i, kind: 'manual', now: Date.now() + i * 60000 });
      const list = await H.history.list(n, 'fa');
      for (const m of list) out.push(await H.history.getContent(m.id));
      window.appSettings.historyMaxEntries = 50;
      return out;
    }, [dbName]);
    ok(kept.join() === 'v6,v5,v4', 'on the real IndexedDB only the newest N versions are kept, newest first', kept);

    await seed();
    await ev(async ([n]) => { const H = CodeMiniHistory; await H.history.record({ dbName: n, fileId: 'fa', name: 'a.js', content: 'x', kind: 'manual' }); await H.store.putBackup({ key: n + '|fa', dbName: n, fileId: 'fa', content: 'y', pageId: 'dead' }); await H.history.record({ dbName: 'other-db', fileId: 'fa', name: 'a.js', content: 'z', kind: 'manual' }); }, [dbName]);
    await ev(([n]) => CodeMiniHistory.purgeDatabases([n]), [dbName]);
    ok((await hist('fa')).length === 0 && (await backups()).length === 0, 'purging a database (Factory Reset, deleting a window or workspace) removes its history and its hot-exit copies');
    ok(await ev(async () => (await CodeMiniHistory.history.list('other-db', 'fa')).length) === 1, 'and leaves other databases alone');
    await ev(() => CodeMiniHistory.history.clearFile('other-db', 'fa'));

    // ------------------------------------------------------------------------------------------------
    console.log('\n[Locked files are never copied]');
    await seed();
    const lockedSaved = await ev(async ([n]) => {
      const tab = document.createElement('div'); tab.dataset.type = 'monaco';
      await CodeMiniHistory.noteSaved({ tabEl: null, dbName: n, file: { id: 'fl', name: 'secret.js', isLocked: true }, content: 'plain secret' });
      await new Promise(r => setTimeout(r, 300));
      return (await CodeMiniHistory.history.list(n, 'fl')).length;
    }, [dbName]);
    ok(lockedSaved === 0, 'a save of a locked file leaves no history');
    await ev(() => { createNewTab('secret.js', 'ri-file-code-line', false, 'plain secret typed in memory', 'monaco', 'fl'); });
    await sleep(2000);
    await setText('plain secret typed in memory, edited'); await sleep(2600);
    ok((await backups()).filter(b => b.fileId === 'fl').length === 0, 'text typed into a locked file is not backed up for hot exit');
    ok(await ev(() => { const t = Array.from(document.querySelectorAll('.tab')).find(x => x.dataset.fileId === 'fl'); return t && t._cmSafe === false; }), 'the tab is marked unsafe as soon as it opens');
    await ev(() => { Array.from(document.querySelectorAll('.tab')).forEach(tab => tab.querySelector('.tab-close').click()); });
    await sleep(500);
    ok((await hist('fl')).length === 0, 'and closing it unsaved does not put its text in history either');

    // ------------------------------------------------------------------------------------------------
    console.log('\n[Timeline: reading, comparing, restoring]');
    await seed(); await open('fa');
    await setText('v1\n'); await save(); await setText('v1\nv2\n'); await save(); await setText('v1\nv2\nv3\n'); await save();
    await cur.click('#explorerTimeline .tl-toggle'); await sleep(500);
    s = await tl();
    ok(s.file === 'a.js' && s.count === '3' && s.rows.length === 3, 'the Timeline follows the open file and lists its versions', s);
    ok(s.rows[0].meta.startsWith('Saved') && /\+1/.test(s.rows[0].meta) && /\u22120/.test(s.rows[0].meta), 'a row shows how it was saved, its size and its +/\u2212 lines', s.rows[0]);
    ok(/tl-manual/.test(s.rows[0].kind), 'a deliberate save has a filled dot');
    await cur.click('.tl-row:nth-child(3) .tl-main'); await sleep(2000);
    ok((await diffTabs()).length === 1 && /a\.js/.test((await diffTabs())[0]), 'clicking a row opens a diff tab against the file as it is now', await diffTabs());
    const sides = await ev(() => { const p = document.querySelector('.content-pane.active'); const d = p && p._diff && p._diff.editor; return d ? [d.getOriginalEditor().getValue(), d.getModifiedEditor().getValue()] : null; });
    ok(sides && sides[0] === 'v1\n' && sides[1] === 'v1\nv2\nv3\n', 'the old version is on the left, the current text on the right', sides);
    await ev(() => document.querySelector('.tab[data-type="diff"] .tab-close').click()); await sleep(300);
    await cur.hover('.tl-row:nth-child(1)'); await cur.click('.tl-row:nth-child(1) [data-tl-action="compare-prev"]'); await sleep(2000);
    const sides2 = await ev(() => { const p = document.querySelector('.content-pane.active'); const d = p && p._diff && p._diff.editor; return d ? [d.getOriginalEditor().getValue(), d.getModifiedEditor().getValue()] : null; });
    ok(sides2 && sides2[0] === 'v1\nv2\n' && sides2[1] === 'v1\nv2\nv3\n', 'the compare icon shows what that save changed (it against the one before)', sides2);
    await ev(() => document.querySelector('.tab[data-type="diff"] .tab-close').click()); await sleep(300);
    await cur.click('.tab:has-text("a.js")'); await sleep(300);

    await ev(() => { getActiveMonacoEditor().focus(); });
    await cur.hover('.tl-row:nth-child(3)'); await cur.click('.tl-row:nth-child(3) [data-tl-action="restore"]'); await sleep(1200);
    ok(await text() === 'v1\n', 'Restore puts that version in the editor', await text());
    ok((await file('fa')).content === 'v1\n', 'and saves it to the file');
    h = await hist('fa');
    ok(h.length === 4 && h[0].kind === 'manual' && await histText(h[0].id) === 'v1\n', 'the restore is itself a new version at the top', h.map(x => x.kind));
    ok(await ev(() => { const ed = getActiveMonacoEditor(); ed.trigger('t', 'undo', null); return ed.getValue(); }) === 'v1\nv2\nv3\n', 'and one undo brings the text from before the restore back');
    await cur.hover('.tl-row:nth-child(2)'); await cur.click('.tl-row:nth-child(2) [data-tl-action="delete"]'); await sleep(500);
    s = await tl();
    ok(s.rows.length === 3 && (await hist('fa')).length === 3, 'Delete removes just that one entry', s.rows.length);
    await cur.click('#explorerTimeline .tl-clear'); await sleep(200);
    ok(await ev(() => document.querySelector('#explorerTimeline .tl-clear').classList.contains('tl-armed')) && (await hist('fa')).length === 3, 'the bin asks once more before clearing');
    await cur.click('#explorerTimeline .tl-clear'); await sleep(600);
    ok((await hist('fa')).length === 0 && (await tl()).rows.length === 0, 'the second click clears this file\u2019s history');

    console.log('\n[Ways in: right-click a file, right-click a tab, switching files]');
    await seed();
    await ev(async ([n]) => { await CodeMiniHistory.history.record({ dbName: n, fileId: 'fb', name: 'b.js', content: 'alpha\n', kind: 'manual', now: Date.now() - 3600000 }); }, [dbName]);
    await cur.click('#explorerTimeline .tl-toggle'); await sleep(200); await cur.click('#explorerTimeline .tl-toggle'); await sleep(200);
    await cur.locator('.file-item', { hasText: 'b.js' }).first().click({ button: 'right' }); await sleep(300);
    const names = await ev(() => Array.from(document.querySelectorAll('.dropdown-item')).map(i => i.textContent.trim()));
    ok(names.includes('Local History...'), 'right-clicking a file offers Local History...', names);
    await cur.locator('.dropdown-item', { hasText: 'Local History...' }).click(); await sleep(700);
    s = await tl();
    ok(s.open && s.file === 'b.js' && s.rows.length === 1, 'it opens the Timeline for that file, even though it is not open', s);
    await cur.locator('.file-item', { hasText: 'secret.js' }).first().click({ button: 'right' }); await sleep(300);
    ok(!(await ev(() => Array.from(document.querySelectorAll('.dropdown-item')).map(i => i.textContent.trim()))).includes('Local History...'), 'a locked file does not offer it');
    await cur.keyboard.press('Escape'); await cur.mouse.click(700, 500); await sleep(200);
    await open('fa'); await open('fb');
    await cur.locator('.tab', { hasText: 'a.js' }).first().click({ button: 'right' }); await sleep(300);
    const tabMenu = await ev(() => Array.from(document.querySelectorAll('.df-menu-item')).map(i => i.textContent));
    ok(tabMenu.join() === 'Compare with Saved,Local History...,Close,Close Others', 'a file tab\u2019s menu has Local History...', tabMenu);
    await cur.locator('.df-menu-item', { hasText: 'Local History...' }).click(); await sleep(500);
    s = await tl();
    ok(s.file === 'a.js', 'and it shows that tab\u2019s file', s.file);
    await cur.locator('.tab', { hasText: 'b.js' }).first().click(); await sleep(500);
    ok((await tl()).file === 'b.js', 'switching tabs moves the Timeline to the new file');
    await cur.click('#explorerTimeline .tl-toggle'); await sleep(200);
    ok(!(await tl()).open && await ev(() => localStorage.getItem('codemini_timeline_open')) === '0', 'its open/closed state is remembered');

    // ------------------------------------------------------------------------------------------------
    console.log('\n[Timeline: resizing]');
    await seed(); await open('fa');
    await ev(async ([n]) => { const H = CodeMiniHistory; for (let i = 1; i <= 5; i++) await H.history.record({ dbName: n, fileId: 'fa', name: 'a.js', content: 'v' + i + '\n', kind: 'manual', now: Date.now() - (6 - i) * 3600000 }); }, [dbName]);
    const ACTIVE = await ev(() => localStorage.getItem('codemini_active_window'));
    const setActive = (v) => ev((v) => { if (v === null) localStorage.removeItem('codemini_active_window'); else localStorage.setItem('codemini_active_window', v); window.dispatchEvent(new Event('resize')); }, v);
    const WINK = await ev(() => 'codemini_timeline_height_' + (localStorage.getItem('codemini_active_window') || 'win_default'));
    await ev((k) => localStorage.removeItem(k), WINK);
    if (await ev(() => document.getElementById('explorerTimeline').classList.contains('tl-open'))) { await cur.click('#explorerTimeline .tl-toggle'); await sleep(200); }
    const rz = () => ev(() => { const r = document.querySelector('#explorerTimeline .tl-resizer'); const cs = getComputedStyle(r); return { role: r.getAttribute('role'), orient: r.getAttribute('aria-orientation'), display: cs.display, h: r.getBoundingClientRect().height, cursor: cs.cursor, tab: r.tabIndex }; });
    const bodyInfo = () => ev(() => { const b = document.getElementById('explorerTimelineBody'); return { h: b.offsetHeight, sized: b.classList.contains('tl-sized'), styleH: b.style.height, list: document.getElementById('fileList').offsetHeight, now: document.querySelector('#explorerTimeline .tl-resizer').getAttribute('aria-valuenow') }; });
    const savedH = () => ev((k) => localStorage.getItem(k), WINK);
    const near = (a, b, tol) => Math.abs(a - b) <= (tol || 2);
    let r = await rz();
    ok(r.display === 'none', 'while the Timeline is closed there is no handle', r);
    await cur.click('#explorerTimeline .tl-toggle'); await sleep(500);
    r = await rz();
    ok(r.display !== 'none' && r.h === 6 && r.cursor === 'ns-resize', 'opened, the top edge has a 6px ns-resize handle (like the bottom panel\u2019s)', r);
    ok(r.role === 'separator' && r.orient === 'horizontal' && r.tab === 0, 'it is a focusable separator for keyboard and screen-reader users', r);
    let b0 = await bodyInfo();
    ok(!b0.sized && b0.styleH === '' && await savedH() === null, 'until you resize it, the height is the default and nothing is saved', b0);

    const drag = async (dy) => { const box = await cur.locator('#explorerTimeline .tl-resizer').boundingBox(); const x = box.x + box.width / 2, y = box.y + box.height / 2; await cur.mouse.move(x, y); await cur.mouse.down(); await cur.mouse.move(x, y + dy / 2, { steps: 4 }); await cur.mouse.move(x, y + dy, { steps: 4 }); await cur.mouse.up(); await sleep(200); };
    await drag(-80);
    let b1 = await bodyInfo();
    ok(near(b1.h, b0.h + 80, 3) && b1.sized, 'dragging the edge up 80px makes the Timeline 80px taller', [b0.h, b1.h]);
    ok(near(b1.list, b0.list - 80, 3), 'and the file list gives up exactly that much', [b0.list, b1.list]);
    ok(near(parseInt(await savedH(), 10), b1.h, 1), 'the height is saved for this window', [await savedH(), b1.h]);
    await drag(+1000);
    let b2 = await bodyInfo();
    ok(b2.h === 56, 'dragging far down stops at the 56px minimum', b2);
    await drag(-1500);
    let b3 = await bodyInfo();
    ok(b3.list >= 118 && b3.list <= 124 && b3.h > b1.h, 'dragging far up stops while the file list still has about 120px', b3);
    ok(await cur.locator('#explorerTimeline .tl-row').count() === 5, 'the rows are all still there and scroll inside', await cur.locator('#explorerTimeline .tl-row').count());

    await cur.focus('#explorerTimeline .tl-resizer');
    await cur.keyboard.press('ArrowDown'); await sleep(100);
    let k1 = await bodyInfo();
    ok(near(k1.h, b3.h - 16, 1), 'Down arrow on the handle: 16px shorter', [b3.h, k1.h]);
    await cur.keyboard.press('Shift+ArrowDown'); await sleep(100);
    let k2 = await bodyInfo();
    ok(near(k2.h, k1.h - 64, 1), 'Shift+Down: 64px shorter', [k1.h, k2.h]);
    await cur.keyboard.press('ArrowUp'); await sleep(100);
    let k3 = await bodyInfo();
    ok(near(k3.h, k2.h + 16, 1) && near(parseInt(await savedH(), 10), k3.h, 1) && near(parseInt(k3.now, 10), k3.h, 1), 'Up arrow: 16px taller, saved, and announced through aria-valuenow', k3);

    await cur.dblclick('#explorerTimeline .tl-resizer'); await sleep(200);
    let d1 = await bodyInfo();
    ok(!d1.sized && d1.styleH === '' && await savedH() === null, 'double-clicking the handle puts the default back and forgets the saved height', d1);
    await cur.focus('#explorerTimeline .tl-resizer'); await cur.keyboard.press('ArrowUp'); await sleep(100);
    await cur.keyboard.press('Home'); await sleep(100);
    ok(!(await bodyInfo()).sized && await savedH() === null, 'Home on the handle does the same');

    const touchDrag = (dy) => ev((dy) => { const el = document.querySelector('#explorerTimeline .tl-resizer'); const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const mk = (type, yy) => { const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: yy }); return new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }); }; el.dispatchEvent(mk('touchstart', y)); document.dispatchEvent(mk('touchmove', y + dy / 2)); document.dispatchEvent(mk('touchmove', y + dy)); document.dispatchEvent(mk('touchend', y + dy)); }, dy);
    const t0 = (await bodyInfo()).h;
    await touchDrag(-60); await sleep(200);
    const t1 = await bodyInfo();
    ok(near(t1.h, t0 + 60, 3) && t1.sized && near(parseInt(await savedH(), 10), t1.h, 1), 'a finger drags it too (touch events), and it is saved', [t0, t1.h]);

    await cur.click('#explorerTimeline .tl-toggle'); await sleep(200);
    ok((await bodyInfo()).sized && near(parseInt(await savedH(), 10), t1.h, 1), 'closing and reopening keeps the size', await bodyInfo());
    await cur.click('#explorerTimeline .tl-toggle'); await sleep(500);
    ok(near((await bodyInfo()).h, t1.h, 1), 'reopened at the same height', [(await bodyInfo()).h, t1.h]);

    const reach = async (target) => { const cur0 = (await bodyInfo()).h; await drag(cur0 - target); return (await bodyInfo()).h; };
    const want = await reach(300);
    ok(near(want, 300, 3) && near(parseInt(await savedH(), 10), want, 1), 'a 300px Timeline is chosen and saved', want);
    await cur.setViewportSize({ width: 1280, height: 520 }); await sleep(600);
    const small = await bodyInfo();
    ok(small.h < want && small.list >= 112 && small.list <= 128, 'in a short window it shrinks so the file list keeps about 120px', small);
    ok(parseInt(await savedH(), 10) === want, 'without forgetting the height you chose', await savedH());
    await cur.setViewportSize({ width: 1280, height: 800 }); await sleep(600);
    ok(near((await bodyInfo()).h, want, 1), 'and goes back to it when the window is tall again', [(await bodyInfo()).h, want]);

    await ev(([k, v]) => localStorage.setItem(k, String(v)), [WINK, 230]);
    await reload();
    await ensureExplorer();
    const rl = await bodyInfo();
    ok(await ev(() => document.getElementById('explorerTimeline').classList.contains('tl-open')) && near(rl.h, 230, 1) && rl.sized, 'after a reload the Timeline comes back at its saved height', rl);
    await setActive('win_other'); await sleep(400);
    const other = await bodyInfo();
    ok(!other.sized, 'a window with no saved height of its own shows the default (heights are per window)', other);
    await setActive(ACTIVE); await sleep(400);
    ok(near((await bodyInfo()).h, 230, 1), 'and switching back brings this window\u2019s own height back', (await bodyInfo()).h);
    await ev((k) => localStorage.removeItem(k), WINK);
    await cur.dblclick('#explorerTimeline .tl-resizer'); await sleep(150);
    await cur.click('#explorerTimeline .tl-toggle'); await sleep(200);

    console.log('\n[Hot exit: type, reload, get it back]');
    await seed(); await open('fa');
    ok((await backups()).length === 0, 'nothing is backed up before anything is typed');
    await setText('one\ntwo\nTYPED NOT SAVED\n'); await sleep(2400);
    let b = await backups();
    ok(b.length === 1 && b[0].fileId === 'fa' && b[0].content === 'one\ntwo\nTYPED NOT SAVED\n', 'unsaved text is backed up a moment after typing stops', b);
    ok((await file('fa')).content === 'one\ntwo\nthree\n', 'and the file itself is untouched');
    await setText('one\ntwo\nthree\n'); await sleep(2200);
    ok((await backups()).length === 0, 'typing back to exactly what is saved removes the backup');
    await setText('one\ntwo\nTYPED NOT SAVED\n'); await sleep(2400);
    await save();
    ok((await backups()).length === 0, 'saving removes it');
    await seed(); await open('fa');
    await ev(() => { window.appSettings.hotExit = 'Off'; });
    await setText('typed while hot exit is off\n'); await sleep(2400);
    ok((await backups()).length === 0, 'with Hot Exit off nothing is backed up');
    await ev(() => { window.appSettings.hotExit = 'On'; });

    await seed(); await open('fa');
    await setText('typed then page hides\n');
    await ev(() => window.dispatchEvent(new Event('pagehide'))); await sleep(500);
    ok((await backups()).length === 1, 'a page that is hiding writes its backup at once, without waiting for the pause');

    await seed(); await open('fb');
    await setText('alpha\nbeta\nTHIS IS CLOSED ON PURPOSE\n'); await sleep(2400);
    ok((await backups()).length === 1, 'closing on purpose: the backup exists first');
    await ev(() => document.querySelector('.tab.active .tab-close').click()); await sleep(600);
    ok((await backups()).length === 0, 'closing the tab removes it, so it does not come back on the next start');
    h = await hist('fb');
    ok(h.length === 1 && h[0].kind === 'closed' && await histText(h[0].id) === 'alpha\nbeta\nTHIS IS CLOSED ON PURPOSE\n', 'but the text typed is not lost: it is kept in history as "closed unsaved"', h);
    ok((await file('fb')).content === 'alpha\nbeta\n', 'and the file was not changed by closing');

    console.log('\n[Hot exit: after a reload]');
    await seed(); await open('fa'); await open('fb');
    await setText('alpha\nbeta\nB TYPED NOT SAVED\n');
    await cur.locator('.tab', { hasText: 'a.js' }).first().click(); await sleep(400);
    await setText('one\ntwo\nA TYPED NOT SAVED\n'); await sleep(2600);
    ok((await backups()).length === 2, 'two dirty files, two backups', (await backups()).length);
    await setSaved('autoSave', 'After Delay'); // after the reload, auto save would write recovered text if recovery let it
    await reload();
    const ts = await tabs();
    ok(ts.filter(t => t.type === 'monaco').length === 2 && ts.every(t => t.type !== 'monaco' || t.dirty), 'both files are back in their tabs and marked unsaved', ts);
    await cur.locator('.tab', { hasText: 'a.js' }).first().click(); await sleep(500);
    ok(await text() === 'one\ntwo\nA TYPED NOT SAVED\n', 'a.js holds the text that was typed', await text());
    await cur.locator('.tab', { hasText: 'b.js' }).first().click(); await sleep(500);
    ok(await text() === 'alpha\nbeta\nB TYPED NOT SAVED\n', 'and so does b.js', await text());
    await sleep(2500);
    ok((await file('fa')).content === 'one\ntwo\nthree\n' && (await file('fb')).content === 'alpha\nbeta\n', 'even with auto save on, recovered text is not written to the files by itself');
    await setSaved('autoSave', 'Off'); // the undo / redo below are edits too: with auto save on they would (rightly) be saved
    ok(await ev(() => { const ed = getActiveMonacoEditor(); ed.trigger('t', 'undo', null); return ed.getValue(); }) === 'alpha\nbeta\n', 'one undo returns a recovered file to its saved text');
    await ev(() => { const ed = getActiveMonacoEditor(); ed.trigger('t', 'redo', null); });
    const note = await ev(() => CodeMiniNotifications.list().find(n => n.id === 'hot-exit-recovered') || null);
    ok(note && note.title === 'Recovered 2 unsaved files' && /a\.js/.test(note.text) && /b\.js/.test(note.text) && note.actions.join() === 'review-recovered', 'a notification says "Recovered 2 unsaved files" and offers Review', note);
    ok(await ev(() => window.__toastNodes.some(n => /Recovered 2 unsaved files/.test(n.textContent))), 'and a toast showed it when the files came back');
    await ev(() => CodeMiniNotifications.open('hot-exit-recovered')); await sleep(500);
    ok(await ev(() => Array.from(document.querySelectorAll('.ni-btn')).some(b => b.textContent === 'Review')), 'the notification has a Review button');
    await cur.locator('.ni-btn', { hasText: 'Review' }).click(); await sleep(2500);
    ok((await diffTabs()).length === 2 && (await diffTabs()).every(x => /Saved/.test(x)), 'Review opens each recovered file against its saved version', await diffTabs());
    await ev(() => Array.from(document.querySelectorAll('.tab[data-type="diff"]')).forEach(t => t.querySelector('.tab-close').click())); await sleep(300);
    await cur.locator('.tab', { hasText: 'a.js' }).first().click(); await sleep(400);
    await save();
    ok((await file('fa')).content === 'one\ntwo\nA TYPED NOT SAVED\n', 'saving a recovered tab writes it (and only then)');
    const bAfter = await backups();
    ok(bAfter.filter(x => x.fileId === 'fa').length === 0 && bAfter.filter(x => x.fileId === 'fb').length === 1, 'its backup goes, the other file\u2019s stays until it is saved or closed', bAfter.map(x => [x.fileId, x.content, x.pageId]));
    await setSaved('autoSave', 'Off');

    console.log('\n[Hot exit: a file that changed meanwhile, one that is gone]');
    await seed(); await open('fa');
    await setText('one\ntwo\nMY EDIT\n'); await sleep(2400);
    await ev(() => new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); const st = tx.objectStore('filesystem'); st.get('fa').onsuccess = (e) => { const r = e.target.result; r.content = 'changed by a pull\n'; st.put(r); }; tx.oncomplete = res; }));
    await ev(([n]) => CodeMiniHistory.store.putBackup({ key: n + '|ghost', dbName: n, fileId: 'ghost', name: 'ghost.js', content: 'for a file that is gone', baseHash: null, pageId: 'dead-page' }), [dbName]);
    await reload();
    const n2 = await ev(() => CodeMiniNotifications.list().find(n => n.id === 'hot-exit-recovered') || null);
    ok(n2 && n2.title === 'Recovered 1 unsaved file' && /changed after/.test(n2.text), 'if the file changed after the backup, the notification says to check before saving', n2);
    await cur.locator('.tab', { hasText: 'a.js' }).first().click(); await sleep(400);
    ok(await text() === 'one\ntwo\nMY EDIT\n', 'the typed text is still what the editor shows');
    ok((await file('fa')).content === 'changed by a pull\n', 'and the newer file on disk is not overwritten');
    ok((await backups()).filter(x => x.fileId === 'ghost').length === 0 && !(await tabs()).some(t => /ghost/.test(t.name)), 'a backup of a file that no longer exists is dropped quietly');

    console.log('\n[Hot exit: a second window must not take over a live one]');
    await seed(); await open('fa');
    await setText('one\ntwo\nLIVE IN WINDOW A\n'); await sleep(2400);
    const pageB = await context.newPage(); await prepare(pageB);
    await pageB.goto(URL); await sleep(BOOT);
    cur = pageB;
    const bTabs = await tabs();
    const bNote = await ev(() => CodeMiniNotifications.list().find(n => n.id === 'hot-exit-recovered' && n.session === undefined) || null);
    const bText = bTabs.some(t => t.name === 'a.js') ? await (async () => { await cur.locator('.tab', { hasText: 'a.js' }).first().click(); await sleep(400); return text(); })() : null;
    ok(bText === null || bText === 'one\ntwo\nthree\n', 'a second window opens a.js as it is saved, not with window A\u2019s typed text', bText);
    ok(!(bTabs.some(t => t.dirty)), 'and none of its tabs are marked unsaved', bTabs);
    ok((await backups()).length === 1 && (await backups())[0].content === 'one\ntwo\nLIVE IN WINDOW A\n', 'window A\u2019s backup is still there');
    cur = page;
    await page.close();
    await sleep(800);
    cur = pageB;
    await reload(pageB);
    const bText2 = await (async () => { const t = await tabs(); if (!t.some(x => x.name === 'a.js')) return null; await cur.locator('.tab', { hasText: 'a.js' }).first().click(); await sleep(400); return text(); })();
    ok(bText2 === 'one\ntwo\nLIVE IN WINDOW A\n', 'once window A is gone, the next start recovers its text', bText2);
  } else {
    ['saves leave versions', 'Timeline rows and actions', 'hot exit reload cycle', 'second window safety', 'locked files'].forEach(n => { skipped++; console.log('  SKIP', n, '(needs MONACO_DIR)'); });
  }

  const errs = [].concat(...[page, cur].filter(Boolean).map(p => p.errors || [])).filter((e, i, arr) => arr.indexOf(e) === i);
  ok(errs.length === 0, 'no uncaught errors in the page', errs.slice(0, 3));
  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
