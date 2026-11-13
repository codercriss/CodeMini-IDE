// Download > ZIP: (1) in tree view, selecting a folder also selects its contents, and the archive must not hold them twice;
// (2) JSZip must really become available even though Monaco's AMD loader has defined window.define.
// Runs the real selectionRoots(), ZIP builder loop and loadJSZip() from js/core/up-down.js with fakes - no browser.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'js/core/up-down.js'), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

const i = src.indexOf('function selectionRoots('), j = src.indexOf('async function handleDownloadZip');
assert(i > -1 && j > i, 'cannot find selectionRoots in up-down.js');
const ctx = vm.createContext({});
vm.runInContext(src.slice(i, j), ctx);
const roots = (sel, all) => Array.from(ctx.selectionRoots(sel, all), (x) => x.id);

const F = (id, name, parentId, type = 'file') => ({ id, name, parentId, type });
const all = [F('src', 'src', 'root', 'folder'), F('lib', 'lib', 'src', 'folder'), F('a', 'a.js', 'src'), F('b', 'b.js', 'lib'), F('top', 'top.js', 'root'), F('ws', 'ws', 'root', 'workspace'), F('c', 'c.js', 'ws')];
const byId = Object.fromEntries(all.map((x) => [x.id, x]));
const pick = (...ids) => new Set(ids.map((id) => byId[id]));

console.log('selectionRoots');
t('a ticked folder with its ticked contents keeps only the folder', () => assert.deepStrictEqual(roots(pick('src', 'lib', 'a', 'b'), all), ['src']));
t('Select all in tree view keeps only the top-level items', () => assert.deepStrictEqual(roots(pick('src', 'lib', 'a', 'b', 'top', 'ws', 'c'), all), ['src', 'top', 'ws']));
t('files ticked inside an unticked folder are kept (their folder is not selected)', () => assert.deepStrictEqual(roots(pick('a', 'b'), all), ['a', 'b']));
t('a file in a folder that is itself inside a ticked folder is skipped at any depth', () => assert.deepStrictEqual(roots(pick('src', 'b'), all), ['src']));
t('a workspace counts as a folder', () => assert.deepStrictEqual(roots(pick('ws', 'c'), all), ['ws']));
t('the same record twice (two objects, one id) is one item', () => assert.deepStrictEqual(roots(new Set([{ ...byId.top }, byId.top]), all), ['top']));
t('an empty selection, and a record whose parent is missing', () => {
  assert.deepStrictEqual(roots(new Set(), all), []);
  assert.deepStrictEqual(roots(pick('top'), [F('top', 'top.js', 'gone')]), ['top']);
});
t('a parent loop cannot hang it', () => assert.deepStrictEqual(roots(new Set([F('x', 'x', 'y')]), [F('x', 'x', 'y'), F('y', 'y', 'x', 'folder')]), ['x']));

console.log('the archive');
// The wiring: the real buildZip loop from handleDownloadZip, run on a fake JSZip that records the paths it is given.
const k = src.indexOf('    let lockedSkipped = 0;', j), l = src.indexOf('    try {\n        const content = await zip.generateAsync', k);
assert(k > -1 && l > k, 'cannot find the ZIP builder in up-down.js');
const body = src.slice(k, l);
assert(/selectionRoots\(downloadSelectedFiles, allFiles\)\.forEach/.test(body), 'handleDownloadZip must build from selectionRoots(...)');
function zipPaths(selected) {
  const paths = [];
  const node = (prefix) => ({ folder: (name) => node(prefix + name + '/'), file: (name) => paths.push(prefix + name) });
  const run = new vm.Script('(function (zip, allFiles, downloadSelectedFiles, selectionRoots) {' + body + '})');
  run.runInContext(ctx)(node(''), all, selected, ctx.selectionRoots);
  return paths.sort();
}
t('Select all: every file appears once, in its folder, and nothing extra at the top', () => assert.deepStrictEqual(zipPaths(pick('src', 'lib', 'a', 'b', 'top', 'ws', 'c')), ['src/a.js', 'src/lib/b.js', 'top.js', 'ws/c.js']));
t('a folder ticked with its contents has no top-level copies', () => assert.ok(!zipPaths(pick('src', 'lib', 'a', 'b')).some((p) => p === 'a.js' || p === 'b.js')));

