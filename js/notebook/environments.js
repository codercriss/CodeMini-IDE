// ==========================================
// environments.js (Universal Plot & Table Viewer)
// ==========================================
// One slide-in panel (#plotPreviewContainer) shows two kinds of output:
//   - Plots (images from the notebook kernels): Fit / 100% / zoom (buttons, wheel, pinch), drag to pan, double-click to
//     toggle, white / dark / checkerboard background, copy image, download, thumbnails, keyboard shortcuts.
//   - Tables (SQL results, or any columns + rows through window.openTableData): click a header to sort, filter rows
//     (plain text, or column:text), column statistics, row numbers, density, text size, copy as TSV / Markdown / JSON,
//     save as CSV / JSON.
// Everything is built with DOM calls (never HTML strings made from data), so a cell value or a file name can not become markup.

// --- Strict Isolation Registry ---
window._envStateRegistry = window._envStateRegistry || {};

function _getEnvWinId() { 
    return localStorage.getItem('codemini_active_window') || 'win_default'; 
}

function getEnvState() {
    const wid = _getEnvWinId();
    if (!window._envStateRegistry[wid]) {
        window._envStateRegistry[wid] = { 
            plotNavList: [], 
            plotNavIndex: 0, 
            currentPlotZoom: 1 
        };
    }
    return window._envStateRegistry[wid];
}

// What the panel is showing right now. The panel is one shared element, so this is not per window; the per-window
// registry above keeps each window's list of plots.
const PV = { mode: null, T: null, P: null, toastTimer: 0, ro: null };

// NOTE: notebook-kernels.js defines a window.forceCloseEnvironments FIRST
// (interrupts/tears down the Python/R/SQL/Ruby kernels for winId). It loads
// before this file, so without capturing+chaining it here, this assignment
// would silently clobber it - kernels would never actually be torn down on
// window switch/close, only this plot-preview state would reset. Follow the
// same "capture original, call it, then extend" pattern already used for
// window.saveCurrentUIState/restoreCurrentUIState (see now-island.js, search.js).
const _envPrevForceCloseEnvironments = window.forceCloseEnvironments;
window.forceCloseEnvironments = function(winId, isClosing = false) {
    if (typeof _envPrevForceCloseEnvironments === 'function') {
        _envPrevForceCloseEnvironments(winId, isClosing);
    }

    const state = window._envStateRegistry[winId];
    if (state) {
        state.plotNavList = [];
        state.plotNavIndex = 0;
        state.currentPlotZoom = 1;
    }
    
    const currentWin = localStorage.getItem('codemini_active_window') || 'win_default';
    if (currentWin === winId || !currentWin) {
        const container = document.getElementById('plotPreviewContainer');
        if (container) {
            container.classList.remove('show');
            setTimeout(() => {
                if (container.style.display !== 'none' && !container.classList.contains('show')) {
                    container.style.display = 'none';
                    _pvReset();
                }
            }, 300);
        }
    }
};

// ---------- small helpers ----------
const _PV_PREFS_KEY = 'codemini_pv_prefs';
function _pvLoadPrefs() {
    try { const p = JSON.parse(localStorage.getItem(_PV_PREFS_KEY) || '{}'); return (p && typeof p === 'object') ? p : {}; } catch (e) { return {}; }
}
function _pvSavePrefs(patch) {
    try { localStorage.setItem(_PV_PREFS_KEY, JSON.stringify(Object.assign(_pvLoadPrefs(), patch))); } catch (e) { /* storage unavailable: the choice just is not remembered */ }
}
function _pvEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
}
function _pvBtn(label, icon, title, onClick) {
    const b = _pvEl('button', 'pv-btn');
    b.type = 'button';
    if (icon) b.appendChild(_pvEl('i', icon));
    if (label) b.appendChild(_pvEl('span', null, label));
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
}
function _pvSep() { return _pvEl('span', 'pv-sep'); }
function _pvLabel(text) { return _pvEl('span', 'pv-grouplabel', text); }
function _pvById(id) { return document.getElementById(id); }
function _pvNum(n, digits) {
    if (!isFinite(n)) return String(n);
    return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: digits === undefined ? 4 : digits });
}
function _pvToast(msg) {
    const c = _pvById('plotPreviewContainer'); if (!c) return;
    let t = _pvById('pvToast');
    if (!t) { t = _pvEl('div', 'pv-toast'); t.id = 'pvToast'; t.setAttribute('role', 'status'); c.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(PV.toastTimer);
    PV.toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}
function _pvSaveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.visibility = 'hidden';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}
async function _pvCopyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through to the old way */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return !!ok;
    } catch (e) { return false; }
}
function _pvStamp() { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }

