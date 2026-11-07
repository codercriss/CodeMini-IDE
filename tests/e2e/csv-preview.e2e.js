// The CSV / TSV file preview (__cmCsvViewerMain in js/viewers/preview.js): the real preview in the app, then the viewer on its own
// with many kinds of files - quotes, separators, a BOM, ragged rows, sorting, filtering, statistics, copy formats, long files.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };

// the viewer's own source, so it can be run in a bare page
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'viewers', 'preview.js'), 'utf8');
const at = src.indexOf('function __cmCsvViewerMain() {');
let depth = 0, end = -1;
for (let i = src.indexOf('{', at); i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } } }
const VIEWER = src.slice(at, end);

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  console.log('\n[in the app]');
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { setTimeout(() => { window.monaco = mk(); cb(); }, 0); }; window.require.config = () => {};
  });
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.goto('http://localhost:8765/index.html'); await sleep(3500);
  await page.evaluate(async () => {
    const csv = 'id;name;price;note\n1;"Smith, Anna";12.5;"said ""hi"""\n2;Bob;7;\n3;<b>Eve</b><img src=x onerror="window.__x=1">;1200;multi\n4;Dan;;"line1\nline2"\n';
    const f = { id: 'csv1', parentId: 'root', name: 'data.csv', type: 'file', content: csv, timestamp: Date.now() };
    await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put(f); tx.oncomplete = res; });
    window.__csv = csv; openFileInTab(f);
    // the editor is a stand-in in this test, so the preview is given the text through it
    window.monaco = { editor: { getEditors: () => [{ getContainerDomNode: () => document.querySelector('[id^="editor-container-"]'), getValue: () => window.__csv }] } };
  });
  await sleep(800);
  await page.evaluate(() => document.getElementById('playIconItem').click()); await sleep(2500);
  const app = await page.evaluate(() => { const d = document.getElementById('lpIframe').contentDocument; return { info: d.querySelector('.info').textContent, head: Array.from(d.querySelectorAll('thead th')).map(t => t.textContent), rows: Array.from(d.querySelectorAll('tbody tr')).map(tr => Array.from(tr.querySelectorAll('td:not(.rn)')).map(td => td.textContent)), tags: d.querySelectorAll('tbody b, tbody img').length, xss: window.__x, frameXss: document.getElementById('lpIframe').contentWindow.__x }; });
  ok(app.info === '4 rows \u00B7 4 columns \u00B7 semicolon', 'the preview opens the file and finds the ; separator itself', app.info);
  ok(app.head.join('|') === '#|id|name|price|note', 'the first row becomes the column names', app.head);
  ok(app.rows[0][1] === 'Smith, Anna' && app.rows[0][3] === 'said "hi"', 'a quoted field keeps its comma, and "" becomes a quote', app.rows[0]);
  ok(app.rows[3][3] === 'line1\nline2', 'a quoted field can hold a line break', app.rows[3]);
  ok(app.tags === 0 && app.xss === undefined && app.frameXss === undefined && app.rows[2][1].startsWith('<b>Eve</b>'), 'HTML in a cell stays text and nothing runs', app.rows[2]);
  await page.close();

  console.log('\n[the viewer on its own]');
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  async function open(csv) {
    const p = await ctx.newPage();
    await p.setContent('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><textarea id="raw-csv" style="display:none"></textarea></body></html>');
    // the clipboard is replaced by a recorder (setContent does not run init scripts, so it is done here)
    await p.evaluate(() => { window.__clip = null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => { window.__clip = t; return Promise.resolve(); } }, configurable: true }); });
    await p.evaluate((c) => { document.getElementById('raw-csv').value = c; }, csv);
    await p.addScriptTag({ content: '(' + VIEWER + ')();' });
    const q = {
      head: () => p.evaluate(() => Array.from(document.querySelectorAll('thead th:not(.rn)')).map(t => t.firstChild.textContent)),
      col: (c) => p.evaluate((c) => Array.from(document.querySelectorAll('tbody tr[data-ri]')).map(tr => tr.querySelector('td[data-c="' + c + '"]').textContent), c),
      info: () => p.evaluate(() => document.querySelector('.info').textContent),
      th: (name) => p.locator('thead th', { hasText: name }).first(),
      btn: (name) => p.locator('.bar button', { hasText: name }).first(),
      clip: () => p.evaluate(() => window.__clip)
    };
    return { p, q };
  }

  let { p, q } = await open('\uFEFFname,qty,price\r\nwidget,10,2.50\r\ngadget,3,\r\n"ba,r",25,10\r\n');
  ok((await q.head()).join() === 'name,qty,price', 'a BOM is dropped and CRLF line ends work', await q.head());
  ok((await q.col(0)).join('|') === 'widget|gadget|ba,r', 'rows are split right', await q.col(0));
  ok(await q.info() === '3 rows \u00B7 3 columns \u00B7 comma', 'the status line counts rows, columns and the separator', await q.info());
  await q.th('qty').click();
  ok((await q.col(1)).join() === '3,10,25', 'numbers sort as numbers (not 10, 25, 3)', await q.col(1));
  await q.th('qty').click();
  ok((await q.col(1)).join() === '25,10,3', 'descending', await q.col(1));
  await q.th('price').click();
  ok((await q.col(2)).join() === '2.50,10,', 'empty cells sort last', await q.col(2));
  await q.th('price').click();
  ok((await q.col(2)).join() === '10,2.50,', 'and stay last when descending', await q.col(2));
  await q.th('price').click(); await q.th('name').click();
  ok((await q.col(0)).join('|') === 'ba,r|gadget|widget', 'text sorts alphabetically', await q.col(0));
  await p.fill('input[type=search]', 'ad'); await sleep(150);
  ok((await q.col(0)).join('|') === 'gadget' && await q.info() === '1 of 3 rows \u00B7 3 columns \u00B7 comma', 'the filter box narrows the rows', [await q.col(0), await q.info()]);
  await p.fill('input[type=search]', 'qty:25'); await sleep(150);
  ok((await q.col(0)).join('|') === 'ba,r', 'column:text filters one column', await q.col(0));
  await p.fill('input[type=search]', ''); await sleep(100);
  await q.btn('Stats').click();
  const foot = await p.evaluate(() => document.querySelector('tfoot').textContent);
  ok(/sum 38/.test(foot) && /avg 12\.6667/.test(foot) && /min 3/.test(foot) && /max 25/.test(foot) && /sum 12\.5/.test(foot) && /1 empty/.test(foot), 'statistics: sum, average, min, max, empty', foot);
  await q.btn('TSV').click(); await sleep(250);
  ok((await q.clip()).split('\n')[0] === 'name\tqty\tprice' && (await q.clip()).split('\n').length === 5, 'Copy TSV', await q.clip());
  await q.btn('Markdown').click(); await sleep(250);
  ok((await q.clip()).split('\n').slice(0, 2).join('/') === '| name | qty | price |/| --- | ---: | ---: |', 'Copy Markdown with right-aligned number columns', await q.clip());
  await q.btn('JSON').click(); await sleep(250);
  const js = JSON.parse(await q.clip());
  const by = (n) => js.find(o => o.name === n) || {};
  ok(js.length === 3 && by('widget').qty === 10 && by('widget').price === 2.5 && by('gadget').price === null && js[0].name === 'ba,r', 'Copy JSON gives numbers and nulls, in the order shown (sorted by name here)', js);
  await p.locator('tbody td[data-c="0"]', { hasText: 'gadget' }).dblclick(); await sleep(250);
  ok(await q.clip() === 'gadget', 'double-click copies a cell', await q.clip());
  await q.btn('# Rows').click();
  ok(await p.evaluate(() => !document.querySelector('td.rn')), 'row numbers can be turned off');
  await p.close();

  ({ p, q } = await open('a\tb\tc\n1\t2\t3\n4\t5\n'));
  ok(await q.info() === '2 rows \u00B7 3 columns \u00B7 tab', 'a tab separated file is recognised', await q.info());
  ok((await q.col(2)).join('|') === '3|', 'a short row is padded, not dropped', await q.col(2));
  await p.close();

  ({ p, q } = await open('x|y\n1|2\n3|4\n'));
  ok((await q.info()).endsWith('pipe'), 'a pipe separated file is recognised', await q.info());
  await p.selectOption('select', ',');
  ok(await q.info() === '2 rows \u00B7 1 column \u00B7 comma' && (await q.head()).join() === 'x|y', 'the separator can be chosen by hand', [await q.info(), await q.head()]);
  await p.close();

  ({ p, q } = await open('1,2,3\n4,5,6\n'));
  ok((await q.head()).join() === 'column 1,column 2,column 3' && await q.info() === '2 rows \u00B7 3 columns \u00B7 comma', 'a first row of numbers is data, not a header', [await q.head(), await q.info()]);
  await q.btn('Header').click();
  ok((await q.head()).join() === '1,2,3' && (await q.col(0)).join() === '4', 'the Header button makes the first row the names', [await q.head(), await q.col(0)]);
  await p.close();

  ({ p, q } = await open('n,v\n' + Array.from({ length: 1200 }, (_, i) => i + ',' + (i * 2)).join('\n') + '\n'));
  ok((await q.col(0)).length === 500 && await q.info() === '1,200 rows \u00B7 2 columns \u00B7 comma', 'a long file draws the first 500 rows', await q.info());
  await p.locator('[data-more]').click(); await sleep(200);
  ok((await q.col(0)).length === 1200 && await p.evaluate(() => !document.querySelector('[data-more]')), 'Show more draws the rest');
  await p.close();

  ({ p, q } = await open(''));
  ok(await p.evaluate(() => document.querySelector('tbody').textContent) === 'This file is empty', 'an empty file says so', await p.evaluate(() => document.querySelector('tbody').textContent));
  await p.close();

  ({ p, q } = await open('only,a,header\n'));
  ok(await p.evaluate(() => document.querySelector('tbody').textContent) === 'No data rows' || (await q.info()).startsWith('1 rows'), 'a single line does not break it', await p.evaluate(() => document.querySelector('tbody').textContent));
  await p.close();

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
