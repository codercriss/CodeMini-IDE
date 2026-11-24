// Today's pure rules (js/core/today.js), the quotes file (js/data/quotes.js), and how they are wired in. The browser half (the section, the timer,
// the icons) is covered in a real browser by tests/e2e/today.e2e.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('../js/core/today.js');
const Q = require('../js/data/quotes.js');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

console.log('which quote today');
t('the day is the person\'s own calendar date: it turns over at their midnight, not at UTC', () => {
  const a = new Date(2026, 10, 1, 0, 0, 1), b = new Date(2026, 10, 1, 23, 59, 59), c = new Date(2026, 10, 2, 0, 0, 0);
  assert.strictEqual(T.dayNumber(a), T.dayNumber(b));
  assert.strictEqual(T.dayNumber(c) - T.dayNumber(a), 1);
  assert.strictEqual(T.dayNumber(new Date(2026, 2, 29, 12)) - T.dayNumber(new Date(2026, 2, 28, 12)), 1, 'across a clock change, one day is one day');
  assert.strictEqual(T.dayKey(new Date(2026, 0, 5)), '2026-01-05');
});
t('every quote once per cycle, never the same one two days running, for any size of set', () => {
  for (const size of [3, 4, 5, 7, 15, 18, 33, 100]) {
    const seen = [];
    for (let day = 20000; day < 20000 + size * 40; day++) seen.push(T.dailyIndex(size, day));
    seen.forEach((i, k) => { assert.ok(i >= 0 && i < size); if (k) assert.notStrictEqual(i, seen[k - 1], 'size ' + size + ' day ' + k); });
    for (let cycle = 0; cycle < 6; cycle++) {
      const start = Math.ceil(20000 / size) * size + cycle * size, set = new Set();
      for (let d = start; d < start + size; d++) set.add(T.dailyIndex(size, d));
      assert.strictEqual(set.size, size, 'size ' + size + ' cycle ' + cycle + ' shows every quote once');
    }
  }
});
t('it depends on the date alone: the same day gives the same quote, every time and in every window', () => {
  const pool = Q.developer;
  const a = T.pickDaily(pool, new Date(2026, 10, 1, 8)), b = T.pickDaily(pool, new Date(2026, 10, 1, 22, 30));
  assert.strictEqual(a, b);
  assert.notStrictEqual(T.pickDaily(pool, new Date(2026, 10, 2, 8)), a);
  const days = new Set(); for (let d = 0; d < 36; d++) days.add(T.pickDaily(pool, new Date(2026, 10, 1 + d)).t);
  assert.strictEqual(days.size, pool.length, 'two cycles of 18 days show all 18');
});
t('small and odd sizes behave', () => {
  assert.strictEqual(T.dailyIndex(0, 5), -1); assert.strictEqual(T.dailyIndex(1, 123), 0);
  assert.deepStrictEqual([T.dailyIndex(2, 10), T.dailyIndex(2, 11), T.dailyIndex(2, 12), T.dailyIndex(2, -1)], [0, 1, 0, 1], 'two quotes alternate');
  assert.ok(T.dailyIndex(5, -3) >= 0 && T.dailyIndex(5, -3) < 5, 'a day before 1970 is still valid');
  assert.strictEqual(T.pickDaily([], new Date()), null);
});
t('Shuffle and Each open: another quote than the one shown, when there is another', () => {
  const pool = [{ t: 'a' }, { t: 'b' }, { t: 'c' }];
  for (let i = 0; i < 60; i++) assert.notStrictEqual(T.pickRandom(pool, 'b').t, 'b');
  assert.strictEqual(T.pickRandom([{ t: 'only' }], 'only').t, 'only', 'a pool of one has nothing else to give');
  assert.strictEqual(T.pickRandom([], 'x'), null);
  assert.strictEqual(T.pickRandom(pool, 'a', () => 0).t, 'b'); assert.strictEqual(T.pickRandom(pool, 'a', () => 0.9999).t, 'c', 'the last one is reachable');
});

