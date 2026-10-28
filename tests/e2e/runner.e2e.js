// Isolated previews, for real: the app on http://localhost:8765 and the runner on http://localhost:8766 are two
// different origins. Checks that a previewed page works (CSS, JS, console, refresh), that it cannot reach the app
// (storage, functions, messages), that forged messages are ignored, and that the app falls back safely when the
// runner is missing, switched off, or pointed at the app's own origin.
const path = require('path'), http = require('http');
const { chromium } = require('playwright');
const { createServer } = require('./lib/static-server');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const APP = 'http://localhost:8765', RUNNER = 'http://localhost:8766';

const FILES = [
  { id: 'rn1', name: 'index.html', content: '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1 id="t">Hello isolated</h1><script src="app.js"></script></body></html>' },
  { id: 'rn2', name: 'style.css', content: 'h1 { color: rgb(1, 2, 3); }' },
  { id: 'rn3', name: 'app.js', content: "document.getElementById('t').dataset.ran = 'yes'; console.log('from-the-page'); try { localStorage.setItem('kv', '1'); } catch (e) {}" }
];

async function open(browser, runnerUrl, extraLs, viewport) {
  const phone = viewport && viewport.width < 600;
  const ctx = await browser.newContext(phone ? { viewport, deviceScaleFactor: 2, hasTouch: true, isMobile: true } : { viewport: viewport || { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/^\[CodeMini\]/.test(m.text())) console.log('    [app]', m.text().slice(0, 160)); });
  await page.addInitScript(([runnerUrl, extraLs]) => {
    if (location.port === '8765') {
      if (runnerUrl) localStorage.setItem('codemini_runner_url', runnerUrl);
      Object.keys(extraLs || {}).forEach(k => localStorage.setItem(k, extraLs[k]));
    }
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); }; window.require.config = () => {};
  }, [runnerUrl, extraLs || {}]);
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.goto(APP + '/index.html'); await sleep(3500);
  // The preview prefers live editor content. The mocked Monaco has none, so say "no editor is open for this file"
  // and let it use the saved file, as it does for any file that is not being edited.
  // A test sets window.__liveText to simulate what is typed in the open editor; until then there is no live editor.
  await page.evaluate(() => { const m = window.monaco; window.monaco = new Proxy(m, { get: (t, k) => (k === 'editor' ? new Proxy(t.editor, { get: (e, j) => (j === 'getEditors' ? () => (window.__liveText === undefined ? [] : [...document.querySelectorAll('[id^="editor-container-"]')].map(c => ({ getContainerDomNode: () => c, getValue: () => window.__liveText }))) : e[j]) }) : t[k]) }); });
  await page.evaluate(async (FILES) => {
    for (const f of FILES) await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put({ id: f.id, parentId: 'root', name: f.name, type: 'file', content: f.content, timestamp: Date.now() }); tx.oncomplete = res; });
    openFileInTab({ id: 'rn1', parentId: 'root', name: 'index.html', type: 'file', content: FILES[0].content, timestamp: Date.now() });
  }, FILES);
  await sleep(800);
  return { ctx, page, errors };
}
const innerFrame = (page) => page.frames().find(f => f.parentFrame() && /shell\.html/.test(f.parentFrame().url())); // the page, whatever its URL (an in-place rewrite changes it)
const previewFrame = (page, origin) => page.frames().find(f => f.url().startsWith('blob:' + origin + '/'));

