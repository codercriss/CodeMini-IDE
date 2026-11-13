// Keyboard shortcuts: one registry for the app's own shortcuts, so they can be listed and changed in
// Settings > Keybindings.
//
//   Catalog     every rebindable command: id, name, default key(s), where it applies (scope) and when.
//   Overrides   what the user changed, saved per window / profile (window.getPrefixedKey, like every other setting).
//               A command with no override uses its defaults; an empty list means "no shortcut".
//   Dispatcher  ONE capture-phase keydown listener runs the global commands. A key the user set beats a default.
//   Scoped      Notebook Run Cell and Source Control Commit have no handler here: their own code asks
//               CodeMiniKeybindings.matches(event, id), so the key they react to is the user's too.
//
// Notes on keys:
//   - Cmd on a Mac counts as Ctrl (Quick Open already worked that way). A combo is written Ctrl+Shift+Alt+Key.
//   - AltGr (which many keyboard layouts report as Ctrl+Alt) never matches, so typing a character is never a shortcut.
//   - A shortcut needs Ctrl or Alt, or is a function key; a bare letter would fire while you type.
//   - DOM is built with nodes, never HTML strings (tests/html-sinks).
//
// The pure half is exported for Node (tests/keybindings.test.js); the browser half starts after that.
(function (root) {
    'use strict';
    const W = root;

    // ---------------------------------------------------------------------------------------------
    // Pure: key names and combos
    // ---------------------------------------------------------------------------------------------
    const KEY_ALIASES = {
        escape: 'Esc', esc: 'Esc', return: 'Enter', enter: 'Enter', ' ': 'Space', space: 'Space', spacebar: 'Space',
        arrowup: 'Up', up: 'Up', arrowdown: 'Down', down: 'Down', arrowleft: 'Left', left: 'Left', arrowright: 'Right', right: 'Right',
        del: 'Delete', delete: 'Delete', ins: 'Insert', insert: 'Insert', pageup: 'PageUp', pagedown: 'PageDown',
        home: 'Home', end: 'End', tab: 'Tab', backspace: 'Backspace'
    };
    const MOD_ALIASES = { ctrl: 'ctrl', control: 'ctrl', cmd: 'ctrl', command: 'ctrl', meta: 'ctrl', super: 'ctrl', win: 'ctrl', alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift' };
    const CODE_KEYS = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' };
    const F_KEY = /^F([1-9]|1\d|2[0-4])$/;

    // The name of the key pressed, or null for a modifier on its own (Shift, Control, Alt, Meta, CapsLock...).
    // The label on the key wins (so Ctrl+` and Ctrl+B follow the layout); when Alt or a dead key has turned it into
    // something else (Alt+N on a Mac types a tilde), the physical key is used.
    function nameKey(key, code) {
        key = key == null ? '' : String(key);
        if (key === 'Dead' || key === 'Unidentified' || (key.length === 1 && key.charCodeAt(0) > 127)) {
            const m = /^Key([A-Z])$/.exec(code || ''); if (m) return m[1];
            const d = /^Digit(\d)$/.exec(code || ''); if (d) return d[1];
            return CODE_KEYS[code] || null;
        }
        if (key === ' ') return 'Space';
        if (key.length === 1) return key.toUpperCase();
        const alias = KEY_ALIASES[key.toLowerCase()];
        if (alias) return alias;
        if (F_KEY.test(key.toUpperCase())) return key.toUpperCase();
        return null;
    }
    function buildCombo(p) { return [p.ctrl ? 'Ctrl' : null, p.shift ? 'Shift' : null, p.alt ? 'Alt' : null, p.key].filter(Boolean).join('+'); }

    // The canonical combo for a keydown event, or null when it is not a combination (a lone modifier, or AltGr).
    function comboFromEvent(e) {
        if (!e) return null;
        if (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) return null;
        const key = nameKey(e.key, e.code);
        if (!key) return null;
        return buildCombo({ ctrl: !!(e.ctrlKey || e.metaKey), shift: !!e.shiftKey, alt: !!e.altKey, key });
    }

    // "ctrl + shift + f", "Cmd+F1", "Ctrl++" -> { ctrl, shift, alt, key }, or null.
    function parseCombo(str) {
        if (typeof str !== 'string') return null;
        let rest = str.trim().replace(/\s*\+\s*/g, '+');
        const p = { ctrl: false, shift: false, alt: false, key: '' };
        for (;;) {
            const i = rest.indexOf('+');
            if (i <= 0) break;
            const mod = MOD_ALIASES[rest.slice(0, i).toLowerCase()];
            if (!mod) break;
            p[mod] = true; rest = rest.slice(i + 1);
        }
        if (!rest) return null;
        const key = nameKey(rest.length === 1 ? rest : (KEY_ALIASES[rest.toLowerCase()] || rest), '');
        if (!key) return null;
        p.key = key;
        return p;
    }
    function normalizeCombo(str) { const p = parseCombo(str); return p ? buildCombo(p) : null; }
    function formatCombo(str) { const c = normalizeCombo(str); return c ? c.replace(/\+(?=.)/g, ' + ') : ''; }

    // Keys that type nothing on their own: Shift with one of these (Shift+Enter) cannot fire while the user types a character.
    const NON_PRINTING = ['Enter', 'Tab', 'Esc', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right'];
    // Is this a combo the dispatcher may use? A bare letter, or Shift+letter, would fire while the user types.
    function validateBinding(str) {
        const p = parseCombo(str);
        if (!p) return { ok: false, message: 'That is not a key combination.' };
        if (!(p.ctrl || p.alt || F_KEY.test(p.key) || (p.shift && NON_PRINTING.includes(p.key)))) return { ok: false, message: 'Add Ctrl or Alt (or use a function key): a shortcut with only a letter or Shift would fire while you type.' };
        return { ok: true, message: '' };
    }

    const RESERVED = ['Ctrl+N', 'Ctrl+Shift+N', 'Ctrl+T', 'Ctrl+Shift+T', 'Ctrl+W', 'Ctrl+Shift+W', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+PageUp', 'Ctrl+PageDown', 'Alt+F4', 'Ctrl+Q', 'Ctrl+Shift+Q'];
    // The browser keeps these for itself (an installed app can receive some of them), which is why New File is Alt+N.
    function reservedWarning(str) {
        const c = normalizeCombo(str);
        return c && RESERVED.includes(c) ? `The browser keeps ${c} for itself, so it may never reach CodeMini (an installed app can receive some of these). Alt+N and Alt+W are the defaults for this reason.` : null;
    }
    // Many layouts report AltGr as Ctrl+Alt: such a combo would also catch typing a character.
    function altGrWarning(str) {
        const p = parseCombo(str);
        return p && p.ctrl && p.alt && !p.shift ? 'Ctrl+Alt is AltGr on many keyboards, and the app ignores AltGr so you can still type characters: this shortcut will not fire there.' : null;
    }

    // ---------------------------------------------------------------------------------------------
    // Pure: the catalog of rebindable commands
    // ---------------------------------------------------------------------------------------------
    // scope: 'global' commands run from the dispatcher; the others are asked for by their own feature's handler.
    const CATALOG = [
        { id: 'file.save', category: 'File Management', name: 'Save File', description: 'Save the active file or notebook', defaults: ['Ctrl+S'], scope: 'global', when: 'Always' },
        { id: 'file.new', category: 'File Management', name: 'New File', description: 'Create a new file in the current folder', defaults: ['Alt+N'], scope: 'global', when: 'Always' },
        { id: 'tab.close', category: 'File Management', name: 'Close Tab', description: 'Close the active tab', defaults: ['Alt+W'], scope: 'global', when: 'Always' },
        { id: 'notebook.runCell', category: 'Execution', name: 'Run Cell', description: 'Run the selected notebook cell', defaults: ['Ctrl+Enter'], scope: 'notebook', when: 'A notebook is open' },
        { id: 'notebook.runAdvance', category: 'Execution', name: 'Run Cell and Move On', description: 'Run the selected cell and select the next one', defaults: ['Shift+Enter'], scope: 'notebook', when: 'A notebook is open' },
        { id: 'quickOpen.files', category: 'Navigation & Formatting', name: 'Quick Open', description: 'Find a file by name', defaults: ['Ctrl+P'], scope: 'global', when: 'Always' },
        { id: 'quickOpen.commands', category: 'Navigation & Formatting', name: 'Command Palette', description: 'Run any command by name', defaults: ['F1', 'Ctrl+Shift+P'], scope: 'global', when: 'Always' },
        { id: 'view.toggleSidebar', category: 'Navigation & Formatting', name: 'Toggle Sidebar', description: 'Show or hide the Explorer sidebar', defaults: ['Ctrl+B'], scope: 'global', when: 'Not while typing in a Word document' },
        { id: 'view.toggleTerminal', category: 'Navigation & Formatting', name: 'Open Terminal', description: 'Open the integrated terminal', defaults: ['Ctrl+`'], scope: 'global', when: 'Always' },
        { id: 'view.searchFiles', category: 'Navigation & Formatting', name: 'Search Across Files', description: 'Open search in the sidebar', defaults: ['Ctrl+Shift+F'], scope: 'global', when: 'Always' },
        { id: 'editor.format', category: 'Navigation & Formatting', name: 'Format Document', description: 'Format the active file or notebook', defaults: ['Shift+Alt+F'], scope: 'global', when: 'Always' },
        { id: 'scm.commit', category: 'Source Control', name: 'Commit', description: 'Commit the staged changes', defaults: ['Ctrl+Enter'], scope: 'scm', when: 'The commit message box is focused' }
    ];

    // Commands in different scopes may share a key; a global command shadows every other scope.
    const scopesOverlap = (a, b) => a === b || a === 'global' || b === 'global';

    // ---------------------------------------------------------------------------------------------
    // Pure: the registry (a store is { load(): object | null, save(object) })
    // ---------------------------------------------------------------------------------------------
    function createRegistry(store) {
        const commands = new Map();          // id -> { ...catalog entry, run?, test? }
        let overrides = {};                  // id -> [combo]  (only what the user changed)
        let index = new Map();               // combo -> [ids], user-set first
        let recording = null;                // () => boolean: is a recorder open and still on screen
        const listeners = new Set();

        const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
        function cleanList(list) {
            const out = [];
            (Array.isArray(list) ? list : []).forEach((s) => { const c = normalizeCombo(s); if (c && validateBinding(c).ok && !out.includes(c)) out.push(c); });
            return out;
        }
        function rebuild() {
            index = new Map();
            const ids = Array.from(commands.keys());
            const ordered = ids.filter((id) => has(id)).concat(ids.filter((id) => !has(id)));
            ordered.forEach((id) => bindings(id).forEach((c) => { if (!index.has(c)) index.set(c, []); index.get(c).push(id); }));
        }
        const has = (id) => Object.prototype.hasOwnProperty.call(overrides, id);
        function bindings(id) {
            const c = commands.get(id);
            if (!c) return [];
            return has(id) ? overrides[id].slice() : c.defaults.slice();
        }
        function emit() { listeners.forEach((fn) => { try { fn(); } catch (e) { /* a listener must not break saving */ } }); }
        function persist() { try { store.save(overrides); } catch (e) { /* private mode: it lasts for this page */ } }

        const api = {
            register(cmd) {
                commands.set(cmd.id, Object.assign({ scope: 'global', defaults: [], when: 'Always' }, cmd, { defaults: cleanList(cmd.defaults) }));
                rebuild();
            },
            commands: () => Array.from(commands.values()),
            get: (id) => commands.get(id) || null,
            bindings,
            isCustom: has,
            // The first binding, as the palette shows it ("Alt+N"); empty when the command has none.
            label: (id) => bindings(id)[0] || '',
            reload() {
                let raw = null;
                try { raw = store.load(); } catch (e) { raw = null; }
                const next = {};
                if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                    Object.keys(raw).forEach((id) => { if (commands.has(id) && Array.isArray(raw[id])) { const l = cleanList(raw[id]); if (!sameList(l, commands.get(id).defaults)) next[id] = l; } });
                }
                overrides = next; rebuild(); emit();
            },
            // combos: an array (empty = no shortcut) or null (back to the defaults).
            setBinding(id, combos) {
                const c = commands.get(id); if (!c) return false;
                if (combos === null) delete overrides[id];
                else {
                    const l = cleanList(combos);
                    if (sameList(l, c.defaults)) delete overrides[id]; else overrides[id] = l;
                }
                persist(); rebuild(); emit(); return true;
            },
            reset(id) { return api.setBinding(id, null); },
            resetAll() { overrides = {}; persist(); rebuild(); emit(); },
            customCount: () => Object.keys(overrides).length,
            // Other commands on this key whose scope overlaps (their shortcut would shadow or be shadowed).
            conflicts(id, combo) {
                const me = commands.get(id), c = normalizeCombo(combo);
                if (!me || !c) return [];
                return Array.from(commands.values()).filter((o) => o.id !== id && scopesOverlap(me.scope, o.scope) && bindings(o.id).includes(c)).map((o) => o.id);
            },
            matches(e, id) { const c = comboFromEvent(e); return !!c && bindings(id).includes(c); },
            setRecording(fn) { recording = fn; },
            isRecording() { if (!recording) return false; if (!recording()) { recording = null; return false; } return true; },
            // Runs the first global command bound to this event whose condition holds. Returns whether one ran.
            handle(e) {
                if (api.isRecording()) return false;
                const combo = comboFromEvent(e);
                if (!combo) return false;
                const ids = index.get(combo);
                if (!ids) return false;
                for (const id of ids) {
                    const c = commands.get(id);
                    if (!c || c.scope !== 'global' || typeof c.run !== 'function') continue;
                    if (typeof c.test === 'function' && !c.test(e)) continue;
                    e.preventDefault(); e.stopPropagation();
                    c.run(e);
                    return true;
                }
                return false;
            },
            onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
        };
        return api;
    }

    const api = { CATALOG, RESERVED, nameKey, comboFromEvent, parseCombo, normalizeCombo, formatCombo, validateBinding, reservedWarning, altGrWarning, scopesOverlap, createRegistry };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof document === 'undefined') return; // Node: rules only

    // ---------------------------------------------------------------------------------------------
    // Browser: the commands' actions (each one drives a control the app already has)
    // ---------------------------------------------------------------------------------------------
    const click = (id) => () => { const n = document.getElementById(id); if (n) n.click(); };
    const activeTabEl = () => {
        const g = document.getElementById(typeof activeGroupId !== 'undefined' && activeGroupId ? activeGroupId : 'editorGroup1');
        return g ? g.querySelector('.tab.active') : document.querySelector('.tab.active');
    };
    const RUN = {
        'file.save': () => { if (typeof W.performActiveSave === 'function') W.performActiveSave(); },
        'file.new': click('menuNewFile'),
        'tab.close': () => { const t = activeTabEl(); const b = t && t.querySelector('.tab-close'); if (b) b.click(); },
        'quickOpen.files': () => W.openQuickOpen && W.openQuickOpen(),
        'quickOpen.commands': () => W.openQuickOpen && W.openQuickOpen('>'),
        'view.toggleSidebar': click('folderIconItem'),
        'view.toggleTerminal': click('terminalIconItem'),
        'view.searchFiles': click('searchIconItem'),
        // Monaco files use Monaco's own formatter; notebooks reuse the toolbar's Format button.
        'editor.format': () => {
            const t = activeTabEl();
            if (t && (t.dataset.type === 'notebook' || t.dataset.type === 'java-notebook')) {
                const a = document.querySelector('.tb-format'); if (a) a.click();
                const b = document.querySelector('.jtb-format'); if (b) b.click();
            } else if (typeof W.getActiveMonacoEditor === 'function') {
                const ed = W.getActiveMonacoEditor();
                if (ed) { const act = ed.getAction('editor.action.formatDocument'); if (act) act.run(); }
            }
        }
    };
    // Ctrl+B is also Bold inside the Word-style document editor, which keeps it.
    const TEST = { 'view.toggleSidebar': (e) => !(e.target && e.target.closest && e.target.closest('.doc-content')) };

    // ---------------------------------------------------------------------------------------------
    // Browser: storage (per window / profile) and the dispatcher
    // ---------------------------------------------------------------------------------------------
    let pendingWin = null; // { winId, isProfile } while a window switch reloads: the active window may not be updated yet
    const storageKey = (w) => (typeof W.getPrefixedKey === 'function' ? W.getPrefixedKey('keybindings', w && w.winId, w && w.isProfile) : 'codemini_keybindings');
    const registry = createRegistry({
        load: () => { try { return JSON.parse(localStorage.getItem(storageKey(pendingWin)) || 'null'); } catch (e) { return null; } },
        save: (o) => {
            const k = storageKey();
            if (Object.keys(o).length) localStorage.setItem(k, JSON.stringify(o)); else localStorage.removeItem(k);
        }
    });
    CATALOG.forEach((c) => registry.register(Object.assign({}, c, RUN[c.id] ? { run: RUN[c.id] } : {}, TEST[c.id] ? { test: TEST[c.id] } : {})));
    registry.reload();
    // Captured so neither Monaco nor the browser (Print, Save page) gets the key first.
    document.addEventListener('keydown', (e) => { registry.handle(e); }, true);

    // ---------------------------------------------------------------------------------------------
    // Browser: Settings > Keybindings
    // ---------------------------------------------------------------------------------------------
    function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    function icon(name) { const i = document.createElement('i'); i.className = name; return i; }
    function btn(act, ic, title) {
        const b = el('button', 'kb-btn'); b.type = 'button'; b.dataset.kbAct = act; b.title = title; b.setAttribute('aria-label', title);
        b.appendChild(icon(ic)); return b;
    }
    const nameOf = (id) => { const c = registry.get(id); return c ? c.name : id; };

    // Notes under a row for a combo: conflicts, browser-reserved, AltGr.
    function notesFor(id, combo) {
        const out = [];
        if (!combo) return out;
        const others = registry.conflicts(id, combo);
        if (others.length) out.push('Also used by ' + others.map(nameOf).join(', '));
        const r = reservedWarning(combo); if (r) out.push(r);
        const g = altGrWarning(combo); if (g) out.push(g);
        return out;
    }
    function buildRow(c) {
        const row = el('div', 'settings-item kb-row'); row.dataset.kbId = c.id;
        const info = el('div', 'settings-item-info');
        info.appendChild(el('strong', '', c.name));
        info.appendChild(el('span', '', c.description));
        const meta = el('div', 'kb-meta');
        meta.appendChild(document.createTextNode('When: ' + c.when + ' \u00b7 '));
        const src = el('span', 'kb-source' + (registry.isCustom(c.id) ? ' kb-user' : ''), registry.isCustom(c.id) ? 'User' : 'Default');
        meta.appendChild(src);
        info.appendChild(meta);
        const control = el('div', 'settings-control kb-control');
        const keys = el('div', 'kb-keys');
        const list = registry.bindings(c.id);
        if (!list.length) keys.appendChild(el('span', 'kb-none', 'Not set'));
        list.forEach((k, i) => {
            if (i) keys.appendChild(el('span', 'kb-or', 'or'));
            keys.appendChild(el('span', 'kbd-badge', formatCombo(k)));
        });
        const acts = el('div', 'kb-actions');
        acts.appendChild(btn('edit', 'ri-pencil-line', 'Change shortcut for ' + c.name));
        if (list.length) acts.appendChild(btn('clear', 'ri-close-line', 'Remove shortcut for ' + c.name));
        if (registry.isCustom(c.id)) acts.appendChild(btn('reset', 'ri-restart-line', 'Reset ' + c.name + ' to its default'));
        control.append(keys, acts);
        row.append(info, control);
        // Conflicts are shown for what is bound now, not only while editing.
        const notes = []; list.forEach((k) => notesFor(c.id, k).forEach((n) => { if (!notes.includes(n)) notes.push(n); }));
        if (notes.length) { const n = el('div', 'kb-note'); n.textContent = notes.join(' \u00b7 '); row.appendChild(n); }
        return row;
    }

    let rec = null; // { id, row, combo, el, text, noteEl, confirmBtn, onKey }
    function stopRecording() {
        if (!rec) return;
        document.removeEventListener('keydown', rec.onKey, true);
        rec = null;
    }
    function refreshRows(host) {
        const h = host || document.getElementById('kbRows'); if (!h) return;
        renderRows(h);
    }
    function previewText(combo, mods) { return combo ? formatCombo(combo) : (mods || 'Press desired key combination'); }
    function updateRecorder() {
        if (!rec) return;
        const v = rec.combo ? validateBinding(rec.combo) : { ok: false, message: '' };
        rec.text.textContent = previewText(rec.combo, rec.mods);
        rec.text.classList.toggle('kb-rec-empty', !rec.combo);
        const notes = rec.combo ? (v.ok ? notesFor(rec.id, rec.combo) : [v.message]) : [];
        rec.noteEl.textContent = notes.join(' \u00b7 ');
        rec.noteEl.classList.toggle('kb-note-error', !!rec.combo && !v.ok);
        rec.noteEl.hidden = !notes.length;
        rec.confirmBtn.disabled = !(rec.combo && v.ok);
    }
    function confirmRecording() {
        if (!rec || !rec.combo || !validateBinding(rec.combo).ok) return;
        const id = rec.id, combo = rec.combo;
        stopRecording();
        registry.setBinding(id, [combo]);
    }
    function startRecording(row, id) {
        if (rec) { stopRecording(); refreshRows(); row = document.querySelector(`#kbRows .kb-row[data-kb-id="${id}"]`); if (!row) return; }
        const control = row.querySelector('.kb-control'), keys = row.querySelector('.kb-keys'), acts = row.querySelector('.kb-actions');
        keys.textContent = ''; acts.textContent = '';
        const box = el('div', 'kb-recorder'); box.tabIndex = 0; box.setAttribute('role', 'textbox'); box.setAttribute('aria-label', 'Press the new shortcut, then Enter');
        const text = el('span', 'kb-rec-text kb-rec-empty', 'Press desired key combination');
        box.appendChild(text); keys.appendChild(box);
        const ok = btn('confirm', 'ri-check-line', 'Save this shortcut (Enter)'); ok.disabled = true;
        const no = btn('cancel', 'ri-close-line', 'Cancel (Esc)');
        acts.append(ok, no);
        let noteEl = row.querySelector('.kb-note');
        if (!noteEl) { noteEl = el('div', 'kb-note'); row.appendChild(noteEl); }
        noteEl.hidden = true; noteEl.textContent = '';
        const onKey = (e) => {
            if (!rec) return;
            e.preventDefault(); e.stopPropagation();
            const bare = !(e.ctrlKey || e.metaKey || e.altKey || e.shiftKey);
            if (bare && e.key === 'Escape') { stopRecording(); refreshRows(); return; }
            if (bare && e.key === 'Enter') { confirmRecording(); return; }
            const combo = comboFromEvent(e);
            if (!combo) { // only modifiers so far: show them as they are held
                rec.combo = null;
                rec.mods = [e.ctrlKey || e.metaKey ? 'Ctrl' : null, e.shiftKey ? 'Shift' : null, e.altKey ? 'Alt' : null].filter(Boolean).join(' + ');
                rec.mods = rec.mods ? rec.mods + ' + \u2026' : '';
                updateRecorder(); return;
            }
            rec.combo = combo; updateRecorder();
        };
        rec = { id, row, combo: null, mods: '', el: box, text, noteEl, confirmBtn: ok, onKey };
        registry.setRecording(() => !!(rec && rec.el.isConnected)); // a closed Settings tab ends it: shortcuts must never stay off
        document.addEventListener('keydown', onKey, true);
        box.focus();
    }

    function renderRows(host) {
        host.textContent = '';
        let last = null;
        registry.commands().forEach((c) => {
            if (c.category !== last) { host.appendChild(el('h3', 'settings-category-title', c.category)); last = c.category; }
            host.appendChild(buildRow(c));
        });
    }
    let wiredHost = null;
    function renderSettings(container) {
        const host = container && container.querySelector('#kbRows');
        if (!host) return;
        registry.reload(); // this window's own shortcuts
        renderRows(host);
        const resetAll = container.querySelector('#kbResetAll');
        if (resetAll && !resetAll.dataset.kbWired) {
            resetAll.dataset.kbWired = '1';
            resetAll.addEventListener('click', () => {
                if (!registry.customCount()) { if (typeof W.showSuccessToast === 'function') W.showSuccessToast('Every shortcut is already at its default.'); return; }
                if (typeof W.showCustomModal !== 'function') { registry.resetAll(); return; }
                W.showCustomModal({ title: 'Reset all shortcuts', text: 'Every shortcut goes back to its default.', submitText: 'Reset all' }, () => {
                    registry.resetAll();
                    if (typeof closeGenModal === 'function') closeGenModal();
                    if (typeof W.showSuccessToast === 'function') W.showSuccessToast('Shortcuts reset.');
                });
            });
        }
        if (host.dataset.kbWired !== '1') {
            host.dataset.kbWired = '1';
            host.addEventListener('click', (e) => {
                const b = e.target.closest('[data-kb-act]'); if (!b) return;
                const row = b.closest('.kb-row'); const id = row && row.dataset.kbId; if (!id) return;
                const act = b.dataset.kbAct;
                if (act === 'edit') startRecording(row, id);
                else if (act === 'confirm') confirmRecording();
                else if (act === 'cancel') { stopRecording(); refreshRows(host); }
                else if (act === 'clear') registry.setBinding(id, []);
                else if (act === 'reset') registry.reset(id);
            });
        }
        wiredHost = host;
    }
    registry.onChange(() => { const h = document.getElementById('kbRows'); if (h && h.isConnected && !rec) renderRows(h); });

    Object.assign(api, {
        registry, renderSettings, startRecording,
        matches: registry.matches, bindings: registry.bindings, label: registry.label, reload: registry.reload,
        handle: registry.handle,
        // A window switch: read that window's shortcuts (settings-profile.js's reloadSettings calls this).
        reloadFor(winId, isProfile) { pendingWin = winId ? { winId, isProfile: !!isProfile } : null; try { registry.reload(); } finally { pendingWin = null; } }
    });
    W.CodeMiniKeybindings = api;
})(typeof window !== 'undefined' ? window : globalThis);
