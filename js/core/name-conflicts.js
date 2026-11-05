// ==========================================
// name-conflicts.js
// ==========================================
// What happens when something is copied, moved, pasted, dropped, imported or restored into a place that already
// has an item with that name. It used to be renamed to "name(1).ext" every time, with no say in the matter.
// Now each clash asks: Replace, Skip or Rename (the old behaviour), with both names and last-modified times shown,
// and, when more items are waiting, a "apply to all remaining items" box and a Stop button.
//
// Every caller does the same three steps, because a dialog is asynchronous and an IndexedDB transaction is not
// allowed to wait for one (it would commit and close underneath the dialog):
//   1. read what is already at the destination,
//   2. plan = await CodeMiniConflicts.planPlacement({ items, existing, parentId, ... })   (this is where the
//      person is asked; nothing has been written yet, so Stop leaves everything as it was),
//   3. write everything in one transaction, following plan.entries.
//
// The first half is pure (no DOM, no globals) and is tested in Node by tests/name-conflicts.test.js. The second
// half is the dialog, built from DOM nodes so a file name can only ever be text.
(function (root) {
    'use strict';

    const lower = (s) => String(s == null ? '' : s).toLowerCase();
    const parentOf = (r) => r.parentId || 'root';
    const isContainer = (r) => !!r && (r.type === 'folder' || r.type === 'workspace');

    // Same numbering the rest of the app uses ("name(1).ext", ".gitignore(1)"), kept here so Node can run it.
    function uniqueNameDefault(existing, parentId, baseName, type) {
        parentId = parentId || 'root';
        let finalName = baseName, counter = 1;
        const dot = type === 'file' ? baseName.lastIndexOf('.') : -1;
        const ext = dot > 0 ? baseName.slice(dot) : '', base = dot > 0 ? baseName.slice(0, dot) : baseName;
        while (existing.some((f) => parentOf(f) === parentId && lower(f.name) === lower(finalName))) { finalName = `${base}(${counter})${ext}`; counter++; }
        return finalName;
    }

    function descendantsOf(list, id) {
        const kids = new Map();
        list.forEach((r) => { const p = parentOf(r); if (!kids.has(p)) kids.set(p, []); kids.get(p).push(r); });
        const out = [], stack = [id], seen = new Set([id]);
        while (stack.length) {
            (kids.get(stack.pop()) || []).forEach((c) => { if (seen.has(c.id)) return; seen.add(c.id); out.push(c); if (isContainer(c)) stack.push(c.id); });
        }
        return out;
    }

    // How big a stored file is, for the dialog. Folders have no size of their own (they show an item count).
    function sizeOfRecord(r) {
        if (!r || isContainer(r) || r.isLocked || typeof r.content !== 'string') return null;
        if (r.encoding === 'base64') return Math.floor(r.content.length * 3 / 4);
        return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(r.content).length : r.content.length;
    }
    // A stored record -> the shape the planner and dialog use. extra: { count, timestamp, ... } overrides.
    function toItem(record, extra) {
        return Object.assign({ id: record.id, name: record.name, type: record.type, timestamp: record.timestamp, size: sizeOfRecord(record), record }, extra || {});
    }

    // items: [{ id, name, type, timestamp, size?, count?, destParentId? }] to be placed directly inside parentId
// (or inside their own destParentId when they carry one: a restore puts each item back where it came from).
    // existing: every record in the destination database (so a replaced folder can be emptied properly).
    // Options: ignoreIds   records to leave out of the comparison (a same-database move: the item itself)
    //          protectIds  records that must survive (the sources) - a clash that contains one cannot be replaced
    //          verb ('moving' | 'copying' | 'importing' | 'restoring'), where (a place's name, for the sentence)
    //          ask(info) -> Promise<{ choice: 'replace'|'skip'|'rename'|'stop', applyToAll }>   (defaults to the dialog)
    // Returns { stopped, entries: [{ item, action: 'place'|'rename'|'replace'|'skip', name, removed }], counts }.
    // removed (replace only) = the existing records to delete, the clashing item and everything inside it.
    async function planPlacement(opts) {
        const items = opts.items || [];
        const parentId = opts.parentId || 'root';
        const uniqueName = opts.uniqueName || (root.getUniqueFileName && root.getUniqueFileName.bind(root)) || uniqueNameDefault;
        const ask = opts.ask || (root.CodeMiniConflicts && root.CodeMiniConflicts.askUser);
        const ignore = new Set(opts.ignoreIds || []);
        const protect = new Set([...(opts.protectIds || []), ...items.map((i) => i.id), ...ignore]);
        let live = (opts.existing || []).filter((r) => !ignore.has(r.id));
        const entries = [];
        const counts = { placed: 0, renamed: 0, replaced: 0, skipped: 0 };
        let remembered = null;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const kind = isContainer(item) ? 'folder' : 'file';
            const home = item.destParentId !== undefined ? (item.destParentId || 'root') : parentId;
            const markPlaced = (name) => { live.push({ id: '__new_' + i, __placeholder: true, parentId: home, name, type: item.type }); };
            const clash = live.find((f) => parentOf(f) === home && lower(f.name) === lower(item.name));

            if (!clash) { entries.push({ item, action: 'place', name: item.name }); counts.placed++; markPlaced(item.name); continue; }

            // A copy pasted into the folder it came from: that is "make another one", not a conflict to ask about.
            if (clash.id === item.id) {
                const name = uniqueName(live, home, item.name, kind);
                entries.push({ item, action: 'rename', name }); counts.renamed++; markPlaced(name); continue;
            }

            const removedAll = isContainer(clash) ? [clash].concat(descendantsOf(live, clash.id)) : [clash];
            const removedReal = removedAll.filter((r) => !r.__placeholder);
            const locked = removedReal.some((r) => r.isLocked);
            const touchesSource = removedReal.some((r) => protect.has(r.id));
            const canReplace = !locked && !touchesSource && !clash.__placeholder;
            const reason = locked ? 'locked' : (touchesSource ? 'source' : (clash.__placeholder ? 'batch' : null));

            let decision = null;
            if (remembered && (remembered !== 'replace' || canReplace)) decision = { choice: remembered };
            if (!decision) {
                if (!ask) throw new Error('planPlacement: no way to ask the person about a name clash');
                const answer = await ask({
                    verb: opts.verb || 'moving', where: opts.where || '',
                    item: { name: item.name, type: item.type, timestamp: item.timestamp, size: item.size == null ? null : item.size, count: item.count == null ? null : item.count },
                    existing: { name: clash.name, type: clash.type, timestamp: clash.timestamp, size: sizeOfRecord(clash), count: isContainer(clash) ? removedReal.length - 1 : null, isLocked: !!clash.isLocked },
                    canReplace, blockedReason: reason, renameTo: uniqueName(live, home, item.name, kind),
                    index: i, total: items.length, remaining: items.length - i - 1
                });
                if (!answer || answer.choice === 'stop') return { stopped: true, entries: [], counts };
                decision = { choice: answer.choice === 'replace' && !canReplace ? 'rename' : answer.choice };
                if (answer.applyToAll) remembered = decision.choice;
            }

            if (decision.choice === 'skip') { entries.push({ item, action: 'skip', name: item.name }); counts.skipped++; }
            else if (decision.choice === 'replace') {
                const gone = new Set(removedReal.map((r) => r.id));
                live = live.filter((r) => !gone.has(r.id));
                entries.push({ item, action: 'replace', name: item.name, removed: removedReal }); counts.replaced++; markPlaced(item.name);
            } else {
                const name = uniqueName(live, home, item.name, kind);
                entries.push({ item, action: 'rename', name }); counts.renamed++; markPlaced(name);
            }
        }
        return { stopped: false, entries, counts };
    }

    // "3 moved, 1 skipped" style tail for toasts.
    function describeCounts(counts) {
        const bits = [];
        if (counts.skipped) bits.push(`${counts.skipped} skipped`);
        if (counts.replaced) bits.push(`${counts.replaced} replaced`);
        return bits.length ? ` (${bits.join(', ')})` : '';
    }

    const api = { planPlacement, uniqueNameDefault, descendantsOf, sizeOfRecord, toItem, describeCounts, isContainer };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof document === 'undefined') return; // Node: logic only

    // ---------------------------------------------------------------------------------------------
    // Replaced items are not simply gone: they go to the Recycle Bin the way a deleted item does (when it is
    // on), and tabs open on them are closed (the record they edit no longer exists).
    function afterReplace(removed, dbName) {
        if (!removed || !removed.length) return;
        const binOn = !(root.appSettings && root.appSettings.enableTrashBin === false);
        if (binOn && Array.isArray(root.recycleBin)) {
            removed.forEach((r) => { const copy = Object.assign({}, r); copy.deletedAt = Date.now(); copy._db = dbName; root.recycleBin.push(copy); });
        }
        if (typeof root.closeTabsForMovedFiles === 'function') root.closeTabsForMovedFiles(removed.map((r) => r.id), dbName);
        if (typeof root.renderStacks === 'function') root.renderStacks();
    }

    // ---------------------------------------------------------------------------------------------
    // The dialog
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    function formatDate(ts) {
        if (typeof ts !== 'number' || !isFinite(ts)) return 'Unknown';
        try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts)); } catch (e) { return new Date(ts).toLocaleString(); }
    }
    function formatBytes(n) {
        if (n == null) return '';
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
        return (n / 1048576).toFixed(1) + ' MB';
    }
    function iconFor(info) {
        const wrap = el('span', 'cf-icon');
        if (info.type === 'folder' || info.type === 'workspace') { const i = el('i', 'ri-folder-2-line file-icon icon-folder'); wrap.appendChild(i); return wrap; }
        let markup = '';
        try { markup = typeof root.getFileIconHTML === 'function' ? root.getFileIconHTML(info.name) : ''; } catch (e) { markup = ''; }
        if (markup) { // fixed markup chosen from the extension (the name is never put in it); DOMParser keeps it out of innerHTML
            const doc = new DOMParser().parseFromString(markup, 'text/html');
            Array.from(doc.body.childNodes).forEach((n) => wrap.appendChild(document.importNode(n, true)));
        } else wrap.appendChild(el('i', 'ri-file-text-line file-icon'));
        return wrap;
    }
    function metaLine(info) {
        const parts = ['Modified: ' + formatDate(info.timestamp)];
        if (info.type === 'folder' || info.type === 'workspace') { if (info.count != null) parts.push(info.count === 1 ? '1 item' : info.count + ' items'); }
        else if (info.size != null) parts.push(formatBytes(info.size));
        return parts.join('  \u00b7  ');
    }
    function row(label, info, badge) {
        const r = el('div', 'cf-row');
        r.appendChild(iconFor(info));
        const body = el('div', 'cf-info');
        const top = el('div', 'cf-top'); top.appendChild(el('span', 'cf-tag', label)); if (badge) top.appendChild(el('span', 'cf-badge ' + badge.toLowerCase(), badge));
        body.appendChild(top);
        const name = el('div', 'cf-name', info.name); name.title = info.name; body.appendChild(name);
        body.appendChild(el('div', 'cf-meta', metaLine(info)));
        r.appendChild(body);
        return r;
    }

    let queue = Promise.resolve();
    // One dialog at a time, even if two operations clash at once.
    function askUser(info) { const p = queue.then(() => showDialog(info)); queue = p.catch(() => {}); return p; }

    function showDialog(info) {
        return new Promise((resolve) => {
            const previouslyFocused = document.activeElement;
            const backdrop = el('div', 'modal-backdrop cf-backdrop');
            const dlg = el('div', 'island-modal cf-modal');
            dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true');
            const kindWord = (info.existing.type === 'folder' || info.existing.type === 'workspace') ? 'Folder' : 'File';
            const sameKind = (info.existing.type === 'folder' || info.existing.type === 'workspace') === (info.item.type === 'folder' || info.item.type === 'workspace');
            const title = el('h3', '', sameKind ? kindWord + ' already exists' : 'Name already in use');
            title.id = 'cfTitle'; dlg.setAttribute('aria-labelledby', 'cfTitle');
            dlg.appendChild(title);
            const verb = { moving: 'Moving', copying: 'Copying', importing: 'Importing', restoring: 'Restoring' }[info.verb] || 'Moving';
            dlg.appendChild(el('p', 'cf-lead', `${verb} \u201c${info.item.name}\u201d${info.where ? ' to ' + info.where : ''}: something with this name is already there.`));

            const t1 = info.existing.timestamp, t2 = info.item.timestamp;
            let existingBadge = '', incomingBadge = '';
            if (typeof t1 === 'number' && typeof t2 === 'number' && Math.abs(t1 - t2) >= 2000) { existingBadge = t1 > t2 ? 'Newer' : 'Older'; incomingBadge = t2 > t1 ? 'Newer' : 'Older'; }
            const compare = el('div', 'cf-compare');
            compare.appendChild(row('Already here', info.existing, existingBadge));
            compare.appendChild(row(info.verb === 'restoring' ? 'Being restored' : (info.verb === 'importing' ? 'Importing' : (info.verb === 'copying' ? 'Copying' : 'Moving')), info.item, incomingBadge));
            dlg.appendChild(compare);

            const notes = el('div', 'cf-notes');
            const existingIsFolder = info.existing.type === 'folder' || info.existing.type === 'workspace';
            if (!info.canReplace) {
                notes.appendChild(el('div', 'cf-note warn', info.blockedReason === 'locked' ? 'The existing item is locked, so it can\u2019t be replaced.'
                    : info.blockedReason === 'source' ? 'The existing item contains what is being moved or copied, so it can\u2019t be replaced.'
                    : 'Another item in this batch already took that name, so only Skip or Rename are possible.'));
            } else if (existingIsFolder) {
                notes.appendChild(el('div', 'cf-note warn', 'Replace deletes the existing folder and everything in it' + (root.appSettings && root.appSettings.enableTrashBin === false ? '.' : ' (it goes to the Recycle Bin).')));
            } else if (!(root.appSettings && root.appSettings.enableTrashBin === false)) {
                notes.appendChild(el('div', 'cf-note', 'The replaced file goes to the Recycle Bin.'));
            }
            notes.appendChild(el('div', 'cf-note', `Rename keeps both: this one is saved as \u201c${info.renameTo}\u201d.`));
            dlg.appendChild(notes);

            let applyBox = null;
            if (info.remaining > 0) {
                const label = el('label', 'cf-apply');
                applyBox = el('input'); applyBox.type = 'checkbox'; applyBox.id = 'cfApplyAll';
                label.appendChild(applyBox); label.appendChild(el('span', '', 'Apply this choice to all remaining items'));
                dlg.appendChild(label);
            }

            const actions = el('div', 'modal-actions cf-actions');
            const finish = (choice) => {
                const applyToAll = !!(applyBox && applyBox.checked && choice !== 'stop');
                document.removeEventListener('keydown', onKey, true);
                dlg.classList.remove('show'); backdrop.classList.remove('show');
                setTimeout(() => { dlg.remove(); backdrop.remove(); }, 220);
                try { if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus(); } catch (e) { /* the element may be gone */ }
                resolve({ choice, applyToAll });
            };
            const button = (cls, text, choice, id) => { const b = el('button', cls, text); b.type = 'button'; b.dataset.choice = choice; if (id) b.id = id; b.addEventListener('click', () => finish(choice)); actions.appendChild(b); return b; };
            if (info.total > 1) button('btn-cancel', 'Stop', 'stop', 'cfStop').title = 'Cancel the whole operation; nothing is changed';
            button('btn-cancel', 'Skip', 'skip', 'cfSkip');
            const replaceBtn = button('btn-cancel cf-replace', 'Replace', 'replace', 'cfReplace');
            if (!info.canReplace) { replaceBtn.disabled = true; replaceBtn.title = 'Not possible here'; }
            const renameBtn = button('btn-submit', 'Rename', 'rename', 'cfRename');
            dlg.appendChild(actions);

            // Esc = Stop (or Skip when there is only one item); Tab stays inside the dialog.
            function onKey(e) {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(info.total > 1 ? 'stop' : 'skip'); return; }
                if (e.key !== 'Tab') return;
                const focusables = Array.from(dlg.querySelectorAll('button:not([disabled]), input')).filter((n) => n.offsetParent !== null);
                if (!focusables.length) return;
                const first = focusables[0], last = focusables[focusables.length - 1];
                if (!dlg.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
                else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
            document.addEventListener('keydown', onKey, true);

            document.body.appendChild(backdrop); document.body.appendChild(dlg);
            requestAnimationFrame(() => { backdrop.classList.add('show'); dlg.classList.add('show'); });
            // The dialog fades in with a visibility transition, and an element that is still hidden cannot take focus.
            setTimeout(() => { if (dlg.isConnected) renameBtn.focus(); }, 60);
        });
    }

    api.askUser = askUser; api.afterReplace = afterReplace;
    root.CodeMiniConflicts = api;
})(typeof window !== 'undefined' ? window : globalThis);
