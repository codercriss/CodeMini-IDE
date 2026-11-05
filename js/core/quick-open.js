// ==========================================
// quick-open.js
// ==========================================
// The top search island ("Workspace" box in the title bar), now a keyboard-first Quick Open:
//   Ctrl+P (Cmd+P)   open it            F1 / Ctrl+Shift+P   open it in command mode (">")
//   >  commands      :  go to line      @  symbols in this file      #  workspaces
//   Up / Down move, Enter opens, Alt+Enter opens to the side, Esc closes.
// Matching is fuzzy ("sapp" finds src/app.js), the empty box lists recently opened files first, and
// a name:line suffix ("app.js:42") opens the file at that line.
//
// The first half is pure (matching, ranking, query parsing, the recent list) and has no DOM, so
// tests/quick-open.test.js runs it in Node. The second half is the UI. It builds the list with DOM
// calls (textContent), never HTML strings, so a file or folder name can never become markup.
(function (root) {
    'use strict';

    // ---------------------------------------------------------------------------------------------
    // Fuzzy matching. Finds the best way to lay the query's letters over the text, in order, and
    // scores it: consecutive letters and letters that start a word (after / . _ - space, or a
    // camelCase hump) score high, gaps cost. Returns { score, positions } or null.
    const MATCH = 16, CONSECUTIVE = 14, GAP_OPEN = 3, GAP_EXTEND = 1, LEAD_PENALTY_CAP = 6;
    const SEPARATORS = '/\\-_. :';
    function boundaryBonus(text, j) {
        if (j === 0) return 20;
        const prev = text[j - 1], cur = text[j];
        if (SEPARATORS.indexOf(prev) !== -1) return 16;
        if (prev === prev.toLowerCase() && prev !== prev.toUpperCase() && cur === cur.toUpperCase() && cur !== cur.toLowerCase()) return 14;
        return 0;
    }
    function fuzzyMatch(query, text) {
        const qRaw = String(query || '').replace(/\s+/g, '');
        const q = qRaw.toLowerCase();
        const t = String(text || '');
        const m = q.length, n = t.length;
        if (m === 0) return { score: 0, positions: [] };
        if (m > n) return null;
        const lower = t.toLowerCase();
        // Quick reject: the letters must at least occur in order.
        let at = 0;
        for (let i = 0; i < m; i++) { at = lower.indexOf(q[i], at); if (at === -1) return null; at++; }

        const NEG = -1e9;
        const M = new Float64Array(m * n).fill(NEG), G = new Float64Array(m * n).fill(NEG), via = new Int8Array(m * n);
        for (let i = 0; i < m; i++) {
            for (let j = 0; j < n; j++) {
                const k = i * n + j;
                if (lower[j] === q[i]) {
                    const bonus = boundaryBonus(t, j) + (t[j] === qRaw[i] ? 1 : 0);
                    if (i === 0) {
                        M[k] = MATCH + bonus - Math.min(j, LEAD_PENALTY_CAP); via[k] = 0;
                    } else if (j > 0) {
                        const run = M[(i - 1) * n + j - 1] > NEG / 2 ? M[(i - 1) * n + j - 1] + MATCH + CONSECUTIVE + bonus : NEG;
                        const gap = j > 1 && G[(i - 1) * n + j - 2] > NEG / 2 ? G[(i - 1) * n + j - 2] + MATCH + bonus : NEG;
                        if (run >= gap) { M[k] = run; via[k] = 1; } else { M[k] = gap; via[k] = 2; }
                    }
                }
                const prevG = j > 0 ? G[k - 1] - GAP_EXTEND : NEG;
                G[k] = Math.max(prevG, M[k] > NEG / 2 ? M[k] - GAP_OPEN : NEG);
            }
        }
        let best = NEG, bestJ = -1;
        for (let j = 0; j < n; j++) { const s = M[(m - 1) * n + j]; if (s > best) { best = s; bestJ = j; } }
        if (bestJ < 0 || best <= NEG / 2) return null;

        const positions = new Array(m);
        let j = bestJ;
        for (let i = m - 1; i >= 0; i--) {
            positions[i] = j;
            if (i === 0) break;
            const k = i * n + j;
            if (via[k] === 1) { j -= 1; continue; }
            // came across a gap: find the earlier letter whose gap-adjusted score was the best
            let bj = -1, bs = NEG;
            for (let x = 0; x <= j - 2; x++) {
                const s = M[(i - 1) * n + x] - (GAP_OPEN + (j - 2 - x) * GAP_EXTEND);
                if (s > bs) { bs = s; bj = x; }
            }
            j = bj;
        }
        return { score: best - n * 0.05, positions };
    }

    // ---------------------------------------------------------------------------------------------
    // What was typed -> what to do with it.
    function parseQuery(raw) {
        const s = String(raw == null ? '' : raw);
        const lead = s.replace(/^\s+/, '');
        if (lead[0] === '>') return { mode: 'commands', text: lead.slice(1).trim() };
        if (lead[0] === ':') { const m = /^:\s*(\d+)?(?:[:,]\s*(\d+))?/.exec(lead); return { mode: 'line', text: '', line: m && m[1] ? parseInt(m[1], 10) : null, col: m && m[2] ? parseInt(m[2], 10) : null }; }
        if (lead[0] === '@') return { mode: 'symbol', text: lead.slice(1).trim() };
        if (lead[0] === '#') return { mode: 'workspace', text: lead.slice(1).trim() };
        const m = /^(.*?\S):(\d+)(?::(\d+))?\s*$/.exec(lead);
        if (m) return { mode: 'all', text: m[1].trim(), line: parseInt(m[2], 10), col: m[3] ? parseInt(m[3], 10) : null };
        return { mode: 'all', text: lead.trim() };
    }

    // files: [{ id, name, path }]   recents: file ids, most recent first
    // -> [{ file, score, positions }] best first. positions index into file.path.
    function rankFiles(files, query, recents) {
        const q = String(query || '').replace(/\s+/g, '');
        const recentRank = new Map((recents || []).map((id, i) => [id, i]));
        const out = [];
        for (const file of files) {
            const m = fuzzyMatch(q, file.path);
            if (!m) continue;
            let score = m.score;
            if (q) {
                const nameStart = file.path.length - file.name.length;
                const inName = m.positions.filter((p) => p >= nameStart).length;
                if (inName === q.length) score += 50; // the whole query landed in the file name
                const lname = file.name.toLowerCase(), lq = q.toLowerCase();
                if (lname === lq) score += 200; else if (lname.startsWith(lq)) score += 60;
            }
            if (recentRank.has(file.id)) score += Math.max(0, 20 - recentRank.get(file.id) * 2);
            out.push({ file, score, positions: m.positions });
        }
        out.sort((a, b) => (b.score - a.score) || (a.file.path.length - b.file.path.length) || (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0));
        return out;
    }
    // Generic fuzzy filter for commands, workspaces and folders.
    function rankByName(items, query, nameOf) {
        const out = [];
        for (const item of items) {
            const m = fuzzyMatch(query, nameOf(item));
            if (m) out.push({ item, score: m.score, positions: m.positions });
        }
        out.sort((a, b) => (b.score - a.score) || (nameOf(a.item) < nameOf(b.item) ? -1 : 1));
        return out;
    }
    function pushRecent(list, id, max) {
        const out = [id].concat((list || []).filter((x) => x !== id));
        return out.slice(0, max || 20);
    }

    const api = { fuzzyMatch, parseQuery, rankFiles, rankByName, pushRecent };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof document === 'undefined') return; // Node: logic only

    // ---------------------------------------------------------------------------------------------
    // UI
    const RECENT_MAX = 20, SHOW_FILES = 30, SHOW_OTHER = 8, SHOW_EMPTY_FILES = 15;
    const W = typeof window !== 'undefined' ? window : root;
    W.CodeMiniQuickOpen = api;

    // The icon the Explorer gives a folder and a workspace alike (see createFileElement in app.js).
    const FOLDER_ICON = 'ri-folder-2-line file-icon icon-folder';
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    // Text with the matched letters wrapped in <b>, built from nodes so the text stays text.
    function highlighted(text, positions, offset) {
        const frag = document.createDocumentFragment();
        const hit = new Set((positions || []).map((p) => p - (offset || 0)));
        let run = '', runHit = false;
        const flush = () => { if (!run) return; if (runHit) frag.appendChild(el('b', 'qo-hl', run)); else frag.appendChild(document.createTextNode(run)); run = ''; };
        for (let i = 0; i < text.length; i++) {
            const h = hit.has(i);
            if (h !== runHit) { flush(); runHit = h; }
            run += text[i];
        }
        flush();
        return frag;
    }
    // getFileIconHTML returns fixed markup chosen from the file extension (the file name is never put into
    // it), so parsing its result is safe; DOMParser keeps it out of any innerHTML assignment.
    function fileIcon(name) {
        const wrap = el('span', 'qo-icon');
        let markup = '';
        try { markup = typeof W.getFileIconHTML === 'function' ? W.getFileIconHTML(name) : ''; } catch (e) { markup = ''; }
        if (markup) {
            const doc = new DOMParser().parseFromString(markup, 'text/html');
            Array.from(doc.body.childNodes).forEach((n) => wrap.appendChild(document.importNode(n, true)));
        } else wrap.appendChild(el('i', 'ri-file-text-line'));
        return wrap;
    }

    // `db` and `cellActiveWindow` are top-level `let`s in the app's scripts, so they are not properties of window.
    const curDb = () => (typeof db !== 'undefined' ? db : null);
    const curWindow = () => (typeof cellActiveWindow !== 'undefined' ? cellActiveWindow : null);
    const storageKey = () => 'codemini_quickopen_recent_' + (curDb() && curDb().name ? curDb().name : 'default');
    function loadRecents() { try { const v = JSON.parse(localStorage.getItem(storageKey()) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch (e) { return []; } }
    function saveRecents(list) { try { localStorage.setItem(storageKey(), JSON.stringify(list)); } catch (e) { /* storage full or blocked: recents are a convenience */ } }
    function noteOpened(fileId) { if (fileId) saveRecents(pushRecent(loadRecents(), fileId, RECENT_MAX)); }

    // Every time a file's tab becomes the active one it counts as "recently opened".
    function trackRecents() {
        if (typeof W.switchTab !== 'function' || W.switchTab.__qoWrapped) return;
        const original = W.switchTab;
        const wrapped = function (targetPaneId) {
            const result = original.apply(this, arguments);
            try {
                const tab = document.querySelector('.tab[data-target="' + String(targetPaneId).replace(/"/g, '') + '"]');
                if (tab && tab.dataset.fileId) noteOpened(tab.dataset.fileId);
            } catch (e) { /* never let bookkeeping break tab switching */ }
            return result;
        };
        wrapped.__qoWrapped = true;
        W.switchTab = wrapped;
        try { switchTab = wrapped; } catch (e) { /* binding is not assignable in this scope */ }
    }

    // ---- the commands (each one drives a control the app already has) ----
    const click = (id) => () => { const n = document.getElementById(id); if (n) n.click(); };
    function activeMonaco() { return typeof W.getActiveMonacoEditor === 'function' ? W.getActiveMonacoEditor() : null; }
    function commandList() {
        return [
            { name: 'New File', icon: 'ri-file-add-line', keys: 'Alt+N', run: click('menuNewFile') },
            { name: 'New Folder', icon: 'ri-folder-add-line', run: click('addFolderBtn') },
            { name: 'Open Terminal', icon: 'ri-terminal-window-line', keys: 'Ctrl+`', run: click('terminalIconItem') },
            { name: 'Toggle Sidebar', icon: 'ri-layout-left-line', keys: 'Ctrl+B', run: click('folderIconItem') },
            { name: 'Search Across Files', icon: 'ri-search-line', keys: 'Ctrl+Shift+F', run: click('searchIconItem') },
            { name: 'Settings', icon: 'ri-settings-6-line', run: click('settingsIconItem') },
            { name: 'Profile', icon: 'ri-user-4-line', run: click('profileIconItem') },
            { name: 'Format Code', icon: 'ri-format-clear', keys: 'Shift+Alt+F', run: () => {
                const ed = activeMonaco();
                if (ed) { const a = ed.getAction('editor.action.formatDocument'); if (a) { a.run(); return; } }
                document.querySelector('.tb-format')?.click(); document.querySelector('.jtb-format')?.click();
            } },
            { name: 'Split Editor', icon: 'ri-layout-column-line', run: click('splitLayoutBtn') },
            { name: 'Close Active Tab', icon: 'ri-close-line', keys: 'Alt+W', run: () => {
                const g = document.getElementById(W.activeGroupId || 'editorGroup1');
                const t = g ? g.querySelector('.tab.active .tab-close') : null; if (t) t.click();
            } },
            { name: 'Close All Tabs', icon: 'ri-close-circle-line', run: () => {
                const g = document.getElementById(W.activeGroupId || 'editorGroup1');
                if (g) Array.from(g.querySelectorAll('.tab')).forEach((tab) => { const b = tab.querySelector('.tab-close'); if (b) b.click(); });
            } },
            { name: 'Toggle Zen Mode', icon: 'ri-fullscreen-line', run: () => { document.body.classList.toggle('zen-mode'); } }
        ];
    }

    // ---- reading the file system ----
    let cache = { dbName: null, at: 0, files: [], byId: new Map() };
    function loadFiles(force) {
        return new Promise((resolve) => {
            const database = curDb();
            if (!database) { resolve(cache); return; }
            if (!force && cache.dbName === database.name && Date.now() - cache.at < 2000) { resolve(cache); return; }
            let req;
            try { req = database.transaction('filesystem', 'readonly').objectStore('filesystem').getAll(); } catch (e) { resolve(cache); return; }
            req.onsuccess = (ev) => {
                const rows = ev.target.result || [];
                const byId = new Map(rows.map((r) => [r.id, r]));
                const pathOf = (r) => {
                    const parts = [r.name]; let cur = r.parentId, guard = 0;
                    while (cur && byId.has(cur) && guard++ < 64) { const p = byId.get(cur); parts.unshift(p.name); cur = p.parentId; }
                    return parts.join('/');
                };
                const files = rows.filter((r) => r.type === 'file').map((r) => ({ id: r.id, name: r.name, path: pathOf(r) }));
                const folders = rows.filter((r) => r.type === 'folder').map((r) => ({ id: r.id, name: r.name, path: pathOf(r) }));
                cache = { dbName: database.name, at: Date.now(), files, folders, byId };
                resolve(cache);
            };
            req.onerror = () => resolve(cache);
        });
    }

    // ---- doing things ----
    function openFileById(id, opts) {
        const database = curDb(); if (!database) return;
        database.transaction('filesystem', 'readonly').objectStore('filesystem').get(id).onsuccess = (ev) => {
            const file = ev.target.result;
            if (!file || typeof W.handleFileClick !== 'function') return;
            if (opts && opts.side) openToSide();
            W.handleFileClick(file, document.createElement('div'));
            if (opts && opts.line) setTimeout(() => goToLine(opts.line, opts.col), 120);
        };
    }
    // The other editor group (created like the Split button does when there is only one).
    function openToSide() {
        const g2 = document.getElementById('editorGroup2');
        if (!g2) { const b = document.getElementById('splitLayoutBtn'); if (b) b.click(); return; }
        const current = W.activeGroupId || 'editorGroup1';
        const other = current === 'editorGroup2' ? document.getElementById('editorGroup1') : g2;
        if (!other) return;
        document.querySelectorAll('.editor-group').forEach((g) => g.classList.remove('active-group'));
        other.classList.add('active-group'); W.activeGroupId = other.id;
        try { activeGroupId = other.id; } catch (e) { /* not assignable here */ }
    }
    function goToLine(line, col) {
        const ed = activeMonaco(); if (!ed || !line) return false;
        const model = ed.getModel(); const last = model ? model.getLineCount() : line;
        const ln = Math.max(1, Math.min(line, last));
        ed.revealLineInCenter(ln); ed.setPosition({ lineNumber: ln, column: Math.max(1, col || 1) }); ed.focus();
        return true;
    }
    function openFolder(id) {
        const info = cache.byId.get(id); if (!info || typeof folderStack === 'undefined') return;
        const chain = []; let cur = info, guard = 0;
        while (cur && guard++ < 64) { chain.unshift({ id: cur.id, name: cur.name }); cur = cache.byId.get(cur.parentId); if (cur && cur.id === folderStack[0].id) break; }
        folderStack = [folderStack[0]].concat(chain);
        if (typeof W.loadFilesFromDB === 'function') W.loadFilesFromDB();
    }
    // enterWorkspace (app.js) is what clicking a workspace in the Explorer runs: it opens the workspace's own
    // database (CodeMiniDB_WS_<id>), resets the breadcrumb to it and refreshes the tabs and sidebars.
    function openWorkspace(ws) { if (typeof W.enterWorkspace === 'function') W.enterWorkspace(ws); }

    // ---- the island ----
    const state = { rows: [], selected: 0, token: 0, query: '' };
    // The island hangs from the bottom edge of the top bar, wherever that is: lower with the window bar showing (28px
    // on desktop and Android, taller on iOS, which reserves room for the status bar), higher with it hidden, and it
    // follows when the window bar is toggled, the phone is rotated or the keyboard resizes the page. A fixed offset
    // (it was 80px, and 120px on every phone) is only right for one of those.
    function positionIsland() {
        const box = document.getElementById('topSearchIsland'), bar = document.querySelector('.top-menu');
        if (!box || !bar) return;
        box.style.top = Math.round(bar.getBoundingClientRect().bottom + (W.scrollY || 0) + 2) + 'px';
    }
    const island = () => document.getElementById('topSearchIsland');
    const input = () => document.querySelector('.top-center .search-bar input');

    function header(title, count) { const h = el('div', 'qo-section'); h.appendChild(el('span', '', title)); if (count !== undefined) h.appendChild(el('span', 'qo-count', String(count))); return h; }
    function hintRow(mode) {
        const row = el('div', 'qo-hint');
        [['', 'files', 'all'], ['>', 'commands', 'commands'], [':', 'line', 'line'], ['@', 'symbol', 'symbol'], ['#', 'workspace', 'workspace']].forEach(([key, label, m]) => {
            const chip = el('span', 'qo-hint-chip' + (m === mode ? ' active' : ''));
            if (key) chip.appendChild(el('kbd', '', key));
            chip.appendChild(document.createTextNode(label));
            chip.dataset.prefix = key;
            row.appendChild(chip);
        });
        return row;
    }
    function buildRow(r) {
        const row = el('div', 'qo-item'); row.setAttribute('role', 'option');
        const main = el('div', 'qo-main');
        if (r.iconNode) main.appendChild(r.iconNode); else if (r.icon) { const w = el('span', 'qo-icon'); w.appendChild(el('i', r.icon)); main.appendChild(w); }
        const label = el('span', 'qo-label'); label.appendChild(r.labelNode || document.createTextNode(r.label)); main.appendChild(label);
        if (r.enter) { const go = el('i', 'ri-external-link-line qo-enter'); go.title = 'Open workspace'; main.appendChild(go); }
        row.appendChild(main);
        if (r.detail) { // outer box is right-to-left so a long path is cut at its start; the inner span keeps the text itself left-to-right
            const d = el('span', 'qo-detail'); d.title = r.detailTitle || r.detail;
            const inner = el('span', 'qo-detail-in'); inner.appendChild(r.detailNode || document.createTextNode(r.detail)); d.appendChild(inner); row.appendChild(d);
        }
        if (r.keys) row.appendChild(el('span', 'kbd-badge qo-kbd', r.keys));
        return row;
    }
    function render() {
        const box = island(); if (!box) return;
        box.textContent = '';
        positionIsland();
        box.classList.add('qo');
        box.setAttribute('role', 'listbox');
        const parsed = parseQuery(state.query);
        box.appendChild(hintRow(parsed.mode));
        let flat = 0;
        state.sections.forEach((s) => {
            if (s.title) box.appendChild(header(s.title, s.count));
            s.rows.forEach((r) => {
                const row = buildRow(r); const idx = flat++;
                row.dataset.idx = String(idx);
                row.addEventListener('mouseenter', () => select(idx, false));
                row.addEventListener('click', (e) => { e.stopPropagation(); activate(idx, e.altKey); });
                box.appendChild(row);
            });
        });
        if (state.note) box.appendChild(el('div', 'qo-note', state.note));
        if (flat === 0 && !state.note) {
            box.appendChild(el('div', 'qo-empty', 'No results found'));
            box.appendChild(el('div', 'qo-tip', 'Tip: type > for commands, : for a line number'));
        }
        state.rows = state.sections.reduce((a, s) => a.concat(s.rows), []);
        state.selected = Math.min(state.selected, Math.max(0, state.rows.length - 1));
        paintSelection(false);
    }
    function paintSelection(scroll) {
        const box = island(); if (!box) return;
        box.querySelectorAll('.qo-item.selected').forEach((n) => n.classList.remove('selected'));
        const cur = box.querySelector('.qo-item[data-idx="' + state.selected + '"]');
        if (cur) { cur.classList.add('selected'); if (scroll && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' }); }
    }
    function select(idx, scroll) { if (!state.rows.length) return; state.selected = (idx + state.rows.length) % state.rows.length; paintSelection(scroll !== false); }
    function close(blur) {
        const box = island(); if (box) box.style.display = 'none';
        const inp = input(); if (inp) { inp.value = ''; if (blur) inp.blur(); }
        state.query = '';
    }
    function activate(idx, side) {
        const r = state.rows[idx]; if (!r) return;
        close(true);
        r.run({ side: !!side });
    }

    // Build the sections for what is typed. Async because the file list comes from IndexedDB.
    async function compute(query) {
        const token = ++state.token;
        state.query = query;
        const parsed = parseQuery(query);
        const data = await loadFiles(parsed.mode === 'all' && !parsed.text && !query);
        if (token !== state.token) return null; // a newer keystroke superseded this one
        const sections = []; let note = '';
        const fileRow = (hit, extra) => {
            const f = hit.file, nameStart = f.path.length - f.name.length;
            const dir = f.path.slice(0, Math.max(0, nameStart - 1));
            return Object.assign({
                kind: 'file', iconNode: fileIcon(f.name), labelNode: highlighted(f.name, hit.positions.filter((p) => p >= nameStart), nameStart),
                detail: dir, detailTitle: f.path, detailNode: dir ? highlighted(dir, hit.positions.filter((p) => p < nameStart), 0) : null,
                run: (o) => openFileById(f.id, { side: o.side, line: parsed.line, col: parsed.col })
            }, extra || {});
        };
        const cmdRows = (text, limit) => rankByName(commandList(), text, (c) => c.name).slice(0, limit).map((h) => ({
            kind: 'command', icon: h.item.icon, labelNode: highlighted(h.item.name, h.positions, 0), keys: h.item.keys, run: () => h.item.run()
        }));
        const wsRows = (text, limit) => rankByName(W.workspacesList || [], text, (w) => w.name || '').slice(0, limit).map((h) => ({
            kind: 'workspace', icon: FOLDER_ICON, enter: true, labelNode: highlighted(h.item.name, h.positions, 0), run: () => openWorkspace(h.item)
        }));

        if (parsed.mode === 'commands') {
            const rows = cmdRows(parsed.text, 50); sections.push({ title: 'COMMANDS', count: rows.length, rows });
        } else if (parsed.mode === 'workspace') {
            const rows = wsRows(parsed.text, 50); sections.push({ title: 'WORKSPACES', count: rows.length, rows });
        } else if (parsed.mode === 'line') {
            const ed = activeMonaco();
            if (!ed) note = 'Open a file in the editor to go to a line';
            else {
                const total = ed.getModel() ? ed.getModel().getLineCount() : 0;
                const line = parsed.line;
                sections.push({ title: '', rows: [{
                    kind: 'line', icon: 'ri-arrow-right-line',
                    label: line ? 'Go to line ' + Math.min(line, total) + (parsed.col ? ', column ' + parsed.col : '') : 'Type a line number (1 to ' + total + ')',
                    run: () => goToLine(line, parsed.col)
                }] });
                if (!line) sections[0].rows = [];
                if (!line) note = 'Type a line number between 1 and ' + total;
            }
        } else if (parsed.mode === 'symbol') {
            const ed = activeMonaco();
            if (!ed) note = 'Open a file in the editor to browse its symbols';
            else sections.push({ title: '', rows: [{ kind: 'symbol', icon: 'ri-braces-line', label: 'Browse symbols in this file', run: () => { ed.focus(); const a = ed.getAction('editor.action.quickOutline'); if (a) a.run(); } }] });
        } else if (!parsed.text) {
            const recents = loadRecents();
            const recentFiles = recents.map((id) => data.files.find((f) => f.id === id)).filter(Boolean).slice(0, 8);
            if (recentFiles.length) sections.push({ title: 'RECENTLY OPENED', count: recentFiles.length, rows: recentFiles.map((f) => fileRow({ file: f, positions: [] })) });
            const seen = new Set(recentFiles.map((f) => f.id));
            const others = data.files.filter((f) => !seen.has(f.id)).sort((a, b) => (a.path < b.path ? -1 : 1)).slice(0, SHOW_EMPTY_FILES);
            if (others.length) sections.push({ title: 'FILES', count: data.files.length - recentFiles.length, rows: others.map((f) => fileRow({ file: f, positions: [] })) });
            const cr = cmdRows('', 6); if (cr.length) sections.push({ title: 'COMMANDS', count: commandList().length, rows: cr });
            const wr = wsRows('', SHOW_OTHER); if (wr.length) sections.push({ title: 'WORKSPACES', count: wr.length, rows: wr });
            const folders = (data.folders || []).sort((a, b) => (a.path < b.path ? -1 : 1)).slice(0, SHOW_OTHER);
            if (folders.length) sections.push({ title: 'FOLDERS', count: (data.folders || []).length, rows: folders.map((f) => ({ kind: 'folder', icon: FOLDER_ICON, label: f.name, detail: f.path, run: () => openFolder(f.id) })) });
        } else {
            const hits = rankFiles(data.files, parsed.text, loadRecents());
            if (hits.length) sections.push({ title: 'FILES', count: hits.length, rows: hits.slice(0, SHOW_FILES).map((h) => fileRow(h)) });
            const cr = cmdRows(parsed.text, SHOW_OTHER); if (cr.length) sections.push({ title: 'COMMANDS', count: cr.length, rows: cr });
            const wr = wsRows(parsed.text, SHOW_OTHER); if (wr.length) sections.push({ title: 'WORKSPACES', count: wr.length, rows: wr });
            const fh = rankByName(data.folders || [], parsed.text, (f) => f.name).slice(0, SHOW_OTHER);
            if (fh.length) sections.push({ title: 'FOLDERS', count: fh.length, rows: fh.map((h) => ({ kind: 'folder', icon: FOLDER_ICON, labelNode: highlighted(h.item.name, h.positions.filter((p) => p >= h.item.path.length - h.item.name.length).map((p) => p - (h.item.path.length - h.item.name.length)), 0), detail: h.item.path, run: () => openFolder(h.item.id) })) });
        }
        return { sections, note };
    }

    // The entry point the title-bar search box already calls on focus and on every keystroke.
    W.renderTopSearch = async function (query) {
        const box = island(); if (!box) return;
        const result = await compute(String(query || ''));
        if (!result) return;
        state.sections = result.sections; state.note = result.note;
        // app.js also re-renders this when files change; keep the highlighted row if the text did not.
        if (state.renderedQuery !== String(query || '')) state.selected = 0;
        state.renderedQuery = String(query || '');
        render();
    };

    function open(prefill) {
        const inp = input(), box = island(); if (!inp || !box) return;
        positionIsland();
        box.style.display = 'flex';
        inp.focus();
        if (prefill !== undefined) inp.value = prefill; else inp.select();
        W.renderTopSearch(inp.value);
    }
    W.openQuickOpen = open;

    function init() {
        const inp = input(), box = island(); if (!inp || !box) return;
        trackRecents();
        positionIsland();
        W.addEventListener('resize', positionIsland);
        W.addEventListener('orientationchange', positionIsland);
        if (W.visualViewport) W.visualViewport.addEventListener('resize', positionIsland);
        new MutationObserver(positionIsland).observe(document.body, { attributes: true, attributeFilter: ['class'] }); // hide-window-bar, zen mode...
        inp.setAttribute('autocomplete', 'off'); inp.setAttribute('spellcheck', 'false');
        inp.setAttribute('role', 'combobox'); inp.setAttribute('aria-controls', 'topSearchIsland');
        inp.addEventListener('keydown', (e) => {
            if (box.style.display === 'none') return;
            if (e.key === 'ArrowDown') { e.preventDefault(); select(state.selected + 1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); select(state.selected - 1); }
            else if (e.key === 'PageDown') { e.preventDefault(); select(Math.min(state.rows.length - 1, state.selected + 8)); }
            else if (e.key === 'PageUp') { e.preventDefault(); select(Math.max(0, state.selected - 8)); }
            else if (e.key === 'Enter') { e.preventDefault(); activate(state.selected, e.altKey); }
            else if (e.key === 'Escape') { e.preventDefault(); close(true); const ed = activeMonaco(); if (ed) ed.focus(); }
        });
        // A hint chip types its prefix for you (handy on a phone, which has no F1).
        box.addEventListener('mousedown', (e) => { if (e.target.closest('.qo-hint-chip')) e.preventDefault(); });
        box.addEventListener('click', (e) => {
            const chip = e.target.closest('.qo-hint-chip'); if (!chip) return;
            e.stopPropagation(); inp.value = chip.dataset.prefix; inp.focus(); W.renderTopSearch(inp.value);
        });
        // On a phone, starting to scroll the list puts the keyboard away so more of it is visible.
        box.addEventListener('touchmove', () => { if (document.activeElement === inp) inp.blur(); }, { passive: true });
    }

    // Ctrl+P / Cmd+P, F1 and Ctrl+Shift+P. Captured so neither Monaco nor the browser's Print dialog gets them first.
    document.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        const key = (e.key || '').toLowerCase();
        if (mod && !e.shiftKey && !e.altKey && key === 'p') { e.preventDefault(); e.stopPropagation(); open(); }
        else if (e.key === 'F1' && !mod && !e.altKey && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); open('>'); }
        else if (mod && e.shiftKey && !e.altKey && key === 'p') { e.preventDefault(); e.stopPropagation(); open('>'); }
    }, true);

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : globalThis);
