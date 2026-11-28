// Opens the app in a fresh browser context for an e2e test: Monaco stubbed, the service worker blocked, external requests either faked (the CDNs) or
// refused, and optionally Same origin mode (no runner), a phone, or a locale. Shared by offline.e2e.js and extensions.e2e.js.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = 'http://localhost:8765';
const CORS = { 'access-control-allow-origin': '*' };

// What each fake CDN file looks like. Small, valid, and shaped like the real thing where the app reads it (CSS with @font-face, modules with imports).
function bodyFor(url) {
  if (/\.css$/.test(url) && /font-awesome/.test(url)) return { type: 'text/css', body: '@font-face{font-family:a;src:url(../webfonts/fa-solid-900.woff2) format("woff2"),url(../webfonts/fa-solid-900.ttf) format("truetype")}@font-face{font-family:b;src:url(../webfonts/fa-brands-400.woff2) format("woff2")}' };
  if (/remixicon\.css$/.test(url)) return { type: 'text/css', body: '@font-face{font-family:r;src:url("remixicon.woff2?t=1") format("woff2"),url("remixicon.ttf?t=1") format("truetype")}' };
  if (/\.css$/.test(url)) return { type: 'text/css', body: 'body{}' };
  if (/esm\.sh\/(@babel|fflate|archive|marked)/.test(url)) return { type: 'text/javascript', body: 'export*from"/v1/dep.mjs";' };
  if (/\.mjs$|esm\.sh|\+esm/.test(url)) return { type: 'text/javascript', body: 'export default 1;' };
  if (/\.wasm$/.test(url)) return { type: 'application/wasm', body: 'wasm-bytes-' + 'x'.repeat(2000) };
  return { type: 'text/javascript', body: '/* stub for ' + url.slice(-40) + ' */\n' + '// '.padEnd(300, '-') };
}

// opts: { normal, phone, locale, fakeCdn (default true), clock: Date }
async function openApp(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext(Object.assign({ serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] }, opts.locale ? { locale: opts.locale } : {},
    opts.phone ? { viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 900 } }));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => { if (!(opts.ignoreErrors && opts.ignoreErrors.test(e.message))) errors.push(e.message); });
  await page.addInitScript((normal) => {
    if (location.port === '8765' && normal) localStorage.setItem('codemini_runner', 'off');
    window.__codeminiKeepAuto = false;   // no automatic top-up of kept components behind the test's back (the explicit call still works)
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); }; window.require.config = () => {};
  }, !!opts.normal);
  const hits = {}, fails = {};
  await page.route(/^https?:\/\/(?!localhost)/, async (route) => {
    const url = route.request().url(); hits[url] = (hits[url] || 0) + 1;
    if (opts.fakeCdn === false) return route.abort();
    const key = Object.keys(fails).find((k) => url.indexOf(k) > -1), f = key ? fails[key] : null;
    if (f === 'abort') return route.abort();
    if (f === 404) return route.fulfill({ status: 404, headers: CORS, body: 'not found' });
    if (f && f.delay) await sleep(f.delay);
    if (/\/webfonts\/|\.woff2|\.ttf/.test(url)) return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'font/woff2' }, CORS), body: 'fontbytes' });
    if (/\/v1\/dep\.mjs$/.test(url)) return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'text/javascript' }, CORS), body: 'export default 2;' });
    const b = bodyFor(url);
    return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': b.type, 'content-length': String(Buffer.byteLength(b.body)) }, CORS), body: b.body });
  });
  if (opts.clock) await page.clock.install({ time: opts.clock });
  await page.goto(APP + '/index.html'); await sleep(3500);
  return { ctx, page, errors, hits, fails };
}
module.exports = { openApp, sleep, APP, CORS };
