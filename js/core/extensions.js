// ==========================================
// extensions.js: the engine behind the Extensions sidebar (UI/UX specs, feature 26, first release)
// ==========================================
// What the first release installs: THEMES (a declarative colour set on top of the Light or Dark base) and PACKS (snippet packs), from a `.cmpack`
// file. No code runs: a theme is a handful of colours, a pack is snippet text. Scripted extensions need the runner API (feature 22) and Guard (25),
// which do not exist yet, so nothing here can install one.
//
//   .cmpack     A ZIP with `manifest.json` and the item files. The manifest says `format: "codemini-pack"`, a version, and the items (kind, path, size,
//               SHA-256). The ZIP is read here by a small reader (stored and deflate entries) rather than by JSZip, which is a CDN download: opening
//               a pack must work offline, and the reader can refuse what is not safe (a path that climbs out, an entry that claims a huge size,
//               encryption, more entries than a pack should have) BEFORE anything is inflated.
//   Integrity   The item's bytes must match the SHA-256 in the manifest, or the install stops with an error.
//   Theme       { name, version, author?, description?, base: "light" | "dark", colors: { "--accent-blue": "#3794ff", ... } }. Only the colour variables in
//               THEME_VARS may be set, and only as hex colours, so a theme can change how the app looks and nothing else.
//   Pack        { name, version, author?, description?, language, snippets: { "Name": { prefix, body, description? } } }: the same shape as the Snippets
//               editor's file, checked by the same parser.
//   Review      Nothing is installed straight from a file: parse() returns a review (what it is, where from, a short hash, what it changes, anything
//               wrong with it) and the person decides. CodeMini Guard (feature 25) does not exist yet, so the review says "Not fully checked".
//   Store       The installed items, per window / profile, in localStorage (window.getPrefixedKey('extensions')). A theme record keeps its colours; a
//               pack record keeps its snippets, so uninstalling removes exactly what it added.
//
// The pure rules are exported for Node (tests/extensions.test.js); the browser half (storage, applying a theme, feeding the snippet provider) follows.
(function (root) {
    'use strict';
    const W = root;

    // ---------------------------------------------------------------------------------------------
    // Limits
    // ---------------------------------------------------------------------------------------------
    const LIMITS = { pack: 2 * 1024 * 1024, entry: 1024 * 1024, entries: 20, item: 512 * 1024, records: 100, total: 3 * 1024 * 1024, snippets: 500, snippetBody: 20000, colors: 40 };
    const KINDS_ALL = ['files', 'extension', 'theme', 'snippets', 'skill', 'settings', 'notebook'];
    const KINDS_HERE = { theme: 'theme', snippets: 'pack' };   // what this release installs, and what the Extensions list calls it

    // ---------------------------------------------------------------------------------------------
    // Pure: the colours a theme may set (the variables css/themes.css defines for the app's own colours)
    // ---------------------------------------------------------------------------------------------
    const THEME_VARS = ['--bg-base', '--bg-white', '--bg-panel', '--bg-panel-secondary', '--text-main', '--text-muted', '--text-placeholder', '--text-inverse',
        '--border-color', '--border-light', '--accent-blue', '--accent-blue-dark', '--text-on-accent', '--accent-blue-light', '--accent-new', '--accent-new-light',
        '--color-danger', '--color-warning', '--color-success', '--color-unsaved', '--bg-tabs-bar', '--bg-tab-inactive', '--bg-dropdown', '--bg-search', '--hover-blue',
        '--hover-gray', '--icon-gray'];
    const BASES = { light: 'CodeMini Light', dark: 'CodeMini Dark' };   // the Colour Theme a theme sits on

    // #rgb, #rrggbb or #rrggbbaa -> lowercase #rrggbb / #rrggbbaa, or '' for anything else (a name, rgb(), url(), a typo).
    function normalizeColor(v) {
        const m = typeof v === 'string' ? /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v.trim()) : null;
        if (!m) return '';
        const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
        return '#' + h.toLowerCase();
    }
    function luminance(hex) {
        const lin = (i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
    }
    function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

    // ---------------------------------------------------------------------------------------------
    // Pure: small helpers
    // ---------------------------------------------------------------------------------------------
    const isStr = (x) => typeof x === 'string';
    const isPlain = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
    const shortHash = (h) => String(h || '').slice(0, 12);
    const bytesHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
    async function sha256Hex(u8) {
        const subtle = (W.crypto && W.crypto.subtle) || (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle);
        if (!subtle) throw new Error('This browser cannot check the file\u2019s integrity (no SHA-256).');
        return bytesHex(new Uint8Array(await subtle.digest('SHA-256', u8)));
    }
    const utf8 = (u8) => new TextDecoder('utf-8', { fatal: true }).decode(u8);
    const SAFE_PATH = /^(?![/\\])(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))(?![A-Za-z]:)[^\0\\]{1,200}$/;
    const okVersion = (v) => isStr(v) && /^\d{1,4}(\.\d{1,4}){0,2}$/.test(v);

    // ---------------------------------------------------------------------------------------------
    // Pure: the ZIP reader. `inflate(u8, maxBytes)` is injected (the browser's DecompressionStream, or Node's zlib in a test).
    // Refuses before inflating: zip64, encryption, methods other than stored and deflate, an unsafe path, too many entries, a declared size over
    // the limit; and after inflating, a size that is not the declared one (a zip bomb lies about its size).
    // ---------------------------------------------------------------------------------------------
    const u16 = (v, o) => v[o] | (v[o + 1] << 8);
    const u32 = (v, o) => (v[o] | (v[o + 1] << 8) | (v[o + 2] << 16) | (v[o + 3] << 24)) >>> 0;
    function openZip(bytes, inflate) {
        const v = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (v.length > LIMITS.pack) throw new Error('This file is larger than a pack should be (' + Math.round(LIMITS.pack / 1048576) + ' MB).');
        if (v.length < 22) throw new Error('This is not a .cmpack (it is not a ZIP file).');
        let eocd = -1;
        for (let i = v.length - 22; i >= Math.max(0, v.length - 22 - 65535); i--) { if (u32(v, i) === 0x06054b50) { eocd = i; break; } }
        if (eocd < 0) throw new Error('This is not a .cmpack (it is not a ZIP file).');
        const count = u16(v, eocd + 10), cdSize = u32(v, eocd + 12), cdOff = u32(v, eocd + 16);
        if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) throw new Error('ZIP64 files are not supported.');
        if (count > LIMITS.entries) throw new Error('This package has ' + count + ' files; a pack has at most ' + LIMITS.entries + '.');
        if (cdOff + cdSize > v.length) throw new Error('The ZIP\u2019s directory is damaged.');
        const entries = new Map();
        let p = cdOff;
        for (let n = 0; n < count; n++) {
            if (p + 46 > v.length || u32(v, p) !== 0x02014b50) throw new Error('The ZIP\u2019s directory is damaged.');
            const flags = u16(v, p + 8), method = u16(v, p + 10), comp = u32(v, p + 20), size = u32(v, p + 24), nameLen = u16(v, p + 28), extraLen = u16(v, p + 30), commentLen = u16(v, p + 32), off = u32(v, p + 42);
            const name = utf8(v.subarray(p + 46, p + 46 + nameLen));
            p += 46 + nameLen + extraLen + commentLen;
            if (name.endsWith('/')) continue;                                       // a folder entry
            if (!SAFE_PATH.test(name)) throw new Error('The package has a file with an unsafe path: ' + name.slice(0, 60));
            if (flags & 1) throw new Error('The package is encrypted. Encrypted packages are not supported here yet.');
            if (method !== 0 && method !== 8) throw new Error('The package uses a compression this reader does not support (method ' + method + ').');
            if (size > LIMITS.entry) throw new Error(name + ' is larger than a pack file should be.');
            if (entries.has(name)) throw new Error('The package lists ' + name + ' twice.');
            entries.set(name, { method, comp, size, off });
        }
        return {
            names: () => Array.from(entries.keys()),
            has: (name) => entries.has(name),
            async read(name) {
                const e = entries.get(name);
                if (!e) throw new Error('The package has no ' + name + '.');
                if (e.off + 30 > v.length || u32(v, e.off) !== 0x04034b50) throw new Error('The ZIP is damaged (' + name + ').');
                const start = e.off + 30 + u16(v, e.off + 26) + u16(v, e.off + 28);
                if (start + e.comp > v.length) throw new Error('The ZIP is damaged (' + name + ').');
                const raw = v.subarray(start, start + e.comp);
                const out = e.method === 0 ? raw : await inflate(raw, e.size);
                if (out.length !== e.size) throw new Error(name + ' is not the size the ZIP says it is.');
                return out;
            }
        };
    }
    // The browser's inflater (deflate-raw), stopping as soon as more than `max` bytes come out.
    async function browserInflate(u8, max) {
        const ds = new DecompressionStream('deflate-raw'), w = ds.writable.getWriter();
        w.write(u8).catch(() => {}); w.close().catch(() => {});
        const rd = ds.readable.getReader(), chunks = []; let total = 0;
        for (;;) {
            const { done, value } = await rd.read();
            if (done) break;
            total += value.length;
            if (total > max) { try { await rd.cancel(); } catch (e) { /* stopped */ } throw new Error('A file in the package is larger than it says.'); }
            chunks.push(value);
        }
        const out = new Uint8Array(total); let o = 0; chunks.forEach((c) => { out.set(c, o); o += c.length; });
        return out;
    }

    // ---------------------------------------------------------------------------------------------
    // Pure: the manifest, and the items
    // ---------------------------------------------------------------------------------------------
    function parseManifest(text) {
        let m;
        try { m = JSON.parse(text); } catch (e) { return { ok: false, error: 'manifest.json is not valid JSON (' + String(e && e.message || e).slice(0, 80) + ').' }; }
        if (!isPlain(m) || m.format !== 'codemini-pack') return { ok: false, error: 'This is not a CodeMini pack (manifest.json does not say "codemini-pack").' };
        if (m.version !== 1) return { ok: false, error: 'This pack is format version ' + String(m.version).slice(0, 10) + '; this app reads version 1.' };
        if (m.encryption) return { ok: false, error: 'The package is encrypted. Encrypted packages are not supported here yet.' };
        if (!Array.isArray(m.items) || !m.items.length) return { ok: false, error: 'The pack lists no items.' };
        if (m.items.length > LIMITS.entries) return { ok: false, error: 'The pack lists too many items.' };
        const items = [];
        for (const it of m.items) {
            if (!isPlain(it)) return { ok: false, error: 'An item in the manifest is not an object.' };
            if (KINDS_ALL.indexOf(it.kind) === -1) return { ok: false, error: 'The pack has an item of an unknown kind (' + String(it.kind).slice(0, 20) + ').' };
            if (!isStr(it.path) || !SAFE_PATH.test(it.path)) return { ok: false, error: 'The pack has an item with an unsafe path.' };
            if (!Number.isInteger(it.size) || it.size < 0 || it.size > LIMITS.entry) return { ok: false, error: it.path + ' has a size that is not valid.' };
            if (!isStr(it.sha256) || !/^[0-9a-f]{64}$/i.test(it.sha256)) return { ok: false, error: it.path + ' has no valid SHA-256 in the manifest.' };
            items.push({ kind: it.kind, path: it.path, size: it.size, sha256: it.sha256.toLowerCase() });
        }
        return { ok: true, manifest: { format: 'codemini-pack', version: 1, appVersion: isStr(m.appVersion) ? m.appVersion.slice(0, 20) : '', sender: isStr(m.sender) ? m.sender.slice(0, 60) : '', items } };
    }

    function head(obj, errors) {
        const out = {};
        if (!isStr(obj.name) || !obj.name.trim() || obj.name.length > 60) errors.push('It needs a name (up to 60 characters).'); else out.name = obj.name.trim();
        if (!okVersion(obj.version)) errors.push('It needs a version like 1.0 or 1.2.3.'); else out.version = obj.version;
        out.author = isStr(obj.author) ? obj.author.trim().slice(0, 60) : '';
        out.description = isStr(obj.description) ? obj.description.trim().slice(0, 300) : '';
        return out;
    }

    // -> { ok, theme: { name, version, author, description, base, colors }, warnings } | { ok: false, errors }
    function validateTheme(obj) {
        const errors = [], warnings = [];
        if (!isPlain(obj)) return { ok: false, errors: ['A theme file is an object.'] };
        const out = head(obj, errors);
        if (!has(BASES, obj.base)) errors.push('"base" must be "light" or "dark".'); else out.base = obj.base;
        const colors = {};
        if (!isPlain(obj.colors) || !Object.keys(obj.colors).length) errors.push('It needs "colors": { "--accent-blue": "#3794ff", ... }.');
        else if (Object.keys(obj.colors).length > LIMITS.colors) errors.push('It sets more colours than there are to set.');
        else Object.keys(obj.colors).forEach((k) => {
            if (THEME_VARS.indexOf(k) === -1) { errors.push('"' + k.slice(0, 40) + '" is not a colour a theme can set.'); return; }
            const c = normalizeColor(obj.colors[k]);
            if (!c) errors.push(k + ' is not a hex colour (use #rgb, #rrggbb or #rrggbbaa).'); else colors[k] = c;
        });
        if (errors.length) return { ok: false, errors };
        out.colors = colors;
        const fg = colors['--text-main'], bg = colors['--bg-white'];
        if (fg && bg && fg.length === 7 && bg.length === 7 && contrast(fg, bg) < 3) warnings.push('Low contrast: the main text colour is hard to read on the background (' + contrast(fg, bg).toFixed(1) + ' to 1).');
        return { ok: true, theme: out, warnings };
    }

    // parseSnippets is the Snippets editor's own parser (js/core/snippets.js), injected so this file does not depend on it.
    // -> { ok, pack: { name, version, author, description, language, snippets, count, skipped }, warnings } | { ok: false, errors }
    function validatePack(obj, parseSnippets) {
        const errors = [], warnings = [];
        if (!isPlain(obj)) return { ok: false, errors: ['A snippet pack is an object.'] };
        const out = head(obj, errors);
        if (!isStr(obj.language) || !/^[a-z0-9_-]{1,30}$/.test(obj.language)) errors.push('"language" must be a Monaco language id such as "javascript" or "python".'); else out.language = obj.language;
        if (!isPlain(obj.snippets)) errors.push('It needs "snippets": { "Name": { "prefix": "...", "body": "..." } }.');
        if (errors.length) return { ok: false, errors };
        if (Object.keys(obj.snippets).length > LIMITS.snippets) return { ok: false, errors: ['A pack has at most ' + LIMITS.snippets + ' snippets.'] };
        const parsed = parseSnippets(JSON.stringify(obj.snippets));
        if (!parsed.ok) return { ok: false, errors: ['The snippets are not valid: ' + parsed.error] };
        if (parsed.entries.some((e) => (Array.isArray(e.body) ? e.body.join('\n') : String(e.body)).length > LIMITS.snippetBody)) return { ok: false, errors: ['A snippet body is longer than ' + LIMITS.snippetBody + ' characters.'] };
        if (!parsed.entries.length) return { ok: false, errors: ['The pack has no usable snippets.' + (parsed.skipped.length ? ' ' + parsed.skipped[0].name + ' ' + parsed.skipped[0].reason + '.' : '')] };
        out.snippets = obj.snippets; out.count = parsed.entries.length; out.skipped = parsed.skipped;
        parsed.skipped.slice(0, 3).forEach((s) => warnings.push('"' + s.name + '" will be skipped: it ' + s.reason + '.'));
        return { ok: true, pack: out, warnings };
    }

    // ---------------------------------------------------------------------------------------------
    // Pure: reading a .cmpack into a REVIEW (nothing is installed here)
    //   io: { inflate, parseSnippets, sha256 }  (the browser's own by default)
    //   -> { ok: true, review } | { ok: false, error }
    // review: { kind: 'theme'|'pack', record (what would be stored), rows, changes, warnings, guard, replaces, source }
    // ---------------------------------------------------------------------------------------------
    const GUARD_NOT_BUILT = { verdict: 'Not fully checked', text: 'CodeMini Guard is not available yet. This package has no code to run; its file was checked for shape and its SHA-256 matched the manifest.' };

    async function readPack(bytes, io, existing) {
        let zip;
        try { zip = openZip(bytes, io.inflate); } catch (e) { return { ok: false, error: e.message }; }
        if (!zip.has('manifest.json')) return { ok: false, error: 'This is not a CodeMini pack: it has no manifest.json.' };
        let mtext; try { mtext = utf8(await zip.read('manifest.json')); } catch (e) { return { ok: false, error: 'manifest.json could not be read (' + e.message + ').' }; }
        const mf = parseManifest(mtext); if (!mf.ok) return mf;
        const items = mf.manifest.items;
        const unsupported = items.filter((i) => !has(KINDS_HERE, i.kind));
        if (unsupported.length) return { ok: false, error: 'This pack has ' + (unsupported[0].kind === 'extension' ? 'a scripted extension, which cannot be installed yet (it needs CodeMini Guard and the extension runner)' : 'an item of kind "' + unsupported[0].kind + '", which cannot be installed from here yet') + '. This release installs themes and snippet packs.' };
        if (items.length !== 1) return { ok: false, error: 'This pack has ' + items.length + ' items. Install one item at a time.' };
        const it = items[0];
        if (!zip.has(it.path)) return { ok: false, error: 'The manifest lists ' + it.path + ' but the package does not contain it.' };
        let bytesOfItem; try { bytesOfItem = await zip.read(it.path); } catch (e) { return { ok: false, error: e.message }; }
        if (bytesOfItem.length !== it.size) return { ok: false, error: it.path + ' is not the size the manifest says.' };
        const hash = await io.sha256(bytesOfItem);
        if (hash !== it.sha256) return { ok: false, error: 'Integrity check failed: ' + it.path + ' does not match the SHA-256 in the manifest. The file was changed after the pack was made.' };
        let obj; try { obj = JSON.parse(utf8(bytesOfItem)); } catch (e) { return { ok: false, error: it.path + ' is not valid JSON.' }; }
        const kind = KINDS_HERE[it.kind];
        const v = it.kind === 'theme' ? validateTheme(obj) : validatePack(obj, io.parseSnippets);
        if (!v.ok) return { ok: false, error: 'This ' + (kind === 'theme' ? 'theme' : 'pack') + ' file has problems:', details: v.errors };
        const body = it.kind === 'theme' ? v.theme : v.pack;
        const id = kind + '-' + slug(body.name);
        const old = (existing || []).find((r) => r.id === id) || null;
        const record = { id, kind, name: body.name, version: body.version, author: body.author, description: body.description, source: 'File', hash, enabled: true, payload: it.kind === 'theme' ? { base: body.base, colors: body.colors } : { language: body.language, snippets: body.snippets, count: body.count } };
        const rows = [['Name', body.name], ['Version', 'v' + body.version], ['Author', (body.author || 'Not given') + ' (typed by the author, not verified)'], ['Source', 'File' + (mf.manifest.sender ? ', sent by ' + mf.manifest.sender : '')], ['SHA-256', shortHash(hash)]];
        const changes = it.kind === 'theme'
            ? ['Sets ' + Object.keys(body.colors).length + ' colours on the ' + (body.base === 'dark' ? 'Dark' : 'Light') + ' theme', 'Changes nothing else: it has no code.']
            : ['Adds ' + body.count + ' snippet' + (body.count === 1 ? '' : 's') + ' for ' + body.language, 'Your own snippets are not touched. Uninstalling removes only these.'];
        return { ok: true, review: { kind, record, rows, changes, warnings: v.warnings.slice(), guard: Object.assign({}, GUARD_NOT_BUILT), replaces: old ? { version: old.version, hash: old.hash, same: old.hash === hash } : null, sourceText: utf8(bytesOfItem), file: it.path } };
    }

    // ---------------------------------------------------------------------------------------------
    // Pure: the installed items. io: { load() -> array|null, save(array) }
    // ---------------------------------------------------------------------------------------------
    const sizeOf = (r) => JSON.stringify(r).length;
    function createStore(io) {
        let list = [];
        const listeners = new Set();
        const emit = () => listeners.forEach((fn) => { try { fn(); } catch (e) { /* a listener must not break saving */ } });
        const persist = () => { try { io.save(list); } catch (e) { /* private mode: it lasts for this page */ } };
        const clean = (r) => isPlain(r) && isStr(r.id) && (r.kind === 'theme' || r.kind === 'pack') && isStr(r.name) && isPlain(r.payload);
        return {
            reload() { let raw = null; try { raw = io.load(); } catch (e) { raw = null; } list = Array.isArray(raw) ? raw.filter(clean).slice(0, LIMITS.records) : []; emit(); },
            list: () => list.slice(),
            get: (id) => list.find((r) => r.id === id) || null,
            totalSize: () => list.reduce((n, r) => n + sizeOf(r), 0),
            // Adds a record, or replaces the one with the same id (keeping what the old one was in `previous`).
            add(rec, enabled) {
                if (!clean(rec)) throw new Error('That is not an installable item.');
                if (sizeOf(rec) > LIMITS.item) throw new Error('This item is larger than an installed item can be.');
                const old = list.find((r) => r.id === rec.id), now = Date.now();
                const next = Object.assign({}, rec, { enabled: enabled !== false, installedAt: old ? old.installedAt : now, updatedAt: now, previous: old ? { version: old.version, hash: old.hash } : null });
                const others = list.filter((r) => r.id !== rec.id);
                if (!old && others.length >= LIMITS.records) throw new Error('There are already ' + LIMITS.records + ' installed items.');
                if (others.reduce((n, r) => n + sizeOf(r), 0) + sizeOf(next) > LIMITS.total) throw new Error('There is no room: installed items are limited to ' + Math.round(LIMITS.total / 1048576) + ' MB in total.');
                list = others.concat([next]); persist(); emit(); return next;
            },
            remove(id) { const had = list.some((r) => r.id === id); list = list.filter((r) => r.id !== id); if (had) { persist(); emit(); } return had; },
            setEnabled(id, on) { const r = list.find((x) => x.id === id); if (!r) return false; r.enabled = !!on; persist(); emit(); return true; },
            onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
        };
    }

    // What a theme contributes while it is applied: its variables, or {} when it must not be (a theme pack owns the whole look; the base the
    // theme was made for must be the Colour Theme in use, or its colours would sit on the wrong background).
    function themeOverlay(record, settings) {
        if (!record || record.kind !== 'theme' || record.enabled === false || !record.payload) return {};
        if (!settings || (settings.themePack && settings.themePack !== 'None')) return {};
        if (settings.colorTheme !== BASES[record.payload.base]) return {};
        const out = {};
        Object.keys(record.payload.colors || {}).forEach((k) => { if (THEME_VARS.indexOf(k) > -1 && normalizeColor(record.payload.colors[k])) out[k] = normalizeColor(record.payload.colors[k]); });
        return out;
    }
    // Entries of every ENABLED pack for a language, shaped like the Snippets editor's own entries (name, prefixes, body, description).
    function packEntries(records, lang, parseSnippets) {
        const out = [];
        (records || []).forEach((r) => {
            if (r.kind !== 'pack' || r.enabled === false || !r.payload || r.payload.language !== lang) return;
            const parsed = parseSnippets(JSON.stringify(r.payload.snippets || {}));
            if (parsed.ok) parsed.entries.forEach((e) => out.push(e));
        });
        return out;
    }

    const api = {
        LIMITS, THEME_VARS, BASES, KINDS_HERE, GUARD_NOT_BUILT,
        normalizeColor, contrast, slug, shortHash, sha256Hex, openZip, browserInflate, parseManifest, validateTheme, validatePack, readPack, createStore, themeOverlay, packEntries
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof document === 'undefined') return; // Node: the rules only

    // ---------------------------------------------------------------------------------------------
    // Browser: storage per window / profile, applying a theme, feeding the snippet provider
    // ---------------------------------------------------------------------------------------------
    const key = () => (typeof W.getPrefixedKey === 'function' ? W.getPrefixedKey('extensions') : 'codemini_extensions');
    const store = createStore({
        load: () => { try { return JSON.parse(localStorage.getItem(key()) || 'null'); } catch (e) { return null; } },
        save: (list) => { if (list.length) localStorage.setItem(key(), JSON.stringify(list)); else localStorage.removeItem(key()); }
    });
    store.reload();

    const settings = () => W.appSettings || {};
    const activeThemeId = () => String(settings().extTheme || '');
    // Called by applyTheme() (settings-profile.js) with <html>: sets the active theme's colours, and removes the ones a previous theme set.
    // clearOverlay() runs at the start of applyTheme() (so the colours it sets and removes itself are not confused with ours), applyOverlay() at the end.
    let applied = [];
    function clearOverlay(rootEl) { applied.forEach((k) => rootEl.style.removeProperty(k)); applied = []; }
    function applyOverlay(rootEl) {
        const id = activeThemeId(); if (!id) return;
        const vars = themeOverlay(store.get(id), settings());
        Object.keys(vars).forEach((k) => { rootEl.style.setProperty(k, vars[k]); applied.push(k); });
    }
    const reapply = () => { if (typeof W.applyTheme === 'function') W.applyTheme(); };
    store.onChange(reapply);

    // Applying a theme means: its base becomes the Colour Theme, no Theme Pack is active, and it is the active theme. (Settings > Theme choosing
    // anything else clears it: saveSetting does that for colorTheme and themePack.)
    function applyTheme(id) {
        const r = store.get(id); if (!r || r.kind !== 'theme' || typeof W.saveSetting !== 'function') return false;
        W.__extApplying = true;
        try { W.saveSetting('themePack', 'None'); W.saveSetting('colorTheme', BASES[r.payload.base]); W.saveSetting('extTheme', id); } finally { W.__extApplying = false; }
        reapply(); return true;
    }
    function applyBuiltIn(colorTheme, themePack) {
        if (typeof W.saveSetting !== 'function') return;
        W.__extApplying = true;
        try { W.saveSetting('extTheme', ''); W.saveSetting('themePack', themePack || 'None'); if (colorTheme) W.saveSetting('colorTheme', colorTheme); } finally { W.__extApplying = false; }
        reapply();
    }
    function isThemeActive(id) { return activeThemeId() === id && Object.keys(themeOverlay(store.get(id), settings())).length > 0; }

    // Snippet packs: the Snippets provider asks for these on top of the person's own snippets.
    function feedSnippets() {
        if (W.CodeMiniSnippets && typeof W.CodeMiniSnippets.setExtra === 'function' && typeof W.CodeMiniSnippets.parseSnippets === 'function') {
            W.CodeMiniSnippets.setExtra((lang) => packEntries(store.list(), lang, W.CodeMiniSnippets.parseSnippets));
        }
    }
    feedSnippets();
    if (activeThemeId()) reapply();     // settings-profile.js applied the theme before this file loaded: put the installed theme's colours on

    async function reviewFile(file) {
        if (!file) return { ok: false, error: 'No file was chosen.' };
        if (file.size > LIMITS.pack) return { ok: false, error: 'This file is larger than a pack should be (' + Math.round(LIMITS.pack / 1048576) + ' MB).' };
        let bytes; try { bytes = new Uint8Array(await file.arrayBuffer()); } catch (e) { return { ok: false, error: 'The file could not be read.' }; }
        return readPack(bytes, { inflate: browserInflate, parseSnippets: (t) => (W.CodeMiniSnippets && W.CodeMiniSnippets.parseSnippets ? W.CodeMiniSnippets.parseSnippets(t) : { ok: false, error: 'The snippet parser is not available.' }), sha256: sha256Hex }, store.list());
    }
    function install(review, enable) {
        const rec = store.add(review.record, enable);
        if (enable && rec.kind === 'theme') applyTheme(rec.id);
        return rec;
    }
    function uninstall(id) {
        const wasActive = activeThemeId() === id;
        const had = store.remove(id);
        if (wasActive && typeof W.saveSetting === 'function') { W.__extApplying = true; try { W.saveSetting('extTheme', ''); } finally { W.__extApplying = false; } }
        reapply();
        return had;
    }
    function setEnabled(id, on) { const ok = store.setEnabled(id, on); reapply(); return ok; }

    W.CodeMiniExtensions = Object.freeze({
        store, clearOverlay, applyOverlay, appliedVars: () => applied.slice(), applyTheme, applyBuiltIn, isThemeActive, reviewFile, install, uninstall, setEnabled, feedSnippets,
        reload: () => { store.reload(); reapply(); }, activeThemeId
    });
})(typeof window !== 'undefined' ? window : globalThis);
