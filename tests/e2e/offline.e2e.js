// Offline and Packages in the Now Island (UI/UX specs, feature 13): the section at the bottom of the Now pane. Its three summary rows, the state in one
// word, Protect storage, how Isolation changes what it counts, and Manage handing over to the Extensions sidebar's Components tab. The package list
// itself (states, Keep offline, Re-verify, Remove, Download all) moved to the Extensions sidebar and is covered by tests/e2e/extensions.e2e.js.
const { chromium } = require('playwright');
const { openApp, sleep } = require('./lib/app-page');
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };

const txt = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
const shown = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && getComputedStyle(e).display !== 'none'; }, sel);
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (await fn()) return true; await sleep(100); } return false; }
const mainTexts = (page) => page.evaluate(() => [...document.querySelectorAll('.off-sec .off-main-text')].map((e) => e.textContent));
const openIsland = (page) => page.evaluate(() => CodeMiniNowIsland.open({ tab: 'now' }));

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  console.log('\n[desktop, Same origin mode]');
  let { ctx, page, errors } = await openApp(browser, { normal: true });
  await openIsland(page); await sleep(600);
  ok(await shown(page, '.off-sec'), 'the section is in the Now pane');
  ok(await page.evaluate(() => { const t = document.querySelector('.today-sec'), o = document.querySelector('.off-sec'), r = document.querySelector('.ni-sec-running'), f = document.querySelector('.ni-sec-finished'); const fol = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); return fol(r, t) && fol(t, o) && fol(o, f); }), 'below RUNNING and TODAY, above RECENTLY FINISHED');
  ok(/OFFLINE AND PACKAGES/.test(await txt(page, '.off-toggle')), 'titled OFFLINE AND PACKAGES');
  ok(await txt(page, '.off-word') === 'Online only' && await page.evaluate(() => document.querySelector('.off-word').classList.contains('bad')), 'nothing saved: "Online only" in the danger colour');
  ok(await page.evaluate(() => document.querySelectorAll('.off-sec .off-row').length === 3), 'three summary rows: Packages, Storage, App');
  ok(/^0 of 17 ready offline/.test((await mainTexts(page))[0]), 'the Packages row counts every component', (await mainTexts(page))[0]);
  ok(/ of .* used/.test((await mainTexts(page))[1]), 'the Storage row says how much is used');
  ok(/Not installed as an app/.test((await mainTexts(page))[2]), 'the App row says it is not installed');
  ok(await page.evaluate(() => { const rows = [...document.querySelectorAll('.off-sec .off-row')]; return rows.every((r) => getComputedStyle(r).borderBottomStyle === 'dashed') && rows.every((r) => r.getBoundingClientRect().height >= 35); }), 'flat rows: dashed dividers, at least 36px');
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.off-sec .off-line')).height === '2px'), 'with a 2px progress line');
  ok(await page.evaluate(() => document.querySelector('.ni-empty').hidden), '"Nothing is running" is not shown: the pane always has Today and this section');
  ok(await page.evaluate(() => !(document.getElementById('niViewer') && document.getElementById('niViewer').classList.contains('show')) && !document.getElementById('nowIslandPanel').classList.contains('ni-tall')), 'the island has no slide-over list of its own any more');

  await page.evaluate(() => document.querySelector('.off-toggle').click()); await sleep(150);
  ok(!(await shown(page, '.off-body')) && await page.evaluate(() => localStorage.getItem('codemini_offline_collapsed') === '1'), 'the header collapses the section and remembers it');
  await page.evaluate(() => document.querySelector('.off-toggle').click()); await sleep(150);
  ok(await shown(page, '.off-body'), 'and expands it again');

  await page.evaluate(() => CodeMiniOffline.download(['sqljs', 'jszip'])); await sleep(500);
  ok(await waitFor(async () => /^2 of 17/.test((await mainTexts(page))[0])) && await txt(page, '.off-word') === 'Partly offline' && await page.evaluate(() => document.querySelector('.off-word').classList.contains('warn')), 'saving some components: "2 of 17" and "Partly offline"', await mainTexts(page));
  ok(await page.evaluate(() => { const f = document.querySelector('.off-sec .off-line-fill'); return parseFloat(f.style.width) > 8 && parseFloat(f.style.width) < 15; }), 'the line shows the share (2 of 17)');

  await page.evaluate(() => { window.__prot = 0; window.CodeMiniAlerts = { canProtectStorage: () => true, protectStorage: async () => { window.__prot++; } }; navigator.storage.persisted = async () => false; });
  await page.evaluate(() => CodeMiniOffline.refresh()); await sleep(500);
  ok(await page.evaluate(() => document.querySelectorAll('.off-sec .off-row')[1].classList.contains('warn')) && /Protect storage/.test(await txt(page, '.off-sec .off-row.warn .ni-link')), 'unprotected storage turns the Storage row amber with a Protect storage link');
  await page.evaluate(() => document.querySelector('.off-sec .off-row.warn .ni-link').click()); await sleep(300);
  ok(await page.evaluate(() => window.__prot === 1), 'which uses the app\'s existing action');

  await page.evaluate(() => [...document.querySelectorAll('.off-sec .ni-link')].find((b) => b.textContent === 'Manage').click()); await sleep(700);
  ok(await page.evaluate(() => document.getElementById('extensionsSidebar').classList.contains('open') && document.querySelector('.sb-tab[data-tab="components"]').classList.contains('active')), 'Manage opens the Extensions sidebar on its Components tab');
  ok(await page.evaluate(() => document.querySelectorAll('.ext-row[data-comp]').length === 17), 'where the whole list is');
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();

  console.log('\n[desktop, Isolated mode]');
  ({ ctx, page, errors } = await openApp(browser, {}));
  await openIsland(page); await sleep(600);
  ok(/^0 of 10 ready offline/.test((await mainTexts(page))[0]) && /7 run in the isolated runner/.test(await txt(page, '.off-sec .off-sub')), 'the runtimes the runner hosts are left out of the count, and the section says how many', await mainTexts(page));
  await page.evaluate(() => CodeMiniOffline.download(CodeMiniOffline.rows().filter(CodeMiniOffline.needsDownload).map((r) => r.pkg.id))); await sleep(500);
  ok(await waitFor(async () => /^8 of 10 ready offline/.test((await mainTexts(page))[0]), 15000), 'it saves what the app can cover: 8 of 10 (archive-wasm loads more on first use, and jsdiff comes with the app shell, which needs a service worker)', await mainTexts(page));
  ok(await txt(page, '.off-word') === 'Partly offline', 'and the header never says Ready offline while part of the app is not covered', await txt(page, '.off-word'));
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();

  console.log('\n[phone]');
  ({ ctx, page, errors } = await openApp(browser, { normal: true, phone: true }));
  await openIsland(page); await sleep(600);
  ok(await page.evaluate(() => { const b = document.querySelector('#nowIslandPanel .ni-pane.active'); return b.scrollWidth <= b.clientWidth + 1; }), 'nothing overflows sideways');
  ok(await page.evaluate(() => { const p = document.getElementById('nowIslandPanel').getBoundingClientRect(); return p.left >= 54 && p.right <= innerWidth - 9 && p.height <= innerHeight * 0.6 + 2; }), 'the island keeps its phone place and stays within 60% of the screen');
  await page.evaluate(() => [...document.querySelectorAll('.off-sec .ni-link')].find((b) => b.textContent === 'Manage').click()); await sleep(700);
  ok(await page.evaluate(() => document.getElementById('extensionsSidebar').classList.contains('open')), 'Manage works on a phone too');
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('Crashed:', e); process.exit(2); });
