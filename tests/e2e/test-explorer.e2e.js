// Test Explorer (feature 18) in the real app with a real IndexedDB. The isolated runner is not available here (it is a second origin on the network),
// so window.CodeMiniExec is replaced by a stand-in that runs the program the explorer builds, for JavaScript, the way the host does (an async function,
// console.* captured line by line). Python is not run here: tests/real-pyodide-tests.manual.js does that on a real Pyodide.
// Monaco is stubbed in this harness, so the editor glyphs cannot be seen here; their decorations are covered by the unit tests' wiring checks.
// The icon font is blocked in this harness (no network), so icon-only buttons have no size: they are clicked through the DOM.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const NOISE = /monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i;

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { setTimeout(() => { window.monaco = mk(); cb(); }, 0); }; window.require.config = () => {};
  });
  await page.goto('http://localhost:8765/index.html'); await sleep(2600);
  const ev = (f, a) => page.evaluate(f, a);
  const settle = (ms) => sleep(ms || 400);

  // ---- stand-ins: the host (runs JavaScript programs, or waits to be killed), the diff opener, the toast
  await ev(() => {
    window.__kills = 0; window.__killRej = null; window.__diffs = []; window.__toasts = []; window.__wait = false;
    window.CodeMiniExec = {
      use: async () => true, fallbackNotice: () => '', kill() { window.__kills++; if (window.__killRej) window.__killRej(new Error('host killed')); },
      run: (winId, req, onOut) => new Promise(async (resolve, reject) => {
        if (window.__wait) { window.__killRej = reject; return; }
        const AF = Object.getPrototypeOf(async function () {}).constructor, orig = console.log;
        console.log = (...a) => onOut({ kind: 'log', text: a.join(' ') });
        try { await new AF(req.code)(); resolve({}); } catch (e) { resolve({ error: { name: e.name, message: e.message, text: String(e.stack) } }); } finally { console.log = orig; }
      })
    };
    window.CodeMiniDiff = Object.assign(window.CodeMiniDiff || {}, { openStatic: (o) => { window.__diffs.push(o); } });
    window.handleFileClick = () => {}; window.showSuccessToast = (m) => { window.__toasts.push(m); };
  });
  const put = (recs) => ev((recs) => new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'), st = tx.objectStore('filesystem'); recs.forEach(r => st.put(Object.assign({ isLocked: false, timestamp: Date.now() }, r))); tx.oncomplete = () => { loadFilesFromDB(); res(); }; }), recs);
  const records = () => ev(() => new Promise(res => { db.transaction('filesystem').objectStore('filesystem').getAll().onsuccess = e => res(e.target.result); }));
  const click = (sel) => ev((sel) => document.querySelector(sel).click(), sel);
  const rows = () => ev(() => [...document.querySelectorAll('#testSidebar .te-row')].map(r => r.dataset.state + ' ' + r.dataset.name));
  const S = '#testSidebar';

  console.log('\n[1] the entry points, with no tests');
  ok(await ev(() => !!document.getElementById('menuTests') && /Test/.test(document.getElementById('menuTests').textContent)), 'the Tests menu item is there');
  ok(await ev(() => getComputedStyle(document.getElementById('statusTestsToggle')).display === 'none'), 'the status bar item is hidden while there are no tests');
  await click('#menuTests'); await settle(500);
  ok(await ev(() => document.getElementById('testSidebar').classList.contains('open') && /TEST EXPLORER/.test(document.querySelector('#testSidebar .sb-title').textContent) && !document.getElementById('mainMenuDropdown').classList.contains('show')), 'it opens the TEST EXPLORER sidebar and closes the menu');
  ok(await ev(() => /No tests found/.test(document.querySelector('#testSidebar .te-emptystate').textContent) && [...document.querySelectorAll('#testSidebar .te-btn')].map(b => b.textContent).join('|') === 'Create a test file|Configure patterns'), 'the empty state offers to create a test file or configure patterns');
  ok(await ev(() => Object.keys(localStorage).some(k => { try { return JSON.parse(localStorage.getItem(k)).sidebar === 'tests'; } catch (e) { return false; } })), 'the open sidebar is remembered');

  console.log('\n[2] creating a sample test file');
  await click(S + ' .te-btn.primary'); await settle(200); await click(S + ' .te-menu-item[data-sample="javascript"]'); await settle(700);
  const recs = await records();
  ok(recs.some(r => r.name === 'math.test.js' && /describe\('add'/.test(r.content)) && recs.some(r => r.name === 'tests' && r.type === 'folder'), 'it creates tests/math.test.js');
  ok((await rows()).join('|') === 'idle tests/math.test.js|idle add|idle add > adds two numbers|idle add > adds negatives', 'and the tree shows its suite and two tests, not yet run', await rows());
  ok(await ev(() => getComputedStyle(document.getElementById('statusTestsToggle')).display !== 'none'), 'the status bar item appears');

  console.log('\n[3] running: pass, fail, skip, with an error block');
  await put([{ id: 'src', parentId: 'root', name: 'src', type: 'folder' }, { id: 'src-calc', parentId: 'src', name: 'calc.js', type: 'file', content: 'module.exports = { add: (a, b) => a + b };' },
    { id: 'tests-calc', parentId: (await records()).find(r => r.name === 'tests').id, name: 'calc.test.js', type: 'file', content: "const { add } = require('../src/calc');\ndescribe('calc', () => {\n  it('adds', () => { console.log('hi from a test'); expect(add(1, 2)).toBe(3); });\n  it('is wrong', () => { expect(add(1, 2)).toBe(4); });\n  it.skip('later', () => {});\n});\n" }]);
  await settle(500);
  await click(S + ' .te-run-all'); await settle(1200);
  const rs = await rows();
  ok(rs.includes('passed calc > adds') && rs.includes('failed calc > is wrong') && rs.includes('skipped calc > later') && rs.includes('passed add > adds two numbers') && rs.includes('failed tests/calc.test.js') && rs.includes('passed tests/math.test.js'), 'every test shows its state, and a file with a failure is failed', rs);
  ok(await ev(() => [...document.querySelectorAll('#testSidebar .te-pill')].map(p => p.textContent).join(',') === '3,1,1'), 'the summary pills read 3 passed, 1 failed, 1 skipped');
  ok(await ev(() => /3/.test(document.getElementById('statusTestsToggle').textContent) && /1/.test(document.getElementById('statusTestsToggle').textContent) && document.getElementById('statusTestsToggle').dataset.state === 'failed'), 'the status bar item shows the counts');
  const err = await ev(() => ({ msg: document.querySelector('#testSidebar .te-err-msg').textContent, cmp: [...document.querySelectorAll('#testSidebar .te-cmp-row')].map(r => r.textContent), frame: [...document.querySelectorAll('#testSidebar .te-frames .te-link')].map(f => f.textContent) }));
  ok(err.msg === 'Expected 3 to be 4' && err.cmp.join('|') === 'Expected4|Actual3' && err.frame[0] === 'tests/calc.test.js:4:' + err.frame[0].split(':')[2], 'the failed test has its message, Expected / Actual, and a clickable frame at the right line', err);
  await ev(() => [...document.querySelectorAll('#testSidebar .te-action')].find(b => b.textContent === 'View diff').click()); await settle(100);
  ok(await ev(() => window.__diffs.length === 1 && window.__diffs[0].original === '4' && window.__diffs[0].modified === '3'), 'View diff opens a diff of expected against actual');
  ok(await ev(() => { const t = document.querySelector('.bottom-panel-tab[data-target="testPanelContent"]'); return t.classList.contains('active') && /hi from a test/.test(document.getElementById('testOutputBody').textContent) && /3 passed, 1 failed, 1 skipped/.test(document.getElementById('testOutputBody').textContent); }), 'the Test Output tab opened by itself and has the console output and the totals');

  console.log('\n[4] filter, stale, run failed');
  await click(S + ' .sb-header .sb-icon-btn[aria-label="Filter"]'); await click(S + ' .sb-seg[data-mode="failed"]');
  ok((await rows()).join('|') === 'failed tests/calc.test.js|failed calc|failed calc > is wrong', 'Failed shows only the failed test, with its path', await rows());
  await click(S + ' .sb-seg[data-mode="all"]');
  await put([{ id: 'tests-calc', parentId: (await records()).find(r => r.name === 'tests').id, name: 'calc.test.js', type: 'file', content: "const { add } = require('../src/calc');\ndescribe('calc', () => {\n  it('adds', () => { expect(add(1, 2)).toBe(3); });\n  it('is wrong', () => { expect(add(1, 2)).toBe(3); });\n});\n" }]); await settle(500);
  ok(await ev(() => !!document.querySelector('#testSidebar .te-stale') && document.querySelector('#testSidebar .te-stale').textContent === 'STALE'), 'a file that changed since its run is marked STALE');
  await ev(() => CodeMiniTests.runFailed()); await settle(1000);
  ok((await rows()).includes('passed calc > is wrong') && !(await ev(() => !!document.querySelector('#testSidebar .te-stale'))), 'Run Failed re-runs the failed test, which now passes, and clears STALE', await rows());

  console.log('\n[5] stop, and Restricted Mode');
  await ev(() => { window.__wait = true; }); await ev(() => { CodeMiniTests.runAll(); }); await settle(300);
  ok(await ev(() => !document.querySelector('#testSidebar .te-stop').disabled && document.getElementById('statusTestsToggle').dataset.state === 'running'), 'while running, Stop is enabled and the status item says running');
  await click(S + ' .te-stop'); await settle(500);
  ok(await ev(() => window.__kills >= 1 && document.querySelector('#testSidebar .te-stop').disabled && /Stopped/.test(document.getElementById('testOutputHead').textContent)), 'Stop shuts the host down and ends the run as stopped');
  await ev(() => { window.__wait = false; window.CodeMiniConfig.canRun = () => false; window.dispatchEvent(new Event('workspacetrustchange')); }); await settle(400);
  ok(await ev(() => !!document.querySelector('#testSidebar .te-banner-lock') && document.querySelector('#testSidebar .te-run-all').disabled && [...document.querySelectorAll('#testSidebar .te-play')].every(b => b.disabled)), 'in Restricted Mode tests are listed, with a banner, but cannot be run');

  console.log('\n[6] tests.json patterns');
  await ev(() => { window.CodeMiniConfig.canRun = () => true; });
  const cfgId = 'cfg-te';
  await put([{ id: cfgId, parentId: 'root', name: '.codemini', type: 'folder' }, { id: 'te-cfg-file', parentId: cfgId, name: 'tests.json', type: 'file', content: JSON.stringify({ version: 1, patterns: { javascript: ['*.check.js'] } }) }, { id: 'chk', parentId: 'root', name: 'a.check.js', type: 'file', content: "it('checked', () => {});" }]); await settle(600);
  ok((await rows()).join('|') === 'idle a.check.js|idle checked', 'a pattern in .codemini/tests.json replaces the default: only *.check.js files are found', await rows());
  await put([{ id: 'te-cfg-file', parentId: cfgId, name: 'tests.json', type: 'file', content: '{ "patterns": ' }]); await settle(600);
  ok(await ev(() => /tests\.json is not valid/.test(document.querySelector('#testSidebar .te-banner-bad').textContent)) && (await rows()).includes('idle tests/math.test.js'), 'a broken tests.json shows a banner and falls back to the default patterns', await rows());

  ok(errors.filter(e => !NOISE.test(e)).length === 0, 'no page errors', errors.filter(e => !NOISE.test(e)));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
