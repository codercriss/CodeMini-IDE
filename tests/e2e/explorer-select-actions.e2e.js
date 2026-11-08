// Explorer status bar: while Multi-Select or the Download toggle is on, the right side swaps the sync status for
// three icons - Select all / Unselect all, Select all folders, Select all files.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); }; window.require.config = () => {};
  });
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.goto('http://localhost:8765/index.html'); await sleep(5200);
  const ev = (f, a) => page.evaluate(f, a);
  const shown = (sel) => ev((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0; }, sel);

  // Rows currently selected, by name and by which kind of selection marked them.
  const marked = (cls) => ev((c) => [...document.querySelectorAll('#fileList .file-item.' + c)].map(e => e.dataset.name || e.innerText.split('\n')[0].trim()).sort(), cls);
  const sel = () => marked('selected-file');
  const dsel = () => marked('download-selected-file');
  const title = (id) => ev((i) => document.getElementById(i).title, id);
  const active = (id) => ev((i) => document.getElementById(i).classList.contains('is-active'), id);
  const disabled = (id) => ev((i) => document.getElementById(i).disabled, id);
  const click = async (id) => { await ev((i) => document.getElementById(i).click(), id); await sleep(120); };
  const seed = (recs) => ev(async (rs) => {
    for (const r of rs) await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put(Object.assign({ timestamp: Date.now() }, r)); tx.oncomplete = res; });
    loadFilesFromDB();
  }, recs);

  // root: two folders (dirA empty, dirB with a file and a sub-folder) and three files
  await seed([
    { id: 'dirA', parentId: 'root', name: 'dirA', type: 'folder' },
    { id: 'dirB', parentId: 'root', name: 'dirB', type: 'folder' },
    { id: 'a', parentId: 'root', name: 'a.txt', type: 'file', content: '' },
    { id: 'b', parentId: 'root', name: 'b.txt', type: 'file', content: '' },
    { id: 'c', parentId: 'root', name: 'c.js', type: 'file', content: '' },
    { id: 'bf', parentId: 'dirB', name: 'inner.md', type: 'file', content: '' },
    { id: 'bd', parentId: 'dirB', name: 'sub', type: 'folder' },
  ]);
  await sleep(300);
  await ev(() => document.getElementById('folderIconItem').click()); await sleep(500);

  console.log('\n[idle: sync status, no selection icons]');
  ok(await shown('#explorerSyncStatus'), 'sync status is showing');
  ok(!(await shown('#explorerSelectActions')), 'selection icons are hidden');

  console.log('\n[Multi-Select on]');
  await ev(() => document.getElementById('multiSelectBtn').click()); await sleep(150);
  ok(!(await shown('#explorerSyncStatus')), 'sync status is replaced');
  ok(await shown('#explorerSelectActions'), 'selection icons appear in the status bar');
  ok((await ev(() => [...document.querySelectorAll('#explorerSelectActions .explorer-select-btn')].map(b => b.title))).join('|') === 'Select all|Select all folders|Select all files', 'three icons: select all / folders / files');
  ok(await ev(() => !!document.querySelector('#explorerStatusLeft') && getComputedStyle(document.getElementById('explorerStatusLeft')).display !== 'none'), 'left side (name + counts) is untouched');

  await click('selectAllFoldersBtn');
  ok(JSON.stringify(await sel()) === '["dirA","dirB"]', 'Select all folders: only folders', await sel());
  ok(await active('selectAllFoldersBtn') && !(await active('selectAllFilesBtn')) && !(await active('selectAllToggleBtn')), 'only the folders icon is lit');
  ok(await title('selectAllFoldersBtn') === 'Unselect all folders', 'its tooltip flips to Unselect');

  await click('selectAllFilesBtn');
  ok(JSON.stringify(await sel()) === '["a.txt","b.txt","c.js","dirA","dirB"]', 'adding Select all files: everything is selected', await sel());
  ok(await title('selectAllToggleBtn') === 'Unselect all' && await active('selectAllToggleBtn'), 'main icon becomes Unselect all');
  ok(await ev(() => document.getElementById('selectAllToggleBtn').firstElementChild.className) === 'ri-close-circle-line', 'and swaps its glyph');

  await click('selectAllFoldersBtn');
  ok(JSON.stringify(await sel()) === '["a.txt","b.txt","c.js"]', 'clicking folders again unselects just the folders', await sel());
  ok(await title('selectAllToggleBtn') === 'Select all', 'main icon is back to Select all');

  await click('selectAllToggleBtn');
  ok((await sel()).length === 5, 'Select all selects every row');
  await click('selectAllToggleBtn');
  ok((await sel()).length === 0 && await ev(() => selectedFiles.size === 0), 'Unselect all clears them (rows and the set)');

  console.log('\n[a single click keeps the icons honest]');
  await click('selectAllFilesBtn');
  await ev(() => [...document.querySelectorAll('#fileList .file-item')].find(e => e.dataset.name === 'b.txt').click()); await sleep(120);
  ok(!(await active('selectAllFilesBtn')) && await title('selectAllFilesBtn') === 'Select all files', 'deselecting one file turns Select all files back off');
  await click('selectAllFilesBtn');
  ok(JSON.stringify(await sel()) === '["a.txt","b.txt","c.js"]', 'and it selects only the missing one', await sel());
  await click('selectAllToggleBtn'); // everything selected? no - folders are not, so this selects the rest
  ok((await sel()).length === 5, 'Select all completes a partial selection');
  await click('selectAllToggleBtn');

  console.log('\n[only what is shown]');
  await ev(() => { currentExplorerSearch = 'a'; loadFilesFromDB(); }); await sleep(250);
  const shownNames = await ev(() => [...document.querySelectorAll('#fileList .file-item')].map(e => e.dataset.name).sort());
  await click('selectAllToggleBtn');
  ok(JSON.stringify(await sel()) === JSON.stringify(shownNames) && shownNames.length < 5, 'with a search filter, Select all takes only the matches', { shownNames, sel: await sel() });
  await ev(() => { currentExplorerSearch = ''; loadFilesFromDB(); }); await sleep(250);
  ok(await title('selectAllToggleBtn') === 'Select all', 'clearing the filter: not everything is selected any more');
  await click('selectAllToggleBtn'); await click('selectAllToggleBtn');

  console.log('\n[empty folder + leftover selection]');
  await click('selectAllToggleBtn'); // select all 5 in root
  await ev(() => { folderStack.push({ id: 'dirA', name: 'dirA' }); loadFilesFromDB(); }); await sleep(250);
  ok(await disabled('selectAllFoldersBtn') && await disabled('selectAllFilesBtn'), 'folders/files icons are disabled when there are none');
  ok(!(await disabled('selectAllToggleBtn')) && await title('selectAllToggleBtn') === 'Unselect all', 'main icon offers to clear the leftover selection');
  await click('selectAllToggleBtn');
  ok(await ev(() => selectedFiles.size === 0), 'and it does');
  ok(await disabled('selectAllToggleBtn'), 'with nothing shown and nothing selected it is disabled');
  await ev(() => { folderStack.pop(); loadFilesFromDB(); }); await sleep(250);

  console.log('\n[tree view: expanded rows count]');
  await ev(() => document.getElementById('treeViewBtn').click()); await sleep(200);
  await ev(() => { window.expandedFolders.add('dirB'); loadFilesFromDB(); }); await sleep(250);
  const treeNames = await ev(() => [...document.querySelectorAll('#fileList .file-item')].map(e => e.dataset.name).sort());
  ok(treeNames.includes('inner.md') && treeNames.includes('sub'), 'tree shows the nested rows', treeNames);
  await click('selectAllToggleBtn');
  ok(JSON.stringify(await sel()) === JSON.stringify(treeNames), 'Select all covers the nested rows too', await sel());
  await click('selectAllFilesBtn');
  ok(JSON.stringify(await sel()) === '["dirA","dirB","sub"]', 'with everything selected, the files icon (a toggle) unselects just the files; the folders stay', await sel());
  await click('selectAllToggleBtn'); await click('selectAllToggleBtn');
  await ev(() => document.getElementById('treeViewBtn').click()); await sleep(200);

  console.log('\n[Multi-Select off]');
  await click('selectAllToggleBtn');
  await ev(() => document.getElementById('multiSelectBtn').click()); await sleep(150);
  ok(await shown('#explorerSyncStatus') && !(await shown('#explorerSelectActions')), 'sync status is back, icons are gone');
  ok((await sel()).length === 0 && await ev(() => selectedFiles.size === 0), 'selection was cleared');

  console.log('\n[Download (export) toggle]');
  await ev(() => document.querySelector('.ri-download-line[title="Download"]').click()); await sleep(200);
  ok(await shown('#explorerSelectActions') && !(await shown('#explorerSyncStatus')), 'icons appear for the Download toggle too');
  ok(await shown('#explorerDownloadToolbar'), 'the Raw / JSON / ZIP bar is still there');
  ok(await ev(() => document.getElementById('dlRawBtn').disabled), 'Raw starts disabled (nothing selected)');
  await click('selectAllFilesBtn');
  ok(JSON.stringify(await dsel()) === '["a.txt","b.txt","c.js"]', 'Select all files marks the download selection', await dsel());
  ok((await sel()).length === 0 && await ev(() => selectedFiles.size === 0 && downloadSelectedFiles.size === 3), 'and leaves the Multi-Select set alone');
  ok(await ev(() => !document.getElementById('dlRawBtn').disabled), 'Raw is enabled once something is selected');
  await sleep(300); // the icon colour fades over 150ms
  ok(await ev(() => getComputedStyle(document.getElementById('selectAllFilesBtn')).color) === await ev(() => { const s = document.createElement('i'); s.style.color = 'var(--accent-new)'; document.body.appendChild(s); const c = getComputedStyle(s).color; s.remove(); return c; }), 'active icon uses the download teal');
  await click('selectAllToggleBtn');
  ok((await dsel()).length === 5, 'Select all takes everything');
  await click('selectAllToggleBtn');
  ok((await dsel()).length === 0 && await ev(() => document.getElementById('dlRawBtn').disabled), 'Unselect all empties it and disables Raw again');

  console.log('\n[both on: Download wins, like a row click]');
  await ev(() => document.getElementById('multiSelectBtn').click()); await sleep(150);
  await click('selectAllToggleBtn');
  ok((await dsel()).length === 5 && (await sel()).length === 0, 'with both on, the shortcuts fill the download selection');
  await ev(() => document.querySelector('.ri-download-line[title="Download"]').click()); await sleep(200);
  ok(await shown('#explorerSelectActions'), 'turning only Download off keeps the icons (Multi-Select is still on)');
  await click('selectAllToggleBtn');
  ok((await sel()).length === 5 && await ev(() => downloadSelectedFiles.size === 0), 'and they now drive the Multi-Select selection');
  await ev(() => document.getElementById('multiSelectBtn').click()); await sleep(150);
  ok(!(await shown('#explorerSelectActions')) && await shown('#explorerSyncStatus'), 'everything off: back to the sync status');

  console.log('\n[markup]');
  ok(await ev(() => [...document.querySelectorAll('#explorerSelectActions button')].every(b => b.type === 'button' && b.getAttribute('aria-label'))), 'icons are real buttons with accessible names');

  const rel = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i.test(e));
  ok(rel.length === 0, 'no unexpected page errors', rel);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
