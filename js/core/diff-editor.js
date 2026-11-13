// ==========================================
// diff-editor.js
// ==========================================
// The diff editor: an editor tab (type "diff") that shows two versions of a file with Monaco's own diff editor,
// which the app already loads for code, so it works offline (the Source Control popup's diff used a library
// fetched from a CDN at runtime). A slim toolbar sits under the tab bar: Unified / Split, previous / next change with
// a counter ("3 of 12"), Ignore whitespace, and Refresh.
//
// Ways in:
//   Source Control   the diff popup has an "Open in tab" icon, and double-clicking a changed file opens the tab
//                    (js/git/git.js calls CodeMiniDiff.open)
//   Explorer         right-click a file > Select for Compare, then right-click another > Compare with Selected
//   Tab menu         right-click an open file's tab > Compare with Saved (the editor's text against what is stored)
//   Quick Open       "Compare Active File With..." and "Compare Active File with Saved"
//
// A diff tab is a read-only view. It is not part of a restored session (it has no file of its own to reopen).
// The first half is pure (no DOM) and is tested in Node by tests/diff-editor.test.js.
(function (root) {
    'use strict';

    // ---------------------------------------------------------------------------------------------
    // Pure helpers
    // Where to take the editor for each change. Monaco reports changes as line ranges; a change that only deletes
    // lines has modifiedEndLineNumber 0 and modifiedStartLineNumber is the line it happened after.
    function changeTargets(lineChanges) {
        return (lineChanges || []).map((c) => ({ line: Math.max(1, c.modifiedStartLineNumber || 1) }));
    }
    function nextIndex(current, total, direction) {
        if (total <= 0) return -1;
        if (current < 0 || current >= total) return direction < 0 ? total - 1 : 0;
        return (current + direction + total) % total;
    }
    function counterLabel(current, total) {
        if (total <= 0) return 'No changes';
        if (current < 0) return total === 1 ? '1 change' : total + ' changes';
        return (current + 1) + ' of ' + total;
    }
    // The language Monaco should use for a file name, from the languages Monaco itself lists.
    function languageForName(name, languages) {
        const lower = String(name || '').toLowerCase();
        const dot = lower.lastIndexOf('.');
        const ext = dot >= 0 ? lower.slice(dot) : '';
        const list = languages || [];
        const hit = list.find((l) => (l.filenames || []).some((f) => f.toLowerCase() === lower)) || (ext && list.find((l) => (l.extensions || []).some((e) => e.toLowerCase() === ext)));
        return hit ? hit.id : 'plaintext';
    }
    // "src/app.js" for a file inside a folder, "app.js" at the top.
    function labelFor(name, parentName) { return parentName ? parentName + '/' + name : name; }
    function describeSides(kind, name, left, right) {
        if (kind === 'saved') return { title: name + ' (Saved \u2194 Editor)', left: 'Saved', right: 'Editor' };
        if (kind === 'compare') return { title: left + ' \u2194 ' + right, left, right };
        return { title: name + ' (' + left + ' \u2194 ' + right + ')', left, right };
    }

    // True when two texts differ only in whitespace (indentation, spacing inside a line, blank lines, line endings).
    function whitespaceOnly(a, b) {
        const strip = (t) => String(t || '').replace(/\s+/g, '');
        return strip(a) === strip(b);
    }
    // The editor options a diff tab takes from the app's settings, so it looks like the main editor
    // (line numbers on / off / relative / interval, font, whitespace marks, word wrap ...).
    function optionsFromSettings(s) {
        s = s || {};
        const o = {
            fontSize: s.fontSize || 13,
            fontFamily: s.fontFamily || "'Fira Code', 'JetBrains Mono', monospace",
            fontWeight: s.fontWeight || 'normal',
            lineHeight: s.lineHeight || 21,
            letterSpacing: typeof s.letterSpacing === 'number' ? s.letterSpacing : 0.3,
            fontLigatures: s.fontLigatures !== false,
            tabSize: s.tabSize || 4,
            wordWrap: s.wordWrap || 'off',
            lineNumbers: s.lineNumbers || 'on',
            renderWhitespace: s.renderWhitespace || 'none',
            smoothScrolling: s.smoothScrolling !== false,
            bracketPairColorization: { enabled: s.bracketPairs !== false }
        };
        return o;
    }

    const api = { changeTargets, nextIndex, counterLabel, languageForName, labelFor, describeSides, whitespaceOnly, optionsFromSettings };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof document === 'undefined') return; // Node: logic only

    // ---------------------------------------------------------------------------------------------
    // UI
    const W = typeof window !== 'undefined' ? window : root;
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const toast = (msg) => { if (typeof W.showSuccessToast === 'function') W.showSuccessToast(msg); };
    const VIEW_KEY = 'codemini_diff_view';
    const isPhone = () => W.matchMedia && W.matchMedia('(max-width: 768px)').matches;
    const preferredView = () => { try { return localStorage.getItem(VIEW_KEY) === 'unified' ? 'unified' : 'split'; } catch (e) { return 'split'; } };
    const curDb = () => (typeof db !== 'undefined' ? db : null);

    // One stored record, from the open database or another one (a workspace's).
    function getRecord(id, dbName) {
        return new Promise((resolve) => {
            if (!id) { resolve(null); return; }
            const read = (database, done) => {
                try { const rq = database.transaction('filesystem', 'readonly').objectStore('filesystem').get(id); rq.onsuccess = (e) => done(e.target.result || null); rq.onerror = () => done(null); } catch (e) { done(null); }
            };
            const open = curDb();
            if (open && (!dbName || open.name === dbName)) { read(open, resolve); return; }
            if (typeof W.openExistingCodeMiniDb !== 'function') { resolve(null); return; }
            W.openExistingCodeMiniDb(dbName, (d) => read(d, (r) => { try { d.close(); } catch (e) { /* already closed */ } resolve(r); }), () => resolve(null));
        });
    }
    async function labelOfRecord(rec, dbName) {
        const parent = rec.parentId && rec.parentId !== 'root' ? await getRecord(rec.parentId, dbName) : null;
        return labelFor(rec.name, parent && parent.type === 'folder' ? parent.name : '');
    }

    // ---- building the tab ----
    function buildShell() {
        const rootEl = el('div', 'df-root');
        const bar = el('div', 'df-toolbar');
        const seg = el('div', 'df-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Diff layout');
        [['unified', 'Unified'], ['split', 'Split']].forEach(([key, text]) => { const b = el('button', 'df-seg-btn', text); b.type = 'button'; b.dataset.df = key; seg.appendChild(b); });
        bar.appendChild(seg);
        const nav = el('div', 'df-nav');
        [['prev', 'ri-arrow-up-s-line', 'Previous change'], ['next', 'ri-arrow-down-s-line', 'Next change']].forEach(([key, icon, title]) => {
            const b = el('button', 'df-icon-btn'); b.type = 'button'; b.dataset.df = key; b.title = title; b.setAttribute('aria-label', title); b.appendChild(el('i', icon)); nav.appendChild(b);
        });
        bar.appendChild(nav);
        bar.appendChild(el('span', 'df-counter', ''));
        const ws = el('label', 'df-ws'); const box = el('input'); box.type = 'checkbox'; box.dataset.df = 'ws'; ws.appendChild(box); ws.appendChild(el('span', '', 'Ignore whitespace')); bar.appendChild(ws);
        bar.appendChild(el('span', 'df-spacer'));
        const rf = el('button', 'df-icon-btn'); rf.type = 'button'; rf.dataset.df = 'refresh'; rf.title = 'Refresh'; rf.setAttribute('aria-label', 'Refresh'); rf.appendChild(el('i', 'ri-refresh-line')); bar.appendChild(rf);
        rootEl.appendChild(bar);
        const labels = el('div', 'df-labels'); labels.appendChild(el('span', 'df-label df-label-left')); labels.appendChild(el('span', 'df-label df-label-right'));
        rootEl.appendChild(labels);
        rootEl.appendChild(el('div', 'df-host'));
        const msg = el('div', 'df-msg'); msg.hidden = true; rootEl.appendChild(msg);
        return rootEl;
    }

    function whenMonaco(callback, onGiveUp) {
        let tries = 0;
        const poll = () => { if (W.monaco && W.monaco.editor) callback(); else if (++tries > 150) onGiveUp(); else setTimeout(poll, 100); };
        poll();
    }

    function setup(pane, tab, opts) {
        const rootEl = buildShell();
        const holder = pane.firstElementChild || pane;
        holder.appendChild(rootEl);
        const q = (sel) => rootEl.querySelector(sel);
        const rec = { opts, editor: null, original: null, modified: null, nav: -1, ignoreWs: false, view: preferredView(), data: null, mq: null, onMq: null, disposed: false };
        pane._diff = rec;
        const message = (text, icon) => {
            const m = q('.df-msg'); m.textContent = ''; if (icon) m.appendChild(el('i', icon)); m.appendChild(el('div', '', text)); m.hidden = false;
            q('.df-host').style.visibility = 'hidden';
        };
        const clearMessage = () => { q('.df-msg').hidden = true; q('.df-host').style.visibility = ''; };
        const effectiveView = () => (isPhone() ? 'unified' : rec.view);
        const paintToolbar = () => {
            const v = effectiveView();
            rootEl.querySelectorAll('.df-seg-btn').forEach((b) => { b.classList.toggle('active', b.dataset.df === v); b.setAttribute('aria-pressed', b.dataset.df === v ? 'true' : 'false'); });
            const splitBtn = q('.df-seg-btn[data-df="split"]'); splitBtn.disabled = isPhone(); splitBtn.title = isPhone() ? 'Split view needs a wider screen' : '';
        };
        const updateCounter = () => {
            if (!rec.editor) { q('.df-counter').textContent = ''; return; }
            const computed = rec.editor.getLineChanges();
            if (computed === null) { q('.df-counter').textContent = 'Comparing...'; return; } // Monaco has not finished comparing yet: that is not "no differences"
            const changes = computed;
            q('.df-counter').textContent = counterLabel(rec.nav, changes.length);
            const none = changes.length === 0;
            rootEl.querySelectorAll('[data-df="prev"], [data-df="next"]').forEach((b) => { b.disabled = none; });
            if (none && rec.data && !rec.data.binary) {
                const same = rec.data.original.text === rec.data.modified.text;
                message(same ? 'No differences' : (rec.ignoreWs || whitespaceOnly(rec.data.original.text, rec.data.modified.text) ? 'No differences except whitespace' : 'No differences'), 'ri-check-double-line');
            } else if (rec.data && !rec.data.binary) clearMessage();
        };
        const go = (dir) => {
            if (!rec.editor) return;
            const targets = changeTargets(rec.editor.getLineChanges());
            rec.nav = nextIndex(rec.nav, targets.length, dir);
            if (rec.nav < 0) return;
            const ed = rec.editor.getModifiedEditor();
            ed.revealLineInCenter(targets[rec.nav].line); ed.setPosition({ lineNumber: targets[rec.nav].line, column: 1 });
            updateCounter();
        };

        const render = () => {
            const data = rec.data;
            q('.df-label-left').textContent = data.original.label || ''; q('.df-label-right').textContent = data.modified.label || '';
            if (data.binary) { message('Binary file, diff not available', 'ri-file-forbid-line'); q('.df-counter').textContent = ''; rootEl.querySelectorAll('[data-df="prev"], [data-df="next"]').forEach((b) => { b.disabled = true; }); return; }
            whenMonaco(() => {
                if (rec.disposed) return;
                const m = W.monaco, s = W.appSettings || {};
                if (!rec.editor) {
                    const language = languageForName(opts.name, m.languages.getLanguages());
                    rec.original = m.editor.createModel(data.original.text, language);
                    rec.modified = m.editor.createModel(data.modified.text, language);
                    const theme = (W.appSettings && typeof W.isThemeDark === 'function' && W.isThemeDark()) ? 'vs-dark' : 'vs-light';
                    rec.editor = m.editor.createDiffEditor(q('.df-host'), Object.assign({
                        theme, automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: effectiveView() === 'split',
                        ignoreTrimWhitespace: rec.ignoreWs, enableSplitViewResizing: true, renderOverviewRuler: true, scrollBeyondLastLine: false,
                        minimap: { enabled: false }
                    }, optionsFromSettings(s)));
                    rec.editor.setModel({ original: rec.original, modified: rec.modified });
                    rec.editor.onDidUpdateDiff(updateCounter);
                } else {
                    rec.original.setValue(data.original.text); rec.modified.setValue(data.modified.text);
                }
                clearMessage(); rec.nav = -1; updateCounter();
                // Monaco reports "changes: null" until its comparison has finished (it runs in a worker), and that is not
                // the same as "no differences"; wait for the result. A newer load makes an older wait stop.
                const ticket = rec.ticket = (rec.ticket || 0) + 1;
                const waitForDiff = (tries) => {
                    if (rec.disposed || rec.ticket !== ticket || !rec.editor) return;
                    if (rec.editor.getLineChanges() !== null) { updateCounter(); return; }
                    if (tries === 200) { q('.df-counter').textContent = 'Taking a while...'; }
                    if (tries < 1200) setTimeout(() => waitForDiff(tries + 1), 100);
                    else message('The comparison could not be completed.', 'ri-error-warning-line');
                };
                waitForDiff(0);
            }, () => message('The editor could not be loaded. It needs a connection the first time.', 'ri-error-warning-line'));
        };
        const load = async () => {
            message('Loading...', 'ri-loader-4-line');
            try { rec.data = await opts.load(); } catch (e) { message('Could not read the files to compare.', 'ri-error-warning-line'); return; }
            if (!rec.data) { message('Could not read the files to compare.', 'ri-error-warning-line'); return; }
            if (rec.data.error) { message(rec.data.error, 'ri-error-warning-line'); return; }
            render();
        };
        rec.reload = load;

        // The toolbar
        paintToolbar();
        if (opts.static) q('[data-df="refresh"]').hidden = true;
        rootEl.addEventListener('click', (e) => {
            const b = e.target.closest('[data-df]'); if (!b || b.disabled) return;
            const k = b.dataset.df;
            if (k === 'unified' || k === 'split') {
                rec.view = k; try { localStorage.setItem(VIEW_KEY, k); } catch (err) { /* a preference only */ }
                paintToolbar(); if (rec.editor) rec.editor.updateOptions({ renderSideBySide: effectiveView() === 'split' });
            } else if (k === 'next') go(1); else if (k === 'prev') go(-1);
            else if (k === 'refresh') load();
        });
        rootEl.addEventListener('change', (e) => {
            if (e.target.dataset && e.target.dataset.df === 'ws') { rec.ignoreWs = e.target.checked; if (rec.editor) { rec.editor.updateOptions({ ignoreTrimWhitespace: rec.ignoreWs }); rec.nav = -1; } }
        });
        // Split is not offered on a phone: follow the screen as it changes (rotation, a resized window).
        if (W.matchMedia) {
            rec.mq = W.matchMedia('(max-width: 768px)');
            rec.onMq = () => { paintToolbar(); if (rec.editor) rec.editor.updateOptions({ renderSideBySide: effectiveView() === 'split' }); };
            if (rec.mq.addEventListener) rec.mq.addEventListener('change', rec.onMq); else if (rec.mq.addListener) rec.mq.addListener(rec.onMq);
        }
        load();
    }

    // Called by the Settings screen whenever an editor setting changes: every open diff tab follows it.
    W.updateDiffEditorSettings = function () {
        const s = W.appSettings || {};
        const theme = (typeof W.isThemeDark === 'function' && W.isThemeDark()) ? 'vs-dark' : 'vs-light';
        document.querySelectorAll('.df-root').forEach((rootEl) => {
            const pane = rootEl.closest('.content-pane'); const rec = pane && pane._diff;
            if (rec && rec.editor && !rec.disposed) { try { rec.editor.updateOptions(optionsFromSettings(s)); if (W.monaco) W.monaco.editor.setTheme(theme); } catch (e) { /* a disposed editor */ } }
        });
    };

    W.teardownDiffEditor = function (paneId) {
        const pane = document.getElementById(paneId); const rec = pane && pane._diff; if (!rec) return;
        rec.disposed = true;
        try { if (rec.editor) rec.editor.dispose(); if (rec.original) rec.original.dispose(); if (rec.modified) rec.modified.dispose(); } catch (e) { /* disposing twice is harmless */ }
        if (rec.mq) { if (rec.mq.removeEventListener) rec.mq.removeEventListener('change', rec.onMq); else if (rec.mq.removeListener) rec.mq.removeListener(rec.onMq); }
        pane._diff = null;
    };

    // opts: { key, name, title, load: async () => ({ original: { text, label }, modified: { text, label }, binary?, error? }), static? }
    // A diff with the same key is one tab: opening it again shows that tab, reloaded.
    function open(opts) {
        const existing = Array.from(document.querySelectorAll('.tab[data-type="diff"]')).find((t) => t.dataset.diffKey === opts.key);
        if (existing) {
            if (typeof W.switchTab === 'function') W.switchTab(existing.dataset.target);
            const p = document.getElementById(existing.dataset.target); if (p && p._diff && p._diff.reload) p._diff.reload();
            return existing;
        }
        if (typeof W.createNewTab !== 'function') return null;
        W.createNewTab(opts.title, 'ri-arrow-left-right-line', false, '', 'diff', null);
        const group = document.getElementById(typeof activeGroupId !== 'undefined' ? activeGroupId : 'editorGroup1') || document.getElementById('editorGroup1');
        const tab = group.querySelector('.tab.active');
        if (!tab) return null;
        tab.dataset.diffKey = opts.key;
        const pane = document.getElementById(tab.dataset.target);
        setup(pane, tab, opts);
        return tab;
    }

    // ---- the ways in ----
    // Two versions already in hand (Source Control).
    function openStatic(o) {
        return open({
            key: o.key, name: o.name, static: true,
            title: describeSides(o.kind || 'git', o.name, o.originalLabel, o.modifiedLabel).title,
            load: async () => ({ original: { text: o.original || '', label: o.originalLabel }, modified: { text: o.modified || '', label: o.modifiedLabel }, binary: o.encoding === 'base64' })
        });
    }
    // Source Control with a loader of its own (the working-tree diff is recomputed on Refresh).
    function openLoaded(o) {
        return open({ key: o.key, name: o.name, title: describeSides('git', o.name, o.originalLabel, o.modifiedLabel).title, load: o.load });
    }

    let compareSource = null; // the file picked with "Select for Compare"
    function setCompareSource(file) {
        const open = curDb();
        compareSource = { id: file.id, name: file.name, dbName: open ? open.name : null };
        toast('Selected \u201c' + file.name + '\u201d for compare. Right-click another file and choose Compare with Selected.');
    }
    async function readSide(ref) {
        const rec = await getRecord(ref.id, ref.dbName);
        if (!rec) return { error: '\u201c' + ref.name + '\u201d no longer exists.' };
        if (rec.isLocked) return { error: '\u201c' + rec.name + '\u201d is locked. Unlock it to compare it.' };
        return { rec, label: await labelOfRecord(rec, ref.dbName) };
    }
    function compareFiles(a, b) {
        const key = 'cmp:' + a.dbName + ':' + a.id + ':' + b.dbName + ':' + b.id;
        return open({
            key, name: b.name, title: a.name + ' \u2194 ' + b.name,
            load: async () => {
                const [l, r] = await Promise.all([readSide(a), readSide(b)]);
                if (l.error || r.error) return { error: l.error || r.error };
                const binary = l.rec.encoding === 'base64' || r.rec.encoding === 'base64';
                return { original: { text: l.rec.content || '', label: l.label }, modified: { text: r.rec.content || '', label: r.label }, binary };
            }
        });
    }
    function compareWithSelected(file) {
        if (!compareSource) { toast('Pick a file first: right-click it and choose Select for Compare.'); return; }
        const open = curDb();
        if (compareSource.id === file.id) { toast('That is the file you selected. Pick a different one.'); return; }
        return compareFiles(compareSource, { id: file.id, name: file.name, dbName: open ? open.name : null });
    }
    // The editor's text against what is stored for the file.
    function compareWithSaved(tab) {
        if (!tab || tab.dataset.type !== 'monaco' || !tab.dataset.fileId) { toast('Compare with Saved works on code files.'); return null; }
        const fileId = tab.dataset.fileId, dbName = tab.dataset.dbName || (curDb() && curDb().name);
        const name = tab.querySelector('span') ? tab.querySelector('span').textContent : 'file';
        const sides = describeSides('saved', name);
        return open({
            key: 'saved:' + dbName + ':' + fileId, name, title: sides.title,
            load: async () => {
                const rec = await getRecord(fileId, dbName);
                if (!rec) return { error: '\u201c' + name + '\u201d is not stored yet. Save it first.' };
                if (rec.isLocked) return { error: '\u201c' + name + '\u201d is locked.' };
                const pane = document.getElementById(tab.dataset.target);
                const ed = pane && W.monaco ? W.monaco.editor.getEditors().find((e) => pane.contains(e.getContainerDomNode())) : null;
                const text = ed ? ed.getValue() : (rec.content || '');
                return { original: { text: rec.content || '', label: sides.left }, modified: { text, label: sides.right }, binary: rec.encoding === 'base64' };
            }
        });
    }
    function activeFileTab() {
        const group = document.getElementById(typeof activeGroupId !== 'undefined' ? activeGroupId : 'editorGroup1') || document.getElementById('editorGroup1');
        const tab = group && group.querySelector('.tab.active');
        return tab && tab.dataset.type === 'monaco' && tab.dataset.fileId ? tab : null;
    }

    // Explorer right-click: [{ icon, text, handler }] for a file.
    function explorerOptions(file) {
        if (!file || file.type !== 'file') return [];
        const out = [{ icon: 'ri-git-commit-line', text: 'Select for Compare', handler: () => setCompareSource(file) }];
        if (compareSource && compareSource.id !== file.id) out.push({ icon: 'ri-arrow-left-right-line', text: 'Compare with Selected', handler: () => compareWithSelected(file), title: 'Compare with \u201c' + compareSource.name + '\u201d' });
        return out;
    }

    // ---- the tab's right-click menu ----
    let menuEl = null;
    function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
    function showTabMenu(e, tab) {
        closeMenu();
        const items = [];
        if (tab.dataset.type === 'monaco' && tab.dataset.fileId) items.push({ icon: 'ri-arrow-left-right-line', text: 'Compare with Saved', run: () => compareWithSaved(tab) });
        if (tab.dataset.type === 'monaco' && tab.dataset.fileId && W.CodeMiniHistory) items.push({ icon: 'ri-history-line', text: 'Local History...', run: () => W.CodeMiniHistory.showForTab(tab) });
        items.push({ icon: 'ri-close-line', text: 'Close', run: () => { const b = tab.querySelector('.tab-close'); if (b) b.click(); } });
        items.push({ icon: 'ri-close-circle-line', text: 'Close Others', run: () => {
            const group = tab.closest('.editor-group');
            Array.from(group.querySelectorAll('.tab')).filter((t) => t !== tab).forEach((t) => { const b = t.querySelector('.tab-close'); if (b) b.click(); });
        } });
        menuEl = el('div', 'df-menu'); menuEl.setAttribute('role', 'menu');
        items.forEach((it) => {
            const row = el('div', 'df-menu-item'); row.setAttribute('role', 'menuitem'); row.tabIndex = 0;
            row.appendChild(el('i', it.icon)); row.appendChild(el('span', '', it.text));
            const run = () => { closeMenu(); it.run(); };
            row.addEventListener('click', run); row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); run(); } });
            menuEl.appendChild(row);
        });
        document.body.appendChild(menuEl);
        const r = menuEl.getBoundingClientRect();
        menuEl.style.left = Math.max(4, Math.min(e.clientX, innerWidth - r.width - 4)) + 'px';
        menuEl.style.top = Math.max(4, Math.min(e.clientY, innerHeight - r.height - 4)) + 'px';
        menuEl.firstElementChild.focus();
    }
    document.addEventListener('contextmenu', (e) => {
        const tab = e.target.closest && e.target.closest('.tab');
        if (!tab || e.target.closest('.tab-close')) return;
        if (typeof activeDrag !== 'undefined' && activeDrag && activeDrag.isLongPressed) return; // a touch drag, not a menu
        e.preventDefault(); showTabMenu(e, tab);
    });
    document.addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuEl) { e.stopPropagation(); closeMenu(); } }, true);
    W.addEventListener('blur', closeMenu); W.addEventListener('resize', closeMenu);

    Object.assign(api, { open, openStatic, openLoaded, compareFiles, compareWithSelected, compareWithSaved, setCompareSource, explorerOptions, activeFileTab, getRecord });
    W.CodeMiniDiff = api;
})(typeof window !== 'undefined' ? window : globalThis);