// ---------- the panel ----------
function initPreviewContainer() {
    let container = document.getElementById('plotPreviewContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'plotPreviewContainer';
        container.className = 'plot-preview-container';
        container.tabIndex = -1;   // so the panel can take keyboard focus (its shortcuts only work while it has it)
        container.innerHTML = `
            <div class="plot-header">
                <div class="plot-header-left">
                    <i class="ri-bar-chart-2-line" id="previewIcon" style="color:var(--accent-blue); font-size: 16px;"></i> <span id="previewTitle">Preview</span>
                </div>
                <div class="plot-header-right">
                    <i class="ri-zoom-in-line" id="plotZoomIn" title="Zoom In"></i>
                    <i class="ri-zoom-out-line" id="plotZoomOut" title="Zoom Out"></i>
                    <i class="ri-download-2-line" id="plotDownload" title="Download"></i>
                    <div class="hide-on-mobile" style="width: 1px; height: 16px; background: var(--border-color); margin: 0 8px;"></div>
                    <i class="ri-fullscreen-fill hide-on-mobile" id="plotMaximizeToggle" title="Toggle Full Width"></i>
                    <i class="ri-close-line" id="plotCloseBtn" title="Close"></i>
                </div>
            </div>
            <div class="pv-toolbar" id="pvToolbar" hidden></div>
            <div class="pv-toolbar pv-thumbs" id="pvThumbs" hidden></div>
            <div class="plot-content" id="previewContentArea" style="flex:1; overflow:auto; display:flex; justify-content:center; align-items:center; background: var(--bg-white); padding: 20px; min-height:0;">
                </div>
            <div class="plot-statusbar" id="previewStatusBar">
                <div class="plot-status-left" id="previewStatusLeft">
                    <span id="previewNavControls" style="display:flex; gap:12px; align-items:center;">
                        <i class="ri-arrow-left-line disabled" id="plotNavBack" title="Previous Item"></i>
                        <i class="ri-arrow-right-line disabled" id="plotNavFwd" title="Next Item"></i>
                    </span>
                    <span id="previewInfo"></span>
                </div>
                <div class="plot-status-right">
                    <span id="plotFileName"></span> - <span id="plotCellNum"></span>
                </div>
            </div>
        `;
        document.body.appendChild(container);

        const style = document.createElement('style');
        style.innerHTML = `
            .plot-preview-container { position: fixed; top: 0; right: 0; width: 55%; height: 100vh; background-color: var(--bg-white); z-index: 10005; display: flex; flex-direction: column; border-left: 1px solid var(--border-color); box-shadow: -5px 0 25px rgba(0, 0, 0, 0.1); transform: translateX(105%); transition: transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1), width 0.3s ease; outline: none; }
            .plot-preview-container.show { transform: translateX(0); }
            .plot-preview-container.maximized { width: 100%; border-left: none; }
            @media (max-width: 768px) { .plot-preview-container { width: 100%; border-left: none; } .plot-preview-container .hide-on-mobile { display: none !important; } .pv-search input { font-size: 16px !important; } }
            .plot-header { display: flex; justify-content: space-between; align-items: center; height: 36px; padding: 0 15px; background-color: var(--bg-panel); border-bottom: 1px solid var(--border-color); color: var(--text-main); font-size: 13px; flex-shrink: 0; }
            .plot-header-left { display: flex; align-items: center; gap: 6px; font-weight: 600; }
            .plot-header-right { display: flex; align-items: center; gap: 12px; font-size: 16px; color: var(--icon-gray); }
            .plot-header-right i { cursor: pointer; transition: color 0.2s; }
            .plot-header-right i:hover { color: var(--text-main); }
            .plot-statusbar { display: flex; justify-content: space-between; align-items: center; height: 26px; padding: 0 15px; background-color: var(--bg-tabs-bar); border-top: 1px solid var(--border-color); color: var(--text-muted); font-size: 12px; flex-shrink: 0; }
            .plot-status-left{
               gap: 12px;
               display: flex; align-items: center; min-width: 0;
}
            .plot-status-left i { font-size: 15px; cursor: pointer; transition: color 0.2s; }
            .plot-status-left i:hover:not(.disabled) { color: var(--text-main); }
            .plot-status-left i.disabled { opacity: 0.3; cursor: not-allowed; }
            .plot-status-left #previewInfo { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            
            .preview-table-wrapper table { border-collapse: collapse; width: 100%; text-align: left; font-size: 13px; white-space: nowrap; }
            .preview-table-wrapper thead { position: sticky; top: 0; background: var(--bg-tabs-bar); z-index: 1; box-shadow: 0 1px 2px rgba(0,0,0,0.1); }
            .preview-table-wrapper th, .preview-table-wrapper td { padding: 10px 15px; border-right: 1px solid var(--border-color); border-bottom: 1px solid var(--border-color); }
            .preview-table-wrapper th { font-weight: 600; color: var(--text-main); }
            .preview-table-wrapper td { color: var(--text-main); }

            /* toolbar (one row under the header; scrolls sideways on a phone) */
            .pv-toolbar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border-color); background: var(--bg-panel); overflow-x: auto; white-space: nowrap; flex-shrink: 0; -webkit-overflow-scrolling: touch; }
            .pv-toolbar[hidden] { display: none !important; }
            .pv-btn { display: inline-flex; align-items: center; gap: 4px; background: transparent; border: 1px solid var(--border-color); border-radius: 4px; padding: 3px 8px; font-size: 12px; line-height: 1.4; color: var(--text-muted); cursor: pointer; flex-shrink: 0; font-family: inherit; }
            .pv-btn:hover { color: var(--text-main); background: var(--bg-tabs-bar); }
            .pv-btn.on { color: var(--accent-blue); border-color: var(--accent-blue); }
            .pv-btn:disabled { opacity: 0.4; cursor: not-allowed; }
            .pv-sep { width: 1px; height: 16px; background: var(--border-color); margin: 0 4px; flex-shrink: 0; }
            .pv-grouplabel { font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
            .pv-search { display: flex; align-items: center; gap: 6px; border: 1px solid var(--border-color); border-radius: 4px; padding: 2px 8px; background: var(--bg-white); flex: 1 0 150px; max-width: 280px; color: var(--text-muted); }
            .pv-search input { border: 0; outline: 0; background: transparent; color: var(--text-main); font-size: 12px; width: 100%; min-width: 80px; font-family: inherit; }
            .pv-zoomlabel { min-width: 44px; text-align: center; font-size: 12px; color: var(--text-muted); flex-shrink: 0; font-variant-numeric: tabular-nums; }
            .pv-thumbs { gap: 8px; padding: 6px 10px; }
            .pv-thumb { height: 44px; width: auto; max-width: 80px; object-fit: contain; border: 2px solid transparent; border-radius: 4px; background: #fff; cursor: pointer; flex-shrink: 0; opacity: 0.75; }
            .pv-thumb.active { border-color: var(--accent-blue); opacity: 1; }

            /* plot viewport */
            .pv-plot-area { position: relative !important; overflow: hidden !important; display: block !important; padding: 0 !important; touch-action: none; cursor: grab; user-select: none; -webkit-user-select: none; }
            .pv-plot-area.pv-grabbing { cursor: grabbing; }
            .pv-plot-area img { position: absolute; left: 0; top: 0; max-width: none; transform-origin: 0 0; will-change: transform; -webkit-user-drag: none; }
            .pv-bg-white { background: #fff !important; }
            .pv-bg-dark { background: #1e1e1e !important; }
            .pv-bg-checker { background-color: #fff !important; background-image: linear-gradient(45deg, #d6d6d6 25%, transparent 25%, transparent 75%, #d6d6d6 75%), linear-gradient(45deg, #d6d6d6 25%, transparent 25%, transparent 75%, #d6d6d6 75%) !important; background-size: 16px 16px !important; background-position: 0 0, 8px 8px !important; }

            /* table viewport */
            .pv-table-area { padding: 0 !important; align-items: stretch !important; justify-content: stretch !important; overflow: hidden !important; }
            .pv-table-wrap { width: 100%; height: 100%; overflow: auto; background: var(--bg-white); -webkit-overflow-scrolling: touch; }
            .pv-table { border-collapse: separate; border-spacing: 0; width: max-content; min-width: 100%; font-variant-numeric: tabular-nums; }
            .pv-table th, .pv-table td { padding: 8px 12px; border-right: 1px solid var(--border-color); border-bottom: 1px solid var(--border-color); white-space: nowrap; max-width: 420px; overflow: hidden; text-overflow: ellipsis; text-align: left; color: var(--text-main); }
            .pv-compact th, .pv-compact td { padding: 3px 8px; }
            .pv-table thead th { position: sticky; top: 0; z-index: 2; background: var(--bg-tabs-bar); font-weight: 600; cursor: pointer; user-select: none; -webkit-user-select: none; }
            .pv-table thead th:hover { color: var(--accent-blue); }
            .pv-table th.pv-num, .pv-table td.pv-num { text-align: right; }
            .pv-table td.pv-null { color: var(--text-muted); font-style: italic; }
            .pv-table th.pv-rn, .pv-table td.pv-rn { position: sticky; left: 0; z-index: 1; background: var(--bg-tabs-bar); color: var(--text-muted); text-align: right; cursor: default; font-weight: 400; }
            .pv-table thead th.pv-rn { z-index: 3; }
            .pv-table tbody tr:hover td:not(.pv-rn) { background: rgba(127, 127, 127, 0.08); }
            .pv-table tbody tr.pv-sel td:not(.pv-rn) { background: rgba(56, 139, 253, 0.16); }
            .pv-sort { margin-left: 6px; font-size: 10px; color: var(--accent-blue); }
            .pv-table tfoot td { position: sticky; bottom: 0; z-index: 2; background: var(--bg-tabs-bar); font-size: 11px; color: var(--text-muted); white-space: normal; vertical-align: top; border-top: 1px solid var(--border-color); }
            .pv-table tfoot td div { white-space: nowrap; }
            .pv-more td, .pv-empty td { text-align: center !important; padding: 12px; max-width: none; color: var(--text-muted); }
            .pv-toast { position: absolute; left: 50%; bottom: 40px; transform: translate(-50%, 8px); background: rgba(30, 30, 30, 0.92); color: #fff; padding: 6px 12px; border-radius: 6px; font-size: 12px; opacity: 0; pointer-events: none; transition: opacity 0.2s, transform 0.2s; z-index: 5; max-width: 90%; text-align: center; }
            .pv-toast.show { opacity: 1; transform: translate(-50%, 0); }
        `;
        document.head.appendChild(style);

        document.getElementById('plotCloseBtn').addEventListener('click', _pvClose);
        
        document.getElementById('plotMaximizeToggle').addEventListener('click', () => {
            container.classList.toggle('maximized');
            const icon = document.getElementById('plotMaximizeToggle');
            if (container.classList.contains('maximized')) {
                icon.classList.replace('ri-fullscreen-fill', 'ri-fullscreen-exit-fill');
            } else {
                icon.classList.replace('ri-fullscreen-exit-fill', 'ri-fullscreen-fill');
            }
        });
        
        // The header's zoom and download icons mean different things for a plot and a table.
        document.getElementById('plotZoomIn').addEventListener('click', () => _pvZoomStep(1));
        document.getElementById('plotZoomOut').addEventListener('click', () => _pvZoomStep(-1));
        document.getElementById('plotDownload').addEventListener('click', () => { if (PV.mode === 'table') _pvTableSave('csv'); else if (PV.mode === 'plot') _pvPlotDownload(); });
        
        document.getElementById('plotNavBack').addEventListener('click', () => _pvPlotGo(-1));
        document.getElementById('plotNavFwd').addEventListener('click', () => _pvPlotGo(1));

        // Shortcuts only work while the panel has focus, so typing in the editor behind it never triggers them.
        container.addEventListener('keydown', _pvKeydown);
        container.addEventListener('pointerdown', (e) => { if (!/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) container.focus({ preventScroll: true }); });
    }
    return container;
}

