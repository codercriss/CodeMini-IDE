// ==========================================
// up-down.js
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
    // --- Hooks for Upload & Download Features ---
    const uploadBtn = document.querySelector('.ri-upload-line[title="Upload"]');
    const downloadBtn = document.querySelector('.ri-download-line[title="Download"]');

    if(uploadBtn) uploadBtn.addEventListener('click', toggleUploadZone);
    if(downloadBtn) downloadBtn.addEventListener('click', toggleDownloadMode);

    setupUploadAndDownload();
});

// --- Upload & Download Logic ---

function toggleUploadZone() {
    const upZone = document.getElementById('explorerUploadZone');
    const dlZone = document.getElementById('explorerDownloadToolbar');
    const mainToolbar = document.querySelector('.file-browser-toolbar');

    if (upZone && dlZone && mainToolbar) {
        if (upZone.style.display === 'none') {
            upZone.style.display = 'flex';
            dlZone.style.display = 'none';
            isDownloadMultiSelectMode = false;
            updateDownloadState();
            mainToolbar.style.borderBottom = 'none';
        } else {
            upZone.style.display = 'none';
            mainToolbar.style.borderBottom = '';
        }
    }
}

function toggleDownloadMode() {
    const upZone = document.getElementById('explorerUploadZone');
    const dlZone = document.getElementById('explorerDownloadToolbar');
    const mainToolbar = document.querySelector('.file-browser-toolbar');
    
    isDownloadMultiSelectMode = !isDownloadMultiSelectMode;
    updateDownloadState();

    if (isDownloadMultiSelectMode) {
        if (dlZone) dlZone.style.display = 'flex';
        if (upZone) upZone.style.display = 'none';
        if (mainToolbar) mainToolbar.style.borderBottom = 'none';
    } else {
        if (dlZone) dlZone.style.display = 'none';
        if (mainToolbar) mainToolbar.style.borderBottom = '';
    }
}

function updateDownloadState() {
    const downloadBtn = document.querySelector('.ri-download-line[title="Download"]');
    if (downloadBtn) {
        downloadBtn.style.color = isDownloadMultiSelectMode ? 'var(--accent-new)' : 'var(--icon-gray)';
    }

    if (!isDownloadMultiSelectMode) {
        downloadSelectedFiles.clear();
        document.querySelectorAll('.file-item.download-selected-file').forEach(el => el.classList.remove('download-selected-file'));
    }
    updateDownloadToolbar();
}

function updateDownloadToolbar() {
    const rawBtn = document.getElementById('dlRawBtn');
    if (rawBtn) {
        rawBtn.disabled = downloadSelectedFiles.size === 0;
    }
    // Also called whenever the download toggle or its selection changes: keep the status-bar selection icons in step.
    if (window.refreshExplorerSelectActions) window.refreshExplorerSelectActions();
}

function setupUploadAndDownload() {
    const zone = document.getElementById('explorerUploadZone');
    const input = document.getElementById('explorerUploadInput');
    
    if (zone && input) {
        zone.addEventListener('click', () => input.click());
        
        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.add('drag-over');
        });
        
        zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
        
        zone.addEventListener('drop', async (e) => {
            e.preventDefault();
            zone.classList.remove('drag-over');
            const items = e.dataTransfer.items;
            if (items && items.length > 0) {
                await handleDropItems(items);
                toggleUploadZone();
            }
        });
        
        input.addEventListener('change', async (e) => {
            if (e.target.files.length > 0) {
                await processFileList(e.target.files);
                toggleUploadZone();
            }
            input.value = '';
        });
    }

    document.getElementById('dlRawBtn')?.addEventListener('click', handleDownloadRaw);
    document.getElementById('dlJsonBtn')?.addEventListener('click', handleDownloadJson);
    document.getElementById('dlZipBtn')?.addEventListener('click', handleDownloadZip);
}

