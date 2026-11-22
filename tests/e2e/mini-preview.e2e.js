// Mini Preview (UI/UX specs, feature 15) in a real browser: the app on http://localhost:8765 and a real runner on http://localhost:8766
// (two origins, so Isolated is really isolated). Monaco is stubbed, so the editor is a faithful fake (ranges, a model, tracked decorations,
// actions, context keys): what is checked is everything on THIS side of the editor: the action, Alt+P, the section in the Now pane, the pin,
// the page in the frame, the console strip, errors, viewport, follow, source changed, the phone pill and the fallback.
const { chromium } = require('playwright');
const { createServer } = require('./lib/static-server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const APP = 'http://localhost:8765', RUNNER = 'http://localhost:8766';

// The fake editor, installed in the page. window.__mk(name, lang, text) returns an editor; ed.sel(l1,c1,l2,c2) selects.
const FAKE = () => {
  const range = (a, b, c, d) => ({ startLineNumber: a, startColumn: b, endLineNumber: c, endColumn: d, isEmpty() { return a === c && b === d; }, getEndPosition() { return { lineNumber: c, column: d }; } });
  window.__mk = (name, lang, text) => {
    const lines = () => model._text.split('\n');
    const sub = (r) => { const L = lines(); if (r.startLineNumber === r.endLineNumber) return L[r.startLineNumber - 1].slice(r.startColumn - 1, r.endColumn - 1);
      const out = [L[r.startLineNumber - 1].slice(r.startColumn - 1)]; for (let i = r.startLineNumber; i < r.endLineNumber - 1; i++) out.push(L[i]); out.push(L[r.endLineNumber - 1].slice(0, r.endColumn - 1)); return out.join('\n'); };
    const decos = {}; let nextId = 1; const contentCbs = [];
    const model = { _text: text, getLanguageId: () => lang, isDisposed: () => false, getValueInRange: sub,
      deltaDecorations(old, add) { old.forEach((i) => delete decos[i]); return add.map((a) => { const id = 'd' + nextId++; decos[id] = a.range; return id; }); },
      getDecorationRange: (id) => decos[id] || null,
      onDidChangeContent(cb) { contentCbs.push(cb); return { dispose() { const i = contentCbs.indexOf(cb); if (i > -1) contentCbs.splice(i, 1); } }; },
      // an edit: replace the whole text; tracked ranges move by the number of lines inserted above them
      edit(newText, shiftLines) { model._text = newText; if (shiftLines) Object.keys(decos).forEach((k) => { const r = decos[k]; decos[k] = range(r.startLineNumber + shiftLines, r.startColumn, r.endLineNumber + shiftLines, r.endColumn); }); contentCbs.slice().forEach((cb) => cb({})); } };
    let selection = range(1, 1, 1, 1); const selCbs = []; const keys = {}; const calls = { setPosition: [], reveal: [], focus: 0 };
    const dom = document.createElement('div'); dom.style.cssText = 'position:fixed;left:60px;top:80px;width:600px;height:300px'; document.body.appendChild(dom);
    const ed = { __name: name, __model: model, __calls: calls, __actions: [], __keys: keys, __dom: dom,
      getSelection: () => selection, getModel: () => model,
      setSelection(r) { selection = r; selCbs.slice().forEach((cb) => cb({})); },
      sel(a, b, c, d) { ed.setSelection(range(a, b, c, d)); },
      createContextKey(k, v) { keys[k] = v; return { set: (x) => { keys[k] = x; } }; },
      addAction(a) { ed.__actions.push(a); },
      onDidChangeCursorSelection(cb) { selCbs.push(cb); return { dispose() {} }; }, onDidScrollChange() { return { dispose() {} }; }, onDidChangeModel() { return { dispose() {} }; },
      getScrolledVisiblePosition: (p) => ({ left: 40, top: (p.lineNumber - 1) * 20 + 100, height: 20 }), getDomNode: () => dom,
      setPosition(p) { calls.setPosition.push(p); }, revealPositionInCenter(p) { calls.reveal.push(p); }, focus() { calls.focus++; } };
    window.getFileContextFromEditor = (e) => ({ fileId: 'f-' + e.__name, fileName: e.__name });
    window.CodeMiniMiniPreview.attachEditor(ed);
    window.__ed = ed;
    return ed;
  };
};

async function open(browser, opts) {
  opts = opts || {};
  const phone = opts.phone;
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => { if (!/reading 'x'/.test(e.message)) errors.push(e.message); }); // the boom.js test throws inside the previewed page on purpose
  await page.addInitScript(([runnerUrl, off]) => {
    if (location.port === '8765') { if (runnerUrl) localStorage.setItem('codemini_runner_url', runnerUrl); if (off) localStorage.setItem('codemini_runner', 'off'); }
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); }; window.require.config = () => {};
  }, [opts.off ? null : RUNNER, !!opts.off]);
  await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  await page.goto(APP + '/index.html'); await sleep(3500);
  await page.evaluate(FAKE);
  return { ctx, page, errors };
}
// the previewed page: the frame inside the runner's shell, or a blob frame of the app in Normal mode
const pageFrame = (page) => page.frames().find((f) => f.parentFrame() && f.url().startsWith('blob:'));
const txt = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
const shown = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && getComputedStyle(e).display !== 'none'; }, sel);
const vis = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e || e.hidden) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, sel);
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (await fn()) return true; await sleep(100); } return false; }
const action = (page) => page.evaluate(() => window.__ed.__actions.find((a) => a.id === 'preview-selection').run(window.__ed));

