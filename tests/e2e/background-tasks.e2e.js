// Now Island core (build-order item 5): RUNNING / RECENTLY FINISHED in the Now pane, Peek, the full-output viewer, the floating Peek panel,
// the status-bar spinner and the spinner on a background window's tab. Tasks are started through the real window.CodeMiniBackground.
// The Remix Icon font is blocked in this harness (no network), so icon-only buttons have no size: they are clicked through the DOM.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const NOISE = /monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i;

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.addInitScript(() => { window.RUN = '.ni-sec-running'; window.FIN = '.ni-sec-finished'; });
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { setTimeout(() => { window.monaco = mk(); cb(); }, 0); }; window.require.config = () => {};
  });
  const ev = (f, a) => page.evaluate(f, a);
  const islandOpen = () => ev(() => document.getElementById('nowIslandPanel').classList.contains('show'));
  const toggleIsland = () => ev(() => document.getElementById('nowIsland').click());
  const closeIsland = async () => { if (await islandOpen()) await toggleIsland(); await sleep(50); };
  const openIsland = async () => { if (!(await islandOpen())) await toggleIsland(); await ev(() => document.querySelector('.ni-tab[data-pane="now"]').click()); await sleep(80); };
  const boot = async () => { await page.goto('http://localhost:8765/index.html'); await sleep(2200); };
  // Starts a task that is listed at once (isHidden) unless `fg` is set, and keeps it on window.__t[name].
  const start = (name, o) => ev(([name, o]) => {
    window.__t = window.__t || {}; window.__calls = window.__calls || {};
    const opts = Object.assign({ kind: 'run', title: name }, o || {});
    if (!opts.fg) opts.isHidden = () => true;
    if (opts.stop) opts.onStop = () => { window.__calls[name + ':stop'] = (window.__calls[name + ':stop'] || 0) + 1; };
    if (opts.go) opts.onGoto = () => { window.__calls[name + ':go'] = (window.__calls[name + ':go'] || 0) + 1; };
    window.__t[name] = window.CodeMiniBackground.start(opts); return window.__t[name].id;
  }, [name, o]);
  const T = (name, call, ...a) => ev(([name, call, a]) => window.__t[name][call](...a), [name, call, a]);
  const rows = (sel) => ev((sel) => [...document.querySelectorAll(sel + ' .ni-task')].map(li => ({ id: li.dataset.id, state: li.dataset.state, title: li.querySelector('.ni-task-title').textContent, sub: li.querySelector('.ni-task-sub').textContent })), sel);
  const RUN = '.ni-sec-running', FIN = '.ni-sec-finished';
  const rect = (sel) => ev((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(innerWidth - r.right), b: Math.round(innerHeight - r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; }, sel);

  await boot();
  await ev(() => { localStorage.removeItem('codemini_notifications'); });
  await page.reload(); await sleep(2200);

  console.log('\n[1] nothing running');
  ok(await ev(() => !!window.CodeMiniBackground && typeof window.CodeMiniBackground.start === 'function'), 'the registry is on window');
  await openIsland();
  ok(await ev(() => { const e = document.querySelector('.ni-pane[data-pane="now"] .ni-empty'); return !!e && !e.hidden && /Nothing is running/.test(e.textContent); }), 'the Now pane says nothing is running');
  ok(await ev(() => document.querySelector(RUN).hidden && document.querySelector(FIN).hidden), 'and shows no sections');
  ok(await ev(() => { const r = document.getElementById('nowIslandPanel').getBoundingClientRect(); return Math.round(r.height) >= 290 && Math.round(r.height) <= 292; }), 'the panel is 290px tall when there is little to show', await rect('#nowIslandPanel'));
  ok(await ev(() => { const e = document.querySelector('.ni-pane[data-pane="now"] .ni-empty').getBoundingClientRect(), p = document.querySelector('.ni-pane[data-pane="now"]').getBoundingClientRect(); return Math.abs((e.top + e.height / 2) - (p.top + p.height / 2)) < 3; }), 'the empty state is centred in it');
  await closeIsland();

  console.log('\n[2] a quick task leaves no trace, a slow one appears');
  await ev(() => { const t = window.CodeMiniBackground.start({ kind: 'console', title: 'Quick' }); t.finish('success', 'done'); });
  await openIsland();
  ok((await rows(RUN)).length === 0 && (await rows(FIN)).length === 0, 'a task that ends at once is in neither list');
  ok(await ev(() => !document.getElementById('nowIsland').classList.contains('has-running') && !document.getElementById('nowIsland').classList.contains('ni-flash')), 'and the status bar did not flash');
  await closeIsland();
  await start('Slow', { fg: true, kind: 'git' });
  ok(await ev(() => !document.getElementById('nowIsland').classList.contains('has-running')), 'a task still inside its first 800 ms is not shown yet');
  await sleep(1000);
  ok(await ev(() => document.getElementById('nowIsland').classList.contains('has-running')), 'after that the status bar shows it');
  await T('Slow', 'finish');
  await sleep(1400); // the check it flashes lasts 1.2 s
  await ev(() => window.CodeMiniBackground.dismissAllFinished());

  console.log('\n[3] status-bar button');
  await ev(() => { document.querySelectorAll('.ni-pp').forEach(x => x.remove()); });
  await start('Build', { kind: 'git', stop: true, go: true });
  await start('Second');
  await sleep(250);
  const sb = await ev(() => { const b = document.getElementById('nowIsland'), run = b.querySelector('.ni-run'), cs = getComputedStyle(run), ring = getComputedStyle(b.querySelector('.ni-run-ring')); return { cls: b.classList.contains('has-running'), count: b.querySelector('.ni-run-count').textContent, title: b.title, aria: b.getAttribute('aria-label'), runShown: cs.display !== 'none', iconHidden: getComputedStyle(b.querySelector('i')).display === 'none', anim: ring.animationName, color: ring.borderTopColor }; });
  ok(sb.cls && sb.count === '2' && sb.title === '2 running', 'two running: the count is 2 and the tooltip says so', sb);
  ok(sb.runShown && sb.iconHidden && sb.anim === 'niSpin', 'the spinner replaces the icon and turns', sb);
  ok(/Now Island, 2 running/.test(sb.aria), 'the accessible name includes the running count', sb);

  console.log('\n[4] RUNNING rows');
  await openIsland();
  let r = await rows(RUN);
  ok(r.length === 2 && r[0].title === 'Build' && r[1].title === 'Second', 'both are listed, oldest first', r);
  ok(/^Running 00:0\d, in another tab$/.test(r[0].sub), 'second line: elapsed time and why it is out of sight', r[0].sub);
  ok(await ev(() => document.querySelector(RUN + ' .sb-count-badge').textContent === '2' && getComputedStyle(document.querySelector(RUN + ' .sb-section-header')).position === 'sticky'), 'the RUNNING header has a count and is sticky');
  const rowBtns = await ev(() => [...document.querySelectorAll(RUN + ' .ni-task')[0].querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent));
  ok(JSON.stringify(rowBtns) === JSON.stringify(['Peek: Build', 'Go to', 'Stop']), 'a row offers Peek, Go to and Stop', rowBtns);
  ok(await ev(() => { const b = document.querySelectorAll(RUN + ' .ni-task')[1].querySelectorAll('button'); return b.length === 1; }), 'a task with no Stop or Go to offers only Peek');
  ok(await ev(() => { const li = document.querySelector(RUN + ' .ni-task'), cs = getComputedStyle(li); return cs.borderBottomColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(li.querySelector('.ni-task-bar')).height === '2px'; }), 'a 2px progress line replaces the dashed border while it runs');
  ok(await ev(() => document.querySelector(RUN + ' .ni-task-bar').classList.contains('indeterminate')), 'no percentage: the bar is indeterminate');
  await T('Build', 'update', { progress: 0.5 }); await sleep(250);
  ok(await ev(() => { const b = document.querySelector(RUN + ' .ni-task-bar'); return !b.classList.contains('indeterminate') && b.firstChild.style.width === '50%' && b.getAttribute('aria-valuenow') === '50'; }), 'with progress 0.5 the bar is half full and says so to a screen reader');
  await T('Build', 'update', { title: 'Git: <img src=x onerror="window.__pwn=1">' }); await sleep(250);
  ok(await ev(() => !document.querySelector('#nowIslandPanel img') && !window.__pwn && document.querySelector(RUN + ' .ni-task-title').textContent.startsWith('Git: <img')), 'a hostile title is shown as text and nothing runs');
  await T('Build', 'update', { title: 'Build' });

  console.log('\n[5] rows are updated in place');
  const same = await ev(() => { window.__li = document.querySelector(RUN + ' .ni-task'); window.__peekBtn = window.__li.querySelector('.ni-link'); window.__peekBtn.focus(); return document.activeElement === window.__peekBtn; });
  await sleep(2300);
  ok(await ev(() => document.querySelector(RUN + ' .ni-task') === window.__li && document.activeElement === window.__peekBtn), 'after two refreshes it is the same node and keyboard focus is still on Peek');
  ok(await ev(() => /Running 00:0[2-9]/.test(window.__li.querySelector('.ni-task-sub').textContent)), 'while the elapsed time moved on');

  console.log('\n[6] Peek');
  await T('Build', 'log', 'one\ntwo\nthree'); await T('Build', 'log', 'oops', 'err'); await T('Build', 'log', 'five'); await T('Build', 'log', '<b>six</b>');
  await sleep(250);
  await ev(() => document.querySelector(RUN + ' .ni-task .ni-link').click());
  const pk = await ev(() => { const li = document.querySelector(RUN + ' .ni-task'); const lines = [...li.querySelectorAll('.ni-peek-line')]; return { open: !!li.querySelector('.ni-peek'), exp: li.querySelector('.ni-link').getAttribute('aria-expanded'), lines: lines.map(l => l.textContent), err: lines.map(l => l.classList.contains('err')), bold: !!li.querySelector('.ni-peek b'), meta: li.querySelector('.ni-peek-meta').textContent, mono: getComputedStyle(li.querySelector('.ni-peek-log')).fontFamily, bg: getComputedStyle(li.querySelector('.ni-peek-log')).backgroundColor, bd: getComputedStyle(li.querySelector('.ni-peek-log')).borderTopWidth, ah: [...li.querySelectorAll('.ni-peek-actions button')].map(b => b.getAttribute('aria-label') || b.textContent) }; });
  ok(pk.open && pk.exp === 'true', 'Peek opens under its row and says it is expanded', pk);
  ok(JSON.stringify(pk.lines) === JSON.stringify(['three', 'oops', 'five', '<b>six</b>']), 'it shows the last four lines, as plain text', pk.lines);
  ok(pk.err[1] && !pk.err[0] && !pk.bold, 'stderr is marked, and markup in output is not interpreted', pk);
  ok(/^Elapsed 00:\d\d/.test(pk.meta) && /in another tab/.test(pk.meta), 'the meta line has the elapsed time', pk.meta);
  ok(/mono|Menlo|Consolas/.test(pk.mono) && pk.bd === '0px' && pk.bg !== 'rgba(0, 0, 0, 0)', 'the log is a mono strip on the panel colour with no border', pk);
  ok(JSON.stringify(pk.ah) === JSON.stringify(['Stop', 'View full output', 'Pin to screen']), 'Peek offers Stop, View full output and Pin to screen', pk.ah);
  ok(await islandOpen(), 'opening Peek does not close the island');
  await T('Build', 'update', { detail: 'Fetching 12/48: src/app.js' }); await sleep(250);
  ok(await ev(() => /Fetching 12\/48: src\/app\.js/.test(document.querySelector(RUN + ' .ni-peek-meta').textContent)), 'a step reported by the producer shows in Peek');
  await T('Build', 'log', 'seven'); await sleep(300);
  ok(await ev(() => [...document.querySelectorAll(RUN + ' .ni-peek-line')].pop().textContent === 'seven'), 'new output appears live');

  console.log('\n[7] Stop and Go to');
  await ev(() => { [...document.querySelectorAll(RUN + ' .ni-task')[0].querySelectorAll('.ni-peek-actions .ni-link')].find(b => b.textContent === 'Stop').click(); });
  await sleep(250);
  ok(await ev(() => window.__calls['Build:stop'] === 1), 'Stop calls the producer once');
  ok(await ev(() => { const li = document.querySelector(RUN + ' .ni-task'); return /^Stopping/.test(li.querySelector('.ni-task-sub').textContent) && li.querySelector('button[aria-label="Stop"]').disabled; }), 'the row says Stopping and Stop is disabled');
  ok(await islandOpen(), 'Stop does not close the island');
  await ev(() => document.querySelector(RUN + ' .ni-task button[aria-label="Go to"]').click());
  await sleep(150);
  ok(await ev(() => window.__calls['Build:go'] === 1), 'Go to calls the producer');
  ok(!(await islandOpen()), 'and closes the island so the target is in view');
  await openIsland();

  console.log('\n[8] View full output');
  await ev(() => [...document.querySelectorAll(RUN + ' .ni-peek-actions .ni-link')].find(b => b.textContent === 'View full output').click());
  await sleep(150);
  let vw = await ev(() => { const v = document.getElementById('niViewer'); return { show: v.classList.contains('show'), aria: v.getAttribute('aria-label'), title: v.querySelector('.ni-viewer-title').textContent, lines: [...v.querySelectorAll('.ni-log-full > *')].map(x => x.textContent), time: v.querySelector('.ni-viewer-time').textContent }; });
  ok(vw.show && vw.aria === 'Task output' && vw.title === 'Build', 'the slide-over opens as "Task output"', vw);
  ok(vw.lines.length === 7 && vw.lines[0] === 'one' && vw.lines[6] === 'seven', 'it has every line, not just the last four', vw.lines);
  ok(/^Started .*Stopping|^Started .*Running/.test(vw.time), 'with when it started and how it is doing', vw.time);
  await T('Build', 'log', 'eight'); await sleep(300);
  ok(await ev(() => document.querySelector('#niViewer .ni-log-full').lastChild.textContent === 'eight'), 'it follows new output');
  await ev(() => document.querySelector('.ni-tab[data-pane="notifications"]').click());
  ok(await ev(() => !document.getElementById('niViewer').classList.contains('show')), 'switching to Notifications closes it (it belongs to the Now tab)');
  await ev(() => document.querySelector('.ni-tab[data-pane="now"]').click());
  await ev(() => [...document.querySelectorAll(RUN + ' .ni-peek-actions .ni-link')].find(b => b.textContent === 'View full output').click());
  await sleep(100);
  await ev(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  ok(await ev(() => !document.getElementById('niViewer').classList.contains('show')), 'Esc closes it');
  ok(await ev(() => document.querySelector('#niViewer').getAttribute('aria-label') === 'Notification'), 'and the viewer goes back to being the notification viewer');

  console.log('\n[9] finishing');
  await ev(() => { window.__notes = []; window.CodeMiniNotifications.onChange(l => { window.__notes = l; }); });
  await T('Build', 'finish', 'error', 'Push rejected');
  await sleep(300);
  ok(await ev(() => document.getElementById('nowIsland').classList.contains('ni-flash') && /ri-close-line/.test(document.querySelector('.ni-run-ring').className)), 'the status bar flashes a cross');
  r = await rows(FIN);
  ok(r.length === 1 && r[0].title === 'Build' && r[0].state === 'error' && r[0].sub === 'Push rejected', 'it moves to RECENTLY FINISHED with its error', r);
  ok(await ev(() => window.__notes.some(n => n.id.startsWith('bg-') && n.title === 'Build failed' && n.text === 'Push rejected' && n.source === 'CodeMini')), 'it was out of sight, so a notification says it failed');
  await sleep(1400);
  ok(await ev(() => { const b = document.getElementById('nowIsland'); return !b.classList.contains('ni-flash') && b.classList.contains('has-running') && b.querySelector('.ni-run-count').textContent === '1'; }), 'the flash ends after about a second and the count drops to 1');
  await T('Second', 'finish', 'success', '3 files'); await sleep(250);
  r = await rows(FIN);
  ok(r.length === 2 && r[0].title === 'Second' && /^Finished in \d+ s, 3 files$/.test(r[0].sub), 'newest first, with how long it took', r);
  ok(await ev(() => !document.getElementById('nowIsland').classList.contains('has-running')), 'nothing running: the icon is back');
  ok(await ev(() => document.querySelector(RUN).hidden && !document.querySelector(FIN).hidden && document.querySelector(FIN + ' .sb-count-badge').textContent === '2'), 'the RUNNING section hides itself');
  await ev(() => document.querySelector(FIN + ' .ni-task button[aria-label="Dismiss"]').click()); await sleep(150);
  ok((await rows(FIN)).length === 1, 'Dismiss removes one finished task');
  await ev(() => document.querySelector(FIN + ' .sb-section-header .ni-link').click()); await sleep(150);
  ok((await rows(FIN)).length === 0 && await ev(() => document.querySelector('.ni-pane[data-pane="now"] .ni-empty') && !document.querySelector('.ni-pane[data-pane="now"] .ni-empty').hidden), 'Clear empties the list and the empty state returns');
  await closeIsland();

  console.log('\n[10] pin to screen: the floating Peek panel');
  await start('Deploy', { kind: 'git', stop: true, go: true });
  await start('Tests'); await start('Export'); await start('Install'); await sleep(250);
  await openIsland();
  await ev(() => { const li = [...document.querySelectorAll(RUN + ' .ni-task')].find(x => x.querySelector('.ni-task-title').textContent === 'Deploy'); li.querySelector('.ni-link').click(); });
  await T('Deploy', 'log', 'Uploading 3/12'); await sleep(250);
  await ev(() => document.querySelector('.ni-peek-actions button[aria-label="Pin to screen"]').click()); await sleep(150);
  ok(await ev(() => document.getElementById('niPeekDock').hidden), 'while the island is open the panel stays hidden (the rows are in front of the person)');
  ok(await ev(() => document.querySelector('.ni-peek-actions button[aria-pressed="true"]') !== null), 'the pin shows as pressed');
  await closeIsland(); await sleep(150);
  ok(await ev(() => !document.getElementById('niPeekDock').hidden && document.querySelectorAll('.ni-pp').length === 1), 'once the island closes the panel is on screen');
  const dk = await rect('#niPeekDock'), pp = await ev(() => { const p = document.querySelector('.ni-pp'), cs = getComputedStyle(p); return { z: getComputedStyle(document.getElementById('niPeekDock')).zIndex, bg: cs.backgroundColor, bw: cs.borderTopWidth, rad: cs.borderTopLeftRadius, sh: cs.boxShadow !== 'none', title: p.querySelector('.ni-pp-title').textContent, body: [...p.querySelectorAll('.ni-peek-line')].map(x => x.textContent), foot: p.querySelector('.ni-pp-foot').textContent, h: Math.round(p.getBoundingClientRect().height), btns: [...p.querySelectorAll('.ni-pp-head button')].map(b => b.getAttribute('aria-label')) }; });
  ok(dk.r === 15 && dk.b === 32 && dk.w === 320, 'bottom right: 15px from the right, 32px up, 320px wide', dk);
  ok(pp.z === '9998' && pp.bw === '1px' && pp.rad === '4px' && pp.sh, 'it has the island panel\'s surface, below the island (9998)', pp);
  ok(pp.title === 'Deploy' && pp.body.includes('Uploading 3/12') && /Running/.test(pp.foot) && pp.h <= 180, 'title, log tail and a footer, at most 180px tall', pp);
  ok(JSON.stringify(pp.btns) === JSON.stringify(['Go to', 'Keep open', 'Collapse', 'Close']), 'header icons: Go to, Keep open, Collapse, Close', pp.btns);
  ok(await ev(() => { const d = document.getElementById('niPeekDock'), r = d.getBoundingClientRect(); const el = document.elementFromPoint(r.left + 5, r.top - 2); return getComputedStyle(d).pointerEvents === 'none' && el !== d; }), 'clicks beside the panel pass through to the page');
  await T('Deploy', 'log', 'Uploading 4/12'); await sleep(300);
  ok(await ev(() => [...document.querySelectorAll('.ni-pp .ni-peek-line')].pop().textContent === 'Uploading 4/12'), 'the panel follows the task live');
  // Collapse
  await ev(() => document.querySelector('.ni-pp button[aria-label="Collapse"]').click()); await sleep(100);
  ok(await ev(() => { const p = document.querySelector('.ni-pp'); return p.classList.contains('collapsed') && getComputedStyle(p.querySelector('.ni-pp-body')).display === 'none' && p.querySelector('button[aria-label="Expand"]') !== null; }), 'Collapse shrinks it to the header line');
  await ev(() => document.querySelector('.ni-pp button[aria-label="Expand"]').click()); await sleep(100);
  // Drag
  const before = await rect('#niPeekDock');
  await ev(() => { const h = document.querySelector('.ni-pp-head'), r = h.getBoundingClientRect(), o = { bubbles: true, pointerId: 7, button: 0, clientX: r.left + 20, clientY: r.top + 8 }; h.dispatchEvent(new PointerEvent('pointerdown', o)); h.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, o, { clientX: r.left - 180, clientY: r.top - 120 }))); h.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, o, { clientX: r.left - 180, clientY: r.top - 120 }))); });
  await sleep(100);
  const after = await rect('#niPeekDock');
  ok(after.l < before.l - 150 && after.t < before.t - 100 && await ev(() => document.getElementById('niPeekDock').classList.contains('dragged')), 'dragging the header moves it', { before, after });
  await ev(() => { const h = document.querySelector('.ni-pp-head'), o = { bubbles: true, pointerId: 8, button: 0, clientX: 5, clientY: 5 }; h.dispatchEvent(new PointerEvent('pointerdown', o)); h.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, o, { clientX: -900, clientY: -900 }))); h.dispatchEvent(new PointerEvent('pointerup', o)); });
  const edge = await rect('#niPeekDock');
  ok(edge.l >= 0 && edge.t >= 0, 'it cannot be dragged off screen', edge);
  await ev(() => { document.getElementById('niPeekDock').classList.remove('dragged'); const d = document.getElementById('niPeekDock'); d.style.left = ''; d.style.top = ''; });
  // up to 3 then "+N more"
  await ev(() => { ['Tests', 'Export', 'Install'].forEach(n => window.CodeMiniBackground.pin(window.__t[n].id)); }); await sleep(150);
  ok(await ev(() => document.querySelectorAll('.ni-pp').length === 3 && /^\+1 more$/.test(document.querySelector('.ni-pp-more').textContent)), 'four pinned: three panels and "+1 more"');
  await ev(() => document.querySelector('.ni-pp-more').click()); await sleep(200);
  ok(await islandOpen() && await ev(() => document.querySelector('.ni-tab[data-pane="now"]').classList.contains('active')), '"+1 more" opens the island on the Now tab');
  ok(await ev(() => document.getElementById('niPeekDock').hidden), 'and the panels step aside');
  await closeIsland();
  // finish with an error: stays and offers Open
  await T('Deploy', 'finish', 'error', 'Auth failed'); await sleep(300);
  const ef = await ev(() => { const p = [...document.querySelectorAll('.ni-pp')].find(x => x.querySelector('.ni-pp-title').textContent === 'Deploy'); return { state: p.dataset.state, foot: p.querySelector('.ni-pp-foot').textContent, open: !!([...p.querySelectorAll('.ni-pp-foot .ni-link')].find(b => b.textContent === 'Open')), time: p.querySelector('.ni-pp-time').textContent }; });
  ok(ef.state === 'error' && /Auth failed/.test(ef.foot) && ef.open, 'a failure shows the error and an Open link', ef);
  await ev(() => [...document.querySelectorAll('.ni-pp')].find(x => x.querySelector('.ni-pp-title').textContent === 'Deploy').querySelector('.ni-pp-foot .ni-link').click()); await sleep(150);
  ok(await ev(() => window.__calls['Deploy:go'] === 1), 'Open goes to the task (its Go to)');
  // Esc inside the panel closes it, and only there
  await ev(() => { const p = document.querySelector('.ni-pp[data-id="' + window.__t['Tests'].id + '"]'); p.querySelector('button').focus(); p.querySelector('button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await sleep(150);
  ok(await ev(() => !window.CodeMiniBackground.isPinned(window.__t['Tests'].id)), 'Esc with focus in a panel closes (unpins) it');
  await ev(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await sleep(100);
  ok(await ev(() => window.CodeMiniBackground.isPinned(window.__t['Export'].id) && window.CodeMiniBackground.isPinned(window.__t['Install'].id)), 'Esc elsewhere does nothing to the others');
  ok(await ev(() => !window.CodeMiniBackground.get(window.__t['Tests'].id) || window.CodeMiniBackground.get(window.__t['Tests'].id).state === 'running'), 'closing a panel does not stop the task');
  // success fades unless kept
  await ev(() => document.querySelector('.ni-pp[data-id="' + window.__t['Export'].id + '"] button[aria-label="Keep open"]').click());
  await T('Export', 'finish', 'success', 'ok'); await T('Install', 'finish', 'success', 'ok');
  await sleep(500);
  ok(await ev(() => document.querySelector('.ni-pp[data-id="' + window.__t['Install'].id + '"]').dataset.state === 'success'), 'a finished panel shows its result');
  await sleep(8800);
  ok(await ev(() => !document.querySelector('.ni-pp[data-id="' + window.__t['Install'].id + '"]')), 'a success fades after 8 s');
  ok(await ev(() => !!document.querySelector('.ni-pp[data-id="' + window.__t['Export'].id + '"]')), 'unless it was kept');
  ok(await ev(() => window.CodeMiniBackground.finished().some(x => x.title === 'Install')), 'and it is still in RECENTLY FINISHED');
  ok(await ev(() => !!document.querySelector('.ni-pp[data-state="error"]')), 'the failed one is still there after all that time');
  await ev(() => { window.CodeMiniBackground.dismissAllFinished(); window.CodeMiniBackground.running().forEach(x => window.CodeMiniBackground.get(x.id) && window.__t && Object.values(window.__t).forEach(t => t.finish('stopped'))); }); await sleep(250);
  await ev(() => window.CodeMiniBackground.dismissAllFinished()); await sleep(150);

  console.log('\n[11] phone layout');
  await page.setViewportSize({ width: 390, height: 844 }); await sleep(200);
  await start('Phone1', { stop: true }); await start('Phone2'); await start('Phone3'); await sleep(250);
  await ev(() => ['Phone1', 'Phone2', 'Phone3'].forEach(n => window.CodeMiniBackground.pin(window.__t[n].id))); await sleep(200);
  const pd = await rect('#niPeekDock');
  ok(pd.l === 55 && pd.r === 10 && pd.b === 55, 'the dock is a strip beside the activity bar, 55px above the bottom', pd);
  ok(await ev(() => document.querySelectorAll('.ni-pp').length === 2 && /^\+1 more$/.test(document.querySelector('.ni-pp-more').textContent)), 'at most two show, then "+1 more"');
  const strip = await ev(() => [...document.querySelectorAll('.ni-pp')].map(p => ({ c: p.classList.contains('collapsed'), h: Math.round(p.getBoundingClientRect().height) })));
  ok(strip.every(s => s.c && s.h <= 40), 'each starts collapsed to a single line', strip);
  await ev(() => { const p = document.querySelector('.ni-pp'); p.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [new Touch({ identifier: 1, target: p, clientX: 100, clientY: 400 })] })); p.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [new Touch({ identifier: 1, target: p, clientX: 220, clientY: 405 })] })); });
  await sleep(200);
  ok(await ev(() => !window.CodeMiniBackground.isPinned(window.__t['Phone1'].id)), 'a swipe to the right dismisses a panel');
  await openIsland();
  const ph = await rect('#nowIslandPanel');
  ok(ph.h >= 340 && ph.h <= 342 && ph.l === 55 && ph.r === 10, 'the island keeps its phone place and its 340px minimum', ph);
  await ev(() => { for (let i = 0; i < 30; i++) window.CodeMiniBackground.start({ kind: 'run', title: 'Bulk ' + i, isHidden: () => true }); }); await sleep(300);
  const grown = await ev(() => { const p = document.getElementById('nowIslandPanel'), pane = document.querySelector('.ni-pane[data-pane="now"]'); return { h: Math.round(p.getBoundingClientRect().height), vh: innerHeight, scroll: pane.scrollHeight > pane.clientHeight + 5 }; });
  ok(grown.h <= Math.round(grown.vh * 0.6) + 1 && grown.h > 340 && grown.scroll, 'with 30 tasks it grows to at most 60vh and the list scrolls inside', grown);
  await closeIsland();
  await page.setViewportSize({ width: 1280, height: 800 }); await sleep(200);
  await openIsland();
  const grownD = await ev(() => { const p = document.getElementById('nowIslandPanel'); return { h: Math.round(p.getBoundingClientRect().height), vh: innerHeight }; });
  ok(grownD.h <= Math.round(grownD.vh * 0.72) + 1 && grownD.h > 290, 'on a desktop it stops at 72vh', grownD);
  await ev(() => { Object.values(window.__t).forEach(t => t.finish('stopped')); window.CodeMiniBackground.running().forEach(() => {}); });
  await closeIsland();

  console.log('\n[12] window tab spinner');
  await boot(); await sleep(300);
  await ev(() => { const bar = document.getElementById('windowBar'), t = document.createElement('div'); t.className = 'window-tab'; t.dataset.id = 'win_other'; t.textContent = 'Other'; bar.appendChild(t); });
  await ev(() => { window.__w = window.CodeMiniBackground.start({ kind: 'console', title: 'In other window', winId: 'win_other' }); }); await sleep(250);
  ok(await ev(() => document.querySelector('.window-tab[data-id="win_other"]').classList.contains('has-running')), 'a background window with a running task gets the spinner class');
  ok(await ev(() => { const cs = getComputedStyle(document.querySelector('.window-tab[data-id="win_other"]'), '::after'); return cs.animationName === 'niSpin' && cs.width === '9px'; }), 'drawn as a 9px ring');
  ok(await ev(() => !document.querySelector('.window-tab[data-id="win_default"]').classList.contains('has-running')), 'the active window\'s tab does not');
  await ev(() => { const bar = document.getElementById('windowBar'); const keep = bar.querySelector('[data-id="win_other"]'); bar.innerHTML = ''; bar.appendChild(keep.cloneNode(true)); }); await sleep(150);
  ok(await ev(() => document.querySelector('.window-tab[data-id="win_other"]').classList.contains('has-running')), 'it is put back when the window bar is rebuilt');
  await ev(() => window.__w.finish('success')); await sleep(250);
  ok(await ev(() => !document.querySelector('.window-tab[data-id="win_other"]').classList.contains('has-running')), 'and removed when the task ends');
  await ev(() => window.CodeMiniBackground.dismissAllFinished());

  console.log('\n[13] announcements');
  await ev(() => { localStorage.removeItem('codemini_notifications'); });
  await boot();
  await ev(() => { window.__n = []; window.CodeMiniNotifications.onChange(l => { window.__n = l; }); });
  await start('Watched', { fg: true }); await sleep(1100);
  await T('Watched', 'finish', 'success', 'fine'); await sleep(200);
  ok(await ev(() => window.__n.length === 0), 'a task the person was looking at is not announced');
  await start('Away', { stop: true }); await sleep(300);
  await T('Away', 'finish', 'success', '12 files'); await sleep(300);
  ok(await ev(() => window.__n.length === 1 && window.__n[0].title === 'Away finished' && /12 files/.test(window.__n[0].text)), 'one that ran out of sight is announced when it ends');
  ok(await ev(() => document.querySelectorAll('#notifToastStack .nt-toast').length === 1), 'with a toast, because the island is closed');
  await start('Mine', { stop: true }); await ev(() => window.CodeMiniBackground.stop(window.__t['Mine'].id)); await T('Mine', 'finish', 'stopped'); await sleep(250);
  ok(await ev(() => window.__n.length === 1), 'a Stop the person asked for is not announced');
  ok(await ev(() => { const b = document.getElementById('nowIsland'); return b.getAttribute('aria-label') === 'Now Island, 1 unread notification' && b.title === '1 unread'; }), 'with nothing running the button\'s label is the one it always had');

  console.log('\n[14] reduced motion');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await start('Calm'); await sleep(250);
  ok(await ev(() => getComputedStyle(document.querySelector('.ni-run-ring')).animationName === 'none'), 'the status-bar ring does not turn');
  await openIsland();
  ok(await ev(() => getComputedStyle(document.querySelector('.ni-task-bar.indeterminate > span')).animationName === 'none'), 'the shimmer is off');
  await T('Calm', 'finish'); await closeIsland();
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  const rel = errors.filter(e => !NOISE.test(e));
  ok(rel.length === 0, 'no unexpected page errors', rel);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