// Reads a File as plain text (existing behavior) unless its extension is a
// known binary type, in which case it's read as base64 instead - reading
// binary content with file.text() silently corrupts it (UTF-8 decoding
// mangles arbitrary bytes), which is what made opening any image, video, or
// archive uploaded through this app broken from the moment it was uploaded.
async function readFileAsAppropriate(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    const binaryExts = window.BINARY_FILE_EXTS || [];
    if (binaryExts.includes(ext)) {
        const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                // reader.result is a data URL like "data:<mime>;base64,<payload>" -
                // store just the payload; the mime type is cheaply re-derivable
                // from the extension wherever it's needed (see getMimeTypeForExt).
                const result = reader.result;
                const commaIdx = result.indexOf(',');
                resolve(commaIdx !== -1 ? result.slice(commaIdx + 1) : result);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        return { content: base64, encoding: 'base64' };
    }
    return { content: await file.text(), encoding: undefined };
}

// True only for a real CodeMini export (what handleDownloadJson writes): an array of filesystem
// records. The old test - data[0].id && data[0].type - also matched any ordinary JSON data file such
// as [{"id": 1, "type": "a"}], which was then "restored" as garbage filesystem records instead of
// being uploaded as the file it is.
function isCodeMiniExport(data) {
    return Array.isArray(data) && data.length > 0 && data.every(d =>
        d && typeof d === 'object' && d.id != null && typeof d.name === 'string' &&
        (d.type === 'file' || d.type === 'folder' || d.type === 'workspace'));
}

// Recreate structured files and directories from Drag and Drop
async function handleDropItems(items) {
    let targetParentId = folderStack[folderStack.length - 1].id;
    // Captured now, synchronously, alongside targetParentId - reading files
    // below (entry.file(), FileReader, possibly many of them for a deep
    // folder drop) can take real time, and if the user switches windows
    // mid-upload, the module-level `db` will already point at the new
    // window's database by the time we get to actually writing. Passing
    // this captured reference through keeps the write targeted at the
    // window the upload was actually started in.
    let targetDb = db;
    let filesToSave = [];
    
    const readEntry = async (entry, currentPath) => {
        if (entry.isFile) {
            const file = await new Promise(r => entry.file(r));
            
            // Special handling: Native App JSON Restoration
            if (file.name.endsWith('.json') && currentPath === "") {
                const content = await file.text();
                try {
                    const data = JSON.parse(content);
                    if (isCodeMiniExport(data)) {
                        await importJsonData(data, targetParentId, targetDb);
                        return; // Successfully handled directly
                    }
                } catch(e) {} // Not matching standard array format, handle as raw file
            }
            
            const { content, encoding } = await readFileAsAppropriate(file);
            filesToSave.push({ name: file.name, path: currentPath, type: 'file', content: content, encoding: encoding, modified: file.lastModified });
        } else if (entry.isDirectory) {
            filesToSave.push({ name: entry.name, path: currentPath, type: 'folder' });
            const reader = entry.createReader();
            
            const readEntriesPromise = async () => {
                let entries = [];
                let hasMore = true;
                while (hasMore) {
                    const batch = await new Promise(r => reader.readEntries(r));
                    if (batch.length === 0) hasMore = false;
                    else entries.push(...batch);
                }
                return entries;
            };
            
            const allEntries = await readEntriesPromise();
            for(let e of allEntries) {
                await readEntry(e, currentPath ? currentPath + '/' + entry.name : entry.name);
            }
        }
    };
    
    // The drop's DataTransferItemList is only readable while the drop event is being dispatched -
    // once this function yields (the first entry.file() callback), items.length reads 0. The old
    // loop called webkitGetAsEntry() for one item per iteration with an await in between, so
    // dropping several files/folders at once only ever imported the FIRST one. Grab every entry
    // now, synchronously, then read them at leisure.
    const droppedEntries = [];
    for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
        if (entry) droppedEntries.push(entry);
    }
    // Workspace Trust: files from outside CodeMini are about to land in this workspace. The entries are already
    // captured above, so a dialog can safely take its time. May redirect everything into a new restricted window.
    const trustRoute = window.WorkspaceTrust ? await window.WorkspaceTrust.routeIncoming({ dbName: targetDb && targetDb.name }) : null;
    if (trustRoute === 'cancel') return;
    if (trustRoute) { targetDb = trustRoute.db; targetParentId = trustRoute.parentId; }

    for (const entry of droppedEntries) await readEntry(entry, "");
    
    if (filesToSave.length > 0) {
        await saveExtractedFiles(filesToSave, targetParentId, targetDb);
    }
    if (trustRoute) trustRoute.finish();
}

