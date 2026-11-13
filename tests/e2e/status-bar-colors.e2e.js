// Settings > Theme > Status Bar, in a real browser: the chosen background and text-and-icons colors reach the bottom status bar
// on Light, Light +, Dark and Dark +; a Theme Pack keeps the bar exactly as it draws it (and gets the choice back when it is
// turned off); Reset returns to the theme's own colors; the Settings controls show what the bar really looks like; and the
// next load paints the colors from the first frame (no flash).
// Needs the app on http://localhost:8765 (npm run test:e2e serves it) and Playwright.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const NOISE = /monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i;
const URL = 'http://localhost:8765/index.html';
const rgb = (hex) => { const h = hex.replace('#', ''); return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`; };
const THEMES = ['CodeMini Light', 'CodeMini Light +', 'CodeMini Dark', 'CodeMini Dark +'];
const PACKS = ['CodeMini Premium', 'CodeMini Premium Light'];
const BG = '#123456', FG = '#fedcba';

// The network is blocked and Monaco is a stand-in: only the page's own scripts matter here. Records, per animation frame, what the status bar looks like.
async function newPage(browser, seedSrc) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.addInitScript((seedSrc) => {
    if (seedSrc && !localStorage.getItem('__seeded')) { localStorage.setItem('__seeded', '1'); try { new Function(seedSrc)(); } catch (e) { console.error('seed failed', e); } }
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { setTimeout(() => { window.monaco = mk(); cb(); }, 0); }; window.require.config = () => {};
    window.__f = []; const t0 = performance.now();
    const tick = () => {
      const bar = document.querySelector('.status-bar');
      window.__f.push({ t: Math.round(performance.now() - t0), hasBar: !!bar, bg: bar ? getComputedStyle(bar).backgroundColor : null, varBg: document.documentElement.style.getPropertyValue('--status-bar-bg') });
      if (performance.now() - t0 < 2500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, seedSrc || '');
  return { page, errors };
}
const ready = async (page) => {
  await page.waitForFunction(() => typeof window.saveSetting === 'function' && document.querySelector('.status-bar') && !document.getElementById('appPreloader'), null, { timeout: 15000 });
};
const measure = async (page) => { await sleep(450); return page.evaluate(() => {
  const cs = (el) => getComputedStyle(el), bar = document.querySelector('.status-bar'), root = document.documentElement;
  return {
    bg: cs(bar).backgroundColor, fg: cs(bar).color, border: cs(bar).borderTopWidth,
    icon: cs(document.querySelector('#statusConsoleToggle i')).color, text: cs(document.getElementById('activeFileStatus')).color,
    topMenu: cs(document.querySelector('.top-menu')).backgroundColor,
    varBg: root.style.getPropertyValue('--status-bar-bg'), varFg: root.style.getPropertyValue('--status-bar-fg'),
  }; }); };
const set = (page, settings) => page.evaluate((s) => { for (const k in s) window.saveSetting(k, s[k]); }, settings);

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  console.log('\n[1] Nothing chosen: the bar is exactly what each theme and pack draws');
  let { page, errors } = await newPage(browser);
  await page.goto(URL); await ready(page);
  const base = {};
  for (const colorTheme of THEMES) { await set(page, { themePack: 'None', colorTheme }); base[colorTheme] = await measure(page); }
  for (const themePack of PACKS) { await set(page, { themePack }); base[themePack] = await measure(page); }
  await set(page, { themePack: 'None', colorTheme: 'CodeMini Light' });
  ok(base['CodeMini Light'].bg === 'rgb(245, 245, 245)' && base['CodeMini Light'].fg === 'rgb(51, 51, 51)', 'Light: the panel gray with the main text color', base['CodeMini Light']);
  ok(Object.values(base).every(m => m.varBg === '' && m.varFg === ''), 'no variable is set anywhere');
  ok(new Set(Object.values(base).map(m => m.bg)).size >= 4, 'the themes and packs really do draw different bars (so the comparisons below mean something)', Object.values(base).map(m => m.bg));
  ok(base['CodeMini Dark'].border.startsWith('1px'), 'Dark keeps its top border', base['CodeMini Dark'].border);

  console.log('\n[2] Chosen colors reach the bar on all four Color Themes');
  for (const colorTheme of THEMES) {
    await set(page, { colorTheme, statusBarBackground: BG, statusBarForeground: FG });
    const m = await measure(page);
    ok(m.bg === rgb(BG), `${colorTheme}: background`, m.bg);
    ok(m.fg === rgb(FG) && m.text === rgb(FG), `${colorTheme}: text`, [m.fg, m.text]);
    ok(m.icon === rgb(FG), `${colorTheme}: icons (same color as the text)`, m.icon);
    ok(m.topMenu === base[colorTheme].topMenu, `${colorTheme}: the rest of the UI is untouched`, [m.topMenu, base[colorTheme].topMenu]);
    ok(m.border === base[colorTheme].border, `${colorTheme}: the bar's border is untouched`, [m.border, base[colorTheme].border]);
  }

  console.log('\n[3] A Theme Pack keeps its own bar, and the choice comes back after it');
  await set(page, { colorTheme: 'CodeMini Light', statusBarBackground: BG, statusBarForeground: FG });
  for (const themePack of PACKS) {
    await set(page, { themePack });
    const m = await measure(page);
    ok(m.bg === base[themePack].bg && m.fg === base[themePack].fg && m.icon === base[themePack].icon && m.text === base[themePack].text, `${themePack}: background, text and icons are the pack's own`, [m, base[themePack]]);
    ok(m.varBg === '' && m.varFg === '', `${themePack}: no variable is set`);
    ok(await page.evaluate(() => [localStorage.getItem('codemini_statusBarBackground'), localStorage.getItem('codemini_statusBarForeground')].join()) === `${BG},${FG}`, `${themePack}: the choice is still stored`);
  }
  await set(page, { themePack: 'None' });
  let m = await measure(page);
  ok(m.bg === rgb(BG) && m.fg === rgb(FG), 'pack off: the chosen colors are back');

  console.log('\n[4] Only a background: the text and icons stay readable by themselves');
  await set(page, { statusBarBackground: '#101820', statusBarForeground: '' });
  m = await measure(page);
  ok(m.bg === rgb('#101820') && m.fg === 'rgb(255, 255, 255)' && m.icon === 'rgb(255, 255, 255)', 'dark background: white text and icons', m);
  await set(page, { statusBarBackground: '#fafafa' });
  m = await measure(page);
  ok(m.fg === 'rgb(0, 0, 0)' && m.icon === 'rgb(0, 0, 0)', 'light background: black text and icons', m);
  await set(page, { statusBarBackground: '', statusBarForeground: '#00ff88' });
  m = await measure(page);
  ok(m.bg === base['CodeMini Light'].bg && m.fg === rgb('#00ff88'), 'only a text color: the theme background stays', m);

  console.log('\n[5] Reset and bad values');
  await set(page, { statusBarBackground: BG, statusBarForeground: FG });
  await set(page, { statusBarBackground: '', statusBarForeground: '' });
  m = await measure(page);
  ok(m.bg === base['CodeMini Light'].bg && m.fg === base['CodeMini Light'].fg && m.icon === base['CodeMini Light'].icon && m.varBg === '', 'both empty: exactly the theme again', m);
  await set(page, { statusBarBackground: 'red;}body{display:none', statusBarForeground: 'url(x)' });
  m = await measure(page);
  ok(m.bg === base['CodeMini Light'].bg && m.varBg === '' && m.varFg === '', 'a value that is not #rgb / #rrggbb is not applied');
  ok(await page.evaluate(() => [window.appSettings.statusBarBackground, window.appSettings.statusBarForeground].join('|')) === '|', 'and is stored as empty');
  ok(await page.evaluate(() => getComputedStyle(document.body).display) !== 'none', 'the page was not changed by it');
  await set(page, { statusBarBackground: '#ABC' });
  ok(await page.evaluate(() => window.appSettings.statusBarBackground) === '#aabbcc', '#ABC is stored as #aabbcc');
  await set(page, { statusBarBackground: '', statusBarForeground: '' });
  ok(errors.filter(e => !NOISE.test(e)).length === 0, 'no page errors', errors);
  await page.context().close();

  console.log('\n[6] The Settings screen');
  ({ page, errors } = await newPage(browser));
  await page.goto(URL); await ready(page);
  await page.evaluate(() => window.openSettingsTab('theme'));
  await page.waitForSelector('#statusBarBackgroundInput', { state: 'visible', timeout: 8000 });
  const ui = () => page.evaluate(() => ({
    bgVal: document.getElementById('statusBarBackgroundInput').value, fgVal: document.getElementById('statusBarForegroundInput').value,
    bgDis: document.getElementById('statusBarBackgroundInput').disabled, fgDis: document.getElementById('statusBarForegroundInput').disabled,
    resetDis: document.getElementById('btnResetStatusBarColors').disabled, hint: document.getElementById('statusBarColorsHint').textContent,
    stored: [localStorage.getItem('codemini_statusBarBackground'), localStorage.getItem('codemini_statusBarForeground')].join('|'),
  }));
  const hexOf = (c) => '#' + c.match(/\d+/g).slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('');
  let u = await ui(); m = await measure(page);
  ok(u.bgVal === hexOf(m.bg) && u.fgVal === hexOf(m.fg), 'unchosen: the swatches show the colors the bar has now', [u, m]);
  ok(u.resetDis === true && !u.bgDis && !u.fgDis, 'Reset is disabled while nothing is chosen');
  await page.fill('#statusBarBackgroundInput', '#223344');
  m = await measure(page); u = await ui();
  ok(m.bg === rgb('#223344'), 'picking a background changes the bar at once', m.bg);
  ok(m.fg === 'rgb(255, 255, 255)', 'and the text follows it', m.fg);
  ok(u.stored === '#223344|', 'only the background is stored', u.stored);
  ok(u.fgVal === '#ffffff', 'the text swatch shows the color now in use', u.fgVal);
  ok(u.resetDis === false, 'Reset is enabled once something is chosen');
  await page.fill('#statusBarForegroundInput', '#ffcc00');
  m = await measure(page);
  ok(m.fg === rgb('#ffcc00') && m.icon === rgb('#ffcc00') && m.text === rgb('#ffcc00'), 'picking the text color changes the text and the icons', m);
  await page.selectOption('#colorThemeSelect', 'CodeMini Dark +');
  m = await measure(page); u = await ui();
  ok(m.bg === rgb('#223344') && m.fg === rgb('#ffcc00'), 'the choice survives a Color Theme change');
  await page.selectOption('#themePackSelect', 'CodeMini Premium');
  m = await measure(page); u = await ui();
  ok(m.varBg === '' && m.bg === base['CodeMini Premium'].bg && m.fg === base['CodeMini Premium'].fg && m.icon === base['CodeMini Premium'].icon, 'a Theme Pack: the bar is the pack\u2019s own', [m, base['CodeMini Premium']]);
  ok(u.bgDis && u.fgDis && u.resetDis, 'a Theme Pack: both swatches and Reset are locked');
  ok(/Controlled by the "CodeMini Premium" theme pack/.test(u.hint), 'and the row says why', u.hint);
  ok(u.bgVal === hexOf(m.bg), 'locked swatches show what the bar is', [u.bgVal, m.bg]);
  await page.selectOption('#themePackSelect', 'None');
  m = await measure(page); u = await ui();
  ok(m.bg === rgb('#223344') && m.fg === rgb('#ffcc00'), 'Theme Pack None: the choice is back');
  ok(!u.bgDis && !u.fgDis && !u.resetDis && u.bgVal === '#223344' && u.fgVal === '#ffcc00' && !/Controlled by/.test(u.hint), 'and the row is live again, showing the choice', u);
  await page.click('#btnResetStatusBarColors');
  m = await measure(page); u = await ui();
  const darkPlus = base['CodeMini Dark +'];
  ok(m.bg === darkPlus.bg && m.fg === darkPlus.fg && m.icon === darkPlus.icon && m.varBg === '' && m.varFg === '', 'Reset: the bar is exactly Dark + again', [m, darkPlus]);
  ok(u.stored === '|' && u.resetDis === true, 'Reset: nothing stored, button disabled again', u);
  ok(u.bgVal === hexOf(m.bg) && u.fgVal === hexOf(m.fg), 'Reset: the swatches show the theme colors again');
  await page.fill('#settingsSearchInput', 'status bar');
  ok(await page.evaluate(() => { const r = document.getElementById('btnResetStatusBarColors').closest('.settings-item'); return !r.classList.contains('search-hidden') && r.offsetParent !== null; }), 'Settings search for "status bar" finds the row');
  ok(errors.filter(e => !NOISE.test(e)).length === 0, 'no page errors', errors);
  await page.context().close();

  console.log('\n[7] The next load paints the colors from the first frame');
  ({ page, errors } = await newPage(browser, `localStorage.setItem('codemini_colorTheme','CodeMini Dark +'); localStorage.setItem('codemini_statusBarBackground','${BG}'); localStorage.setItem('codemini_statusBarForeground','${FG}');`));
  await page.goto(URL); await ready(page); await sleep(300);
  await page.reload(); await ready(page); await sleep(1500);
  const f = await page.evaluate(() => window.__f);
  const withBar = f.filter(x => x.hasBar);
  ok(withBar.length > 5 && withBar.every(x => x.varBg === BG), 'the variable is on <html> in every frame the bar exists (no flash)', withBar.slice(0, 3));
  ok(withBar.every(x => x.bg === rgb(BG)), 'and the bar is the chosen color in every one of those frames', [...new Set(withBar.map(x => x.bg))]);
  const cache = await page.evaluate(() => JSON.parse(localStorage.getItem('codemini_theme_cache')));
  const entry = cache[Object.keys(cache)[0]];
  ok(entry.vars['--status-bar-bg'] === BG && entry.vars['--status-bar-fg'] === FG, 'the theme cache remembers both variables', entry);
  m = await measure(page);
  ok(m.bg === rgb(BG) && m.fg === rgb(FG), 'and after load it is still the chosen colors');
  await set(page, { themePack: 'CodeMini Premium' });
  const cache2 = await page.evaluate(() => JSON.parse(localStorage.getItem('codemini_theme_cache')));
  const e2 = cache2[Object.keys(cache2)[0]];
  ok(!('--status-bar-bg' in e2.vars) && !('--status-bar-fg' in e2.vars), 'under a Theme Pack the cache holds neither, so a pack never flashes custom colors');
  ok(errors.filter(e => !NOISE.test(e)).length === 0, 'no page errors', errors);
  await page.context().close();

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
