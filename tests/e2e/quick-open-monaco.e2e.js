// Quick Open's go-to-line against a REAL Monaco (tests/e2e/quick-open.e2e.js can only use a stand-in editor, so it proves
// the right line was asked for, not that the editor goes there). Needs MONACO_DIR (see lib/monaco-local.js); without it
// this reports SKIP and passes.
const { chromium } = require('playwright');
const monacoLocal = require('./lib/monaco-local');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  if (!monacoLocal.available()) { console.log('  SKIP quick-open against a real Monaco (needs MONACO_DIR)'); console.log('\n0 passed, 0 failed, 1 skipped (no MONACO_DIR)'); return; }
  let pass = 0, fail = 0;
  const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort()); await monacoLocal.install(page);
  await page.goto('http://localhost:8765/index.html'); await sleep(6500);
  const ev = (f, a) => page.evaluate(f, a);
  const lines = Array.from({ length: 120 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n';
  await ev(async (lines) => {
    await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); const s = tx.objectStore('filesystem'); s.put({ id: 'f1', parentId: 'root', name: 'long.txt', type: 'file', content: lines, timestamp: Date.now() }); s.put({ id: 'f2', parentId: 'root', name: 'other.txt', type: 'file', content: lines, timestamp: Date.now() }); tx.oncomplete = res; });
    handleFileClick({ id: 'f1', parentId: 'root', name: 'long.txt', type: 'file', content: lines }, document.createElement('div'));
  }, lines);
  await sleep(2500);
  const pos = () => ev(() => { const e = getActiveMonacoEditor(); const p = e.getPosition(); const vr = e.getVisibleRanges()[0]; return { line: p.lineNumber, col: p.column, visibleFrom: vr.startLineNumber, visibleTo: vr.endLineNumber }; });
  const quick = async (text) => { await page.keyboard.press('Control+P'); await sleep(400); await page.fill('.top-center .search-bar input', text); await sleep(400); await page.keyboard.press('Enter'); await sleep(900); };

  console.log('\n[go to line in the real editor]');
  await quick(':42');
  let p = await pos(); ok(p.line === 42 && p.col === 1, '":42" puts the cursor on line 42', p);
  ok(p.visibleFrom <= 42 && p.visibleTo >= 42 && p.visibleFrom > 1, 'and scrolls it into view (the editor really moved)', p);
  await quick(':100:4'); p = await pos(); ok(p.line === 100 && p.col === 4, '":100:4" sets line and column', p);
  await quick(':9999'); p = await pos(); ok(p.line === 121 || p.line === 120, 'a line past the end lands on the last line instead of failing', p);
  await quick(':1'); p = await pos(); ok(p.line === 1 && p.visibleFrom === 1, '":1" goes back to the top', p);
  ok(await ev(() => { const a = document.activeElement; return !!a && !!document.querySelector('.tab.active') && getActiveMonacoEditor().hasTextFocus(); }), 'and the editor has the keyboard focus again');

  console.log('\n[name:line opens another file at a line]');
  await quick('other.txt:77');
  await sleep(1200);
  const other = await ev(() => { const e = getActiveMonacoEditor(); const t = document.querySelector('.tab.active'); return { tab: t.dataset.fileId, line: e.getPosition().lineNumber }; });
  ok(other.tab === 'f2' && other.line === 77, '"other.txt:77" opens that file and goes to line 77', other);

  const rel = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|importScripts|\[object Event\]/i.test(e));
  ok(rel.length === 0, 'no unexpected page errors', rel);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