// Flat file lists from file input (Does not natively capture deep directories without webkitdirectory)
async function processFileList(files) {
    let targetParentId = folderStack[folderStack.length - 1].id;
    // See handleDropItems above for why this is captured synchronously here
    // rather than left for saveExtractedFiles/importJsonData to read fresh.
    let targetDb = db;
    let filesToSave = [];

    // Workspace Trust: see handleDropItems above.
    const trustRoute = window.WorkspaceTrust ? await window.WorkspaceTrust.routeIncoming({ dbName: targetDb && targetDb.name }) : null;
    if (trustRoute === 'cancel') return;
    if (trustRoute) { targetDb = trustRoute.db; targetParentId = trustRoute.parentId; }
    
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
        // Native App JSON Restoration
        if (file.name.endsWith('.json')) {
            const content = await file.text();
            try {
                const data = JSON.parse(content);
                if (isCodeMiniExport(data)) {
                    await importJsonData(data, targetParentId, targetDb);
                    continue; 
                }
            } catch(e) {}
        }
        
        const { content, encoding } = await readFileAsAppropriate(file);
        let path = file.webkitRelativePath || "";
        if (path) {
            const parts = path.split('/');
            parts.pop(); 
            path = parts.join('/');
        }
        filesToSave.push({ name: file.name, path: path, type: 'file', content: content, encoding: encoding, modified: file.lastModified });
    }
    if (filesToSave.length > 0) {
        await saveExtractedFiles(filesToSave, targetParentId, targetDb);
    }
    if (trustRoute) trustRoute.finish();
}

// Everything in a database's filesystem store, read in its own transaction (a question to the person can then take
// as long as it likes before the writing transaction is opened).
function readAllRecords(database) {
    return new Promise(resolve => {
        const req = database.transaction('filesystem', 'readonly').objectStore('filesystem').getAll();
        req.onsuccess = (ev) => resolve(ev.target.result || []);
        req.onerror = () => resolve([]);
    });
}