console.log('the quotes you add, favourites, and the Mine set');
t('lines: text, "text — author", "text | author", "text - author"; quote marks dropped; empty lines and over-long ones handled', () => {
  const got = T.parseCustom('Stay curious.\n\n\u201cKeep going\u201d \u2014 A. Friend\nShip it | Me Too\nA hyphen-ated line - Pat\r\nNo author here\n  \n"Quoted" \u2013 Someone');
  assert.deepStrictEqual(got, [
    { t: 'Stay curious.', a: 'Me' }, { t: 'Keep going', a: 'A. Friend' }, { t: 'Ship it', a: 'Me Too' },
    { t: 'A hyphen-ated line', a: 'Pat' }, { t: 'No author here', a: 'Me' }, { t: 'Quoted', a: 'Someone' }]);
  assert.strictEqual(T.parseCustom('x'.repeat(900) + ' - ' + 'y'.repeat(200))[0].t.length, 400);
  assert.strictEqual(T.parseCustom('x - ' + 'y'.repeat(200))[0].a.length, 60);
  assert.strictEqual(T.parseCustom(Array.from({ length: 500 }, (_, i) => 'q' + i).join('\n')).length, T.MAX_CUSTOM);
  assert.deepStrictEqual(T.parseCustom(''), []); assert.deepStrictEqual(T.parseCustom(null), []); assert.deepStrictEqual(T.parseCustom('"" - nobody'), []);
});
t('favourites toggle on and off, by text, and are capped', () => {
  const q = { t: 'Done and imperfect beats perfect and unfinished.', a: 'CodeMini' };
  let favs = T.toggleFav([], q);
  assert.deepStrictEqual(favs, [{ t: q.t, a: 'CodeMini', s: '' }]); assert.ok(T.hasQuote(favs, q));
  assert.deepStrictEqual(T.toggleFav(favs, q), []);
  assert.deepStrictEqual(T.toggleFav([], null), []);
  let many = []; for (let i = 0; i < 260; i++) many = T.toggleFav(many, { t: 'q' + i, a: 'x' });
  assert.strictEqual(many.length, 200); assert.strictEqual(many[199].t, 'q259', 'the newest are kept');
});
t('the pools: Developer, Motivational, and Mine (typed lines + favourites, no duplicates) that falls back to Developer when empty', () => {
  assert.strictEqual(T.quotePool('Developer', Q, [], []).quotes.length, Q.developer.length);
  assert.strictEqual(T.quotePool('Motivational', Q, [], []).quotes.length, Q.motivational.length);
  const mine = T.quotePool('Mine', Q, [{ t: 'One', a: 'Me' }, { t: 'two', a: 'Me' }], [{ t: 'ONE', a: 'x' }, { t: 'Three', a: 'y' }]);
  assert.deepStrictEqual(mine.quotes.map((x) => x.t), ['One', 'two', 'Three']); assert.strictEqual(mine.fellBack, false);
  const empty = T.quotePool('Mine', Q, [], []);
  assert.deepStrictEqual([empty.fellBack, empty.quotes.length], [true, Q.developer.length]);
  assert.strictEqual(T.quotePool('nonsense', Q, [], []).quotes.length, Q.developer.length, 'an unknown set is Developer');
  assert.strictEqual(T.pick(T.SETS, 'Mine', 'Developer'), 'Mine'); assert.strictEqual(T.pick(T.SETS, 'x', 'Developer'), 'Developer');
});
t('attribution and what Copy puts on the clipboard', () => {
  assert.strictEqual(T.attribution({ t: 'x', a: 'Ada Lovelace', s: 'Notes, 1843' }), 'Ada Lovelace, Notes, 1843');
  assert.strictEqual(T.attribution({ t: 'x', a: 'CodeMini' }), 'CodeMini');
  assert.strictEqual(T.copyText({ t: 'Be kind.', a: 'CodeMini' }), '\u201cBe kind.\u201d \u2014 CodeMini');
  assert.strictEqual(T.copyText(null), '');
});