function _pvClose() {
    const container = document.getElementById('plotPreviewContainer');
    if (!container) return;
    container.classList.remove('show');
    setTimeout(() => { if (!container.classList.contains('show')) { container.style.display = 'none'; _pvReset(); } }, 300);
}

// Drops what the current mode built (the observer, the table's data) so a closed panel holds nothing.
function _pvReset() {
    if (PV.ro) { try { PV.ro.disconnect(); } catch (e) { /* already gone */ } PV.ro = null; }
    PV.mode = null; PV.T = null; PV.P = null;
    const area = _pvById('previewContentArea'); if (area) area.textContent = '';
}

// Switches the shared panel to 'plot' or 'table': title, which header icons make sense, a fresh content area.
function _pvSetMode(mode) {
    _pvReset();
    PV.mode = mode;
    const isTable = mode === 'table';
    _pvById('previewTitle').textContent = isTable ? 'Table Preview' : 'Plot Preview';
    _pvById('previewIcon').className = isTable ? 'ri-table-2' : 'ri-bar-chart-2-line';
    _pvById('plotZoomIn').style.display = 'block';
    _pvById('plotZoomOut').style.display = 'block';
    _pvById('plotZoomIn').title = isTable ? 'Larger text (+)' : 'Zoom In (+)';
    _pvById('plotZoomOut').title = isTable ? 'Smaller text (-)' : 'Zoom Out (-)';
    _pvById('plotDownload').style.display = 'block';
    _pvById('plotDownload').title = isTable ? 'Save as CSV' : 'Download PNG';
    _pvById('previewNavControls').style.display = isTable ? 'none' : 'flex';
    _pvById('previewInfo').textContent = '';
    const tb = _pvById('pvToolbar'); tb.textContent = ''; tb.hidden = false;
    const th = _pvById('pvThumbs'); th.textContent = ''; th.hidden = true;
    const area = _pvById('previewContentArea');
    area.className = 'plot-content ' + (isTable ? 'pv-table-area' : 'pv-plot-area');
    area.style.background = ''; area.style.padding = ''; area.style.overflow = ''; area.style.display = '';
    return area;
}

