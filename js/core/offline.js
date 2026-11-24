// ==========================================
// offline.js: Offline and Packages, UI/UX specs feature 13
// ==========================================
// An OFFLINE AND PACKAGES section at the bottom of the Now Island's Now pane (order 40) and a full-island drill-in view that lists every
// library the app loads from a CDN, whether each one is saved on this device, and lets the person download, re-download or remove them.
//
// What "saved" means here, and the limits that follow from it (they are said in the app, not hidden):
//   - The app's service worker keeps CDN responses in the codemini-dynamic-* cache (sw.js, cache first). A library is "Ready offline" only when
//     EVERY file it needs is in that cache. Files that a CSS file or an ES module pulls in (fonts, sub-modules) are FOUND by reading the cached
//     entry file, not typed in here, so the list cannot drift from what the library really asks for.
//   - The RUNNER is a different origin and has no service worker of its own. When Isolation is on, Python, R, SQL, PHP, Ruby and the Markdown
//     preview run inside the runner and use only the browser's own HTTP cache, which the app can neither read nor fill. Those packages are shown
//     as "Runs in the runner" and are left out of the counts, and the header never says "Ready offline" while any of them is uncovered.
//   - Some libraries fetch more files the first time they are used (WebR's R runtime, PHP's engine, archive-wasm's decoders, Monaco's language
//     modules). Where the full list cannot be known, the package says so (coverage "entry" or "core") instead of claiming more than it knows.
//
// The pure rules (catalogue, crawlers, resolution, summary, filters) are exported for Node (tests/offline.test.js); the browser half (reading
// CacheStorage, downloading, the section and the drill-in) follows them.
(function (root) {
    'use strict';
    const W = root;

    // ---------------------------------------------------------------------------------------------
    // The caches (sw.js): the name below must match DYNAMIC_CACHE there (tests/offline.test.js compares them)
    // ---------------------------------------------------------------------------------------------
    const DYNAMIC_CACHE = 'codemini-dynamic-v1.10.000.9';
    const DYNAMIC_PREFIX = 'codemini-dynamic-', STATIC_PREFIX = 'codemini-static-';

    // ---------------------------------------------------------------------------------------------
    // The catalogue. Item shapes (a package's `files` is an all-of list):
    //   { u, kind }                    one file. kind: 'js' | 'wasm' | 'css' (its fonts are found) | 'esm' (its imports are found) | 'bin'
    //   { u, kind, optional: true }    wanted if the host has it, ignored if it answers 404
    //   { any: [ [items], [items] ] }  alternatives (the app tries a second CDN when the first fails): one complete alternative is enough
    // coverage: 'full' = every file is known; 'core' = the files needed to start are known, more load on use (Monaco languages);
    //           'entry' = only the entry file is known, the rest loads on first use (never shown as Ready).
    // global: the name a loaded copy defines on window, which is how "loaded this session but not saved" is told from "not loaded" (the browser's
    // resource list also records requests that FAILED, so it cannot be used).
    // surfaces: where the library runs when Isolation is on (runner-client modeFor): if ALL of them are isolated the app's cache does not
    // cover it. bundled: shipped inside the app itself (the static cache).
    // ---------------------------------------------------------------------------------------------
    const MONACO = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/vs/';
    const PYO = 'https://cdn.jsdelivr.net/pyodide/v0.24.1/full/';
    const SQLJS = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/';
    const OPAL = 'https://cdn.opalrb.com/opal/1.8.3/';
    const PDFJS = '3.11.174';
    const GROUPS = ['EDITOR', 'PYTHON NOTEBOOKS', 'R NOTEBOOKS', 'SQL', 'PHP', 'RUBY', 'DOCUMENTS AND PDF', 'ARCHIVES', 'GIT', 'ICONS AND FONTS'];

    const PACKAGES = [
        { id: 'monaco', name: 'Monaco Editor', group: 'EDITOR', version: '0.39.0', coverage: 'core', global: 'monaco',
          source: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/', prefixes: ['https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/'],
          files: [{ u: MONACO + 'loader.min.js', kind: 'js' }, { u: MONACO + 'editor/editor.main.js', kind: 'js' }, { u: MONACO + 'editor/editor.main.nls.js', kind: 'js' },
              { u: MONACO + 'editor/editor.main.css', kind: 'css' }, { u: MONACO + 'base/worker/workerMain.js', kind: 'js' }],
          neededBy: ['Every editor tab', 'The diff editor'], dependsOn: [],
          note: 'Language modules (HTML, CSS, TypeScript and others) download the first time a file of that language is opened.' },
        { id: 'emmet', name: 'Emmet for Monaco', group: 'EDITOR', version: '5.3.0', coverage: 'full',
          source: 'https://unpkg.com/emmet-monaco-es@5.3.0/', prefixes: ['https://unpkg.com/emmet-monaco-es@5.3.0/'],
          files: [{ u: 'https://unpkg.com/emmet-monaco-es@5.3.0/dist/emmet-monaco.min.js', kind: 'js' }],
          neededBy: ['HTML and CSS abbreviations in the editor'], dependsOn: ['monaco'] },
        { id: 'babel', name: 'Babel Standalone', group: 'EDITOR', version: '7.29.9', coverage: 'full',
          source: 'https://esm.sh/@babel/standalone@7.29.9', prefixes: ['https://esm.sh/@babel/standalone@7.29.9'],
          files: [{ u: 'https://esm.sh/@babel/standalone@7.29.9', kind: 'esm' }],
          neededBy: ['Live Preview of JSX and TypeScript'], dependsOn: [] },

        { id: 'pyodide', name: 'Pyodide', group: 'PYTHON NOTEBOOKS', version: '0.24.1', coverage: 'core', global: 'loadPyodide', surfaces: ['notebooks', 'console', 'terminal'],
          source: PYO, prefixes: ['https://cdn.jsdelivr.net/pyodide/v0.24.1/'],
          files: [{ u: PYO + 'pyodide.js', kind: 'js' }, { u: PYO + 'pyodide.asm.js', kind: 'js' }, { u: PYO + 'pyodide.asm.wasm', kind: 'wasm' }, { u: PYO + 'python_stdlib.zip', kind: 'bin' },
              { u: PYO + 'pyodide-lock.json', kind: 'bin', optional: true }, { u: PYO + 'repodata.json', kind: 'bin', optional: true }],
          neededBy: ['Python notebooks', 'The Console and Terminal (python)', 'Tasks and Test Explorer (python, pytest)', 'Run on a .py file'], dependsOn: [],
          note: 'Python packages you install (numpy, pandas and so on) are saved when they are first used and count as extra files.' },
        { id: 'webr', name: 'WebR', group: 'R NOTEBOOKS', version: '0.6.0', coverage: 'entry', surfaces: ['notebooks'],
          source: 'https://webr.r-wasm.org/v0.6.0/', prefixes: ['https://webr.r-wasm.org/v0.6.0/'],
          files: [{ u: 'https://webr.r-wasm.org/v0.6.0/webr.mjs', kind: 'esm' }],
          neededBy: ['R notebooks'], dependsOn: [],
          note: 'The R runtime (several large files) downloads the first time you run R. Run one R cell while online to save it.' },
        { id: 'sqljs', name: 'sql.js', group: 'SQL', version: '1.8.0', coverage: 'full', global: 'initSqlJs', surfaces: ['notebooks'],
          source: SQLJS, prefixes: [SQLJS],
          files: [{ u: SQLJS + 'sql-wasm.js', kind: 'js' }, { u: SQLJS + 'sql-wasm.wasm', kind: 'wasm' }],
          neededBy: ['SQL notebooks and the SQL scratchpad'], dependsOn: [] },
        { id: 'php', name: 'php-wasm', group: 'PHP', version: '0.1.0', coverage: 'entry', surfaces: ['preview', 'console', 'terminal'],
          source: 'https://www.npmjs.com/package/php-wasm/v/0.1.0', prefixes: ['https://unpkg.com/php-wasm@0.1.0/', 'https://cdn.jsdelivr.net/npm/php-wasm@0.1.0/'],
          files: [{ any: [[{ u: 'https://unpkg.com/php-wasm@0.1.0/PhpWeb.mjs', kind: 'esm' }], [{ u: 'https://cdn.jsdelivr.net/npm/php-wasm@0.1.0/PhpWeb.mjs', kind: 'esm' }]] }],
          neededBy: ['Run on a .php file', 'PHP in the Live Preview, Console and Terminal'], dependsOn: [],
          note: 'The PHP engine downloads the first time PHP runs. Run one PHP file while online to save it.' },
        { id: 'opal', name: 'Opal (Ruby)', group: 'RUBY', version: '1.8.3', coverage: 'full', global: 'Opal', surfaces: ['console', 'terminal'],
          source: OPAL, prefixes: [OPAL],
          files: ['opal.min.js', 'opal-parser.min.js', 'math.min.js', 'json.min.js', 'base64.min.js'].map((f) => ({ u: OPAL + f, kind: 'js' })),
          neededBy: ['Run on a .rb file', 'Ruby in the Console and Terminal'], dependsOn: [] },

        { id: 'marked', name: 'marked', group: 'DOCUMENTS AND PDF', version: '18.0.14', coverage: 'full', surfaces: ['preview', 'notebooks'],
          source: 'https://www.npmjs.com/package/marked/v/18.0.14', prefixes: ['https://cdn.jsdelivr.net/npm/marked@18.0.14/', 'https://esm.sh/marked@18.0.14'],
          files: [{ u: 'https://cdn.jsdelivr.net/npm/marked@18.0.14/lib/marked.umd.js', kind: 'js' },
              { any: [[{ u: 'https://esm.sh/marked@18.0.14', kind: 'esm' }], [{ u: 'https://cdn.jsdelivr.net/npm/marked@18.0.14/+esm', kind: 'esm' }]] }],
          neededBy: ['Markdown in the Live Preview and Mini Preview', 'Markdown cells in notebooks'], dependsOn: [] },
        { id: 'ghmd', name: 'GitHub Markdown CSS', group: 'DOCUMENTS AND PDF', version: '5.2.0', coverage: 'full', surfaces: ['preview'],
          source: 'https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.2.0/', prefixes: ['https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.2.0/'],
          files: [{ u: 'https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.2.0/github-markdown.min.css', kind: 'css' }],
          neededBy: ['The look of Markdown in the Live Preview and Mini Preview'], dependsOn: ['marked'] },
        { id: 'pdfjs', name: 'pdf.js', group: 'DOCUMENTS AND PDF', version: PDFJS, coverage: 'full',
          source: 'https://www.npmjs.com/package/pdfjs-dist/v/' + PDFJS, prefixes: ['https://esm.sh/pdfjs-dist@' + PDFJS, 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS + '/'],
          files: [{ any: [
              [{ u: 'https://esm.sh/pdfjs-dist@' + PDFJS, kind: 'esm' }, { u: 'https://esm.sh/pdfjs-dist@' + PDFJS + '/build/pdf.worker.min.js', kind: 'js' }],
              [{ u: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS + '/+esm', kind: 'esm' }, { u: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS + '/build/pdf.worker.min.js', kind: 'js' }]] }],
          neededBy: ['The PDF viewer'], dependsOn: [] },

        { id: 'jszip', name: 'JSZip', group: 'ARCHIVES', version: '3.10.1', coverage: 'full', global: 'JSZip',
          source: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/', prefixes: ['https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/'],
          files: [{ u: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', kind: 'js' }],
          neededBy: ['Uploading and downloading zip files'], dependsOn: [] },
        { id: 'fflate', name: 'fflate', group: 'ARCHIVES', version: '0.8.2', coverage: 'full',
          source: 'https://esm.sh/fflate@0.8.2', prefixes: ['https://esm.sh/fflate@0.8.2'],
          files: [{ u: 'https://esm.sh/fflate@0.8.2', kind: 'esm' }],
          neededBy: ['The Word, Excel and PowerPoint viewer'], dependsOn: [] },
        { id: 'archive-wasm', name: 'archive-wasm', group: 'ARCHIVES', version: '2.1.0', coverage: 'entry',
          source: 'https://esm.sh/archive-wasm@2.1.0', prefixes: ['https://esm.sh/archive-wasm@2.1.0'],
          files: [{ u: 'https://esm.sh/archive-wasm@2.1.0', kind: 'esm' }],
          neededBy: ['The archive viewer (7z, rar and other formats)'], dependsOn: [],
          note: 'The decoder (a WebAssembly file) downloads the first time an archive is opened. Open one while online to save it.' },

        { id: 'diff', name: 'jsdiff', group: 'GIT', version: '9.0.0', coverage: 'full', bundled: true,
          source: '', prefixes: [], files: [{ u: '/js/vendor/diff-9.0.0.js', kind: 'js' }],
          neededBy: ['The diff editor and Source Control'], dependsOn: [] },

        { id: 'remixicon', name: 'Remix Icon', group: 'ICONS AND FONTS', version: '3.5.0', coverage: 'full',
          source: 'https://cdn.jsdelivr.net/npm/remixicon@3.5.0/', prefixes: ['https://cdn.jsdelivr.net/npm/remixicon@3.5.0/'],
          files: [{ u: 'https://cdn.jsdelivr.net/npm/remixicon@3.5.0/fonts/remixicon.css', kind: 'css' }],
          neededBy: ['Almost every icon in the app'], dependsOn: [] },
        { id: 'fontawesome', name: 'Font Awesome', group: 'ICONS AND FONTS', version: '6.4.0', coverage: 'full',
          source: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/', prefixes: ['https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/'],
          files: [{ u: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css', kind: 'css' }],
          neededBy: ['Some icons in the app'], dependsOn: [] }
    ];
    const byId = (id) => PACKAGES.find((p) => p.id === id) || null;

    // ---------------------------------------------------------------------------------------------
    // Pure: what a cached CSS or module file pulls in
    // ---------------------------------------------------------------------------------------------
    function resolveUrl(spec, base) { try { return new URL(spec, base).href; } catch (e) { return null; } }

    // One font file per @font-face (the browser downloads the first format it supports: woff2, then woff, then the rest).
    function cssDeps(css, base) {
        const out = [];
        const faces = String(css).match(/@font-face\s*\{[^}]*\}/gi) || [];
        faces.forEach((face) => {
            const found = [];
            const re = /url\(\s*(["']?)([^)"']+)\1\s*\)(?:\s*format\(\s*(["']?)([^)"']+)\3\s*\))?/gi;
            let m;
            while ((m = re.exec(face))) { if (!/^data:/i.test(m[2])) found.push({ url: m[2], format: (m[4] || '').toLowerCase() }); }
            if (!found.length) return;
            const pick = found.find((f) => f.format === 'woff2') || found.find((f) => /woff2/i.test(f.url)) || found.find((f) => f.format === 'woff') || found[0];
            const abs = resolveUrl(pick.url, base);
            if (abs) out.push(abs);
        });
        return Array.from(new Set(out));
    }

    // Static imports of a module (`import "/x.mjs"`, `from "./y.mjs"`, `export * from "/z"`, `import("/w")`) that stay on the same host. esm.sh
    // and jsDelivr write them as absolute paths ("/v135/pkg@1/es2022/pkg.mjs"), so a path starting with "/" or "." is followed.
    function esmDeps(src, base) {
        const out = new Set();
        const re = /(?:\bfrom|\bimport|\bexport\s*\*\s*from)\s*\(?\s*["']((?:\/|\.\.?\/)[^"']+)["']/g;
        let m, host;
        try { host = new URL(base).host; } catch (e) { return []; }
        while ((m = re.exec(String(src)))) {
            const abs = resolveUrl(m[1], base);
            if (abs && new URL(abs).host === host) out.add(abs);
        }
        return Array.from(out);
    }

    // ---------------------------------------------------------------------------------------------
    // Pure: working out what a package needs and what of it is saved
    //   io: { has(url) -> Promise<bool>, text(url) -> Promise<string|null>, loaded(url) -> bool (fetched by this page, saved or not),
    //         avoid(url) -> bool (an address that failed to download just now: an alternative that uses it is chosen last) }
    // Returns { id, state, have, total, files: [{ url, cached, optional }], closureKnown, missing: [url] }
    //   state: 'ready' | 'partial' | 'session' (loaded this session but not saved) | 'none'
    // ---------------------------------------------------------------------------------------------
    const CRAWL_DEPTH = 3, CRAWL_MAX_FILES = 60;

    async function crawlLeaf(item, io, budget, depth) {
        const cached = !!(await io.has(item.u));
        const leaf = { url: item.u, cached, optional: !!item.optional };
        const leaves = [leaf];
        let closureKnown = true;
        if ((item.kind === 'css' || item.kind === 'esm') && !item.optional) {
            if (!cached) closureKnown = false;                          // what it pulls in is not known until it is saved
            else if (depth < CRAWL_DEPTH) {
                const text = await io.text(item.u);
                const deps = text == null ? [] : item.kind === 'css' ? cssDeps(text, item.u) : esmDeps(text, item.u);
                for (const u of deps) {
                    if (budget.n >= CRAWL_MAX_FILES) { closureKnown = false; break; }
                    if (leaves.some((l) => l.url === u) || budget.seen.has(u)) continue;
                    budget.seen.add(u); budget.n++;
                    const child = await crawlLeaf({ u, kind: item.kind === 'css' ? 'bin' : 'esm' }, io, budget, depth + 1);
                    child.leaves.forEach((l) => { if (!leaves.some((x) => x.url === l.url)) leaves.push(l); });
                    if (!child.closureKnown) closureKnown = false;
                }
            }
        }
        return { leaves, closureKnown };
    }

    async function resolveItems(items, io, budget) {
        let leaves = [], closureKnown = true;
        for (const item of items) {
            if (item.any) {
                let best = null;
                for (const alt of item.any) {
                    const r = await resolveItems(alt, io, { n: 0, seen: new Set() });
                    const req = r.leaves.filter((l) => !l.optional), have = req.filter((l) => l.cached).length;
                    const bad = !!io.avoid && alt.some((x) => x.u && io.avoid(x.u));     // an address that just failed to download
                    const complete = have === req.length && r.closureKnown;
                    const score = bad && !complete ? -1 : req.length ? have / req.length : 0;
                    if (!best || (complete && !best.complete) || (!best.complete && score > best.score)) best = { r, score, complete };
                }
                best.r.leaves.forEach((l) => { if (!leaves.some((x) => x.url === l.url)) leaves.push(l); });
                if (!best.complete) closureKnown = false;
            } else {
                const c = await crawlLeaf(item, io, budget, 0);
                c.leaves.forEach((l) => { if (!leaves.some((x) => x.url === l.url)) leaves.push(l); });
                if (!c.closureKnown) closureKnown = false;
            }
        }
        return { leaves, closureKnown };
    }

    async function resolvePackage(pkg, io) {
        const r = await resolveItems(pkg.files, io, { n: 0, seen: new Set() });
        const required = r.leaves.filter((l) => !l.optional);
        const have = required.filter((l) => l.cached).length, total = required.length;
        const anyCached = r.leaves.some((l) => l.cached);
        let state;
        if (!anyCached) state = r.leaves.some((l) => io.loaded && io.loaded(l.url)) ? 'session' : 'none';
        else if (have === total && r.closureKnown && pkg.coverage !== 'entry') state = 'ready';
        else state = 'partial';
        return { id: pkg.id, state, have, total, files: r.leaves, closureKnown: r.closureKnown, missing: r.leaves.filter((l) => !l.cached).map((l) => l.url) };
    }

    // What a download has to fetch: every file that is not saved (optional ones too: a 404 on those is fine).
    function downloadList(result) { return result ? result.missing.slice() : []; }

    // Only what belongs to a catalogued package may be removed: a file the package needs, or anything under one of its own addresses.
    function ownedBy(pkg, url, result) {
        if (result && result.files.some((l) => l.url === url)) return true;
        return (pkg.prefixes || []).some((p) => url.indexOf(p) === 0);
    }

    // ---------------------------------------------------------------------------------------------
    // Pure: the numbers in the section
    // ---------------------------------------------------------------------------------------------
    // surfaceMode(surface) -> 'runner' | 'normal' (CodeMiniRunner.modeFor). A package that runs ONLY in the runner (every surface isolated)
    // is not covered by the app's cache.
    function isRunnerOnly(pkg, surfaceMode) {
        if (!pkg.surfaces || !pkg.surfaces.length || typeof surfaceMode !== 'function') return false;
        return pkg.surfaces.every((s) => surfaceMode(s) === 'runner');
    }
    function effectiveState(pkg, result, surfaceMode, busy) {
        if (busy && busy.state) return busy.state;                       // 'loading' or 'failed' set by a download in progress or just finished
        if (isRunnerOnly(pkg, surfaceMode)) return 'runner';
        return result ? result.state : 'none';
    }

    function summarize(rows) {
        const c = { ready: 0, partial: 0, none: 0, session: 0, loading: 0, failed: 0, runner: 0 };
        rows.forEach((r) => { c[r.state] = (c[r.state] || 0) + 1; });
        const counted = rows.length - c.runner;
        const word = counted === 0 && c.runner === 0 ? 'Online only'
            : c.ready === counted && counted > 0 ? (c.runner > 0 ? 'Partly offline' : 'Ready offline')
            : (c.ready + c.partial + c.loading) > 0 ? 'Partly offline' : 'Online only';
        const tone = word === 'Ready offline' ? 'ok' : word === 'Partly offline' ? 'warn' : 'bad';
        return { counts: c, counted, ready: c.ready, runner: c.runner, word, tone };
    }

    const FILTERS = [{ id: 'all', label: 'All' }, { id: 'ready', label: 'Ready' }, { id: 'none', label: 'Not downloaded' }, { id: 'issues', label: 'Issues' }];
    function filterRows(rows, filter, query) {
        const q = String(query || '').trim().toLowerCase();
        return rows.filter((r) => {
            if (filter === 'ready' && r.state !== 'ready') return false;
            if (filter === 'none' && !(r.state === 'none' || r.state === 'session')) return false;
            if (filter === 'issues' && !(r.state === 'partial' || r.state === 'failed')) return false;
            if (q && (r.pkg.name + ' ' + r.pkg.group + ' ' + r.pkg.version + ' ' + hostOf(r.pkg)).toLowerCase().indexOf(q) === -1) return false;
            return true;
        });
    }
    function groupRows(rows) {
        return GROUPS.map((g) => ({ group: g, rows: rows.filter((r) => r.pkg.group === g) })).filter((g) => g.rows.length);
    }
    function hostOf(pkg) {
        if (pkg.bundled) return 'This app';
        const f = firstUrl(pkg.files);
        try { return new URL(f).host; } catch (e) { return ''; }
    }
    function firstUrl(items) {
        for (const it of items) { if (it.u) return it.u; if (it.any) { const u = firstUrl(it.any[0]); if (u) return u; } }
        return '';
    }

    // ---------------------------------------------------------------------------------------------
    // Pure: labels
    // ---------------------------------------------------------------------------------------------
    const STATE_ICON = {
        ready: { icon: 'ri-checkbox-circle-fill', tone: 'new', label: 'Ready offline' },
        session: { icon: 'ri-flashlight-fill', tone: 'blue', label: 'Loaded this session, not saved' },
        partial: { icon: 'ri-contrast-2-line', tone: 'yellow', label: 'Partly cached' },
        loading: { icon: 'ri-loader-4-line', tone: 'blue', label: 'Downloading' },
        none: { icon: 'ri-cloud-line', tone: 'muted', label: 'Not downloaded' },
        failed: { icon: 'ri-error-warning-line', tone: 'danger', label: 'Failed or blocked' },
        runner: { icon: 'ri-shield-check-line', tone: 'muted', label: 'Runs in the runner' }
    };
    function fmtBytes(b) {
        if (!(b > 0)) return '0 MB';
        if (b < 1048576) return b < 1024 ? b + ' B' : Math.max(1, Math.round(b / 1024)) + ' KB';
        const mb = b / 1048576;
        return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : (mb < 10 ? mb.toFixed(1) : String(Math.round(mb))) + ' MB';
    }
    function cacheVersion(names, prefix) {
        const n = (names || []).filter((k) => k.indexOf(prefix) === 0).sort().pop();
        return n ? n.slice(prefix.length) : '';
    }
    function slowConnection(c) {
        if (!c) return false;
        return !!c.saveData || /^(slow-2g|2g|3g)$/.test(String(c.effectiveType || ''));
    }
    function summaryText(sum) {
        return sum.ready + ' of ' + sum.counted + ' ready offline';
    }
    function leftLabel(missingPackages) {
        return missingPackages === 0 ? 'Everything is downloaded' : 'Download all for offline, ' + missingPackages + ' left';
    }

    const api = {
        DYNAMIC_CACHE, DYNAMIC_PREFIX, STATIC_PREFIX, PACKAGES, GROUPS, FILTERS, STATE_ICON, CRAWL_MAX_FILES,
        byId, cssDeps, esmDeps, resolvePackage, downloadList, ownedBy, isRunnerOnly, effectiveState, summarize, filterRows, groupRows, hostOf,
        fmtBytes, cacheVersion, slowConnection, summaryText, leftLabel
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof document === 'undefined') return; // Node: the rules only

    // ---------------------------------------------------------------------------------------------
    // Browser: reading the caches, downloading, removing
    // ---------------------------------------------------------------------------------------------
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const linkBtn = (text, label, onClick) => { const b = el('button', 'ni-link', text); b.type = 'button'; if (label) b.setAttribute('aria-label', label); b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); }); return b; };
    const hasCaches = () => typeof caches !== 'undefined' && !!caches && typeof caches.keys === 'function';
    const surfaceMode = (s) => { try { return W.CodeMiniRunner && W.CodeMiniRunner.modeFor ? W.CodeMiniRunner.modeFor(s) : 'normal'; } catch (e) { return 'normal'; } };
    const pkgOfUrl = (u) => PACKAGES.find((p) => ownedBy(p, u, null) || (p.bundled && p.files.some((f) => f.u === u))) || null;
    const io = {
        has: async (u) => { try { return !!(await caches.match(u)); } catch (e) { return false; } },
        text: async (u) => { try { const r = await caches.match(u); return r ? await r.clone().text() : null; } catch (e) { return null; } },
        loaded: (u) => { const p = pkgOfUrl(u); return !!(p && p.global && W[p.global]); },
        avoid: (u) => S.avoid.has(u)
    };
    async function cacheNames() { try { return hasCaches() ? await caches.keys() : []; } catch (e) { return []; } }
    async function dynamicName() { const n = (await cacheNames()).filter((k) => k.indexOf(DYNAMIC_PREFIX) === 0).sort().pop(); return n || DYNAMIC_CACHE; }

    const S = {
        results: new Map(),        // package id -> resolvePackage result
        extras: new Map(),         // package id -> [urls saved under its own addresses that its file list does not name]
        busy: new Map(),           // package id -> { state: 'loading', pct } | { state: 'failed', error }
        sizes: new Map(),          // url -> bytes
        skip: new Set(),           // optional files the host does not have (404)
        avoid: new Set(),          // addresses that failed to download in this attempt: the app's other CDN is tried instead
        filter: 'all', query: '', expanded: new Set(), confirm: null,
        controller: null, running: false, lastError: '', token: 0, storage: null, persisted: null, names: [], checkedMsg: ''
    };

    function rows() {
        return PACKAGES.map((pkg) => {
            const result = S.results.get(pkg.id) || null;
            return { pkg, result, state: effectiveState(pkg, result, surfaceMode, S.busy.get(pkg.id)), busy: S.busy.get(pkg.id) || null, extras: S.extras.get(pkg.id) || [] };
        });
    }
    const needsDownload = (r) => !r.pkg.bundled && r.state !== 'runner' && !!r.result && (r.result.have < r.result.total || !r.result.closureKnown);
    const missingCount = () => rows().filter(needsDownload).length;

    // Reads every package's state from the caches (and which cached files belong to which package), then redraws.
    async function refresh() {
        const mine = ++S.token;
        S.names = await cacheNames();
        const results = new Map();
        for (const pkg of PACKAGES) { results.set(pkg.id, await resolvePackage(pkg, io)); if (mine !== S.token) return; }
        const extras = new Map();
        try {
            const dyn = S.names.filter((k) => k.indexOf(DYNAMIC_PREFIX) === 0);
            for (const name of dyn) {
                const keys = await (await caches.open(name)).keys();
                keys.forEach((req) => {
                    const owner = PACKAGES.find((p) => ownedBy(p, req.url, null));
                    if (!owner || results.get(owner.id).files.some((l) => l.url === req.url)) return;
                    if (!extras.has(owner.id)) extras.set(owner.id, []);
                    extras.get(owner.id).push(req.url);
                });
            }
        } catch (e) { /* no cache access: extras stay empty */ }
        if (mine !== S.token) return;
        S.results = results; S.extras = extras;
        await readStorage();
        draw();
        if (viewOpen) measureAll();            // sizes of what is saved, a few at a time, while the list is on screen
    }

    async function readStorage() {
        try { S.storage = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (e) { S.storage = null; }
        try { S.persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch (e) { S.persisted = null; }
    }

    // ---- sizes (only while the drill-in is open: reading every saved file is not free) ----
    async function sizeOfUrl(url) {
        if (S.sizes.has(url)) return S.sizes.get(url);
        let n = 0;
        try {
            const r = await caches.match(url);
            if (r) {
                const cl = Number(r.headers.get('content-length'));
                if (cl > 0) n = cl;
                else if (r.body && r.body.getReader) { const rd = r.clone().body.getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.byteLength; } }
            }
        } catch (e) { n = 0; }
        S.sizes.set(url, n);
        return n;
    }
    async function measureAll() {
        for (const r of rows()) {
            if (!r.result) continue;
            const urls = r.result.files.filter((l) => l.cached).map((l) => l.url).concat(r.extras);
            let changed = false;
            for (const u of urls) { if (!S.sizes.has(u)) { await sizeOfUrl(u); changed = true; } }
            if (changed && viewOpen) drawView();
        }
    }
    const packageBytes = (r) => r.result ? r.result.files.filter((l) => l.cached).map((l) => l.url).concat(r.extras).reduce((n, u) => n + (S.sizes.get(u) || 0), 0) : 0;

    // ---- downloading ----
    async function fetchInto(url, signal) {
        const resp = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'reload', signal });
        if (!resp.ok) { const e = new Error('The host answered ' + resp.status); e.status = resp.status; throw e; }
        const keep = resp.clone();
        const cache = await caches.open(await dynamicName());
        const saved = cache.put(url, keep);
        if (resp.body && resp.body.getReader) { const rd = resp.body.getReader(); for (;;) { const { done } = await rd.read(); if (done) break; } } else await resp.arrayBuffer();
        await saved;
    }
    const friendly = (e) => e && e.name === 'AbortError' ? 'Stopped' : e && e.status ? e.message : (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'You are offline' : 'The host blocked it or could not be reached';

    // Saves whatever a package still needs. Files that a CSS or module file pulls in are only known once it is saved, so this goes round again
    // until nothing new turns up (at most four rounds).
    async function downloadOne(pkg, signal) {
        S.busy.set(pkg.id, { state: 'loading', pct: 0 });
        let done = 0, failed = '';
        for (let round = 0; round < 5 && !failed; round++) {
            const result = await resolvePackage(pkg, io);
            const list = downloadList(result).filter((u) => !S.skip.has(u));
            if (!list.length) break;
            for (const u of list) {
                if (signal.aborted) { failed = 'Stopped'; break; }
                const leaf = result.files.find((l) => l.url === u);
                try { await fetchInto(u, signal); done++; }
                catch (e) {
                    if (leaf && leaf.optional && e && e.status === 404) { S.skip.add(u); continue; }
                    if (e && e.name === 'AbortError') { failed = friendly(e); break; }
                    // The app tries a second CDN when the first fails (php-wasm, marked, pdf.js); so does this. If the package has no other
                    // way to get the file, it has failed.
                    S.avoid.add(u);
                    const again = await resolvePackage(pkg, io);
                    if (again.missing.includes(u)) { failed = friendly(e); break; }
                    break;                                                       // the other way is chosen on the next round
                }
                S.busy.set(pkg.id, { state: 'loading', pct: Math.min(95, Math.round(100 * done / (done + Math.max(0, list.length - done)))) });
                scheduleDraw();
            }
        }
        if (failed) S.busy.set(pkg.id, { state: 'failed', error: failed }); else S.busy.delete(pkg.id);
        return !failed;
    }
    async function downloadPackages(ids, opts) {
        if (S.running) return;
        if (typeof fetch !== 'function' || !hasCaches()) { S.lastError = 'This browser cannot save files for offline use.'; draw(); return; }
        S.running = true; S.controller = new AbortController(); S.lastError = ''; S.avoid.clear();
        let ok = 0, bad = 0;
        try {
            try {
                for (const id of ids) {
                    const pkg = byId(id); if (!pkg || pkg.bundled) continue;
                    if (opts && opts.redo) await removeOwned(pkg);
                    if (await downloadOne(pkg, S.controller.signal)) ok++; else bad++;
                    if (S.controller.signal.aborted) break;
                }
            } finally { S.controller = null; }
            await refresh();                      // the run is over only once the list shows what is really saved (no stale "Downloading")
        } finally { S.running = false; }
        if (bad === 0 && ok > 0 && typeof W.showSuccessToast === 'function') W.showSuccessToast(ok === 1 ? 'Saved for offline use' : ok + ' packages saved for offline use');
        if (bad) S.lastError = bad + (bad === 1 ? ' package' : ' packages') + ' could not be saved. Open one to see why.';
        draw();
    }
    function stopDownloads() { if (S.controller) S.controller.abort(); }

    // ---- removing: only what belongs to a catalogued package, and never the app shell's own cache ----
    async function removeOwned(pkg) {
        const result = S.results.get(pkg.id) || null;
        const names = (await cacheNames()).filter((k) => k.indexOf(DYNAMIC_PREFIX) === 0);
        let n = 0;
        for (const name of names) {
            const cache = await caches.open(name);
            for (const req of await cache.keys()) { if (ownedBy(pkg, req.url, result) && await cache.delete(req)) n++; }
        }
        S.busy.delete(pkg.id);
        return n;
    }
    async function removePackage(id) { const pkg = byId(id); if (!pkg || pkg.bundled) return 0; const n = await removeOwned(pkg); S.sizes.clear(); await refresh(); return n; }
    async function clearAll() {
        let n = 0;
        for (const pkg of PACKAGES) { if (!pkg.bundled) n += await removeOwned(pkg); }
        S.sizes.clear(); S.confirm = null; await refresh();
        return n;
    }

    // ---------------------------------------------------------------------------------------------
    // Browser: the section in the Now pane
    // ---------------------------------------------------------------------------------------------
    const NI = () => W.CodeMiniNowIsland || null;
    const COLLAPSE_KEY = 'codemini_offline_collapsed';
    const getCollapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (e) { return false; } };
    let ui = null, viewOpen = false, viewApi = null, drawQueued = false;

    function stateIcon(state, pct) {
        const d = STATE_ICON[state] || STATE_ICON.none;
        const i = el('i', d.icon + ' off-ico off-' + d.tone);
        i.setAttribute('role', 'img'); i.setAttribute('aria-label', d.label + (state === 'loading' && pct != null ? ' ' + pct + '%' : ''));
        i.title = d.label;
        return i;
    }
    const statusRow = (iconNode, textNodes, action, linePct, lineTone) => {
        const row = el('div', 'off-row');
        const main = el('div', 'off-row-main');
        const text = el('div', 'off-row-text'); textNodes.forEach((n) => text.appendChild(n));
        main.append(iconNode, text); if (action) main.appendChild(action);
        row.appendChild(main);
        if (linePct != null) { const line = el('div', 'off-line'); const fill = el('div', 'off-line-fill' + (lineTone ? ' ' + lineTone : '')); fill.style.width = Math.max(0, Math.min(100, linePct)) + '%'; line.appendChild(fill); row.appendChild(line); }
        return row;
    };

    function buildSection() {
        const root = el('div', 'ni-sec off-sec'); root.setAttribute('role', 'region'); root.setAttribute('aria-label', 'Offline and packages');
        const head = el('div', 'sb-section-header off-head');
        const toggle = el('button', 'off-toggle'); toggle.type = 'button';
        const chev = el('i', 'ri-arrow-down-s-line'); toggle.append(chev, el('span', null, 'OFFLINE AND PACKAGES'));
        const word = el('span', 'off-word');
        head.append(toggle, word);
        const body = el('div', 'off-body');
        root.append(head, body);
        toggle.addEventListener('click', () => { try { localStorage.setItem(COLLAPSE_KEY, getCollapsed() ? '0' : '1'); } catch (e) { /* not remembered */ } drawSection(); });
        ui = { root, toggle, chev, word, body };
        return ui;
    }

    function drawSection() {
        if (!ui) return;
        const rs = rows(), sum = summarize(rs), collapsed = getCollapsed();
        ui.word.textContent = sum.word; ui.word.className = 'off-word ' + sum.tone;
        ui.chev.className = collapsed ? 'ri-arrow-right-s-line' : 'ri-arrow-down-s-line';
        ui.toggle.setAttribute('aria-expanded', String(!collapsed));
        ui.body.hidden = collapsed;
        if (collapsed) return;
        ui.body.textContent = '';
        // Packages
        const pkgIcon = stateIcon(sum.tone === 'ok' ? 'ready' : sum.tone === 'warn' ? 'partial' : 'none');
        const t1 = [el('span', 'off-main-text', summaryText(sum))];
        if (sum.runner) t1.push(el('span', 'off-sub', sum.runner + (sum.runner === 1 ? ' runs' : ' run') + ' in the isolated runner, which this does not cover'));
        const manage = linkBtn('Manage', 'Manage offline packages', () => openView());
        ui.body.appendChild(statusRow(pkgIcon, t1, manage, sum.counted ? 100 * sum.ready / sum.counted : 0));
        // Storage
        const est = S.storage, used = est && est.usage || 0, quota = est && est.quota || 0, pct = quota ? 100 * used / quota : 0;
        const unprotected = S.persisted === false && W.CodeMiniAlerts && W.CodeMiniAlerts.canProtectStorage && W.CodeMiniAlerts.canProtectStorage();
        const stText = est ? fmtBytes(used) + ' of ' + fmtBytes(quota) + ' used' : 'Storage use is not available in this browser';
        const prot = unprotected ? linkBtn('Protect storage', 'Ask the browser to keep this storage', async () => { try { await W.CodeMiniAlerts.protectStorage(); } finally { await readStorage(); draw(); } }) : null;
        const stRow = statusRow(el('i', unprotected ? 'ri-error-warning-line off-ico off-yellow' : 'ri-hard-drive-2-line off-ico off-muted'), [el('span', 'off-main-text', stText)].concat(unprotected ? [el('span', 'off-sub', 'Not protected: the browser may clear it when space runs low')] : []), prot, est ? pct : null, pct > 90 ? 'danger' : pct > 75 ? 'yellow' : 'blue');
        if (unprotected) stRow.classList.add('warn');
        ui.body.appendChild(stRow);
        // App
        const pwa = W.CodeMiniPWA, standalone = !!(pwa && pwa.isStandalone && pwa.isStandalone());
        const ver = cacheVersion(S.names, STATIC_PREFIX);
        const sw = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? (navigator.serviceWorker.controller ? 'Service worker active' + (ver ? ', ' + ver : '') : 'Service worker not controlling this page yet') : 'Service workers are not supported here';
        const install = !standalone && pwa && pwa.canInstall && pwa.canInstall() ? linkBtn('Install', 'Install CodeMini as an app', async () => { try { await pwa.install(); } finally { draw(); } }) : null;
        ui.body.appendChild(statusRow(el('i', (standalone ? 'ri-checkbox-circle-fill off-new' : 'ri-smartphone-line off-muted') + ' off-ico'), [el('span', 'off-main-text', standalone ? 'Installed as app' : 'Not installed as an app'), el('span', 'off-sub', sw)], install, null));
    }

    // ---------------------------------------------------------------------------------------------
    // Browser: the drill-in (the island's slide-over view)
    // ---------------------------------------------------------------------------------------------
    let V = null;   // { list, search, seg, foot, footMsg }
    function openView() {
        const n = NI(); if (!n) return;
        n.openView({
            title: 'Offline and packages', label: 'Offline and packages',
            build: (content) => {
                viewOpen = true;
                const toolbar = el('div', 'off-toolbar');
                const seg = el('div', 'sb-segmented'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Show');
                FILTERS.forEach((f) => { const b = el('button', 'sb-seg', f.label); b.type = 'button'; b.dataset.offFilter = f.id; b.addEventListener('click', () => { S.filter = f.id; drawView(); }); seg.appendChild(b); });
                const search = el('input', 'off-search'); search.type = 'text'; search.placeholder = 'Search'; search.setAttribute('aria-label', 'Search packages'); search.value = S.query;
                search.addEventListener('input', () => { S.query = search.value; drawView(true); });
                toolbar.append(seg, search);
                const list = el('div', 'off-scroll');
                const foot = el('div', 'off-foot');
                content.append(toolbar, list, foot);
                V = { content, toolbar, seg, search, list, foot };
                drawView();
                refresh().then(() => measureAll());
                return () => { viewOpen = false; V = null; S.confirm = null; };
            }
        });
    }

    function sectionHeader(label, count) {
        const h = el('div', 'sb-section-header off-group'); const left = el('span'); left.appendChild(document.createTextNode(label));
        if (count != null) left.appendChild(el('span', 'sb-count-badge', String(count)));
        h.appendChild(left); return h;
    }
    const kv = (k, v, action) => { const r = el('div', 'off-kv'); r.append(el('span', 'off-k', k), el('span', 'off-v', v)); if (action) r.appendChild(action); return r; };
    const fmtWhen = (t) => t ? new Date(t).toLocaleString() : 'Not yet this session';

    function appBlock() {
        const frag = document.createDocumentFragment();
        frag.appendChild(sectionHeader('THIS APP'));
        const pwa = W.CodeMiniPWA, standalone = !!(pwa && pwa.isStandalone && pwa.isStandalone());
        const mode = standalone ? 'Standalone window' : 'Browser tab';
        frag.appendChild(kv('Installed', standalone ? 'Yes' : 'No', !standalone && pwa && pwa.canInstall && pwa.canInstall() ? linkBtn('Install', 'Install CodeMini as an app', async () => { try { await pwa.install(); } finally { draw(); } }) : null));
        frag.appendChild(kv('Display mode', mode));
        S.names.filter((k) => k.indexOf('codemini-') === 0).forEach((name) => frag.appendChild(kv('Cache', name)));
        const st = pwa && pwa.getUpdateState ? pwa.getUpdateState() : {};
        const check = linkBtn(S.checking ? 'Checking' : 'Check for updates', 'Check for an app update', async () => {
            if (!pwa || !pwa.checkForUpdates || S.checking) return;
            S.checking = true; drawView();
            try { const r = await pwa.checkForUpdates(); S.checkedMsg = r === 'up-to-date' ? 'Up to date' : r === 'updated' ? 'An update is ready' : r === 'unsupported' ? 'Not supported here' : 'Checked'; }
            catch (e) { S.checkedMsg = 'Could not check'; }
            S.checking = false; drawView();
        });
        frag.appendChild(kv('Last checked', (S.checkedMsg ? S.checkedMsg + '. ' : '') + fmtWhen(st.lastChecked), check));
        return frag;
    }

    function listItems(title, items, nameOf) {
        const wrap = el('div', 'off-rel'); wrap.appendChild(el('div', 'off-rel-title', title));
        const ul = el('ul', 'off-rel-list');
        items.forEach((x) => ul.appendChild(el('li', null, nameOf ? nameOf(x) : x)));
        wrap.appendChild(ul); return wrap;
    }

    function packageRow(r) {
        const { pkg, result, state, busy } = r;
        const open = S.expanded.has(pkg.id);
        const li = el('div', 'off-pkg' + (open ? ' open' : '')); li.dataset.pkg = pkg.id;
        const main = el('button', 'off-pkg-main'); main.type = 'button'; main.setAttribute('aria-expanded', String(open));
        main.setAttribute('aria-label', pkg.name + ', ' + (STATE_ICON[state] || STATE_ICON.none).label);
        const text = el('span', 'off-pkg-text');
        const l1 = el('span', 'off-pkg-l1'); l1.append(el('span', 'off-pkg-name', pkg.name), el('span', 'off-pill', pkg.version));
        const files = result && result.total ? result.have + ' of ' + result.total + ' files' : '';
        text.append(l1, el('span', 'off-pkg-l2', [hostOf(pkg), files].filter(Boolean).join(' · ')));
        const bytes = packageBytes(r);
        main.append(stateIcon(state, busy && busy.pct), text, el('span', 'off-pkg-size', bytes ? fmtBytes(bytes) : ''), el('i', open ? 'ri-arrow-up-s-line off-chev' : 'ri-arrow-down-s-line off-chev'));
        main.addEventListener('click', () => { if (open) S.expanded.delete(pkg.id); else S.expanded.add(pkg.id); drawView(true); });
        li.appendChild(main);
        if (state === 'loading') { const line = el('div', 'off-line'); const f = el('div', 'off-line-fill'); f.style.width = (busy.pct || 3) + '%'; line.appendChild(f); li.appendChild(line); }
        if (!open) return li;
        const d = el('div', 'off-detail');
        if (state === 'loading') d.appendChild(el('div', 'off-note', 'Downloading ' + (busy.pct || 0) + '%'));
        if (state === 'failed') d.appendChild(el('div', 'off-note danger', busy.error || 'It could not be saved.'));
        if (state === 'runner') d.appendChild(el('div', 'off-note', 'Isolation is on, so this runs inside the runner: a separate site with no service worker of its own. This app cannot see or fill the runner\u2019s cache, so it is not counted here. The browser\u2019s own cache may keep it between visits, but that cannot be checked from here. In Same origin mode (Settings > Security) the files below are used.'));
        if (state === 'session') d.appendChild(el('div', 'off-note', 'It was loaded in this session but is not saved on this device (the service worker may not be controlling this page yet). Download it to keep a copy.'));
        if (pkg.bundled) d.appendChild(el('div', 'off-note', 'Part of the app itself. It is saved with the app shell and works offline once the app has been installed by the browser.'));
        if (pkg.note && state !== 'runner') d.appendChild(el('div', 'off-note', pkg.note));
        if (result && !result.closureKnown && state !== 'none' && state !== 'runner') d.appendChild(el('div', 'off-note', 'Some of the files it pulls in are not known until the main file is saved.'));
        if (r.extras.length) d.appendChild(el('div', 'off-note', '+' + r.extras.length + (r.extras.length === 1 ? ' more file' : ' more files') + ' saved while you used it'));
        // Needed by / Depends on, joined by dashed connectors
        const rel = el('div', 'off-rels');
        rel.appendChild(listItems('Needed by', pkg.neededBy));
        if (pkg.dependsOn.length) rel.appendChild(listItems('Depends on', pkg.dependsOn, (id) => { const p = byId(id); return p ? p.name + ' ' + p.version : id; }));
        d.appendChild(rel);
        if (result && result.files.length) {
            const fl = el('details', 'off-files'); fl.appendChild(el('summary', null, 'Files (' + result.files.length + ')'));
            const ul = el('ul', 'off-file-list');
            result.files.forEach((l) => { const li2 = el('li', l.cached ? 'cached' : ''); li2.append(el('i', l.cached ? 'ri-checkbox-circle-fill off-new' : 'ri-cloud-line off-muted'), el('span', null, l.url.replace(/^https?:\/\//, '') + (l.optional ? ' (optional)' : ''))); ul.appendChild(li2); });
            fl.appendChild(ul); d.appendChild(fl);
        }
        // Actions
        const act = el('div', 'off-actions');
        const cached = !!(result && (result.files.some((l) => l.cached) || r.extras.length));
        if (!pkg.bundled && state !== 'runner') {
            const online = typeof navigator === 'undefined' || navigator.onLine !== false;
            if (state !== 'ready' && state !== 'loading') { const b = linkBtn(state === 'failed' ? 'Retry' : 'Download now', 'Download ' + pkg.name, () => downloadPackages([pkg.id])); if (!online || S.running) b.disabled = true; act.appendChild(b); }
            if (cached && state !== 'loading') { const b = linkBtn('Re-download', 'Download ' + pkg.name + ' again', () => downloadPackages([pkg.id], { redo: true })); if (!online || S.running) b.disabled = true; act.appendChild(b); }
            if (cached && state !== 'loading') {
                if (S.confirm && S.confirm.kind === 'remove' && S.confirm.id === pkg.id) {
                    act.append(el('span', 'off-confirm-text', 'Remove it?'), linkBtn('Remove', 'Confirm: remove ' + pkg.name + ' from the cache', async () => { S.confirm = null; await removePackage(pkg.id); }), linkBtn('Cancel', 'Cancel', () => { S.confirm = null; drawView(true); }));
                } else { const b = linkBtn('Remove from cache', 'Remove ' + pkg.name + ' from the cache', () => { S.confirm = { kind: 'remove', id: pkg.id }; drawView(true); }); b.classList.add('danger'); act.appendChild(b); }
            }
        }
        if (pkg.source) act.appendChild(linkBtn('Open source', 'Open the ' + pkg.name + ' page', () => { try { W.open(pkg.source, '_blank', 'noopener'); } catch (e) { /* popup blocked */ } }));
        d.appendChild(act);
        li.appendChild(d);
        return li;
    }

    function drawView(keepScroll) {
        if (!V) return;
        const rs = rows();
        V.seg.querySelectorAll('.sb-seg').forEach((b) => b.classList.toggle('active', b.dataset.offFilter === S.filter));
        const prevTop = V.list.scrollTop;
        V.list.textContent = '';
        V.list.appendChild(appBlock());
        const shown = filterRows(rs, S.filter, S.query);
        if (!shown.length) V.list.appendChild(el('div', 'off-empty', S.query || S.filter !== 'all' ? 'No packages match' : 'No packages'));
        groupRows(shown).forEach((g) => {
            V.list.appendChild(sectionHeader(g.group, g.rows.length));
            g.rows.forEach((r) => V.list.appendChild(packageRow(r)));
        });
        V.list.scrollTop = prevTop;
        drawFooter(rs);
    }

    function drawFooter(rs) {
        const left = rs.filter(needsDownload).length, online = typeof navigator === 'undefined' || navigator.onLine !== false;
        V.foot.textContent = '';
        if (S.lastError) V.foot.appendChild(el('div', 'off-foot-msg danger', S.lastError));
        if (!online) V.foot.appendChild(el('div', 'off-foot-msg', 'You are offline. Downloads need a connection.'));
        const row = el('div', 'off-foot-row');
        if (S.running) {
            const stop = el('button', 'ni-btn primary', 'Stop downloading'); stop.type = 'button'; stop.addEventListener('click', stopDownloads); row.appendChild(stop);
        } else if (S.confirm && S.confirm.kind === 'slow') {
            V.foot.appendChild(el('div', 'off-foot-msg', 'You are on a slow or data-saver connection, and these files are large. Download anyway?'));
            const go = el('button', 'ni-btn primary', 'Download'); go.type = 'button'; go.addEventListener('click', () => { S.confirm = null; downloadPackages(rows().filter(needsDownload).map((r) => r.pkg.id)); });
            row.append(go, linkBtn('Cancel', 'Cancel', () => { S.confirm = null; drawView(true); }));
        } else {
            const all = el('button', 'ni-btn primary', leftLabel(left)); all.type = 'button'; all.disabled = left === 0 || !online;
            all.addEventListener('click', () => {
                if (slowConnection(navigator.connection)) { S.confirm = { kind: 'slow' }; drawView(true); return; }
                downloadPackages(rows().filter(needsDownload).map((r) => r.pkg.id));
            });
            row.appendChild(all);
            if (S.confirm && S.confirm.kind === 'clear') {
                row.append(el('span', 'off-confirm-text', 'Clear all saved packages?'), linkBtn('Clear', 'Confirm: clear all saved packages', async () => { await clearAll(); }), linkBtn('Cancel', 'Cancel', () => { S.confirm = null; drawView(true); }));
            } else {
                const clear = linkBtn('Clear cached data', 'Clear the saved packages', () => { S.confirm = { kind: 'clear' }; drawView(true); }); clear.classList.add('danger'); row.appendChild(clear);
            }
        }
        V.foot.appendChild(row);
    }

    function scheduleDraw() { if (drawQueued) return; drawQueued = true; (W.requestAnimationFrame || ((f) => setTimeout(f, 16)))(() => { drawQueued = false; draw(); }); }
    function draw() { drawSection(); if (viewOpen) drawView(true); }

    // ---------------------------------------------------------------------------------------------
    // Start-up
    // ---------------------------------------------------------------------------------------------
    function init() {
        const n = NI(); if (!n) return;
        buildSection();
        n.mount(ui.root, 40, { always: true });
        n.onOpen(() => refresh());
        W.addEventListener('online', draw); W.addEventListener('offline', draw);
        refresh();
    }
    init();

    W.CodeMiniOffline = Object.freeze({
        refresh, rows, openView, download: (ids, opts) => downloadPackages(ids, opts), stop: stopDownloads, removePackage, clearAll,
        summary: () => summarize(rows()), state: () => ({ running: S.running, filter: S.filter, query: S.query, skipped: Array.from(S.skip) })
    });
})(typeof window !== 'undefined' ? window : globalThis);
