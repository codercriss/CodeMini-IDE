// Settings (JSON): every setting as one JSON file you can read, search and edit in a code editor.
//
//   What it shows   every setting with the value it has now, in the order of the default list (window.getDefaultSettings).
//                   Security settings (isolation, Workspace Trust) are NOT in it: they stay in Settings > Security, where
//                   they explain what they do, so a pasted file can never loosen them.
//   Checks          a JSON schema built from the Settings screen's own controls (type, allowed options, number range) puts
//                   squiggles under a wrong value or an unknown name while you type.
//   Saving          Ctrl+S (or File > Save) applies it. Nothing is applied while there is a problem, so a half-edited file
//                   cannot change half your settings. Only the settings YOU changed in the file are applied (compared with
//                   what it showed when it opened), so changing another setting in the Settings screen meanwhile is not
//                   undone; a setting you delete from the file is left as it is.
//   The tab         a virtual "settings.json" Monaco tab with no file behind it: autosave never touches it.
//
// The pure half is exported for Node (tests/settings-json.test.js); the browser half starts after that.
// DOM is built with nodes, never HTML strings (tests/html-sinks).
(function (root) {
    'use strict';
    const W = root;

    // ---------------------------------------------------------------------------------------------
    // Pure
    // ---------------------------------------------------------------------------------------------
    const isSecurity = (key) => /^(isolation|workspaceTrust)/.test(key) || key === 'syncProfileSettings';
    const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const SCALARS = ['boolean', 'number', 'string'];

    // The document: each default setting, in order, with its current value when that has the right type.
    function buildDocument(defaults, current) {
        const out = {};
        Object.keys(defaults || {}).forEach((k) => {
            if (isSecurity(k) || !SCALARS.includes(typeof defaults[k])) return;
            const c = current ? current[k] : undefined;
            out[k] = (c !== undefined && typeof c === typeof defaults[k]) ? c : defaults[k];
        });
        return out;
    }

    // descriptors: [{ key, kind: 'checkbox' | 'select' | 'number' | 'text', options?, min?, max?, title?, description? }]
    function buildSchema(defaults, descriptors) {
        const byKey = {};
        (descriptors || []).forEach((d) => { if (!byKey[d.key]) byKey[d.key] = d; });
        const properties = {};
        Object.keys(defaults || {}).forEach((k) => {
            if (isSecurity(k) || !SCALARS.includes(typeof defaults[k])) return;
            const type = typeof defaults[k], d = byKey[k] || {};
            const p = { type, default: defaults[k] };
            if (d.title || d.description) p.description = [d.title, d.description].filter(Boolean).join('. ');
            if (d.kind === 'select' && Array.isArray(d.options) && type !== 'boolean') {
                const opts = type === 'number' ? d.options.map(Number).filter((n) => Number.isFinite(n)) : d.options;
                if (opts.length) p.enum = opts;
            }
            if (type === 'number') { if (Number.isFinite(d.min)) p.minimum = d.min; if (Number.isFinite(d.max)) p.maximum = d.max; }
            properties[k] = p;
        });
        return { type: 'object', description: 'CodeMini settings. Press Ctrl+S to apply.', properties, additionalProperties: false };
    }

    // Checks the text against the schema and works out what changed against `baseline` (what the file showed when it opened).
    // -> { ok:false, error } for text that is not a settings object, or { ok, problems:[{key,message}], changes:{key:value} }.
    function validateDocument(text, schema, baseline) {
        let obj;
        try { obj = JSON.parse(text); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        if (!isPlain(obj)) return { ok: false, error: 'settings.json is an object: { "setting": value }.' };
        const props = (schema && schema.properties) || {};
        const problems = [], changes = {};
        Object.keys(obj).forEach((k) => {
            const p = props[k], v = obj[k];
            if (!p) { problems.push({ key: k, message: isSecurity(k) ? 'is a security setting: change it in Settings > Security.' : 'is not a CodeMini setting.' }); return; }
            if (typeof v !== p.type) { problems.push({ key: k, message: 'must be ' + (p.type === 'boolean' ? 'true or false' : p.type === 'number' ? 'a number' : 'text') + '.' }); return; }
            if (p.enum && !p.enum.includes(v)) { problems.push({ key: k, message: 'must be one of ' + p.enum.map((x) => JSON.stringify(x)).join(', ') + '.' }); return; }
            if (p.type === 'number' && ((p.minimum != null && v < p.minimum) || (p.maximum != null && v > p.maximum))) {
                problems.push({ key: k, message: 'must be ' + (p.minimum != null && p.maximum != null ? 'between ' + p.minimum + ' and ' + p.maximum : p.minimum != null ? 'at least ' + p.minimum : 'at most ' + p.maximum) + '.' }); return;
            }
            if (!baseline || v !== baseline[k]) changes[k] = v;
        });
        return { ok: problems.length === 0, problems, changes };
    }

    function summarize(result) {
        if (!result.ok && result.error) return { kind: 'error', text: 'Not applied: ' + result.error, problems: [] };
        if (result.problems.length) return { kind: 'error', text: 'Not applied: ' + result.problems.length + (result.problems.length === 1 ? ' problem' : ' problems') + '. Fix it and save again.', problems: result.problems.slice(0, 4) };
        const n = Object.keys(result.changes).length;
        return { kind: 'ok', text: n === 0 ? 'Nothing changed.' : 'Applied ' + n + (n === 1 ? ' setting.' : ' settings.'), problems: [] };
    }

    const api = { isSecurity, buildDocument, buildSchema, validateDocument, summarize };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof document === 'undefined') return; // Node: rules only

    // ---------------------------------------------------------------------------------------------
    // Browser
    // ---------------------------------------------------------------------------------------------
    const MODEL_URI = 'inmemory://codemini/settings.json';
    const SCHEMA_URI = 'inmemory://codemini/schema/settings.json';
    const KIND = 'settings-json';
    function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    const toast = (m) => { if (typeof W.showSuccessToast === 'function') W.showSuccessToast(m); };
    const isVirtual = (tab) => !!(tab && tab.dataset && tab.dataset.virtual === KIND);
    const existing = () => Array.from(document.querySelectorAll('.tab')).find(isVirtual) || null;
    function waitFor(fn, ms) {
        return new Promise((resolve) => {
            const t0 = Date.now();
            (function poll() { let v = null; try { v = fn(); } catch (e) { v = null; } if (v) { resolve(v); return; } if (Date.now() - t0 > ms) { resolve(null); return; } setTimeout(poll, 100); })();
        });
    }

    function banner(pane) {
        const b = el('div', 'sj-banner'); b.setAttribute('role', 'status');
        const i = document.createElement('i'); i.className = 'ri-information-line';
        const text = el('span', 'sj-text', 'Changes apply on save (Ctrl+S). Security settings are not in this file: change them in Settings > Security.');
        const state = el('span', 'sj-state');
        const problems = el('div', 'sj-problems'); problems.hidden = true;
        const head = el('div', 'sj-head'); head.append(i, text, state);
        b.append(head, problems);
        pane.insertBefore(b, pane.firstChild);
        return { root: b, state, problems };
    }
    function showResult(tab, s) {
        const b = tab._sjBanner; if (!b) return;
        b.state.textContent = s.kind === 'ok' ? s.text + ' ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : s.text;
        b.state.className = 'sj-state sj-' + s.kind;
        b.problems.textContent = '';
        s.problems.forEach((p) => b.problems.appendChild(el('div', 'sj-problem', '\u201c' + p.key + '\u201d ' + p.message)));
        b.problems.hidden = !s.problems.length;
    }

    // Ctrl+S in the settings.json tab (script.js's performActiveSave sends it here).
    function save(tab) {
        const ed = tab && tab._sjEditor; if (!ed) return false;
        const result = validateDocument(ed.getValue(), tab._sjSchema, tab._sjBase);
        const s = summarize(result);
        showResult(tab, s);
        if (!result.ok) return false;
        Object.keys(result.changes).forEach((k) => { if (typeof W.saveSetting === 'function') W.saveSetting(k, result.changes[k]); else if (W.appSettings) W.appSettings[k] = result.changes[k]; });
        if (typeof W.syncUI === 'function') W.syncUI();
        tab._sjBase = Object.assign({}, tab._sjBase, result.changes);
        tab.classList.remove('unsaved-blink'); tab.classList.add('saved-pulse'); setTimeout(() => tab.classList.remove('saved-pulse'), 1000);
        return true;
    }

    async function open() {
        if (typeof W.getDefaultSettings !== 'function' || !W.appSettings || typeof W.createNewTab !== 'function') { toast('Settings are not ready yet.'); return null; }
        const have = existing();
        if (have) { if (typeof W.switchTab === 'function') W.switchTab(have.dataset.target); return have; }
        const defaults = W.getDefaultSettings();
        const descriptors = typeof W.getSettingsDescriptors === 'function' ? W.getSettingsDescriptors() : [];
        const doc = buildDocument(defaults, W.appSettings);
        W.createNewTab('settings.json', 'ri-braces-line', false, JSON.stringify(doc, null, 2) + '\n', 'monaco', null);
        const group = document.getElementById(typeof activeGroupId !== 'undefined' && activeGroupId ? activeGroupId : 'editorGroup1') || document.getElementById('editorGroup1');
        const tab = group && group.querySelector('.tab.active');
        if (!tab) return null;
        tab.dataset.virtual = KIND;
        if (typeof W.updateOpenedTabsRegistry === 'function') W.updateOpenedTabsRegistry(); // the session was saved when the tab was made, before it was marked: save it again so a reload brings it back
        tab._sjBase = doc; tab._sjSchema = buildSchema(defaults, descriptors);
        const pane = document.getElementById(tab.dataset.target);
        if (!pane) return tab;
        tab._sjBanner = banner(pane);
        // The Monaco editor appears a moment later (it loads on demand): give it the schema-checked model.
        const ed = await waitFor(() => W.monaco && W.monaco.editor && typeof W.monaco.editor.getEditors === 'function' && W.monaco.editor.getEditors().find((e) => pane.contains(e.getContainerDomNode())), 30000);
        if (!ed) return tab;
        const m = W.monaco, old = ed.getModel();
        const stale = m.editor.getModel(m.Uri.parse(MODEL_URI)); if (stale) stale.dispose(); // Monaco refuses a second model with the same address
        const model = m.editor.createModel(JSON.stringify(doc, null, 2) + '\n', 'json', m.Uri.parse(MODEL_URI));
        if (W.CodeMiniJsonSchemas) W.CodeMiniJsonSchemas.add(SCHEMA_URI, [model.uri.toString()], tab._sjSchema);
        ed.setModel(model);
        if (old) old.dispose();
        tab.classList.remove('unsaved-blink'); // the first content event belongs to loading, not to the user
        tab._sjEditor = ed; tab._sjModel = model;
        // Closing the tab frees the editor and this model: the app's pane teardown disposes an editor with its current model.
        return tab;
    }

    Object.assign(api, { open, save, isVirtual, existing });
    W.CodeMiniSettingsJson = api;
})(typeof window !== 'undefined' ? window : globalThis);