function _pvShow(container) {
    container.style.display = 'flex';
    setTimeout(() => { container.classList.add('show'); container.focus({ preventScroll: true }); }, 10);
}

function _pvZoomStep(dir) {
    if (PV.mode === 'table' && PV.T) {
        PV.T.font = Math.max(9, Math.min(22, PV.T.font + dir));
        _pvSavePrefs({ font: PV.T.font });
        _pvTableRender();
    } else if (PV.mode === 'plot') {
        window.updatePlotZoom(dir > 0 ? 0.25 : -0.25);
    }
}

function _pvKeydown(e) {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '');
    if (e.key === 'Escape') {
        e.stopPropagation();
        if (inField && e.target.value) { e.target.value = ''; e.target.dispatchEvent(new Event('input', { bubbles: true })); }
        else _pvClose();
        return;
    }
    if (inField || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === '+' || k === '=') { e.preventDefault(); _pvZoomStep(1); return; }
    if (k === '-' || k === '_') { e.preventDefault(); _pvZoomStep(-1); return; }
    if (PV.mode === 'plot') {
        if (k === 'ArrowLeft') { e.preventDefault(); _pvPlotGo(-1); }
        else if (k === 'ArrowRight') { e.preventDefault(); _pvPlotGo(1); }
        else if (k === '0') { e.preventDefault(); _pvPlotFit(); }
        else if (k === '1') { e.preventDefault(); _pvPlotActual(); }
        else if (k === 'b' || k === 'B') { e.preventDefault(); _pvPlotCycleBg(); }
        else if (k === 'c' || k === 'C') { e.preventDefault(); _pvPlotCopy(); }
    } else if (PV.mode === 'table') {
        if (k === '/') { e.preventDefault(); const s = _pvById('pvSearch'); if (s) s.focus(); }
    }
}

// ==========================================
// Tables
// ==========================================
const _PV_NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
function _pvIsNum(v) { return typeof v === 'number' ? isFinite(v) : (typeof v === 'string' && _PV_NUM_RE.test(v.trim())); }
function _pvCell(v) { return v === null || v === undefined ? null : v; }

// spec: { columns: [names], rows: [[values]], label?: 'SQL Table', cell?: 'Cell 3', title?: 'Table Preview' }
window.openTableData = function(spec) {
    if (!spec || !Array.isArray(spec.columns) || !Array.isArray(spec.rows)) return;
    const container = initPreviewContainer();
    const area = _pvSetMode('table');
    const prefs = _pvLoadPrefs();
    const cols = spec.columns.map((c) => String(c));
    const rows = spec.rows.map((r) => cols.map((_, c) => _pvCell(Array.isArray(r) ? r[c] : undefined)));
    const T = {
        cols, rows,
        numeric: cols.map((_, c) => { let seen = false; for (const r of rows) { const v = r[c]; if (v === null) continue; if (!_pvIsNum(v)) return false; seen = true; } return seen; }),
        order: [], sortCol: -1, sortDir: 0, filter: '',
        rowNum: prefs.rowNum !== false, compact: !!prefs.compact, font: Math.max(9, Math.min(22, parseInt(prefs.font, 10) || 13)),
        stats: false, limit: 500, sel: -1, dom: {}
    };
    PV.T = T;

    // toolbar
    const tb = _pvById('pvToolbar');
    const search = _pvEl('label', 'pv-search'); search.appendChild(_pvEl('i', 'ri-search-line'));
    const input = document.createElement('input');
    input.type = 'search'; input.id = 'pvSearch'; input.placeholder = 'Filter rows (or column:text)'; input.autocomplete = 'off'; input.spellcheck = false;
    input.setAttribute('aria-label', 'Filter rows');
    input.addEventListener('input', () => { T.filter = input.value; T.limit = 500; _pvTableRefresh(); });
    search.appendChild(input);
    tb.appendChild(search);
    const mkToggle = (key, icon, title, label) => {
        const b = _pvBtn(label, icon, title, () => { T[key] = !T[key]; if (key === 'rowNum' || key === 'compact') _pvSavePrefs({ [key]: T[key] }); _pvTableRender(); });
        b.dataset.pv = key; b.setAttribute('aria-pressed', 'false'); return b;
    };
    tb.appendChild(mkToggle('rowNum', null, 'Show row numbers', '# Rows'));
    tb.appendChild(mkToggle('stats', null, 'Column statistics for the rows shown', '\u03A3 Stats'));
    tb.appendChild(mkToggle('compact', null, 'Compact rows', 'Compact'));
    tb.appendChild(_pvSep());
    tb.appendChild(_pvLabel('Copy'));
    tb.appendChild(_pvBtn('TSV', null, 'Copy the rows shown as tab-separated text (pastes into a spreadsheet)', () => _pvTableCopy('tsv')));
    tb.appendChild(_pvBtn('Markdown', null, 'Copy the rows shown as a Markdown table', () => _pvTableCopy('md')));
    tb.appendChild(_pvBtn('JSON', null, 'Copy the rows shown as a JSON array of objects', () => _pvTableCopy('json')));
    tb.appendChild(_pvSep());
    tb.appendChild(_pvLabel('Save'));
    tb.appendChild(_pvBtn('CSV', 'ri-download-line', 'Save the rows shown as a CSV file', () => _pvTableSave('csv')));
    tb.appendChild(_pvBtn('JSON', 'ri-download-line', 'Save the rows shown as a JSON file', () => _pvTableSave('json')));

    // table
    const wrap = _pvEl('div', 'pv-table-wrap');
    const table = _pvEl('table', 'pv-table');
    table.setAttribute('role', 'grid');
    T.dom = { wrap, table, thead: _pvEl('thead'), tbody: _pvEl('tbody'), tfoot: _pvEl('tfoot'), input };
    table.appendChild(T.dom.thead); table.appendChild(T.dom.tbody); table.appendChild(T.dom.tfoot);
    wrap.appendChild(table); area.appendChild(wrap);

    // header click = sort (none -> ascending -> descending -> none)
    T.dom.thead.addEventListener('click', (e) => {
        const th = e.target.closest('th[data-c]'); if (!th) return;
        const c = parseInt(th.dataset.c, 10);
        if (T.sortCol !== c) { T.sortCol = c; T.sortDir = 1; }
        else if (T.sortDir === 1) T.sortDir = -1;
        else { T.sortCol = -1; T.sortDir = 0; }
        _pvTableRefresh();
    });
    // row click = highlight; double-click a cell = copy its value
    T.dom.tbody.addEventListener('click', (e) => {
        const more = e.target.closest('[data-more]');
        if (more) { T.limit += 1000; _pvTableRender(); return; }
        const tr = e.target.closest('tr[data-ri]'); if (!tr) return;
        const prev = T.dom.tbody.querySelector('tr.pv-sel'); if (prev) prev.classList.remove('pv-sel');
        T.sel = parseInt(tr.dataset.ri, 10); tr.classList.add('pv-sel');
    });
    T.dom.tbody.addEventListener('dblclick', async (e) => {
        const td = e.target.closest('td[data-c]'); const tr = e.target.closest('tr[data-ri]'); if (!td || !tr) return;
        const v = T.rows[parseInt(tr.dataset.ri, 10)][parseInt(td.dataset.c, 10)];
        const ok = await _pvCopyText(v === null ? '' : String(v));
        _pvToast(ok ? 'Cell copied' : 'Copy is not available here');
    });

    _pvById('plotFileName').textContent = spec.label || 'Table';
    _pvById('plotCellNum').textContent = spec.cell || '';
    _pvTableRefresh();
    _pvShow(container);
};