console.log('the clock and the date');
t('the clock follows the system by default, and 24-hour or 12-hour can be forced', () => {
  const d = new Date(2026, 10, 1, 21, 5, 9);
  assert.deepStrictEqual(T.timeParts(d, { locale: 'en-US' }), { text: '9:05', period: 'PM' }, 'a 12-hour locale: the AM/PM is separate (it is drawn smaller)');
  assert.deepStrictEqual(T.timeParts(d, { locale: 'en-GB' }), { text: '21:05', period: '' }, 'a 24-hour locale');
  assert.deepStrictEqual(T.timeParts(d, { locale: 'en-US', clock: 'On' }), { text: '21:05', period: '' });
  assert.strictEqual(T.timeParts(d, { locale: 'en-GB', clock: 'Off' }).text, '9:05'); assert.ok(/^pm$/i.test(T.timeParts(d, { locale: 'en-GB', clock: 'Off' }).period));
  assert.strictEqual(T.timeParts(new Date(2026, 10, 1, 0, 5), { locale: 'en-US', clock: 'On' }).text, '00:05', 'just after midnight is 00:05, never 24:05');
  assert.strictEqual(T.timeParts(new Date(2026, 10, 1, 0, 5), { locale: 'en-US', clock: 'Off' }).text, '12:05');
  const morning = new Date(2026, 10, 1, 9, 5, 0);
  assert.strictEqual(T.timeParts(morning, { locale: 'en-GB' }).text, '09:05', 'a 24-hour clock has two-digit hours');
  assert.strictEqual(T.timeParts(morning, { locale: 'fr-FR' }).text, '09:05');
  assert.strictEqual(T.timeParts(morning, { locale: 'en-US', clock: 'On' }).text, '09:05');
  assert.strictEqual(T.timeParts(new Date(2026, 10, 1, 0, 0, 0), { locale: 'en-GB' }).text, '00:00', 'midnight is 00:00, not 0:00');
  assert.strictEqual(T.timeParts(morning, { locale: 'en-US' }).text, '9:05', 'a 12-hour clock does not');
  assert.strictEqual(T.timeParts(morning, { locale: 'en-GB', seconds: true }).text, '09:05:00');
});
t('seconds only when asked for', () => {
  const d = new Date(2026, 10, 1, 21, 5, 9);
  assert.strictEqual(T.timeParts(d, { locale: 'en-GB' }).text, '21:05');
  assert.strictEqual(T.timeParts(d, { locale: 'en-GB', seconds: true }).text, '21:05:09');
});
t('the day and the date, in the person\'s own locale', () => {
  const d = new Date(2026, 10, 1);
  assert.deepStrictEqual(T.dateLabels(d, 'en-GB'), { weekday: 'Sunday', date: '1 November 2026' });
  assert.deepStrictEqual(T.dateLabels(d, 'en-US'), { weekday: 'Sunday', date: 'November 1, 2026' });
  assert.strictEqual(T.dateLabels(d, 'fr-FR').weekday, 'dimanche');
});
t('it wakes at the next minute (or second), a few ms late and never early', () => {
  assert.strictEqual(T.msToNextTick(new Date(2026, 10, 1, 9, 5, 0, 0), false), 60020);
  assert.strictEqual(T.msToNextTick(new Date(2026, 10, 1, 9, 5, 59, 900), false), 120);
  assert.strictEqual(T.msToNextTick(new Date(2026, 10, 1, 9, 5, 30, 250), true), 770);
  for (let s = 0; s < 60; s += 7) for (const ms of [0, 1, 500, 999]) { const w = T.msToNextTick(new Date(2026, 10, 1, 9, 5, s, ms), false); assert.ok(w > 0 && w <= 60020); }
});

console.log('the quotes file');
t('every entry has a text and an author; a historical line has a source, an original one does not', () => {
  assert.ok(Q.developer.length >= 15 && Q.motivational.length >= 12);
  [].concat(Q.developer, Q.motivational).forEach((q) => {
    assert.ok(typeof q.t === 'string' && q.t.length >= 10 && q.t.length <= 200, 'text: ' + q.t);
    assert.ok(typeof q.a === 'string' && q.a.length > 0, 'author: ' + q.t);
    if (q.a === 'CodeMini') assert.ok(!q.s, 'an original line has no source: ' + q.t); else assert.ok(q.s && /\d{4}/.test(q.s), 'a historical line names its work and year: ' + q.a);
    assert.ok(!/^["\u201c]|["\u201d]$/.test(q.t), 'no quote marks inside the text (they are drawn)');
  });
});
t('no duplicates, and a historical author appears only for a work that was published long enough ago to be public domain', () => {
  const all = [].concat(Q.developer, Q.motivational), texts = all.map((q) => q.t.toLowerCase());
  assert.strictEqual(new Set(texts).size, texts.length);
  all.filter((q) => q.a !== 'CodeMini').forEach((q) => {
    const year = Number(/(\d{4})/.exec(q.s)[1]);
    assert.ok(year <= 1950, q.a + ' ' + q.s + ': the oldest work first; a later one needs a decision about its copyright (see js/data/quotes.js)');
  });
  assert.deepStrictEqual(all.filter((q) => q.a !== 'CodeMini').map((q) => q.a).sort(), ['Ada Lovelace', 'Alan Turing', 'Benjamin Franklin', 'Benjamin Franklin', 'Henry David Thoreau', 'Ralph Waldo Emerson', 'Samuel Johnson'], 'every historical author is one that was checked');
});
t('the famous misattributions are kept out (a ratchet: add to the list when you meet another)', () => {
  const all = [].concat(Q.developer, Q.motivational).map((q) => q.t.toLowerCase()).join('\n');
  ['preparing to fail', 'insanity is doing the same thing', 'be the change', 'luck is what happens when preparation', 'we are what we repeatedly do', 'the only thing we have to fear', 'well-behaved women', 'success is not final', 'premature optimization']
    .forEach((p) => assert.ok(all.indexOf(p) === -1, 'a quote that is usually misattributed: ' + p));
});

