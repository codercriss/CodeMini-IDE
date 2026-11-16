// ==========================================
// codemini-config.js: the workspace config folder (`.codemini/`), UI/UX specs feature 23
// ==========================================
// A workspace can carry its own setup in a real folder at its root: `.codemini/tasks.json`, `tests.json`, `settings.json` and so on. It is a
// normal folder in the workspace's own database, so it shows in Explorer, is versioned by Source Control and travels in a ZIP. This file is the one
// place that knows where it is and how to read and create things in it; Tasks, Test Explorer, Deploy and the others call it instead of each
// walking the file store themselves.
//
//   CodeMiniConfig.read('tasks.json')            -> { exists, record, text, locked }
//   CodeMiniConfig.readJson('tasks.json')        -> { exists, value, error: { message, line, column } | null }   (comments and trailing commas are allowed)
//   CodeMiniConfig.ensure('tasks.json', text)    -> { record, created }   creates the folder and the file only if they are missing; never overwrites
//   CodeMiniConfig.open('tasks.json', text?)     ensure + open in an editor tab
//   CodeMiniConfig.canRun()                      false in Restricted Mode: the files are shown, never run (cloning a repo must not run its commands)
//   CodeMiniConfig.registerSchema(name, schema)  Monaco autocomplete and validation for that file, attached when its tab opens
//
// Decisions that come from the spec:
//   * Created lazily: nothing is made with a workspace. The first thing that needs a file creates that file (and the folder), and only that file.
//   * Keys and tokens never go in here: the folder is meant to be committed. Files refer to secrets by name only.
//   * Workspace settings can never touch Workspace Trust, Isolation, My Keys or network permissions (those are profile-level), see filterWorkspaceSettings.
//   * Quick Open and Search skip the folder unless the query starts with ".codemini"; Explorer shows it dimmed, and a setting hides it.
//
// The pure half and the store logic (which works on any { getAll, putMany } adapter) are exported for Node (tests/codemini-config.test.js).
(function (root) {
    'use strict';
    const W = root;
    const DIR = '.codemini';

    // ---------------------------------------------------------------------------------------------
    // Pure
    // ---------------------------------------------------------------------------------------------

    // What each known file is for. `gated` means it can make the app run something or contact something, so it is only acted on in a trusted workspace.
    const FILES = {
        'settings.json': { kind: 'json', gated: false, title: 'Workspace settings' },
        'tasks.json': { kind: 'json', gated: true, title: 'Tasks' },
        'tests.json': { kind: 'json', gated: true, title: 'Tests' },
        'launch.json': { kind: 'json', gated: true, title: 'Run and debug' },
        'deploy.json': { kind: 'json', gated: true, title: 'Deploy' },
        'extensions.json': { kind: 'json', gated: true, title: 'Extensions' },
        'agent.md': { kind: 'md', gated: false, title: 'Agent notes' }
    };

    // The parent id that files at the top of the current workspace carry. Inside a workspace, its own database holds its contents with the workspace's
    // id as their parent; a window with no workspace open uses 'root'.
    function rootParentId(folderStack) {
        const first = folderStack && folderStack[0];
        return first && first.isWorkspaceRoot && first.id ? first.id : 'root';
    }

    const byIdOf = (records) => new Map((records || []).map((r) => [r.id, r]));

    // The `.codemini` folder at the top of this database: a folder with that name whose parent is not itself a record here. (Only that one is
    // configuration; a folder with the same name deeper down is just a folder.)
    function configFolderIds(records) {
        const byId = byIdOf(records), ids = new Set();
        (records || []).forEach((r) => { if (r.type === 'folder' && r.name === DIR && !byId.has(r.parentId)) ids.add(r.id); });
        return ids;
    }

    // Is this record the config folder or anything inside it?
    function isInConfig(rec, byId, folderIds) {
        let cur = rec, guard = 0;
        while (cur && guard++ < 64) {
            if (folderIds.has(cur.id)) return true;
            cur = byId.get(cur.parentId);
        }
        return false;
    }

    // Quick Open's paths start at the top of the database ("src/app.js", ".codemini/tasks.json").
    function isConfigPath(path) {
        const first = String(path || '').split('/')[0];
        return first === DIR;
    }

    // The query that asks for the folder on purpose.
    function wantsConfig(query) {
        return String(query || '').trim().toLowerCase().startsWith(DIR);
    }

    // For a list of records: those that Quick Open or Search should show for this query.
    function withoutConfig(records, query) {
        if (wantsConfig(query)) return records;
        const ids = configFolderIds(records);
        if (!ids.size) return records;
        const byId = byIdOf(records);
        return records.filter((r) => !isInConfig(r, byId, ids));
    }

    // A name inside the folder: 'tasks.json', 'local/state.json'. No empty parts, no '..', no backslashes, nothing absolute.
    function validName(name) {
        if (typeof name !== 'string' || !name || name.length > 200 || /[\\\0]/.test(name) || name.startsWith('/') || name.endsWith('/')) return false;
        return name.split('/').every((p) => p && p !== '.' && p !== '..');
    }

    // JSON with comments and trailing commas (what people bring from other editors). Comments and the commas are blanked out, keeping every
    // character position, so an error can be reported at the right line and column in the original text.
    function stripJsonc(text) {
        const s = String(text);
        let out = '', i = 0, inStr = false;
        while (i < s.length) {
            const c = s[i], n = s[i + 1];
            if (inStr) {
                out += c;
                if (c === '\\') { out += n === undefined ? '' : n; i += 2; continue; }
                if (c === '"') inStr = false;
                i++; continue;
            }
            if (c === '"') { inStr = true; out += c; i++; continue; }
            if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') { out += ' '; i++; } continue; }
            if (c === '/' && n === '*') {
                out += '  '; i += 2;
                while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { out += s[i] === '\n' ? '\n' : ' '; i++; }
                if (i < s.length) { out += '  '; i += 2; }
                continue;
            }
            out += c; i++;
        }
        // trailing commas: a comma followed only by whitespace and then } or ]
        let res = '', k = 0, str = false;
        while (k < out.length) {
            const c = out[k];
            if (str) { res += c; if (c === '\\') { res += out[k + 1] === undefined ? '' : out[k + 1]; k += 2; continue; } if (c === '"') str = false; k++; continue; }
            if (c === '"') { str = true; res += c; k++; continue; }
            if (c === ',') {
                let j = k + 1; while (j < out.length && /\s/.test(out[j])) j++;
                if (out[j] === '}' || out[j] === ']') { res += ' '; k++; continue; }
            }
            res += c; k++;
        }
        return res;
    }

    function lineColumn(text, pos) {
        const before = String(text).slice(0, Math.max(0, pos));
        const lines = before.split('\n');
        return { line: lines.length, column: lines[lines.length - 1].length + 1 };
    }

    // -> { ok: true, value } or { ok: false, message, line, column }
    function parseJsonc(text) {
        const src = String(text == null ? '' : text);
        if (!src.trim()) return { ok: false, message: 'The file is empty.', line: 1, column: 1 };
        const clean = stripJsonc(src);
        try { return { ok: true, value: JSON.parse(clean) }; }
        catch (e) {
            const msg = String((e && e.message) || e);
            let pos = (/position (\d+)/.exec(msg) || [])[1];
            let line, column;
            const lc = /line (\d+) column (\d+)/.exec(msg);
            if (lc) { line = Number(lc[1]); column = Number(lc[2]); }
            else if (pos !== undefined) { const r = lineColumn(src, Number(pos)); line = r.line; column = r.column; }
            else { line = 1; column = 1; }
            return { ok: false, message: msg.replace(/ in JSON at position \d+.*$/, '').replace(/ \(line \d+ column \d+\)/, ''), line, column };
        }
    }

    // Adds `.codemini/local/` to a .gitignore's text if it is not there. -> { text, changed }
    function gitignoreWithLocal(text) {
        const line = DIR + '/local/';
        const src = String(text == null ? '' : text);
        const have = src.split(/\r?\n/).some((l) => { const t = l.trim().replace(/^\//, ''); return t === line || t === DIR + '/local' || t === DIR + '/' || t === DIR; });
        if (have) return { text: src, changed: false };
        const sep = src && !src.endsWith('\n') ? '\n' : '';
        return { text: src + sep + (src.trim() ? '\n' : '') + '# CodeMini: private to this machine\n' + line + '\n', changed: true };
    }

    // Workspace settings are committed with the project, so a cloned repository must never be able to change anything that protects the person
    // or their data. Two layers:
    //   * the security settings (Workspace Trust, Isolation, profile sync) are never settable here, the same rule as the User settings.json (a test keeps
    //     the two in step);
    //   * and of the rest, only DISPLAY and EDITOR behaviour may be set by a workspace: an allow-list, not a deny-list, so a setting added later is
    //     personal until someone decides otherwise. Left out on purpose: the Trash Bin and clearing it (a project must not make deletes permanent),
    //     local history and its limits, hot exit, restore session, confirm-before-exit, update checks, memory, package auto-install, window and layout
    //     choices, and anything about notebook, console or terminal behaviour (as opposed to how they look).
    const WORKSPACE_ALLOWED = new Set([
        'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing', 'fontLigatures', 'tabSize', 'insertSpaces', 'wordWrap', 'minimap', 'lineNumbers',
        'renderWhitespace', 'bracketPairs', 'smoothScrolling', 'cursorStyle', 'cursorBlinking', 'mouseWheelZoom', 'editorFolding', 'renderLineHighlight',
        'matchBrackets', 'cursorWidth', 'formatOnSave', 'autoSave', 'autoSaveDelay',
        'explorerDefaultView', 'treeViewIndent', 'showBreadcrumbs', 'compactExplorer', 'hideCodeminiFolder',
        'colorTheme', 'iconTheme', 'accentColor', 'statusBarBackground', 'statusBarForeground',
        'nbCellFontSize', 'nbCellFontFamily', 'nbCellLineHeight', 'nbCellLetterSpacing', 'nbCellLineNumbers', 'nbCellWordWrap', 'nbCellFolding', 'nbCellMinimap',
        'nbCellRenderWhitespace', 'nbCellBracketPairs', 'nbCellCursorStyle', 'nbCellCursorBlinking', 'nbCellSmoothScrolling', 'nbPlotBackground',
        'consoleFontSize', 'consoleFontFamily', 'consoleLineHeight', 'consoleWordWrap',
        'termFontSize', 'termFontFamily', 'termTextColor', 'termPromptColor', 'termCmdColor'
    ]);
    const isSecurityKey = (key) => /^(isolation|workspaceTrust)/.test(key) || key === 'syncProfileSettings';
    const isWorkspaceSettable = (key) => WORKSPACE_ALLOWED.has(key) && !isSecurityKey(key);

    // `schema` (optional) is the Settings screen's own schema (type, allowed options, number range) so a value the Settings screen would refuse is refused here too.
    function filterWorkspaceSettings(obj, defaults, schema) {
        const accepted = {}, rejected = [];
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { accepted, rejected: [{ key: '', reason: 'Workspace settings are an object: { "setting": value }.' }] };
        const props = (schema && schema.properties) || {};
        Object.keys(obj).forEach((k) => {
            if (k === '$schema') return;
            const d = defaults ? defaults[k] : undefined;
            if (isSecurityKey(k)) { rejected.push({ key: k, reason: 'is a security setting: it can only be changed in Settings > Security, never by a workspace.' }); return; }
            if (d === undefined) { rejected.push({ key: k, reason: 'is not a CodeMini setting.' }); return; }
            if (!WORKSPACE_ALLOWED.has(k)) { rejected.push({ key: k, reason: 'is a personal setting: a workspace cannot change it. Set it in Settings.' }); return; }
            const v = obj[k];
            if (!['boolean', 'number', 'string'].includes(typeof d) || typeof v !== typeof d) { rejected.push({ key: k, reason: 'must be ' + (typeof d === 'boolean' ? 'true or false' : typeof d === 'number' ? 'a number' : 'text') + '.' }); return; }
            const p = props[k];
            if (p && Array.isArray(p.enum) && !p.enum.includes(v)) { rejected.push({ key: k, reason: 'must be one of ' + p.enum.map((x) => JSON.stringify(x)).join(', ') + '.' }); return; }
            if (typeof v === 'number' && (!Number.isFinite(v) || (p && ((p.minimum != null && v < p.minimum) || (p.maximum != null && v > p.maximum))))) {
                rejected.push({ key: k, reason: 'must be ' + (p && p.minimum != null && p.maximum != null ? 'between ' + p.minimum + ' and ' + p.maximum : p && p.minimum != null ? 'at least ' + p.minimum : p && p.maximum != null ? 'at most ' + p.maximum : 'a finite number') + '.' }); return;
            }
            accepted[k] = v;
        });
        return { accepted, rejected };
    }

    // ---- the workspace settings overlay: what .codemini/settings.json says, as a pure function of the file ----
    // -> { exists, error: { message, line, column } | null, accepted: {key: value}, rejected: [{key, reason}] }
    function computeOverlay(rec, defaults, schema) {
        if (!rec) return { exists: false, error: null, accepted: {}, rejected: [] };
        if (rec.isLocked) return { exists: true, error: { message: 'The file is locked.', line: 1, column: 1 }, accepted: {}, rejected: [] };
        const p = parseJsonc(rec.content);
        if (!p.ok) return { exists: true, error: { message: p.message, line: p.line, column: p.column }, accepted: {}, rejected: [] };
        const f = filterWorkspaceSettings(p.value, defaults, schema);
        return { exists: true, error: null, accepted: f.accepted, rejected: f.rejected };
    }
    // The settings file in a list of records: .codemini/settings.json directly inside the top-level config folder.
    function findSettingsRecord(records) {
        const ids = configFolderIds(records);
        return (records || []).find((r) => r.type === 'file' && r.name === 'settings.json' && ids.has(r.parentId)) || null;
    }
    // Changes when the database, or the file's text or lock, changes: nothing else.
    function overlaySignature(dbName, rec) {
        if (!rec) return String(dbName) + '|none';
        const text = String(rec.content || '');
        let h = 5381; for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
        return String(dbName) + '|' + rec.id + '|' + (rec.isLocked ? 'L' : 'u') + '|' + text.length + '|' + h;
    }
    // The settings as the PERSON has them: a copy of the effective settings with each overridden key put back to their own value.
    function userSettingsView(effective, userValues) {
        const out = Object.assign({}, effective || {});
        Object.keys(userValues || {}).forEach((k) => { out[k] = userValues[k]; });
        return out;
    }
    // Keys whose overridden value differs between two accepted sets (added, removed or changed).
    function overlayKeysChanged(prev, next) {
        const keys = new Set(Object.keys(prev || {}).concat(Object.keys(next || {})));
        return Array.from(keys).filter((k) => !(prev && k in prev && next && k in next && prev[k] === next[k]));
    }

    // ---------------------------------------------------------------------------------------------
    // Store logic: works on any { getAll(): Promise<record[]>, putMany(records): Promise<void> }
    // ---------------------------------------------------------------------------------------------
    let idSeq = 0;
    const newId = () => Date.now().toString() + Math.random().toString(36).substring(2) + (idSeq++).toString(36);
    const makeRecord = (parentId, name, type, content) => ({ id: newId(), parentId, name, type, isLocked: false, password: null, content: content || '', timestamp: Date.now() });

    // Walks name segments from the top, noting what is there and what is missing. -> { parent, missing: [segments], existing: record | null }
    function locate(records, parentId, segments) {
        let parent = parentId;
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const hit = records.find((r) => (r.parentId || 'root') === parent && r.name === seg);
            if (!hit) return { parent, missing: segments.slice(i), existing: null };
            if (i === segments.length - 1) return { parent, missing: [], existing: hit };
            if (hit.type !== 'folder') return { parent, missing: null, existing: null, blockedBy: hit };
            parent = hit.id;
        }
        return { parent, missing: [], existing: null };
    }

    async function readFile(store, parentId, name) {
        if (!validName(name)) throw new Error('Not a valid name inside ' + DIR + ': ' + name);
        const records = await store.getAll();
        const at = locate(records, parentId, [DIR].concat(name.split('/')));
        const rec = at.existing;
        if (!rec || rec.type !== 'file') return { exists: false, record: null, text: '', locked: false };
        const locked = !!rec.isLocked;
        return { exists: true, record: rec, text: locked ? '' : String(rec.content || ''), locked };
    }

    // Creates the folder(s) and the file if missing; never touches one that exists.
    async function ensureFile(store, parentId, name, text) {
        if (!validName(name)) throw new Error('Not a valid name inside ' + DIR + ': ' + name);
        const records = await store.getAll();
        const segs = [DIR].concat(name.split('/'));
        const at = locate(records, parentId, segs);
        if (at.missing === null) throw new Error(at.blockedBy.name + ' is a file, so ' + name + ' cannot be created inside it.');
        if (at.existing) {
            if (at.existing.type !== 'file') throw new Error(name + ' is a folder, so it cannot be used as a file.');
            return { record: at.existing, created: false, createdFolders: [] };
        }
        const fresh = [];
        let parent = at.parent;
        at.missing.forEach((seg, i) => {
            const last = i === at.missing.length - 1;
            const rec = makeRecord(parent, seg, last ? 'file' : 'folder', last ? String(text == null ? '' : text) : '');
            fresh.push(rec); parent = rec.id;
        });
        await store.putMany(fresh);
        const file = fresh[fresh.length - 1];
        return { record: file, created: true, createdFolders: fresh.slice(0, -1).map((r) => r.name) };
    }

    // Creates an empty folder inside the config folder (e.g. 'local') if missing.
    async function ensureFolder(store, parentId, name) {
        if (!validName(name)) throw new Error('Not a valid name inside ' + DIR + ': ' + name);
        const records = await store.getAll();
        const at = locate(records, parentId, [DIR].concat(name.split('/')));
        if (at.missing === null) throw new Error(at.blockedBy.name + ' is a file, so ' + name + ' cannot be a folder.');
        if (at.existing) {
            if (at.existing.type !== 'folder') throw new Error(name + ' is a file, so it cannot be a folder.');
            return { record: at.existing, created: false };
        }
        const fresh = []; let parent = at.parent;
        at.missing.forEach((seg) => { const rec = makeRecord(parent, seg, 'folder', ''); fresh.push(rec); parent = rec.id; });
        await store.putMany(fresh);
        return { record: fresh[fresh.length - 1], created: true };
    }

    // The .gitignore at the top of the workspace gets `.codemini/local/`. -> { changed, created, skipped: 'locked' | null }
    async function addLocalToGitignore(store, parentId) {
        const records = await store.getAll();
        const gi = records.find((r) => (r.parentId || 'root') === parentId && r.name === '.gitignore' && r.type === 'file');
        if (gi && gi.isLocked) return { changed: false, created: false, skipped: 'locked' };
        const r = gitignoreWithLocal(gi ? gi.content : '');
        if (!r.changed) return { changed: false, created: false, skipped: null };
        if (gi) await store.putMany([Object.assign({}, gi, { content: r.text, timestamp: Date.now() })]);
        else await store.putMany([makeRecord(parentId, '.gitignore', 'file', r.text)]);
        return { changed: true, created: !gi, skipped: null };
    }

    const api = {
        DIR, FILES, rootParentId, configFolderIds, isInConfig, isConfigPath, wantsConfig, withoutConfig, validName,
        stripJsonc, parseJsonc, gitignoreWithLocal, isSecurityKey, isWorkspaceSettable, WORKSPACE_ALLOWED, filterWorkspaceSettings,
        computeOverlay, findSettingsRecord, overlaySignature, userSettingsView, overlayKeysChanged,
        _store: { readFile, ensureFile, ensureFolder, addLocalToGitignore, locate }
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof document === 'undefined') return; // Node: the rules and the store logic only

    // ---------------------------------------------------------------------------------------------
    // Browser
    // ---------------------------------------------------------------------------------------------
    const toast = (m) => { if (typeof W.showSuccessToast === 'function') W.showSuccessToast(m); };
    const curDb = () => (typeof db !== 'undefined' && db ? db : null);
    const curStack = () => (typeof folderStack !== 'undefined' ? folderStack : null);
    const topParent = () => rootParentId(curStack());

    // The adapter over the open database. After a write it asks Explorer to redraw, but only if that database is still the open one.
    function browserStore() {
        const d = curDb();
        if (!d) return null;
        return {
            getAll: () => new Promise((resolve, reject) => {
                try { const rq = d.transaction('filesystem', 'readonly').objectStore('filesystem').getAll(); rq.onsuccess = () => resolve(rq.result || []); rq.onerror = () => reject(rq.error); }
                catch (e) { reject(e); }
            }),
            putMany: (records) => new Promise((resolve, reject) => {
                try {
                    const tx = d.transaction('filesystem', 'readwrite');
                    records.forEach((r) => tx.objectStore('filesystem').put(r));
                    tx.oncomplete = () => { if (curDb() === d && typeof loadFilesFromDB === 'function') loadFilesFromDB(); resolve(); };
                    tx.onerror = tx.onabort = () => reject(tx.error || new Error('The file store refused the write.'));
                } catch (e) { reject(e); }
            })
        };
    }
    const need = () => { const s = browserStore(); if (!s) throw new Error('The file store is not open yet.'); return s; };

    const read = (name) => readFile(need(), topParent(), name);
    async function readJson(name) {
        const r = await read(name);
        if (!r.exists) return { exists: false, value: null, error: null, locked: false };
        if (r.locked) return { exists: true, value: null, error: { message: 'The file is locked.', line: 1, column: 1 }, locked: true };
        const p = parseJsonc(r.text);
        return p.ok ? { exists: true, value: p.value, error: null, locked: false } : { exists: true, value: null, error: { message: p.message, line: p.line, column: p.column }, locked: false };
    }
    const ensure = (name, text) => ensureFile(need(), topParent(), name, text);

    // ---- templates and schemas that features register ----
    const templates = {}, schemas = {};
    function registerTemplate(name, text) { if (validName(name)) templates[name] = text; }
    // A schema is an object, or a function that returns one when it is needed (the settings schema is built from the Settings screen, which is not there yet at load).
    const resolveSchema = (name) => { const sc = schemas[name]; if (typeof sc !== 'function') return sc || null; try { return sc() || null; } catch (e) { return null; } };
    function registerSchema(name, schema) {
        if (!validName(name)) return;
        schemas[name] = schema;
        if (typeof schema !== 'function' && W.CodeMiniJsonSchemas) W.CodeMiniJsonSchemas.add(schemaUri(name), [], schema); // known by its address, so a "$schema" entry resolves without any network
    }
    const schemaUri = (name) => 'codemini://schema/' + name;

    async function open(name, text) {
        const r = await ensure(name, text !== undefined ? text : templates[name]);
        if (r.created) toast('Created ' + DIR + '/' + name);
        if (typeof W.openFileInTab === 'function') W.openFileInTab(r.record);
        return r.record;
    }

    // Restricted Mode: configuration is shown, never acted on.
    function isTrusted() { try { return !W.WorkspaceTrust || !W.WorkspaceTrust.isEnabled() || W.WorkspaceTrust.isTrusted(); } catch (e) { return false; } }
    function canRun(name) { const f = name && FILES[name]; return !(f && f.gated) || isTrusted(); }

    // ---- hide / dim in Explorer ----
    function hideSetting() { return !!(W.appSettings && W.appSettings.hideCodeminiFolder); }
    // Explorer calls this with the whole record list: it returns the ids to leave out.
    function explorerHiddenIds(records) {
        if (!hideSetting()) return new Set();
        const ids = configFolderIds(records);
        if (!ids.size) return new Set();
        const byId = byIdOf(records), out = new Set();
        records.forEach((r) => { if (isInConfig(r, byId, ids)) out.add(r.id); });
        return out;
    }
    // Only the one at the top of the workspace: a folder with the same name deeper down is just a folder.
    const isConfigFolder = (rec) => !!(rec && rec.type === 'folder' && rec.name === DIR && (rec.parentId || 'root') === topParent());

    // ---- Monaco: schema for a config file when its tab opens ----
    // File tabs have anonymous models, so the schema is attached by that model's address once the tab's editor exists.
    async function attachEditor(editor, tab) {
        try {
            const fileId = tab && tab.dataset && tab.dataset.fileId;
            if (!fileId || !editor || !editor.getModel || !W.CodeMiniJsonSchemas) return false;
            const records = await need().getAll();
            const rec = records.find((r) => r.id === fileId);
            if (!rec) return false;
            const ids = configFolderIds(records);
            if (!ids.size || !rec.parentId || !ids.has(rec.parentId)) return false; // only files directly inside .codemini/ have a schema
            const schema = resolveSchema(rec.name);
            if (!schema) return false;
            const model = editor.getModel();
            if (!model) return false;
            W.CodeMiniJsonSchemas.add(schemaUri(rec.name), [model.uri.toString()], schema);
            return true;
        } catch (e) { return false; } // a schema must never get in the way of editing
    }

    // ---- "Initialize" and the .gitignore offer ----
    async function offerGitignore() {
        const store = need(), parent = topParent();
        const have = (await store.getAll()).find((r) => (r.parentId || 'root') === parent && r.name === '.gitignore' && r.type === 'file');
        if (have && !gitignoreWithLocal(have.content).changed) return false;
        if (typeof W.showCustomModal !== 'function') return false;
        W.showCustomModal({ title: 'Keep local state out of Git?', text: 'Add ' + DIR + '/local/ to .gitignore? That folder holds things that belong to this machine only (last run results, caches).', submitText: 'Add to .gitignore' }, async () => {
            if (typeof closeGenModal === 'function') closeGenModal();
            try { const r = await addLocalToGitignore(store, parent); if (r.changed) toast(r.created ? 'Created .gitignore' : 'Updated .gitignore'); else if (r.skipped === 'locked') toast('.gitignore is locked, so it was not changed.'); }
            catch (e) { toast('Could not update .gitignore: ' + e.message); }
        });
        return true;
    }
    // Makes the folder, its local/ subfolder, and every file a feature has registered as a starter; then offers the .gitignore line.
    async function initialize() {
        const store = need(), parent = topParent(), made = [];
        for (const name of Object.keys(templates)) { const r = await ensureFile(store, parent, name, templates[name]); if (r.created) made.push(name); }
        const local = await ensureFolder(store, parent, 'local');
        if (local.created) made.push('local/');
        toast(made.length ? 'Created ' + DIR + ': ' + made.join(', ') : DIR + ' is already set up.');
        await offerGitignore();
        return made;
    }


    // ---------------------------------------------------------------------------------------------
    // Workspace settings overlay: .codemini/settings.json overrides the person's own value for the settings a workspace may set
    // ---------------------------------------------------------------------------------------------
    // Nothing is saved for an overridden setting: the person's own value stays in their storage, and this only changes what the app uses while that
    // workspace is open. Taking the key out of the file (or leaving the workspace) gives their value back.
    let overlay = { sig: '', dbName: '', exists: false, error: null, accepted: {}, rejected: [], userValues: {} };
    const dbNameNow = () => { const d = curDb(); return d ? d.name : ''; };

    function settingsSchema() {
        const SJ = W.CodeMiniSettingsJson;
        if (!SJ || typeof SJ.buildSchema !== 'function' || typeof W.getDefaultSettings !== 'function') return null;
        const full = SJ.buildSchema(W.getDefaultSettings(), typeof W.getSettingsDescriptors === 'function' ? W.getSettingsDescriptors() : []);
        const properties = { $schema: { type: 'string', description: 'Where the schema for this file comes from. Leave it as it is.' } };
        Object.keys(full.properties).forEach((k) => { if (isWorkspaceSettable(k)) properties[k] = full.properties[k]; });
        return { type: 'object', description: 'CodeMini settings for this workspace. They override your own for as long as the workspace is open. Only display and editor settings can be set here.', properties, additionalProperties: false };
    }

    function announce(next) {
        if (!W.CodeMiniNotifications || typeof W.CodeMiniNotifications.add !== 'function') return;
        let text = '';
        if (next.error) text = 'The file is not valid: ' + next.error.message + ' (line ' + next.error.line + '). None of it was applied.';
        else if (next.rejected.length) text = next.rejected.slice(0, 3).map((r) => (r.key ? '"' + r.key + '" ' : '') + r.reason).join(' ') + (next.rejected.length > 3 ? ' And ' + (next.rejected.length - 3) + ' more.' : '');
        if (!text) return;
        W.CodeMiniNotifications.add({ id: 'ws-settings-problems', source: 'Workspace settings', kind: 'warning', title: next.error ? 'Workspace settings were not applied' : 'Some workspace settings were not applied', text });
    }

    // Reapply what the app uses (the settings are rebuilt from the person's own, with the overlay on top), then run each changed setting's usual side effects.
    function applyChange(keys) {
        if (typeof W.reloadSettings === 'function') W.reloadSettings();
        if (typeof W.saveSetting === 'function' && W.appSettings) keys.forEach((k) => { try { W.saveSetting(k, W.appSettings[k], { transient: true }); } catch (e) { /* one setting must not stop the rest */ } });
    }

    // Called with the records of the open database whenever Explorer loads them (so on every entry to a workspace and every save).
    function noteFiles(records) {
        const rec = findSettingsRecord(records), sig = overlaySignature(dbNameNow(), rec);
        if (sig === overlay.sig) return;
        const prev = overlay.accepted;
        const next = computeOverlay(rec, typeof W.getDefaultSettings === 'function' ? W.getDefaultSettings() : null, settingsSchema());
        overlay = Object.assign({ sig, dbName: dbNameNow(), userValues: {} }, next);
        announce(next);
        const keys = overlayKeysChanged(prev, next.accepted);
        if (keys.length) applyChange(keys);
        else if (typeof W.syncUI === 'function') W.syncUI();
    }
    // The editor saved a file (possibly in a database that is not the open one): if it was a settings.json, look again.
    async function noteSaved(o) {
        try {
            if (!o || !o.file || o.file.name !== 'settings.json') return;
            const s = browserStore(); if (!s) return;
            noteFiles(await s.getAll());
        } catch (e) { /* never in the way of saving */ }
    }
    const isOverridden = (key) => overlay.dbName !== '' && overlay.dbName === dbNameNow() && Object.prototype.hasOwnProperty.call(overlay.accepted, key);
    // Called by reloadSettings after it has rebuilt the settings from the person's own storage.
    function applyOverlay(settings) {
        overlay.userValues = {};
        if (!settings || !overlay.dbName || overlay.dbName !== dbNameNow()) return;
        Object.keys(overlay.accepted).forEach((k) => { if (k in settings) { overlay.userValues[k] = settings[k]; settings[k] = overlay.accepted[k]; } });
    }
    const userView = (effective) => userSettingsView(effective, overlay.dbName === dbNameNow() ? overlay.userValues : {});

    // The Settings screen: an overridden control shows the workspace's value, is locked, and says so, with a way to the file.
    function decorateSettings(container) {
        if (!container) return;
        const entries = Array.from(container.querySelectorAll('[data-setting]')).map((i) => [i, i.dataset.setting]);
        // The status bar colors are custom controls without a data-setting.
        [['statusBarBackgroundInput', 'statusBarBackground'], ['statusBarForegroundInput', 'statusBarForeground']].forEach(([id, key]) => { const i = container.querySelector('#' + id); if (i) entries.push([i, key]); });
        entries.forEach(([input, key]) => {
            const row = input.closest('.settings-item'), on = isOverridden(key);
            const strong = row && row.querySelector('.settings-item-info strong');
            const badge = row && row.querySelector('.ws-badge');
            if (on) {
                if (input.dataset.wsLocked !== '1') { input.dataset.wsLocked = '1'; }
                input.disabled = true;
                if (row) row.classList.add('ws-locked');
                if (strong && !badge) {
                    const b = document.createElement('button');
                    b.type = 'button'; b.className = 'ws-badge'; b.textContent = 'Set by workspace';
                    b.title = 'This workspace sets it in ' + DIR + '/settings.json. Open the file; remove the line there to use your own value.';
                    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); open('settings.json'); });
                    strong.appendChild(b);
                }
            } else if (input.dataset.wsLocked === '1') {
                delete input.dataset.wsLocked;
                // Two controls are locked by the Theme Pack logic in syncUI, which has just run: leave those as it set them.
                if (input.id !== 'colorThemeSelect' && input.id !== 'accentColorInput') input.disabled = false;
                if (row) row.classList.remove('ws-locked');
                if (badge) badge.remove();
            }
        });
    }

    // ---- the Workspace settings entry in the workspace menu ----
    function addWorkspaceMenuEntry(dropdown) {
        if (!dropdown || dropdown.querySelector('.ws-config-entry')) return;
        const item = document.createElement('div');
        item.className = 'dropdown-item ws-config-entry';
        item.style.borderTop = '1px solid var(--border-color)';
        const icon = document.createElement('i'); icon.className = 'ri-settings-3-line';
        const label = document.createElement('span'); label.textContent = 'Workspace settings';
        item.append(icon, label);
        item.title = 'Open ' + DIR + '/settings.json (created if it is not there)';
        item.addEventListener('click', () => { dropdown.classList.remove('show'); open('settings.json').catch((e) => toast('Could not open it: ' + e.message)); });
        dropdown.appendChild(item);
    }

    // What "Initialize .codemini" and the first "Workspace settings" create. A small file that does something: it says which schema describes it.
    registerTemplate('settings.json', '{\n  "$schema": "' + schemaUri('settings.json') + '"\n}\n');
    registerSchema('settings.json', settingsSchema);

    Object.assign(api, {
        read, readJson, ensure, open, canRun, isTrusted, registerTemplate, registerSchema, schemaUri, attachEditor,
        explorerHiddenIds, isConfigFolder, initialize, offerGitignore,
        noteFiles, noteSaved, applyOverlay, isOverridden, userSettingsView: userView, decorateSettings, addWorkspaceMenuEntry, overlay: () => ({ exists: overlay.exists, error: overlay.error, accepted: Object.assign({}, overlay.accepted), rejected: overlay.rejected.slice(), dbName: overlay.dbName }),
        templates: () => Object.assign({}, templates), schemaFor: (name) => resolveSchema(name)
    });
    W.CodeMiniConfig = api;
})(typeof window !== 'undefined' ? window : globalThis);