// SQL result tables (made by the notebook) are read from the page and handed to openTableData.
window.openTablePreview = function(tableId, cellInfo = 'Query Result') {
    const tableEl = document.getElementById(tableId);
    if (!tableEl) return;
    const columns = Array.from(tableEl.querySelectorAll('thead th')).map((th) => th.textContent);
    const rows = Array.from(tableEl.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.children).map((td) => (td.querySelector('em') ? null : td.textContent)));
    window.openTableData({ columns, rows, label: 'SQL Table', cell: cellInfo });
};

function _pvRowFilter(T, query) {
    const q = query.trim().toLowerCase(); if (!q) return null;
    const txt = (v) => (v === null ? 'null' : String(v)).toLowerCase();
    const m = q.match(/^([^:]+):(.*)$/);
    if (m) {
        const name = m[1].trim(), ci = T.cols.findIndex((c) => c.toLowerCase() === name);
        if (ci >= 0) { const needle = m[2].trim(); return (r) => txt(r[ci]).includes(needle); }
    }
    return (r) => r.some((v) => txt(v).includes(q));
}

function _pvTableRefresh() {
    const T = PV.T; if (!T) return;
    const f = _pvRowFilter(T, T.filter);
    let order = [];
    for (let i = 0; i < T.rows.length; i++) if (!f || f(T.rows[i])) order.push(i);
    if (T.sortCol >= 0 && T.sortDir !== 0) {
        const c = T.sortCol, dir = T.sortDir, numeric = T.numeric[c], rows = T.rows;
        order.sort((i, j) => {
            const a = rows[i][c], b = rows[j][c];
            if (a === null || b === null) return a === b ? i - j : (a === null ? 1 : -1);   // empty values stay last in either direction
            const d = numeric ? parseFloat(a) - parseFloat(b) : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
            return d * dir || i - j;
        });
    }
    T.order = order;
    _pvTableRender();
}

function _pvColStats(T, c) {
    let n = 0, nulls = 0, sum = 0, min = Infinity, max = -Infinity;
    const distinct = new Set();
    for (const ri of T.order) {
        const v = T.rows[ri][c];
        if (v === null) { nulls++; continue; }
        n++;
        if (T.numeric[c]) { const x = parseFloat(v); sum += x; if (x < min) min = x; if (x > max) max = x; }
        else distinct.add(String(v));
    }
    return { n, nulls, sum, min, max, distinct: distinct.size };
}