async function saveExtractedFiles(filesToSave, rootParentId, explicitDb) {
    // Mirrors saveFileToDB's (app.js) executingDbInstance pattern: use the
    // db this operation was actually meant for (passed in by a caller that
    // captured it before its own async gap), falling back to the live
    // global only for callers with no such gap of their own.
    const executingDbInstance = explicitDb || db;

    // What is being brought in, as the top-level things that land directly in the destination folder: a file
    // with no path is itself one; anything inside folders belongs to its first folder (a whole dropped or
    // extracted folder is ONE item). Those are the only things that can clash - what is inside a folder that
    // is new, replaced or renamed lands in a fresh folder.
    const topKey = (f) => f.path ? 'd:' + f.path.split('/')[0] : (f.type === 'folder' ? 'd:' + f.name : 'f:' + f.name);
    const tops = new Map();
    filesToSave.forEach(f => {
        const key = topKey(f);
        if (!tops.has(key)) tops.set(key, { key, name: key.slice(2), type: key[0] === 'd' ? 'folder' : 'file', count: 0, timestamp: null, size: null });
        const t = tops.get(key);
        if (f.type === 'folder') return;
        t.count++;
        if (typeof f.modified === 'number') t.timestamp = Math.max(t.timestamp || 0, f.modified);
        if (t.type === 'file') t.size = CodeMiniConflicts.sizeOfRecord(f);
    });
    const topList = [...tops.values()];

    const existingAtStart = await readAllRecords(executingDbInstance);
    const dest = existingAtStart.find(r => r.id === rootParentId);
    const plan = await CodeMiniConflicts.planPlacement({
        // Synthetic ids: an imported item is a NEW record, never "the same one" as something already stored.
        items: topList.map((t, i) => ({ id: '__import_' + i, name: t.name, type: t.type, timestamp: t.timestamp, size: t.size, count: t.type === 'folder' ? t.count : null, key: t.key })),
        existing: existingAtStart, parentId: rootParentId, verb: 'importing', where: dest ? dest.name : ''
    });
    if (plan.stopped) { if (window.showSuccessToast) window.showSuccessToast('Import cancelled. Nothing was changed.'); return; }
    const skipKeys = new Set(plan.entries.filter(e => e.action === 'skip').map(e => e.item.key));
    const nameForKey = new Map(plan.entries.map(e => [e.item.key, e.name]));
    const removedAll = plan.entries.flatMap(e => e.removed || []);
    const toSave = filesToSave.filter(f => !skipKeys.has(topKey(f)));
    if (toSave.length === 0) { if (window.showSuccessToast) window.showSuccessToast('Nothing was imported' + CodeMiniConflicts.describeCounts(plan.counts)); return; }

    const tx = executingDbInstance.transaction('filesystem', 'readwrite');
    const store = tx.objectStore('filesystem');

    return new Promise(resolve => {
        const existingFiles = existingAtStart.filter(r => !removedAll.some(x => x.id === r.id));
        removedAll.forEach(r => store.delete(r.id)); // Replace: what was there goes first
        let pathMap = { "": rootParentId };

        const getOrCreatePath = (pathString) => {
            if (!pathString) return rootParentId;
            if (pathMap[pathString]) return pathMap[pathString];

            let currentPath = "";
            let currentParent = rootParentId;
            const parts = pathString.split('/');

            for (let dir of parts) {
                currentPath = currentPath ? currentPath + '/' + dir : dir;
                if (!pathMap[currentPath]) {
                    let newId = Date.now().toString() + Math.random().toString(36).substring(2);
                    // The first folder is the item the person decided about (it may have been renamed); deeper
                    // ones are inside a fresh folder, and are only numbered against duplicates within the import.
                    let safeDirName = currentParent === rootParentId && nameForKey.has('d:' + dir) ? nameForKey.get('d:' + dir) : window.getUniqueFileName(existingFiles, currentParent, dir, 'folder');

                    let newFolder = { id: newId, parentId: currentParent, name: safeDirName, type: 'folder', timestamp: Date.now() };
                    store.put(newFolder);
                    existingFiles.push(newFolder);
                    pathMap[currentPath] = newId;
                }
                currentParent = pathMap[currentPath];
            }
            return currentParent;
        };

        toSave.forEach(fItem => {
            let parentId = getOrCreatePath(fItem.path);
            let id = Date.now().toString() + Math.random().toString(36).substring(2);
            const atTop = parentId === rootParentId;

            if (fItem.type === 'folder') {
                let fullPath = fItem.path ? fItem.path + '/' + fItem.name : fItem.name;
                if (!pathMap[fullPath]) {
                    let safeFolderName = atTop && nameForKey.has('d:' + fItem.name) ? nameForKey.get('d:' + fItem.name) : window.getUniqueFileName(existingFiles, parentId, fItem.name, 'folder');
                    let newFolder = { id: id, parentId: parentId, name: safeFolderName, type: 'folder', timestamp: Date.now() };
                    pathMap[fullPath] = id;
                    store.put(newFolder);
                    existingFiles.push(newFolder);
                }
            } else {
                let safeFileName = atTop && nameForKey.has('f:' + fItem.name) ? nameForKey.get('f:' + fItem.name) : window.getUniqueFileName(existingFiles, parentId, fItem.name, 'file');
                let newFile = { id: id, parentId: parentId, name: safeFileName, type: 'file', content: fItem.content, encoding: fItem.encoding, timestamp: Date.now() };
                store.put(newFile);
                existingFiles.push(newFile);
            }
        });

        tx.oncomplete = () => {
            CodeMiniConflicts.afterReplace(removedAll, executingDbInstance.name);
            if (db === executingDbInstance) loadFilesFromDB();
            const tail = CodeMiniConflicts.describeCounts(plan.counts);
            if (tail && window.showSuccessToast) window.showSuccessToast('Imported' + tail);
            resolve();
        };
    });
}

