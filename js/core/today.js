// ==========================================
// today.js: Today in the Now Island (UI/UX specs, feature 12)
// ==========================================
// A TODAY section in the Now pane (order 30, between Mini Preview and Offline and Packages): the time, the day and date, and a quote.
//
//   Time       28px, follows the system 12h or 24h preference through Intl.DateTimeFormat (a setting can force either), updates once a minute
//              (every second only if "Show seconds" is on). It only ticks while the island is open and the page is visible, so a closed island
//              costs nothing.
//   Day, date  "Sunday" over "1 November 2026" in the person's own locale.
//   Quote      one a day, chosen from the DATE alone, so it is the same on every open and in every window. Within a set every quote is shown once
//              before any repeats and the same one never comes two days running. "Each open" picks a new one whenever the island opens, "Off"
//              hides it. Shuffle gives another until the next day (or open). Copy puts it on the clipboard. The heart saves it to the person's
//              favourites, which, with the lines they typed in Settings, make the "Mine" set.
//   Quotes     js/data/quotes.js: a small local file in the service worker's precache, so it works offline. Public-domain lines with their
//              author and source, or original lines credited to CodeMini.
//
// The pure rules (the daily pick, the formats, the quote parsing, the pools) are exported for Node (tests/today.test.js); the browser half
// (the section, the timer, the buttons) follows them.
(function (root) {
    'use strict';
    const W = root;

    const SETS = ['Developer', 'Motivational', 'Mine'];
    const MODES = ['Daily', 'Each open', 'Off'];
    const CLOCKS = ['Auto', 'On', 'Off'];            // 24-hour clock: follow the system, force 24-hour, force 12-hour
    const MAX_CUSTOM = 200, MAX_TEXT = 400, MAX_AUTHOR = 60, MAX_FAVS = 200;

    // ---------------------------------------------------------------------------------------------
    // Pure: which quote today
    // ---------------------------------------------------------------------------------------------
    // The day as a whole number, by the person's own calendar date (not UTC): the quote changes at their midnight.
    function dayNumber(d) { return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000); }
    function dayKey(d) { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }

    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    }
    function permutation(n, cycle) {
        const a = Array.from({ length: n }, (_, i) => i), rnd = mulberry32(Math.imul(cycle | 0, 2654435761) ^ Math.imul(n, 40503) ^ 0x9E3779B9);
        for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
        return a;
    }
    // Every quote once per cycle of n days, in an order that is different each cycle; and the first quote of a cycle is never the last of the
    // one before, so the same line never comes two days running.
    function dailyIndex(n, day) {
        if (!(n > 0)) return -1;
        if (n === 1) return 0;
        if (n === 2) return ((day % 2) + 2) % 2;
        const cycle = Math.floor(day / n), pos = ((day % n) + n) % n, perm = permutation(n, cycle);
        if (pos < 2 && perm[0] === permutation(n, cycle - 1)[n - 1]) { const t = perm[0]; perm[0] = perm[1]; perm[1] = t; }
        return perm[pos];
    }
    function pickDaily(pool, date) { const i = dailyIndex(pool.length, dayNumber(date)); return i < 0 ? null : pool[i]; }
    // Another quote than `avoidText` (when there is another), for Shuffle and "Each open".
    function pickRandom(pool, avoidText, rnd) {
        if (!pool.length) return null;
        const r = rnd || Math.random, others = pool.length > 1 ? pool.filter((q) => q.t !== avoidText) : pool;
        return others[Math.min(others.length - 1, Math.floor(r() * others.length))];
    }

    // ---------------------------------------------------------------------------------------------
    // Pure: the quotes the person added, favourites, and which pool is in use
    // ---------------------------------------------------------------------------------------------
    // One quote per line: `text — author`, `text | author`, `text - author`, or just the text. Quote marks round the text are dropped.
    function parseCustom(text) {
        const out = [];
        String(text || '').split(/\r?\n/).forEach((raw) => {
            const line = raw.trim();
            if (!line || out.length >= MAX_CUSTOM) return;
            const m = /^(.*\S)\s+(?:\u2014|\u2013|\|)\s+(.+)$/.exec(line) || /^(.*\S)\s+-\s+(.+)$/.exec(line);
            let t = (m ? m[1] : line).trim().replace(/^["\u201c\u201d]+|["\u201c\u201d]+$/g, '').trim(), a = m ? m[2].trim() : '';
            if (!t) return;
            out.push({ t: t.slice(0, MAX_TEXT), a: (a || 'Me').slice(0, MAX_AUTHOR) });
        });
        return out;
    }
    function dedupe(list) { const seen = new Set(); return list.filter((q) => { const k = q.t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); }
    const hasQuote = (list, q) => !!q && list.some((x) => x.t === q.t);
    function toggleFav(favs, q) {
        if (!q) return favs.slice();
        if (hasQuote(favs, q)) return favs.filter((x) => x.t !== q.t);
        return favs.concat([{ t: q.t, a: q.a, s: q.s || '' }]).slice(-MAX_FAVS);
    }
    // The pool for a set. "Mine" is what the person typed plus their favourites; with nothing there yet it falls back to Developer (and says so).
    function quotePool(set, data, custom, favs) {
        if (set === 'Motivational') return { quotes: data.motivational.slice(), fellBack: false };
        if (set === 'Mine') {
            const mine = dedupe((custom || []).concat(favs || []));
            if (mine.length) return { quotes: mine, fellBack: false };
            return { quotes: data.developer.slice(), fellBack: true };
        }
        return { quotes: data.developer.slice(), fellBack: false };
    }
    const attribution = (q) => q ? [q.a, q.s].filter(Boolean).join(', ') : '';
    const copyText = (q) => q ? '\u201c' + q.t + '\u201d \u2014 ' + attribution(q) : '';
    const pick = (allowed, v, fallback) => (allowed.indexOf(v) > -1 ? v : fallback);

    // ---------------------------------------------------------------------------------------------
    // Pure: the clock and the date
    // ---------------------------------------------------------------------------------------------
    // clock: 'Auto' follows the system's 12h/24h preference; 'On' forces 24-hour, 'Off' forces 12-hour. (h23 and h12, not hour12: false, which some
    // engines write as "24:05" after midnight.)
    function timeParts(date, opts) {
        const o = opts || {}, f = { hour: 'numeric', minute: '2-digit' };
        if (o.seconds) f.second = '2-digit';
        if (o.clock === 'On') f.hourCycle = 'h23'; else if (o.clock === 'Off') f.hourCycle = 'h12';
        let fmt = new Intl.DateTimeFormat(o.locale, f);
        // A 24-hour clock is written with two-digit hours (09:05, 00:00); engines differ on what "numeric" gives there (Chromium: 9:05 and 0:00).
        const hc = fmt.resolvedOptions().hourCycle;
        if (hc === 'h23' || hc === 'h24') { f.hour = '2-digit'; f.hourCycle = 'h23'; fmt = new Intl.DateTimeFormat(o.locale, f); }
        const parts = fmt.formatToParts(date);
        const period = parts.filter((p) => p.type === 'dayPeriod').map((p) => p.value).join('');
        const text = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
        return { text, period };
    }
    function dateLabels(date, locale) {
        return { weekday: new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date), date: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(date) };
    }
    // How long until the display changes: the next minute, or the next second with seconds shown (a few ms late, never early).
    function msToNextTick(date, seconds) {
        const ms = date.getMilliseconds(), s = date.getSeconds();
        return (seconds ? 1000 - ms : 60000 - (s * 1000 + ms)) + 20;
    }

    const api = {
        SETS, MODES, CLOCKS, MAX_CUSTOM,
        dayNumber, dayKey, dailyIndex, pickDaily, pickRandom, parseCustom, dedupe, hasQuote, toggleFav, quotePool, attribution, copyText, pick,
        timeParts, dateLabels, msToNextTick
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof document === 'undefined') return; // Node: the rules only

    // ---------------------------------------------------------------------------------------------
    // Browser
    // ---------------------------------------------------------------------------------------------
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const NI = () => W.CodeMiniNowIsland || null;
    const COLLAPSE_KEY = 'codemini_today_collapsed', FAV_KEY = 'codemini_quote_favorites';
    const store = {
        get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
        set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* not remembered */ } }
    };
    const loadFavs = () => { try { const a = JSON.parse(store.get(FAV_KEY) || '[]'); return Array.isArray(a) ? a.filter((q) => q && typeof q.t === 'string' && typeof q.a === 'string').slice(-MAX_FAVS) : []; } catch (e) { return []; } };

    // Settings > General > Today (the Daily quote, Quote set, My quotes, Show seconds and 24-hour clock rows).
    function settings() {
        const s = W.appSettings || {};
        return { mode: pick(MODES, s.todayQuote, 'Daily'), set: pick(SETS, s.todayQuoteSet, 'Developer'), seconds: s.todayShowSeconds === true || s.todayShowSeconds === 'true', clock: pick(CLOCKS, s.todayClock24, 'Auto'), mine: String(s.todayMyQuotes || '') };
    }

    const S = { quote: null, shuffled: null, eachOpen: null, day: '', timer: 0, favs: loadFavs(), fellBack: false };
    let ui = null;

    function pool() {
        const st = settings(), data = W.CODEMINI_QUOTES || { developer: [], motivational: [] };
        const p = quotePool(st.set, data, parseCustom(st.mine), S.favs);
        S.fellBack = p.fellBack;
        return p.quotes;
    }
    // Chooses what is shown. `fresh`: the island has just opened (a new one for "Each open") or the settings changed.
    function chooseQuote(fresh) {
        const st = settings();
        if (st.mode === 'Off') { S.quote = null; return; }
        const p = pool();
        if (S.shuffled && hasQuote(p, S.shuffled)) { S.quote = S.shuffled; return; }
        S.shuffled = null;
        if (st.mode === 'Each open') {
            if (fresh || !S.eachOpen || !hasQuote(p, S.eachOpen)) S.eachOpen = pickRandom(p, S.eachOpen && S.eachOpen.t);
            S.quote = S.eachOpen;
        } else S.quote = pickDaily(p, new Date());
    }

    function build() {
        const root = el('div', 'ni-sec today-sec'); root.setAttribute('role', 'region'); root.setAttribute('aria-label', 'Today');
        const head = el('div', 'sb-section-header');
        const toggle = el('button', 'today-toggle'); toggle.type = 'button';
        const chev = el('i', 'ri-arrow-down-s-line'); toggle.append(chev, el('span', null, 'TODAY'));
        head.appendChild(toggle);
        const body = el('div', 'today-body');
        // time, and the day and date beside it
        const clock = el('div', 'today-clock');
        const time = el('div', 'today-time'), timeText = el('span'), period = el('span', 'today-period');
        time.append(timeText, period);
        const dates = el('div', 'today-dates'), day = el('span', 'today-day'), date = el('span', 'today-date');
        dates.append(day, date); clock.append(time, dates);
        // the quote, its attribution and its three icons
        const quote = el('div', 'today-quote');
        const qtext = el('div', 'today-quote-text'); qtext.setAttribute('role', 'button'); qtext.tabIndex = 0; qtext.setAttribute('aria-expanded', 'false');
        const foot = el('div', 'today-quote-foot'), attr = el('span', 'today-attr'), tools = el('span', 'today-tools');
        const mkBtn = (icon, label, fn) => { const b = el('button', 'ni-icon-btn'); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.appendChild(el('i', icon)); b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
        const shuffle = mkBtn('ri-shuffle-line', 'Another quote', onShuffle), copy = mkBtn('ri-file-copy-line', 'Copy quote', onCopy), fav = mkBtn('ri-heart-line', 'Save to favourites', onFavorite);
        fav.setAttribute('aria-pressed', 'false');
        tools.append(shuffle, copy, fav); foot.append(attr, tools); quote.append(qtext, foot);
        const note = el('div', 'today-note'); note.hidden = true;
        body.append(clock, quote, note); root.append(head, body);
        const toggleExpand = () => { const open = !qtext.classList.contains('open'); qtext.classList.toggle('open', open); qtext.setAttribute('aria-expanded', String(open)); };
        qtext.addEventListener('click', toggleExpand);
        qtext.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(); } });
        toggle.addEventListener('click', () => { store.set(COLLAPSE_KEY, store.get(COLLAPSE_KEY) === '1' ? '0' : '1'); draw(); });
        ui = { root, toggle, chev, body, timeText, period, day, date, quote, qtext, attr, fav, note };
    }

    function draw() {
        if (!ui) return;
        const collapsed = store.get(COLLAPSE_KEY) === '1', st = settings(), now = new Date();
        ui.chev.className = collapsed ? 'ri-arrow-right-s-line' : 'ri-arrow-down-s-line';
        ui.toggle.setAttribute('aria-expanded', String(!collapsed));
        ui.body.hidden = collapsed;
        if (collapsed) return;
        const t = timeParts(now, { seconds: st.seconds, clock: st.clock }), d = dateLabels(now);
        ui.timeText.textContent = t.text; ui.period.textContent = t.period ? ' ' + t.period : '';
        ui.day.textContent = d.weekday; ui.date.textContent = d.date;
        const q = S.quote;
        ui.quote.hidden = !q;
        if (q) {
            ui.qtext.textContent = '\u201c' + q.t + '\u201d'; ui.qtext.title = q.t.length > 120 ? 'Click to read all of it' : '';
            ui.attr.textContent = '\u2014 ' + attribution(q);
            const fav = hasQuote(S.favs, q);
            ui.fav.setAttribute('aria-pressed', String(fav)); ui.fav.title = fav ? 'Remove from favourites' : 'Save to favourites';
            ui.fav.firstChild.className = fav ? 'ri-heart-fill' : 'ri-heart-line';
        }
        ui.note.hidden = !(q && st.set === 'Mine' && S.fellBack);
        if (!ui.note.hidden) ui.note.textContent = 'Nothing in Mine yet, so this is from Developer. Add lines in Settings > General, or save quotes with the heart.';
    }

    // ---- the timer: only while the island is open and the page is visible ----
    function tick() {
        S.timer = 0;
        const n = NI();
        if (!ui || !n || !n.isOpen() || document.hidden) return;
        const key = dayKey(new Date());
        if (key !== S.day) { S.day = key; S.shuffled = null; chooseQuote(false); }   // midnight: a new day, a new quote
        draw();
        if (store.get(COLLAPSE_KEY) !== '1') S.timer = setTimeout(tick, msToNextTick(new Date(), settings().seconds));
    }
    function restart() { clearTimeout(S.timer); S.timer = 0; tick(); }
    function onOpen() { S.day = dayKey(new Date()); chooseQuote(true); restart(); }

    // ---- the three icons ----
    function onShuffle() { const p = pool(); S.shuffled = pickRandom(p, S.quote && S.quote.t); if (S.shuffled) S.quote = S.shuffled; draw(); }
    async function onCopy() {
        if (!S.quote) return;
        let ok = false;
        try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(copyText(S.quote)); ok = true; } } catch (e) { ok = false; }
        if (typeof W.showSuccessToast === 'function') W.showSuccessToast(ok ? 'Quote copied' : 'Could not copy the quote');
    }
    function onFavorite() {
        if (!S.quote) return;
        S.favs = toggleFav(S.favs, S.quote);
        store.set(FAV_KEY, JSON.stringify(S.favs));
        draw();
    }

    // A Today setting changed (Settings > General > Today): apply it now.
    function settingsChanged() { S.shuffled = null; chooseQuote(true); if (NI() && NI().isOpen()) restart(); else draw(); }

    function init() {
        const n = NI(); if (!n) return;
        build();
        n.mount(ui.root, 30, { always: true });
        n.onOpen(onOpen);
        document.addEventListener('visibilitychange', () => { if (!document.hidden && n.isOpen()) restart(); });
        S.day = dayKey(new Date()); chooseQuote(true); draw();
    }
    init();

    W.CodeMiniToday = Object.freeze({
        settingsChanged, refresh: () => { chooseQuote(false); draw(); }, shuffle: onShuffle, toggleFavorite: onFavorite,
        state: () => ({ quote: S.quote, favs: S.favs.slice(), ticking: !!S.timer, fellBack: S.fellBack })
    });
})(typeof window !== 'undefined' ? window : globalThis);
