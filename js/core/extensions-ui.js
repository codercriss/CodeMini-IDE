// ==========================================
// extensions-ui.js: the Extensions sidebar (UI/UX specs, feature 26, first release)
// ==========================================
// Behind the plug item of the activity bar (`extensionIconItem`): a 300px sidebar with two tabs.
//   Installed   the themes and theme packs that come with the app (Apply / Active), what the person installed from a file (themes and snippet
//               packs, with an on/off switch, details and Uninstall), and the components saved on this device (Manage opens the Components tab).
//   Components  the libraries the app loads from a CDN, in four groups (LANGUAGES AND RUNTIMES, EDITING, VIEWERS, CORE): their state, a
//               Keep offline switch, Download, Re-verify, Remove from this device, and the storage and Download all summary. This is feature 13's
//               package list, built once, here; the Now Island's Offline and Packages section keeps three summary rows and Manage opens this tab.
//   Install     "Install from file" reads a .cmpack and shows a REVIEW first (what it is, where from, a short hash, the Guard verdict, what it
//               changes); nothing is installed until the person says so.
// Not in this release: the Discover tab (the bundled catalog), update checks, workspace recommendations, scripted extensions, Share links, and the
// Guard report (Guard is not built, so the verdict says "Not fully checked"). The engine is js/core/extensions.js and js/core/offline.js; this file
// only draws it, with textContent, never from markup.
(function (root) {
    'use strict';
    const W = root;
    if (typeof document === 'undefined') return;

    const $ = (id) => document.getElementById(id);
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const icon = (cls) => el('i', cls);
    const link = (text, label, fn, extra) => { const b = el('button', 'ni-link' + (extra ? ' ' + extra : ''), text); b.type = 'button'; if (label) b.setAttribute('aria-label', label); b.addEventListener('click', (e) => { e.stopPropagation(); fn(e); }); return b; };
    const iconBtn = (cls, label, fn) => { const b = el('button', 'sb-icon-btn'); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.appendChild(icon(cls)); b.addEventListener('click', (e) => { e.stopPropagation(); fn(e); }); return b; };
    const EXT = () => W.CodeMiniExtensions, OFF = () => W.CodeMiniOffline;
    const rules = () => W.CodeMiniOfflineRules;                   // offline.js's pure rules (the catalogue, the labels)
    const toast = (m) => { if (typeof W.showSuccessToast === 'function') W.showSuccessToast(m); };

    const S = {
        tab: 'installed', q: { installed: '', components: '' }, filter: 'all', scroll: { installed: 0, components: 0 },
        review: null, error: null, expanded: new Set(), confirm: null, menu: false, verify: new Map(), checking: new Set(), highlight: ''
    };
    let ui = null;
    const isOpen = () => !!$('extensionsSidebar') && $('extensionsSidebar').classList.contains('open');
    const fmtBytes = (b) => (rules() ? rules().fmtBytes(b) : String(b));
    const FILTERS = [['all', 'All'], ['themes', 'Themes'], ['packs', 'Packs']];

    // ---------------------------------------------------------------------------------------------
    // The Installed tab's rows
    // ---------------------------------------------------------------------------------------------
    const settings = () => W.appSettings || {};
    const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    function installedRows() {
        const out = [], ext = EXT(), st = settings();
        const extActive = ext ? ext.activeThemeId() : '';
        Object.keys(W.THEME_REGISTRY || {}).forEach((name) => out.push({ id: 'builtin-theme-' + slug(name), kind: 'theme', name, meta: 'Built in, by CodeMini', builtIn: true, enabled: true,
            active: !extActive && (!st.themePack || st.themePack === 'None') && st.colorTheme === name, apply: () => ext && ext.applyBuiltIn(name, 'None') }));
        Object.keys(W.THEME_PACK_REGISTRY || {}).filter((n) => n !== 'None').forEach((name) => out.push({ id: 'builtin-pack-' + slug(name), kind: 'theme', name, meta: 'Theme pack, built in, by CodeMini', builtIn: true, enabled: true,
            active: st.themePack === name, apply: () => ext && ext.applyBuiltIn(null, name) }));
        if (ext) ext.store.list().forEach((r) => out.push({ id: r.id, kind: r.kind, name: r.name, record: r, enabled: r.enabled !== false,
            meta: ['v' + r.version, r.author ? 'by ' + r.author : '', 'from ' + r.source].filter(Boolean).join(', '), active: r.kind === 'theme' && ext.isThemeActive(r.id), apply: () => ext.applyTheme(r.id) }));
        const off = OFF();
        if (off) off.rows().filter((r) => r.state === 'ready' || r.state === 'partial').forEach((r) => out.push({ id: 'component-' + r.pkg.id, kind: 'component', name: r.pkg.name, meta: 'v' + r.pkg.version + ', ' + (r.state === 'ready' ? 'saved on this device' : 'partly saved'), enabled: true, component: r }));
        return out;
    }
    const KIND_LABEL = { theme: 'THEME', pack: 'PACK', component: 'COMPONENT' };
    const KIND_ICON = { theme: 'ri-palette-line', pack: 'ri-file-list-3-line', component: 'ri-box-3-line' };
    function matches(r, q, filter) {
        if (filter === 'themes' && r.kind !== 'theme') return false;
        if (filter === 'packs' && r.kind !== 'pack') return false;
        return !q || (r.name + ' ' + KIND_LABEL[r.kind] + ' ' + (r.meta || '')).toLowerCase().indexOf(q.toLowerCase()) > -1;
    }

    function sw(on, label, onToggle) {
        const b = el('button', 'ext-switch' + (on ? ' on' : '')); b.type = 'button'; b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(!!on)); b.setAttribute('aria-label', label); b.title = label;
        b.appendChild(el('span', 'ext-switch-knob'));
        b.addEventListener('click', (e) => { e.stopPropagation(); onToggle(!on); });
        return b;
    }
    const pill = (text, cls) => el('span', 'ext-pill' + (cls ? ' ' + cls : ''), text);
    function section(label, count) {
        const h = el('div', 'sb-section-header'); const s = el('span'); s.appendChild(document.createTextNode(label));
        if (count != null) s.appendChild(el('span', 'sb-count-badge', String(count)));
        h.appendChild(s); return h;
    }
    const when = (t) => (t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

    function installedRow(r) {
        const open = S.expanded.has(r.id);
        const li = el('div', 'ext-row' + (open ? ' open' : '') + (S.highlight === r.id ? ' fresh' : '') + (r.enabled ? '' : ' off')); li.dataset.ext = r.id;
        const main = el('button', 'ext-row-main'); main.type = 'button'; main.setAttribute('aria-expanded', String(open));
        const text = el('span', 'ext-row-text'), l1 = el('span', 'ext-row-l1');
        l1.append(el('span', 'ext-row-name', r.name), pill(KIND_LABEL[r.kind]));
        text.append(l1, el('span', 'ext-row-l2', r.meta));
        main.append(icon(KIND_ICON[r.kind] + ' ext-ico'), text);
        main.addEventListener('click', () => { if (open) S.expanded.delete(r.id); else S.expanded.add(r.id); renderBody(); });
        const end = el('span', 'ext-row-end');
        if (r.kind === 'theme') end.appendChild(r.active ? pill('Active', 'active') : link('Apply', 'Apply ' + r.name, () => { r.apply(); renderBody(); }));
        else if (r.kind === 'pack') end.appendChild(sw(r.enabled, (r.enabled ? 'Disable ' : 'Enable ') + r.name, (on) => { EXT().setEnabled(r.id, on); }));
        else end.appendChild(link('Manage', 'Manage ' + r.name + ' in Components', () => { S.q.components = r.name.replace(/ \(.*$/, ''); setTab('components'); }));
        li.append(main, end);
        if (!open) return li;
        const d = el('div', 'ext-detail');
        if (r.record) {
            const rec = r.record;
            if (rec.description) d.appendChild(el('div', 'ext-desc', rec.description));
            [['Source', rec.source], ['Version', 'v' + rec.version], ['SHA-256', (rec.hash || '').slice(0, 12)], ['Installed', when(rec.installedAt)]].forEach(([k, v]) => { const row = el('div', 'ext-kv'); row.append(el('span', 'ext-k', k), el('span', 'ext-v', v)); d.appendChild(row); });
            const g = el('div', 'ext-kv'); g.append(el('span', 'ext-k', 'Guard'), pill('Not fully checked', 'warn')); d.appendChild(g);
            if (rec.previous) d.appendChild(el('div', 'ext-desc', 'Replaced v' + rec.previous.version + '.'));
            const act = el('div', 'ext-actions');
            if (S.confirm && S.confirm.kind === 'uninstall' && S.confirm.id === r.id) {
                act.append(el('span', 'ext-confirm', rec.kind === 'theme' ? 'Uninstall this theme?' : 'Uninstall this pack and its ' + (rec.payload.count || '') + ' snippets?'),
                    link('Uninstall', 'Confirm: uninstall ' + r.name, () => { S.confirm = null; S.expanded.delete(r.id); EXT().uninstall(r.id); toast('Uninstalled ' + r.name); }), link('Cancel', 'Cancel', () => { S.confirm = null; renderBody(); }));
            } else act.appendChild(link('Uninstall', 'Uninstall ' + r.name, () => { S.confirm = { kind: 'uninstall', id: r.id }; renderBody(); }, 'danger'));
            d.appendChild(act);
        } else if (r.builtIn) d.appendChild(el('div', 'ext-desc', 'Part of CodeMini. It cannot be uninstalled.'));
        else if (r.component) d.appendChild(el('div', 'ext-desc', 'A library CodeMini loads from the web, saved on this device so it works offline. Manage it in the Components tab.'));
        li.appendChild(d);
        return li;
    }

    function drawInstalled(body) {
        const all = installedRows().filter((r) => matches(r, S.q.installed, S.filter));
        if (S.error) body.appendChild(errorBanner());
        if (!all.length) { body.appendChild(el('div', 'ext-empty', S.q.installed || S.filter !== 'all' ? 'Nothing matches.' : 'Nothing installed yet.')); return; }
        const enabled = all.filter((r) => r.enabled), disabled = all.filter((r) => !r.enabled);
        body.appendChild(section('ENABLED', enabled.length)); enabled.forEach((r) => body.appendChild(installedRow(r)));
        if (disabled.length) { body.appendChild(section('DISABLED', disabled.length)); disabled.forEach((r) => body.appendChild(installedRow(r))); }
    }
    function errorBanner() {
        const b = el('div', 'ext-error'); b.setAttribute('role', 'alert');
        const top = el('div', 'ext-error-top'); top.append(icon('ri-close-circle-fill'), el('span', null, S.error.message), link('Dismiss', 'Dismiss this message', () => { S.error = null; renderBody(); }));
        b.appendChild(top);
        if (S.error.details && S.error.details.length) { const ul = el('ul', 'ext-error-list'); S.error.details.slice(0, 6).forEach((t) => ul.appendChild(el('li', null, t))); b.appendChild(ul); }
        return b;
    }

    // ---------------------------------------------------------------------------------------------
    // The Components tab: feature 13's package list
    // ---------------------------------------------------------------------------------------------
    function stateIcon(state, pct) {
        const R = rules(), d = R.STATE_ICON[state] || R.STATE_ICON.none, i = icon(d.icon + ' ext-ico off-' + d.tone);
        i.setAttribute('role', 'img'); i.setAttribute('aria-label', d.label + (state === 'loading' && pct != null ? ' ' + pct + '%' : '')); i.title = d.label; return i;
    }
    function componentRow(r) {
        const R = rules(), off = OFF(), pkg = r.pkg, open = S.expanded.has('c:' + pkg.id), kept = off.isKept(pkg.id), bytes = off.packageBytes(r);
        const li = el('div', 'ext-row' + (open ? ' open' : '')); li.dataset.comp = pkg.id;
        const main = el('button', 'ext-row-main'); main.type = 'button'; main.setAttribute('aria-expanded', String(open));
        main.setAttribute('aria-label', pkg.name + ', ' + (R.STATE_ICON[r.state] || R.STATE_ICON.none).label);
        const text = el('span', 'ext-row-text'), l1 = el('span', 'ext-row-l1');
        l1.append(el('span', 'ext-row-name', pkg.name), pill(pkg.version));
        const files = r.result && r.result.total ? r.result.have + ' of ' + r.result.total + ' files' : '';
        text.append(l1, el('span', 'ext-row-l2', 'Needed by: ' + R.neededByText(pkg, 2)), el('span', 'ext-row-l2', [R.hostOf(pkg), files].filter(Boolean).join(' \u00b7 ')));
        main.append(stateIcon(r.state, r.busy && r.busy.pct), text, el('span', 'ext-size', bytes ? fmtBytes(bytes) : ''));
        main.addEventListener('click', () => { const k = 'c:' + pkg.id; if (S.expanded.has(k)) S.expanded.delete(k); else S.expanded.add(k); renderBody(); });
        const end = el('span', 'ext-row-end');
        if (pkg.required) { const lock = icon('ri-lock-line ext-lock'); lock.setAttribute('role', 'img'); lock.setAttribute('aria-label', 'Required: CodeMini cannot run without it'); lock.title = 'Required: CodeMini cannot run without it'; end.appendChild(lock); }
        else if (!pkg.bundled && r.state !== 'runner') end.appendChild(sw(kept, (kept ? 'Stop keeping ' : 'Keep ') + pkg.name + ' offline', (on) => { off.setKeep(pkg.id, on); }));
        li.append(main, end);
        if (r.state === 'loading') { const line = el('div', 'off-line'); const f = el('div', 'off-line-fill'); f.style.width = (r.busy.pct || 3) + '%'; line.appendChild(f); li.appendChild(line); }
        if (!open) return li;
        const d = el('div', 'ext-detail'), note = (t, cls) => d.appendChild(el('div', 'ext-desc' + (cls ? ' ' + cls : ''), t));
        if (r.state === 'loading') note('Downloading ' + (r.busy.pct || 0) + '%');
        if (r.state === 'failed') note(r.busy.error || 'It could not be saved.', 'danger');
        if (r.state === 'runner') note('Isolation is on, so this runs inside the runner: a separate site with no service worker of its own. This app cannot see or fill the runner\u2019s cache, so it is not counted here. The browser\u2019s own cache may keep it between visits, but that cannot be checked from here. In Same origin mode (Settings > Security) the files below are used.');
        if (r.state === 'session') note('It was loaded in this session but is not saved on this device (the service worker may not be controlling this page yet). Download it to keep a copy.');
        if (pkg.bundled) note('Part of the app itself. It is saved with the app shell and works offline once the browser has installed the app.');
        if (pkg.required) note('Required. CodeMini cannot run without it, so it is always kept and has no Remove.');
        if (pkg.note && r.state !== 'runner') note(pkg.note);
        if (r.result && !r.result.closureKnown && r.state !== 'none' && r.state !== 'runner') note('Some of the files it pulls in are not known until the main file is saved.');
        if (r.extras.length) note('+' + r.extras.length + (r.extras.length === 1 ? ' more file' : ' more files') + ' saved while you used it');
        const rel = el('div', 'off-rels');
        [['Needed by', pkg.neededBy]].concat(pkg.dependsOn.length ? [['Depends on', pkg.dependsOn.map((id) => { const p = R.byId(id); return p ? p.name + ' ' + p.version : id; })]] : []).forEach(([t, items]) => {
            const w = el('div', 'off-rel'); w.appendChild(el('div', 'off-rel-title', t)); const ul = el('ul', 'off-rel-list'); items.forEach((x) => ul.appendChild(el('li', null, x))); w.appendChild(ul); rel.appendChild(w);
        });
        d.appendChild(rel);
        if (r.result && r.result.files.length) {
            const fl = el('details', 'off-files'); fl.appendChild(el('summary', null, 'Files (' + r.result.files.length + ')'));
            const ul = el('ul', 'off-file-list');
            r.result.files.forEach((l) => { const x = el('li', l.cached ? 'cached' : ''); x.append(icon(l.cached ? 'ri-checkbox-circle-fill off-new' : 'ri-cloud-line off-muted'), el('span', null, l.url.replace(/^https?:\/\//, '') + (l.optional ? ' (optional)' : ''))); ul.appendChild(x); });
            fl.appendChild(ul); d.appendChild(fl);
        }
        const v = S.verify.get(pkg.id);
        if (v) {
            note(v.ok ? 'Verified ' + v.checked + (v.checked === 1 ? ' file' : ' files') + (v.bytes ? ' (' + fmtBytes(v.bytes) + ')' : '') + ': all readable' + '.' : v.problems.length + (v.problems.length === 1 ? ' file has a problem' : ' files have problems') + ':', v.ok ? '' : 'danger');
            if (!v.ok) { const ul = el('ul', 'off-file-list'); v.problems.slice(0, 5).forEach((p) => ul.appendChild(el('li', null, p.url.replace(/^https?:\/\//, '').slice(-60) + ': ' + p.why))); d.appendChild(ul); }
        }
        const act = el('div', 'ext-actions'), online = typeof navigator === 'undefined' || navigator.onLine !== false, busy = off.info().running;
        const cached = !!(r.result && (r.result.files.some((l) => l.cached) || r.extras.length));
        if (!pkg.bundled && r.state !== 'runner') {
            if (r.state !== 'ready' && r.state !== 'loading') { const b = link(r.state === 'failed' ? 'Retry' : 'Download', 'Download ' + pkg.name, () => off.download([pkg.id])); if (!online || busy) b.disabled = true; act.appendChild(b); }
            if (cached && r.state !== 'loading') {
                const rv = link(S.checking.has(pkg.id) ? 'Verifying' : 'Re-verify', 'Re-verify ' + pkg.name, async () => { S.checking.add(pkg.id); renderBody(); const res = await off.verify(pkg.id); S.checking.delete(pkg.id); if (res) S.verify.set(pkg.id, res); renderBody(); });
                act.appendChild(rv);
                const rd = link('Re-download', 'Download ' + pkg.name + ' again', () => { S.verify.delete(pkg.id); off.download([pkg.id], { redo: true }); }); if (!online || busy) rd.disabled = true; act.appendChild(rd);
                if (!pkg.required) {
                    if (S.confirm && S.confirm.kind === 'remove' && S.confirm.id === pkg.id) act.append(el('span', 'ext-confirm', R.removeMessage(pkg.name, bytes)), link('Remove', 'Confirm: remove ' + pkg.name + ' from this device', async () => { S.confirm = null; S.verify.delete(pkg.id); await off.removePackage(pkg.id); }), link('Cancel', 'Cancel', () => { S.confirm = null; renderBody(); }));
                    else act.appendChild(link('Remove from this device', 'Remove ' + pkg.name + ' from this device', () => { S.confirm = { kind: 'remove', id: pkg.id }; renderBody(); }, 'danger'));
                }
            }
        }
        if (pkg.source) act.appendChild(link('Open source', 'Open the ' + pkg.name + ' page', () => { try { W.open(pkg.source, '_blank', 'noopener'); } catch (e) { /* popup blocked */ } }));
        d.appendChild(act); li.appendChild(d);
        return li;
    }

    function summaryRow() {
        const R = rules(), off = OFF(), info = off.info(), est = info.storage, used = est && est.usage || 0, quota = est && est.quota || 0, pct = quota ? 100 * used / quota : 0;
        const wrap = el('div', 'ext-summary');
        const top = el('div', 'ext-summary-top');
        top.appendChild(el('span', 'ext-summary-text', est ? fmtBytes(used) + ' of ' + fmtBytes(quota) + ' used' : 'Storage use is not available in this browser'));
        const prot = info.persisted === false && W.CodeMiniAlerts && W.CodeMiniAlerts.canProtectStorage && W.CodeMiniAlerts.canProtectStorage();
        if (prot) top.appendChild(link('Protect storage', 'Ask the browser to keep this storage', async () => { try { await W.CodeMiniAlerts.protectStorage(); } finally { await off.refresh(); } }));
        wrap.appendChild(top);
        if (est) { const line = el('div', 'ext-usage'); const f = el('div', 'ext-usage-fill' + (pct > 90 ? ' danger' : pct > 75 ? ' yellow' : '')); f.style.width = Math.min(100, pct) + '%'; line.appendChild(f); wrap.appendChild(line); }
        const sum = off.summary(), left = off.missing(), online = typeof navigator === 'undefined' || navigator.onLine !== false;
        wrap.appendChild(el('div', 'ext-summary-sub', R.summaryText(sum) + (sum.runner ? ' \u00b7 ' + sum.runner + ' run' + (sum.runner === 1 ? 's' : '') + ' in the isolated runner (not covered)' : '')));
        const row = el('div', 'ext-summary-row');
        if (info.running) row.appendChild(link('Stop downloading', 'Stop downloading', () => off.stop()));
        else if (S.confirm && S.confirm.kind === 'slow') {
            wrap.appendChild(el('div', 'ext-summary-sub', 'You are on a slow or data-saver connection, and these files are large. Download anyway?'));
            row.append(link('Download', 'Download anyway', () => { S.confirm = null; off.download(off.rows().filter(off.needsDownload).map((x) => x.pkg.id)); }), link('Cancel', 'Cancel', () => { S.confirm = null; renderBody(); }));
        } else { const b = link(R.leftLabel(left), 'Download all components for offline use', () => { if (R.slowConnection(navigator.connection)) { S.confirm = { kind: 'slow' }; renderBody(); return; } off.download(off.rows().filter(off.needsDownload).map((x) => x.pkg.id)); }); if (!left || !online) b.disabled = true; row.appendChild(b); }
        if (!online) row.appendChild(el('span', 'ext-summary-sub', 'You are offline. Downloads need a connection.'));
        if (info.lastError) row.appendChild(el('span', 'ext-summary-sub danger', info.lastError));
        wrap.appendChild(row);
        return wrap;
    }
    function drawComponents(body) {
        const R = rules(), off = OFF();
        if (!off) { body.appendChild(el('div', 'ext-empty', 'Components are not available.')); return; }
        body.appendChild(summaryRow());
        const rs = R.filterRows(off.rows(), 'all', S.q.components);
        if (!rs.length) { body.appendChild(el('div', 'ext-empty', 'Nothing matches.')); return; }
        R.groupRows(rs).forEach((g) => { body.appendChild(section(g.section, g.rows.length)); g.rows.forEach((r) => body.appendChild(componentRow(r))); });
    }

    // ---------------------------------------------------------------------------------------------
    // Install from a file: the review
    // ---------------------------------------------------------------------------------------------
    function drawReview(body) {
        const rv = S.review, rec = rv.record;
        const top = el('div', 'ext-review-head'); top.append(el('span', 'ext-review-name', rec.name), pill(rv.kind === 'theme' ? 'THEME' : 'PACK'));
        body.appendChild(top);
        rv.rows.forEach(([k, v]) => { const row = el('div', 'ext-kv'); row.append(el('span', 'ext-k', k), el('span', 'ext-v', v)); body.appendChild(row); });
        if (rv.replaces) body.appendChild(el('div', 'ext-note' + (rv.replaces.same ? ' warn' : ''), rv.replaces.same ? 'This exact version (v' + rv.replaces.version + ') is already installed.' : 'This replaces v' + rv.replaces.version + '.'));
        body.appendChild(section('GUARD REPORT'));
        const g = el('div', 'ext-guard'); g.append(pill(rv.guard.verdict, 'warn'), el('span', 'ext-desc', rv.guard.text)); body.appendChild(g);
        body.appendChild(section('WHAT IT CHANGES'));
        const ul = el('ul', 'ext-changes'); rv.changes.forEach((t) => ul.appendChild(el('li', null, t))); body.appendChild(ul);
        if (rv.warnings.length) { const w = el('ul', 'ext-warnings'); rv.warnings.forEach((t) => { const li = el('li'); li.append(icon('ri-error-warning-line'), el('span', null, t)); w.appendChild(li); }); body.appendChild(w); }
        const det = el('details', 'off-files ext-source'); det.appendChild(el('summary', null, 'View source (' + rv.file + ')'));
        const pre = el('pre', 'ext-pre'); pre.textContent = rv.sourceText.length > 20000 ? rv.sourceText.slice(0, 20000) + '\n\u2026' : rv.sourceText; det.appendChild(pre); body.appendChild(det);
        const same = rv.replaces && rv.replaces.same, actions = el('div', 'ext-review-actions');
        const primary = el('button', 'ni-btn primary', rv.kind === 'theme' ? 'Install and apply' : 'Install and enable'); primary.type = 'button'; primary.disabled = !!same;
        primary.addEventListener('click', () => doInstall(true));
        const second = el('button', 'ni-btn', rv.kind === 'theme' ? 'Install' : 'Install disabled'); second.type = 'button'; second.disabled = !!same;
        second.addEventListener('click', () => doInstall(false));
        const cancel = link('Cancel', 'Cancel the install', closeReview);
        actions.append(primary, second, cancel); body.appendChild(actions);
    }
    function doInstall(enable) {
        const rv = S.review; if (!rv) return;
        try {
            const rec = EXT().install(rv, enable);
            toast('Installed ' + rec.name);
            S.review = null; S.error = null; S.highlight = rec.id; S.expanded.add(rec.id); S.tab = 'installed'; S.q.installed = ''; render();
            setTimeout(() => { S.highlight = ''; if (isOpen()) renderBody(); }, 2500);
        } catch (e) { S.review = null; S.error = { message: 'It could not be installed: ' + e.message }; render(); }
    }
    function closeReview() { S.review = null; render(); }
    async function chooseFile(file) {
        if (!file) return;
        const res = await EXT().reviewFile(file);
        if (!res.ok) { S.error = { message: res.error, details: res.details }; S.review = null; setTab('installed'); return; }
        S.error = null; S.review = res.review; render();
    }

    // ---------------------------------------------------------------------------------------------
    // The frame: header, tabs, search, body
    // ---------------------------------------------------------------------------------------------
    function setTab(tab) { S.scroll[S.tab] = ui && ui.body ? ui.body.scrollTop : 0; S.tab = tab; S.confirm = null; S.review = null; render(); }
    function renderBody() {
        if (!ui || !ui.body) return;
        const keep = ui.body.scrollTop; ui.body.textContent = '';
        if (S.review) drawReview(ui.body); else if (S.tab === 'components') drawComponents(ui.body); else drawInstalled(ui.body);
        ui.body.scrollTop = keep;
        if (ui.tabs) { const n = installedRows().length; const t = ui.tabs.querySelector('[data-tab="installed"] .sb-count-badge'); if (t) t.textContent = String(n); }
    }
    function render() {
        const rootEl = $('extRoot'); if (!rootEl) return;
        rootEl.textContent = '';
        const head = el('div', 'sb-header');
        if (S.review) {
            const left = el('div', 'ext-back'); left.append(iconBtn('ri-arrow-left-line', 'Back', closeReview), el('div', 'sb-title', 'Review Extension')); head.appendChild(left);
        } else head.appendChild(el('div', 'sb-title', 'Extensions'));
        const tools = el('div', 'sb-tools');
        if (!S.review) {
            const add = iconBtn('ri-add-line', 'Install', () => { S.menu = !S.menu; render(); }); if (S.menu) add.classList.add('on'); tools.appendChild(add);
        }
        tools.appendChild(iconBtn('ri-close-line', 'Close', close));
        head.appendChild(tools); rootEl.appendChild(head);
        ui = { root: rootEl, body: null, tabs: null };
        if (S.menu && !S.review) {
            const menu = el('div', 'ext-menu'); menu.setAttribute('role', 'menu');
            const item = el('button', 'ext-menu-item', 'Install from file\u2026'); item.type = 'button'; item.setAttribute('role', 'menuitem');
            item.addEventListener('click', () => { S.menu = false; render(); $('extFile').value = ''; $('extFile').click(); });
            menu.appendChild(item); rootEl.appendChild(menu);
        }
        if (!S.review) {
            const tabs = el('div', 'sb-tabs'); tabs.setAttribute('role', 'tablist');
            [['installed', 'Installed'], ['components', 'Components']].forEach(([id, label]) => {
                const b = el('button', 'sb-tab' + (S.tab === id ? ' active' : ''), label); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(S.tab === id)); b.dataset.tab = id;
                if (id === 'installed') b.appendChild(el('span', 'sb-count-badge', String(installedRows().length)));
                b.addEventListener('click', () => { if (S.tab !== id) setTab(id); });
                tabs.appendChild(b);
            });
            rootEl.appendChild(tabs); ui.tabs = tabs;
            const bar = el('div', 'ext-searchbar');
            const input = el('input', 'ext-search'); input.type = 'search'; input.placeholder = S.tab === 'components' ? 'Search components' : 'Search installed'; input.value = S.q[S.tab]; input.setAttribute('aria-label', input.placeholder);
            input.addEventListener('input', () => { S.q[S.tab] = input.value; renderBody(); });
            bar.appendChild(input);
            if (S.tab === 'installed') {
                const seg = el('div', 'sb-segmented'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Show');
                FILTERS.forEach(([id, label]) => { const b = el('button', 'sb-seg' + (S.filter === id ? ' active' : ''), label); b.type = 'button'; b.dataset.extFilter = id; b.addEventListener('click', () => { S.filter = id; seg.querySelectorAll('.sb-seg').forEach((x) => x.classList.toggle('active', x.dataset.extFilter === id)); renderBody(); }); seg.appendChild(b); });
                bar.appendChild(seg);
            }
            rootEl.appendChild(bar);
        }
        ui.body = el('div', 'sb-body ext-body'); rootEl.appendChild(ui.body);
        renderBody();
        if (S.tab === 'components' && !S.review && OFF()) OFF().wantSizes(true); else if (OFF()) OFF().wantSizes(false);
        if (!S.review) ui.body.scrollTop = S.scroll[S.tab] || 0;
    }

    // ---------------------------------------------------------------------------------------------
    // Opening and closing, like every other sidebar
    // ---------------------------------------------------------------------------------------------
    function open(tab) {
        const sb = $('extensionsSidebar'); if (!sb) return;
        if (typeof W.closeAllSidebars === 'function') W.closeAllSidebars();
        sb.classList.add('open'); $('extensionIconItem')?.classList.add('active');
        if (tab === 'installed' || tab === 'components') { S.tab = tab; S.review = null; }
        shown();
        if (typeof W.saveCurrentUIState === 'function') W.saveCurrentUIState();
    }
    function close() {
        $('extensionsSidebar')?.classList.remove('open'); $('extensionIconItem')?.classList.remove('active'); S.menu = false;
        if (OFF()) OFF().wantSizes(false);
        if (typeof W.saveCurrentUIState === 'function') W.saveCurrentUIState();
    }
    // Whenever the sidebar becomes visible (a click, "Manage", or the saved layout being restored), draw it from the current state.
    function shown() { render(); if (OFF()) OFF().refresh(); }

    function init() {
        const sb = $('extensionsSidebar'); if (!sb) return;
        const root = el('div', 'ext-root'); root.id = 'extRoot'; sb.appendChild(root);
        const file = el('input'); file.type = 'file'; file.id = 'extFile'; file.accept = '.cmpack,.zip'; file.hidden = true; file.addEventListener('change', () => { const f = file.files && file.files[0]; if (f) chooseFile(f); });
        sb.appendChild(file);
        // The plug item gets its id from script.js after load, so the click is caught here rather than bound to the element.
        document.addEventListener('click', (e) => {
            const item = e.target && e.target.closest ? e.target.closest('#extensionIconItem') : null; if (!item) return;
            const was = sb.classList.contains('open'); if (typeof W.closeAllSidebars === 'function') W.closeAllSidebars();
            if (!was) { sb.classList.add('open'); item.classList.add('active'); shown(); }
            if (typeof W.saveCurrentUIState === 'function') W.saveCurrentUIState();
        });
        // the saved layout re-opens the sidebar by adding the class itself: draw it then too
        new MutationObserver(() => { if (isOpen() && !ui) shown(); else if (isOpen() && ui && !ui.root.isConnected) shown(); }).observe(sb, { attributes: true, attributeFilter: ['class'] });
        const redraw = () => { if (isOpen()) renderBody(); };
        if (OFF()) OFF().onChange(redraw);
        if (EXT()) EXT().store.onChange(redraw);
        W.addEventListener('codemini:theme-settings', redraw);   // a theme was applied elsewhere (Settings): Apply and Active follow
        if (isOpen()) shown();
    }
    init();

    W.CodeMiniExtensionsUI = Object.freeze({ open, close, isOpen, state: () => ({ tab: S.tab, review: !!S.review, error: S.error && S.error.message, filter: S.filter, q: Object.assign({}, S.q) }), chooseFile, render });
})(typeof window !== 'undefined' ? window : globalThis);