// Robust JSON Restoration
async function importJsonData(data, targetParentId, explicitDb) {
    const executingDbInstance = explicitDb || db;

    // This path used to write records with whatever names the export held and never looked at what
    // was already in the target folder, so restoring an export twice (or into a folder that already
    // had a same-named item) left identically-named siblings. Read the target DB first, then ask about each
    // clash (Replace / Skip / Rename) before anything is written.
    const existingFiles = await readAllRecords(executingDbInstance);
    const dataIds = new Set(data.map(d => d.id));
    // The root level items of the import batch land directly in the target folder, so they're the only kind
    // that can clash (children live inside a brand-new folder).
    const roots = data.filter(item => !dataIds.has(item.parentId));
    const childrenOf = new Map();
    data.forEach(d => { if (dataIds.has(d.parentId)) { if (!childrenOf.has(d.parentId)) childrenOf.set(d.parentId, []); childrenOf.get(d.parentId).push(d); } });
    const within = (rootItem) => { const out = [], stack = [rootItem.id]; while (stack.length) (childrenOf.get(stack.pop()) || []).forEach(c => { out.push(c); stack.push(c.id); }); return out; };
    const dest = existingFiles.find(r => r.id === targetParentId);
    const plan = await CodeMiniConflicts.planPlacement({
        // Synthetic ids: an exported record's id is not the id of anything stored here, even if they look equal.
        items: roots.map((r, i) => ({ id: '__import_' + i, name: r.name, type: r.type === 'file' ? 'file' : 'folder', timestamp: r.timestamp, size: CodeMiniConflicts.sizeOfRecord(r), count: r.type === 'file' ? null : within(r).length, record: r })),
        existing: existingFiles, parentId: targetParentId, verb: 'importing', where: dest ? dest.name : ''
    });
    if (plan.stopped) { if (window.showSuccessToast) window.showSuccessToast('Import cancelled. Nothing was changed.'); return; }
    const entryOfRoot = new Map(plan.entries.map(e => [e.item.record.id, e]));
    const skippedIds = new Set();
    plan.entries.filter(e => e.action === 'skip').forEach(e => { skippedIds.add(e.item.record.id); within(e.item.record).forEach(c => skippedIds.add(c.id)); });
    const removedAll = plan.entries.flatMap(e => e.removed || []);

    const tx = executingDbInstance.transaction('filesystem', 'readwrite');
    const store = tx.objectStore('filesystem');

    return new Promise(resolve => {
        tx.oncomplete = () => {
            CodeMiniConflicts.afterReplace(removedAll, executingDbInstance.name);
            if (db === executingDbInstance) loadFilesFromDB();
            const tail = CodeMiniConflicts.describeCounts(plan.counts);
            if (tail && window.showSuccessToast) window.showSuccessToast('Imported' + tail);
            resolve();
        };

        removedAll.forEach(r => store.delete(r.id)); // Replace: what was there goes first
        let idMap = {};
        data.forEach(item => {
            idMap[item.id] = Date.now().toString() + Math.random().toString(36).substring(2);
        });

        data.forEach(item => {
            if (skippedIds.has(item.id)) return;
            let newItem = { ...item };
            newItem.id = idMap[item.id];

            // If parent exists in the imported JSON package, maintain relative hierarchy
            if (dataIds.has(item.parentId)) {
                newItem.parentId = idMap[item.parentId];
            } else {
                newItem.parentId = targetParentId;
                newItem.name = entryOfRoot.get(item.id).name;
            }
            newItem.timestamp = Date.now();
            store.put(newItem);
        });
        // Nothing left to write (everything was skipped): a transaction with no requests still completes.
    });
}

// Shared with editor.js/media.js: given a stored file record, reconstructs
// its real content as a Blob - decoding base64 back to actual binary bytes
// for binary files, or wrapping plain text as-is otherwise. Centralizes the
// "how do I get this file's real bytes back" logic so every download/player
// path handles base64 files identically instead of each needing its own
// decode logic (or, before this fix existed at all, silently treating the
// base64 string itself as if it were the file's literal text content).
window.getExtMimeType = function(ext) {
    const map = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp',
        mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg', m4v: 'video/mp4',
        mkv: 'video/x-matroska', avi: 'video/x-msvideo',
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
        zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
        tar: 'application/x-tar', gz: 'application/gzip', pdf: 'application/pdf',
        woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    };
    return map[ext] || 'application/octet-stream';
};

window.fileRecordToBlob = function(fileData) {
    const ext = (fileData.name || '').split('.').pop().toLowerCase();
    if (fileData.encoding === 'base64') {
        const mime = window.getExtMimeType(ext);
        const binaryStr = atob(fileData.content || '');
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    }
    return new Blob([fileData.content || ''], { type: 'text/plain' });
};

