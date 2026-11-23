// Offline and Packages' pure rules (js/core/offline.js), the catalogue against what the app really loads, and how it is wired in. The browser
// half (CacheStorage, downloads, the section, the drill-in) is covered in a real browser by tests/e2e/offline.e2e.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const O = require('../js/core/offline.js');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let n = 0; const t = (name, fn) => Promise.resolve().then(fn).then(() => { n++; console.log('  ok', name); });

const mk = (files, loaded) => ({ has: async (u) => Object.prototype.hasOwnProperty.call(files, u), text: async (u) => (u in files ? files[u] : null), loaded: (u) => (loaded || []).includes(u) });
const flat = (items) => items.flatMap((i) => (i.u ? [i.u] : i.any.flat().flatMap((a) => (a.u ? [a.u] : flat([a])))));

(async () => {
console.log('the catalogue');
await t('ids are unique, groups are known, and every package says what needs it', () => {
  const ids = O.PACKAGES.map((p) => p.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  O.PACKAGES.forEach((p) => {
    assert.ok(O.GROUPS.includes(p.group), p.id + ' group ' + p.group);
    assert.ok(['full', 'core', 'entry'].includes(p.coverage), p.id + ' coverage');
    assert.ok(p.neededBy.length > 0 && p.name && p.version, p.id + ' text');
    p.dependsOn.forEach((d) => assert.ok(O.byId(d), p.id + ' depends on a package that exists: ' + d));
    (p.surfaces || []).forEach((s) => assert.ok(['preview', 'notebooks', 'console', 'terminal'].includes(s), p.id + ' surface ' + s));
  });
  O.GROUPS.forEach((g) => assert.ok(O.PACKAGES.some((p) => p.group === g), 'group ' + g + ' has a package'));
});
await t('"loaded" is told by a global the library defines, and every such name is a plain identifier', () => {
  const withGlobal = O.PACKAGES.filter((p) => p.global).map((p) => p.id);
  assert.deepStrictEqual(withGlobal, ['monaco', 'pyodide', 'sqljs', 'opal', 'jszip']);
  O.PACKAGES.filter((p) => p.global).forEach((p) => assert.ok(/^[A-Za-z_$][\w$]*$/.test(p.global), p.id));
  assert.ok(!/getEntriesByType|PerformanceResourceTiming/.test(read('js/core/offline.js').replace(/\/\/.*$/gm, '')), 'not the resource list: it records failed requests too');
});
await t('a file\'s address carries the version the package says it is (so the label cannot drift from the file)', () => {
  O.PACKAGES.filter((p) => !p.bundled).forEach((p) => flat(p.files).forEach((u) => {
    assert.ok(/^https:\/\//.test(u), u + ' is https');
    assert.ok(u.indexOf(p.version) > -1, p.id + ' ' + p.version + ' is in ' + u);
  }));
  const diff = O.byId('diff'); assert.ok(diff.bundled && /^\//.test(diff.files[0].u) && diff.files[0].u.indexOf('9.0.0') > -1);
  assert.ok(fs.existsSync(path.join(root, diff.files[0].u)), 'the bundled file is really in the app');
});
await t('every CDN address the app loads is in the catalogue (a new library cannot be missing from this list)', () => {
  const files = ['index.html'];
  (function walk(d) { fs.readdirSync(path.join(root, d), { withFileTypes: true }).forEach((e) => {
    const rel = path.join(d, e.name);
    if (e.isDirectory()) { if (!/vendor|node_modules/.test(e.name)) walk(rel); } else if (/\.js$/.test(e.name) && !/^(mini-preview|offline)\.js$/.test(e.name)) files.push(rel);
  }); })('js');
  const runner = path.join(root, '..', 'codemini-runner', 'exec.js');
  const texts = files.map((f) => read(f)); if (fs.existsSync(runner)) texts.push(fs.readFileSync(runner, 'utf8'));
  const hosts = /https:\/\/(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|esm\.sh|webr\.r-wasm\.org|cdn\.opalrb\.com)[^"'` )<>,;\\]*/g;
  const found = new Set();
  texts.forEach((txt) => (txt.match(hosts) || []).forEach((u) => {
    u = u.replace(/\$\{PDFJS_VERSION\}/g, '3.11.174');
    if (u.indexOf('${') > -1 || /\/X\/?$/.test(u)) return;           // a template with a variable part is not a fixed address
    found.add(u);
  }));
  assert.ok(found.size >= 20, 'the scan found the app\'s CDN addresses (' + found.size + ')');
  const covered = (u) => O.PACKAGES.some((p) => (p.prefixes || []).some((pre) => u.indexOf(pre) === 0) || flat(p.files).includes(u));
  const missing = Array.from(found).filter((u) => !covered(u));
  assert.deepStrictEqual(missing, [], 'add these to the catalogue in js/core/offline.js: ' + missing.join(', '));
});
await t('the cache name matches sw.js, and the app files are precached in the static cache', () => {
  assert.strictEqual(/const DYNAMIC_CACHE = '([^']+)'/.exec(read('sw.js'))[1], O.DYNAMIC_CACHE, 'DYNAMIC_CACHE in sw.js');
  assert.ok(/'codemini-static-v/.test(read('sw.js')) && O.STATIC_PREFIX === 'codemini-static-' && O.DYNAMIC_PREFIX === 'codemini-dynamic-');
  assert.ok(read('sw.js').includes("'/js/vendor/diff-9.0.0.js'"), 'the bundled package is really precached');
});

console.log('what a CSS or module file pulls in');
await t('CSS: one font file per @font-face, woff2 first, data: ignored, relative to the CSS file', () => {
  const css = '@font-face{src:url(../webfonts/a.woff2) format("woff2"),url(../webfonts/a.ttf) format("truetype")}'
    + '@font-face{src:url("b.woff?t=9") format("woff"),url("b.ttf") format("truetype")}'
    + '@font-face{src:url(data:font/woff2;base64,AAAA) format("woff2")}'
    + '@font-face{src:url(c.ttf)}';
  assert.deepStrictEqual(O.cssDeps(css, 'https://h.test/x/css/all.css'), ['https://h.test/x/webfonts/a.woff2', 'https://h.test/x/css/b.woff?t=9', 'https://h.test/x/css/c.ttf']);
  assert.deepStrictEqual(O.cssDeps('body{}', 'https://h.test/a.css'), []);
});
await t('modules: absolute and relative imports on the same host are followed; other hosts and bare names are not', () => {
  const src = 'import"/v135/a.mjs";export*from"/v135/b.mjs";import x from"./c.mjs";import("/d.mjs");import y from "https://evil.test/x.js";import z from "lodash";';
  assert.deepStrictEqual(O.esmDeps(src, 'https://esm.sh/pkg@1'), ['https://esm.sh/v135/a.mjs', 'https://esm.sh/v135/b.mjs', 'https://esm.sh/c.mjs', 'https://esm.sh/d.mjs']);
  assert.deepStrictEqual(O.esmDeps('x', 'not a url'), []);
});

console.log('working out what is saved');
const FA = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/', FACSS = '@font-face{src:url(../webfonts/s.woff2) format("woff2")}@font-face{src:url(../webfonts/b.woff2) format("woff2")}';
await t('nothing saved is "none"; the CSS alone is "partial" with its fonts still missing; all of it is "ready"', async () => {
  const fa = O.byId('fontawesome');
  assert.strictEqual((await O.resolvePackage(fa, mk({}))).state, 'none');
  let r = await O.resolvePackage(fa, mk({ [FA + 'css/all.min.css']: FACSS }));
  assert.deepStrictEqual([r.state, r.have, r.total, r.missing], ['partial', 1, 3, [FA + 'webfonts/s.woff2', FA + 'webfonts/b.woff2']]);
  r = await O.resolvePackage(fa, mk({ [FA + 'css/all.min.css']: FACSS, [FA + 'webfonts/s.woff2']: '', [FA + 'webfonts/b.woff2']: '' }));
  assert.deepStrictEqual([r.state, r.have, r.total, r.missing.length], ['ready', 3, 3, 0]);
});
await t('a file the CSS is not saved yet is "partial", not "ready": its fonts are not known', async () => {
  const r = await O.resolvePackage(O.byId('remixicon'), mk({}));
  assert.strictEqual(r.closureKnown, false);
  const r2 = await O.resolvePackage(O.byId('remixicon'), mk({ 'https://cdn.jsdelivr.net/npm/remixicon@3.5.0/fonts/remixicon.css': '@font-face{src:url("remixicon.woff2?t=1") format("woff2")}' }));
  assert.strictEqual(r2.state, 'partial'); assert.ok(r2.missing[0].endsWith('remixicon.woff2?t=1'));
});
await t('module sub-files are found by reading the saved entry, and followed down a few levels', async () => {
  const B = 'https://esm.sh/fflate@0.8.2';
  const all = { [B]: 'export*from"/v1/a.mjs"', 'https://esm.sh/v1/a.mjs': 'import"/v1/b.mjs"', 'https://esm.sh/v1/b.mjs': 'export default 1' };
  let r = await O.resolvePackage(O.byId('fflate'), mk({ [B]: all[B] }));
  assert.deepStrictEqual([r.state, r.missing], ['partial', ['https://esm.sh/v1/a.mjs']]);
  r = await O.resolvePackage(O.byId('fflate'), mk(all));
  assert.deepStrictEqual([r.state, r.have, r.total], ['ready', 3, 3]);
});
await t('the crawl is capped, and a cap that cuts it short means "not known", never "ready"', async () => {
  const B = 'https://esm.sh/fflate@0.8.2', files = { [B]: Array.from({ length: 200 }, (_, i) => 'import"/m' + i + '.mjs";').join('') };
  for (let i = 0; i < 200; i++) files['https://esm.sh/m' + i + '.mjs'] = '';
  const r = await O.resolvePackage(O.byId('fflate'), mk(files));
  assert.ok(r.total <= O.CRAWL_MAX_FILES + 1 && r.closureKnown === false && r.state === 'partial');
});
await t('alternatives: either CDN\'s complete copy is enough; a half copy of one beats nothing of the other', async () => {
  const M = 'https://cdn.jsdelivr.net/npm/marked@18.0.14/lib/marked.umd.js';
  let r = await O.resolvePackage(O.byId('marked'), mk({ [M]: '', 'https://cdn.jsdelivr.net/npm/marked@18.0.14/+esm': 'export default 1' }));
  assert.deepStrictEqual([r.state, r.have, r.total], ['ready', 2, 2], 'the second CDN served it');
  r = await O.resolvePackage(O.byId('marked'), mk({ [M]: '', 'https://esm.sh/marked@18.0.14': 'export default 1' }));
  assert.strictEqual(r.state, 'ready', 'the first CDN served it');
  r = await O.resolvePackage(O.byId('marked'), mk({ [M]: '' }));
  assert.deepStrictEqual([r.state, r.have, r.total], ['partial', 1, 2]);
  const pdf = O.byId('pdfjs'), w = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  r = await O.resolvePackage(pdf, mk({ [w]: '', 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/+esm': '' }));
  assert.strictEqual(r.state, 'ready', 'a library and ITS OWN worker, from the same CDN');
  r = await O.resolvePackage(pdf, mk({ [w]: '', 'https://esm.sh/pdfjs-dist@3.11.174': '' }));
  assert.strictEqual(r.state, 'partial', 'the library from one CDN and the worker from the other is not a working pair');
});
await t('an address that just failed is avoided: the other CDN is chosen next, and a file with no other way stays on the list', async () => {
  const a = 'https://unpkg.com/php-wasm@0.1.0/PhpWeb.mjs', b = 'https://cdn.jsdelivr.net/npm/php-wasm@0.1.0/PhpWeb.mjs';
  const io = Object.assign(mk({}), { avoid: (u) => u === a });
  let r = await O.resolvePackage(O.byId('php'), mk({}));
  assert.deepStrictEqual(r.missing, [a], 'the first alternative is the default');
  r = await O.resolvePackage(O.byId('php'), io);
  assert.deepStrictEqual(r.missing, [b], 'after unpkg failed, jsDelivr');
  r = await O.resolvePackage(O.byId('php'), Object.assign(mk({ [a]: '' }), { avoid: (u) => u === a }));
  assert.strictEqual(r.have, 1, 'but a copy that is already saved is kept, whatever failed before');
  const lone = 'https://cdn.jsdelivr.net/npm/marked@18.0.14/lib/marked.umd.js';
  r = await O.resolvePackage(O.byId('marked'), Object.assign(mk({}), { avoid: (u) => u === lone }));
  assert.ok(r.missing.includes(lone), 'a file with no alternative is still wanted');
});
await t('optional files never hold a package back, and a package whose full list is unknown is never "ready"', async () => {
  const P = 'https://cdn.jsdelivr.net/pyodide/v0.24.1/full/';
  const base = { [P + 'pyodide.js']: '', [P + 'pyodide.asm.js']: '', [P + 'pyodide.asm.wasm']: '', [P + 'python_stdlib.zip']: '' };
  let r = await O.resolvePackage(O.byId('pyodide'), mk(base));
  assert.deepStrictEqual([r.state, r.have, r.total], ['ready', 4, 4], 'without the optional lock file');
  assert.ok(r.missing.includes(P + 'pyodide-lock.json'), 'but it is still on the download list (a 404 is fine)');
  r = await O.resolvePackage(O.byId('webr'), mk({ 'https://webr.r-wasm.org/v0.6.0/webr.mjs': 'export default 1' }));
  assert.strictEqual(r.state, 'partial', 'WebR: the R runtime is not known, so it cannot be "ready"');
  r = await O.resolvePackage(O.byId('archive-wasm'), mk({ 'https://esm.sh/archive-wasm@2.1.0': 'export default 1' }));
  assert.strictEqual(r.state, 'partial');
});
await t('loaded this session but not saved is its own state', async () => {
  const u = 'https://cdn.jsdelivr.net/pyodide/v0.24.1/full/pyodide.js';
  assert.strictEqual((await O.resolvePackage(O.byId('pyodide'), mk({}, [u]))).state, 'session');
  assert.strictEqual((await O.resolvePackage(O.byId('pyodide'), mk({}, []))).state, 'none');
});
await t('what a download fetches is exactly what is missing; removal only touches what a package owns', async () => {
  const py = O.byId('pyodide'), r = await O.resolvePackage(py, mk({ 'https://cdn.jsdelivr.net/pyodide/v0.24.1/full/pyodide.js': '' }));
  assert.deepStrictEqual(O.downloadList(r), r.missing); assert.strictEqual(r.missing.length, 5);
  assert.ok(O.ownedBy(py, 'https://cdn.jsdelivr.net/pyodide/v0.24.1/full/numpy-1.25.2.whl', null), 'a Python package saved while using it');
  ['/index.html', '/js/core/app.js', 'https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js', 'https://example.test/pyodide/v0.24.1/', 'https://api.github.com/user']
    .forEach((u) => O.PACKAGES.forEach((p) => assert.ok(!O.ownedBy(p, u, null), u + ' is not owned by ' + p.id)));
  assert.ok(O.PACKAGES.every((p) => p.bundled ? p.prefixes.length === 0 : p.prefixes.every((x) => /^https:\/\/[^/]+\/.+/.test(x))), 'every address a package owns names a host and a path');
});

console.log('the numbers');
const row = (id, state) => ({ pkg: O.byId(id), state });
await t('the header word: Ready offline, Partly offline, Online only', () => {
  const all = (s) => O.PACKAGES.map((p) => ({ pkg: p, state: s }));
  assert.deepStrictEqual([O.summarize(all('ready')).word, O.summarize(all('ready')).tone], ['Ready offline', 'ok']);
  assert.deepStrictEqual([O.summarize(all('none')).word, O.summarize(all('none')).tone], ['Online only', 'bad']);
  const some = all('none'); some[0].state = 'ready';
  assert.deepStrictEqual([O.summarize(some).word, O.summarize(some).tone], ['Partly offline', 'warn']);
  const part = all('none'); part[3].state = 'partial'; assert.strictEqual(O.summarize(part).word, 'Partly offline');
  assert.strictEqual(O.summarize([]).word, 'Online only');
});
await t('packages that run only in the runner are left out of the count, and stop the header saying "Ready offline"', () => {
  const rs = O.PACKAGES.map((p) => ({ pkg: p, state: p.surfaces && p.surfaces.every((s) => s === 'notebooks' || s === 'console' || s === 'terminal' || s === 'preview') ? 'runner' : 'ready' }));
  const s = O.summarize(rs);
  assert.ok(s.runner > 0 && s.counted === rs.length - s.runner && s.ready === s.counted);
  assert.strictEqual(s.word, 'Partly offline', 'everything the app can cover is ready, yet part of the app is not covered');
  assert.strictEqual(O.summaryText({ ready: 12, counted: 12 }), '12 of 12 ready offline');
});
await t('which packages the runner hides: only when EVERY surface they run on is isolated', () => {
  const py = O.byId('pyodide'), allRunner = () => 'runner', allNormal = () => 'normal', mixed = (s) => (s === 'notebooks' ? 'normal' : 'runner');
  assert.ok(O.isRunnerOnly(py, allRunner)); assert.ok(!O.isRunnerOnly(py, allNormal)); assert.ok(!O.isRunnerOnly(py, mixed), 'notebooks run in the page, so the app cache matters');
  assert.ok(!O.isRunnerOnly(O.byId('monaco'), allRunner), 'the editor always runs in the app');
  assert.ok(!O.isRunnerOnly(py, undefined));
  assert.strictEqual(O.effectiveState(py, { state: 'ready' }, allRunner), 'runner');
  assert.strictEqual(O.effectiveState(py, { state: 'ready' }, allNormal), 'ready');
  assert.strictEqual(O.effectiveState(py, { state: 'ready' }, allNormal, { state: 'loading', pct: 5 }), 'loading', 'a download in progress wins');
  assert.strictEqual(O.effectiveState(py, null, allNormal), 'none');
});
await t('filters and search, and the groups come out in the spec\'s order with empty ones left out', () => {
  const rs = [row('monaco', 'ready'), row('pyodide', 'none'), row('webr', 'partial'), row('sqljs', 'failed'), row('opal', 'session'), row('php', 'runner')];
  assert.strictEqual(O.filterRows(rs, 'all', '').length, 6);
  assert.deepStrictEqual(O.filterRows(rs, 'ready', '').map((r) => r.pkg.id), ['monaco']);
  assert.deepStrictEqual(O.filterRows(rs, 'none', '').map((r) => r.pkg.id), ['pyodide', 'opal']);
  assert.deepStrictEqual(O.filterRows(rs, 'issues', '').map((r) => r.pkg.id), ['webr', 'sqljs']);
  assert.deepStrictEqual(O.filterRows(rs, 'all', ' PYO ').map((r) => r.pkg.id), ['pyodide'], 'by name, any case');
  assert.deepStrictEqual(O.filterRows(rs, 'all', 'r notebooks').map((r) => r.pkg.id), ['webr'], 'by group');
  assert.deepStrictEqual(O.filterRows(rs, 'all', 'cdn.opalrb').map((r) => r.pkg.id), ['opal'], 'by host');
  assert.deepStrictEqual(O.groupRows(rs).map((g) => g.group), ['EDITOR', 'PYTHON NOTEBOOKS', 'R NOTEBOOKS', 'SQL', 'PHP', 'RUBY']);
  assert.strictEqual(O.hostOf(O.byId('diff')), 'This app'); assert.strictEqual(O.hostOf(O.byId('php')), 'unpkg.com');
});
await t('labels: sizes, cache versions, slow connections, the download button', () => {
  assert.deepStrictEqual([0, 500, 2048, 5 * 1048576, 86 * 1048576, 1.2 * 1073741824].map(O.fmtBytes), ['0 MB', '500 B', '2 KB', '5.0 MB', '86 MB', '1.2 GB']);
  assert.strictEqual(O.cacheVersion(['codemini-dynamic-v1.10.000.9', 'codemini-static-v1.6.0', 'other'], 'codemini-static-'), 'v1.6.0');
  assert.strictEqual(O.cacheVersion([], 'codemini-static-'), '');
  assert.ok(O.slowConnection({ saveData: true }) && O.slowConnection({ effectiveType: '3g' }) && O.slowConnection({ effectiveType: '2g' }));
  assert.ok(!O.slowConnection({ effectiveType: '4g' }) && !O.slowConnection(null) && !O.slowConnection(undefined));
  assert.strictEqual(O.leftLabel(5), 'Download all for offline, 5 left'); assert.strictEqual(O.leftLabel(0), 'Everything is downloaded');
  assert.deepStrictEqual(Object.keys(O.STATE_ICON).sort(), ['failed', 'loading', 'none', 'partial', 'ready', 'runner', 'session']);
  assert.strictEqual(O.STATE_ICON.ready.icon, 'ri-checkbox-circle-fill'); assert.strictEqual(O.STATE_ICON.session.icon, 'ri-flashlight-fill');
  assert.strictEqual(O.STATE_ICON.partial.icon, 'ri-contrast-2-line'); assert.strictEqual(O.STATE_ICON.none.icon, 'ri-cloud-line');
  assert.strictEqual(O.STATE_ICON.failed.icon, 'ri-error-warning-line'); assert.strictEqual(O.STATE_ICON.loading.icon, 'ri-loader-4-line');
});

console.log('wiring');
await t('the script loads after the Now Island, is precached, and is in npm test', () => {
  const html = read('index.html');
  assert.ok(html.indexOf('js/core/offline.js') > html.indexOf('js/core/now-island.js'));
  assert.ok(read('sw.js').includes("'/js/core/offline.js'"));
  assert.ok(JSON.parse(read('package.json')).scripts.test.includes('tests/offline.test.js'));
});
await t('it mounts at order 40, and uses the island\'s own slide-over (not a modal)', () => {
  const src = read('js/core/offline.js'), ni = read('js/core/now-island.js');
  assert.ok(/n\.mount\(ui\.root, 40\)/.test(src) && /n\.openView\(\{/.test(src));
  assert.ok(/openView: openCustomView/.test(ni) && /ni-viewer-custom/.test(ni));
  assert.ok(/onOpen:/.test(ni), 'the section re-reads the caches whenever the island opens');
  assert.ok(/e\.target\.isConnected === false\) return;/.test(ni), 'a click on a row the panel re-drew is not an outside click');
});
await t('it never builds markup from text, and only ever deletes from the dynamic caches', () => {
  const src = read('js/core/offline.js').replace(/\/\/.*$/gm, '');
  assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new Function/.test(src));
  assert.ok(!/caches\.delete\(/.test(src), 'no whole-cache deletion: the app shell cache is never touched');
  assert.strictEqual((src.match(/cache\.delete\(/g) || []).length, 1, 'one place removes entries');
  assert.ok(/names = \(await cacheNames\(\)\)\.filter\(\(k\) => k\.indexOf\(DYNAMIC_PREFIX\) === 0\)/.test(src) && /ownedBy\(pkg, req\.url, result\)/.test(src), 'and only dynamic-cache entries a package owns');
  assert.ok(/if \(!pkg \|\| pkg\.bundled\) return 0/.test(src), 'the bundled package cannot be removed');
});
await t('every class the module uses has a rule in style.css, and the theme packs know the new pills', () => {
  const src = read('js/core/offline.js'), css = read('css/style.css'), ni = read('js/core/now-island.js');
  const used = new Set(); (src.match(/['"`](off-[a-z0-9-]+)/g) || []).forEach((m) => used.add(m.slice(1)));
  (src.match(/el\('[a-z0-9]+', '([^']+)'/g) || []).forEach((m) => m.split("'")[3].split(' ').filter((c) => c.indexOf('off-') === 0).forEach((c) => used.add(c)));
  const free = new Set(['off-new', 'off-blue', 'off-yellow', 'off-muted', 'off-danger', 'off-tone']);   // colour classes, written as .off-ico.off-new
  const missing = Array.from(used).filter((c) => !css.includes('.' + c) && !ni.includes('.' + c) && !free.has(c) && c !== 'off-filter' && c !== 'off-').filter((c) => !/^off-(muted|new|blue|yellow|danger)$/.test(c));
  assert.deepStrictEqual(missing, [], 'classes without a rule: ' + missing.join(', '));
  const th = read('css/themes.css');
  ['.off-pill', '.off-line', '.off-line-fill'].forEach((s) => assert.ok(th.includes('"codemini-premium"] ' + s), s));
  assert.ok(/input\.off-search\[type="text"\] \{\s*border-radius: 0 !important/.test(th), 'the flat search keeps square ends (selector as specific as the pack\'s own text-input rule)');
});

console.log(n + ' offline checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