function _pvTableRender() {
    const T = PV.T; if (!T) return;
    const { table, thead, tbody, tfoot } = T.dom;
    table.style.fontSize = T.font + 'px';
    table.classList.toggle('pv-compact', T.compact);
    _pvById('pvToolbar').querySelectorAll('button[data-pv]').forEach((b) => { const on = !!T[b.dataset.pv]; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });

    // head
    const htr = document.createElement('tr');
    if (T.rowNum) htr.appendChild(_pvEl('th', 'pv-rn', '#'));
    T.cols.forEach((name, c) => {
        const th = _pvEl('th', T.numeric[c] ? 'pv-num' : '');
        th.dataset.c = String(c); th.title = 'Sort by ' + name;
        th.setAttribute('aria-sort', T.sortCol === c ? (T.sortDir > 0 ? 'ascending' : 'descending') : 'none');
        th.appendChild(_pvEl('span', null, name));
        if (T.sortCol === c) th.appendChild(_pvEl('span', 'pv-sort', T.sortDir > 0 ? '\u25B2' : '\u25BC'));
        htr.appendChild(th);
    });
    thead.textContent = ''; thead.appendChild(htr);

    // body (the first `limit` rows; "Show more" adds more)
    const frag = document.createDocumentFragment();
    const shown = Math.min(T.order.length, T.limit), span = T.cols.length + (T.rowNum ? 1 : 0);
    for (let k = 0; k < shown; k++) {
        const ri = T.order[k], r = T.rows[ri], tr = document.createElement('tr');
        tr.dataset.ri = String(ri);
        if (ri === T.sel) tr.className = 'pv-sel';
        if (T.rowNum) tr.appendChild(_pvEl('td', 'pv-rn', String(k + 1)));
        for (let c = 0; c < T.cols.length; c++) {
            const v = r[c], td = document.createElement('td');
            td.dataset.c = String(c);
            if (v === null) { td.className = 'pv-null'; td.textContent = 'NULL'; }
            else {
                const s = String(v);
                td.textContent = s;
                if (T.numeric[c]) td.className = 'pv-num';
                if (s.length > 40) td.title = s.length > 600 ? s.slice(0, 600) + '\u2026' : s;
            }
            tr.appendChild(td);
        }
        frag.appendChild(tr);
    }
    if (!T.order.length) {
        const tr = _pvEl('tr', 'pv-empty'), td = _pvEl('td', null, T.rows.length ? 'No rows match the filter' : 'No rows'); td.colSpan = span; tr.appendChild(td); frag.appendChild(tr);
    } else if (T.order.length > shown) {
        const tr = _pvEl('tr', 'pv-more'), td = document.createElement('td'); td.colSpan = span;
        const b = _pvBtn('Show ' + Math.min(1000, T.order.length - shown).toLocaleString() + ' more (' + (T.order.length - shown).toLocaleString() + ' not shown)', null, '', () => {});
        b.dataset.more = '1'; td.appendChild(b); tr.appendChild(td); frag.appendChild(tr);
    }
    tbody.textContent = ''; tbody.appendChild(frag);

    // statistics row
    tfoot.textContent = '';
    if (T.stats && T.order.length) {
        const tr = document.createElement('tr');
        if (T.rowNum) tr.appendChild(_pvEl('td', 'pv-rn', '\u03A3'));
        T.cols.forEach((_, c) => {
            const s = _pvColStats(T, c), td = _pvEl('td', T.numeric[c] ? 'pv-num' : '');
            if (T.numeric[c] && s.n) {
                td.appendChild(_pvEl('div', null, 'sum ' + _pvNum(s.sum)));
                td.appendChild(_pvEl('div', null, 'avg ' + _pvNum(s.sum / s.n)));
                td.appendChild(_pvEl('div', null, 'min ' + _pvNum(s.min)));
                td.appendChild(_pvEl('div', null, 'max ' + _pvNum(s.max)));
            } else td.appendChild(_pvEl('div', null, s.distinct.toLocaleString() + ' distinct'));
            if (s.nulls) td.appendChild(_pvEl('div', null, s.nulls.toLocaleString() + ' empty'));
            tr.appendChild(td);
        });
        tfoot.appendChild(tr);
    }

    const total = T.rows.length, n = T.order.length;
    _pvById('previewInfo').textContent = (n === total ? total.toLocaleString() + ' rows' : n.toLocaleString() + ' of ' + total.toLocaleString() + ' rows') + ' \u00B7 ' + T.cols.length + ' column' + (T.cols.length === 1 ? '' : 's');
}