(async () => {
  const runnerServer = createServer(require('../lib/paths').runnerDir(), { headers: { 'Content-Security-Policy': "frame-ancestors 'self' http://localhost:8765 http://127.0.0.1:8765" } });
  await new Promise(r => runnerServer.listen(8766, r));
  const strangerServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<iframe id="r" src="http://localhost:8766/shell.html" style="width:300px;height:200px"></iframe>'); });
  await new Promise(r => strangerServer.listen(8769, r));
  // A runner whose inner page never loads: its shell shows about:blank instead of the page (the blank preview seen on a phone).
  const fs = require('fs');
  const brokenServer = createServer(require('../lib/paths').runnerDir());
  const baseHandler = brokenServer.listeners('request')[0];
  brokenServer.removeAllListeners('request');
  brokenServer.on('request', (req, res) => {
    if (req.url.split('?')[0] === '/shell.js') {
      const src = fs.readFileSync(require('../lib/paths').resolve('runner/shell.js'), 'utf8').replace('page.src = url;', "page.src = 'about:blank';");
      res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(src);
    } else baseHandler(req, res);
  });
  await new Promise(r => brokenServer.listen(8768, r));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  console.log('\n[isolated preview]');
  let { ctx, page, errors } = await open(browser, RUNNER);
  const ev = (f, a) => page.evaluate(f, a);
  await ev(() => document.getElementById('playIconItem').click()); await sleep(4500);
  ok(await ev(() => document.getElementById('livePreviewContainer').classList.contains('show')), 'preview opened');
  ok(await ev(() => new URL(document.getElementById('lpIframe').src).origin) === RUNNER, 'the preview frame is the runner, on its own origin');
  ok(await ev(() => /Isolated/.test(document.getElementById('lpIsolation').title) && document.getElementById('lpIsolation').style.display !== 'none'), 'the toolbar says it is isolated');
  let pf = previewFrame(page, RUNNER);
  ok(!!pf, 'the page itself is a blob: document on the runner origin', page.frames().map(f => f.url().slice(0, 40)));
  if (pf) {
    ok(await pf.evaluate(() => document.getElementById('t').textContent) === 'Hello isolated', 'the HTML rendered');
    ok(await pf.evaluate(() => getComputedStyle(document.getElementById('t')).color) === 'rgb(1, 2, 3)', 'the linked stylesheet applied (minted by the runner)');
    ok(await pf.evaluate(() => document.getElementById('t').dataset.ran) === 'yes', 'the linked script ran');
  }
  ok((await ev(() => document.getElementById('lpConsoleContent').innerText)).includes('from-the-page'), "the page's console output reaches the app's console panel through the relay");

  console.log('\n[the page cannot reach the app]');
  if (pf) {
    const probe = await pf.evaluate(async (APP) => {
      const o = {};
      try { o.topStorage = window.top.localStorage.length; } catch (e) { o.topStorage = 'blocked:' + e.name; }
      try { o.topShield = typeof window.top.CodeMiniShield; } catch (e) { o.topShield = 'blocked:' + e.name; }
      try { o.appDoc = typeof window.parent.parent.document.title; } catch (e) { o.appDoc = 'blocked:' + e.name; }
      try { o.fetch = (await fetch(APP + '/js/core/shield.js')).status; } catch (e) { o.fetch = 'blocked:' + e.name; }
      try { o.dbs = (await indexedDB.databases()).map(d => d.name); } catch (e) { o.dbs = 'err:' + e.name; }
      o.ownOrigin = location.origin;
      return o;
    }, APP);
    ok(/^blocked/.test(probe.topStorage), "cannot read the app's localStorage", probe.topStorage);
    ok(/^blocked/.test(probe.topShield), 'cannot call window.top.CodeMiniShield', probe.topShield);
    ok(/^blocked/.test(probe.appDoc), "cannot reach the app's document", probe.appDoc);
    ok(/^blocked/.test(probe.fetch), "cannot read the app's files with fetch (no CORS)", probe.fetch);
    ok(!probe.dbs.some(n => /codemini|CodeMiniDB|shield/i.test(n)), "the app's IndexedDB databases (workspace, device key) are not visible", probe.dbs);
    ok(probe.ownOrigin === RUNNER, 'the page runs on the runner origin', probe.ownOrigin);

    console.log('\n[forged messages are ignored]');
    await pf.evaluate(() => {
      window.top.postMessage({ type: 'console', level: 'log', args: ['FORGED-TOP'] }, '*');
      window.top.postMessage({ cmRunner: 1, op: 'minted', id: 1, nonce: '0'.repeat(32), url: 'blob:http://localhost:8766/evil' }, '*');
      window.parent.postMessage({ cmRunner: 1, op: 'page', data: { type: 'console', level: 'log', args: ['FORGED-WRAPPED'] } }, '*');
      window.parent.postMessage({ cmRunner: 1, op: 'minted', id: 1, nonce: '0'.repeat(32), url: 'blob:http://localhost:8766/evil2' }, '*');
      console.log('after-forgeries');
    });
    await sleep(800);
    const con = await ev(() => document.getElementById('lpConsoleContent').innerText);
    ok(con.includes('after-forgeries') && !/FORGED/.test(con), 'forged console messages (direct and wrapped) never reach the console panel', con.slice(0, 200));
  }

  console.log('\n[refresh and pop-out]');
  await ev(async () => { await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); const st = tx.objectStore('filesystem'); const g = st.get('rn1'); g.onsuccess = () => { const r = g.result; r.content = r.content.replace('Hello isolated', 'Hello again'); st.put(r); }; tx.oncomplete = res; }); });
  await ev(() => document.getElementById('lpRefreshBtn').click()); await sleep(2500);
  pf = previewFrame(page, RUNNER);
  ok(!!pf && await pf.evaluate(() => document.getElementById('t').textContent) === 'Hello again', 'Refresh reloads the edited file through the runner');
  ok(!!pf && await pf.evaluate(() => getComputedStyle(document.getElementById('t')).color) === 'rgb(1, 2, 3)', 'and its stylesheet still applies after the reload');
  console.log('\n[reload strategy: in-place rewrite vs full navigation]');
  await pf.evaluate(() => { window.__keep = 1; });                     // JS state inside the page
  const urlBefore = pf.url();
  await ev(async () => { await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); const st = tx.objectStore('filesystem'); const g = st.get('rn1'); g.onsuccess = () => { const r = g.result; r.content = r.content.replace('Hello again', 'Navigated'); st.put(r); }; tx.oncomplete = res; }); });
  await ev(() => document.getElementById('lpRefreshBtn').click()); await sleep(2500);
  pf = previewFrame(page, RUNNER);
  ok(!!pf && await pf.evaluate(() => document.getElementById('t').textContent) === 'Navigated', 'Full Navigation: the edit shows');
  ok(!!pf && await pf.evaluate(() => window.__keep) === undefined, 'Full Navigation starts a fresh page (its JavaScript state is gone)');
  ok(!!pf && pf.url() !== urlBefore, 'and it is a new document URL');
  await ev(() => localStorage.setItem('codemini_preview_reload_mode', 'legacy'));
  await ev(() => document.getElementById('lpRefreshBtn').click()); await sleep(2500);     // first legacy render: nothing to rewrite yet, so it navigates
  pf = previewFrame(page, RUNNER);
  ok(!!pf && await pf.evaluate(() => document.getElementById('t').textContent) === 'Navigated', 'Legacy, first render: falls back to navigating (nothing to rewrite yet)');
  await pf.evaluate(() => { window.__keep = 7; });
  const frameBefore = pf;
  const logsBefore = (await ev(() => document.getElementById('lpConsoleContent').innerText)).split('from-the-page').length - 1;
  await ev(async () => { await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); const st = tx.objectStore('filesystem'); const g = st.get('rn1'); g.onsuccess = () => { const r = g.result; r.content = r.content.replace('Navigated', 'Rewritten'); st.put(r); }; tx.oncomplete = res; }); });
  await ev(() => document.getElementById('lpRefreshBtn').click()); await sleep(2500);
  pf = innerFrame(page);
  ok(!!pf && await pf.evaluate(() => document.getElementById('t').textContent) === 'Rewritten', 'Legacy: the edit shows');
  ok(!!pf && await pf.evaluate(() => window.__keep) === 7, 'Legacy rewrites in place: the page keeps its window and JavaScript state');
  ok(pf === frameBefore, 'in the same frame (nothing was navigated)');
  ok(!!pf && await pf.evaluate(() => getComputedStyle(document.getElementById('t')).color) === 'rgb(1, 2, 3)', 'and the stylesheet still applies after the rewrite');
  const logsAfter = (await ev(() => document.getElementById('lpConsoleContent').innerText)).split('from-the-page').length - 1;
  ok(logsAfter === logsBefore + 1, 'the rewritten page reports to the console panel exactly once (the helper script is not installed twice)', { logsBefore, logsAfter });
  await ev(async () => { await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); const st = tx.objectStore('filesystem'); const g = st.get('rn1'); g.onsuccess = () => { const r = g.result; r.content = r.content.replace('Rewritten', 'Rewritten twice'); st.put(r); }; tx.oncomplete = res; }); });
  await ev(() => document.getElementById('lpRefreshBtn').click()); await sleep(2500);
  pf = innerFrame(page);
  ok(!!pf && await pf.evaluate(() => document.getElementById('t').textContent) === 'Rewritten twice' && await pf.evaluate(() => window.__keep) === 7, 'a second in-place rewrite also works and still keeps the state');
  await ev(() => localStorage.removeItem('codemini_preview_reload_mode'));
  console.log('\n[pop-out while isolated]');
  const popupWait = ctx.waitForEvent('page', { timeout: 8000 });
  await ev(() => document.getElementById('lpPopOutBtn').click());
  const popup = await popupWait.catch(() => null);
  ok(!!popup, 'pop-out opens a new window');
  if (popup) {
    await sleep(5000);
    ok(popup.url().startsWith(RUNNER + '/shell.html'), 'which is a runner page (its own origin), not a copy inside the app', popup.url());
    const pif = popup.frames().find(f => f.parentFrame() === popup.mainFrame());
    ok(!!pif && await pif.evaluate(() => document.getElementById('t').textContent) === 'Rewritten twice', 'it shows the page as the preview last rendered it');
    ok(!!pif && await pif.evaluate(() => getComputedStyle(document.getElementById('t')).color) === 'rgb(1, 2, 3)', 'with its stylesheet (re-made inside the new window)');
    ok(!!pif && await pif.evaluate(() => document.getElementById('t').dataset.ran) === 'yes', 'and its script ran');
    ok(await popup.evaluate(() => window.opener) === null, 'the popup has no link back to the app (window.opener is null)');
    const reach = !pif ? null : await pif.evaluate(() => { const o = {}; try { o.opener = String(window.top.opener); } catch (e) { o.opener = 'blocked'; } try { o.shield = typeof window.top.CodeMiniShield; } catch (e) { o.shield = 'blocked'; } try { o.ls = Object.keys(localStorage).filter(k => /^codemini/.test(k)).length; } catch (e) { o.ls = 'blocked'; } return o; });
    ok(!!reach && reach.opener === 'null' && reach.shield === 'undefined' && reach.ls === 0, "the popped-out page cannot reach the app (no opener, no Shield, none of the app's storage)", reach);
    await popup.close();
  }
  const real = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i.test(e));
  ok(real.length === 0, 'no page errors', real);
  await ctx.close();

  console.log('\n[only the app can drive the runner]');
  const sp = await (await browser.newContext()).newPage();
  await sp.goto('http://localhost:8769/'); await sleep(1500);
  const embedded = sp.frames().find(f => f.url().startsWith(RUNNER));
  ok(!embedded, 'another site cannot embed the runner (frame-ancestors)', sp.frames().map(f => f.url()));
  await sp.context().close();

  console.log('\n[fallback: runner unreachable]');
  ({ ctx, page, errors } = await open(browser, 'http://localhost:8767'));
  await page.evaluate(() => document.getElementById('playIconItem').click()); await sleep(5000);
  ok(await page.evaluate(() => document.getElementById('lpIframe').src.startsWith('blob:http://localhost:8765/')), 'the preview still renders, as a same-origin blob');
  ok(await page.evaluate(() => /Not isolated/.test(document.getElementById('lpIsolation').title)), 'and the toolbar says it is NOT isolated');
  const noteVisible = () => page.evaluate(() => { const n = document.getElementById('lpIsolationNote'); if (!n || n.style.display === 'none') return null; const r = n.getBoundingClientRect(); return { text: n.innerText, inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && r.height > 20 }; });
  let note = await noteVisible();
  ok(!!note && note.inView, 'a note opens inside the preview on its own the first time isolation falls back, fully on screen', note);
  ok(!!note && /Not isolated/.test(note.text) && /Reason: .*(did not load|did not announce)/.test(note.text) && /Runner: http:\/\/localhost:8767\/shell.html/.test(note.text) && /App: http:\/\/localhost:8765/.test(note.text), 'and it says why, which runner, and which app', note && note.text);
  await page.evaluate(() => [...document.querySelectorAll('#lpIsolationNote button')].find(b => b.textContent === 'Close').click());
  ok(!(await noteVisible()), 'Close hides it');
  await page.evaluate(() => document.getElementById('lpIsolation').click());
  ok(!!(await noteVisible()), 'tapping the indicator shows it again');
  await page.evaluate(() => document.getElementById('lpIsolation').click());
  ok(!(await noteVisible()), 'and tapping again hides it');
  const fpf = previewFrame(page, 'http://localhost:8765');
  ok(!!fpf && await fpf.evaluate(() => document.getElementById('t').textContent) === 'Hello isolated', 'content is correct in the fallback');
  ok(!!fpf && await fpf.evaluate(() => typeof window.top.CodeMiniShield) === 'object', 'and, as the label warns, fallback code CAN reach the app (the exposure isolation removes)');
  await ctx.close();

  console.log('\n[the runner loads but the page is blocked]');
  ({ ctx, page, errors } = await open(browser, 'http://localhost:8768'));
  await page.evaluate(() => document.getElementById('playIconItem').click()); await sleep(8000); // the shell gives a blank frame 4 s
  ok(await page.evaluate(() => document.getElementById('lpIframe').src.startsWith('blob:http://localhost:8765/')), 'the preview falls back to a same-origin page instead of staying blank');
  const bf = previewFrame(page, 'http://localhost:8765');
  ok(!!bf && await bf.evaluate(() => document.getElementById('t').textContent) === 'Hello isolated', 'and the content is there');
  ok(await page.evaluate(() => /Not isolated/.test(document.getElementById('lpIsolation').title) && /did not load/.test(document.getElementById('lpIsolation').title)), 'the indicator says not isolated and why');
  ok(await page.evaluate(() => /the frame still shows about: after 4 s/.test(CodeMiniRunner.lastError())), 'CodeMiniRunner.lastError() says what the frame was showing');
  ok(await page.evaluate(() => document.getElementById('lpNavBack').classList.contains('disabled')), 'the retry did not add the page to the history twice (Back stays disabled)');
  await ctx.close();

  console.log('\n[in-place rewrite in the original same-origin mode]');
  ({ ctx, page, errors } = await open(browser, RUNNER, { codemini_runner: 'off', codemini_preview_reload_mode: 'legacy' }));
  await page.evaluate(() => document.getElementById('playIconItem').click()); await sleep(3500);
  const lf = () => page.frames().find(f => f.url() === 'about:blank');
  ok(!!lf() && await lf().evaluate(() => document.getElementById('t').textContent) === 'Hello isolated', 'legacy, same-origin: first render');
  await lf().evaluate(() => { window.__keep = 9; });
  const lBefore = (await page.evaluate(() => document.getElementById('lpConsoleContent').innerText)).split('from-the-page').length - 1;
  await page.evaluate(async () => { await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); const st = tx.objectStore('filesystem'); const g = st.get('rn1'); g.onsuccess = () => { const r = g.result; r.content = r.content.replace('Hello isolated', 'Rewritten here'); st.put(r); }; tx.oncomplete = res; }); });
  await page.evaluate(() => document.getElementById('lpRefreshBtn').click()); await sleep(2500);
  ok(await lf().evaluate(() => document.getElementById('t').textContent) === 'Rewritten here' && await lf().evaluate(() => window.__keep) === 9, 'in-place rewrite shows the edit and keeps the page state');
  const lAfter = (await page.evaluate(() => document.getElementById('lpConsoleContent').innerText)).split('from-the-page').length - 1;
  ok(lAfter === lBefore + 1, 'and logs once, not twice', { lBefore, lAfter });
  const lErr = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i.test(e));
  ok(lErr.length === 0, 'and no longer throws "has already been declared" (this was an existing bug)', lErr);
  const nWait = ctx.waitForEvent('page', { timeout: 8000 });
  await page.evaluate(() => document.getElementById('lpPopOutBtn').click());
  const nPopup = await nWait.catch(() => null);
  ok(!!nPopup, 'Normal mode: pop-out still opens a new tab');
  if (nPopup) { await sleep(1500); ok((await nPopup.evaluate(() => document.body.innerText)).includes('Rewritten here'), 'Normal mode: and it shows the page'); await nPopup.close(); }
  await ctx.close();

  console.log('\n[Settings > Security, the gear menu, and the status bar icon]');
  ({ ctx, page, errors } = await open(browser, RUNNER));
  const evp = (f, a) => page.evaluate(f, a);
  await evp(() => document.getElementById('playIconItem').click()); await sleep(4500);
  const isRunner = () => evp(() => { try { return new URL(document.getElementById('lpIframe').src).origin; } catch (e) { return ''; } });
  const badge = () => evp(() => document.getElementById('lpIsolation').title);
  ok(await isRunner() === RUNNER && /Isolated/.test(await badge()), 'starts Isolated (the recommended default)');
  const pos = await evp(() => { const l = document.getElementById('lpCurrentFileLabel').getBoundingClientRect(), i = document.getElementById('lpIsolation').getBoundingClientRect(); return { labelRight: l.right, iconLeft: i.left, iconW: i.width, last: document.querySelector('.lp-status-right').lastElementChild.id }; });
  ok(pos.iconW > 0 && pos.iconLeft >= pos.labelRight - 1, 'the icon sits to the right of the file name', pos);
  ok(pos.last === 'lpIsolation', 'and is the last item in the status bar', pos);

  await evp(() => document.getElementById('settingsIconItem').click()); await sleep(900);
  await evp(() => document.querySelector('.settings-sidebar-item[data-tab="security"]').click()); await sleep(300);
  const ui = await evp(() => { const g = document.querySelector('select[data-setting="isolationMode"]'), p = document.querySelector('select[data-setting="isolationPreview"]'); return { g: g && g.value, p: p && p.value, gOpts: g && [...g.options].map(o => o.textContent), pOpts: p && [...p.options].map(o => o.textContent), disabled: [...document.querySelectorAll('select[disabled]')].filter(x => /not yet available/.test(x.textContent)).length, labels: [...document.querySelectorAll('.settings-item-info strong')].map(x => x.textContent).filter(t => /^(Isolation Mode|Live Preview|Console|Terminal|Notebooks)$/.test(t)) }; });
  ok(ui.g === 'Isolated' && ui.p === 'Use global', 'Security tab: Isolation Mode = Isolated, Live Preview = Use global', ui);
  ok(JSON.stringify(ui.gOpts) === '["Isolated","Normal"]' && JSON.stringify(ui.pOpts) === '["Use global","Isolated","Normal"]', 'with the right choices');
  ok(ui.labels.join() === 'Isolation Mode,Live Preview,Console,Terminal,Notebooks' && ui.disabled === 0, 'Console, Terminal and Notebooks are all real settings now; none is listed as not yet available', ui);

  await evp(() => { const g = document.querySelector('select[data-setting="isolationMode"]'); g.value = 'Normal'; g.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(3000);
  ok(await evp(() => window.appSettings.isolationMode) === 'Normal' && await evp(() => Object.keys(localStorage).some(k => /isolationMode$/.test(k) && localStorage.getItem(k) === 'Normal')), 'choosing Normal is saved');
  ok((await isRunner()) === '' || (await evp(() => document.getElementById('lpIframe').src.startsWith('blob:http://localhost:8765/'))), 'an open preview switches to the same-origin page at once (no manual reload)', await evp(() => document.getElementById('lpIframe').src.slice(0, 40)));
  ok(/Normal mode/.test(await badge()), 'and the icon says Normal mode', await badge());
  const nf = previewFrame(page, 'http://localhost:8765');
  ok(!!nf && await nf.evaluate(() => typeof window.top.CodeMiniShield) === 'object', 'in Normal mode the page can reach the app (the old behaviour, as chosen)');

  console.log('\n[per-surface override from the gear menu]');
  await evp(() => document.getElementById('lpSettingsBtn').click()); await sleep(300);
  ok(await evp(() => document.getElementById('lpIsoGlobalTag').textContent) === 'currently Normal', 'the gear menu shows what the global setting currently is');
  ok(await evp(() => document.querySelector('input[name="lpIsoPref"]:checked').value) === 'Use global', 'and "Use the global setting" is selected');
  await evp(() => document.querySelector('input[name="lpIsoPref"][value="Isolated"]').click()); await sleep(4500);
  ok(await isRunner() === RUNNER && /Isolated/.test(await badge()), 'Isolated for Live Preview beats a global Normal');
  ok(await evp(() => window.appSettings.isolationPreview) === 'Isolated' && await evp(() => document.querySelector('select[data-setting="isolationPreview"]').value) === 'Isolated', 'and it is the same setting as in the Security tab');
  const rf = previewFrame(page, RUNNER);
  ok(!!rf && await rf.evaluate(() => document.getElementById('t') && document.getElementById('t').textContent) === 'Hello isolated', 'with the page rendered in the runner');
  await evp(() => document.querySelector('input[name="lpIsoPref"][value="Use global"]').click()); await sleep(3000);
  ok(await evp(() => document.getElementById('lpIframe').src.startsWith('blob:http://localhost:8765/')), 'back to "Use the global setting": Normal again');
  await evp(() => window.saveSetting('isolationMode', 'Isolated')); await sleep(4500);
  ok(await isRunner() === RUNNER, 'switching the global mode back to Isolated returns the preview to the runner');
  ok(await evp(() => document.getElementById('lpIsoGlobalTag').textContent) === 'currently Isolated', 'and the gear menu follows');
  await evp(() => window.saveSetting('isolationPreview', 'Normal')); await sleep(3000);
  ok(await evp(() => document.getElementById('lpIframe').src.startsWith('blob:http://localhost:8765/')), 'Normal for Live Preview beats a global Isolated');
  const resetOk = await evp(() => { window.saveSetting('isolationPreview', 'Use global'); return window.getIsolationSettings(); });
  ok(resetOk.global === 'runner' && resetOk.surfaces.preview === null, 'getIsolationSettings reports the effective choice', resetOk);
  const bad2 = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i.test(e));
  ok(bad2.length === 0, 'no page errors while switching modes', bad2);
  await ctx.close();

  console.log('\n[auto-reload while typing: both modes, both strategies]');
  for (const [name, extra] of [['Normal / Full Navigation', { codemini_runner: 'off' }], ['Normal / Legacy', { codemini_runner: 'off', codemini_preview_reload_mode: 'legacy' }], ['Isolated / Full Navigation', {}], ['Isolated / Legacy', { codemini_preview_reload_mode: 'legacy' }]]) {
    ({ ctx, page, errors } = await open(browser, RUNNER, extra));
    await page.evaluate(() => document.getElementById('playIconItem').click()); await sleep(4500);
    const typeText = (text) => page.evaluate((text) => { window.__liveText = '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1 id="t">' + text + '</h1><script src="app.js"></script></body></html>'; window.autoSaveFile('rn1', window.__liveText, document.querySelector('.tab[data-file-id="rn1"]')); }, text);
    const now = async () => { const f = page.frames().find(f => f.parentFrame() && (/shell\.html/.test(f.parentFrame().url()) || f === page.frames().find(x => x.url() === 'about:blank'))) || page.frames().find(f => f.url() === 'about:blank') || page.frames().find(f => /^blob:/.test(f.url())); try { return await f.evaluate(() => ({ t: document.getElementById('t').textContent, c: getComputedStyle(document.getElementById('t')).color, ran: document.getElementById('t').dataset.ran })); } catch (e) { return null; } };
    await typeText('typed once'); await sleep(3000);
    let r = await now();
    ok(!!r && r.t === 'typed once' && r.c === 'rgb(1, 2, 3)' && r.ran === 'yes', name + ': one edit shows up, styled, and its script runs', r);
    for (const w of ['a', 'ab', 'abc', 'abcd', 'abcde']) { await typeText('burst ' + w); await sleep(60); }
    await sleep(4000);
    r = await now();
    ok(!!r && r.t === 'burst abcde' && r.c === 'rgb(1, 2, 3)' && r.ran === 'yes', name + ': a fast burst of 5 edits ends on the last one, styled, script run', r);
    await page.evaluate(() => document.getElementById('lpStorageManagerBtn').click()); await sleep(2000);
    const stor = await page.evaluate(() => document.getElementById('lpStoragePanel').innerText.replace(/\s+/g, ' '));
    ok(/LOCAL STORAGE 1/.test(stor) && /kv = 1/.test(stor), name + ': the Storage Manager lists the page\'s data after auto-reload', stor.slice(0, 160));
    await page.evaluate(() => { const b = [...document.querySelectorAll('#lpStoragePanel [onclick]')].find(e => e.getAttribute('onclick').includes('manageStorage(\'delete\', \'ls\'')); if (b) b.click(); }); await sleep(1500);
    ok(!/kv = 1/.test(await page.evaluate(() => document.getElementById('lpStoragePanel').innerText)), name + ': and its delete button works');
    const bad3 = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i.test(e));
    ok(bad3.length === 0, name + ': no page errors while auto-reloading', bad3);
    await ctx.close();
  }

  console.log('\n[the preview console: input width, and commands run in the page]');
  for (const [name, vp, extra] of [['phone, isolated', { width: 390, height: 844 }, {}], ['desktop, isolated', { width: 1280, height: 800 }, {}], ['phone, Normal', { width: 390, height: 844 }, { codemini_runner: 'off' }]]) {
    ({ ctx, page, errors } = await open(browser, RUNNER, extra, vp));
    await page.evaluate(() => document.getElementById('playIconItem').click()); await sleep(4500);
    await page.evaluate(() => document.getElementById('lpToggleConsole').click()); await sleep(800);
    const m = await page.evaluate(() => { const i = document.getElementById('lpConsoleInput'), row = i.closest('.term-input-row'), pr = i.previousElementSibling; const b = (e) => e.getBoundingClientRect(); return { input: b(i).width, row: b(row).width, prompt: pr ? b(pr).width : 0, parent: i.parentElement.className, inside: b(row).right - b(i).right }; });
    ok(m.parent === 'term-input-row', name + ': the input is a direct child of the flex row (the prompt wrapper is closed)', m);
    ok(m.input >= m.row - m.prompt - 24, name + ': the input fills the rest of the row (' + Math.round(m.input) + 'px of ' + Math.round(m.row) + 'px)', m);
    ok(m.inside >= -1 && m.inside <= 16, name + ': and does not overflow the panel', m);
    await page.evaluate(() => { const i = document.getElementById('lpConsoleInput'); i.focus(); i.value = '6 * 7'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }); await sleep(1500);
    ok(/42/.test(await page.evaluate(() => document.getElementById('lpConsoleContent').innerText)), name + ': a command typed there runs in the previewed page and its result comes back', await page.evaluate(() => document.getElementById('lpConsoleContent').innerText.slice(-120)));
    // The gear menu: its groups must not run into each other (the Isolation group once sat directly under the last radio above it).
    await page.evaluate(() => document.getElementById('lpSettingsBtn').click()); await sleep(500);
    const gm = await page.evaluate(() => { const gs = [...document.querySelectorAll('#lpSettingsPanel .lp-settings-group')]; const b = (e) => e.getBoundingClientRect(); return gs.slice(1).map((g, i) => { const prevRadios = gs[i].querySelectorAll('.lp-settings-radio-row'); return { gap: Math.round(b(g.querySelector('.lp-settings-label')).top - b(prevRadios[prevRadios.length - 1]).bottom), border: getComputedStyle(g).borderTopWidth, inside: b(g).right <= innerWidth + 1 && b(g).left >= -1 }; }); });
    ok(gm.length >= 1 && gm.every(x => x.gap >= 16 && x.border === '1px' && x.inside), name + ': gear menu groups are separated by a rule and at least 16px, and fit the screen', gm);
    await ctx.close();
  }

  console.log('\n[Factory Reset / Delete Profile also clear what previews keep in the runner]');
  ({ ctx, page, errors } = await open(browser, RUNNER));
  const evw = (f, a) => page.evaluate(f, a);
  await evw(() => document.getElementById('playIconItem').click()); await sleep(4500);
  const writeData = async (frame, tag) => frame.evaluate(async (tag) => { localStorage.setItem('wipeLs' + tag, '1'); sessionStorage.setItem('wipeSs' + tag, '1'); await new Promise(res => { const r = indexedDB.open('wipeDb' + tag, 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => { r.result.close(); res(); }; }); }, tag);
  const readData = async (frame, tag) => frame.evaluate(async (tag) => ({ ls: localStorage.getItem('wipeLs' + tag), ss: sessionStorage.getItem('wipeSs' + tag), db: (await indexedDB.databases()).some(d => d.name === 'wipeDb' + tag) }), tag);
  let wf = previewFrame(page, RUNNER);
  await writeData(wf, 'A');
  let w1 = await readData(wf, 'A');
  ok(w1.ls === '1' && w1.ss === '1' && w1.db, 'a previewed page stored localStorage, sessionStorage and an IndexedDB database in the runner', w1);
  await evw(() => window.wipePreviewStorage({ domain: '' }));
  w1 = await readData(wf, 'A');
  ok(w1.ls === null && w1.ss === null && !w1.db, 'wipePreviewStorage (Factory Reset, Delete Profile) clears them, with the preview connected', w1);
  await writeData(wf, 'B');
  await evw(() => window.forceClosePreview('win_default')); await sleep(500);          // no preview frame is connected to the runner now
  await evw(() => window.wipePreviewStorage({ domain: '' }));
  ok(await evw(() => document.querySelectorAll('iframe[aria-hidden="true"]').length) === 0, 'the temporary frame used for that is removed again');
  await evw(() => document.getElementById('playIconItem').click()); await sleep(4500);
  wf = previewFrame(page, RUNNER);
  const w2 = wf ? await readData(wf, 'B') : null;
  ok(!!w2 && w2.ls === null && w2.ss === null && !w2.db, 'and also with no preview open (a hidden runner frame does the wipe)', w2);
  const badW = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i.test(e));
  ok(badW.length === 0, 'no page errors', badW);
  await ctx.close();

  console.log('\n[switched off / misconfigured]');
  ({ ctx, page } = await open(browser, RUNNER, { codemini_runner: 'off' }));
  await page.evaluate(() => document.getElementById('playIconItem').click()); await sleep(2500);
  ok(await page.evaluate(() => document.getElementById('lpIframe').src.startsWith('blob:http://localhost:8765/')), 'codemini_runner=off uses same-origin previews at once');
  ok(await page.evaluate(() => /Normal mode/.test(document.getElementById('lpIsolation').title)), 'and says so');
  await ctx.close();
  ({ ctx, page } = await open(browser, APP));
  await page.evaluate(() => document.getElementById('playIconItem').click()); await sleep(2500);
  ok(await page.evaluate(() => document.getElementById('lpIframe').src.startsWith('blob:http://localhost:8765/')), "a runner configured as the app's own origin is refused (it would isolate nothing)");
  ok(await page.evaluate(() => /not configured/.test(document.getElementById('lpIsolation').title)), 'and the toolbar says isolation is not configured');
  await ctx.close();

  await browser.close(); runnerServer.close(); strangerServer.close(); brokenServer.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
