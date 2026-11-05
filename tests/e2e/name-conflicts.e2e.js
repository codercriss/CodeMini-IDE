// Name clashes in the real app (js/core/name-conflicts.js): Copy/Cut + Paste through the Explorer's own right-click
// menus, multi-select, "apply to all", Stop, drag-and-drop, imports, a workspace in another database, the Recycle Bin,
// locked items and open tabs. Monaco is stubbed (its CDN is blocked here).
const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (deps, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); };
    window.require.config = () => {};
  });
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.goto('http://localhost:8765/index.html'); await sleep(5200);
  const ev = (f, a) => page.evaluate(f, a);
  if (!(await ev(() => document.getElementById('sidebar') && document.getElementById('sidebar').offsetWidth > 100))) { await ev(() => document.getElementById('folderIconItem').click()); await sleep(900); }

  // ---- the project the scenarios start from (rebuilt before each one)
  const T1 = 1000000000000, T2 = 1700000000000; // an old and a recent last-modified time
  const reset = async (extra) => {
    await ev(async ({ T1, T2, extra }) => {
      await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').clear(); tx.oncomplete = res; });
      const recs = [
        { id: 'dB', parentId: 'root', name: 'B', type: 'folder', timestamp: T2 },
        { id: 'r1', parentId: 'root', name: 'one.txt', type: 'file', content: 'ONE-root', timestamp: T2 },
        { id: 'r2', parentId: 'root', name: 'two.txt', type: 'file', content: 'TWO-root', timestamp: T2 },
        { id: 'r3', parentId: 'root', name: 'three.txt', type: 'file', content: 'THREE-root', timestamp: T2 },
        { id: 'b1', parentId: 'dB', name: 'one.txt', type: 'file', content: 'ONE-B', timestamp: T1 },
        { id: 'b2', parentId: 'dB', name: 'two.txt', type: 'file', content: 'TWO-B', timestamp: T1 },
        { id: 'bk', parentId: 'dB', name: 'keep.txt', type: 'file', content: 'KEEP', timestamp: T1 }
      ].concat(extra || []);
      await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); recs.forEach(r => tx.objectStore('filesystem').put(r)); tx.oncomplete = res; });
      window.recycleBin.length = 0; delete window.workspaceClipboardRegistry[cellActiveWindow.id];
      if (isMultiSelectMode) document.getElementById('multiSelectBtn').click();
      selectedFiles.clear();
      folderStack = [folderStack[0]]; loadFilesFromDB();
    }, { T1, T2, extra });
    await sleep(500);
  };
  const recs = () => ev(() => new Promise(res => { const tx = db.transaction('filesystem', 'readonly'); tx.objectStore('filesystem').getAll().onsuccess = (e) => res(e.target.result.map(r => ({ id: r.id, p: r.parentId, n: r.name, c: r.content }))); }));
  const inB = async () => (await recs()).filter(r => r.p === 'dB').map(r => `${r.n}=${r.c}`).sort();
  const atRoot = async () => (await recs()).filter(r => r.p === 'root').map(r => r.n).sort();
  const row = (name) => page.locator('.file-item', { hasText: name }).first();
  const menu = async (name, option) => { await row(name).click({ button: 'right' }); await sleep(250); await page.locator('.dropdown-item', { hasText: new RegExp('^\\s*' + option + '\\s*$') }).first().click(); await sleep(250); };
  const dialogOpen = () => ev(() => !!document.querySelector('.cf-modal.show'));
  const waitDialog = async () => { await page.waitForSelector('.cf-modal.show', { timeout: 4000 }); await sleep(250); };
  const dlg = () => ev(() => { const d = document.querySelector('.cf-modal.show'); if (!d) return null; return { title: d.querySelector('h3').textContent, lead: d.querySelector('.cf-lead').textContent, text: d.innerText, rows: [...d.querySelectorAll('.cf-row')].map(r => ({ tag: r.querySelector('.cf-tag').textContent, name: r.querySelector('.cf-name').textContent, meta: r.querySelector('.cf-meta').textContent, badge: (r.querySelector('.cf-badge') || {}).textContent || '' })), buttons: [...d.querySelectorAll('.cf-actions button')].map(b => ({ t: b.textContent, disabled: b.disabled })), hasApply: !!d.querySelector('#cfApplyAll'), focus: document.activeElement && document.activeElement.textContent }; });
  const choose = async (label, applyAll) => {
    if (applyAll) await page.locator('#cfApplyAll').check();
    await page.locator('.cf-actions button', { hasText: new RegExp('^' + label + '$') }).click(); await sleep(700);
  };
  const copyTo = async (names, folderName, how) => { // right-click Copy/Cut on the item(s), then Paste on the folder
    if (names.length > 1) { await ev(() => document.getElementById('multiSelectBtn').click()); for (const n of names) { await row(n).click(); await sleep(150); } }
    await menu(names[0], how || 'Copy');
    if (names.length > 1) await ev(() => document.getElementById('multiSelectBtn').click());
    await menu(folderName, 'Paste');
  };

  console.log('\n[one file clashes: the dialog]');
  await reset();
  await copyTo(['one.txt'], 'B'); await waitDialog();
  let d = await dlg();
  ok(d && d.title === 'File already exists', 'a clash asks instead of silently renaming', d && d.title);
  ok(d.rows.length === 2 && d.rows[0].name === 'one.txt' && d.rows[1].name === 'one.txt', 'it shows both file names', d.rows);
  ok(d.rows.every(r => /^Modified: .*\d/.test(r.meta)) && d.rows[0].meta !== d.rows[1].meta, 'and both last-modified times, which differ', d.rows.map(r => r.meta));
  ok(d.rows[0].badge === 'Older' && d.rows[1].badge === 'Newer', 'the existing file is marked Older and the incoming one Newer', d.rows.map(r => r.badge));
  ok(/\bB\b/.test(d.lead) && /Copying/.test(d.lead), 'the sentence names the action and the destination', d.lead);
  ok(JSON.stringify(d.buttons.map(b => b.t)) === JSON.stringify(['Skip', 'Replace', 'Rename']) && !d.hasApply, 'one item: Skip, Replace, Rename, no Stop and no apply-to-all', d.buttons);
  ok(d.focus === 'Rename', 'Rename (the safe choice) has the focus', d.focus);
  ok(/Rename keeps both.*one\(1\)\.txt/.test(d.text), 'it says what Rename would call the file', d.text);
  ok(await ev(() => document.querySelector('.cf-modal').getAttribute('role') === 'dialog' && document.querySelector('.cf-modal').getAttribute('aria-modal') === 'true'), 'it is a proper modal dialog');
  await choose('Rename');
  ok((await inB()).join() === 'keep.txt=KEEP,one(1).txt=ONE-root,one.txt=ONE-B,two.txt=TWO-B', 'Rename keeps both files', await inB());
  ok(!(await dialogOpen()), 'and the dialog closes');

  console.log('\n[Skip]');
  await reset(); await copyTo(['one.txt'], 'B'); await waitDialog(); await choose('Skip');
  ok((await inB()).join() === 'keep.txt=KEEP,one.txt=ONE-B,two.txt=TWO-B', 'Skip leaves the destination as it was', await inB());
  ok((await atRoot()).includes('one.txt'), 'and the original is still there');

  console.log('\n[Replace, and what happens to the replaced file]');
  await reset();
  await ev(() => { window.__tab = null; handleFileClick({ id: 'b1', parentId: 'dB', name: 'one.txt', type: 'file', content: 'ONE-B' }, document.createElement('div')); });
  await sleep(700);
  const tabBefore = await ev(() => !!document.querySelector('.tab[data-file-id="b1"]'));
  await copyTo(['one.txt'], 'B'); await waitDialog(); await choose('Replace');
  ok((await inB()).join() === 'keep.txt=KEEP,one.txt=ONE-root,two.txt=TWO-B', 'Replace puts the new content under the same name', await inB());
  ok((await atRoot()).includes('one.txt'), 'a copy leaves the original in place');
  const bin = await ev(() => window.recycleBin.map(b => ({ n: b.name, c: b.content, db: b._db })));
  ok(bin.length === 1 && bin[0].n === 'one.txt' && bin[0].c === 'ONE-B' && bin[0].db, 'the replaced file went to the Recycle Bin, so it can be restored', bin);
  ok(tabBefore === true, 'a tab was open on the file about to be replaced', tabBefore);
  ok(!(await ev(() => !!document.querySelector('.tab[data-file-id="b1"]'))), 'and it was closed when that file was replaced');

  console.log('\n[several files: asked per file, with Stop and apply-to-all]');
  await reset(); await copyTo(['one.txt', 'two.txt', 'three.txt'], 'B'); await waitDialog();
  d = await dlg();
  ok(d.rows[0].name === 'one.txt' && d.hasApply && d.buttons.some(b => b.t === 'Stop'), 'the first clash offers the apply-to-all box and Stop', d.buttons);
  ok(/Apply this choice to all remaining items/.test(d.text), 'the box is worded as asked');
  await choose('Skip'); await waitDialog(); d = await dlg();
  ok(d.rows[0].name === 'two.txt', 'with no box ticked the next clash is asked on its own', d.rows[0].name);
  await choose('Replace');
  ok((await inB()).join() === 'keep.txt=KEEP,one.txt=ONE-B,three.txt=THREE-root,two.txt=TWO-root', 'the choices were applied one by one (skip, replace, and the free name placed)', await inB());

  await reset(); await copyTo(['one.txt', 'two.txt', 'three.txt'], 'B'); await waitDialog(); await choose('Replace', true);
  ok(!(await dialogOpen()), 'ticking "apply to all" answers the second clash without asking');
  ok((await inB()).join() === 'keep.txt=KEEP,one.txt=ONE-root,three.txt=THREE-root,two.txt=TWO-root', 'Replace was applied to every clash', await inB());

  await reset(); await copyTo(['one.txt', 'two.txt', 'three.txt'], 'B'); await waitDialog(); await choose('Rename', true);
  ok((await inB()).join() === 'keep.txt=KEEP,one(1).txt=ONE-root,one.txt=ONE-B,three.txt=THREE-root,two(1).txt=TWO-root,two.txt=TWO-B', 'Rename applied to all keeps every file', await inB());

  await reset(); await copyTo(['one.txt', 'two.txt', 'three.txt'], 'B'); await waitDialog(); await choose('Skip', true);
  ok((await inB()).join() === 'keep.txt=KEEP,one.txt=ONE-B,three.txt=THREE-root,two.txt=TWO-B', 'Skip applied to all skips the clashes but still places the free name', await inB());

  await reset(); await copyTo(['one.txt', 'two.txt', 'three.txt'], 'B'); await waitDialog(); await choose('Replace');
  await waitDialog(); await choose('Stop');
  ok((await inB()).join() === 'keep.txt=KEEP,one.txt=ONE-B,two.txt=TWO-B', 'Stop cancels the whole operation, even the answers given before it', await inB());
  ok(await ev(() => !!window.workspaceClipboardRegistry[cellActiveWindow.id]), 'and the clipboard is kept so the paste can be tried again');

  await reset(); await copyTo(['one.txt', 'two.txt'], 'B'); await waitDialog(); await page.keyboard.press('Escape'); await sleep(600);
  ok(!(await dialogOpen()) && (await inB()).join() === 'keep.txt=KEEP,one.txt=ONE-B,two.txt=TWO-B', 'Esc means Stop when several items are waiting');
  await reset(); await copyTo(['one.txt'], 'B'); await waitDialog(); await page.keyboard.press('Escape'); await sleep(600);
  ok((await inB()).join() === 'keep.txt=KEEP,one.txt=ONE-B,two.txt=TWO-B', 'and means Skip for a single item');

  console.log('\n[Cut: the source only goes if the item was placed]');
  await reset(); await copyTo(['one.txt'], 'B', 'Cut'); await waitDialog(); await choose('Skip');
  ok((await atRoot()).includes('one.txt') && (await inB()).includes('one.txt=ONE-B'), 'a skipped cut leaves both files where they were');
  await reset(); await copyTo(['one.txt'], 'B', 'Cut'); await waitDialog(); await choose('Replace');
  ok(!(await atRoot()).includes('one.txt') && (await inB()).includes('one.txt=ONE-root'), 'a replaced cut moves the file', { root: await atRoot(), b: await inB() });
  ok(!(await ev(() => !!window.workspaceClipboardRegistry[cellActiveWindow.id])), 'and the clipboard is spent');
  await reset(); await copyTo(['one.txt'], 'B', 'Cut'); await waitDialog(); await choose('Rename');
  ok(!(await atRoot()).includes('one.txt') && (await inB()).includes('one(1).txt=ONE-root') && (await inB()).includes('one.txt=ONE-B'), 'a renamed cut moves it under a new name');

  console.log('\n[copy into its own folder: no question, numbered as before]');
  await reset(); await menu('one.txt', 'Copy');
  await ev(() => { window.__noAsk = true; });
  await ev(() => { const f = { id: 'r1', parentId: 'root', name: 'one.txt', type: 'file' }; return transferToExternalDBDeep([f], db.name, 'copy', 'root', db.name, 'here'); });
  await sleep(700);
  ok(!(await dialogOpen()) && (await atRoot()).includes('one(1).txt'), 'pasting a copy beside its original just numbers it', await atRoot());

  console.log('\n[drag and drop]');
  await reset();
  await ev(() => { moveFileInDB('r1', 'dB'); }); await waitDialog();
  d = await dlg(); ok(d.rows[1].tag === 'Moving' && /Moving/.test(d.lead), 'a drop that clashes asks, as a move', d.lead);
  await choose('Replace');
  ok(!(await atRoot()).includes('one.txt') && (await inB()).includes('one.txt=ONE-root'), 'Replace moved the dragged file over the one in the folder');
  await reset(); await ev(() => { moveFileInDB('r1', 'dB'); }); await waitDialog(); await choose('Skip');
  ok((await atRoot()).includes('one.txt') && (await inB()).includes('one.txt=ONE-B'), 'Skip leaves the dragged file where it was');
  await reset(); await ev(() => { moveFileInDB('r3', 'dB'); }); await sleep(600);
  ok(!(await dialogOpen()) && (await inB()).includes('three.txt=THREE-root'), 'a drop with no clash just moves, with no dialog');

  console.log('\n[imports]');
  await reset();
  await ev(([t]) => { saveExtractedFiles([{ name: 'one.txt', path: '', type: 'file', content: 'IMPORTED', encoding: 'text', modified: t }], 'dB'); }, [T2]); await waitDialog();
  d = await dlg();
  ok(/Importing/.test(d.lead) && d.rows[1].tag === 'Importing', 'an import that clashes asks', d.lead);
  ok(d.rows[1].meta.startsWith('Modified: ') && !/Unknown/.test(d.rows[1].meta), 'it shows when the incoming file was last modified (from the file itself)', d.rows[1].meta);
  await choose('Replace'); await sleep(400);
  ok((await inB()).includes('one.txt=IMPORTED'), 'Replace stores the imported file');
  await reset();
  await ev(() => { saveExtractedFiles([{ name: 'B', path: '', type: 'folder' }, { name: 'x.txt', path: 'B', type: 'file', content: 'X', encoding: 'text' }, { name: 'y.txt', path: '', type: 'file', content: 'Y', encoding: 'text' }], 'root'); }); await waitDialog();
  d = await dlg(); ok(d.title === 'Folder already exists' && d.rows[1].name === 'B' && /1 item/.test(d.rows[1].meta), 'a whole imported folder is one item, with its count', d.rows);
  ok(/Replace deletes the existing folder and everything in it/.test(d.text), 'and Replace says it deletes the existing folder');
  await choose('Rename'); await sleep(500);
  const afterRen = await recs(); const renB = afterRen.find(r => r.n === 'B(1)' && r.p === 'root');
  ok(renB && afterRen.some(r => r.n === 'x.txt' && r.p === renB.id) && afterRen.some(r => r.n === 'y.txt' && r.p === 'root'), 'Rename imports the folder as B(1) with its content, and the other file too', afterRen.map(r => r.n));
  await reset();
  await ev(() => { saveExtractedFiles([{ name: 'B', path: '', type: 'folder' }, { name: 'x.txt', path: 'B', type: 'file', content: 'X', encoding: 'text' }, { name: 'y.txt', path: '', type: 'file', content: 'Y', encoding: 'text' }], 'root'); }); await waitDialog(); await choose('Skip'); await sleep(400);
  ok(!(await recs()).some(r => r.n === 'x.txt') && (await atRoot()).includes('y.txt'), 'Skip drops the whole folder (and what is inside) but imports the rest');
  await reset();
  await ev(() => { saveExtractedFiles([{ name: 'B', path: '', type: 'folder' }, { name: 'x.txt', path: 'B', type: 'file', content: 'X', encoding: 'text' }], 'root'); }); await waitDialog(); await choose('Replace'); await sleep(500);
  const afterRep = await recs(); const newB = afterRep.find(r => r.n === 'B' && r.p === 'root');
  ok(newB && newB.id !== 'dB' && afterRep.filter(r => r.p === newB.id).map(r => r.n).join() === 'x.txt' && !afterRep.some(r => r.id === 'b1' || r.id === 'bk'), 'Replace of a folder swaps it for the imported one; the old contents are gone', afterRep.map(r => r.n));
  ok((await ev(() => window.recycleBin.length)) >= 4, 'and the old folder and its files went to the Recycle Bin', await ev(() => window.recycleBin.map(b => b.name)));

  console.log('\n[a JSON export restored over itself]');
  await reset();
  const exported = [{ id: 'dB', parentId: 'root', name: 'B', type: 'folder', timestamp: T2 }, { id: 'b1', parentId: 'dB', name: 'one.txt', type: 'file', content: 'FROM-EXPORT', timestamp: T2 }];
  await ev((data) => { importJsonData(data, 'root'); }, exported); await waitDialog();
  d = await dlg(); ok(d.title === 'Folder already exists', 'importing an export whose ids equal stored ids is still a clash to ask about', d.title);
  ok(d.buttons.find(b => b.t === 'Replace' && !b.disabled), 'and Replace is allowed (its ids are not the stored items)');
  await choose('Rename'); await sleep(500);
  ok((await recs()).filter(r => r.n === 'B(1)').length === 1, 'Rename imports it as B(1)');

  console.log('\n[another database: a workspace]');
  await reset();
  await ev(async () => { await new Promise((res) => { const req = indexedDB.open('CodeMiniDB_WS_t1', CODEMINI_DB_VERSION); req.onupgradeneeded = (e) => ensureCodeMiniSchema(e.target.result); req.onsuccess = (e) => { const d = e.target.result; const tx = d.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put({ id: 'w1', parentId: 't1', name: 'one.txt', type: 'file', content: 'WS-ONE', timestamp: 1000 }); tx.oncomplete = () => { d.close(); res(); }; }; }); });
  const wsRecs = () => ev(() => new Promise(res => { const req = indexedDB.open('CodeMiniDB_WS_t1'); req.onsuccess = (e) => { const d = e.target.result; d.transaction('filesystem').objectStore('filesystem').getAll().onsuccess = (ev2) => { const r = ev2.target.result.map(x => `${x.parentId}/${x.name}=${x.content}`).sort(); d.close(); res(r); }; }; }));
  await ev(() => { transferToExternalDBDeep([{ id: 'r1', name: 'one.txt', type: 'file', parentId: 'root' }, { id: 'r2', name: 'two.txt', type: 'file', parentId: 'root' }], 'CodeMiniDB_WS_t1', 'copy', 't1', undefined, 'Test WS'); });
  await waitDialog(); d = await dlg();
  ok(/Test WS/.test(d.lead) && d.rows[0].meta.includes('Modified') && d.rows[0].name === 'one.txt', 'a clash in a workspace names the workspace and shows both files', d.lead);
  await choose('Replace');
  ok((await wsRecs()).join() === 't1/one.txt=ONE-root,t1/two.txt=TWO-root', 'the workspace now holds the copied content (replaced one, added the other)', await wsRecs());
  ok((await atRoot()).includes('one.txt') && (await atRoot()).includes('two.txt'), 'a copy leaves the sources');
  ok(await ev(() => window.recycleBin.some(b => b.name === 'one.txt' && b.content === 'WS-ONE' && b._db === 'CodeMiniDB_WS_t1')), 'the replaced workspace file is in the bin, marked as coming from that workspace');

  await ev(() => new Promise(res => { const req = indexedDB.open('CodeMiniDB_WS_t1'); req.onsuccess = (e) => { const d = e.target.result; const tx = d.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').clear(); tx.objectStore('filesystem').put({ id: 'w1', parentId: 't1', name: 'one.txt', type: 'file', content: 'WS-ONE', timestamp: 1000 }); tx.oncomplete = () => { d.close(); res(); }; }; }));
  await ev(() => { transferToExternalDBDeep([{ id: 'r1', name: 'one.txt', type: 'file', parentId: 'root' }, { id: 'r2', name: 'two.txt', type: 'file', parentId: 'root' }], 'CodeMiniDB_WS_t1', 'move', 't1', undefined, 'Test WS'); });
  await waitDialog(); await choose('Skip'); await sleep(900);
  ok((await atRoot()).includes('one.txt') && !(await atRoot()).includes('two.txt'), 'a move keeps a skipped item at the source and moves the rest', await atRoot());
  ok((await wsRecs()).join() === 't1/one.txt=WS-ONE,t1/two.txt=TWO-root', 'and the skipped clash is untouched in the workspace', await wsRecs());

  console.log('\n[never replaceable]');
  await reset([{ id: 'lk', parentId: 'dB', name: 'secret.txt', type: 'file', content: 'ENC', isLocked: true, timestamp: T1 }, { id: 'r9', parentId: 'root', name: 'secret.txt', type: 'file', content: 'NEW', timestamp: T2 }]);
  await copyTo(['secret.txt'], 'B'); await waitDialog(); d = await dlg();
  ok(d.buttons.find(b => b.t === 'Replace').disabled && /locked/.test(d.text), 'a locked file cannot be replaced, and the dialog says why', d.buttons);
  await choose('Rename');
  ok((await inB()).includes('secret(1).txt=NEW') && (await inB()).includes('secret.txt=ENC'), 'Rename still works for it');

  console.log('\n[Recycle Bin restore]');
  await reset();
  await ev(() => { window.recycleBin.push({ id: 'old1', parentId: 'dB', name: 'one.txt', type: 'file', content: 'BINNED', timestamp: 5, deletedAt: Date.now(), _db: db.name }); });
  await ev(() => { restoreItemsToDB([window.recycleBin[0]], db, () => {}); });
  await waitDialog(); d = await dlg();
  ok(/Restoring/.test(d.lead) && d.rows[1].tag === 'Being restored', 'restoring onto a taken name asks', d.lead);
  await choose('Skip'); await sleep(500);
  ok((await inB()).includes('one.txt=ONE-B') && (await ev(() => window.recycleBin.length)) === 1, 'Skip leaves the item in the bin');

  console.log('\n[the dialog itself]');
  await reset(); await copyTo(['one.txt', 'two.txt'], 'B'); await waitDialog();
  for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
  ok(await ev(() => document.querySelector('.cf-modal').contains(document.activeElement)), 'Tab stays inside the dialog');
  ok(await ev(() => { const b = document.querySelector('.cf-backdrop'); return b && getComputedStyle(b).zIndex === '10049' && getComputedStyle(document.querySelector('.cf-modal')).zIndex === '10050'; }), 'it sits above every other overlay');
  await page.mouse.click(5, 5); await sleep(300);
  ok(await dialogOpen(), 'clicking outside does not dismiss it (a stray click must not decide for you)');
  await choose('Stop');

  await page.setViewportSize({ width: 390, height: 800 }); await sleep(400);
  await reset(); await ev(() => { moveFileInDB('r1', 'dB'); }); await waitDialog();
  const mob = await ev(() => { const r = document.querySelector('.cf-modal').getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth, bh: Math.min(...[...document.querySelectorAll('.cf-actions button')].map(b => b.getBoundingClientRect().height)) }; });
  ok(mob.l >= 0 && mob.r <= mob.w, 'on a phone the dialog fits the screen', mob);
  ok(mob.bh >= 40, 'and its buttons are big enough to tap', mob.bh);
  await choose('Skip');
  await page.setViewportSize({ width: 1280, height: 800 }); await sleep(300);

  console.log('\n[names are text]');
  await reset([{ id: 'h1', parentId: 'dB', name: '<img src=x onerror=window.__pwn=1>.txt', type: 'file', content: 'a', timestamp: T1 }, { id: 'h2', parentId: 'root', name: '<img src=x onerror=window.__pwn=1>.txt', type: 'file', content: 'b', timestamp: T2 }]);
  await ev(() => { transferToExternalDBDeep([{ id: 'h2', name: '<img src=x onerror=window.__pwn=1>.txt', type: 'file', parentId: 'root' }], db.name, 'copy', 'dB', db.name, '<b>B</b>'); }); await waitDialog();
  ok(await ev(() => document.querySelector('.cf-modal img') === null && document.querySelector('.cf-modal b') === null && window.__pwn === undefined), 'a hostile name is shown as text and nothing runs');
  ok((await dlg()).rows[0].name.includes('<img src=x'), 'and it is shown in full');
  await choose('Skip');

  const rel = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i.test(e));
  ok(rel.length === 0, 'no unexpected page errors', rel);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