console.log('loading JSZip next to Monaco\'s AMD loader');
const a = src.indexOf('const JSZIP_URL'), b = src.indexOf('async function handleDownloadZip');
assert(a > -1 && b > a, 'cannot find loadJSZip in up-down.js');
const loaderCode = src.slice(a, b);
// JSZip 3.10.1's wrapper, as shipped: CommonJS, then AMD, then a plain global.
const UMD = '!function(e){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=e();else if("function"==typeof define&&define.amd)define([],e);else{("undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof self?self:this).JSZip=e()}}(function(){return function JSZip(){this.isFake=true}});';
function page(opts = {}) {
  const win = { fetchCalls: [], defineCalls: 0 };
  win.window = win;
  win.define = function () { win.defineCalls++; }; win.define.amd = {}; // what Monaco's loader leaves on the page
  const responses = (opts.responses || [{ ok: true, text: UMD }]).slice();
  win.fetch = (url, init) => { win.fetchCalls.push({ url, init }); const r = responses.length > 1 ? responses.shift() : responses[0]; return r.reject ? Promise.reject(new Error(r.reject)) : Promise.resolve({ ok: r.ok, status: r.status || 200, text: () => Promise.resolve(r.text) }); };
  const ctx = vm.createContext(win);
  // A page that runs an inline <script>'s text when it is put in the head, as a browser does.
  win.document = { createElement: () => ({ remove() {} }), head: { appendChild: (el) => { win.scriptsRun = (win.scriptsRun || 0) + 1; try { vm.runInContext(el.textContent, ctx); } catch (e) { /* a script that throws only reports an error event */ } } } };
  vm.runInContext(loaderCode + '\nwindow.loadJSZip = loadJSZip;', ctx);
  return win;
}
const tn = async (name, fn) => { await fn(); n++; console.log('  ok', name); };
(async () => {
  await tn('the cause: with define.amd on the page, JSZip\'s wrapper registers as an AMD module and no global appears', () => {
    const w = { defineCalls: 0 }; w.window = w; w.define = function () { w.defineCalls++; }; w.define.amd = {};
    vm.runInContext(UMD, vm.createContext(w));
    assert.strictEqual(w.defineCalls, 1); assert.strictEqual(w.JSZip, undefined);
  });
  await tn('loadJSZip makes the global JSZip appear in that same situation', async () => {
    const w = page(); const Z = await w.loadJSZip();
    assert.strictEqual(typeof Z, 'function'); assert.strictEqual(w.JSZip, Z); assert.ok(new Z().isFake);
  });
  await tn('it leaves window.define alone (Monaco keeps working) and never registers an AMD module', async () => {
    const w = page(); const before = w.define; await w.loadJSZip();
    assert.strictEqual(w.define, before); assert.strictEqual(w.define.amd !== undefined, true); assert.strictEqual(w.defineCalls, 0);
    assert.strictEqual(w.exports, undefined); assert.strictEqual(w.module, undefined);
  });
  await tn('it asks for the pinned 3.10.1 file in CORS mode without credentials (so the service worker can cache it)', async () => {
    const w = page(); await w.loadJSZip();
    assert.strictEqual(w.fetchCalls[0].url, 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
    assert.strictEqual(w.fetchCalls[0].init.mode, 'cors'); assert.strictEqual(w.fetchCalls[0].init.credentials, 'omit');
  });
  await tn('two clicks while it loads share one download, and later calls reuse the global', async () => {
    const w = page(); const [x, y] = await Promise.all([w.loadJSZip(), w.loadJSZip()]); await w.loadJSZip();
    assert.strictEqual(x, y); assert.strictEqual(w.fetchCalls.length, 1);
  });
  await tn('a failed load (offline) can be retried and then works', async () => {
    const w = page({ responses: [{ reject: 'Failed to fetch' }, { ok: true, text: UMD }] });
    await assert.rejects(() => w.loadJSZip(), /Failed to fetch/);
    assert.strictEqual(typeof (await w.loadJSZip()), 'function'); assert.strictEqual(w.fetchCalls.length, 2);
  });
  await tn('an HTTP error, or a file that does not make JSZip, is an error and not a silent success', async () => {
    await assert.rejects(() => page({ responses: [{ ok: false, status: 404, text: '' }] }).loadJSZip(), /HTTP 404/);
    await assert.rejects(() => page({ responses: [{ ok: true, text: 'var x = 1;' }] }).loadJSZip(), /did not start/);
  });
  await tn('the loader adds no code-execution sink (the exec-sinks ratchet counts new Function / eval lines)', () => {
    assert.ok(!/new Function\s*\(|\beval\s*\(/.test(src.replace(/\/\/.*$/gm, '')), 'up-down.js must stay free of eval and new Function');
  });
  await tn('handleDownloadZip uses it, reports a failed load and a failed build, and downloads through the safe helper', () => {
    const h = src.slice(b);
    assert.ok(/await loadJSZip\(\)/.test(h) && /new JSZipLib\(\)/.test(h), 'must take JSZip from loadJSZip()');
    assert.ok(!/createElement\('script'\)/.test(h) && !/typeof JSZip === 'undefined'/.test(h), 'the plain script-tag load is what failed');
    assert.ok(/notifyZipFailed\(/.test(h) && /triggerBlobDownload\(content/.test(h));
    assert.ok(/revokeObjectURL\(url\)/.test(src.slice(src.indexOf('function triggerBlobDownload'), b)) && /setTimeout/.test(src.slice(src.indexOf('function triggerBlobDownload'), b)), 'the blob URL must not be revoked straight after the click');
  });
  console.log(`\n${n} zip-selection checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