(async () => {
  const runnerServer = createServer(require('../lib/paths').runnerDir(), { headers: { 'Content-Security-Policy': "frame-ancestors 'self' http://localhost:8765 http://127.0.0.1:8765" } });
  await new Promise((r) => runnerServer.listen(8766, r));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // ====================================================================== desktop, Isolated
  console.log('\n[desktop, Isolated]');
  let { ctx, page, errors } = await open(browser);
  ok(await page.evaluate(() => !!(window.CodeMiniMiniPreview && window.CodeMiniNowIsland)), 'the module and the Now Island API are there');
  ok(await page.evaluate(() => !document.querySelector('.mp-sec')), 'nothing is added to the Now pane until a preview is asked for');

  const ed = await page.evaluateHandle(() => window.__mk('index.html', 'html', '<h1 id="t">Hi</h1>\n<script>console.log("hello"); console.warn("careful")</script>\n<p>third</p>'));
  const act = await page.evaluate(() => { const a = window.__ed.__actions[0]; return { id: a.id, order: a.contextMenuOrder, group: a.contextMenuGroupId, pre: a.precondition, label: a.label, n: window.__ed.__actions.length }; });
  ok(act.id === 'preview-selection' && act.order === 1.6 && act.group === '1_modification' && /editorHasSelection/.test(act.pre) && act.label === 'Preview selected' && act.n === 1, 'the right-click action is registered like Run in console', act);
  ok(await page.evaluate(() => window.__ed.__keys.cmMiniPreviewable === true), 'it is offered for an HTML file');
  await page.evaluate(() => { window.__py = window.__mk('main.py', 'python', 'print(1)'); });
  ok(await page.evaluate(() => window.__py.__keys.cmMiniPreviewable === false), 'and not for a Python file (the context key is false)');
  await page.evaluate(() => { window.__ed = window.__mk('index.html', 'html', '<h1 id="t">Hi</h1>\n<script>console.log("hello"); console.warn("careful")</script>\n<p>third</p>'); });

  // Alt+P with nothing selected: the island opens on Now with the empty state; the editor keeps the focus
  await page.evaluate(() => { const i = document.createElement('input'); i.id = 'sentinel'; document.body.appendChild(i); i.focus(); });
  await page.keyboard.press('Alt+p'); await sleep(500);
  ok(await page.evaluate(() => document.getElementById('nowIslandPanel').classList.contains('show')), 'Alt+P opens the Now Island');
  ok(await page.evaluate(() => document.querySelector('.ni-tab.active').dataset.pane === 'now'), 'on the Now tab');
  ok(await vis(page, '.mp-empty') && /Preview selected \(Alt\+P\)/.test(await txt(page, '.mp-empty')), 'the empty state says what to do');
  ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'sentinel'), 'focus was not taken');
  ok(await shown(page, '#niPin') && await page.evaluate(() => document.getElementById('niPin').getAttribute('aria-pressed') === 'true'), 'the pin shows, pressed (filled)');
  ok(await page.evaluate(() => /Nothing is running/.test(document.querySelector('.ni-empty:not(.mp-empty)').textContent) && document.querySelector('.ni-empty:not(.mp-empty)').hidden), '"Nothing is running" steps aside');
  ok(await page.evaluate(() => !!document.querySelector('#nowIsland .mp-eye') && !document.querySelector('#nowIsland .mp-eye').hidden), 'the status-bar item shows the eye');
  ok(await page.evaluate(() => { const s = document.querySelector('.mp-sec'), r = document.querySelector('.ni-sec-running'); return !!(r.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'the section sits below RUNNING');

  // Preview the selection through the action
  await page.evaluate(() => window.__ed.sel(1, 1, 2, 63));
  await action(page);
  ok(await waitFor(() => page.evaluate(() => /Isolated/.test((document.querySelector('.mp-iso') || {}).textContent || ''))), 'status says Isolated');
  ok(await waitFor(async () => { const f = pageFrame(page); return f && (await f.evaluate(() => !!document.getElementById('t')).catch(() => false)); }), 'the page is in the frame');
  const f1 = pageFrame(page);
  ok(f1 && (await f1.textContent('#t')) === 'Hi', 'the HTML fragment was drawn');
  ok(await page.evaluate(() => { const fr = document.querySelector('.mp-frame'); return CodeMiniRunner.active(fr) && fr.getAttribute('sandbox') === 'allow-scripts allow-same-origin allow-modals allow-popups allow-forms'; }), 'it uses the runner with the Live Preview\'s sandbox flags');
  ok(await txt(page, '.mp-src') === 'index.html:1-2', 'the source pill names the file and lines', await txt(page, '.mp-src'));
  ok(await waitFor(async () => /hello/.test(await txt(page, '.mp-console-rows') || '')), 'the console strip shows console.log', await txt(page, '.mp-console-rows'));
  ok(/careful/.test(await txt(page, '.mp-console-rows')) && await page.evaluate(() => !!document.querySelector('.mp-log.warn')), 'and warnings');
  ok(/ms$|s$/.test((await txt(page, '.mp-time')) || ''), 'a render time is shown', await txt(page, '.mp-time'));
  ok(await txt(page, '.mp-errs') === '0 errors', '0 errors');
  ok(await page.evaluate(() => { const r = document.querySelector('.mp-stage').getBoundingClientRect(); return Math.abs(r.height - 220) < 2 && r.left > document.getElementById('nowIslandPanel').getBoundingClientRect().left + 10; }), 'the framed area is 220px tall and set in from the sides');
  ok(await page.evaluate(() => document.getElementById('sentinel') && document.activeElement.id === 'sentinel'), 'still no focus taken');
  ok(await page.evaluate(() => window.__ed.__calls.focus === 0), 'the editor was not focused by the preview either');

  // pin: outside click does not close; unpin; then it does
  await page.mouse.click(300, 650); await sleep(300);
  ok(await page.evaluate(() => document.getElementById('nowIslandPanel').classList.contains('show')), 'a click outside does not close a pinned island');
  await page.evaluate(() => document.getElementById('niPin').click()); await sleep(100);
  ok(await page.evaluate(() => document.getElementById('niPin').getAttribute('aria-pressed') === 'false'), 'the pin can be released');
  await page.mouse.click(300, 650); await sleep(400);
  ok(await page.evaluate(() => !document.getElementById('nowIslandPanel').classList.contains('show')), 'then an outside click closes it');
  ok(await page.evaluate(() => !!document.querySelector('.mp-frame')), 'the preview itself is still there');
  await page.evaluate(() => window.__ed.sel(3, 1, 3, 12)); await action(page); await sleep(300);
  ok(await page.evaluate(() => document.getElementById('nowIslandPanel').classList.contains('show') && document.getElementById('niPin').getAttribute('aria-pressed') === 'true'), 'choosing Preview selected again reopens and re-pins it');
  ok(await waitFor(async () => { const f = pageFrame(page); return f && (await f.evaluate(() => document.body.textContent.indexOf('third') > -1).catch(() => false)); }), 'and shows the new selection');

  // isolation: the page cannot reach the app
  await page.evaluate(() => window.__mk('probe.js', 'javascript', 'var r = []; try { r.push(typeof parent.parent.CodeMiniShield); } catch (e) { r.push("blocked"); } try { r.push(String(localStorage.getItem("codemini_runner_url"))); } catch (e) { r.push("nostorage"); } console.log("probe:" + r.join(","));'));
  await page.evaluate(() => { window.__ed.sel(1, 1, 1, window.__ed.getModel()._text.length + 1); }); await action(page);
  ok(await waitFor(async () => /probe:/.test(await txt(page, '.mp-console-rows') || '')), 'a JavaScript selection runs and logs');
  const probe = (await txt(page, '.mp-console-rows')).match(/probe:(\S+)/)[1];
  ok(probe === 'blocked,null', 'Isolated: the page cannot touch the app (Shield blocked, the app\'s storage not visible)', probe);

  // a runtime error is counted, shown, and walked back to the editor
  await page.evaluate(() => window.__mk('boom.js', 'javascript', 'var a = 1;\nvar b = 2;\nnull.x;\n'));
  await page.evaluate(() => window.__ed.sel(1, 1, 3, 8)); await action(page);
  ok(await waitFor(async () => await txt(page, '.mp-errs') === '1 error'), 'a runtime error is counted', await txt(page, '.mp-errs'));
  ok(await vis(page, '.mp-error') && /null|Cannot read|of null/i.test(await txt(page, '.mp-error-text')), 'and shown in the error row', await txt(page, '.mp-error-text'));
  ok(await page.evaluate(() => !!document.querySelector('.mp-log.err')), 'red in the console strip');
  await page.evaluate(() => document.querySelector('.mp-error .ni-link').click());
  const pos = await page.evaluate(() => window.__ed.__calls.setPosition.slice(-1)[0]);
  ok(pos && pos.lineNumber === 3, 'Show in editor jumps to the line of the error', pos);
  ok(await page.evaluate(() => window.__ed.__calls.focus === 1), 'and only then takes focus');

  // build errors: invalid JSON says where; no frame content; unsupported and oversized selections
  await page.evaluate(() => window.__mk('data.json', 'json', '{\n  "a": 1,\n  "b": [1, 2,, 3]\n}'));
  await page.evaluate(() => window.__ed.sel(1, 1, 4, 2)); await action(page); await sleep(400);
  ok(await vis(page, '.mp-error') && /Invalid JSON/.test(await txt(page, '.mp-error-text')), 'invalid JSON is an error row');
  ok(!(await vis(page, '.mp-stage')) && !(await vis(page, '.mp-viewport')), 'with no preview area');
  await page.evaluate(() => document.querySelector('.mp-error .ni-link').click());
  const jpos = await page.evaluate(() => window.__ed.__calls.setPosition.slice(-1)[0]);
  ok(jpos && jpos.lineNumber === 3 && jpos.column === 14, 'Show in editor lands on the second comma (line 3, column 14)', jpos);
  await page.evaluate(() => window.__mk('data.json', 'json', '{"name":"mini","list":[1,true,null]}'));
  await page.evaluate(() => window.__ed.sel(1, 1, 1, 37)); await action(page);
  ok(await waitFor(async () => { const f = pageFrame(page); return f && (await f.evaluate(() => !!document.querySelector('.k')).catch(() => false)); }), 'valid JSON is drawn as a tree (and the error row goes away)');
  ok(!(await vis(page, '.mp-error')), 'the error row is gone');
  await page.evaluate(() => window.__mk('t.csv', 'plaintext', 'name,qty\n"Bolt, M6",10\n<b>x</b>,2'));
  await page.evaluate(() => window.__ed.sel(1, 1, 3, 9)); await action(page);
  ok(await waitFor(async () => { const f = pageFrame(page); return f && (await f.evaluate(() => document.querySelectorAll('td').length === 4).catch(() => false)); }), 'CSV is a table');
  ok(await pageFrame(page).evaluate(() => document.querySelector('th').textContent === 'name' && !document.querySelector('b') && document.body.textContent.indexOf('<b>x</b>') > -1), 'with a header, and cells shown as text');
  await page.evaluate(() => window.__mk('logo.svg', 'xml', '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle id="c" cx="20" cy="20" r="10"/></svg>'));
  await page.evaluate(() => window.__ed.sel(1, 1, 1, 200)); await action(page);
  ok(await waitFor(async () => { const f = pageFrame(page); return f && (await f.evaluate(() => !!document.getElementById('c')).catch(() => false)); }), 'SVG is drawn');
  await page.evaluate(() => window.__mk('a.css', 'css', 'h1 { color: rgb(1, 2, 3); }'));
  await page.evaluate(() => window.__ed.sel(1, 1, 1, 29)); await action(page);
  ok(await waitFor(async () => { const f = pageFrame(page); return f && (await f.evaluate(() => getComputedStyle(document.querySelector('h1')).color === 'rgb(1, 2, 3)').catch(() => false)); }), 'CSS is applied to the sample page when the project has no index.html');
  ok(!(await vis(page, '.mp-css-seg')), 'and the index.html / Sample switch is hidden');
  await page.evaluate(async () => { await new Promise((res) => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put({ id: 'ix1', parentId: 'root', name: 'index.html', type: 'file', content: '<!doctype html><html><head><title>p</title></head><body><h1 id="mine">Project</h1></body></html>', absolutePath: '/index.html', timestamp: Date.now() }); tx.oncomplete = res; }); });
  await page.evaluate(() => window.__ed.sel(1, 1, 1, 29)); await action(page);
  ok(await waitFor(async () => { const f = pageFrame(page); return f && (await f.evaluate(() => !!document.getElementById('mine') && getComputedStyle(document.getElementById('mine')).color === 'rgb(1, 2, 3)').catch(() => false)); }), 'CSS is applied to the project\'s own index.html when there is one');
  ok(await vis(page, '.mp-css-seg'), 'and the index.html / Sample switch shows');
  await page.evaluate(() => document.querySelector('[data-mp-css="sample"]').click());
  ok(await waitFor(async () => { const f = pageFrame(page); return f && (await f.evaluate(() => !!document.querySelector('.container')).catch(() => false)); }), 'Sample switches to the sample page');
  await page.evaluate(() => window.__mk('main.py', 'python', 'print(1)')); await page.evaluate(() => window.__ed.sel(1, 1, 1, 9)); await action(page); await sleep(200);
  ok(/HTML, CSS, JavaScript, Markdown, SVG, JSON and CSV/.test(await txt(page, '.mp-error-text')), 'a Python selection says what it can preview');
  await page.evaluate(() => window.__mk('big.html', 'html', 'x'.repeat(210 * 1024))); await page.evaluate(() => window.__ed.sel(1, 1, 1, 210 * 1024 + 1)); await action(page); await sleep(200);
  ok(/Takes up to 200 KB|up to 200 KB/.test(await txt(page, '.mp-error-text')), 'a selection over 200 KB is refused with the limit', await txt(page, '.mp-error-text'));

  // viewport row and the resize grip
  await page.evaluate(() => window.__mk('v.html', 'html', '<p id="w"></p><script>document.getElementById("w").textContent = innerWidth</script>')); await page.evaluate(() => window.__ed.sel(1, 1, 1, 90)); await action(page);
  ok(await waitFor(async () => { const f = pageFrame(page); return f && (await f.evaluate(() => document.getElementById('w').textContent !== '').catch(() => false)); }), 'a page that reports its width');
  await page.evaluate(() => document.querySelector('[data-mp-viewport="768"]').click()); await sleep(400);
  ok(await pageFrame(page).evaluate(() => innerWidth) === 768, '768 lays the page out at 768px');
  ok(await page.evaluate(() => { const f = document.querySelector('.mp-frame'); return /scale\(0\.\d+\)/.test(f.style.transform) && f.style.width === '768px'; }), 'scaled down to fit the panel');
  await page.evaluate(() => document.querySelector('[data-mp-viewport="320"]').click()); await sleep(300);
  ok(await pageFrame(page).evaluate(() => innerWidth) === 320, '320 lays it out at 320px');
  await page.evaluate(() => document.querySelector('[data-mp-viewport="fit"]').click()); await sleep(300);
  ok(await page.evaluate(() => document.querySelector('[data-mp-viewport="fit"]').classList.contains('active') && document.querySelector('.mp-frame').style.transform === ''), 'Fit goes back to the panel width');
  const h0 = await page.evaluate(() => Math.round(document.querySelector('.mp-stage').getBoundingClientRect().height));
  await page.evaluate(() => { const g = document.querySelector('.mp-grip'); g.focus(); });
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  const h1 = await page.evaluate(() => Math.round(document.querySelector('.mp-stage').getBoundingClientRect().height));
  ok(h1 === h0 + 60, 'the grip resizes with the arrow keys', [h0, h1]);
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowUp');
  ok(await page.evaluate(() => Math.round(document.querySelector('.mp-stage').getBoundingClientRect().height)) === 120, 'but not below 120px');
  for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowDown');
  ok(await page.evaluate(() => document.querySelector('.mp-stage').getBoundingClientRect().height <= innerHeight * 0.6 + 2), 'or above 60% of the screen');

  // source changed, with the tracked range
  await page.evaluate(() => { window.__ed = window.__mk('s.html', 'html', '<p id="one">one</p>\n<p id="two">two</p>'); window.__ed.sel(2, 1, 2, 20); });
  await action(page);
  ok(await waitFor(async () => { const f = pageFrame(page); return f && (await f.evaluate(() => !!document.getElementById('two')).catch(() => false)); }), 'a selection of line 2');
  ok(!(await vis(page, '.mp-note')), 'no note yet');
  await page.evaluate(() => window.__ed.__model.edit('<h2>new top line</h2>\n<p id="one">one</p>\n<p id="two">TWO!</p>', 1));
  ok(await vis(page, '.mp-note') && /Source changed/.test(await txt(page, '.mp-note')), 'editing the file shows "Source changed"');
  await page.evaluate(() => document.querySelector('.mp-note .ni-link').click());
  ok(await waitFor(async () => { const f = pageFrame(page); return f && (await f.evaluate(() => document.getElementById('two') && document.getElementById('two').textContent === 'TWO!').catch(() => false)); }), 'Refresh previews the same block of code after a line was added above it (the range was tracked)');
  ok(!(await vis(page, '.mp-note')) && await txt(page, '.mp-src') === 's.html:3', 'the note goes, and the source pill follows the block to line 3', await txt(page, '.mp-src'));

  // follow selection (desktop default: on), debounced
  ok(await page.evaluate(() => document.querySelector('.mp-tools .ni-icon-btn').getAttribute('aria-pressed') === 'true'), 'Follow selection is on by default on a desktop');
  await page.evaluate(() => { window.__ed.sel(1, 1, 1, 21); window.__ed.sel(2, 1, 2, 22); });
  await sleep(250);
  ok(await page.evaluate(() => document.querySelector('.mp-src').textContent) === 's.html:3', 'nothing changes before the 400ms debounce');
  await sleep(1200);
  ok(await waitFor(async () => await txt(page, '.mp-src') === 's.html:2'), 'the preview then follows the selection', await txt(page, '.mp-src'));
  await page.evaluate(() => window.__ed.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1, isEmpty: () => true, getEndPosition: () => ({ lineNumber: 1, column: 1 }) })); await sleep(700);
  ok(await txt(page, '.mp-src') === 's.html:2' && !!pageFrame(page), 'clearing the selection keeps the last preview');
  await page.evaluate(() => document.querySelector('.mp-tools .ni-icon-btn').click());
  await page.evaluate(() => window.__ed.sel(3, 1, 3, 22)); await sleep(1000);
  ok(await txt(page, '.mp-src') === 's.html:2', 'with Follow off the preview stays put');

  // forged messages: only the frame's own messages count
  const before = await txt(page, '.mp-console-rows');
  await page.evaluate(() => window.postMessage({ cmMini: 1, type: 'console', level: 'error', text: 'FORGED' }, '*')); await sleep(300);
  ok((await txt(page, '.mp-console-rows')) === before && await txt(page, '.mp-errs') === '0 errors', 'a message that is not from the preview frame is ignored');

  // Open in Live Preview
  await page.evaluate(() => document.querySelector('.mp-tools .ni-icon-btn[aria-label="Open in Live Preview"]').click()); await sleep(1500);
  ok(await page.evaluate(() => document.getElementById('livePreviewContainer').classList.contains('show')), 'Open in Live Preview opens the dock');
  ok(await page.evaluate(() => document.getElementById('lpCurrentFileLabel').textContent) === 'snippet.html', 'with the snippet', await page.evaluate(() => document.getElementById('lpCurrentFileLabel').textContent));

  // close
  await page.evaluate(() => document.querySelector('.mp-tools .ni-icon-btn[aria-label="Close Mini Preview"]').click()); await sleep(300);
  ok(await page.evaluate(() => document.querySelector('.mp-sec').hidden && !document.querySelector('.mp-frame')), 'Close removes the section and the frame');
  ok(await page.evaluate(() => document.getElementById('niPin').hidden && document.getElementById('nowIsland').querySelector('.mp-eye').hidden), 'the pin and the eye go');
  await page.evaluate(() => document.getElementById('nowIsland').click()); await sleep(300);
  ok(await page.evaluate(() => !document.querySelector('.ni-empty:not(.mp-empty)').hidden), '"Nothing is running" comes back');
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();

  // ====================================================================== desktop, Normal (Isolation off)
  console.log('\n[desktop, Normal mode]');
  ({ ctx, page, errors } = await open(browser, { off: true }));
  await page.evaluate(() => { window.__mk('n.js', 'javascript', 'console.log("normal:" + typeof parent.CodeMiniShield + "," + typeof parent.document);'); window.__ed.sel(1, 1, 1, 200); });
  await action(page);
  ok(await waitFor(async () => /normal:/.test(await txt(page, '.mp-console-rows') || '')), 'it renders and reports without the runner');
  ok((await txt(page, '.mp-iso')).trim() === 'Normal' && await page.evaluate(() => document.querySelector('.mp-iso').classList.contains('warn')), 'the indicator is the amber "Normal"');
  ok(/normal:object,object/.test(await txt(page, '.mp-console-rows')), 'and the page really is in the app\'s origin (the same as the Live Preview in this mode)');
  ok(await page.evaluate(() => !CodeMiniRunner.active(document.querySelector('.mp-frame'))), 'no runner session');
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();

  // ====================================================================== phone: the pill, follow off, island size
  console.log('\n[phone]');
  ({ ctx, page, errors } = await open(browser, { phone: true, off: true }));
  await page.evaluate(() => { window.__mk('p.html', 'html', '<h1 id="ph">Phone</h1>\n<p>two</p>'); });
  ok(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'a coarse pointer');
  ok(!(await vis(page, '.mp-pill')), 'no pill without a selection');
  await page.evaluate(() => window.__ed.sel(1, 1, 1, 27)); await sleep(250);
  ok(!(await vis(page, '.mp-pill')), 'the pill waits until the selection has been steady');
  await sleep(500);
  ok(await vis(page, '.mp-pill') && await txt(page, '.mp-pill') === 'Preview selected', 'it then appears: "Preview selected"');
  const geo = await page.evaluate(() => { const p = document.querySelector('.mp-pill').getBoundingClientRect(), d = window.__ed.__dom.getBoundingClientRect(); return { bottom: Math.round(p.bottom), want: Math.round(d.top + 100 - 6), cs: getComputedStyle(document.querySelector('.mp-pill')) .fontSize }; });
  ok(Math.abs(geo.bottom - geo.want) <= 1 && geo.cs === '11px', 'it sits 6px above the selection end, 11px text', geo);
  await page.evaluate(() => window.__ed.sel(1, 1, 1, 1)); await sleep(100);
  ok(!(await vis(page, '.mp-pill')), 'it hides when the selection clears');
  await page.evaluate(() => window.__ed.sel(1, 1, 1, 27)); await sleep(800);
  await page.evaluate(() => document.querySelector('.mp-pill').click()); await sleep(600);
  ok(await page.evaluate(() => document.getElementById('nowIslandPanel').classList.contains('show') && !document.querySelector('.mp-sec').hidden), 'tapping the pill opens the Mini Preview in the island');
  ok(await waitFor(async () => { const f = pageFrame(page); return f && (await f.evaluate(() => !!document.getElementById('ph')).catch(() => false)); }), 'and draws the selection');
  ok(!(await vis(page, '.mp-pill')), 'the pill goes');
  ok(await page.evaluate(() => document.querySelector('.mp-tools .ni-icon-btn').getAttribute('aria-pressed') === 'false'), 'Follow selection is off by default on a phone');
  ok(await page.evaluate(() => { const r = document.getElementById('nowIslandPanel').getBoundingClientRect(); return r.left >= 54 && r.right <= innerWidth - 9 && r.height <= innerHeight * 0.6 + 2; }), 'the island keeps the phone layout (left 55px, at most 60vh)');
  ok(await page.evaluate(() => { const s = document.querySelector('.mp-sec'), b = document.querySelector('#nowIslandPanel .ni-pane.active'); return b.scrollWidth <= b.clientWidth + 1 && s.getBoundingClientRect().width > 0; }), 'nothing overflows sideways');
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();

  // ====================================================================== theme packs: every new component takes the pack's shape
  console.log('\n[theme packs]');
  ({ ctx, page, errors } = await open(browser, { off: true }));
  await page.evaluate(() => { window.__mk('t.html', 'html', '<p>x</p>'); window.__ed.sel(1, 1, 1, 10); });
  await action(page); await sleep(800);
  const shape = (pack) => page.evaluate((p) => { if (p) document.documentElement.dataset.themePack = p; else delete document.documentElement.dataset.themePack;
    const r = (s) => getComputedStyle(document.querySelector(s)).borderRadius; return { stage: r('.mp-stage'), src: r('.mp-src'), seg: r('.mp-sec .sb-segmented'), grip: r('.mp-grip-bar'), btn: r('.mp-tools .ni-icon-btn') }; }, pack);
  const def = await shape(null);
  for (const pack of ['codemini-premium', 'codemini-premium-light']) {
    const s = await shape(pack);
    ok(s.stage === '14px' && def.stage === '0px', pack + ': the framed area takes the 14px card shape (default ' + def.stage + ')', s);
    ok(s.src === '999px' && s.seg === '999px' && s.grip === '999px', pack + ': the source pill, the viewport control and the grip are pills', s);
  }
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();

  await browser.close(); runnerServer.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('Crashed:', e); process.exit(2); });
