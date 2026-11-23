// Offline and Packages (UI/UX specs, feature 13) in a real browser: the app on http://localhost:8765, real CacheStorage and real fetch. The CDNs are
// faked at the network layer (page.route), including a host that answers 404, one that is blocked, and a slow one. The service worker is blocked,
// so this also proves a download works without one (it writes to the dynamic cache itself). Monaco is stubbed.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const APP = 'http://localhost:8765';
const DYN = 'codemini-dynamic-v1.10.000.9';

async function open(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext(opts.phone ? { viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' } : { viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((normal) => {
    if (location.port === '8765' && normal) localStorage.setItem('codemini_runner', 'off');
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); }; window.require.config = () => {};
  }, !!opts.normal);
  // The fake CDNs. fails[substring] = 'abort' | 404 | { delay: ms }
  const hits = {}, fails = {};
  const CORS = { 'access-control-allow-origin': '*' };
  const bodyFor = (url) => {
    if (/\.css$/.test(url) && /font-awesome/.test(url)) return { type: 'text/css', body: '@font-face{font-family:a;src:url(../webfonts/fa-solid-900.woff2) format("woff2"),url(../webfonts/fa-solid-900.ttf) format("truetype")}@font-face{font-family:b;src:url(../webfonts/fa-brands-400.woff2) format("woff2")}' };
    if (/remixicon\.css$/.test(url)) return { type: 'text/css', body: '@font-face{font-family:r;src:url("remixicon.woff2?t=1") format("woff2"),url("remixicon.ttf?t=1") format("truetype")}' };
    if (/\.css$/.test(url)) return { type: 'text/css', body: 'body{}' };
    if (/esm\.sh\/(@babel|fflate|archive|marked)/.test(url)) return { type: 'text/javascript', body: 'export*from"/v1/dep.mjs";' };
    if (/\.mjs$|esm\.sh|\+esm/.test(url)) return { type: 'text/javascript', body: 'export default 1;' };
    if (/\.wasm$/.test(url)) return { type: 'application/wasm', body: 'wasm-bytes-' + 'x'.repeat(2000) };
    return { type: 'text/javascript', body: '/* stub for ' + url.slice(-40) + ' */\n' + '// '.padEnd(300, '-') };
  };
  await page.route(/^https?:\/\/(?!localhost)/, async (route) => {
    const url = route.request().url(); hits[url] = (hits[url] || 0) + 1;
    const key = Object.keys(fails).find((k) => url.indexOf(k) > -1), f = key ? fails[key] : null;
    if (f === 'abort') return route.abort();
    if (f === 404) return route.fulfill({ status: 404, headers: CORS, body: 'not found' });
    if (f && f.delay) await sleep(f.delay);
    if (/\/webfonts\/|\.woff2|\.ttf/.test(url)) return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'font/woff2' }, CORS), body: 'fontbytes' });
    if (/\/v1\/dep\.mjs$/.test(url)) return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'text/javascript' }, CORS), body: 'export default 2;' });
    const b = bodyFor(url);
    return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': b.type, 'content-length': String(Buffer.byteLength(b.body)) }, CORS), body: b.body });
  });
  await page.goto(APP + '/index.html'); await sleep(3500);
  return { ctx, page, errors, hits, fails };
}
const txt = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
const shown = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && getComputedStyle(e).display !== 'none'; }, sel);
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (await fn()) return true; await sleep(100); } return false; }
const stateOf = (page, id) => page.evaluate((i) => { const b = document.querySelector('.off-pkg[data-pkg="' + i + '"] .off-pkg-main'); return b ? b.getAttribute('aria-label').split(', ').slice(1).join(', ') : null; }, id);
const cached = (page, url) => page.evaluate(async (u) => !!(await caches.match(u)), url);
const dynKeys = (page) => page.evaluate(async (n) => (await (await caches.open(n)).keys()).map((r) => r.url), DYN);
const openIsland = (page) => page.evaluate(() => { CodeMiniNowIsland.open({ tab: 'now' }); });
const openView = async (page) => { await page.evaluate(() => CodeMiniOffline.openView()); await sleep(500); };

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // ====================================================================== Same origin (Normal) mode: every package counts
  console.log('\n[desktop, Same origin mode]');
  let { ctx, page, errors, hits, fails } = await open(browser, { normal: true });
  ok(await page.evaluate(() => !!(window.CodeMiniOffline && window.CodeMiniNowIsland.openView)), 'the module and the island\'s view API are there');
  await openIsland(page); await sleep(600);
  ok(await shown(page, '.off-sec'), 'the section is in the Now pane');
  ok(await page.evaluate(() => { const s = document.querySelector('.off-sec'), r = document.querySelector('.ni-sec-running'), f = document.querySelector('.ni-sec-finished'); return !!(r.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(s.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'below RUNNING, above RECENTLY FINISHED');
  ok(/OFFLINE AND PACKAGES/.test(await txt(page, '.off-toggle')), 'titled OFFLINE AND PACKAGES');
  ok(await txt(page, '.off-word') === 'Online only' && await page.evaluate(() => document.querySelector('.off-word').classList.contains('bad')), 'nothing saved: "Online only" in the danger colour');
  ok(/^0 of 17 ready offline/.test(await txt(page, '.off-row .off-main-text')), 'the Packages row counts every package', await txt(page, '.off-row .off-main-text'));
  ok(await page.evaluate(() => document.querySelectorAll('.off-sec .off-row').length === 3), 'three summary rows: Packages, Storage, App');
  ok(/ of .* used/.test((await page.evaluate(() => document.querySelectorAll('.off-sec .off-main-text')[1].textContent))), 'the Storage row says how much is used');
  ok(/Not installed as an app/.test(await page.evaluate(() => document.querySelectorAll('.off-sec .off-main-text')[2].textContent)), 'the App row says it is not installed');
  ok(await page.evaluate(() => { const e = document.querySelector('.ni-empty'), o = document.querySelector('.off-sec'); return /Nothing is running/.test(e.textContent) && !e.hidden && !!(o.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING); }), '"Nothing is running" still stands in for RUNNING, below the section (it is not this feature\'s to change)');
  ok(await page.evaluate(() => { const rows = [...document.querySelectorAll('.off-sec .off-row')]; return rows.every((r) => getComputedStyle(r).borderBottomStyle === 'dashed') && rows.every((r) => r.getBoundingClientRect().height >= 35); }), 'flat rows: dashed dividers, at least 36px');
  ok(await page.evaluate(() => { const l = document.querySelector('.off-sec .off-line'); return !!l && l.getBoundingClientRect().height === 2; }), 'with a 2px progress line');

  // collapse, remembered
  await page.evaluate(() => document.querySelector('.off-toggle').click()); await sleep(150);
  ok(!(await shown(page, '.off-body')) && await page.evaluate(() => localStorage.getItem('codemini_offline_collapsed') === '1'), 'the header collapses the section and remembers it');
  await page.evaluate(() => document.querySelector('.off-toggle').click()); await sleep(150);
  ok(await shown(page, '.off-body'), 'and expands it again');

  // the drill-in
  await page.evaluate(() => [...document.querySelectorAll('.off-sec .ni-link')].find((b) => b.textContent === 'Manage').click()); await sleep(600);
  ok(await page.evaluate(() => document.getElementById('niViewer').classList.contains('show') && document.getElementById('nowIslandPanel').classList.contains('ni-tall')), 'Manage opens the island\'s slide-over, taller (not a modal)');
  ok(await txt(page, '.ni-viewer-title') === 'Offline and packages', 'with its title');
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.off-search')).borderTopWidth === '0px' && document.querySelectorAll('.off-toolbar .sb-seg').length === 4), 'a toolbar: the four-way filter and a search with a bottom line only');
  ok(await page.evaluate(() => [...document.querySelectorAll('.off-toolbar .sb-seg')].map((b) => b.textContent).join('|') === 'All|Ready|Not downloaded|Issues'), 'All, Ready, Not downloaded, Issues');
  const gnames = await page.evaluate(() => [...document.querySelectorAll('.off-group')].slice(1).map((g) => g.firstChild.firstChild.textContent + '=' + g.querySelector('.sb-count-badge').textContent));
  ok(gnames.join(',') === 'EDITOR=3,PYTHON NOTEBOOKS=1,R NOTEBOOKS=1,SQL=1,PHP=1,RUBY=1,DOCUMENTS AND PDF=3,ARCHIVES=3,GIT=1,ICONS AND FONTS=2', 'the groups, in order, with counts', gnames);
  ok(await page.evaluate(() => /^THIS APP$/.test(document.querySelector('.off-group').firstChild.firstChild.textContent)), 'the app block comes first');
  const app = await page.evaluate(() => [...document.querySelectorAll('.off-kv')].map((r) => r.firstChild.textContent));
  ok(['Installed', 'Display mode', 'Last checked'].every((k) => app.includes(k)), 'the app block: installed, display mode, last checked', app);
  ok(await page.evaluate(() => [...document.querySelectorAll('.off-kv')].find((r) => r.firstChild.textContent === 'Display mode').lastChild.textContent === 'Browser tab'), 'display mode: browser tab');
  ok(await page.evaluate(() => document.querySelectorAll('.off-pkg').length === 17), 'every package has a row');
  ok(await stateOf(page, 'pyodide') === 'Not downloaded', 'Pyodide: Not downloaded');
  ok(await page.evaluate(() => { const r = document.querySelector('.off-pkg[data-pkg="pyodide"] .off-pkg-main'); return r.getBoundingClientRect().height >= 43 && !!r.querySelector('.off-pill') && r.querySelector('.off-pill').textContent === '0.24.1' && r.querySelector('.off-pkg-l2').textContent === 'cdn.jsdelivr.net \u00b7 0 of 4 files'; }), 'a 44px row: status, name, version pill, source host');
  ok(await page.evaluate(() => /Download all for offline, 16 left/.test(document.querySelector('.off-foot .ni-btn').textContent)), 'the footer button counts what is left (the bundled package needs no download)', await txt(page, '.off-foot .ni-btn'));
  ok(await page.evaluate(() => document.querySelector('.off-foot .ni-link').textContent === 'Clear cached data'), 'and a "Clear cached data" link');

  // filter and search
  await page.evaluate(() => document.querySelector('[data-off-filter="ready"]').click()); await sleep(100);
  ok(await page.evaluate(() => document.querySelectorAll('.off-pkg').length === 0 && /No packages match/.test(document.querySelector('.off-empty').textContent)), 'Ready: nothing yet');
  await page.evaluate(() => document.querySelector('[data-off-filter="none"]').click()); await sleep(100);
  ok(await page.evaluate(() => document.querySelectorAll('.off-pkg').length === 17), 'Not downloaded: all 17');
  await page.evaluate(() => document.querySelector('[data-off-filter="all"]').click());
  await page.fill('.off-search', 'pyo'); await sleep(150);
  ok(await page.evaluate(() => document.querySelectorAll('.off-pkg').length === 1 && document.querySelector('.off-pkg').dataset.pkg === 'pyodide'), 'search finds one package by name');
  await page.fill('.off-search', 'cdn.opalrb'); await sleep(150);
  ok(await page.evaluate(() => document.querySelector('.off-pkg') && document.querySelector('.off-pkg').dataset.pkg === 'opal'), 'and by host');
  await page.fill('.off-search', ''); await sleep(150);

  ok(await page.evaluate(() => document.getElementById('nowIslandPanel').classList.contains('show') && document.getElementById('niViewer').classList.contains('show')), 'tapping rows and filters (which redraw the list) never closes the island');
  // expanded row
  await page.evaluate(() => document.querySelector('.off-pkg[data-pkg="pyodide"] .off-pkg-main').click()); await sleep(150);
  const det = await page.evaluate(() => { const d = document.querySelector('.off-pkg[data-pkg="pyodide"] .off-detail'); return d ? { titles: [...d.querySelectorAll('.off-rel-title')].map((x) => x.textContent), acts: [...d.querySelectorAll('.off-actions .ni-link')].map((x) => x.textContent), files: d.querySelector('.off-files summary').textContent } : null; });
  ok(det && det.titles.join() === 'Needed by' && /Download now/.test(det.acts.join()) && /Open source/.test(det.acts.join()) && !/Re-download|Remove/.test(det.acts.join()), 'expanded: Needed by, Download now, Open source (nothing to re-download or remove yet)', det);
  await page.evaluate(() => document.querySelector('.off-pkg[data-pkg="emmet"] .off-pkg-main').click()); await sleep(150);
  ok(await page.evaluate(() => [...document.querySelectorAll('.off-pkg[data-pkg="emmet"] .off-rel-title')].map((x) => x.textContent).join() === 'Needed by,Depends on' && /Monaco Editor 0\.39\.0/.test([...document.querySelectorAll('.off-pkg[data-pkg="emmet"] .off-rel')].pop().textContent)), 'a package with a dependency lists Depends on');

  // download one: it is really in the cache, under the right cache name, with sizes shown
  await page.evaluate(() => document.querySelector('.off-pkg[data-pkg="sqljs"] .off-pkg-main').click());
  await page.evaluate(() => [...document.querySelectorAll('.off-pkg[data-pkg="sqljs"] .ni-link')].find((b) => b.textContent === 'Download now').click());
  ok(await waitFor(async () => await stateOf(page, 'sqljs') === 'Ready offline'), 'Download now: sql.js becomes Ready offline', await stateOf(page, 'sqljs'));
  ok(await cached(page, 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.wasm') && (await dynKeys(page)).length === 2, 'both of its files are in the cache');
  ok((await dynKeys(page)).length === 2 && await page.evaluate(async (n) => (await caches.keys()).includes(n), DYN), 'in the codemini-dynamic cache the service worker uses');
  ok(await page.evaluate(async () => { const r = await caches.match('https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.wasm'); return r.headers.get('content-type') === 'application/wasm' && (await r.text()).startsWith('wasm-bytes'); }), 'saved faithfully (type and body), so it can serve a script or a WebAssembly load');
  ok(await waitFor(async () => /KB|B$/.test(await txt(page, '.off-pkg[data-pkg="sqljs"] .off-pkg-size') || '')), 'a size is shown for what is saved', await txt(page, '.off-pkg[data-pkg="sqljs"] .off-pkg-size'));
  ok(/2 of 2 files/.test(await txt(page, '.off-pkg[data-pkg="sqljs"] .off-pkg-l2')), '"2 of 2 files"');
  ok(await txt(page, '.off-sec .off-word') === 'Partly offline' && /^1 of 17/.test(await txt(page, '.off-sec .off-main-text')), 'the section header and count follow');
  ok(await page.evaluate(() => { const i = document.querySelector('.off-pkg[data-pkg="sqljs"] .off-pkg-main i[role="img"]'); return i.className.indexOf('ri-checkbox-circle-fill') > -1 && i.className.indexOf('off-new') > -1; }), 'with the success icon');

  // CSS: the fonts are found, not typed in
  await page.evaluate(() => CodeMiniOffline.download(['fontawesome']));
  ok(await waitFor(async () => await stateOf(page, 'fontawesome') === 'Ready offline'), 'Font Awesome is Ready after its CSS AND the fonts the CSS names were saved', await stateOf(page, 'fontawesome'));
  const faKeys = (await dynKeys(page)).filter((u) => /font-awesome/.test(u));
  ok(faKeys.length === 3 && faKeys.some((u) => /fa-solid-900\.woff2$/.test(u)) && faKeys.some((u) => /fa-brands-400\.woff2$/.test(u)) && !faKeys.some((u) => /\.ttf$/.test(u)), 'three files: the CSS and only the woff2 fonts the browser would use', faKeys);
  await page.evaluate(() => CodeMiniOffline.download(['remixicon']));
  ok(await waitFor(async () => await stateOf(page, 'remixicon') === 'Ready offline') && (await dynKeys(page)).some((u) => /remixicon\.woff2\?t=1$/.test(u)), 'a font with a query string is saved under that exact address');
  // modules: sub-files are found
  await page.evaluate(() => CodeMiniOffline.download(['fflate']));
  ok(await waitFor(async () => await stateOf(page, 'fflate') === 'Ready offline') && await cached(page, 'https://esm.sh/v1/dep.mjs'), 'a module package also saves the module it imports');
  // optional files and alternatives
  await page.evaluate(() => CodeMiniOffline.download(['pyodide']));
  ok(await waitFor(async () => await stateOf(page, 'pyodide') === 'Ready offline'), 'Pyodide is ready although its optional pyodide-lock.json is not on the host', await stateOf(page, 'pyodide'));
  // (the lock file name is a guess for this version, so the fake host answers 404 for it)
  fails['pyodide-lock.json'] = 404;
  fails['unpkg.com/php-wasm'] = 404;
  await page.evaluate(() => CodeMiniOffline.download(['php']));
  ok(await waitFor(async () => (await stateOf(page, 'php')) !== 'Not downloaded' && !(await page.evaluate(() => CodeMiniOffline.state().running))), 'php-wasm: unpkg answers 404');
  ok(await cached(page, 'https://cdn.jsdelivr.net/npm/php-wasm@0.1.0/PhpWeb.mjs') && !(await cached(page, 'https://unpkg.com/php-wasm@0.1.0/PhpWeb.mjs')), '... so it falls back to jsDelivr, as the app does');
  ok(await stateOf(page, 'php') === 'Partly cached', 'and, because the PHP engine loads on first use, it is Partly cached, never Ready', await stateOf(page, 'php'));

  // failure: blocked host
  fails['webr.r-wasm.org'] = 'abort';
  await page.evaluate(() => CodeMiniOffline.download(['webr']));
  ok(await waitFor(async () => await stateOf(page, 'webr') === 'Failed or blocked'), 'a blocked host: Failed or blocked', await stateOf(page, 'webr'));
  await page.evaluate(() => document.querySelector('.off-pkg[data-pkg="webr"] .off-pkg-main').click()); await sleep(150);
  ok(/blocked it or could not be reached/.test(await txt(page, '.off-pkg[data-pkg="webr"] .off-note.danger') || ''), 'the row says why');
  ok(await page.evaluate(() => [...document.querySelectorAll('.off-pkg[data-pkg="webr"] .ni-link')].some((b) => b.textContent === 'Retry')), 'and offers Retry');
  delete fails['webr.r-wasm.org'];
  await page.evaluate(() => [...document.querySelectorAll('.off-pkg[data-pkg="webr"] .ni-link')].find((b) => b.textContent === 'Retry').click());
  ok(await waitFor(async () => await stateOf(page, 'webr') === 'Partly cached'), 'Retry works once the host does', await stateOf(page, 'webr'));
  ok(/R runtime/.test(await txt(page, '.off-pkg[data-pkg="webr"] .off-note') || ''), 'WebR explains that its runtime downloads on first use');

  // Download all: progress, Stop, the end state
  delete fails['unpkg.com/php-wasm'];
  fails['cdnjs.cloudflare.com/ajax/libs/jszip'] = { delay: 1500 };
  const leftBefore = await page.evaluate(() => CodeMiniOffline.rows().filter((r) => !r.pkg.bundled && r.state !== 'runner' && r.result && (r.result.have < r.result.total || !r.result.closureKnown)).length);
  await page.evaluate(() => document.querySelector('.off-foot .ni-btn').click()); await sleep(500);
  ok(await page.evaluate(() => CodeMiniOffline.state().running) && /Stop downloading/.test(await txt(page, '.off-foot .ni-btn')), 'Download all: the button becomes Stop downloading', await txt(page, '.off-foot .ni-btn'));
  ok(await page.evaluate(() => !!document.querySelector('.off-pkg .ri-loader-4-line')), 'a package in progress shows the spinner');
  await page.evaluate(() => document.querySelector('.off-foot .ni-btn').click());
  ok(await waitFor(async () => !(await page.evaluate(() => CodeMiniOffline.state().running)), 6000), 'Stop ends the run');
  ok(await stateOf(page, 'jszip') === 'Failed or blocked' && /Stopped/.test(await page.evaluate(() => { const r = CodeMiniOffline.rows().find((x) => x.pkg.id === 'jszip'); return r.busy ? r.busy.error : ''; })), 'the one that was in progress says Stopped, and is not left half-written as Ready', await stateOf(page, 'jszip'));
  delete fails['cdnjs.cloudflare.com/ajax/libs/jszip'];
  await page.evaluate(() => document.querySelector('.off-foot .ni-btn').click());
  ok(await waitFor(async () => /Everything is downloaded/.test(await txt(page, '.off-foot .ni-btn') || ''), 15000), 'Download all again finishes everything: "Everything is downloaded"', await txt(page, '.off-foot .ni-btn'));
  ok(await page.evaluate(() => document.querySelector('.off-foot .ni-btn').disabled), 'the button is disabled when nothing is left');
  const sum = await page.evaluate(() => CodeMiniOffline.summary());
  ok(sum.counts.failed === 0 && sum.counts.none <= 1, 'nothing failed, and only the bundled package is still unsaved (the service worker, blocked here, would have it)', sum.counts);
  ok(sum.word === 'Partly offline', 'and the header is still "Partly offline": three packages load more on first use, so it never claims Ready', sum.word);

  // re-download fetches again; remove is two steps and touches only that package
  const before = hits['https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.js'];
  await page.evaluate(() => caches.open('codemini-static-v1.6.0').then((c) => { c.put('/index.html', new Response('shell')); return c.put('https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/vs/basic-languages/python/python.js', new Response('precached by the app shell')); }));   // an address a package owns, but in the app's own cache
  await page.evaluate(() => caches.open('codemini-dynamic-v1.10.000.9').then((c) => c.put('https://example.test/not-a-package.js', new Response('keep me'))));
  await page.evaluate(() => { if (!document.querySelector('.off-pkg[data-pkg="sqljs"] .off-detail')) document.querySelector('.off-pkg[data-pkg="sqljs"] .off-pkg-main').click(); }); await sleep(150);
  await page.evaluate(() => [...document.querySelectorAll('.off-pkg[data-pkg="sqljs"] .ni-link')].find((b) => b.textContent === 'Re-download').click());
  ok(await waitFor(async () => hits['https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.js'] === before + 1), 'Re-download really fetches the files again', [before, hits['https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.js']]);
  ok(await waitFor(async () => await stateOf(page, 'sqljs') === 'Ready offline'), 'and it is Ready again');
  await page.evaluate(() => { if (!document.querySelector('.off-pkg[data-pkg="sqljs"] .off-detail')) document.querySelector('.off-pkg[data-pkg="sqljs"] .off-pkg-main').click(); });
  await page.evaluate(() => [...document.querySelectorAll('.off-pkg[data-pkg="sqljs"] .ni-link')].find((b) => b.textContent === 'Remove from cache').click()); await sleep(150);
  ok(await page.evaluate(() => /Remove it\?/.test(document.querySelector('.off-pkg[data-pkg="sqljs"] .off-confirm-text').textContent)) && await stateOf(page, 'sqljs') === 'Ready offline', 'Remove from cache asks first (two steps)');
  await page.evaluate(() => [...document.querySelectorAll('.off-pkg[data-pkg="sqljs"] .ni-link')].find((b) => b.textContent === 'Cancel').click()); await sleep(100);
  ok(await stateOf(page, 'sqljs') === 'Ready offline' && !(await page.evaluate(() => document.querySelector('.off-confirm-text'))), 'Cancel keeps it');
  await page.evaluate(() => [...document.querySelectorAll('.off-pkg[data-pkg="sqljs"] .ni-link')].find((b) => b.textContent === 'Remove from cache').click()); await sleep(100);
  await page.evaluate(() => [...document.querySelectorAll('.off-pkg[data-pkg="sqljs"] .ni-link')].find((b) => b.textContent === 'Remove').click());
  ok(await waitFor(async () => await stateOf(page, 'sqljs') === 'Not downloaded'), 'Remove takes it out', await stateOf(page, 'sqljs'));
  ok(!(await cached(page, 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.wasm')) && await stateOf(page, 'pyodide') === 'Ready offline', 'and only that package');

  // clear all: two steps; the app shell and anything that is not a package survive
  await page.evaluate(() => [...document.querySelectorAll('.off-foot .ni-link')].find((b) => b.textContent === 'Clear cached data').click()); await sleep(100);
  ok(/Clear all saved packages\?/.test(await txt(page, '.off-foot-row')), 'Clear cached data asks first');
  await page.evaluate(() => [...document.querySelectorAll('.off-foot .ni-link')].find((b) => b.textContent === 'Cancel').click()); await sleep(100);
  ok(await stateOf(page, 'pyodide') === 'Ready offline', 'Cancel keeps everything');
  await page.evaluate(() => [...document.querySelectorAll('.off-foot .ni-link')].find((b) => b.textContent === 'Clear cached data').click()); await sleep(100);
  await page.evaluate(() => [...document.querySelectorAll('.off-foot .ni-link')].find((b) => b.textContent === 'Clear').click());
  ok(await waitFor(async () => await stateOf(page, 'pyodide') === 'Not downloaded' && await stateOf(page, 'fontawesome') === 'Not downloaded'), 'Clear removes every package');
  const left = await dynKeys(page);
  ok(left.length === 1 && left[0] === 'https://example.test/not-a-package.js', 'but only packages: a file that belongs to no package is left alone', left);
  ok(await page.evaluate(async () => { const c = await caches.open('codemini-static-v1.6.0'); return !!(await c.match('/index.html')) && !!(await c.match('https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/vs/basic-languages/python/python.js')); }), 'and the app shell cache is never touched, even for an address a package would own');
  ok(await page.evaluate(() => /Download all for offline, 16 left/.test(document.querySelector('.off-foot .ni-btn').textContent)), 'the button counts again');

  // slow connection warning; offline
  await page.evaluate(() => Object.defineProperty(navigator, 'connection', { value: { saveData: true, effectiveType: '4g' }, configurable: true }));
  await page.evaluate(() => document.querySelector('.off-foot .ni-btn').click()); await sleep(150);
  ok(/slow or data-saver connection/.test(await txt(page, '.off-foot-msg') || '') && !(await page.evaluate(() => CodeMiniOffline.state().running)), 'on a data-saver connection it warns before downloading');
  await page.evaluate(() => [...document.querySelectorAll('.off-foot .ni-link')].find((b) => b.textContent === 'Cancel').click()); await sleep(100);
  ok(!(await page.evaluate(() => CodeMiniOffline.state().running)) && !(await txt(page, '.off-foot-msg')), 'Cancel does nothing');
  await page.evaluate(() => Object.defineProperty(navigator, 'connection', { value: undefined, configurable: true }));
  await ctx.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline'))); await sleep(200);
  ok(await page.evaluate(() => document.querySelector('.off-foot .ni-btn').disabled) && /offline/i.test(await txt(page, '.off-foot-msg') || ''), 'offline: Download all is disabled and says why');
  await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await sleep(200);

  // Escape closes, the section refreshes when the island opens, the empty state
  await page.keyboard.press('Escape'); await sleep(300);
  ok(await page.evaluate(() => !document.getElementById('niViewer').classList.contains('show') && !document.getElementById('nowIslandPanel').classList.contains('ni-tall')), 'Escape closes the view and the island goes back to its size');
  ok(await page.evaluate(() => CodeMiniNowIsland.isViewOpen() === false), 'the API agrees');

  // protect storage
  await page.evaluate(() => { window.__prot = 0; window.CodeMiniAlerts = { canProtectStorage: () => true, protectStorage: async () => { window.__prot++; } }; navigator.storage.persisted = async () => false; });
  await page.evaluate(() => CodeMiniOffline.refresh()); await sleep(400);
  ok(await page.evaluate(() => document.querySelectorAll('.off-sec .off-row')[1].classList.contains('warn')) && /Protect storage/.test(await txt(page, '.off-sec .off-row.warn .ni-link')), 'unprotected storage turns the Storage row amber with a Protect storage link');
  await page.evaluate(() => document.querySelector('.off-sec .off-row.warn .ni-link').click()); await sleep(300);
  ok(await page.evaluate(() => window.__prot === 1), 'which uses the app\'s existing action');
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();

  // ====================================================================== Isolated mode (the default): the runner hides what it hosts
  console.log('\n[desktop, Isolated mode]');
  ({ ctx, page, errors, hits, fails } = await open(browser, {}));
  await openIsland(page); await sleep(500); await openView(page);
  const rs = await page.evaluate(() => CodeMiniOffline.rows().map((r) => r.pkg.id + ':' + r.state));
  const hidden = rs.filter((x) => /:runner$/.test(x)).map((x) => x.split(':')[0]);
  ok(['pyodide', 'webr', 'sqljs', 'php', 'opal', 'marked', 'ghmd'].every((i) => hidden.includes(i)) && !hidden.includes('monaco') && !hidden.includes('fontawesome'), 'with Isolation on, the runtimes the runner hosts are "Runs in the runner"; the editor and icons are not', hidden);
  ok(await stateOf(page, 'pyodide') === 'Runs in the runner', 'the row says so');
  ok(/^0 of 10 ready offline/.test(await txt(page, '.off-sec .off-main-text')) && /7 run in the isolated runner/.test(await txt(page, '.off-sec .off-sub')), 'they are left out of the count, and the section says how many', await txt(page, '.off-sec .off-main-text'));
  await page.evaluate(() => document.querySelector('.off-pkg[data-pkg="pyodide"] .off-pkg-main').click()); await sleep(150);
  ok(/no service worker of its own/.test(await txt(page, '.off-pkg[data-pkg="pyodide"] .off-note') || ''), 'and explains why, in the row');
  ok(await page.evaluate(() => ![...document.querySelectorAll('.off-pkg[data-pkg="pyodide"] .ni-link')].some((b) => /Download|Remove/.test(b.textContent))), 'no Download or Remove for what the app cannot reach');
  ok(await page.evaluate(() => /Download all for offline, 9 left/.test(document.querySelector('.off-foot .ni-btn').textContent)), 'Download all leaves them out too (10 the app can cover, minus the one bundled with it)');
  const snapshot = Object.assign({}, hits);                      // the app's own <script> tags fetched some of them at start-up; only what the DOWNLOAD fetches counts
  await page.evaluate(() => document.querySelector('.off-foot .ni-btn').click());
  ok(await waitFor(async () => /Everything is downloaded/.test(await txt(page, '.off-foot .ni-btn') || ''), 15000), 'it downloads what the app can cover');
  const newHits = Object.keys(hits).filter((u) => hits[u] > (snapshot[u] || 0));
  ok(newHits.length > 5 && !newHits.some((u) => /pyodide|opalrb|r-wasm|sql\.js|php-wasm|marked|github-markdown/.test(u)), 'and the download never fetches what the runner hosts', newHits.filter((u) => /pyodide|opalrb|r-wasm|sql\.js|php-wasm|marked|github-markdown/.test(u)));
  ok(await txt(page, '.off-sec .off-word') !== 'Ready offline', 'the header does not say Ready offline while part of the app is not covered', await txt(page, '.off-sec .off-word'));
  ok(await txt(page, '.off-sec .off-word') === 'Partly offline', 'it says Partly offline');
  await page.evaluate(() => CodeMiniNowIsland.closeView()); await sleep(200);
  ok(await page.evaluate(() => /^3 of|^\d+ of 10 ready/.test(document.querySelector('.off-sec .off-main-text').textContent)), 'the section count is of the packages the app can cover');
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();

  // ====================================================================== theme packs
  console.log('\n[theme packs]');
  ({ ctx, page, errors } = await open(browser, { normal: true }));
  await openIsland(page); await sleep(500); await openView(page);
  await page.evaluate(() => document.querySelector('.off-pkg[data-pkg="monaco"] .off-pkg-main').click());
  const shape = (pack) => page.evaluate((p) => { if (p) document.documentElement.dataset.themePack = p; else delete document.documentElement.dataset.themePack;
    const r = (s) => getComputedStyle(document.querySelector(s)).borderRadius; return { pill: r('.off-pill'), search: r('.off-search'), seg: r('.off-toolbar .sb-segmented'), line: r('.off-line-fill'), btn: r('.off-foot .ni-btn'), panel: r('#nowIslandPanel') }; }, pack);
  await page.evaluate(() => { document.querySelector('.off-sec .off-line-fill'); });
  const def = await shape(null);
  for (const pack of ['codemini-premium', 'codemini-premium-light']) {
    const s = await shape(pack);
    ok(s.pill === '999px' && s.seg === '999px' && s.btn === '999px', pack + ': version pill, the filter control and the footer button are pills', s);
    ok(s.search === '0px' && def.search === '0px', pack + ': the search keeps its flat underline (square ends)', [s.search, def.search]);
  }
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();

  // ====================================================================== phone
  console.log('\n[phone]');
  ({ ctx, page, errors } = await open(browser, { normal: true, phone: true }));
  await openIsland(page); await sleep(500); await openView(page);
  ok(await page.evaluate(() => { const p = document.getElementById('nowIslandPanel').getBoundingClientRect(); return p.left >= 54 && p.right <= innerWidth - 9 && p.height >= innerHeight * 0.55; }), 'the view is a tall island (about 60% of the screen), in the phone layout');
  ok(await page.evaluate(() => { const c = document.querySelector('.off-scroll'); return c.scrollWidth <= c.clientWidth + 1; }), 'nothing overflows sideways');
  ok(await page.evaluate(() => { const t = document.querySelector('.off-toolbar'); return t.scrollWidth <= t.clientWidth + 1; }), 'the toolbar fits');
  ok(await page.evaluate(() => document.querySelector('.off-pkg-main').getBoundingClientRect().height >= 43 && getComputedStyle(document.querySelector('.off-pkg-name')).fontSize === '12px'), 'rows keep their desktop size');
  await page.evaluate(() => document.querySelector('.off-pkg[data-pkg="monaco"] .off-pkg-main').click()); await sleep(150);
  ok(await page.evaluate(() => { const c = document.querySelector('.off-scroll'); return c.scrollWidth <= c.clientWidth + 1; }), 'an expanded row fits too');
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('Crashed:', e); process.exit(2); });
