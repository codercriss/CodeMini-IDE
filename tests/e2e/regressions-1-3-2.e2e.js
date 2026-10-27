// Regressions fixed in 1.3.2. Every check here fails against the 1.3.1 code (see CHANGELOG "1.3.2").
//   1. The shared dialog kept the previous dialog's message when opened without any (New File, New Document ...).
//   2. The Console's Trusted/Untrusted toggle was also toggled by the notebook's page-wide handler.
//   3. The Console's Variables Explorer refresh also ran the notebook's refresh on the Console's own list.
//   4. SQL notebook "copy table" dropped every data cell (querySelectorAll('th', 'td') takes ONE selector).
//   5. The archive viewer's "Extract all" threw "fileData is not defined" and used the Explorer's folder.
//   6. The explorer's date column called a file from two calendar days ago "Yesterday".
const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const NOISE = /monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i;
const BASE = 'http://localhost:8765/';

// A tiny stand-in for archive-wasm (the sandbox and CI have no network). extract() yields one entry.
const ARCHIVE_STUB = "export function extract(){ return [{ path: 'dir/a.txt', type: 'FILE', data: new Uint8Array([104, 105]) }]; }";

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  // Registered first, so the stub below (registered later) wins for its URL.
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.route('https://esm.sh/archive-wasm@2.1.0', r => r.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: ARCHIVE_STUB }));
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { setTimeout(() => { window.monaco = mk(); cb(); }, 0); }; window.require.config = () => {};
  });
  await page.goto(BASE);
  await page.waitForFunction(() => !window.CodeMiniPreloader || !window.CodeMiniPreloader.isActive(), null, { timeout: 15000 }).catch(() => {});
  await sleep(1200);
  return { page, errors, ev: (f, a) => page.evaluate(f, a) };
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const allErrors = [];

  // ---------------------------------------------------------------------------------------------
  console.log('\n[1] the shared dialog never shows the previous dialog\'s message');
  let s = await newPage(browser); const ev = s.ev;
  const modal = () => ev(() => { const t = document.getElementById('genModalText'); return { shown: document.getElementById('genericModal').classList.contains('show'), title: document.getElementById('genModalLabel').textContent, display: t.style.display, text: t.textContent }; });
  const cancel = () => ev(() => document.getElementById('genModalCancel').click());
  const card = (label) => ev((l) => { const c = [...document.querySelectorAll('.launcher-card')].find(x => x.querySelector('span') && x.querySelector('span').textContent === l); if (c) c.click(); return !!c; }, label);

  await ev(() => window.showCustomModal({ title: 'Open GitHub Repo', text: 'Enter repository (e.g., facebook/react):', inputType: 'text', submitText: 'Fetch' }, () => {}));
  let m = await modal();
  ok(m.shown && m.display === 'block' && /Enter repository/.test(m.text), 'a dialog with text shows it', m);
  await cancel();
  await ev(() => window.showCustomModal({ title: 'New Document', inputType: 'text', inputValue: 'Untitled Document', submitText: 'Create' }, () => {}));
  m = await modal();
  ok(m.shown && m.title === 'New Document' && m.display === 'none' && m.text === '', 'the next dialog, opened without text, has no message left over', m);
  await cancel();

  // The same thing through the real Workspace tiles (the screens in the bug report).
  await ev(() => window.showCustomModal({ title: 'Delete', text: 'Are you sure you want to permanently delete this cell?', submitText: 'Delete' }, () => {}));
  await cancel();
  ok(await card('Python Script'), 'Python Script tile found');
  await sleep(200);
  m = await modal();
  ok(m.shown && /Python Script/.test(m.title) && m.display === 'none' && m.text === '', 'Python Script tile: no stale "delete this cell" message', m);
  await cancel();
  await ev(() => window.showCustomModal({ title: 'Close Window', text: 'Are you sure you want to close window "Window-1"?', submitText: 'Close' }, () => {}));
  await cancel();
  ok(await card('Document'), 'Document tile found');
  await sleep(200);
  m = await modal();
  ok(m.shown && m.title === 'New Document' && m.display === 'none' && m.text === '', 'Document tile: no stale "close window" message', m);
  await cancel();
  // text that is HTML-ish stays text (the dialog sets textContent), and a later textless dialog still clears it.
  await ev(() => window.showCustomModal({ title: 'x', text: '<b>bold</b>', submitText: 'OK' }, () => {}));
  ok(await ev(() => document.getElementById('genModalText').querySelector('b') === null), 'dialog text is still plain text, not HTML');
  await cancel();
  allErrors.push(...s.errors);

  // ---------------------------------------------------------------------------------------------
  console.log('\n[2] Console Trusted/Untrusted toggle');
  s = await newPage(browser);
  const trustUi = () => s.ev(() => { const a = document.querySelector('.tb-trust'); const win = localStorage.getItem('codemini_active_window') || 'win_default'; let saved = null; try { saved = JSON.parse(localStorage.getItem('codemini_console_' + win + '_javascript')); } catch (e) {} return { label: a.querySelector('span').textContent, attr: a.dataset.trusted, saved: saved && saved.isTrusted }; });
  const clickTrust = () => s.ev(() => document.querySelector('.tb-trust').click());
  await s.ev(() => window.openLanguageConsole('JavaScript')); await sleep(600);
  let t = await trustUi();
  ok(t.label === 'Trusted' && t.attr === 'true', 'starts Trusted', t);
  await clickTrust(); t = await trustUi();
  ok(t.label === 'Untrusted' && t.attr === 'false' && t.saved === false, 'click 1: Untrusted, and that is what is saved', t);
  await clickTrust(); t = await trustUi();
  ok(t.label === 'Trusted' && t.attr === 'true' && t.saved === true, 'click 2: back to Trusted (this was stuck on Untrusted)', t);
  await clickTrust(); await clickTrust(); await clickTrust(); t = await trustUi();
  ok(t.label === 'Untrusted' && t.saved === false, 'three more clicks end Untrusted: the label and the saved state always agree', t);
  // The state that is really used for running code is the one that is saved: prove it by running something that only works Trusted.
  await clickTrust(); t = await trustUi();
  ok(t.label === 'Trusted' && t.saved === true, 'and Trusted again', t);
  allErrors.push(...s.errors);

  console.log('\n[2b] the same in a Restricted Mode workspace (where it used to be stuck for good)');
  s = await newPage(browser);
  await s.ev(() => window.saveSetting('workspaceTrustEmptyWindow', false));
  ok(await s.ev(() => !window.WorkspaceTrust.isTrusted()), 'precondition: this workspace is restricted');
  await s.ev(() => window.openLanguageConsole('JavaScript')); await sleep(600);
  await clickTrust(); await clickTrust(); t = await trustUi();
  ok(t.label === 'Trusted' && t.saved === true, 'Untrusted then Trusted again works', t);
  await clickTrust(); t = await trustUi();
  ok(t.label === 'Untrusted' && t.saved === false, 'and Untrusted again', t);
  allErrors.push(...s.errors);

  // ---------------------------------------------------------------------------------------------
  console.log('\n[3] Console Variables Explorer: refresh stays in the Console');
  s = await newPage(browser);
  await s.ev(() => window.openLanguageConsole('JavaScript')); await sleep(600);
  await s.ev(() => { window.__nbRefresh = 0; window.updateVariablesExplorer = () => { window.__nbRefresh++; }; });
  await s.ev(() => document.querySelector('.console-container .vars-refresh').click()); await sleep(300);
  ok(await s.ev(() => window.__nbRefresh === 0), 'refresh in a Console does not call the notebook\'s updateVariablesExplorer', await s.ev(() => window.__nbRefresh));
  await s.ev(() => document.querySelector('.console-container .tb-vars').click()); await sleep(200);
  ok(await s.ev(() => document.querySelector('.console-vars-panel').classList.contains('show') && window.__nbRefresh === 0), 'the toolbar button opens the Console\'s own panel and still does not call it');
  await s.ev(() => document.querySelector('.console-container .vars-close').click()); await sleep(100);
  ok(await s.ev(() => !document.querySelector('.console-vars-panel').classList.contains('show')), 'close hides the Console\'s panel');
  // a notebook's own refresh is untouched: a fake notebook pane with the markup the delegate expects
  await s.ev(() => {
    const p = document.createElement('div'); p.className = 'content-pane'; p.id = 'fakeNb';
    p.innerHTML = '<div class="vars-explorer-panel"><i class="vars-refresh"></i><div class="vars-content"></div></div>';
    document.body.appendChild(p);
    document.querySelector('#fakeNb .vars-refresh').click();
  }); await sleep(100);
  ok(await s.ev(() => window.__nbRefresh === 1), 'in a notebook the same icon still refreshes (one call)', await s.ev(() => window.__nbRefresh));
  allErrors.push(...s.errors);

  // ---------------------------------------------------------------------------------------------
  console.log('\n[4] SQL notebook "copy table" keeps the data rows');
  s = await newPage(browser);
  const copied = await s.ev(async () => {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<table id="sqlT"><thead><tr><th>id</th><th>name</th></tr></thead><tbody><tr><td>1</td><td>Ada</td></tr><tr><td>2</td><td>Linus</td></tr></tbody></table>';
    document.body.appendChild(wrap);
    let text = null;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (x) => { text = x; return Promise.resolve(); } }, configurable: true });
    window.copySqlTable('sqlT');
    await new Promise(r => setTimeout(r, 100));
    return text;
  });
  ok(copied === 'id\tname\n1\tAda\n2\tLinus\n', 'header and both data rows are copied, tab separated', copied);
  allErrors.push(...s.errors);

  // ---------------------------------------------------------------------------------------------
  console.log('\n[5] archive viewer: Extract all');
  s = await newPage(browser);
  await s.ev(async () => {
    const rec = { id: 'arc1', parentId: 'folderX', name: 'pack.zip', type: 'file', encoding: 'base64', content: btoa('PK-stub'), timestamp: Date.now() };
    await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put(rec); tx.oncomplete = res; });
    const pane = document.createElement('div'); pane.id = 'paneArc';
    pane.innerHTML = '<div class="archive-viewer-loading"></div><div class="archive-viewer-tree" style="display:none"></div><button class="archive-extract-all-btn" style="display:none">Extract all</button>';
    document.body.appendChild(pane);
    window.__saved = null;
    window.saveExtractedFiles = async (files, parentId) => { window.__saved = { files, parentId }; };
    await window.initArchiveViewer('arc1', 'paneArc');
  });
  ok(await s.ev(() => document.querySelector('#paneArc .archive-viewer-tree').style.display === 'block' && document.querySelector('#paneArc .archive-viewer-tree').textContent.includes('a.txt')), 'the archive tree renders (with the stand-in reader)');
  const errBefore = s.errors.length;
  await s.ev(() => document.querySelector('#paneArc .archive-extract-all-btn').click()); await sleep(300);
  const newErrs = s.errors.slice(errBefore);
  ok(newErrs.length === 0, 'Extract all does not throw (it used to: "fileData is not defined")', newErrs);
  const saved = await s.ev(() => window.__saved);
  ok(saved && saved.files.length === 1 && saved.files[0].name === 'a.txt' && saved.files[0].path === 'dir', 'it extracts the archive\'s entries', saved);
  ok(saved && saved.parentId === 'folderX', 'into the folder the archive lives in, not the Explorer\'s current folder', saved && saved.parentId);
  allErrors.push(...s.errors.slice(0, errBefore));

  // ---------------------------------------------------------------------------------------------
  console.log('\n[6] explorer date labels use calendar days');
  s = await newPage(browser);
  const labels = await s.ev(() => {
    const n = new Date(), at = (dd, h, mi) => new Date(n.getFullYear(), n.getMonth(), n.getDate() + dd, h, mi).getTime();
    return {
      today: formatTime(at(0, 0, 0)), yesterdayLate: formatTime(at(-1, 23, 59)), yesterdayEarly: formatTime(at(-1, 0, 5)),
      twoDaysLate: formatTime(at(-2, 23, 30)), twoDaysExpected: new Date(at(-2, 23, 30)).toLocaleDateString(),
      lastWeek: formatTime(at(-7, 12, 0)), lastWeekExpected: new Date(at(-7, 12, 0)).toLocaleDateString(), none: formatTime(0)
    };
  });
  ok(labels.today === 'Today', 'earlier today is Today', labels);
  ok(labels.yesterdayLate === 'Yesterday' && labels.yesterdayEarly === 'Yesterday', 'any time yesterday is Yesterday', labels);
  ok(labels.twoDaysLate === labels.twoDaysExpected, 'two calendar days ago (even at 23:30) is a date, not "Yesterday"', labels);
  ok(labels.lastWeek === labels.lastWeekExpected && labels.none === '', 'older dates and "no date" are unchanged', labels);
  allErrors.push(...s.errors);

  const rel = allErrors.filter(e => !NOISE.test(e));
  ok(rel.length === 0, 'no unexpected page errors', rel);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