// ----- exports: always the rows shown (filtered and sorted), all of them, not just the ones drawn -----
function _pvTableData(T) { return T.order.map((i) => T.rows[i]); }
function _pvTableText(T, kind) {
    const rows = _pvTableData(T);
    if (kind === 'tsv') {
        const clean = (v) => (v === null ? '' : String(v).replace(/[\t\r\n]+/g, ' '));
        return [T.cols.map(clean).join('\t')].concat(rows.map((r) => r.map(clean).join('\t'))).join('\n') + '\n';
    }
    if (kind === 'md') {
        const clean = (v) => (v === null ? '' : String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
        return ['| ' + T.cols.map(clean).join(' | ') + ' |', '| ' + T.cols.map((_, c) => (T.numeric[c] ? '---:' : '---')).join(' | ') + ' |']
            .concat(rows.map((r) => '| ' + r.map(clean).join(' | ') + ' |')).join('\n') + '\n';
    }
    if (kind === 'json') {
        const keys = []; T.cols.forEach((name, c) => { let k = name || ('column_' + (c + 1)); if (keys.includes(k)) k = k + '_' + (c + 1); keys.push(k); });
        return JSON.stringify(rows.map((r) => { const o = {}; keys.forEach((k, c) => { const v = r[c]; o[k] = v === null ? null : (T.numeric[c] ? parseFloat(v) : v); }); return o; }), null, 2) + '\n';
    }
    // csv
    const q = (v) => { const s = v === null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [T.cols.map(q).join(',')].concat(rows.map((r) => r.map(q).join(','))).join('\n') + '\n';
}
async function _pvTableCopy(kind) {
    const T = PV.T; if (!T) return;
    const ok = await _pvCopyText(_pvTableText(T, kind));
    const label = { tsv: 'TSV', md: 'Markdown', json: 'JSON' }[kind];
    _pvToast(ok ? 'Copied ' + T.order.length.toLocaleString() + ' rows as ' + label : 'Copy is not available here');
}
function _pvTableSave(kind) {
    const T = PV.T; if (!T) return;
    const json = kind === 'json';
    _pvSaveBlob(new Blob([_pvTableText(T, kind)], { type: json ? 'application/json' : 'text/csv;charset=utf-8;' }), 'table_' + _pvStamp() + (json ? '.json' : '.csv'));
    _pvToast('Saved ' + T.order.length.toLocaleString() + ' rows as ' + (json ? 'JSON' : 'CSV'));
}

// ==========================================
// Plots
// ==========================================
const _PV_BGS = ['white', 'dark', 'checker'];

window.openPlotPreview = function(initialSrc, cellElement) {
    const container = initPreviewContainer();
    const state = getEnvState();
    const area = _pvSetMode('plot');
    const prefs = _pvLoadPrefs();
    const settingBg = (window.appSettings && window.appSettings.nbPlotBackground === 'Transparent') ? 'checker' : 'white';

    PV.P = { natW: 0, natH: 0, z: 1, x: 0, y: 0, fit: true, bg: _PV_BGS.includes(prefs.plotBg) ? prefs.plotBg : settingBg };
    _pvPlotToolbar();

    const img = document.createElement('img');
    img.id = 'plotPreviewImg'; img.alt = 'Plot'; img.draggable = false;
    img.addEventListener('load', () => { PV.P.natW = img.naturalWidth; PV.P.natH = img.naturalHeight; PV.P.fit = true; _pvPlotLayout(); });
    area.appendChild(img);
    _pvPlotBindGestures(area);
    if (typeof ResizeObserver === 'function') { PV.ro = new ResizeObserver(() => _pvPlotLayout()); PV.ro.observe(area); }
    _pvPlotApplyBg();

    const activePane = document.querySelector('.content-pane.active');
    state.plotNavList = [];
    if (activePane) {
        const allPlotImgs = activePane.querySelectorAll('.output-plot-img');
        const tab = document.querySelector('.tab[data-target="' + activePane.id + '"]');
        const fName = tab && tab.querySelector('span') ? tab.querySelector('span').textContent : 'notebook';
        allPlotImgs.forEach((imgEl) => {
            const parentCell = imgEl.closest('.cell');
            const cellIndex = parentCell && parentCell.closest('.cells-container') ? Array.from(parentCell.closest('.cells-container').querySelectorAll('.cell')).indexOf(parentCell) + 1 : '?';
            state.plotNavList.push({ src: imgEl.src, cellNum: cellIndex, fileName: fName });
        });
    }
    if (!state.plotNavList.length && initialSrc) state.plotNavList.push({ src: initialSrc, cellNum: '?', fileName: 'notebook' });

    state.plotNavIndex = state.plotNavList.findIndex((p) => p.src === initialSrc);
    if (state.plotNavIndex === -1) state.plotNavIndex = 0; 
    
    state.currentPlotZoom = 1;
    _pvPlotThumbs();
    window.renderPlotPreviewIndex();
    _pvShow(container);
};

function _pvPlotToolbar() {
    const tb = _pvById('pvToolbar');
    tb.appendChild(_pvBtn('Fit', 'ri-fullscreen-line', 'Fit to the panel (0)', () => _pvPlotFit()));
    tb.appendChild(_pvBtn('100%', null, 'Actual size (1)', () => _pvPlotActual()));
    const z = _pvEl('span', 'pv-zoomlabel', '100%'); z.id = 'pvZoomLabel'; tb.appendChild(z);
    tb.appendChild(_pvSep());
    const bg = _pvBtn('', 'ri-contrast-2-line', 'Background: white, dark, checkerboard (B)', () => _pvPlotCycleBg());
    bg.id = 'pvBgBtn'; bg.appendChild(_pvEl('span', null, '')); tb.appendChild(bg);
    tb.appendChild(_pvSep());
    tb.appendChild(_pvBtn('Copy', 'ri-file-copy-line', 'Copy the image (C)', () => _pvPlotCopy()));
    tb.appendChild(_pvBtn('PNG', 'ri-download-line', 'Download as PNG', () => _pvPlotDownload()));
}

function _pvPlotThumbs() {
    const state = getEnvState(), box = _pvById('pvThumbs');
    box.textContent = '';
    box.hidden = state.plotNavList.length < 2;
    if (box.hidden) return;   // one plot: no strip
    state.plotNavList.forEach((p, i) => {
        const t = document.createElement('img');
        t.className = 'pv-thumb'; t.src = p.src; t.alt = 'Plot ' + (i + 1); t.title = (p.fileName || '') + ' - Cell ' + p.cellNum; t.draggable = false;
        t.addEventListener('click', () => { state.plotNavIndex = i; window.renderPlotPreviewIndex(); });
        box.appendChild(t);
    });
}

function _pvPlotGo(dir) {
    const state = getEnvState(), n = state.plotNavIndex + dir;
    if (n < 0 || n >= state.plotNavList.length) return;
    state.plotNavIndex = n;
    window.renderPlotPreviewIndex();
}

window.renderPlotPreviewIndex = function() {
    const state = getEnvState();
    if (!state.plotNavList || state.plotNavList.length === 0) return;
    const data = state.plotNavList[state.plotNavIndex];
    
    const imgEl = document.getElementById('plotPreviewImg');
    if (imgEl && PV.P) {
        PV.P.fit = true; PV.P.natW = 0; PV.P.natH = 0;
        imgEl.src = data.src;
        if (imgEl.complete && imgEl.naturalWidth) { PV.P.natW = imgEl.naturalWidth; PV.P.natH = imgEl.naturalHeight; _pvPlotLayout(); }
        state.currentPlotZoom = 1;
    }
    
    document.getElementById('plotFileName').textContent = data.fileName;
    document.getElementById('plotCellNum').textContent = 'Cell ' + data.cellNum;

    const backBtn = document.getElementById('plotNavBack');
    const fwdBtn = document.getElementById('plotNavFwd');
    
    if (state.plotNavIndex > 0) backBtn.classList.remove('disabled');
    else backBtn.classList.add('disabled');
    
    if (state.plotNavIndex < state.plotNavList.length - 1) fwdBtn.classList.remove('disabled');
    else fwdBtn.classList.add('disabled');

    _pvById('pvThumbs').querySelectorAll('.pv-thumb').forEach((t, i) => {
        t.classList.toggle('active', i === state.plotNavIndex);
        if (i === state.plotNavIndex && t.scrollIntoView) { try { t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* older browsers */ } }
    });
    _pvPlotInfo();
};

// Keeps the picture inside the panel: smaller than the panel = centred; bigger = free to pan but never lost.
function _pvPlotLayout() {
    const P = PV.P, area = _pvById('previewContentArea'), img = _pvById('plotPreviewImg');
    if (!P || !area || !img || !P.natW || !P.natH) return;
    const aw = area.clientWidth, ah = area.clientHeight;
    if (!aw || !ah) return;
    if (P.fit) P.z = Math.max(0.02, Math.min(1, (aw - 40) / P.natW, (ah - 40) / P.natH));
    const sw = P.natW * P.z, sh = P.natH * P.z;
    P.x = (P.fit || sw <= aw) ? (aw - sw) / 2 : Math.min(40, Math.max(aw - sw - 40, P.x));
    P.y = (P.fit || sh <= ah) ? (ah - sh) / 2 : Math.min(40, Math.max(ah - sh - 40, P.y));
    img.style.width = P.natW + 'px'; img.style.height = P.natH + 'px';
    img.style.transform = 'translate3d(' + P.x + 'px,' + P.y + 'px,0) scale(' + P.z + ')';
    getEnvState().currentPlotZoom = P.z;
    _pvPlotInfo();
}

function _pvPlotInfo() {
    const P = PV.P, state = getEnvState(); if (!P) return;
    const pct = Math.round(P.z * 100) + '%';
    const lbl = _pvById('pvZoomLabel'); if (lbl) lbl.textContent = pct;
    const parts = [];
    if (state.plotNavList.length > 1) parts.push((state.plotNavIndex + 1) + ' / ' + state.plotNavList.length);
    if (P.natW) parts.push(P.natW + '\u00D7' + P.natH);
    parts.push(pct);
    _pvById('previewInfo').textContent = parts.join(' \u00B7 ');
}

function _pvPlotZoomAt(cx, cy, nz) {
    const P = PV.P; if (!P || !P.natW) return;
    nz = Math.max(0.05, Math.min(16, nz));
    const k = nz / P.z;
    P.x = cx - (cx - P.x) * k; P.y = cy - (cy - P.y) * k; P.z = nz; P.fit = false;
    _pvPlotLayout();
}
function _pvPlotFit() { if (!PV.P) return; PV.P.fit = true; _pvPlotLayout(); }
function _pvPlotActual() { const a = _pvById('previewContentArea'); if (a) _pvPlotZoomAt(a.clientWidth / 2, a.clientHeight / 2, 1); }

// Kept for anything that still calls it: a step in (positive) or out (negative), about the middle of the panel.
window.updatePlotZoom = function(delta) {
    const P = PV.P, a = _pvById('previewContentArea'); if (!P || !a) return;
    _pvPlotZoomAt(a.clientWidth / 2, a.clientHeight / 2, P.z * (delta >= 0 ? 1.25 : 0.8));
};

function _pvPlotApplyBg() {
    const P = PV.P, area = _pvById('previewContentArea'); if (!P || !area) return;
    _PV_BGS.forEach((b) => area.classList.toggle('pv-bg-' + b, b === P.bg));
    const btn = _pvById('pvBgBtn');
    if (btn) { const s = btn.querySelector('span'); if (s) s.textContent = { white: 'White', dark: 'Dark', checker: 'Checker' }[P.bg]; }
}
function _pvPlotCycleBg() {
    const P = PV.P; if (!P) return;
    P.bg = _PV_BGS[(_PV_BGS.indexOf(P.bg) + 1) % _PV_BGS.length];
    _pvSavePrefs({ plotBg: P.bg });
    _pvPlotApplyBg();
}

function _pvPlotDownload() {
    const img = _pvById('plotPreviewImg'); if (!img || !img.src) return;
    const a = document.createElement('a');
    a.href = img.src;
    a.download = 'plot_export_' + Date.now() + '.png';
    a.click();
}

async function _pvPlotCopy() {
    const img = _pvById('plotPreviewImg'), P = PV.P;
    if (!img || !P || !P.natW) return;
    try {
        if (!navigator.clipboard || typeof ClipboardItem === 'undefined') throw new Error('no image clipboard');
        const c = document.createElement('canvas'); c.width = P.natW; c.height = P.natH;
        c.getContext('2d').drawImage(img, 0, 0);
        // the blob is passed as a promise: Safari only allows a clipboard write that starts inside the tap
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/png')) })]);
        _pvToast('Image copied');
    } catch (e) {
        _pvToast('Copying images is not available here. Use PNG to download it.');
    }
}

// Drag to pan, wheel / trackpad pinch / two-finger pinch to zoom, double-click (or double-tap) to toggle Fit and 100%.
function _pvPlotBindGestures(area) {
    const pts = new Map();
    let pan = null, pinch = null;
    const rel = (e) => { const r = area.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    area.addEventListener('pointerdown', (e) => {
        if (!PV.P || !PV.P.natW) return;
        try { area.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
        pts.set(e.pointerId, rel(e));
        if (pts.size === 1) { pan = { sx: pts.get(e.pointerId).x, sy: pts.get(e.pointerId).y, px: PV.P.x, py: PV.P.y }; area.classList.add('pv-grabbing'); }
        if (pts.size === 2) {
            const [a, b] = Array.from(pts.values());
            pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, z: PV.P.z, x: PV.P.x, y: PV.P.y };
            pan = null;
        }
    });
    area.addEventListener('pointermove', (e) => {
        if (!pts.has(e.pointerId) || !PV.P) return;
        pts.set(e.pointerId, rel(e));
        const P = PV.P;
        if (pts.size >= 2 && pinch) {
            const [a, b] = Array.from(pts.values());
            const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            const nz = Math.max(0.05, Math.min(16, pinch.z * d / pinch.d)), k = nz / pinch.z;
            P.z = nz; P.fit = false;
            P.x = mx - (pinch.mx - pinch.x) * k; P.y = my - (pinch.my - pinch.y) * k;
            _pvPlotLayout();
        } else if (pan) {
            const p = pts.get(e.pointerId);
            P.x = pan.px + (p.x - pan.sx); P.y = pan.py + (p.y - pan.sy);
            _pvPlotLayout();
        }
    });
    const end = (e) => {
        pts.delete(e.pointerId);
        if (pts.size < 2) pinch = null;
        if (pts.size === 1) { const p = Array.from(pts.values())[0]; pan = { sx: p.x, sy: p.y, px: PV.P ? PV.P.x : 0, py: PV.P ? PV.P.y : 0 }; }
        if (pts.size === 0) { pan = null; area.classList.remove('pv-grabbing'); }
    };
    area.addEventListener('pointerup', end);
    area.addEventListener('pointercancel', end);
    area.addEventListener('wheel', (e) => {
        if (!PV.P || !PV.P.natW) return;
        e.preventDefault();
        const p = rel(e);
        _pvPlotZoomAt(p.x, p.y, PV.P.z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
    }, { passive: false });
    area.addEventListener('dblclick', (e) => {
        if (!PV.P || !PV.P.natW) return;
        const p = rel(e);
        if (Math.abs(PV.P.z - 1) < 0.01) _pvPlotFit(); else _pvPlotZoomAt(p.x, p.y, 1);
    });
}
