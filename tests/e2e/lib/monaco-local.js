// Serve a real Monaco to the app instead of the CDN (which the test browser cannot reach), so tests can exercise the
// real editor: set MONACO_DIR to a monaco-editor package's `min` folder, for example
//   cd /tmp && npm install monaco-editor@0.39.0 && MONACO_DIR=/tmp/node_modules/monaco-editor/min node tests/e2e/run.js diff
// Without it, tests that need a real editor say so and skip those checks; the rest use a stub.
// Open the test's browser context with serviceWorkers: 'block' when using this: the app's service worker fetches Monaco
// itself after a reload, and a route cannot intercept that, so the editor would fail to load on the second page load.
const fs = require('fs'), path = require('path');
const BASE = /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/monaco-editor\/0\.39\.0\/min\/(.+?)(\?.*)?$/;
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.json': 'application/json', '.svg': 'image/svg+xml' };
function available() { return !!(process.env.MONACO_DIR && fs.existsSync(path.join(process.env.MONACO_DIR, 'vs', 'loader.js'))); }
// page: the Playwright page. Registered on the page AFTER any "abort external requests" rule (the latest route wins) and
// on its context too, because Monaco's web workers fetch their scripts through the context's routes.
async function install(page) {
  const dir = process.env.MONACO_DIR;
  const handler = (route) => {
    let rel = route.request().url().match(BASE)[1];
    if (rel === 'vs/loader.min.js') rel = 'vs/loader.js';
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file), headers: { 'access-control-allow-origin': '*' } });
  };
  await page.context().route(BASE, handler);
  await page.route(BASE, handler);
  // Monaco's web worker is a blob that fetches its own script, and the browser tool cannot intercept a worker's requests
  // (they fail, and Monaco's diff then never completes). Monaco's own hook points the worker at the test server instead.
  await page.addInitScript(() => { window.MonacoEnvironment = { getWorkerUrl: () => '/__monaco__/worker-loader.js' }; });
}
module.exports = { available, install };
