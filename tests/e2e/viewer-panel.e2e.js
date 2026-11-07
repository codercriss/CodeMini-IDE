// The plot and table viewer panel (js/notebook/environments.js) in the real app: table sorting, filtering, statistics, copy and
// save formats, "show more", the shortcuts; plot fit / zoom / pan, background, thumbnails, navigation, copy and download.
// No editor is needed, so this runs the same with or without MONACO_DIR.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { setTimeout(() => { window.monaco = mk(); cb(); }, 0); }; window.require.config = () => {};
    // the clipboard is replaced by a recorder, so the test does not depend on browser permissions
    window.__clip = null; window.__clipItems = null;
    navigator.clipboard.writeText = (t) => { window.__clip = t; return Promise.resolve(); };
    navigator.clipboard.write = async (items) => { window.__clipItems = await Promise.all(items.map(async (it) => { const o = {}; for (const t of it.types) o[t] = (await it.getType(t)).size; return o; })); };
  });
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.goto('http://localhost:8765/index.html'); await sleep(3500);
  const ev = (f, a) => page.evaluate(f, a);
  const panelOpen = () => ev(() => { const c = document.getElementById('plotPreviewContainer'); return !!c && c.classList.contains('show') && c.style.display !== 'none'; });
  const cellsOf = (col) => ev((col) => Array.from(document.querySelectorAll('#plotPreviewContainer .pv-table tbody tr[data-ri]')).map(tr => tr.querySelector('td[data-c="' + col + '"]').textContent), col);
  const info = () => ev(() => document.getElementById('previewInfo').textContent);
  // the header icons come from an icon font (blocked in the test browser, so they have no size): they are clicked directly
  const hclick = (id) => ev((id) => document.getElementById(id).click(), id);
  const header = (name) => page.locator('#plotPreviewContainer .pv-table thead th', { hasText: name }).first();

  console.log('\n[table: open, columns, numbers]');
  await ev(() => window.openTableData({
    columns: ['id', 'name', 'score', 'note'],
    rows: [[1, 'alice', 90, 'a,b'], [2, 'Bob', 5, 'say "hi"'], [3, 'carol', null, null], [4, 'dave', 1200.5, 'x'], [5, 'Eve', 7, '<img src=x onerror="window.__xss=1">']],
    label: 'Test Table', cell: 'Cell 9'
  })); await sleep(500);
  ok(await panelOpen(), 'the panel opens');
  ok(await ev(() => document.getElementById('previewTitle').textContent) === 'Table Preview', 'it says Table Preview');
  ok(await info() === '5 rows \u00B7 4 columns', 'the status bar counts rows and columns', await info());
  ok(await ev(() => document.getElementById('plotFileName').textContent + '|' + document.getElementById('plotCellNum').textContent) === 'Test Table|Cell 9', 'it names what it shows');
  ok(await ev(() => !!document.querySelector('#plotPreviewContainer .pv-table th.pv-num') && !document.querySelector('#plotPreviewContainer .pv-table td[data-c="1"].pv-num') && !!document.querySelector('#plotPreviewContainer .pv-table td[data-c="2"].pv-num')), 'number columns are right-aligned, text columns are not');
  ok(await ev(() => document.querySelector('#plotPreviewContainer .pv-table td.pv-null').textContent) === 'NULL', 'empty values show as NULL');
  ok(await ev(() => !document.querySelector('#plotPreviewContainer .pv-table img') && window.__xss === undefined), 'a cell holding HTML is shown as text, never as markup');

  console.log('\n[table: sort]');
  await header('score').click(); await sleep(150);
  ok((await cellsOf(2)).join() === '5,7,90,1200.5,NULL', 'first click sorts ascending, numbers as numbers, empty last', await cellsOf(2));
  await header('score').click(); await sleep(150);
  ok((await cellsOf(2)).join() === '1200.5,90,7,5,NULL', 'second click sorts descending, empty still last', await cellsOf(2));
  ok(await ev(() => document.querySelector('#plotPreviewContainer .pv-table th[aria-sort="descending"]') !== null), 'the sorted column says which way (aria-sort)');
  await header('score').click(); await sleep(150);
  ok((await cellsOf(2)).join() === '90,5,NULL,1200.5,7', 'third click goes back to the original order', await cellsOf(2));
  await header('name').click(); await sleep(150);
  ok((await cellsOf(1)).join() === 'alice,Bob,carol,dave,Eve', 'text sorts case-insensitively', await cellsOf(1));

  console.log('\n[table: filter]');
  await page.fill('#pvSearch', 'bo'); await sleep(200);
  ok((await cellsOf(1)).join() === 'Bob' && await info() === '1 of 5 rows \u00B7 4 columns', 'typing filters the rows and the count says so', [await cellsOf(1), await info()]);
  await page.fill('#pvSearch', 'name:ali'); await sleep(200);
  ok((await cellsOf(1)).join() === 'alice', 'column:text filters one column', await cellsOf(1));
  await page.fill('#pvSearch', 'name:90'); await sleep(200);
  ok((await cellsOf(1)).length === 0 && await ev(() => !!document.querySelector('#plotPreviewContainer .pv-empty')), 'no match says so instead of an empty grid');
  await page.fill('#pvSearch', 'null'); await sleep(200);
  ok((await cellsOf(1)).join() === 'carol', 'empty values can be found with "null"', await cellsOf(1));
  await page.fill('#pvSearch', ''); await sleep(200);

  console.log('\n[table: statistics, row numbers, density, text size]');
  await page.locator('#plotPreviewContainer button[data-pv="stats"]').click(); await sleep(150);
  const foot = await ev(() => document.querySelector('#plotPreviewContainer .pv-table tfoot').textContent);
  ok(/sum 1,302\.5/.test(foot) && /avg 325\.625/.test(foot) && /min 5/.test(foot) && /max 1,200\.5/.test(foot) && /1 empty/.test(foot), 'the statistics row has sum, average, min, max and empty counts', foot);
  await page.fill('#pvSearch', 'e'); await sleep(200);
  ok(/5 distinct|\d distinct/.test(await ev(() => document.querySelector('#plotPreviewContainer .pv-table tfoot').textContent)), 'statistics follow the rows shown');
  await page.fill('#pvSearch', ''); await sleep(150);
  await page.locator('#plotPreviewContainer button[data-pv="rowNum"]').click(); await sleep(150);
  ok(await ev(() => !document.querySelector('#plotPreviewContainer .pv-table td.pv-rn')), 'row numbers can be hidden');
  await page.locator('#plotPreviewContainer button[data-pv="rowNum"]').click(); await sleep(150);
  ok(await ev(() => document.querySelector('#plotPreviewContainer .pv-table td.pv-rn').textContent) === '1', 'and shown again');
  await page.locator('#plotPreviewContainer button[data-pv="compact"]').click(); await sleep(150);
  ok(await ev(() => document.querySelector('#plotPreviewContainer .pv-table').classList.contains('pv-compact')), 'compact rows can be switched on');
  await page.locator('#plotPreviewContainer button[data-pv="compact"]').click(); await sleep(100);
  const fs0 = await ev(() => parseFloat(document.querySelector('#plotPreviewContainer .pv-table').style.fontSize));
  await hclick('plotZoomIn'); await sleep(150);
  ok(await ev(() => parseFloat(document.querySelector('#plotPreviewContainer .pv-table').style.fontSize)) === fs0 + 1, 'the header zoom icons change the text size for a table');

  console.log('\n[table: copy and save]');
  await page.locator('#plotPreviewContainer .pv-btn', { hasText: 'TSV' }).click(); await sleep(200);
  ok((await ev(() => window.__clip)).split('\n')[0] === 'id\tname\tscore\tnote', 'Copy TSV starts with the header row', await ev(() => window.__clip));
  await page.locator('#plotPreviewContainer .pv-btn', { hasText: 'Markdown' }).click(); await sleep(200);
  const md = await ev(() => window.__clip).then(s => s.split('\n'));
  ok(md[0] === '| id | name | score | note |' && md[1] === '| ---: | --- | ---: | --- |' && md[2].startsWith('| 1 | alice | 90 |'), 'Copy Markdown makes an aligned table', md.slice(0, 3));
  await page.locator('#plotPreviewContainer .pv-btn', { hasText: 'JSON' }).first().click(); await sleep(200);
  const js = JSON.parse(await ev(() => window.__clip));
  ok(js.length === 5 && js[0].score === 90 && js[2].score === null && js[1].note === 'say "hi"' && js[0].name === 'alice', 'Copy JSON makes objects with real numbers and nulls', js[0]);
  await header('score').click(); await sleep(150);   // ascending
  await page.locator('#plotPreviewContainer .pv-btn', { hasText: 'TSV' }).click(); await sleep(200);
  ok((await ev(() => window.__clip)).split('\n').slice(1, 3).map(l => l.split('\t')[2]).join() === '5,7', 'copies follow the sort order', await ev(() => window.__clip));
  await page.fill('#pvSearch', 'a'); await sleep(200);
  await page.locator('#plotPreviewContainer .pv-btn', { hasText: 'TSV' }).click(); await sleep(200);
  ok((await ev(() => window.__clip)).trim().split('\n').length - 1 === (await cellsOf(1)).length, 'and the filter', [await ev(() => window.__clip), await cellsOf(1)]);
  await page.fill('#pvSearch', ''); await sleep(150);
  const dl = page.waitForEvent('download');
  await page.locator('#plotPreviewContainer .pv-btn', { hasText: 'CSV' }).click();
  const d = await dl;
  const csv = require('fs').readFileSync(await d.path(), 'utf8');
  ok(/^table_\d{8}-\d{6}\.csv$/.test(d.suggestedFilename()), 'Save CSV downloads a timestamped .csv file', d.suggestedFilename());
  ok(csv.split('\n')[0] === 'id,name,score,note' && csv.includes('"a,b"') && csv.includes('"say ""hi"""'), 'CSV quotes commas and quotes properly', csv);
  const dl2 = page.waitForEvent('download');
  await hclick('plotDownload');
  ok(/\.csv$/.test((await dl2).suggestedFilename()), 'the header download icon saves CSV for a table');

  console.log('\n[table: a double-click copies a cell, "/" finds, Esc closes]');
  await page.locator('#plotPreviewContainer .pv-table td[data-c="1"]', { hasText: 'alice' }).dblclick(); await sleep(250);
  ok(await ev(() => window.__clip) === 'alice', 'double-clicking a cell copies its value', await ev(() => window.__clip));
  await page.locator('#plotPreviewContainer .pv-table td[data-c="1"]').first().click(); await sleep(100);
  await page.keyboard.press('/'); await sleep(100);
  ok(await ev(() => document.activeElement && document.activeElement.id) === 'pvSearch', '/ jumps to the filter box');
  await page.keyboard.type('zz'); await sleep(150);
  await page.keyboard.press('Escape'); await sleep(150);
  ok(await ev(() => document.getElementById('pvSearch').value) === '' && await panelOpen(), 'Esc in the filter box clears it first and keeps the panel open');
  await page.keyboard.press('Escape'); await sleep(500);
  ok(!(await panelOpen()), 'a second Esc closes the panel');

  console.log('\n[table: a notebook SQL table, and a long one]');
  await ev(() => {
    const host = document.createElement('div'); host.id = 'fakeSql';
    host.innerHTML = '<table id="sql-t1"><thead><tr><th>k</th><th>v</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td><em>NULL</em></td></tr></tbody></table>';
    document.body.appendChild(host);
    window.openTablePreview('sql-t1', 'Cell 4');
  }); await sleep(500);
  ok(await ev(() => document.getElementById('plotFileName').textContent + '|' + document.getElementById('plotCellNum').textContent) === 'SQL Table|Cell 4', 'openTablePreview still works for SQL results');
  ok((await cellsOf(1)).join() === '1,NULL' && await ev(() => document.querySelectorAll('#plotPreviewContainer .pv-null').length) === 1, 'and keeps NULL apart from text', await cellsOf(1));
  await ev(() => window.openTableData({ columns: ['n'], rows: Array.from({ length: 1200 }, (_, i) => [i]) })); await sleep(400);
  ok(await ev(() => document.querySelectorAll('#plotPreviewContainer .pv-table tbody tr[data-ri]').length) === 500 && await info() === '1,200 rows \u00B7 1 column', 'a long table draws the first 500 rows', [await info()]);
  await page.locator('#plotPreviewContainer [data-more]').click(); await sleep(300);
  ok(await ev(() => document.querySelectorAll('#plotPreviewContainer .pv-table tbody tr[data-ri]').length) === 1200 && await ev(() => !document.querySelector('#plotPreviewContainer [data-more]')), 'Show more draws the rest');
  await ev(() => document.getElementById('plotCloseBtn').click()); await sleep(500);

  console.log('\n[plot: open, fit, zoom, pan]');
  await ev(() => {
    const png = (w, h, color) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h); return c.toDataURL('image/png'); };
    window.__p1 = png(800, 400, '#c33'); window.__p2 = png(300, 600, '#36c'); window.__p3 = png(2400, 1600, '#3a3');
    document.querySelectorAll('.content-pane').forEach(p => p.classList.remove('active'));
    const pane = document.createElement('div'); pane.className = 'content-pane active'; pane.id = 'fakeNbPane';
    pane.innerHTML = '<div class="cells-container">' + [window.__p1, window.__p2, window.__p3].map(s => '<div class="cell"><img class="output-plot-img" src="' + s + '"></div>').join('') + '</div>';
    document.body.appendChild(pane);
    window.openPlotPreview(window.__p3, pane.querySelector('.cell'));
  }); await sleep(800);
  const view = () => ev(() => { const i = document.getElementById('plotPreviewImg'), a = document.getElementById('previewContentArea'); const m = new DOMMatrix(getComputedStyle(i).transform); const r = i.getBoundingClientRect(), ar = a.getBoundingClientRect(); return { z: Math.round(m.a * 1000) / 1000, x: Math.round(m.e), y: Math.round(m.f), left: Math.round(r.left - ar.left), right: Math.round(ar.right - r.right), top: Math.round(r.top - ar.top), bottom: Math.round(ar.bottom - r.bottom), aw: a.clientWidth }; });
  ok(await panelOpen() && await ev(() => document.getElementById('previewTitle').textContent) === 'Plot Preview', 'the plot panel opens on the plot that was clicked');
  ok(await info() === '3 / 3 \u00B7 2400\u00D71600 \u00B7 ' + Math.round((await view()).z * 100) + '%', 'the status bar has position, pixel size and zoom', await info());
  let v = await view();
  ok(v.z < 0.4 && Math.abs(v.left - v.right) <= 2 && Math.abs(v.top - v.bottom) <= 2, 'a big plot starts fitted to the panel and centred', v);
  ok(await ev(() => document.querySelectorAll('#pvThumbs .pv-thumb').length) === 3 && await ev(() => document.querySelectorAll('#pvThumbs .pv-thumb')[2].classList.contains('active')), 'a thumbnail strip appears when there is more than one plot');
  await page.locator('#plotPreviewContainer .pv-btn', { hasText: '100%' }).click(); await sleep(200);
  v = await view(); ok(v.z === 1, '100% shows the actual pixels', v);
  await hclick('plotZoomIn'); await sleep(150);
  v = await view(); ok(v.z === 1.25, 'zoom in steps by a quarter', v);
  await hclick('plotZoomOut'); await hclick('plotZoomOut'); await sleep(150);
  v = await view(); ok(Math.abs(v.z - 0.8) < 0.001, 'and zoom out steps back', v);
  await page.locator('#plotPreviewContainer .pv-btn', { hasText: '100%' }).click(); await sleep(150);
  const box = await ev(() => { const r = document.getElementById('previewContentArea').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const before = await view();
  await page.mouse.move(box.x, box.y); await page.mouse.wheel(0, -300); await sleep(200);
  v = await view(); ok(v.z > before.z, 'the wheel zooms in', [before.z, v.z]);
  await page.mouse.wheel(0, 900); await sleep(200);
  v = await view(); ok(v.z < before.z, 'and zooms out', [before.z, v.z]);
  await page.locator('#plotPreviewContainer .pv-btn', { hasText: '100%' }).click(); await sleep(150);
  const p0 = await view();
  await page.mouse.move(box.x, box.y); await page.mouse.down(); await page.mouse.move(box.x - 120, box.y - 70, { steps: 6 }); await page.mouse.up(); await sleep(150);
  v = await view(); ok(v.x === p0.x - 120 && v.y === p0.y - 70, 'dragging pans a zoomed plot', [p0, v]);
  await page.mouse.move(box.x, box.y); await page.mouse.down(); await page.mouse.move(box.x + 5000, box.y + 5000, { steps: 4 }); await page.mouse.up(); await sleep(150);
  v = await view(); ok(v.left <= 41 && v.top <= 41, 'the plot can not be dragged out of reach', v);
  await page.mouse.dblclick(box.x, box.y); await sleep(200);
  v = await view(); ok(v.z < 0.4 && Math.abs(v.left - v.right) <= 2, 'double-click goes back to Fit', v);
  await page.mouse.dblclick(box.x, box.y); await sleep(200);
  v = await view(); ok(v.z === 1, 'and a second double-click goes to 100%', v);
  await page.locator('#plotPreviewContainer .pv-btn', { hasText: 'Fit' }).click(); await sleep(150);

  console.log('\n[plot: navigation, background, copy, download, keyboard]');
  await ev(() => document.getElementById('plotPreviewContainer').focus());
  await page.keyboard.press('ArrowLeft'); await sleep(300);
  ok((await info()).startsWith('2 / 3 \u00B7 300\u00D7600') && await ev(() => document.getElementById('plotCellNum').textContent) === 'Cell 2', 'the left arrow key goes to the previous plot', await info());
  v = await view(); ok(v.z === 1 || v.z > 0.9, 'and a small plot is not blown up past its size', v);
  await hclick('plotNavBack'); await sleep(300);
  ok((await info()).startsWith('1 / 3 \u00B7 800\u00D7400') && await ev(() => document.getElementById('plotNavBack').classList.contains('disabled')), 'the Back arrow goes to the first, and disables itself there', await info());
  await page.locator('#pvThumbs .pv-thumb').nth(2).click(); await sleep(300);
  ok((await info()).startsWith('3 / 3'), 'a thumbnail jumps to its plot', await info());
  const bgOf = () => ev(() => ['white', 'dark', 'checker'].filter(b => document.getElementById('previewContentArea').classList.contains('pv-bg-' + b)).join());
  const bg0 = await bgOf();
  await page.locator('#pvBgBtn').click(); const bg1 = await bgOf(); await page.locator('#pvBgBtn').click(); const bg2 = await bgOf(); await page.locator('#pvBgBtn').click(); const bg3 = await bgOf();
  ok(new Set([bg0, bg1, bg2]).size === 3 && bg3 === bg0, 'the background button cycles white, dark and checkerboard', [bg0, bg1, bg2, bg3]);
  await page.keyboard.press('b'); ok(await bgOf() !== bg0, 'B changes the background from the keyboard');
  await page.keyboard.press('b'); await page.keyboard.press('b');
  await page.keyboard.press('1'); await sleep(150); v = await view(); ok(v.z === 1, '1 goes to 100%', v);
  await page.keyboard.press('0'); await sleep(150); v = await view(); ok(v.z < 0.4, '0 fits', v);
  await page.keyboard.press('+'); await sleep(100); const vz = await view(); ok(vz.z > v.z, '+ zooms in', [v.z, vz.z]);
  await page.locator('#plotPreviewContainer .pv-btn', { hasText: 'Copy' }).click(); await sleep(400);
  const items = await ev(() => window.__clipItems);
  ok(items && items[0] && items[0]['image/png'] > 100, 'Copy puts a PNG on the clipboard', items);
  const dl3 = page.waitForEvent('download');
  await page.locator('#plotPreviewContainer .pv-btn', { hasText: 'PNG' }).click();
  ok(/^plot_export_\d+\.png$/.test((await dl3).suggestedFilename()), 'the PNG button downloads the plot');
  await ev(() => document.getElementById('plotPreviewContainer').focus());
  await page.keyboard.press('Escape'); await sleep(500);
  ok(!(await panelOpen()) && await ev(() => PV.mode === null && PV.P === null && document.getElementById('previewContentArea').childElementCount === 0), 'Esc closes the panel and it lets go of what it held');
  await ev(() => { const p = document.getElementById('fakeNbPane'); p.remove(); window.openPlotPreview(window.__p1, null); }); await sleep(600);
  ok(await panelOpen() && await ev(() => document.querySelectorAll('#pvThumbs .pv-thumb').length) === 0 && await ev(() => document.getElementById('pvThumbs').hidden), 'a single plot with no notebook around it still opens, with no thumbnail strip');

  console.log('\n[phone]');
  await ev(() => document.getElementById('plotCloseBtn').click()); await sleep(500);
  await page.setViewportSize({ width: 390, height: 800 }); await sleep(300);
  await ev(() => window.openTableData({ columns: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], rows: [[1, 2, 3, 4, 5, 6, 7, 8]] })); await sleep(500);
  ok(await ev(() => { const c = document.getElementById('plotPreviewContainer').getBoundingClientRect(); const t = document.getElementById('pvToolbar'); return c.width <= innerWidth + 1 && t.scrollWidth > t.clientWidth && getComputedStyle(t).overflowX === 'auto'; }), 'on a phone the panel fits the screen and the toolbar scrolls sideways instead of overflowing');
  ok(await ev(() => getComputedStyle(document.getElementById('pvSearch')).fontSize) === '16px', 'the filter box is 16px so iOS does not zoom the page when it is tapped');

  const rel = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined|importScripts|\[object Event\]/i.test(e));
  ok(rel.length === 0, 'no unexpected page errors', rel);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
