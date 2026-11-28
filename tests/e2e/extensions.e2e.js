// The Extensions sidebar (UI/UX specs, feature 26, first release) in a real browser: the app on http://localhost:8765, real CacheStorage and fetch with
// the CDNs faked at the network layer, real .cmpack files built by tests/lib/make-cmpack.js and chosen through the file input, Monaco stubbed.
// Installed (built-in and installed themes, snippet packs), the install review, errors, applying a theme and keeping it across a reload, and the
// Components tab (feature 13's package list, moved here): states, Keep offline, Re-verify, Remove, Download all, RUNNING, Isolation.
const { chromium } = require('playwright');
const { openApp, sleep } = require('./lib/app-page');
const M = require('../lib/make-cmpack');
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };

const THEME = { name: 'Midnight', version: '1.0', author: 'Ana', description: 'A dark blue theme.', base: 'dark', colors: { '--accent-blue': '#7aa2f7', '--bg-white': '#1a1b26', '--text-main': '#c0caf5' } };
const PACK = { name: 'JS helpers', version: '1.2.0', author: 'Bo', description: 'Two small snippets.', language: 'javascript', snippets: { Log: { prefix: 'cl', body: 'console.log($1)' }, Fn: { prefix: 'fn', body: ['function ${1:name}() {', '\t$0', '}'] } } };
const file = (name, buffer) => ({ name, mimeType: 'application/zip', buffer });

