// Local file history, hot exit and the Auto Save status-bar toggle.
//
//   Local history   every save of a code file leaves a snapshot behind (kept per file, capped by count and age).
//                   Explorer > Timeline lists them; click one to diff it with the file, Restore it, or delete it.
//   Hot exit        text that was typed but not saved is copied aside a moment after each edit. After a reload, a
//                   crash or a closed browser it comes back in its tab, still unsaved, and a notification offers Review.
//   Auto Save       a status-bar switch for the existing Settings > General > Auto Save.
//
// Rules this file keeps:
//   - A locked file is stored encrypted, so neither history nor hot exit ever copies its text (canKeep()).
//   - Recovered text is put in the editor as an undoable edit and is never written to the file until the user saves.
//   - Only code files (Monaco tabs) are covered. Notebooks and documents are not.
//   - Everything lives in its own IndexedDB ("CodeMiniHistory"); the workspace databases are not touched.
//   - DOM is built with nodes, never HTML strings (tests/html-sinks).
//
// The pure half is exported for Node (tests/file-history.test.js); the browser half starts after that.
(function (root) {
    'use strict';
    const W = root;

    const LIMITS = {
        mergeMs: 20000,            // auto saves closer together than this share one entry
        maxSnapshotChars: 1000000, // bigger text is not kept in history
        maxBackupChars: 2000000,   // bigger text is not backed up by hot exit
        defaultEntries: 50,
        defaultDays: 14,
        totalChars: 64000000,      // all history together; the oldest entries go first
        backupDebounceMs: 1500
    };
    const KIND_RANK = { closed: 1, auto: 2, manual: 3 };
    const KIND_LABEL = { manual: 'Saved', auto: 'Auto saved', closed: 'Closed unsaved' };

    // ---------------------------------------------------------------------------------------------
    // Pure helpers
    // ---------------------------------------------------------------------------------------------
    // Cheap, stable fingerprint (FNV-1a plus the length). It tells "same text?" apart quickly; it is not security.
    function fnv1a(str) {
        const s = String(str == null ? '' : str);
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
        return (h >>> 0).toString(16) + ':' + s.length;
    }
    function fileKey(dbName, fileId) { return String(dbName) + '|' + String(fileId); }

    // Lines added and removed between two texts. Counts lines, ignores where they moved, so it is a hint; the diff
    // tab is the truth.
    function lineDelta(a, b) {
        const counts = new Map();
        for (const l of String(a == null ? '' : a).split('\n')) counts.set(l, (counts.get(l) || 0) + 1);
        let added = 0;
        for (const l of String(b == null ? '' : b).split('\n')) {
            const c = counts.get(l);
            if (c) counts.set(l, c - 1); else added++;
        }
        let removed = 0;
        for (const c of counts.values()) removed += c;
        return { added, removed };
    }

    function formatSize(n) {
        n = Number(n) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
        return (n / 1024 / 1024).toFixed(1) + ' MB';
    }

    function relativeTime(ts, now) {
        const diff = Math.max(0, (now == null ? Date.now() : now) - ts);
        const min = Math.floor(diff / 60000);
        if (min < 1) return 'Just now';
        if (min < 60) return min + ' min ago';
        const h = Math.floor(min / 60);
        if (h < 24) return h + ' h ago';
        const d = Math.floor(h / 24);
        return d === 1 ? 'Yesterday' : d + ' days ago';
    }

    // Text may be copied into history / hot exit only when it is plain text of a sensible size.
    function canKeep(rec, text, limit) {
        if (!rec || rec.type === 'folder') return false;
        if (rec.isLocked) return false;                 // stored encrypted: its plain text must never be copied
        if (rec.encoding === 'base64') return false;    // binary
        if (typeof text !== 'string') return false;
        return text.length <= (limit || LIMITS.maxSnapshotChars);
    }

    // The Timeline's height may not drop below `min`, and may not squeeze the file list above it under `minRoom`.
    // While the handle is dragged, current + room stays constant (the list gives up exactly what the Timeline takes).
    function clampHeight(h, current, room, min, minRoom) {
        const max = Math.max(min, current + room - minRoom);
        return Math.round(Math.min(max, Math.max(min, Number(h) || 0)));
    }

    // Two auto saves a few seconds apart are one change as far as a reader cares: the newer replaces the older.
    function shouldMerge(prev, kind, now, mergeMs) {
        return !!prev && prev.kind === 'auto' && kind === 'auto' && (now - prev.time) <= (mergeMs == null ? LIMITS.mergeMs : mergeMs);
    }

    function sortNewestFirst(metas) { return (metas || []).slice().sort((a, b) => b.time - a.time); }

    // One file's entries: which ids go (older than the age limit, or beyond the count limit).
    function planPrune(metas, o) {
        const list = sortNewestFirst(metas);
        const ids = [];
        list.forEach((m, i) => {
            if (i >= o.maxEntries || (o.now - m.time) > o.maxAgeMs) ids.push(m.id);
        });
        return ids;
    }

    // Every file's entries: age first, then the oldest go until the total is under the limit.
    function planSweep(metas, o) {
        const ids = new Set();
        const keep = [];
        for (const m of metas || []) { if ((o.now - m.time) > o.maxAgeMs) ids.add(m.id); else keep.push(m); }
        let total = keep.reduce((n, m) => n + (m.size || 0), 0);
        const oldest = keep.slice().sort((a, b) => a.time - b.time);
        for (const m of oldest) {
            if (total <= o.totalChars) break;
            ids.add(m.id); total -= (m.size || 0);
        }
        return Array.from(ids);
    }

    // Hot exit at start-up. entries: the backups found for the open database. ctx: { pageId, alive:Set, files:Map }.
    // Returns [{ entry, action: 'recover' | 'drop' | 'skip', reason, conflict }].
    function planRecovery(entries, ctx) {
        return (entries || []).map((entry) => {
            if (entry.pageId === ctx.pageId) return { entry, action: 'skip', reason: 'this page wrote it, its tab is still open' };
            if (ctx.alive && ctx.alive.has(entry.pageId)) return { entry, action: 'skip', reason: 'another open window is using it' };
            const rec = ctx.files.get(entry.fileId);
            if (!rec) return { entry, action: 'drop', reason: 'the file no longer exists' };
            if (rec.isLocked || rec.encoding === 'base64') return { entry, action: 'drop', reason: 'locked or binary' };
            if ((rec.content || '') === entry.content) return { entry, action: 'drop', reason: 'already saved' };
            const conflict = !!entry.baseHash && entry.baseHash !== fnv1a(rec.content || '');
            return { entry, action: 'recover', reason: conflict ? 'the file changed after the backup' : 'unsaved text', conflict };
        });
    }

    // ---------------------------------------------------------------------------------------------
    // History logic over a store. A store has the methods listed in memoryStore() below; idbStore() is the real one.
    // ---------------------------------------------------------------------------------------------
    function memoryStore() {
        const snaps = new Map(), contents = new Map(), backups = new Map();
        const copy = (o) => Object.assign({}, o);
        return {
            async metasByFile(key) { return Array.from(snaps.values()).filter((m) => m.fileKey === key).map(copy); },
            async allMetas() { return Array.from(snaps.values()).map(copy); },
            async getContent(id) { return contents.has(id) ? contents.get(id) : null; },
            async putSnapshot(meta, content) { snaps.set(meta.id, copy(meta)); contents.set(meta.id, content); },
            async replaceSnapshot(oldId, meta, content) { snaps.delete(oldId); contents.delete(oldId); snaps.set(meta.id, copy(meta)); contents.set(meta.id, content); },
            async updateMeta(meta) { snaps.set(meta.id, copy(meta)); },
            async deleteSnapshots(ids) { ids.forEach((id) => { snaps.delete(id); contents.delete(id); }); },
            async deleteByDb(names) {
                let n = 0;
                for (const m of Array.from(snaps.values())) if (names.includes(m.dbName)) { snaps.delete(m.id); contents.delete(m.id); n++; }
                for (const b of Array.from(backups.values())) if (names.includes(b.dbName)) { backups.delete(b.key); n++; }
                return n;
            },
            async clearHistory() { snaps.clear(); contents.clear(); },
            async getBackup(key) { return backups.has(key) ? copy(backups.get(key)) : null; },
            async putBackup(entry) { backups.set(entry.key, copy(entry)); },
            async deleteBackup(key) { backups.delete(key); },
            async backupsByDb(name) { return Array.from(backups.values()).filter((b) => b.dbName === name).map(copy); },
            async clearBackups() { backups.clear(); }
        };
    }

    function createHistory(store, getCfg) {
        const cfg = () => Object.assign({ enabled: true, maxEntries: LIMITS.defaultEntries, maxDays: LIMITS.defaultDays }, getCfg ? getCfg() : {});
        const nowOf = (o) => (o && o.now != null ? o.now : Date.now());
        let seq = 0;

        async function prune(key, now) {
            const c = cfg();
            const ids = planPrune(await store.metasByFile(key), { maxEntries: Math.max(1, c.maxEntries), maxAgeMs: Math.max(1, c.maxDays) * 86400000, now });
            if (ids.length) await store.deleteSnapshots(ids);
            return ids.length;
        }

        // o: { dbName, fileId, name, content, kind: 'manual' | 'auto' | 'closed', now? }. Returns the entry or null.
        async function record(o) {
            const c = cfg();
            if (!c.enabled) return null;
            const content = o.content;
            if (typeof content !== 'string' || content.length > LIMITS.maxSnapshotChars) return null;
            const now = nowOf(o), kind = KIND_RANK[o.kind] ? o.kind : 'auto';
            const key = fileKey(o.dbName, o.fileId), hash = fnv1a(content);
            const metas = sortNewestFirst(await store.metasByFile(key));
            const latest = metas[0];
            if (latest && latest.hash === hash) {
                // Same text as the newest entry: no new entry, but keep the stronger label (a save beats "closed").
                if (KIND_RANK[kind] > KIND_RANK[latest.kind]) { latest.kind = kind; await store.updateMeta(latest); }
                return null;
            }
            const merge = shouldMerge(latest, kind, now, LIMITS.mergeMs);
            const base = merge ? metas[1] : latest;
            const baseText = base ? await store.getContent(base.id) : null;
            const delta = baseText == null ? { added: null, removed: null } : lineDelta(baseText, content);
            const meta = {
                id: key + '|' + now.toString(36) + '-' + (++seq).toString(36) + Math.random().toString(36).slice(2, 5),
                fileKey: key, dbName: o.dbName, fileId: o.fileId, name: o.name || '', time: now, kind,
                size: content.length, hash, added: delta.added, removed: delta.removed
            };
            if (merge) await store.replaceSnapshot(latest.id, meta, content); else await store.putSnapshot(meta, content);
            await prune(key, now);
            return meta;
        }

        return {
            record, prune,
            async list(dbName, fileId) { return sortNewestFirst(await store.metasByFile(fileKey(dbName, fileId))); },
            getContent: (id) => store.getContent(id),
            async remove(ids) { await store.deleteSnapshots(ids); },
            async clearFile(dbName, fileId) { await store.deleteSnapshots((await store.metasByFile(fileKey(dbName, fileId))).map((m) => m.id)); },
            async sweep(now) {
                const c = cfg();
                const ids = planSweep(await store.allMetas(), { maxAgeMs: Math.max(1, c.maxDays) * 86400000, totalChars: LIMITS.totalChars, now: now == null ? Date.now() : now });
                if (ids.length) await store.deleteSnapshots(ids);
                return ids.length;
            }
        };
    }

    const api = { LIMITS, clampHeight, fnv1a, fileKey, lineDelta, formatSize, relativeTime, canKeep, shouldMerge, planPrune, planSweep, planRecovery, memoryStore, createHistory };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof document === 'undefined') return; // Node: logic only

    // ---------------------------------------------------------------------------------------------
    // Browser half: the IndexedDB store
    // ---------------------------------------------------------------------------------------------
    const DB_NAME = 'CodeMiniHistory';
    let dbPromise = null;
    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            let rq;
            try { rq = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
            rq.onupgradeneeded = () => {
                const d = rq.result;
                const snaps = d.createObjectStore('snapshots', { keyPath: 'id' });
                snaps.createIndex('byFile', 'fileKey'); snaps.createIndex('byDb', 'dbName');
                d.createObjectStore('contents', { keyPath: 'id' });
                const bk = d.createObjectStore('backups', { keyPath: 'key' });
                bk.createIndex('byDb', 'dbName');
            };
            rq.onsuccess = () => {
                const d = rq.result;
                d.onversionchange = () => { try { d.close(); } catch (e) { /* already closed */ } dbPromise = null; };
                resolve(d);
            };
            rq.onerror = () => { dbPromise = null; reject(rq.error); };
            rq.onblocked = () => { /* another tab holds an older version; wait */ };
        });
        return dbPromise;
    }
    // Runs fn(transactionStores) and resolves with its value once the transaction has committed.
    async function run(names, mode, fn) {
        const d = await openDb();
        return new Promise((resolve, reject) => {
            const tx = d.transaction(names, mode);
            let out;
            const stores = {}; names.forEach((n) => { stores[n] = tx.objectStore(n); });
            Promise.resolve(fn(stores, tx)).then((v) => { out = v; }, reject);
            tx.oncomplete = () => resolve(out);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('aborted'));
        });
    }
    const asP = (rq) => new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });

    function idbStore() {
        return {
            metasByFile: (key) => run(['snapshots'], 'readonly', (s) => asP(s.snapshots.index('byFile').getAll(key))),
            allMetas: () => run(['snapshots'], 'readonly', (s) => asP(s.snapshots.getAll())),
            getContent: (id) => run(['contents'], 'readonly', (s) => asP(s.contents.get(id))).then((r) => (r ? r.content : null)),
            putSnapshot: (meta, content) => run(['snapshots', 'contents'], 'readwrite', (s) => { s.snapshots.put(meta); s.contents.put({ id: meta.id, content }); }),
            replaceSnapshot: (oldId, meta, content) => run(['snapshots', 'contents'], 'readwrite', (s) => { s.snapshots.delete(oldId); s.contents.delete(oldId); s.snapshots.put(meta); s.contents.put({ id: meta.id, content }); }),
            updateMeta: (meta) => run(['snapshots'], 'readwrite', (s) => { s.snapshots.put(meta); }),
            deleteSnapshots: (ids) => run(['snapshots', 'contents'], 'readwrite', (s) => { ids.forEach((id) => { s.snapshots.delete(id); s.contents.delete(id); }); }),
            deleteByDb: (names) => run(['snapshots', 'contents', 'backups'], 'readwrite', async (s) => {
                let n = 0;
                for (const name of names) {
                    const metas = await asP(s.snapshots.index('byDb').getAll(name));
                    metas.forEach((m) => { s.snapshots.delete(m.id); s.contents.delete(m.id); n++; });
                    const bks = await asP(s.backups.index('byDb').getAll(name));
                    bks.forEach((b) => { s.backups.delete(b.key); n++; });
                }
                return n;
            }),
            clearHistory: () => run(['snapshots', 'contents'], 'readwrite', (s) => { s.snapshots.clear(); s.contents.clear(); }),
            getBackup: (key) => run(['backups'], 'readonly', (s) => asP(s.backups.get(key))).then((r) => r || null),
            putBackup: (entry) => run(['backups'], 'readwrite', (s) => { s.backups.put(entry); }),
            deleteBackup: (key) => run(['backups'], 'readwrite', (s) => { s.backups.delete(key); }),
            backupsByDb: (name) => run(['backups'], 'readonly', (s) => asP(s.backups.index('byDb').getAll(name))),
            clearBackups: () => run(['backups'], 'readwrite', (s) => { s.backups.clear(); })
        };
    }

    const store = idbStore();
    const settings = () => W.appSettings || {};
    const historyOn = () => settings().localHistory !== 'Off';
    const hotExitOn = () => settings().hotExit !== 'Off';
    const history = createHistory(store, () => ({
        enabled: historyOn(),
        maxEntries: parseInt(settings().historyMaxEntries, 10) || LIMITS.defaultEntries,
        maxDays: parseInt(settings().historyMaxDays, 10) || LIMITS.defaultDays
    }));
    const quiet = (p) => { try { return Promise.resolve(p).catch(() => null); } catch (e) { return Promise.resolve(null); } };
    const toast = (m) => { if (typeof W.showSuccessToast === 'function') W.showSuccessToast(m); };
    const curDb = () => (typeof db !== 'undefined' ? db : null);

    function getRecord(dbName, fileId) {
        return new Promise((resolve) => {
            if (!fileId) { resolve(null); return; }
            const read = (database, done) => {
                try { const rq = database.transaction('filesystem', 'readonly').objectStore('filesystem').get(fileId); rq.onsuccess = (e) => done(e.target.result || null); rq.onerror = () => done(null); }
                catch (e) { done(null); }
            };
            const open = curDb();
            if (open && (!dbName || open.name === dbName)) { read(open, resolve); return; }
            if (typeof W.openExistingCodeMiniDb !== 'function') { resolve(null); return; }
            W.openExistingCodeMiniDb(dbName, (d) => read(d, (r) => { try { d.close(); } catch (e) { /* already closed */ } resolve(r); }), () => resolve(null));
        });
    }

    // ---------------------------------------------------------------------------------------------
    // Which pages are alive (Web Locks): a second browser tab must not take over the first one's unsaved text.
    // A lock is released by the browser when its page closes or crashes, so no timers are needed.
    // ---------------------------------------------------------------------------------------------
    const pageId = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const LOCK_PREFIX = 'codemini-page:';
    try {
        if (navigator.locks && navigator.locks.request) navigator.locks.request(LOCK_PREFIX + pageId, () => new Promise(() => { /* held until the page goes */ })).catch(() => {});
    } catch (e) { /* no Web Locks: other pages are treated as gone */ }
    async function alivePages() {
        try {
            const q = await navigator.locks.query();
            return new Set((q.held || []).filter((l) => l.name && l.name.indexOf(LOCK_PREFIX) === 0).map((l) => l.name.slice(LOCK_PREFIX.length)));
        } catch (e) { return new Set(); }
    }

    // ---------------------------------------------------------------------------------------------
    // Tabs: tracking what is saved and what is typed
    // ---------------------------------------------------------------------------------------------
    const dirtyTabs = new Set();
    const manualSaves = new Map(); // fileId -> time: the next save of this file was asked for by the user

    function tabKey(tab) { return fileKey(tab.dataset.dbName, tab.dataset.fileId); }
    function tabName(tab) { const s = tab.querySelector('span'); return s ? s.textContent : 'file'; }
    function findTab(dbName, fileId) {
        return Array.from(document.querySelectorAll('.tab')).find((t) => t.dataset.type === 'monaco' && t.dataset.fileId === fileId && t.dataset.dbName === dbName) || null;
    }
    function editorText(tab) { try { return tab._cmEditor ? tab._cmEditor.getValue() : null; } catch (e) { return null; } }

    function markManual(fileId) { if (fileId) manualSaves.set(String(fileId), Date.now()); }
    function consumeManual(fileId) {
        const t = manualSaves.get(String(fileId));
        manualSaves.delete(String(fileId));
        return t != null && (Date.now() - t) < 15000;
    }

    // The editor for a code tab now exists. text is what the file held when it was opened.
    function noteOpened(tab, text, editor) {
        if (!tab || !tab.dataset || !tab.dataset.fileId || !tab.dataset.dbName) return;
        tab._cmEditor = editor;
        tab._cmBaseHash = text.length <= LIMITS.maxBackupChars ? fnv1a(text) : null;
        tab._cmSafe = undefined;
        // A locked file's text must never be copied: find out once, now, before anything is typed.
        getRecord(tab.dataset.dbName, tab.dataset.fileId).then((rec) => { tab._cmSafe = canKeep(rec, '', 1); }, () => { tab._cmSafe = false; });
    }

    // The user typed. Cheap on purpose: it only (re)arms a timer.
    function noteEdit(tab) {
        if (!tab || tab._cmSafe === false || !tab._cmEditor || !hotExitOn()) return;
        clearTimeout(tab._cmTimer);
        tab._cmTimer = setTimeout(() => flushTab(tab), LIMITS.backupDebounceMs);
        dirtyTabs.add(tab);
    }

    function flushTab(tab) {
        tab._cmTimer = null;
        if (!tab.isConnected || !tab._cmEditor || !hotExitOn()) { dirtyTabs.delete(tab); return; }
        if (tab._cmSafe === undefined) { tab._cmTimer = setTimeout(() => flushTab(tab), 500); return; } // still checking the file
        if (tab._cmSafe !== true) { dirtyTabs.delete(tab); return; }
        const text = editorText(tab);
        if (text == null || text.length > LIMITS.maxBackupChars) { dirtyTabs.delete(tab); return; }
        const key = tabKey(tab);
        if (tab._cmBaseHash != null && fnv1a(text) === tab._cmBaseHash) { // back to what is saved: nothing to keep
            dirtyTabs.delete(tab);
            return quiet(store.deleteBackup(key));
        }
        return quiet(store.putBackup({ key, dbName: tab.dataset.dbName, fileId: tab.dataset.fileId, name: tabName(tab), content: text, baseHash: tab._cmBaseHash, pageId, time: Date.now() }));
    }
    function flushAll() { Array.from(dirtyTabs).forEach((tab) => { if (tab._cmTimer) { clearTimeout(tab._cmTimer); } flushTab(tab); }); }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });
    W.addEventListener('pagehide', flushAll);

    // autoSaveFile wrote a file. Called from its success path only (never for a locked file).
    function noteSaved(o) {
        const tab = o.tabEl, file = o.file, content = o.content;
        const isEditorSave = !!(tab && tab.dataset && tab.dataset.type === 'monaco');
        const manual = consumeManual(file.id);
        if (isEditorSave) {
            const key = tabKey(tab);
            tab._cmBaseHash = content.length <= LIMITS.maxBackupChars ? fnv1a(content) : null;
            const now = editorText(tab);
            if (now == null || fnv1a(now) === fnv1a(content)) { // the editor still shows what was saved
                clearTimeout(tab._cmTimer); tab._cmTimer = null; dirtyTabs.delete(tab);
                quiet(store.deleteBackup(key));
            }
        } else if (!(manual && !tab)) return; // a notebook, a document, a plain write: not a code-file save
        if (!canKeep(file, content)) return;
        const kind = manual ? 'manual' : 'auto';
        quiet(history.record({ dbName: o.dbName, fileId: file.id, name: file.name, content, kind }).then(() => refreshTimeline()));
    }

    // A tab is going away (closed, or swept up by a window switch). Called first in teardownPaneResources.
    function tabClosing(tab) {
        if (!tab || !tab.dataset || tab.dataset.type !== 'monaco' || !tab._cmEditor) return;
        clearTimeout(tab._cmTimer); tab._cmTimer = null; dirtyTabs.delete(tab);
        const text = editorText(tab);
        // Closing on purpose is not a crash: the backup must not come back on the next start...
        if (tab.dataset.fileId && tab.dataset.dbName) quiet(store.deleteBackup(tabKey(tab)));
        // ...but closing used to drop the typed text silently, so keep it in the history instead.
        if (text != null && tab._cmBaseHash != null && fnv1a(text) !== tab._cmBaseHash && tab._cmSafe === true) {
            quiet(history.record({ dbName: tab.dataset.dbName, fileId: tab.dataset.fileId, name: tabName(tab), content: text, kind: 'closed' }));
        }
        tab._cmEditor = null;
    }

    // ---------------------------------------------------------------------------------------------
    // Hot exit: bring back what was typed and not saved
    // ---------------------------------------------------------------------------------------------
    const recoveredFor = new Set();
    let reviewTabs = [];
    function waitFor(fn, ms) {
        return new Promise((resolve) => {
            const t0 = Date.now();
            (function poll() {
                let v = null; try { v = fn(); } catch (e) { v = null; }
                if (v) { resolve(v); return; }
                if (Date.now() - t0 > ms) { resolve(null); return; }
                setTimeout(poll, 100);
            })();
        });
    }
    function putInEditor(tab, text, source) {
        const ed = tab._cmEditor, model = ed && ed.getModel();
        if (!model) return false;
        ed.pushUndoStop();
        ed.executeEdits(source, [{ range: model.getFullModelRange(), text, forceMoveMarkers: true }]);
        ed.pushUndoStop();
        return true;
    }

    async function recoverFor(dbName) {
        if (!dbName || recoveredFor.has(dbName) || !hotExitOn()) return 0;
        recoveredFor.add(dbName);
        const entries = await quiet(store.backupsByDb(dbName));
        if (!entries || !entries.length) return 0;
        const files = new Map();
        for (const e of entries) files.set(e.fileId, await getRecord(dbName, e.fileId));
        const plan = planRecovery(entries, { pageId, alive: await alivePages(), files });
        for (const p of plan) if (p.action === 'drop') await quiet(store.deleteBackup(p.entry.key));

        const done = [];
        for (const p of plan.filter((x) => x.action === 'recover')) {
            const rec = files.get(p.entry.fileId);
            let tab = findTab(dbName, p.entry.fileId);
            if (!tab && typeof openFileInTab === 'function') { openFileInTab(rec); tab = await waitFor(() => findTab(dbName, p.entry.fileId), 3000); }
            const ed = tab ? await waitFor(() => tab._cmEditor, 20000) : null;
            if (!tab || !ed) continue; // the backup stays; the next start tries again
            if (!putInEditor(tab, p.entry.content, 'hot-exit')) continue;
            // Typing set the autosave timer: cancel it. Recovered text is saved only when the user says so.
            clearTimeout(tab._pendingAutoSaveTimeout); tab._pendingAutoSaveTimeout = null;
            tab.classList.add('unsaved-blink');
            done.push({ tab, name: p.entry.name || rec.name, conflict: p.conflict });
        }
        if (!done.length) return 0;
        reviewTabs = done.map((d) => d.tab);
        const conflicts = done.filter((d) => d.conflict).map((d) => d.name);
        const names = done.map((d) => d.name).join(', ');
        const text = names + '. ' + (done.length === 1 ? 'It is back in its tab and still unsaved.' : 'They are back in their tabs and still unsaved.')
            + (conflicts.length ? ' ' + conflicts.join(', ') + ' changed after these edits were backed up, so check the comparison before saving.' : '')
            + ' Review compares each with the saved version.';
        if (W.CodeMiniNotifications) {
            W.CodeMiniNotifications.add({ id: 'hot-exit-recovered', title: 'Recovered ' + done.length + ' unsaved ' + (done.length === 1 ? 'file' : 'files'), text, kind: 'info', source: 'Hot exit', actions: ['review-recovered'] });
        }
        return done.length;
    }
    function hasReview() { return reviewTabs.some((t) => t.isConnected); }
    function reviewRecovered() {
        const tabs = reviewTabs.filter((t) => t.isConnected);
        if (!tabs.length || !W.CodeMiniDiff) return 0;
        tabs.slice(0, 6).forEach((t) => W.CodeMiniDiff.compareWithSaved(t));
        if (tabs.length > 6) toast((tabs.length - 6) + ' more recovered files: right-click their tabs and choose Compare with Saved.');
        return Math.min(tabs.length, 6);
    }

    // ---------------------------------------------------------------------------------------------
    // Removing everything for databases that are being deleted (Factory Reset, deleting a window or workspace)
    // ---------------------------------------------------------------------------------------------
    function purgeDatabases(names) {
        const list = (names || []).filter(Boolean);
        if (!list.length) return Promise.resolve(0);
        return quiet(store.deleteByDb(list)).then((n) => n || 0);
    }

    // ---------------------------------------------------------------------------------------------
    // Auto Save switch (status bar). Settings has four modes; the switch flips Off <-> the last mode that was on.
    // ---------------------------------------------------------------------------------------------
    const LAST_MODE_KEY = 'codemini_autosave_last_mode';
    let statusEl = null;
    function autoSaveMode() { return settings().autoSave || 'After Delay'; }
    function renderAutoSave() {
        if (!statusEl) return;
        const mode = autoSaveMode(), on = mode !== 'Off';
        statusEl.classList.toggle('as-off', !on);
        statusEl.setAttribute('aria-pressed', on ? 'true' : 'false');
        const label = statusEl.querySelector('.as-label');
        if (label) label.textContent = on ? 'Auto Save' : 'Auto Save: Off';
        statusEl.title = on ? 'Auto Save: ' + mode + '. Click to turn it off.' : 'Auto Save is off. Click to turn it on.';
        const icon = statusEl.querySelector('i');
        if (icon) icon.className = on ? 'ri-save-3-line' : 'ri-save-3-fill';
    }
    function toggleAutoSave() {
        const mode = autoSaveMode();
        let next;
        if (mode !== 'Off') { try { localStorage.setItem(LAST_MODE_KEY, mode); } catch (e) { /* private mode */ } next = 'Off'; }
        else { let last = null; try { last = localStorage.getItem(LAST_MODE_KEY); } catch (e) { /* private mode */ } next = last && last !== 'Off' ? last : 'After Delay'; }
        if (typeof W.saveSetting === 'function') W.saveSetting('autoSave', next); else settings().autoSave = next;
        if (typeof W.syncUI === 'function') W.syncUI(); // an open Settings tab shows the new value
        renderAutoSave();
        toast('Auto Save: ' + next);
    }
    function buildAutoSaveItem() {
        const right = document.querySelector('.status-right');
        if (!right || document.getElementById('statusAutoSave')) return;
        statusEl = document.createElement('div');
        statusEl.className = 'status-item'; statusEl.id = 'statusAutoSave';
        statusEl.setAttribute('role', 'button'); statusEl.setAttribute('tabindex', '0');
        const i = document.createElement('i'); i.className = 'ri-save-3-line';
        const label = document.createElement('span'); label.className = 'as-label hide-on-mobile';
        statusEl.append(i, label);
        statusEl.addEventListener('click', toggleAutoSave);
        statusEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAutoSave(); } });
        const anchor = document.getElementById('nowIsland');
        if (anchor && anchor.parentNode === right) right.insertBefore(statusEl, anchor); else right.appendChild(statusEl);
        renderAutoSave();
    }

    // ---------------------------------------------------------------------------------------------
    // Timeline (Explorer, above the status line)
    // ---------------------------------------------------------------------------------------------
    const OPEN_KEY = 'codemini_timeline_open';
    let sec = null, bodyEl = null, fileEl = null, countEl = null, clearBtn = null, toggleBtn = null;
    let tlOpen = false, pinned = null, tlRows = [], tlToken = 0, clearArmed = null;
    // Resizing: drag the top edge (or Up / Down on it, Home to reset). The size is remembered per window, like the
    // sidebar width and the bottom panel height. What the user chose (preferredH) is kept even when a small window
    // forces a smaller one for now.
    const TL_MIN = 56, TL_MIN_LIST = 120, TL_STEP = 16;
    let resizerEl = null, preferredH = null, heightWin = null, fitTimer = null;
    const winKey = () => { try { return localStorage.getItem('codemini_active_window') || 'win_default'; } catch (e) { return 'win_default'; } };
    const heightKey = () => 'codemini_timeline_height_' + winKey();
    const listRoom = () => { const l = document.getElementById('fileList'); return l ? l.offsetHeight : 0; };
    function paintHeight(h) { // shows a height without remembering it
        const l = document.getElementById('fileList');
        const set = (v) => { bodyEl.style.height = v + 'px'; bodyEl.classList.add('tl-sized'); };
        set(clampHeight(h, bodyEl.offsetHeight, listRoom(), TL_MIN, TL_MIN_LIST));
        // When the list is squeezed to nothing, the rows above it (the breadcrumb) shrink as well, which hides part of
        // the shortage from the first clamp. So look at what the list really got, and take the rest off.
        for (let i = 0; i < 4 && l && l.offsetHeight < TL_MIN_LIST && bodyEl.offsetHeight > TL_MIN; i++) set(Math.max(TL_MIN, bodyEl.offsetHeight - (TL_MIN_LIST - l.offsetHeight)));
        const v = bodyEl.offsetHeight;
        resizerEl.setAttribute('aria-valuenow', String(v));
        return v;
    }
    function rememberHeight(v) { preferredH = v; try { localStorage.setItem(heightKey(), String(v)); } catch (e) { /* private mode */ } }
    function resetHeight() {
        preferredH = null;
        try { localStorage.removeItem(heightKey()); } catch (e) { /* private mode */ }
        bodyEl.style.height = ''; bodyEl.classList.remove('tl-sized'); resizerEl.removeAttribute('aria-valuenow');
    }
    function loadHeight() { // this window's own size (a window switch changes it)
        heightWin = winKey();
        let v = 0; try { v = parseInt(localStorage.getItem(heightKey()), 10) || 0; } catch (e) { /* private mode */ }
        preferredH = v >= TL_MIN ? v : null;
    }
    function fitHeight() {
        // Not on screen (no layout box), or the user is dragging: leave it. A list squeezed to 0px is NOT "not on screen": that is when it must shrink.
        if (!tlOpen || !bodyEl || !sec.getClientRects().length || resizerEl.classList.contains('dragging')) return;
        if (heightWin !== winKey()) loadHeight();
        if (preferredH) paintHeight(preferredH); else { bodyEl.style.height = ''; bodyEl.classList.remove('tl-sized'); }
    }

    function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    function icon(name) { const i = document.createElement('i'); i.className = name; return i; }
    function activeTab() {
        if (W.CodeMiniDiff && W.CodeMiniDiff.activeFileTab) return W.CodeMiniDiff.activeFileTab();
        const g = document.getElementById(typeof activeGroupId !== 'undefined' ? activeGroupId : 'editorGroup1');
        const t = g && g.querySelector('.tab.active');
        return t && t.dataset.type === 'monaco' && t.dataset.fileId ? t : null;
    }
    function currentTarget() {
        if (pinned) return pinned;
        const tab = activeTab();
        return tab && tab.dataset.dbName ? { dbName: tab.dataset.dbName, fileId: tab.dataset.fileId, name: tabName(tab) } : null;
    }
    function whenLabel(ts) {
        const d = new Date(ts), now = new Date();
        const clock = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        if (d.toDateString() === now.toDateString()) return (Date.now() - ts) < 3600000 ? relativeTime(ts) : 'Today ' + clock;
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + clock;
    }
    function versionLabel(m) { return new Date(m.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

    async function currentText(target) {
        const tab = findTab(target.dbName, target.fileId);
        const live = tab ? editorText(tab) : null;
        if (live != null) return { text: live, live: true, tab };
        const rec = await getRecord(target.dbName, target.fileId);
        return { text: rec ? (rec.content || '') : '', live: false, tab: null, rec };
    }

    async function diffWithCurrent(m) {
        const target = currentTarget(); if (!target || !W.CodeMiniDiff) return;
        const [old, cur] = await Promise.all([history.getContent(m.id), currentText(target)]);
        if (old == null) { toast('That entry is no longer stored.'); return; }
        W.CodeMiniDiff.openStatic({ key: 'hist:' + m.id + ':' + fnv1a(cur.text), name: target.name, kind: 'history', original: old, modified: cur.text, originalLabel: versionLabel(m), modifiedLabel: cur.live ? 'Editor' : 'Saved' });
    }
    async function diffWithPrevious(m) {
        const target = currentTarget(); if (!target || !W.CodeMiniDiff) return;
        const idx = tlRows.findIndex((r) => r.id === m.id), prev = idx >= 0 ? tlRows[idx + 1] : null;
        if (!prev) { toast('This is the oldest version kept, so there is nothing before it to compare.'); return; }
        const [a, b] = await Promise.all([history.getContent(prev.id), history.getContent(m.id)]);
        if (a == null || b == null) { toast('That entry is no longer stored.'); return; }
        W.CodeMiniDiff.openStatic({ key: 'hist:' + prev.id + ':' + m.id, name: target.name, kind: 'history', original: a, modified: b, originalLabel: versionLabel(prev), modifiedLabel: versionLabel(m) });
    }
    async function restore(m) {
        const target = currentTarget(); if (!target) return;
        const rec = await getRecord(target.dbName, target.fileId);
        if (!rec) { toast('\u201c' + target.name + '\u201d no longer exists.'); return; }
        if (rec.isLocked) { toast('\u201c' + target.name + '\u201d is locked, so its history is not kept.'); return; }
        const text = await history.getContent(m.id);
        if (text == null) { toast('That entry is no longer stored.'); return; }
        const cur = await currentText(target);
        // What is there now stays reachable: it becomes an entry before the file is overwritten.
        await quiet(history.record({ dbName: target.dbName, fileId: target.fileId, name: target.name, content: cur.text, kind: 'auto' }));
        if (cur.tab && cur.live) {
            putInEditor(cur.tab, text, 'local-history'); // undoable with Ctrl+Z
            markManual(target.fileId);
            if (typeof W.autoSaveFile === 'function') W.autoSaveFile(target.fileId, text, cur.tab);
        } else if (typeof W.autoSaveFile === 'function') {
            markManual(target.fileId);
            W.autoSaveFile(target.fileId, text, null, undefined, target.dbName);
        }
        toast('Restored the version from ' + versionLabel(m) + '.');
    }
    async function removeEntry(m) { await history.remove([m.id]); refreshTimeline(); }

    function buildRow(m, i) {
        const row = el('div', 'tl-row'); row.setAttribute('role', 'listitem'); row.dataset.tlId = m.id;
        const main = el('button', 'tl-main'); main.type = 'button';
        main.dataset.tlAction = 'diff';
        main.title = new Date(m.time).toLocaleString() + '. Click to compare it with the file as it is now.';
        const dot = el('span', 'tl-dot tl-' + m.kind); dot.setAttribute('aria-hidden', 'true');
        const text = el('span', 'tl-text');
        text.appendChild(el('span', 'tl-time', whenLabel(m.time)));
        const meta = el('span', 'tl-meta');
        meta.appendChild(document.createTextNode((KIND_LABEL[m.kind] || 'Saved') + ' \u00b7 ' + formatSize(m.size)));
        if (m.added != null) {
            const add = el('span', 'tl-add', ' +' + m.added), rem = el('span', 'tl-rem', ' \u2212' + m.removed);
            meta.append(add, rem);
        }
        text.appendChild(meta);
        main.append(dot, text);
        const acts = el('span', 'tl-actions');
        const mk = (action, ic, title) => { const b = el('button', 'tl-act'); b.type = 'button'; b.dataset.tlAction = action; b.title = title; b.setAttribute('aria-label', title); b.appendChild(icon(ic)); return b; };
        acts.append(
            mk('compare-prev', 'ri-arrow-left-right-line', i === tlRows.length - 1 ? 'Oldest version kept' : 'Compare with the version before it'),
            mk('restore', 'ri-history-line', 'Restore this version'),
            mk('delete', 'ri-delete-bin-line', 'Delete this entry')
        );
        row.append(main, acts);
        return row;
    }

    async function refreshTimeline() {
        if (!sec) return;
        const target = currentTarget();
        fileEl.textContent = target ? target.name : '';
        clearBtn.hidden = !target || !tlOpen;
        if (!tlOpen) return;
        const token = ++tlToken;
        const rows = target ? await quiet(history.list(target.dbName, target.fileId)) : [];
        if (token !== tlToken) return; // a newer refresh is running
        tlRows = rows || [];
        countEl.textContent = tlRows.length ? String(tlRows.length) : '';
        bodyEl.textContent = '';
        bodyEl.setAttribute('role', 'list');
        if (!target) { bodyEl.appendChild(el('div', 'tl-empty', 'Open a code file to see its history.')); return; }
        if (!historyOn()) { bodyEl.appendChild(el('div', 'tl-empty', 'Local History is off. Turn it on in Settings > Application.')); return; }
        if (!tlRows.length) { bodyEl.appendChild(el('div', 'tl-empty', 'No saved versions yet. Each save adds one.')); return; }
        tlRows.forEach((m, i) => bodyEl.appendChild(buildRow(m, i)));
    }

    function setOpen(open) {
        tlOpen = !!open;
        try { localStorage.setItem(OPEN_KEY, tlOpen ? '1' : '0'); } catch (e) { /* private mode */ }
        sec.classList.toggle('tl-open', tlOpen);
        toggleBtn.setAttribute('aria-expanded', tlOpen ? 'true' : 'false');
        bodyEl.hidden = !tlOpen;
        if (tlOpen) requestAnimationFrame(fitHeight);
        refreshTimeline();
    }

    function showForTarget(target) {
        pinned = target || null;
        // The Explorer has to be on screen for the Timeline to be seen (same way the editor reveals it elsewhere).
        const sidebar = document.getElementById('explorerSidebar');
        if (sidebar && !sidebar.classList.contains('open')) { const btn = document.getElementById('folderIconItem'); if (btn) btn.click(); }
        setOpen(true);
        if (sec) sec.scrollIntoView({ block: 'nearest' });
    }
    function showForTab(tab) { if (tab && tab.dataset.fileId) showForTarget({ dbName: tab.dataset.dbName || (curDb() && curDb().name), fileId: tab.dataset.fileId, name: tabName(tab) }); }
    function showForFile(file) { if (file && file.type === 'file') showForTarget({ dbName: curDb() && curDb().name, fileId: file.id, name: file.name }); }
    function noteActiveChanged() { pinned = null; if (tlOpen) refreshTimeline(); else if (fileEl) { const t = currentTarget(); fileEl.textContent = t ? t.name : ''; } }

    function armClear() {
        const target = currentTarget(); if (!target) return;
        if (clearArmed) {
            clearTimeout(clearArmed); clearArmed = null; clearBtn.classList.remove('tl-armed'); clearBtn.title = 'Clear the history of this file';
            history.clearFile(target.dbName, target.fileId).then(refreshTimeline);
            return;
        }
        clearBtn.classList.add('tl-armed'); clearBtn.title = 'Click again to clear the history of this file';
        toast('Click the bin again to clear this file\u2019s history.');
        clearArmed = setTimeout(() => { clearArmed = null; clearBtn.classList.remove('tl-armed'); clearBtn.title = 'Clear the history of this file'; }, 3500);
    }

    function buildTimeline() {
        const bar = document.querySelector('.explorer-status-bar');
        if (!bar || document.getElementById('explorerTimeline')) return;
        sec = el('div', 'tl-section'); sec.id = 'explorerTimeline';
        const head = el('div', 'tl-header');
        toggleBtn = el('button', 'tl-toggle'); toggleBtn.type = 'button'; toggleBtn.setAttribute('aria-expanded', 'false');
        toggleBtn.setAttribute('aria-controls', 'explorerTimelineBody');
        fileEl = el('span', 'tl-file'); countEl = el('span', 'tl-count');
        toggleBtn.append(icon('ri-arrow-right-s-line tl-chevron'), el('span', 'tl-title', 'TIMELINE'), fileEl, countEl);
        clearBtn = el('button', 'tl-clear'); clearBtn.type = 'button'; clearBtn.title = 'Clear the history of this file'; clearBtn.setAttribute('aria-label', 'Clear the history of this file');
        clearBtn.appendChild(icon('ri-delete-bin-line')); clearBtn.hidden = true;
        head.append(toggleBtn, clearBtn);
        bodyEl = el('div', 'tl-body'); bodyEl.id = 'explorerTimelineBody'; bodyEl.hidden = true;
        resizerEl = el('div', 'tl-resizer'); resizerEl.setAttribute('role', 'separator'); resizerEl.setAttribute('aria-orientation', 'horizontal');
        resizerEl.setAttribute('aria-label', 'Resize Timeline'); resizerEl.setAttribute('aria-controls', 'explorerTimelineBody');
        resizerEl.setAttribute('aria-valuemin', String(TL_MIN)); resizerEl.tabIndex = 0;
        resizerEl.title = 'Drag to resize. Double-click to reset.';
        sec.append(resizerEl, head, bodyEl);
        bar.parentNode.insertBefore(sec, bar);

        let startH = 0, startRoom = 0;
        if (typeof W.makeResizable === 'function') W.makeResizable(resizerEl, { // the app's own handle helper: mouse and touch
            cursor: 'ns-resize',
            onStart: () => { if (!tlOpen) return false; startH = bodyEl.offsetHeight; startRoom = listRoom(); },
            onMove: (dx, dy) => {
                const v = clampHeight(startH - dy, startH, startRoom, TL_MIN, TL_MIN_LIST);
                bodyEl.style.height = v + 'px'; bodyEl.classList.add('tl-sized'); resizerEl.setAttribute('aria-valuenow', String(v));
            },
            onEnd: () => rememberHeight(bodyEl.offsetHeight)
        });
        resizerEl.addEventListener('dblclick', resetHeight);
        resizerEl.addEventListener('keydown', (e) => {
            const step = e.shiftKey ? TL_STEP * 4 : TL_STEP;
            if (e.key === 'Home') { e.preventDefault(); resetHeight(); return; }
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            rememberHeight(paintHeight(bodyEl.offsetHeight + (e.key === 'ArrowUp' ? step : -step)));
        });
        W.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitHeight, 120); });
        toggleBtn.addEventListener('click', () => { if (tlOpen) pinned = null; setOpen(!tlOpen); });
        clearBtn.addEventListener('click', armClear);
        bodyEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-tl-action]'); if (!btn) return;
            const row = btn.closest('.tl-row'); const m = row && tlRows.find((r) => r.id === row.dataset.tlId); if (!m) return;
            const a = btn.dataset.tlAction;
            if (a === 'diff') diffWithCurrent(m); else if (a === 'compare-prev') diffWithPrevious(m);
            else if (a === 'restore') restore(m); else if (a === 'delete') removeEntry(m);
        });
        loadHeight();
        let saved = '0'; try { saved = localStorage.getItem(OPEN_KEY) || '0'; } catch (e) { /* private mode */ }
        setOpen(saved === '1');
    }

    // ---------------------------------------------------------------------------------------------
    // Settings changes, ways in, start-up
    // ---------------------------------------------------------------------------------------------
    function onSettingChanged(key) {
        if (key === 'autoSave') renderAutoSave();
        else if (key === 'hotExit') {
            if (!hotExitOn()) { dirtyTabs.forEach((t) => { clearTimeout(t._cmTimer); t._cmTimer = null; }); dirtyTabs.clear(); quiet(store.clearBackups()); }
            else document.querySelectorAll('.tab.unsaved-blink').forEach((t) => noteEdit(t));
        } else if (key === 'localHistory' || key === 'historyMaxEntries' || key === 'historyMaxDays') { quiet(history.sweep()); refreshTimeline(); }
    }
    function explorerOptions(file) {
        if (!file || file.type !== 'file' || file.isLocked) return [];
        return [{ icon: 'ri-history-line', text: 'Local History...', handler: () => showForFile(file) }];
    }
    function clearAllHistory() { return quiet(store.clearHistory()).then(() => refreshTimeline()); }

    Object.assign(api, {
        pageId, noteOpened, noteEdit, noteSaved, tabClosing, noteActiveChanged, markManual, recoverFor, hasReview, reviewRecovered,
        purgeDatabases, onSettingChanged, explorerOptions, showForTab, showForFile, clearAllHistory, refreshTimeline, flushAll,
        history, store, toggleAutoSave, renderAutoSave, activeTab
    });
    W.CodeMiniHistory = api;

    function start() {
        buildAutoSaveItem(); buildTimeline();
        quiet(history.sweep()); // old entries leave at start-up
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})(typeof window !== 'undefined' ? window : globalThis);