console.log('wiring');
t('the scripts load after the Now Island (quotes before today), and both are precached and in npm test', () => {
  const html = read('index.html');
  assert.ok(html.indexOf('js/data/quotes.js') > html.indexOf('js/core/now-island.js') && html.indexOf('js/core/today.js') > html.indexOf('js/data/quotes.js'));
  const sw = read('sw.js'); assert.ok(sw.includes("'/js/data/quotes.js'") && sw.includes("'/js/core/today.js'"), 'the quotes are in the precache, so they work offline');
  assert.ok(JSON.parse(read('package.json')).scripts.test.includes('tests/today.test.js'));
});
t('it mounts at order 30 as an always-there section, which retires the "Nothing is running" placeholder; Offline is too', () => {
  const src = read('js/core/today.js'), ni = read('js/core/now-island.js');
  assert.ok(/n\.mount\(ui\.root, 30, \{ always: true \}\)/.test(src) && /n\.mount\(ui\.root, 40, \{ always: true \}\)/.test(read('js/core/offline.js')));
  assert.ok(/hosted\.always\.size > 0/.test(ni) && /opts\.always/.test(ni));
});
t('the time only ticks while the island is open and the page is visible', () => {
  const src = read('js/core/today.js');
  assert.ok(/!n\.isOpen\(\) \|\| document\.hidden\) return;/.test(src), 'a closed island or a hidden page does not tick');
  assert.ok(/n\.onOpen\(onOpen\)/.test(src) && /visibilitychange/.test(src), 'and it catches up when the island opens or the page comes back');
});
t('the five settings have defaults, loading, rows, and apply at once; and they are on the reviewed personal list', () => {
  const sp = read('js/core/settings-profile.js');
  assert.ok(/todayQuote: 'Daily', todayQuoteSet: 'Developer', todayMyQuotes: '', todayShowSeconds: false, todayClock24: 'Auto'/.test(sp));
  ['todayQuote', 'todayQuoteSet', 'todayMyQuotes', 'todayShowSeconds', 'todayClock24'].forEach((k) => {
    assert.ok(sp.includes('data-setting="' + k + '"'), k + ' row');
    assert.ok(new RegExp(k + ': (pickOption|localStorage)').test(sp), k + ' is loaded');
    assert.ok(read('tests/e2e/codemini-config.e2e.js').includes("'" + k + "'"), k + ' is on the reviewed personal list (a workspace cannot set it)');
  });
  assert.ok(/key\.startsWith\('today'\) && window\.CodeMiniToday\) window\.CodeMiniToday\.settingsChanged\(\)/.test(sp));
  const rows = ['Daily Quote', 'Quote Set', 'My Quotes', 'Show Seconds', '24-hour Clock'].map((l) => sp.indexOf('<strong>' + l + '</strong>'));
  assert.ok(rows.every((i, k) => i > 0 && (k === 0 || i > rows[k - 1])), 'in the order the spec gives (Daily quote, Quote set, Show seconds, 24-hour clock; My quotes beside Quote set)' );
});
t('it never builds markup from text', () => {
  const src = read('js/core/today.js').replace(/\/\/.*$/gm, '');
  assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new Function/.test(src));
});
t('every class it uses has a rule, the size and clamp are the spec\'s, and the icons are always there on touch', () => {
  const src = read('js/core/today.js'), css = read('css/style.css');
  const used = new Set(); (src.match(/el\('[a-z0-9]+', '([^']+)'/g) || []).forEach((m) => m.split("'")[3].split(' ').filter((c) => c.indexOf('today-') === 0).forEach((c) => used.add(c)));
  const missing = Array.from(used).filter((c) => !css.includes('.' + c));
  assert.deepStrictEqual(missing, [], 'classes without a rule: ' + missing.join(', '));
  assert.ok(/\.today-time \{[^}]*font-size: 28px;[^}]*font-weight: 600;[^}]*tabular-nums/.test(css), 'the time: 28px, 600, tabular numbers');
  assert.ok(/\.today-quote-text \{[^}]*-webkit-line-clamp: 3;[^}]*font-style: italic/.test(css) && /max-width: 768px\) \{ \.today-quote-text \{ -webkit-line-clamp: 2/.test(css), 'the quote: italic, 3 lines, 2 on a phone');
  assert.ok(/@media \(hover: none\) \{ \.today-tools \{ opacity: 1; \} \}/.test(css), 'the icons show on hover, and always on touch');
  assert.ok(/\.today-day \{[^}]*font-size: 13px;[^}]*font-weight: 600/.test(css) && /\.today-date \{[^}]*font-size: 11px/.test(css), 'day 13/600, date 11');
});

console.log(n + ' today checks passed');
