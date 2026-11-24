// Today in the Now Island (UI/UX specs, feature 12) in a real browser, with a CONTROLLED CLOCK (Playwright's page.clock): the minute tick, seconds,
// the midnight rollover, a closed island that stops ticking, 12 and 24 hour clocks and other locales are all checked by moving time, not by waiting.
// The quote a given day must show is worked out here from the same module and quotes file, so "the same quote every open" is a real check.
const { chromium } = require('playwright');
const T = require('../../js/core/today.js');
const Q = require('../../js/data/quotes.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const APP = 'http://localhost:8765';
const expected = (y, m, d, set) => T.pickDaily((set === 'Motivational' ? Q.motivational : Q.developer), new Date(y, m, d, 12));

async function open(browser, o) {
  o = o || {};
  const ctx = await browser.newContext(Object.assign({ locale: o.locale || 'en-GB', timezoneId: 'Europe/London', serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] },
    o.phone ? { viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 900 } }));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (location.port === '8765') localStorage.setItem('codemini_runner', 'off');
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); }; window.require.config = () => {};
  });
  await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  await page.clock.install({ time: new Date('2026-10-31T20:00:00Z') });   // the clock only moves forward: start earlier, then move to the time under test
  await page.goto(APP + '/index.html'); await sleep(3500);
  await page.clock.pauseAt(new Date('2026-11-01T09:05:30Z'));
  return { ctx, page, errors };
}
const TIME = '.today-time span:first-child';   // the digits; .today-time also holds the AM/PM
const txt = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
const shown = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && getComputedStyle(e).display !== 'none'; }, sel);
const openIsland = (page) => page.evaluate(() => CodeMiniNowIsland.open({ tab: 'now' }));
const closeIsland = (page) => page.evaluate(() => { document.getElementById('nowIslandClose').click(); });
const setting = (page, k, v) => page.evaluate(([key, val]) => window.saveSetting(key, val), [k, v]);
const quote = (page) => page.evaluate(() => { const t = document.querySelector('.today-quote-text').textContent; return t.replace(/^\u201c|\u201d$/g, ''); });
const attr = (page) => txt(page, '.today-attr');
const clickIn = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel);

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // ====================================================================== desktop, en-GB (24-hour), Sunday 1 November 2026, 09:05:30
  console.log('\n[desktop, en-GB]');
  let { ctx, page, errors } = await open(browser);
  ok(await page.evaluate(() => !!window.CodeMiniToday && !!window.CODEMINI_QUOTES), 'the module and the quotes are there');
  await openIsland(page); await page.clock.runFor(200);
  ok(await shown(page, '.today-sec'), 'the TODAY section is in the Now pane');
  ok(await page.evaluate(() => { const t = document.querySelector('.today-sec'), o = document.querySelector('.off-sec'), r = document.querySelector('.ni-sec-running'), f = document.querySelector('.ni-sec-finished'); const fol = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); return fol(r, t) && fol(t, o) && fol(o, f); }), 'between RUNNING and OFFLINE AND PACKAGES');
  ok(/TODAY/.test(await txt(page, '.today-sec .sb-section-header')), 'titled TODAY, in the shared section-header style');
  ok(await txt(page, TIME) === '09:05', 'the time follows a 24-hour locale', await txt(page, TIME));
  ok(await txt(page, '.today-day') === 'Sunday' && await txt(page, '.today-date') === '1 November 2026', 'the day over the date, in the locale', [await txt(page, '.today-day'), await txt(page, '.today-date')]);
  const look = await page.evaluate(() => { const g = (s) => getComputedStyle(document.querySelector(s)), r = (s) => document.querySelector(s).getBoundingClientRect(); return {
    time: [g('.today-time').fontSize, g('.today-time').fontWeight, g('.today-time').fontVariantNumeric], day: [g('.today-day').fontSize, g('.today-day').fontWeight], date: [g('.today-date').fontSize, g('.today-date').color === g('.today-day').color],
    right: r('.today-dates').left > r('.today-time').right - 1, stacked: r('.today-date').top > r('.today-day').top, below: r('.today-quote').top > r('.today-clock').bottom - 1,
    base: Math.abs(r('.today-date').bottom - r('.today-time').bottom) < 8 }; });
  ok(look.time[0] === '28px' && look.time[1] === '600' && /tabular-nums/.test(look.time[2]), 'time: 28px, 600, tabular numbers', look.time);
  ok(look.day.join() === '13px,600' && look.date[0] === '11px' && look.date[1] === false, 'day 13px/600, date 11px and muted', look);
  ok(look.right && look.stacked && look.below && look.base, 'day and date stacked to the right of the time, sitting on its baseline, the quote below', look);
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.today-sec')).borderBottomStyle === 'dashed' && !document.querySelector('.today-sec').style.background), 'no box and no bar: flat text with a dashed divider at the end');
  ok(await page.evaluate(() => document.querySelector('.ni-empty').hidden), '"Nothing is running" is gone: the pane always has Today in it');

  // the quote: the one the date calls for, every time
  const q1 = expected(2026, 10, 1);
  ok(await quote(page) === q1.t, 'the quote is the one 1 November 2026 calls for (worked out from the same rules)', [await quote(page), q1.t]);
  ok(await attr(page) === '\u2014 ' + T.attribution(q1), 'with its attribution on its own line', await attr(page));
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.today-quote-text')).fontStyle === 'italic' && getComputedStyle(document.querySelector('.today-quote-text')).fontSize === '12px'), '12px italic plain text');
  await closeIsland(page); await page.clock.runFor(100); await openIsland(page); await page.clock.runFor(100);
  ok(await quote(page) === q1.t, 'the same quote after closing and opening the island');
  ok(await page.evaluate(() => { const o = getComputedStyle(document.querySelector('.today-tools')).opacity; return o === '0'; }), 'the three icons are hidden until you hover');
  await page.hover('.today-quote-text'); await page.clock.runFor(400); await sleep(400);   // the icons fade in over real time
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.today-tools')).opacity === '1' && document.querySelectorAll('.today-tools .ni-icon-btn').length === 3), 'and the three icons (shuffle, copy, favourite) appear on hover');
  ok(await page.evaluate(() => [...document.querySelectorAll('.today-tools .ni-icon-btn i')].map((i) => i.className).join() === 'ri-shuffle-line,ri-file-copy-line,ri-heart-line'), 'bare 14px icons, in that order');

  // time moves: the minute tick, and nothing in between
  await page.clock.runFor(10000);
  ok(await txt(page, TIME) === '09:05', 'no change within the minute (it is not ticking every second)');
  await page.clock.runFor(21000);
  ok(await txt(page, TIME) === '09:06', 'it ticks over at the minute', await txt(page, TIME));
  await setting(page, 'todayShowSeconds', true); await page.clock.runFor(50);
  const s1 = await txt(page, TIME); await page.clock.runFor(2000); const s2 = await txt(page, TIME);
  ok(/^\d\d:\d\d:\d\d$/.test(s1) && s1 !== s2, 'Show seconds: seconds appear and move every second', [s1, s2]);
  await setting(page, 'todayShowSeconds', false); await page.clock.runFor(50);
  ok(/^\d\d:\d\d$/.test(await txt(page, TIME)), 'and turn off again');

  // a closed island does not tick
  await closeIsland(page); await page.clock.runFor(61000);
  ok(await page.evaluate(() => CodeMiniToday.state().ticking === false), 'a closed island has no timer running');
  await page.clock.runFor(5 * 60000);
  await openIsland(page); await page.clock.runFor(50);
  ok(await txt(page, TIME) === '09:12', 'and it is right the moment it opens again', await txt(page, TIME));
  ok(await page.evaluate(() => CodeMiniToday.state().ticking === true), 'ticking again');

  // midnight, with the island open
  await page.clock.pauseAt(new Date('2026-11-01T23:58:30Z')); await page.clock.runFor(200);
  ok(await txt(page, '.today-date') === '1 November 2026', 'late on the 1st');
  await page.clock.runFor(2 * 60000);
  const q2 = expected(2026, 10, 2);
  ok(await txt(page, '.today-date') === '2 November 2026' && await txt(page, '.today-day') === 'Monday', 'it turns over at midnight while open: Monday 2 November', [await txt(page, '.today-day'), await txt(page, '.today-date')]);
  ok(await quote(page) === q2.t && q2.t !== q1.t, 'and the quote changes with the day', [await quote(page), q2.t]);
  ok(await txt(page, TIME) === '00:00', 'at 00:00', await txt(page, TIME));

  // Shuffle, Copy, Favourite
  await page.hover('.today-quote-text');
  const before = await quote(page);
  await clickIn(page, '.today-tools .ni-icon-btn:nth-child(1)'); await page.clock.runFor(50);
  const shuffled = await quote(page);
  ok(shuffled !== before && Q.developer.some((x) => x.t === shuffled), 'Shuffle gives another quote from the set', [before, shuffled]);
  await page.clock.runFor(61000);
  ok(await quote(page) === shuffled, 'and it stays through the minute tick');
  await page.evaluate(() => { window.__copied = null; });
  await clickIn(page, '.today-tools .ni-icon-btn:nth-child(2)'); await page.clock.runFor(100);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const cur = Q.developer.find((x) => x.t === shuffled);
  ok(clip === T.copyText(cur), 'Copy puts "\u201cquote\u201d \u2014 author" on the clipboard', clip);
  ok(await page.evaluate(() => document.querySelectorAll('.today-tools .ni-icon-btn')[2].getAttribute('aria-pressed') === 'false'), 'the heart is not filled');
  await clickIn(page, '.today-tools .ni-icon-btn:nth-child(3)'); await page.clock.runFor(50);
  ok(await page.evaluate(() => { const b = document.querySelectorAll('.today-tools .ni-icon-btn')[2]; return b.getAttribute('aria-pressed') === 'true' && b.firstChild.className === 'ri-heart-fill'; }), 'Favourite fills the heart');
  ok(await page.evaluate((t) => JSON.parse(localStorage.getItem('codemini_quote_favorites')).some((q) => q.t === t), shuffled), 'and keeps the quote, so it survives a reload');
  await page.clock.pauseAt(new Date('2026-11-02T10:00:00Z')); await page.clock.runFor(200);
  await page.evaluate(() => CodeMiniToday.refresh()); await page.clock.runFor(50);

  // Quote sets, Mine, the fallback
  await setting(page, 'todayQuoteSet', 'Motivational'); await page.clock.runFor(50);
  ok(await quote(page) === T.pickDaily(Q.motivational, new Date(2026, 10, 2, 12)).t, 'Quote set: Motivational shows that day\'s Motivational quote', await quote(page));
  await setting(page, 'todayQuoteSet', 'Mine'); await page.clock.runFor(50);
  ok(await quote(page) === shuffled, 'Mine: with only one favourite, that is the quote', await quote(page));
  await clickIn(page, '.today-tools .ni-icon-btn:nth-child(3)'); await page.clock.runFor(50);
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('codemini_quote_favorites')).length === 0), 'clicking the filled heart removes the favourite');
  await page.evaluate(() => CodeMiniToday.settingsChanged()); await page.clock.runFor(50);
  ok(await shown(page, '.today-note') && /Nothing in Mine yet/.test(await txt(page, '.today-note')) && await quote(page) === T.pickDaily(Q.developer, new Date(2026, 10, 2, 12)).t, 'Mine with nothing in it says so and shows Developer\'s quote for the day', await txt(page, '.today-note'));
  await setting(page, 'todayMyQuotes', 'Stay curious. - Me\n\u201cShip it\u201d \u2014 A. Friend'); await page.clock.runFor(50);
  ok(!(await shown(page, '.today-note')) && ['Stay curious.', 'Ship it'].includes(await quote(page)), 'lines you type fill Mine', await quote(page));
  ok(['\u2014 Me', '\u2014 A. Friend'].includes(await attr(page)), 'with their authors', await attr(page));
  // a long quote: three lines, then all of it on click
  await setting(page, 'todayMyQuotes', 'x '.repeat(200) + 'end - Long One'); await page.clock.runFor(50);
  const lh = await page.evaluate(() => { const e = document.querySelector('.today-quote-text'), cs = getComputedStyle(e); return { clamp: cs.webkitLineClamp, h: e.getBoundingClientRect().height, line: parseFloat(cs.lineHeight) }; });
  ok(lh.clamp === '3' && lh.h <= lh.line * 3 + 1, 'a long quote is held to three lines', lh);
  await clickIn(page, '.today-quote-text'); await page.clock.runFor(50);
  ok(await page.evaluate((line) => document.querySelector('.today-quote-text').getBoundingClientRect().height > line * 3 && document.querySelector('.today-quote-text').getAttribute('aria-expanded') === 'true', lh.line), 'clicking it shows all of it');
  await setting(page, 'todayQuoteSet', 'Developer'); await page.clock.runFor(50);

  // Daily quote: Each open, Off
  await setting(page, 'todayQuote', 'Each open'); await page.clock.runFor(50);
  const seen = [];
  for (let i = 0; i < 8; i++) { await closeIsland(page); await page.clock.runFor(50); await openIsland(page); await page.clock.runFor(60); seen.push(await quote(page)); }
  ok(seen.every((q, i) => i === 0 || q !== seen[i - 1]) && new Set(seen).size > 2, 'Each open: a new quote every time the island opens, never the same twice in a row', seen);
  await setting(page, 'todayQuote', 'Off'); await page.clock.runFor(50);
  ok(!(await shown(page, '.today-quote')) && await txt(page, TIME) !== null && await shown(page, '.today-clock'), 'Off: the quote goes, the clock and date stay');
  await setting(page, 'todayQuote', 'Daily'); await page.clock.runFor(50);
  ok(await shown(page, '.today-quote') && await quote(page) === T.pickDaily(Q.developer, new Date(2026, 10, 2, 12)).t, 'Daily brings back the day\'s quote', await quote(page));

  // 24-hour clock setting
  await page.clock.pauseAt(new Date('2026-11-02T21:05:00Z')); await page.clock.runFor(100);
  ok(await txt(page, TIME) === '21:05' && await txt(page, '.today-period') === '', 'Auto in en-GB: 21:05');
  await setting(page, 'todayClock24', 'Off'); await page.clock.runFor(50);
  ok(await txt(page, TIME) === '9:05' && /pm/i.test(await txt(page, '.today-period')), '12-hour forced: 9:05 pm', [await txt(page, TIME), await txt(page, '.today-period')]);
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.today-period')).fontSize === '13px'), 'the pm is smaller than the time');
  await setting(page, 'todayClock24', 'Auto');

  // collapse
  await clickIn(page, '.today-toggle'); await page.clock.runFor(50);
  ok(!(await shown(page, '.today-body')) && await page.evaluate(() => localStorage.getItem('codemini_today_collapsed') === '1'), 'the header collapses it, and remembers');
  await page.clock.runFor(61000);
  ok(await page.evaluate(() => CodeMiniToday.state().ticking === false), 'a collapsed section does not tick');
  await clickIn(page, '.today-toggle'); await page.clock.runFor(100);
  ok(await shown(page, '.today-body') && /\d:\d\d/.test(await txt(page, TIME)), 'and comes back');

  // Settings > General: the real rows, and a change applies at once
  await page.evaluate(() => document.getElementById('settingsIconItem').click()); await page.clock.runFor(1500);
  const rows = await page.evaluate(() => ['todayQuote', 'todayQuoteSet', 'todayMyQuotes', 'todayShowSeconds', 'todayClock24'].map((k) => { const e = document.querySelector('[data-setting="' + k + '"]'); return e ? e.tagName.toLowerCase() + (e.type ? ':' + e.type : '') : null; }));
  ok(rows.join() === 'select:select-one,select:select-one,textarea:textarea,input:checkbox,select:select-one', 'Settings has the five rows: Daily quote, Quote set, My quotes, Show seconds, 24-hour clock', rows);
  ok(await page.evaluate(() => [...document.querySelectorAll('[data-setting="todayQuote"] option')].map((o) => o.textContent).join() === 'Daily,Each open,Off' && [...document.querySelectorAll('[data-setting="todayQuoteSet"] option')].map((o) => o.textContent).join() === 'Developer,Motivational,Mine'), 'with the spec\'s choices');
  ok(await page.evaluate(() => { const h = [...document.querySelectorAll('.settings-category-title')].map((e) => e.textContent); return h.includes('Today (Now Island)'); }), 'under their own heading in General');
  await page.evaluate(() => { const s = document.querySelector('[data-setting="todayQuoteSet"]'); s.value = 'Motivational'; s.dispatchEvent(new Event('change', { bubbles: true })); }); await page.clock.runFor(100);
  ok(await page.evaluate(() => window.appSettings.todayQuoteSet === 'Motivational' && localStorage.getItem(Object.keys(localStorage).find((k) => /todayQuoteSet$/.test(k))) === 'Motivational'), 'choosing a set there is saved', await page.evaluate(() => window.appSettings.todayQuoteSet));
  ok(await quote(page) === T.pickDaily(Q.motivational, new Date(2026, 10, 2, 12)).t, 'and the section follows it at once (the island is open behind Settings)', await quote(page));
  await page.evaluate(() => { const t = document.querySelector('[data-setting="todayMyQuotes"]'); t.value = 'Typed in settings - Tester'; t.dispatchEvent(new Event('change', { bubbles: true })); const s = document.querySelector('[data-setting="todayQuoteSet"]'); s.value = 'Mine'; s.dispatchEvent(new Event('change', { bubbles: true })); }); await page.clock.runFor(100);
  ok(await page.evaluate(() => window.appSettings.todayMyQuotes === 'Typed in settings - Tester'), 'typed lines are saved (multi-line text is kept)');
  await page.evaluate(() => { document.getElementById('settingsIconItem').click(); }); await page.clock.runFor(300);
  await openIsland(page); await page.clock.runFor(200);
  ok(await quote(page) === 'Typed in settings' && await attr(page) === '\u2014 Tester', 'and the Today section shows what was typed in Settings', [await quote(page), await attr(page)]);
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();

  // ====================================================================== en-US (12-hour) and fr-FR
  console.log('\n[en-US and fr-FR]');
  ({ ctx, page, errors } = await open(browser, { locale: 'en-US' }));
  await openIsland(page); await page.clock.runFor(200);
  ok(await txt(page, TIME) === '9:05' && /AM/.test(await txt(page, '.today-period')) && await txt(page, '.today-date') === 'November 1, 2026', 'en-US follows the system: 9:05 AM, November 1, 2026', [await txt(page, TIME), await txt(page, '.today-period'), await txt(page, '.today-date')]);
  await setting(page, 'todayClock24', 'On'); await page.clock.runFor(50);
  ok(await txt(page, TIME) === '09:05' && await txt(page, '.today-period') === '', '24-hour forced: 09:05');
  await page.clock.pauseAt(new Date('2026-11-02T00:05:00Z')); await page.clock.runFor(100);
  ok(await txt(page, TIME) === '00:05', 'just after midnight it is 00:05, not 24:05', await txt(page, TIME));
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();
  ({ ctx, page, errors } = await open(browser, { locale: 'fr-FR' }));
  await openIsland(page); await page.clock.runFor(200);
  ok(await txt(page, '.today-day') === 'dimanche' && await txt(page, '.today-date') === '1 novembre 2026' && await txt(page, TIME) === '09:05', 'fr-FR: dimanche, 1 novembre 2026, 09:05', [await txt(page, '.today-day'), await txt(page, '.today-date'), await txt(page, TIME)]);
  await ctx.close();

  // ====================================================================== phone
  console.log('\n[phone]');
  ({ ctx, page, errors } = await open(browser, { phone: true }));
  await openIsland(page); await page.clock.runFor(300);
  ok(await page.evaluate(() => matchMedia('(hover: none)').matches), 'a touch screen (no hover)');
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.today-tools')).opacity === '1'), 'the three icons are always shown on touch');
  const ph = await page.evaluate(() => { const e = document.querySelector('.today-quote-text'), cs = getComputedStyle(e); return { clamp: cs.webkitLineClamp, time: getComputedStyle(document.querySelector('.today-time')).fontSize, p: document.getElementById('nowIslandPanel').getBoundingClientRect() }; });
  ok(ph.clamp === '2' && ph.time === '28px', 'two lines of quote on a phone, the time still 28px', ph);
  ok(ph.p.left >= 54 && ph.p.right <= 390 - 9 && ph.p.height <= 800 * 0.6 + 2, 'the island keeps its phone place and stays within 60% of the screen', ph.p);
  ok(await page.evaluate(() => { const b = document.querySelector('#nowIslandPanel .ni-pane.active'); return b.scrollWidth <= b.clientWidth + 1; }), 'nothing overflows sideways');
  ok(await page.evaluate(() => { const t = document.querySelector('.today-sec').getBoundingClientRect(), p = document.querySelector('#nowIslandPanel .ni-pane.active').getBoundingClientRect(); return t.top >= p.top - 1 && t.bottom <= p.bottom + 1; }), 'Today is whole on the first screen of the pane');
  ok(await page.evaluate(() => { const b = document.querySelector('#nowIslandPanel .ni-pane.active'); b.scrollTop = b.scrollHeight; return b.scrollHeight >= b.clientHeight; }), 'the pane scrolls when Today and Offline are taller than the island');
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('Crashed:', e); process.exit(2); });