// A locked file's text is encrypted in storage, so a raw or zip download would only produce an empty file.
// Those files are skipped (the JSON export keeps them, still encrypted, and restores them locked).
function notifyLockedSkipped(count) {
    if (!count || !window.showCustomModal) return;
    window.showCustomModal({
        title: 'Locked files skipped',
        text: `${count} locked file${count === 1 ? ' was' : 's were'} not included. Remove the lock first to download ${count === 1 ? 'it' : 'them'}, or use the JSON export, which keeps locked files encrypted.`,
        submitText: 'OK'
    }, () => { if (typeof closeGenModal === 'function') closeGenModal(); });
}

async function handleDownloadRaw() {
    if (downloadSelectedFiles.size === 0) return;

    // Filter out folders and workspaces, keeping only actual files
    const allCandidates = Array.from(downloadSelectedFiles).filter(
        f => f.type !== 'folder' && f.type !== 'workspace'
    );
    const filesToDownload = allCandidates.filter(f => !f.isLocked);
    const lockedSkipped = allCandidates.length - filesToDownload.length;

    if (filesToDownload.length === 0 && lockedSkipped > 0) { notifyLockedSkipped(lockedSkipped); return; }
    if (filesToDownload.length === 0) {
        if (window.showCustomModal) {
            window.showCustomModal({
                title: 'Error', 
                text: 'No downloadable files selected. Folders cannot be downloaded as Raw text.', 
                submitText: 'OK'
            }, () => {});
        }
        return;
    }

    const tx = db.transaction('filesystem', 'readonly');
    const store = tx.objectStore('filesystem');

    // Helper to fetch file data asynchronously
    const getFileData = (id) => new Promise(resolve => {
        store.get(id).onsuccess = (e) => resolve(e.target.result);
    });

    for (let i = 0; i < filesToDownload.length; i++) {
        const fileObj = filesToDownload[i];
        const fileData = await getFileData(fileObj.id);
        
        if (fileData) {
            const blob = window.fileRecordToBlob(fileData);
            const url = URL.createObjectURL(blob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = fileData.name;
            
            // Append to body, click, and remove (required for Firefox compatibility)
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            
            // Small delay to prevent the browser from blocking concurrent downloads
            await new Promise(r => setTimeout(r, 100));
            URL.revokeObjectURL(url);
        }
    }

    toggleDownloadMode(); 
    notifyLockedSkipped(lockedSkipped);
}

async function handleDownloadJson() {
    if (downloadSelectedFiles.size === 0) return;
    const tx = db.transaction('filesystem', 'readonly');
    const allFiles = await new Promise(res => {
        tx.objectStore('filesystem').getAll().onsuccess = e => res(e.target.result);
    });

    const filesToExport = [];
    const addedIds = new Set();

    const addFileAndDescendants = (fileObj) => {
        if (addedIds.has(fileObj.id)) return;
        filesToExport.push(fileObj);
        addedIds.add(fileObj.id);

        if (fileObj.type === 'folder' || fileObj.type === 'workspace') {
            const children = allFiles.filter(f => f.parentId === fileObj.id);
            children.forEach(c => addFileAndDescendants(c));
        }
    };

    Array.from(downloadSelectedFiles).forEach(f => addFileAndDescendants(f));

    const blob = new Blob([JSON.stringify(filesToExport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `codemini_export_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toggleDownloadMode();
}

// Tree view: ticking a folder also ticks everything inside it, and the ZIP builder walks into every selected
// folder itself. Zipping all of those items would add the contents a second time at the top level of the archive,
// so only the items whose parent chain holds no selected item are kept (the folder brings its contents along).
// Pure: takes the selected records and every record of the database.
function selectionRoots(selected, allFiles) {
    const items = [], seen = new Set();
    Array.from(selected).forEach(f => { if (f && !seen.has(f.id)) { seen.add(f.id); items.push(f); } });
    const byId = new Map((allFiles || []).map(f => [f.id, f]));
    return items.filter(f => {
        let parent = byId.get(f.parentId); const guard = new Set();
        while (parent && !guard.has(parent.id)) {
            if (parent.id !== f.id && seen.has(parent.id)) return false; // an item is never its own ancestor (a corrupt loop must not drop it)
            guard.add(parent.id);
            parent = byId.get(parent.parentId);
        }
        return true;
    });
}

// JSZip, loaded the first time it is needed. A plain <script> tag does NOT work here: Monaco's AMD loader (in the
// page head) defines window.define with define.amd, so JSZip's UMD wrapper registers itself as an anonymous AMD
// module and never creates the global `JSZip` - the script loads without error and `new JSZip()` then throws. Hiding
// window.define while the file downloads would also hide it from Monaco's own modules loading at that moment, so the
// file is fetched as text (the service worker caches it, so it works offline after the first time) and run with
// `define`, `exports` and `module` shadowed: the wrapper then takes its plain-global branch and nothing global is touched.
const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
let jsZipLoading = null;
function loadJSZip() {
    if (typeof window.JSZip === 'function') return Promise.resolve(window.JSZip);
    if (jsZipLoading) return jsZipLoading; // two clicks while it loads share one download
    jsZipLoading = fetch(JSZIP_URL, { mode: 'cors', credentials: 'omit' })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(code => {
            // An inline <script> with the library wrapped in a function whose `define`, `exports` and `module` are
            // its own (undefined) parameters. It runs on insertion, before the next line.
            const el = document.createElement('script');
            el.textContent = '(function (define, exports, module) {\n' + code + '\n}).call(window);';
            document.head.appendChild(el);
            el.remove();
            if (typeof window.JSZip !== 'function') throw new Error('JSZip did not start');
            return window.JSZip;
        })
        .catch(e => { jsZipLoading = null; throw e; }); // a failed load can be retried
    return jsZipLoading;
}

// Hands a blob to the browser as a download. The link is in the page while it is clicked (Firefox needs that) and the
// blob URL lives on for a few seconds: revoking it straight after click() cancels the download in some browsers.
function triggerBlobDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
}

function notifyZipFailed(text) {
    if (window.showCustomModal) {
        window.showCustomModal({ title: 'ZIP download failed', text, submitText: 'OK' }, () => { if (typeof closeGenModal === 'function') closeGenModal(); });
    } else console.error(text);
}

async function handleDownloadZip() {
    if (downloadSelectedFiles.size === 0) return;

    // Captured before the JSZip load below, which only happens once per
    // session but can take a moment - if the user switches windows while it's
    // loading, `db` would otherwise point at the new window by the time the
    // folder-children lookup below runs, silently zipping up empty folders
    // instead of the ones actually selected.
    const targetDb = db;

    let JSZipLib;
    try { JSZipLib = await loadJSZip(); }
    catch (e) {
        notifyZipFailed('The ZIP library could not be loaded. It needs a connection the first time (after that it works offline). ' + (e && e.message ? '(' + e.message + ')' : ''));
        return;
    }

    const tx = targetDb.transaction('filesystem', 'readonly');
    const allFiles = await new Promise(res => {
        tx.objectStore('filesystem').getAll().onsuccess = e => res(e.target.result);
    });

    const zip = new JSZipLib();

    let lockedSkipped = 0;
    const buildZip = (fileObj, currentFolder) => {
        if (fileObj.isLocked && fileObj.type === 'file') {
            lockedSkipped++;
        } else if (fileObj.type === 'folder' || fileObj.type === 'workspace') {
            const newFolder = currentFolder.folder(fileObj.name);
            const children = allFiles.filter(f => f.parentId === fileObj.id);
            children.forEach(c => buildZip(c, newFolder));
        } else if (fileObj.encoding === 'base64') {
            currentFolder.file(fileObj.name, fileObj.content || '', { base64: true });
        } else {
            currentFolder.file(fileObj.name, fileObj.content || '');
        }
    };

    selectionRoots(downloadSelectedFiles, allFiles).forEach(f => buildZip(f, zip));

    try {
        const content = await zip.generateAsync({ type: 'blob' });
        triggerBlobDownload(content, `codemini_archive_${Date.now()}.zip`);
        toggleDownloadMode();
        notifyLockedSkipped(lockedSkipped);
    } catch (e) {
        notifyZipFailed('The ZIP could not be built: ' + (e && e.message ? e.message : e));
    }
}