const txt = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
const all = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.textContent), sel);
const shown = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && getComputedStyle(e).display !== 'none'; }, sel);
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (await fn()) return true; await sleep(100); } return false; }
const sidebarOpen = (page) => page.evaluate(() => document.getElementById('extensionsSidebar').classList.contains('open'));
const clickPlug = (page) => page.evaluate(() => document.getElementById('extensionIconItem').click());
const openSidebar = async (page, tab) => { await page.evaluate((t) => CodeMiniExtensionsUI.open(t), tab || 'installed'); await sleep(400); };
const tabOf = (page, id) => page.evaluate((i) => { const b = document.querySelector('.sb-tab[data-tab="' + i + '"]'); return b ? b.classList.contains('active') : null; }, id);
const clickTab = async (page, id) => { await page.evaluate((i) => document.querySelector('.sb-tab[data-tab="' + i + '"]').click(), id); await sleep(300); };
const row = (id) => '.ext-row[data-ext="' + id + '"]';
const comp = (id) => '.ext-row[data-comp="' + id + '"]';
const clickLink = (page, scope, label) => page.evaluate(([s, l]) => { const b = [...document.querySelectorAll(s + ' .ni-link')].find((x) => x.textContent === l); if (!b) throw new Error('no link ' + l + ' in ' + s); b.click(); }, [scope, label]);
const hasLink = (page, scope, label) => page.evaluate(([s, l]) => [...document.querySelectorAll(s + ' .ni-link')].some((x) => x.textContent === l), [scope, label]);
const expand = (page, scope) => page.evaluate((s) => { if (!document.querySelector(s + ' .ext-detail')) document.querySelector(s + ' .ext-row-main').click(); }, scope);
const stateOf = (page, id) => page.evaluate((i) => { const b = document.querySelector('.ext-row[data-comp="' + i + '"] .ext-row-main'); return b ? b.getAttribute('aria-label').split(', ').slice(1).join(', ') : null; }, id);
const cachedUrl = (page, url) => page.evaluate(async (u) => !!(await caches.match(u)), url);
const dynKeys = (page) => page.evaluate(async () => { const n = (await caches.keys()).find((k) => k.indexOf('codemini-dynamic-') === 0); return n ? (await (await caches.open(n)).keys()).map((r) => r.url) : []; });
const rootVar = (page, v) => page.evaluate((n) => document.documentElement.style.getPropertyValue(n), v);
const setting = (page, k) => page.evaluate((key) => window.appSettings[key], k);
const pick = (page, buf, name) => page.setInputFiles('#extFile', file(name || 'pack.cmpack', buf));
const snippetPrefixes = (page, lang) => page.evaluate((l) => window.CodeMiniSnippets.entries(l).map((e) => e.prefixes[0]).sort(), lang);
const switchOn = (page, scope) => page.evaluate((s) => document.querySelector(s + ' .ext-switch').getAttribute('aria-checked') === 'true', scope);

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // ====================================================================== the sidebar and the Installed tab
  console.log('\n[desktop: the sidebar and Installed]');
  let { ctx, page, errors, hits, fails } = await openApp(browser, { normal: true });
  ok(await page.evaluate(() => !!(window.CodeMiniExtensions && window.CodeMiniExtensionsUI && window.CodeMiniOffline && window.CodeMiniOfflineRules)), 'the engine, the sidebar and the component rules are there');
  ok(!(await sidebarOpen(page)), 'the sidebar starts closed');
  await clickPlug(page); await sleep(500);
  ok(await sidebarOpen(page) && await page.evaluate(() => document.getElementById('extensionIconItem').classList.contains('active')), 'the plug item of the activity bar opens it and shows active');
  ok(await txt(page, '#extRoot .sb-title') === 'Extensions', 'its header says "Extensions"');
  ok((await all(page, '.sb-tab')).map((t) => t.replace(/\d+$/, '')).join() === 'Installed,Components' && await tabOf(page, 'installed'), 'two tabs, Installed and Components, opening on Installed');
  ok(await page.evaluate(() => { const r = document.getElementById('extensionsSidebar').getBoundingClientRect(); return r.width >= 280 && r.width <= 320; }), 'about 300px wide');
  ok(await page.evaluate(() => [...document.querySelectorAll('#extRoot .sb-header .sb-icon-btn')].map((b) => b.getAttribute('aria-label')).join() === 'Install,Close'), 'a header with Install and Close');
  await clickPlug(page); await sleep(300);
  ok(!(await sidebarOpen(page)) && await page.evaluate(() => !document.getElementById('extensionIconItem').classList.contains('active')), 'clicking it again closes it');
  await clickPlug(page); await sleep(400);

  // built-in themes and theme packs
  const names = await all(page, '.ext-row .ext-row-name');
  const reg = await page.evaluate(() => [...Object.keys(window.THEME_REGISTRY), ...Object.keys(window.THEME_PACK_REGISTRY).filter((n) => n !== 'None')]);
  ok(reg.length >= 5 && reg.every((n) => names.includes(n)), 'every theme and theme pack the app has is listed', [reg, names]);
  ok((await all(page, '.ext-row .ext-pill:not(.active)')).filter((x) => x === 'THEME').length >= 5, 'each with a THEME kind pill');
  ok(/^ENABLED/.test((await all(page, '#extRoot .sb-section-header'))[0]) && (await txt(page, '.sb-section-header .sb-count-badge')) === String(reg.length), 'under an ENABLED header with a count');
  ok(await page.evaluate(() => document.querySelectorAll('.ext-pill.active').length === 1), 'exactly one is Active');
  ok(await txt(page, '.sb-tab[data-tab="installed"] .sb-count-badge') === String(reg.length), 'the Installed tab shows the count');
  const before = await setting(page, 'colorTheme');
  const other = (await page.evaluate(() => Object.keys(window.THEME_REGISTRY))).find((n) => n !== before);
  await page.evaluate((n) => { [...document.querySelectorAll('.ext-row')].find((r) => r.querySelector('.ext-row-name').textContent === n).querySelector('.ni-link').click(); }, other); await sleep(400);
  ok(await setting(page, 'colorTheme') === other && await page.evaluate((n) => document.querySelector('.ext-pill.active').closest('.ext-row').querySelector('.ext-row-name').textContent === n, other), 'Apply on a built-in theme applies it, and Active moves', await setting(page, 'colorTheme'));
  await page.evaluate((n) => { [...document.querySelectorAll('.ext-row')].find((r) => r.querySelector('.ext-row-name').textContent === n).querySelector('.ni-link').click(); }, before); await sleep(300);
  await page.fill('.ext-search', 'light'); await sleep(200);
  ok((await all(page, '.ext-row .ext-row-name')).every((x) => /light/i.test(x)) && (await all(page, '.ext-row')).length >= 1, 'search narrows the list');
  await page.fill('.ext-search', ''); await sleep(100);
  await page.evaluate(() => document.querySelector('[data-ext-filter="packs"]').click()); await sleep(200);
  ok(await txt(page, '.ext-empty') === 'Nothing matches.', 'the Packs filter has nothing yet');
  await page.evaluate(() => document.querySelector('[data-ext-filter="themes"]').click()); await sleep(200);
  ok((await all(page, '.ext-row')).length === reg.length, 'the Themes filter shows the themes');
  await page.evaluate(() => document.querySelector('[data-ext-filter="all"]').click());
  ok(await page.evaluate(() => [...document.querySelectorAll('[data-ext-filter]')].map((b) => b.textContent).join() === 'All,Themes,Packs'), 'filters All, Themes, Packs');
  await page.evaluate(() => document.querySelector('#extRoot .sb-header .sb-icon-btn').click()); await sleep(200);
  ok(await shown(page, '.ext-menu') && (await txt(page, '.ext-menu-item')).startsWith('Install from file'), 'Install opens a menu with "Install from file"');
  await page.evaluate(() => document.querySelector('#extRoot .sb-header .sb-icon-btn').click()); await sleep(200);

  // install a theme from a .cmpack: the review first
  await pick(page, M.cmpack('theme', THEME, { sender: 'Ana' }), 'midnight.cmpack'); await sleep(900);
  ok(await txt(page, '#extRoot .sb-title') === 'Review Extension' && !(await shown(page, '.sb-tabs')), 'a chosen file opens the Review Extension screen, in place of the tabs');
  ok(await txt(page, '.ext-review-name') === 'Midnight' && await txt(page, '.ext-review-head .ext-pill') === 'THEME', 'with its name and kind');
  const kv = await page.evaluate(() => [...document.querySelectorAll('.ext-body > .ext-kv')].map((r) => r.firstChild.textContent + '=' + r.lastChild.textContent));
  ok(kv.map((x) => x.split('=')[0]).join() === 'Name,Version,Author,Source,SHA-256' && /^Source=File, sent by Ana/.test(kv[3]) && /^SHA-256=[0-9a-f]{12}$/.test(kv[4]) && /not verified/.test(kv[2]), 'name, version, author (marked unverified), source, a short SHA-256', kv);
  ok((await all(page, '#extRoot .sb-section-header')).join() === 'GUARD REPORT,WHAT IT CHANGES', 'GUARD REPORT and WHAT IT CHANGES sections', await all(page, '#extRoot .sb-section-header'));
  ok(await txt(page, '.ext-guard .ext-pill') === 'Not fully checked' && /Guard is not available/.test(await txt(page, '.ext-guard')), 'the Guard verdict is honest: Not fully checked, and why');
  ok((await all(page, '.ext-changes li')).join('|') === 'Sets 3 colours on the Dark theme|Changes nothing else: it has no code.', 'and it says exactly what it changes');
  ok(/"Midnight"/.test(await page.evaluate(() => document.querySelector('.ext-pre').textContent)) && await page.evaluate(() => !!document.querySelector('.ext-source summary')), 'View source shows the file');
  ok((await all(page, '.ext-review-actions .ni-btn')).join() === 'Install and apply,Install' && await hasLink(page, '.ext-review-actions', 'Cancel'), 'Install and apply, Install, Cancel');
  ok(await page.evaluate(() => document.querySelector('.ext-review-actions .ni-btn.primary').textContent === 'Install and apply'), 'the first is the primary button');
  ok(await page.evaluate(() => window.CodeMiniExtensions.store.list().length === 0), 'nothing is installed yet');
  await clickLink(page, '.ext-review-actions', 'Cancel'); await sleep(300);
  ok(await txt(page, '#extRoot .sb-title') === 'Extensions' && await tabOf(page, 'installed') && await page.evaluate(() => window.CodeMiniExtensions.store.list().length === 0), 'Cancel goes back and installs nothing');
  await pick(page, M.cmpack('theme', THEME, { sender: 'Ana' }), 'midnight.cmpack'); await sleep(900);
  await page.evaluate(() => document.querySelector('.ext-review-actions .ni-btn.primary').click()); await sleep(900);
  ok(await txt(page, '#extRoot .sb-title') === 'Extensions' && await shown(page, row('theme-midnight')), 'Install and apply returns to the list with the new row');
  ok(await txt(page, row('theme-midnight') + ' .ext-row-name') === 'Midnight' && await txt(page, row('theme-midnight') + ' .ext-row-l2') === 'v1.0, by Ana, from File', 'named, with "v1.0, by Ana, from File"');
  ok(await page.evaluate((s) => !!document.querySelector(s + ' .ext-pill.active'), row('theme-midnight')) && await page.evaluate(() => document.querySelectorAll('.ext-pill.active').length === 1), 'it is the Active theme');
  ok(await rootVar(page, '--accent-blue') === '#7aa2f7' && await rootVar(page, '--bg-white') === '#1a1b26' && await rootVar(page, '--text-main') === '#c0caf5', 'its colours are on the page');
  ok(await setting(page, 'colorTheme') === 'CodeMini Dark' && await setting(page, 'extTheme') === 'theme-midnight' && await setting(page, 'themePack') === 'None', 'on the Dark base, no theme pack, extTheme set');
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.ext-pill.active')).backgroundColor === 'rgb(122, 162, 247)'), 'and the app really draws with them (the Active pill is the theme\'s blue)');
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => /extensions$/.test(k)))).length === 1), 'it is saved');

  // survives a reload, with no flash of the base theme
  await page.reload({ waitUntil: 'domcontentloaded' });
  ok(await rootVar(page, '--bg-white') === '#1a1b26', 'after a reload its colours are on the page at once (the early theme cache knows them)');
  await sleep(3500);
  ok(await sidebarOpen(page) && await shown(page, row('theme-midnight')) && await page.evaluate((s) => !!document.querySelector(s + ' .ext-pill.active'), row('theme-midnight')), 'the sidebar comes back open, Midnight still Active');
  ok(await rootVar(page, '--accent-blue') === '#7aa2f7' && await setting(page, 'extTheme') === 'theme-midnight', 'and still applied');

  // leaving it: another built-in theme, or choosing one in Settings
  await page.evaluate(() => [...document.querySelectorAll('.ext-row')].find((r) => r.querySelector('.ext-row-name').textContent === 'CodeMini Light').querySelector('.ni-link').click()); await sleep(400);
  ok(await rootVar(page, '--bg-white') === '' && await setting(page, 'extTheme') === '' && await setting(page, 'colorTheme') === 'CodeMini Light', 'applying a built-in theme takes the installed theme\'s colours off');
  ok(await hasLink(page, row('theme-midnight'), 'Apply') && !(await page.evaluate((s) => !!document.querySelector(s + ' .ext-pill.active'), row('theme-midnight'))), 'Midnight shows Apply again');
  await clickLink(page, row('theme-midnight'), 'Apply'); await sleep(400);
  ok(await rootVar(page, '--bg-white') === '#1a1b26' && await setting(page, 'colorTheme') === 'CodeMini Dark', 'Apply puts it back, and switches to the Dark base it was made for');
  await page.evaluate(() => window.saveSetting('colorTheme', 'CodeMini Dark +')); await sleep(400);
  ok(await rootVar(page, '--bg-white') === '' && await setting(page, 'extTheme') === '', 'choosing another Colour Theme in Settings leaves the installed theme');
  ok(!(await page.evaluate((s) => !!document.querySelector(s + ' .ext-pill.active'), row('theme-midnight'))), 'and the list follows without being touched');
  await clickLink(page, row('theme-midnight'), 'Apply'); await sleep(300);
  const pack0 = await page.evaluate(() => Object.keys(window.THEME_PACK_REGISTRY).find((n) => n !== 'None'));
  await page.evaluate((n) => window.CodeMiniExtensions.applyBuiltIn(null, n), pack0); await sleep(400);
  ok(await rootVar(page, '--bg-white') === '' && await setting(page, 'themePack') === pack0, 'a theme pack owns the whole look: the installed theme\'s colours are not laid over it');
  await clickLink(page, row('theme-midnight'), 'Apply'); await sleep(300);
  ok(await setting(page, 'themePack') === 'None' && await rootVar(page, '--bg-white') === '#1a1b26', 'applying Midnight again turns the pack off');

  // a snippet pack: completion really gets its snippets, and only while it is enabled
  ok(!(await snippetPrefixes(page, 'javascript')).includes('cl'), 'before: completion has no "cl" snippet');
  await pick(page, M.cmpack('snippets', PACK), 'js-helpers.cmpack'); await sleep(900);
  ok(await txt(page, '.ext-review-head .ext-pill') === 'PACK' && (await all(page, '.ext-changes li'))[0] === 'Adds 2 snippets for javascript', 'a pack\'s review says how many snippets, for which language');
  ok((await all(page, '.ext-review-actions .ni-btn')).join() === 'Install and enable,Install disabled', 'Install and enable, Install disabled');
  await page.evaluate(() => document.querySelector('.ext-review-actions .ni-btn.primary').click()); await sleep(900);
  ok(await txt(page, row('pack-js-helpers') + ' .ext-row-l2') === 'v1.2.0, by Bo, from File' && await txt(page, row('pack-js-helpers') + ' .ext-pill') === 'PACK', 'the pack is listed');
  ok(await switchOn(page, row('pack-js-helpers')), 'with its switch on');
  ok(JSON.stringify(await snippetPrefixes(page, 'javascript').then((a) => a.filter((p) => p === 'cl' || p === 'fn'))) === '["cl","fn"]', 'completion now offers its snippets (cl, fn)');
  ok(!(await snippetPrefixes(page, 'python')).includes('cl'), 'for its language only');
  await page.evaluate((s) => document.querySelector(s + ' .ext-switch').click(), row('pack-js-helpers')); await sleep(400);
  ok(!(await snippetPrefixes(page, 'javascript')).includes('cl') && /^DISABLED/.test((await all(page, '#extRoot .sb-section-header')).slice(-1)[0]), 'switched off: its snippets go, and the row moves under DISABLED', [await snippetPrefixes(page, 'javascript'), await all(page, '#extRoot .sb-section-header')]);
  await page.evaluate((s) => document.querySelector(s + ' .ext-switch').click(), row('pack-js-helpers')); await sleep(400);
  ok((await snippetPrefixes(page, 'javascript')).includes('fn'), 'switched on again: they are back');

  // details, uninstall (two steps)
  await expand(page, row('pack-js-helpers'));
  const det = await page.evaluate((s) => [...document.querySelectorAll(s + ' .ext-kv')].map((r) => r.firstChild.textContent + '=' + r.lastChild.textContent), row('pack-js-helpers'));
  ok(det.map((x) => x.split('=')[0]).join() === 'Source,Version,SHA-256,Installed,Guard' && /^SHA-256=[0-9a-f]{12}$/.test(det[2]) && /Not fully checked/.test(det[4]), 'details: source, version, SHA-256, when installed, and the Guard verdict', det);
  ok(/Two small snippets/.test(await txt(page, row('pack-js-helpers') + ' .ext-desc')), 'and its description');
  await clickLink(page, row('pack-js-helpers'), 'Uninstall'); await sleep(200);
  ok(/Uninstall this pack and its 2 snippets\?/.test(await txt(page, row('pack-js-helpers') + ' .ext-confirm')), 'Uninstall asks first, and says what goes');
  await clickLink(page, row('pack-js-helpers'), 'Cancel'); await sleep(200);
  ok(await shown(page, row('pack-js-helpers')) && (await snippetPrefixes(page, 'javascript')).includes('cl'), 'Cancel keeps it');
  await clickLink(page, row('pack-js-helpers'), 'Uninstall'); await clickLink(page, row('pack-js-helpers'), 'Uninstall'); await sleep(400);
  ok(!(await shown(page, row('pack-js-helpers'))) && !(await snippetPrefixes(page, 'javascript')).includes('cl'), 'Uninstall removes the row and exactly its snippets');
  ok(await page.evaluate(() => window.CodeMiniSnippets.store.count('javascript') === 0), 'the person\'s own snippets were never touched');
  await pick(page, M.cmpack('snippets', PACK), 'js-helpers.cmpack'); await sleep(900);
  await page.evaluate(() => document.querySelectorAll('.ext-review-actions .ni-btn')[1].click()); await sleep(900);
  ok(!(await switchOn(page, row('pack-js-helpers'))) && !(await snippetPrefixes(page, 'javascript')).includes('cl') && /^DISABLED/.test((await all(page, '#extRoot .sb-section-header')).slice(-1)[0]), 'Install disabled: listed, off, its snippets not offered', [await switchOn(page, row('pack-js-helpers')), await snippetPrefixes(page, 'javascript'), await all(page, '#extRoot .sb-section-header')]);
  await expand(page, row('pack-js-helpers')); await clickLink(page, row('pack-js-helpers'), 'Uninstall'); await clickLink(page, row('pack-js-helpers'), 'Uninstall'); await sleep(300);

  // reinstalling and replacing
  await pick(page, M.cmpack('theme', THEME, { sender: 'Ana' }), 'midnight.cmpack'); await sleep(900);
  ok(/already installed/.test(await txt(page, '.ext-note')) && await page.evaluate(() => [...document.querySelectorAll('.ext-review-actions .ni-btn')].every((b) => b.disabled)), 'the same pack again: "already installed", and Install is off');
  await clickLink(page, '.ext-review-actions', 'Cancel'); await sleep(200);
  await pick(page, M.cmpack('theme', Object.assign({}, THEME, { version: '1.1', colors: Object.assign({}, THEME.colors, { '--accent-blue': '#ff9e64' }) })), 'midnight11.cmpack'); await sleep(900);
  ok(/This replaces v1\.0\./.test(await txt(page, '.ext-note')), 'a newer version says it replaces v1.0');
  await page.evaluate(() => document.querySelector('.ext-review-actions .ni-btn.primary').click()); await sleep(900);
  ok(await txt(page, row('theme-midnight') + ' .ext-row-l2') === 'v1.1, by Ana, from File' && await rootVar(page, '--accent-blue') === '#ff9e64', 'it is replaced and applied');
  await expand(page, row('theme-midnight'));
  ok(/Replaced v1\.0\./.test(await txt(page, row('theme-midnight') + ' .ext-detail')) && await page.evaluate(() => window.CodeMiniExtensions.store.list().length === 1), 'it remembers what it replaced, and there is still one');

  // errors: each is a message, nothing is installed
  const bodyTheme = JSON.stringify(THEME, null, 2), tampered = bodyTheme.replace('#7aa2f7', '#ff0000');
  const bad = async (buf, re, label) => { await pick(page, buf, 'bad.cmpack'); await sleep(900); const msg = await txt(page, '.ext-error'); ok(re.test(msg || '') && await tabOf(page, 'installed') && await page.evaluate(() => !!document.querySelector('.ext-error[role="alert"]')), label, msg); return msg; };
  await bad(M.cmpack('theme', tampered, { sha256: M.sha256(Buffer.from(bodyTheme)), size: bodyTheme.length }), /Integrity check failed.*changed after the pack was made/, 'a changed file: "Integrity check failed"');
  await clickLink(page, '.ext-error', 'Dismiss'); await sleep(200);
  ok(!(await shown(page, '.ext-error')), 'Dismiss clears the message');
  await bad(Buffer.from('this is just a text file, not a zip at all, but long enough'), /not a \.cmpack/, 'a file that is not a ZIP');
  await bad(M.cmpack('extension', { x: 1 }, { itemPath: 'ext.json' }), /scripted extension, which cannot be installed yet/, 'a scripted extension is refused, with the reason');
  const msg = await bad(M.cmpack('theme', { name: '', version: 'x', base: 'purple', colors: { '--accent-blue': 'red', '--evil': '#fff' } }), /theme file has problems/, 'a theme with problems');
  ok((await all(page, '.ext-error-list li')).length >= 4 && (await all(page, '.ext-error-list li')).some((x) => /not a colour a theme can set/.test(x)), 'each problem is listed', await all(page, '.ext-error-list li'));
  await bad(M.zip([{ name: '../evil.json', data: '{}', method: 'store' }]), /unsafe path/, 'a path that climbs out of the pack');
  ok(await page.evaluate(() => window.CodeMiniExtensions.store.list().length === 1), 'and none of those installed anything');

  // uninstalling the active theme
  await expand(page, row('theme-midnight')); await clickLink(page, row('theme-midnight'), 'Uninstall'); await sleep(150);
  ok(/Uninstall this theme\?/.test(await txt(page, row('theme-midnight') + ' .ext-confirm')), 'a theme asks too');
  await clickLink(page, row('theme-midnight'), 'Uninstall'); await sleep(500);
  ok(!(await shown(page, row('theme-midnight'))) && await rootVar(page, '--bg-white') === '' && await setting(page, 'extTheme') === '', 'uninstalling the active theme takes its colours off, with no trace');
  ok(await page.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((k) => /extensions$/.test(k)) || 'x')) === null, 'and the saved list is empty');
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();

  // ====================================================================== Components (feature 13's list, moved here), Same origin mode
  console.log('\n[desktop: Components, Same origin mode]');
  ({ ctx, page, errors, hits, fails } = await openApp(browser, { normal: true }));
  await page.evaluate(() => CodeMiniNowIsland.open({ tab: 'now' })); await sleep(500);
  ok(await shown(page, '.off-sec') && !(await sidebarOpen(page)), 'the Now Island still has its Offline and Packages section');
  ok(await page.evaluate(() => document.querySelectorAll('.off-sec .off-row').length === 3) && !(await page.evaluate(() => !!document.getElementById('niViewer') && document.getElementById('niViewer').classList.contains('show'))), 'three summary rows, and no slide-over');
  await page.evaluate(() => [...document.querySelectorAll('.off-sec .ni-link')].find((b) => b.textContent === 'Manage').click()); await sleep(700);
  ok(await sidebarOpen(page) && await tabOf(page, 'components'), 'Manage opens the Extensions sidebar on its Components tab');
  ok(/^0 of 17 ready offline$/.test(await txt(page, '.ext-summary-sub')) && /of .* used/.test(await txt(page, '.ext-summary-text')), 'a summary: how many are ready, and the storage used');
  ok(await page.evaluate(() => !!document.querySelector('.ext-usage .ext-usage-fill')), 'with a 2px usage line');
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.ext-usage')).height === '2px'), 'which is 2px');
  const groups = await page.evaluate(() => [...document.querySelectorAll('.ext-body .sb-section-header')].map((g) => g.firstChild.firstChild.textContent + '=' + g.querySelector('.sb-count-badge').textContent));
  ok(groups.join(',') === 'LANGUAGES AND RUNTIMES=5,EDITING=2,VIEWERS=5,CORE=5', 'four groups with counts, in the spec\'s order', groups);
  ok(await page.evaluate(() => document.querySelectorAll('.ext-row[data-comp]').length === 17), 'every component has a row');
  ok(await page.evaluate(() => ['monaco', 'jszip', 'diff', 'remixicon', 'fontawesome'].every((id) => { const r = document.querySelector('.ext-row[data-comp="' + id + '"]'); return !!r.querySelector('.ext-lock') && !r.querySelector('.ext-switch'); })), 'CORE rows carry a lock and no Keep offline switch');
  ok(await page.evaluate(() => ['pyodide', 'webr', 'sqljs', 'php', 'opal', 'babel', 'emmet', 'pdfjs', 'marked'].every((id) => { const r = document.querySelector('.ext-row[data-comp="' + id + '"]'); return !!r.querySelector('.ext-switch') && !r.querySelector('.ext-lock'); })), 'every other row has a Keep offline switch');
  ok(await page.evaluate(() => { const r = document.querySelector('.ext-row[data-comp="pyodide"]'); return r.querySelector('.ext-row-name').textContent === 'Python (Pyodide)' && r.querySelector('.ext-pill').textContent === '0.24.1' && /^Needed by: Python notebooks, /.test(r.querySelector('.ext-row-l2').textContent) && r.querySelector('.ext-row-main').getBoundingClientRect().height >= 51; }), 'a row: name, version pill, "Needed by", and room to breathe');
  ok(await stateOf(page, 'pyodide') === 'Not downloaded' && await stateOf(page, 'monaco') !== 'Runs in the runner', 'Pyodide is Not downloaded');
  ok(await page.evaluate(() => /Download all for offline, 16 left/.test(document.querySelector('.ext-summary-row .ni-link').textContent)), 'Download all counts what is left (the bundled one needs none)');
  ok(!(await hasLink(page, '.ext-summary-row', 'Clear cached data')), 'there is no clear-everything button: CORE is required');

  // search and scroll are remembered per tab
  await page.fill('.ext-search', 'pyo'); await sleep(200);
  ok(await page.evaluate(() => document.querySelectorAll('.ext-row[data-comp]').length === 1 && document.querySelector('.ext-row[data-comp]').dataset.comp === 'pyodide'), 'search finds one component by name');
  await clickTab(page, 'installed');
  ok(await page.evaluate(() => document.querySelector('.ext-search').value === ''), 'the Installed tab has its own search');
  await clickTab(page, 'components');
  ok(await page.evaluate(() => document.querySelector('.ext-search').value === 'pyo') && await page.evaluate(() => document.querySelectorAll('.ext-row[data-comp]').length === 1), 'and Components kept its own');
  await page.fill('.ext-search', ''); await sleep(200);
  await page.evaluate(() => { document.querySelector('.ext-body').scrollTop = 400; }); await clickTab(page, 'installed'); await clickTab(page, 'components');
  ok(await page.evaluate(() => Math.abs(document.querySelector('.ext-body').scrollTop - 400) < 3), 'the scroll position is remembered too', await page.evaluate(() => document.querySelector('.ext-body').scrollTop));
  await page.evaluate(() => { document.querySelector('.ext-body').scrollTop = 0; });

  // expanded row, then download one
  await expand(page, comp('pyodide'));
  const det2 = await page.evaluate(() => { const d = document.querySelector('.ext-row[data-comp="pyodide"] .ext-detail'); return d ? { titles: [...d.querySelectorAll('.off-rel-title')].map((x) => x.textContent), acts: [...d.querySelectorAll('.ni-link')].map((x) => x.textContent), files: d.querySelector('.off-files summary').textContent } : null; });
  ok(det2 && det2.titles.join() === 'Needed by' && det2.acts.join() === 'Download,Open source', 'expanded: Needed by, then Download and Open source (nothing to verify or remove yet)', det2);
  await expand(page, comp('sqljs'));
  await clickLink(page, comp('sqljs'), 'Download');
  ok(await waitFor(async () => await stateOf(page, 'sqljs') === 'Ready offline'), 'Download: SQL becomes Ready offline', await stateOf(page, 'sqljs'));
  ok((await dynKeys(page)).length === 2 && await cachedUrl(page, 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.wasm'), 'its two files are in the cache');
  ok(await waitFor(async () => /KB|B$/.test(await txt(page, comp('sqljs') + ' .ext-size') || '')), 'its size is shown', await txt(page, comp('sqljs') + ' .ext-size'));
  ok(/2 of 2 files/.test(await txt(page, comp('sqljs') + ' .ext-row-l2:last-of-type')), '"2 of 2 files"');
  ok(/^1 of 17 ready offline$/.test(await txt(page, '.ext-summary-sub')), 'the summary follows');
  ok(await page.evaluate(() => [...document.querySelectorAll('.ext-body .sb-section-header')].length === 4), 'still four groups');

  // Re-verify
  await expand(page, comp('sqljs'));
  await clickLink(page, comp('sqljs'), 'Re-verify');
  ok(await waitFor(async () => /Verified 2 files/.test(await txt(page, comp('sqljs') + ' .ext-detail') || '')), 'Re-verify checks every saved file: "Verified 2 files"', await txt(page, comp('sqljs') + ' .ext-detail'));
  await page.evaluate(async () => { const n = (await caches.keys()).find((k) => k.indexOf('codemini-dynamic-') === 0), c = await caches.open(n); await c.put('https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.wasm', new Response('', { status: 200, headers: { 'content-type': 'application/wasm' } })); });
  await clickLink(page, comp('sqljs'), 'Re-verify');
  ok(await waitFor(async () => /1 file has a problem/.test(await txt(page, comp('sqljs') + ' .ext-detail') || '')) && /sql-wasm\.wasm: The saved copy is empty/.test(await txt(page, comp('sqljs') + ' .ext-detail') || ''), 'a file that was emptied is found, and named', await txt(page, comp('sqljs') + ' .ext-detail'));
  await clickLink(page, comp('sqljs'), 'Re-download');
  ok(await waitFor(async () => await page.evaluate(async () => (await (await caches.match('https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.wasm')).text()).startsWith('wasm-bytes'))), 'Re-download puts a good copy back');
  await clickLink(page, comp('sqljs'), 'Re-verify');
  ok(await waitFor(async () => /Verified 2 files/.test(await txt(page, comp('sqljs') + ' .ext-detail') || '')), 'and it verifies');

  // Remove from this device: two steps, says what it means
  await clickLink(page, comp('sqljs'), 'Remove from this device'); await sleep(150);
  ok(/^Removes .+\. SQL downloads again the next time it is used\.$/.test(await txt(page, comp('sqljs') + ' .ext-confirm')), 'asks first, with the size and what happens next', await txt(page, comp('sqljs') + ' .ext-confirm'));
  await clickLink(page, comp('sqljs'), 'Cancel'); await sleep(150);
  ok(await stateOf(page, 'sqljs') === 'Ready offline', 'Cancel keeps it');
  await clickLink(page, comp('sqljs'), 'Remove from this device'); await clickLink(page, comp('sqljs'), 'Remove');
  ok(await waitFor(async () => await stateOf(page, 'sqljs') === 'Not downloaded') && !(await cachedUrl(page, 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.wasm')), 'Remove takes it off the device');

  // Keep offline
  ok(!(await switchOn(page, comp('sqljs'))), 'the switch starts off: On demand');
  await page.evaluate((s) => document.querySelector(s + ' .ext-switch').click(), comp('sqljs'));
  ok(await waitFor(async () => await stateOf(page, 'sqljs') === 'Ready offline'), 'Keep offline downloads it now', await stateOf(page, 'sqljs'));
  ok(await switchOn(page, comp('sqljs')) && await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => /keepOffline$/.test(k)))).join() === 'sqljs'), 'and the choice is saved');
  await page.evaluate(async () => { const n = (await caches.keys()).find((k) => k.indexOf('codemini-dynamic-') === 0), c = await caches.open(n); for (const r of await c.keys()) await c.delete(r); });   // the browser cleared it
  await page.evaluate(() => CodeMiniOffline.refresh()); await sleep(500);
  ok(await stateOf(page, 'sqljs') === 'Not downloaded', 'the browser clears the cache: it is gone');
  const h0 = hits['https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.js'];
  await page.evaluate(() => CodeMiniOffline.maintainKept());
  ok(await waitFor(async () => await stateOf(page, 'sqljs') === 'Ready offline') && hits['https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.js'] > h0, 'a kept component is fetched again by itself', [h0, hits['https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.js']]);
  const others = await dynKeys(page);
  ok(!others.some((u) => /pyodide|webr|opal/.test(u)) && others.some((u) => /jszip/.test(u)) && await stateOf(page, 'jszip') === 'Ready offline', 'it brought the CORE components that were missing (they are always kept), and nothing else', others);
  await page.evaluate((s) => document.querySelector(s + ' .ext-switch').click(), comp('sqljs')); await sleep(400);
  ok(!(await switchOn(page, comp('sqljs'))) && await stateOf(page, 'sqljs') === 'Ready offline', 'turning it off keeps what is saved (it is on demand again)');
  await page.evaluate((s) => document.querySelector(s + ' .ext-switch').click(), comp('sqljs')); await sleep(400);
  await expand(page, comp('sqljs')); await clickLink(page, comp('sqljs'), 'Remove from this device'); await clickLink(page, comp('sqljs'), 'Remove');
  ok(await waitFor(async () => await stateOf(page, 'sqljs') === 'Not downloaded') && !(await switchOn(page, comp('sqljs'))), 'removing a kept component stops keeping it');
  ok(await page.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((k) => /keepOffline$/.test(k)) || 'x')) === null, 'and clears the saved choice');

  // CORE: required, no Remove
  await expand(page, comp('jszip'));
  ok(/Required\. CodeMini cannot run without it/.test(await txt(page, comp('jszip') + ' .ext-detail')), 'a CORE row says it is required');
  ok(!(await hasLink(page, comp('jszip'), 'Remove from this device')) && await hasLink(page, comp('jszip'), 'Re-verify'), 'it has no Remove, but can be re-verified');
  await page.evaluate(async () => { const n = (await caches.keys()).find((k) => k.indexOf('codemini-dynamic-') === 0), c = await caches.open(n); await c.delete('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'); });   // the browser cleared it
  await page.evaluate(() => CodeMiniOffline.refresh()); await sleep(500);
  ok(await stateOf(page, 'jszip') === 'Not downloaded', 'if the browser clears a CORE component it shows as Not downloaded');
  await expand(page, comp('jszip')); await clickLink(page, comp('jszip'), 'Download');
  ok(await waitFor(async () => await stateOf(page, 'jszip') === 'Ready offline'), 'and Download puts it back');

  // the other states and fallbacks, as before
  await page.evaluate(() => CodeMiniOffline.download(['fontawesome']));
  ok(await waitFor(async () => await stateOf(page, 'fontawesome') === 'Ready offline'), 'Font Awesome is Ready after its CSS and the fonts the CSS names');
  const fa = (await dynKeys(page)).filter((u) => /font-awesome/.test(u));
  ok(fa.length === 3 && fa.some((u) => /fa-solid-900\.woff2$/.test(u)) && !fa.some((u) => /\.ttf$/.test(u)), 'three files: the CSS and the woff2 fonts only', fa);
  fails['pyodide-lock.json'] = 404;
  await page.evaluate(() => CodeMiniOffline.download(['pyodide']));
  ok(await waitFor(async () => await stateOf(page, 'pyodide') === 'Ready offline'), 'Pyodide is ready although its optional lock file is not on the host');
  fails['unpkg.com/php-wasm'] = 404;
  await page.evaluate(() => CodeMiniOffline.download(['php']));
  ok(await waitFor(async () => await cachedUrl(page, 'https://cdn.jsdelivr.net/npm/php-wasm@0.1.0/PhpWeb.mjs')) && await stateOf(page, 'php') === 'Partly cached', 'php-wasm falls back to the second CDN, and stays Partly cached (the engine loads on first use)');
  fails['webr.r-wasm.org'] = 'abort';
  await page.evaluate(() => CodeMiniOffline.download(['webr']));
  ok(await waitFor(async () => await stateOf(page, 'webr') === 'Failed or blocked'), 'a blocked host: Failed or blocked');
  await expand(page, comp('webr'));
  ok(/blocked it or could not be reached/.test(await txt(page, comp('webr') + ' .ext-desc.danger') || '') && await hasLink(page, comp('webr'), 'Retry'), 'with the reason and Retry');
  delete fails['webr.r-wasm.org']; await clickLink(page, comp('webr'), 'Retry');
  ok(await waitFor(async () => await stateOf(page, 'webr') === 'Partly cached'), 'Retry works once the host does');

  // RUNNING: a download is a background task in the Now Island
  await page.evaluate(() => CodeMiniOffline.removePackage('pyodide')); await sleep(500);
  fails['cdn.jsdelivr.net/pyodide/v0.24.1/full/pyodide.asm.wasm'] = { delay: 2500 };
  await page.evaluate(() => { CodeMiniNowIsland.open({ tab: 'now' }); document.getElementById('extensionsSidebar'); });
  await page.evaluate(() => { window.__dl = CodeMiniOffline.download(['pyodide']); }); await sleep(1800);
  const running = await page.evaluate(() => { const s = document.querySelector('.ni-sec-running'); return s && !s.hidden ? s.textContent : ''; });
  ok(/Download Python \(Pyodide\)/.test(running), 'a download is listed in the Now Island\'s RUNNING section', running.slice(0, 120));
  await page.evaluate(() => window.__dl); await sleep(600);
  ok(await page.evaluate(() => { const s = document.querySelector('.ni-sec-running'); return !s || s.hidden || !/Download Python/.test(s.textContent); }), 'and leaves it when it ends');
  delete fails['cdn.jsdelivr.net/pyodide/v0.24.1/full/pyodide.asm.wasm'];

  // Download all, Stop, the end state, a slow connection, offline, Protect storage
  await page.evaluate(() => Promise.all(['pyodide', 'webr', 'php'].map((id) => CodeMiniOffline.removePackage(id)))); await sleep(400);
  fails['cdnjs.cloudflare.com/ajax/libs/github-markdown-css'] = { delay: 1500 };
  await page.evaluate(() => [...document.querySelectorAll('.ext-summary-row .ni-link')][0].click()); await sleep(600);
  ok(await page.evaluate(() => CodeMiniOffline.info().running) && await hasLink(page, '.ext-summary-row', 'Stop downloading'), 'Download all: the link becomes Stop downloading');
  ok(await page.evaluate(() => !!document.querySelector('.ext-row .ri-loader-4-line')), 'a component in progress shows the spinner');
  await clickLink(page, '.ext-summary-row', 'Stop downloading');
  ok(await waitFor(async () => !(await page.evaluate(() => CodeMiniOffline.info().running)), 6000), 'Stop ends the run');
  delete fails['cdnjs.cloudflare.com/ajax/libs/github-markdown-css'];
  await page.evaluate(() => [...document.querySelectorAll('.ext-summary-row .ni-link')][0].click());
  ok(await waitFor(async () => /Everything is downloaded/.test(await txt(page, '.ext-summary-row .ni-link') || ''), 15000), 'Download all again finishes: "Everything is downloaded"', await txt(page, '.ext-summary-row .ni-link'));
  ok(await page.evaluate(() => document.querySelector('.ext-summary-row .ni-link').disabled), 'and the link is off');
  const sum = await page.evaluate(() => CodeMiniOffline.summary());
  ok(sum.word === 'Partly offline' && sum.counts.failed === 0, 'the header still says Partly offline: three components load more on first use', sum);
  await page.evaluate(() => Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true }));
  await page.evaluate(() => CodeMiniOffline.removePackage('emmet')); await sleep(500);
  await page.evaluate(() => [...document.querySelectorAll('.ext-summary-row .ni-link')][0].click()); await sleep(200);
  ok(/slow or data-saver connection/.test(await txt(page, '.ext-summary') || '') && !(await page.evaluate(() => CodeMiniOffline.info().running)), 'on a data-saver connection it asks before downloading');
  await clickLink(page, '.ext-summary-row', 'Cancel'); await sleep(150);
  await page.evaluate(() => Object.defineProperty(navigator, 'connection', { value: undefined, configurable: true }));
  await ctx.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline'))); await sleep(300);
  ok(await page.evaluate(() => document.querySelector('.ext-summary-row .ni-link').disabled) && /offline/i.test(await txt(page, '.ext-summary-row') || ''), 'offline: Download all is off, and says why');
  await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await sleep(300);
  await page.evaluate(() => { window.__prot = 0; window.CodeMiniAlerts = { canProtectStorage: () => true, protectStorage: async () => { window.__prot++; } }; navigator.storage.persisted = async () => false; });
  await page.evaluate(() => CodeMiniOffline.refresh()); await sleep(500);
  ok(await hasLink(page, '.ext-summary-top', 'Protect storage'), 'unprotected storage offers Protect storage in the summary');
  await clickLink(page, '.ext-summary-top', 'Protect storage'); await sleep(300);
  ok(await page.evaluate(() => window.__prot === 1), 'which uses the app\'s existing action');
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();

  // ====================================================================== Isolated mode: the runner hides what it hosts
  console.log('\n[desktop: Components, Isolated mode]');
  ({ ctx, page, errors, hits, fails } = await openApp(browser, {}));
  await openSidebar(page, 'components');
  const hidden = await page.evaluate(() => CodeMiniOffline.rows().filter((r) => r.state === 'runner').map((r) => r.pkg.id));
  ok(['pyodide', 'webr', 'sqljs', 'php', 'opal', 'marked', 'ghmd'].every((i) => hidden.includes(i)) && !hidden.includes('monaco'), 'with Isolation on, the runtimes the runner hosts say "Runs in the runner"', hidden);
  ok(await stateOf(page, 'pyodide') === 'Runs in the runner' && !(await page.evaluate(() => !!document.querySelector('.ext-row[data-comp="pyodide"] .ext-switch'))), 'their rows say so, and have no Keep offline switch');
  ok(/^0 of 10 ready offline/.test(await txt(page, '.ext-summary-sub')) && /7 run in the isolated runner/.test(await txt(page, '.ext-summary-sub')), 'they are left out of the count, and the summary says how many', await txt(page, '.ext-summary-sub'));
  await expand(page, comp('pyodide'));
  ok(/no service worker of its own/.test(await txt(page, comp('pyodide') + ' .ext-desc') || '') && !(await hasLink(page, comp('pyodide'), 'Download')), 'a row explains why, and offers no download');
  const snap = Object.assign({}, hits);
  await page.evaluate(() => [...document.querySelectorAll('.ext-summary-row .ni-link')][0].click());
  ok(await waitFor(async () => /Everything is downloaded/.test(await txt(page, '.ext-summary-row .ni-link') || ''), 15000), 'Download all downloads what the app can cover');
  const newHits = Object.keys(hits).filter((u) => hits[u] > (snap[u] || 0));
  ok(newHits.length > 5 && !newHits.some((u) => /pyodide|opalrb|r-wasm|sql\.js|php-wasm|marked|github-markdown/.test(u)), 'and never fetches what the runner hosts');
  ok(await txt(page, '.off-sec .off-word') !== 'Ready offline', 'the header does not say Ready offline while part of the app is not covered');
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();

  // ====================================================================== theme packs
  console.log('\n[theme packs]');
  ({ ctx, page, errors } = await openApp(browser, { normal: true }));
  await openSidebar(page, 'installed');
  await pick(page, Buffer.from('not a zip, only some text, but long enough to try'), 'bad.cmpack'); await sleep(800);
  await page.evaluate(() => document.querySelector('#extRoot .sb-header .sb-icon-btn').click()); await sleep(200);
  const shape = (pack) => page.evaluate((p) => { if (p) document.documentElement.dataset.themePack = p; else delete document.documentElement.dataset.themePack;
    const r = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).borderRadius : null; }; return { pill: r('.ext-pill'), search: r('.ext-search'), menu: r('.ext-menu'), error: r('.ext-error'), seg: r('.ext-searchbar .sb-segmented') }; }, pack);
  const def = await shape(null);
  for (const pack of ['codemini-premium', 'codemini-premium-light']) {
    const s = await shape(pack);
    ok(s.pill === '999px' && s.seg === '999px', pack + ': the kind pill and the filter are pills', s);
    ok(s.search === '0px' && def.search === '0px', pack + ': the search keeps its flat underline', [s.search, def.search]);
    ok(s.menu === '14px' && s.error === '14px', pack + ': the Install menu and the error card take the card shape', s);
  }
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();

  // ====================================================================== phone
  console.log('\n[phone]');
  ({ ctx, page, errors } = await openApp(browser, { normal: true, phone: true }));
  await openSidebar(page, 'installed');
  ok(await page.evaluate(() => { const r = document.getElementById('extensionsSidebar').getBoundingClientRect(); return r.width > 280 && r.right <= 391; }), 'the sidebar fits the screen', await page.evaluate(() => document.getElementById('extensionsSidebar').getBoundingClientRect().width));
  const fits = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && e.scrollWidth <= e.clientWidth + 1; }, sel);
  ok(await fits('.ext-body') && await fits('.sb-tabs') && await fits('.ext-searchbar'), 'nothing overflows sideways: the list, the tabs, the search and filter');
  ok(await page.evaluate(() => [...document.querySelectorAll('.ext-row .ni-link')].length > 0 && [...document.querySelectorAll('.ext-row .ni-link, .sb-tab')].every((b) => b.getBoundingClientRect().height >= 30)), 'links and tabs are at least 30px tall to tap');
  ok(await page.evaluate(() => { const sw = document.querySelector('.ext-switch'); if (!sw) return false; const a = getComputedStyle(sw, '::after'); return a.position === 'absolute' && parseFloat(a.height) >= 40 && parseFloat(a.width) >= 40 && sw.getBoundingClientRect().height === 16; }) || await page.evaluate(() => !document.querySelector('.ext-switch')), 'the switch keeps its size but gets a 40px-plus hit area');
  await pick(page, M.cmpack('theme', THEME), 'midnight.cmpack'); await sleep(900);
  ok(await fits('.ext-body') && await shown(page, '.ext-review-actions') && await page.evaluate(() => { const b = document.querySelector('.ext-review-actions .ni-btn.primary').getBoundingClientRect(); return b.right <= 391 && b.left >= 0; }), 'the review screen fits too, buttons on screen');
  await page.evaluate(() => document.querySelector('.ext-review-actions .ni-btn.primary').click()); await sleep(700);
  ok(await rootVar(page, '--bg-white') === '#1a1b26', 'a theme installs and applies on a phone');
  await clickTab(page, 'components');
  ok(await fits('.ext-body') && await fits('.ext-summary'), 'Components fits');
  await page.evaluate(() => document.querySelector('.ext-row[data-comp="pyodide"] .ext-row-main').click()); await sleep(200);
  ok(await fits('.ext-body'), 'an expanded row fits');
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('Crashed:', e); process.exit(2); });
