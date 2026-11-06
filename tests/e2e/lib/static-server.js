// Minimal dependency-free static file server used by the e2e runner.
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
};

// opts.headers: extra response headers (the runner test sends the same frame-ancestors header production does).
function createServer(root, opts) {
  const extra = (opts && opts.headers) || {};
  return http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // With MONACO_DIR set (see lib/monaco-local.js) /__monaco__/ serves a real Monaco, including the bootstrap for its web
    // worker: a blob worker's own requests cannot be intercepted by the browser tool, so the worker needs a real URL.
    if (rel.startsWith('/__monaco__/') && process.env.MONACO_DIR) {
      const sub = rel.slice('/__monaco__/'.length);
      if (sub === 'worker-loader.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }).end("self.MonacoEnvironment = { baseUrl: '/__monaco__/' };\nimportScripts('/__monaco__/vs/base/worker/workerMain.js');"); return; }
      const mf = path.join(process.env.MONACO_DIR, path.normalize(sub));
      if (!mf.startsWith(process.env.MONACO_DIR)) { res.writeHead(403).end(); return; }
      fs.readFile(mf, (err, data) => { if (err) { res.writeHead(404).end(); return; } res.writeHead(200, { 'Content-Type': TYPES[path.extname(mf)] || 'application/octet-stream' }).end(data); });
      return;
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(root, path.normalize(rel));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('Not found'); return; }
      res.writeHead(200, Object.assign({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, extra));
      res.end(data);
    });
  });
}
module.exports = { createServer };
