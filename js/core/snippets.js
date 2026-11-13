// User snippets: type a prefix in any editor, pick the snippet from autocomplete (it shows the snippet icon), and it
// expands, with tab stops ($1, ${2:name}) the way VS Code snippets do.
//
//   File format   one JSON object per language, as in VS Code:
//                 { "Log to console": { "prefix": "log", "body": ["console.log($1);"], "description": "..." } }
//                 prefix may be a list; body may be one string or a list of lines.
//   Storage       the TEXT of each language's file, saved per window / profile (window.getPrefixedKey), so what you typed
//                 is what comes back. Text that is not valid JSON is never stored: the last good version stays in use.
//   Where         Settings > Snippets (a language picker, a New Snippet form, and the file in a Monaco editor with schema
//                 checks), reached from Settings, the command palette ("Configure Snippets") or Quick Open.
//
// The pure half is exported for Node (tests/snippets.test.js); the browser half starts after that.
// DOM is built with nodes, never HTML strings (tests/html-sinks).
(function (root) {
    'use strict';
    const W = root;

    // ---------------------------------------------------------------------------------------------
    // Pure: the file format
    // ---------------------------------------------------------------------------------------------
    const SNIPPET_SCHEMA = {
        type: 'object',
        description: 'Snippets for one language: each key is the snippet\u2019s name.',
        additionalProperties: {
            type: 'object',
            required: ['prefix', 'body'],
            properties: {
                prefix: { description: 'What you type to get this snippet (a list gives it several).', anyOf: [{ type: 'string', minLength: 1 }, { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }] },
                body: { description: 'The text inserted. A list is one line per item. $1, $2 are tab stops, ${1:name} a tab stop with text.', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
                description: { type: 'string', description: 'Shown beside the snippet in autocomplete.' }
            },
            additionalProperties: false
        }
    };

    const isStr = (v) => typeof v === 'string';
    const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

    function checkEntry(name, e) {
        if (!isPlain(e)) return 'is not an object';
        const p = e.prefix;
        const prefixes = isStr(p) ? [p] : (Array.isArray(p) ? p : null);
        if (!prefixes || !prefixes.length || !prefixes.every((x) => isStr(x) && x.trim())) return 'needs a prefix (a text, or a list of texts)';
        const b = e.body;
        if (!(isStr(b) || (Array.isArray(b) && b.every(isStr)))) return 'needs a body (a text, or a list of lines)';
        if (e.description != null && !isStr(e.description)) return 'has a description that is not text';
        return null;
    }

    // text -> { ok:true, entries:[{name, prefixes, body, description}], skipped:[{name, reason}] } | { ok:false, error }
    // An empty file counts as no snippets. Entries that cannot work are skipped and named; the rest still work.
    function parseSnippets(text) {
        if (text == null || !String(text).trim()) return { ok: true, entries: [], skipped: [] };
        let obj;
        try { obj = JSON.parse(text); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        if (!isPlain(obj)) return { ok: false, error: 'A snippets file is an object: { "Name": { "prefix": "...", "body": "..." } }' };
        const entries = [], skipped = [];
        Object.keys(obj).forEach((name) => {
            const e = obj[name], why = checkEntry(name, e);
            if (why) { skipped.push({ name, reason: why }); return; }
            entries.push({ name, prefixes: (isStr(e.prefix) ? [e.prefix] : e.prefix).map((x) => x.trim()), body: e.body, description: isStr(e.description) ? e.description : '' });
        });
        return { ok: true, entries, skipped };
    }
    const bodyText = (body) => (Array.isArray(body) ? body.join('\n') : String(body == null ? '' : body));

    // The New Snippet form: add one entry to a language's file text. Returns { ok:true, text } or { ok:false, error }.
    function addSnippetToText(text, f) {
        const name = String(f && f.name || '').trim();
        const prefixes = String(f && f.prefix || '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
        const body = String(f && f.body || '');
        const description = String(f && f.description || '').trim();
        if (!name) return { ok: false, error: 'Give the snippet a name.' };
        if (!prefixes.length) return { ok: false, error: 'Give it a prefix: what you type to get it.' };
        if (!body.trim()) return { ok: false, error: 'Write what the snippet inserts.' };
        let obj = {};
        if (text && String(text).trim()) {
            try { obj = JSON.parse(text); } catch (e) { return { ok: false, error: 'Fix the JSON in the editor first (' + String(e && e.message || e) + ').' }; }
            if (!isPlain(obj)) return { ok: false, error: 'The editor does not hold a snippets object, so nothing was added.' };
        }
        if (Object.prototype.hasOwnProperty.call(obj, name)) return { ok: false, error: 'A snippet named \u201c' + name + '\u201d already exists. Pick another name, or edit it in the file.' };
        const lines = body.replace(/\r\n?/g, '\n').split('\n');
        const entry = { prefix: prefixes.length === 1 ? prefixes[0] : prefixes, body: lines.length === 1 ? lines[0] : lines };
        if (description) entry.description = description;
        // defineProperty, not assignment: obj["__proto__"] = x would set a prototype and silently add nothing
        Object.defineProperty(obj, name, { value: entry, enumerable: true, writable: true, configurable: true });
        return { ok: true, text: JSON.stringify(obj, null, 2), name };
    }

    // One autocomplete item per prefix of each entry.
    function completionItems(entries) {
        const out = [];
        (entries || []).forEach((e) => e.prefixes.forEach((prefix) => out.push({ label: prefix, insertText: bodyText(e.body), detail: e.description || e.name, documentation: bodyText(e.body), name: e.name })));
        return out;
    }

    // Where the typed text starts, so a prefix with a dash or a symbol ("for-each", "#!") replaces what was typed instead of
    // being added after it: the longest tail of the text before the cursor that the label starts with. -1 when none does.
    function prefixTailStart(linePrefix, label) {
        const lp = String(linePrefix || ''), lab = String(label || '').toLowerCase();
        for (let i = 0; i < lp.length; i++) { const tail = lp.slice(i).toLowerCase(); if (tail && lab.startsWith(tail)) return i; }
        return -1;
    }

    function statusText(parsed) {
        if (!parsed.ok) return { kind: 'error', text: 'Not saved: ' + parsed.error };
        const n = parsed.entries.length, s = parsed.skipped;
        const base = n === 0 ? 'No snippets yet.' : n + (n === 1 ? ' snippet' : ' snippets') + ' ready in autocomplete.';
        if (!s.length) return { kind: 'ok', text: base };
        return { kind: 'warn', text: base + ' Skipped: ' + s.slice(0, 3).map((x) => '\u201c' + x.name + '\u201d ' + x.reason).join('; ') + (s.length > 3 ? ' (and ' + (s.length - 3) + ' more)' : '') + '.' };
    }

    // The saved text of every language, with parsing remembered per text. io = { load(): object | null, save(object) }.
    function createStore(io) {
        let texts = Object.create(null); // no prototype: a language called "__proto__" or "constructor" is just a key
        const cache = new Map(); // language -> { text, parsed }
        const listeners = new Set();
        const emit = () => listeners.forEach((fn) => { try { fn(); } catch (e) { /* a listener must not break saving */ } });
        function parsedFor(lang) {
            const text = texts[lang] || '';
            const c = cache.get(lang);
            if (c && c.text === text) return c.parsed;
            const parsed = parseSnippets(text);
            cache.set(lang, { text, parsed });
            return parsed;
        }
        const api = {
            reload() {
                let raw = null;
                try { raw = io.load(); } catch (e) { raw = null; }
                const next = Object.create(null);
                if (isPlain(raw)) Object.keys(raw).forEach((l) => { if (isStr(raw[l]) && raw[l].trim()) next[l] = raw[l]; });
                texts = next; cache.clear(); emit();
            },
            text: (lang) => texts[lang] || '',
            // Only text that parses is kept (the last good version stays otherwise). An empty file removes the language.
            setText(lang, text) {
                const parsed = parseSnippets(text);
                if (!parsed.ok) return false;
                if (!String(text).trim() || (parsed.entries.length === 0 && parsed.skipped.length === 0 && String(text).replace(/\s+/g, '') === '{}')) delete texts[lang]; else texts[lang] = String(text);
                cache.delete(lang);
                try { io.save(texts); } catch (e) { /* private mode: it lasts for this page */ }
                emit(); return true;
            },
            entries: (lang) => parsedFor(lang).entries,
            parsed: parsedFor,
            count: (lang) => parsedFor(lang).entries.length,
            languages: () => Object.keys(texts).filter((l) => parsedFor(l).entries.length > 0),
            onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }
        };
        return api;
    }

    const api = { SNIPPET_SCHEMA, parseSnippets, bodyText, addSnippetToText, completionItems, prefixTailStart, statusText, createStore };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof document === 'undefined') return; // Node: rules only

    // ---------------------------------------------------------------------------------------------
    // Browser: storage (per window / profile) and the autocomplete provider
    // ---------------------------------------------------------------------------------------------
    let pendingWin = null;
    const storageKey = (w) => (typeof W.getPrefixedKey === 'function' ? W.getPrefixedKey('snippets', w && w.winId, w && w.isProfile) : 'codemini_snippets');
    const store = createStore({
        load: () => { try { return JSON.parse(localStorage.getItem(storageKey(pendingWin)) || 'null'); } catch (e) { return null; } },
        save: (o) => { const k = storageKey(); if (Object.keys(o).length) localStorage.setItem(k, JSON.stringify(o)); else localStorage.removeItem(k); }
    });
    store.reload();

    // One provider per language. Monaco 0.39 never calls a provider registered for '*' (or { language: '*' }), only for a
    // language by name, so every language Monaco knows gets one, and one is added for any that appears later.
    const providedFor = new Set();
    let listening = false;
    function makeProvider() {
        return {
            provideCompletionItems(model, position) {
                const m = W.monaco, lang = model.getLanguageId();
                const entries = store.entries(lang);
                if (!entries.length) return { suggestions: [] };
                const L = m.languages;
                const word = model.getWordUntilPosition(position);
                const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
                return {
                    suggestions: completionItems(entries).map((it) => {
                        const start = prefixTailStart(line, it.label);
                        const startColumn = start >= 0 ? start + 1 : word.startColumn;
                        return {
                            label: it.label, kind: L.CompletionItemKind.Snippet, insertText: it.insertText,
                            insertTextRules: L.CompletionItemInsertTextRule.InsertAsSnippet,
                            detail: it.detail, documentation: { value: '```\n' + it.documentation + '\n```' },
                            range: { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn, endColumn: position.column },
                            sortText: '0' + it.label
                        };
                    })
                };
            }
        };
    }
    function ensureLanguage(id) {
        const m = W.monaco;
        if (!id || providedFor.has(id) || !m || !m.languages) return;
        providedFor.add(id);
        m.languages.registerCompletionItemProvider(id, makeProvider());
    }
    function ensureProvider() {
        const m = W.monaco;
        if (!m || !m.languages || typeof m.languages.registerCompletionItemProvider !== 'function' || typeof m.languages.getLanguages !== 'function') return false;
        m.languages.getLanguages().forEach((l) => ensureLanguage(l.id));
        if (!listening && m.editor && typeof m.editor.onDidCreateModel === 'function') { m.editor.onDidCreateModel((model) => ensureLanguage(model.getLanguageId())); listening = true; }
        return true;
    }
    (function waitForMonaco() { let waited = 0; const t = setInterval(() => { waited += 300; if (ensureProvider() || waited > 180000) clearInterval(t); }, 300); })();

    // ---------------------------------------------------------------------------------------------
    // Browser: Settings > Snippets
    // ---------------------------------------------------------------------------------------------
    const COMMON = ['javascript', 'typescript', 'python', 'html', 'css', 'json', 'markdown', 'sql', 'php', 'r', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'shell'];
    const LABELS = { javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python', html: 'HTML', css: 'CSS', json: 'JSON', markdown: 'Markdown', sql: 'SQL', php: 'PHP', r: 'R', java: 'Java', c: 'C', cpp: 'C++', csharp: 'C#', go: 'Go', rust: 'Rust', shell: 'Shell' };
    function languageList() {
        const m = W.monaco;
        let langs = [];
        if (m && m.languages && typeof m.languages.getLanguages === 'function') {
            try { langs = m.languages.getLanguages().map((l) => ({ id: l.id, label: (l.aliases && l.aliases[0]) || l.id })); } catch (e) { langs = []; }
        }
        if (!langs.length) langs = COMMON.map((id) => ({ id, label: LABELS[id] || id }));
        COMMON.forEach((id) => { if (!langs.some((l) => l.id === id)) langs.push({ id, label: LABELS[id] || id }); });
        store.languages().forEach((id) => { if (!langs.some((l) => l.id === id)) langs.push({ id, label: id }); });
        const seen = new Set();
        langs = langs.filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)));
        const withSnippets = (l) => store.count(l.id) > 0;
        langs.sort((a, b) => (withSnippets(b) - withSnippets(a)) || a.label.localeCompare(b.label));
        return langs;
    }
    function activeLanguage() {
        try {
            const ed = typeof W.getActiveMonacoEditor === 'function' ? W.getActiveMonacoEditor() : null;
            const model = ed && ed.getModel && ed.getModel();
            const id = model && model.getLanguageId && model.getLanguageId();
            return id && id !== 'plaintext' && id !== 'json' ? id : null;
        } catch (e) { return null; }
    }

    function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    const MODEL_ROOT = 'inmemory://codemini/snippets/';
    const SCHEMA_URI = 'inmemory://codemini/schema/snippets.json';

    let ui = null, pendingLang = null, lastLang = null; // lastLang: reopening Settings returns to the language you were working on
    function setStatus(s) {
        if (!ui) return;
        ui.status.textContent = s.text;
        ui.status.className = 'sn-status sn-' + s.kind;
    }
    function fillLanguages(selected) {
        const list = languageList();
        ui.select.textContent = '';
        list.forEach((l) => {
            const o = document.createElement('option');
            o.value = l.id;
            const c = store.count(l.id);
            o.textContent = l.label + (c ? ' (' + c + ')' : '');
            ui.select.appendChild(o);
        });
        ui.select.value = selected;
        if (ui.select.value !== selected) ui.select.value = list[0] ? list[0].id : '';
    }
    function modelFor(lang) {
        if (ui.models.has(lang)) return ui.models.get(lang);
        const m = W.monaco;
        const uri = m.Uri.parse(MODEL_ROOT + lang + '.json');
        const stale = m.editor.getModel(uri); if (stale) stale.dispose(); // Monaco refuses a second model with the same address
        const text = store.text(lang) || '{}';
        const model = m.editor.createModel(text, 'json', uri);
        if (W.CodeMiniJsonSchemas) W.CodeMiniJsonSchemas.add(SCHEMA_URI, [uri.toString()], SNIPPET_SCHEMA);
        model.onDidChangeContent(() => {
            clearTimeout(ui.timer);
            ui.timer = setTimeout(() => applyModel(lang), 400);
        });
        ui.models.set(lang, model);
        return model;
    }
    // The file in the editor changed: if it is valid JSON it becomes the snippets for that language.
    function applyModel(lang) {
        const model = ui && ui.models.get(lang);
        if (!model) return;
        const text = model.getValue();
        const parsed = parseSnippets(text);
        if (parsed.ok) store.setText(lang, text);
        if (lang === ui.lang) setStatus(statusText(parsed));
        const o = Array.from(ui.select.options).find((x) => x.value === lang);
        if (o) { const label = o.textContent.replace(/ \(\d+\)$/, ''); const c = store.count(lang); o.textContent = label + (c ? ' (' + c + ')' : ''); }
    }
    function showLanguage(lang) {
        if (!ui || !ui.editor || !lang) return;
        ui.lang = lang; lastLang = lang;
        const model = modelFor(lang);
        if (ui.editor.getModel() !== model) ui.editor.setModel(model);
        setStatus(statusText(parseSnippets(model.getValue())));
    }
    function createEditor() {
        const m = W.monaco;
        if (!m || !m.editor || !m.Uri) return false;
        ui.editor = m.editor.create(ui.host, { language: 'json', value: '{}', automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, tabSize: 2, fontSize: 13, lineNumbers: 'on', wordWrap: 'on', padding: { top: 6, bottom: 6 } });
        return true;
    }
    function ensureEditor() {
        if (ui.editor) return true;
        if (!createEditor()) {
            setStatus({ kind: 'warn', text: 'Loading the editor\u2026' });
            if (!ui.waiting) {
                ui.waiting = setInterval(() => { if (!ui) { return; } if (createEditor()) { clearInterval(ui.waiting); ui.waiting = null; showLanguage(ui.select.value); } }, 300);
            }
            return false;
        }
        return true;
    }
    function show() { // the Snippets tab came on screen
        if (!ui) return;
        if (ensureEditor()) { showLanguage(ui.select.value); ui.editor.layout(); }
    }
    function onAdd() {
        const model = ui.models.get(ui.lang);
        if (!model) { ui.formError.textContent = 'The editor is still loading.'; ui.formError.hidden = false; return; }
        const r = addSnippetToText(model.getValue(), { name: ui.name.value, prefix: ui.prefix.value, body: ui.body.value, description: ui.desc.value });
        if (!r.ok) { ui.formError.textContent = r.error; ui.formError.hidden = false; return; }
        ui.formError.hidden = true; ui.formError.textContent = '';
        // Undo stops on both sides, so each added snippet is its own undo step (edits made one after another would merge into one).
        ui.editor.pushUndoStop();
        ui.editor.executeEdits('snippets-form', [{ range: model.getFullModelRange(), text: r.text, forceMoveMarkers: true }]);
        ui.editor.pushUndoStop();
        clearTimeout(ui.timer); applyModel(ui.lang);
        ui.name.value = ''; ui.prefix.value = ''; ui.body.value = ''; ui.desc.value = '';
        if (typeof W.showSuccessToast === 'function') W.showSuccessToast('Added \u201c' + r.name + '\u201d to ' + (ui.select.selectedOptions[0] ? ui.select.selectedOptions[0].textContent.replace(/ \(\d+\)$/, '') : ui.lang) + '.');
    }
    function dispose() {
        if (!ui) return;
        clearTimeout(ui.timer); if (ui.waiting) clearInterval(ui.waiting);
        try { if (ui.editor) ui.editor.dispose(); ui.models.forEach((m) => m.dispose()); } catch (e) { /* already gone */ }
        ui = null;
    }
    function renderSettings(container) {
        const sec = container && container.querySelector('#set-snippets');
        if (!sec || sec.dataset.snWired) return;
        sec.dataset.snWired = '1';
        store.reload(); // this window's own snippets
        ui = { sec, select: sec.querySelector('#snLang'), name: sec.querySelector('#snName'), prefix: sec.querySelector('#snPrefix'), desc: sec.querySelector('#snDesc'), body: sec.querySelector('#snBody'),
            add: sec.querySelector('#snAdd'), formError: sec.querySelector('#snFormError'), host: sec.querySelector('#snEditor'), status: sec.querySelector('#snStatus'), models: new Map(), editor: null, lang: null, timer: null, waiting: null };
        const first = pendingLang || activeLanguage() || lastLang || 'javascript'; pendingLang = null;
        fillLanguages(first);
        ui.select.addEventListener('change', () => showLanguage(ui.select.value));
        ui.add.addEventListener('click', onAdd);
        container.querySelectorAll('[data-tab="snippets"]').forEach((t) => t.addEventListener('click', () => setTimeout(show, 0)));
        const pane = container.closest('.content-pane');
        if (pane) pane._cmDispose = (() => { const prev = pane._cmDispose; return () => { if (prev) prev(); dispose(); }; })();
        if (sec.classList.contains('active') || sec.offsetParent !== null) setTimeout(show, 0);
    }
    // Configure Snippets: open Settings on the Snippets tab, on this language when there is one.
    function open(lang) {
        pendingLang = lang || activeLanguage() || null;
        if (typeof W.openSettingsTab === 'function') W.openSettingsTab('snippets');
        else { const b = document.getElementById('settingsIconItem'); if (b) b.click(); }
        // Settings may already be showing its Snippets tab: switch the language in place.
        setTimeout(() => { if (ui && pendingLang) { fillLanguages(pendingLang); pendingLang = null; show(); } }, 700);
    }

    Object.assign(api, {
        store, renderSettings, open, ensureProvider, entries: store.entries, reload: store.reload,
        reloadFor(winId, isProfile) { pendingWin = winId ? { winId, isProfile: !!isProfile } : null; try { store.reload(); } finally { pendingWin = null; } }
    });
    W.CodeMiniSnippets = api;
})(typeof window !== 'undefined' ? window : globalThis);
