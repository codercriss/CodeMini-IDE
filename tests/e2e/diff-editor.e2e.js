// The diff editor (js/core/diff-editor.js) in the real app. Most of what matters is Monaco's own diff editor, so this
// test uses a real Monaco when MONACO_DIR is set (see tests/e2e/lib/monaco-local.js) and, without it, runs the checks
// that do not need one and reports the rest as SKIP.
const { chromium } = require('playwright');
const monacoLocal = require('./lib/monaco-local');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0, skipped = 0;
const REAL = monacoLocal.available();
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const real = (c, n, x) => { if (REAL) ok(c, n, x); else { skipped++; console.log('  SKIP', n, '(needs MONACO_DIR)'); } };
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  // A real Monaco is served by a route, which cannot see requests the app's own service worker makes (it would fetch
  // Monaco itself after a reload and fail offline), so the worker is blocked for the real-editor run.
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: REAL ? 'block' : 'allow' })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  if (!REAL) await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (deps, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); };
    window.require.config = () => {};
  });
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  if (REAL) await monacoLocal.install(page);
  await page.goto('http://localhost:8765/index.html'); await sleep(REAL ? 6500 : 5200);
  const ev = (f, a) => page.evaluate(f, a);
  console.log(REAL ? '\n(real Monaco)' : '\n(no MONACO_DIR: editor checks are skipped)');
  if (!(await ev(() => document.getElementById('explorerSidebar').offsetWidth > 100))) { await ev(() => document.getElementById('folderIconItem').click()); await sleep(900); }

  const seed = async (extra) => {
    await ev(async (extra) => {
      await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').clear(); tx.oncomplete = res; });
      const t = Date.now();
      const recs = [
        { id: 'fa', parentId: 'root', name: 'a.js', type: 'file', content: 'one\ntwo\nthree\n', timestamp: t },
        { id: 'fb', parentId: 'root', name: 'b.js', type: 'file', content: 'one\nTWO\nthree\nfour\n', timestamp: t },
        { id: 'fc', parentId: 'root', name: 'c.js', type: 'file', content: 'a\n b\n', timestamp: t },
        { id: 'fd', parentId: 'root', name: 'd.js', type: 'file', content: 'a\nb\n', timestamp: t },
        { id: 'fe', parentId: 'root', name: 'e.js', type: 'file', content: 'one\ntwo\nthree\n', timestamp: t },
        { id: 'fp', parentId: 'root', name: 'pic.png', type: 'file', content: 'AAAA', encoding: 'base64', timestamp: t },
        { id: 'fl', parentId: 'root', name: 'secret.js', type: 'file', content: 'ENC', isLocked: true, timestamp: t }
      ].concat(extra || []);
      await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); recs.forEach(r => tx.objectStore('filesystem').put(r)); tx.oncomplete = res; });
      Array.from(document.querySelectorAll('.tab')).forEach(tab => { const b = tab.querySelector('.tab-close'); if (b) b.click(); });
      folderStack = [folderStack[0]]; loadFilesFromDB();
      window.appSettings.autoSave = 'Off';
    }, extra);
    await sleep(600);
  };
  const row = (name) => page.locator('.file-item', { hasText: name }).first();
  const menuItem = (text) => page.locator('.dropdown-item', { hasText: new RegExp('^\\s*' + text + '\\s*$') });
  const rightClick = async (name) => { await row(name).click({ button: 'right' }); await sleep(250); };
  const closeMenu = async () => { await page.keyboard.press('Escape'); await page.mouse.click(700, 500); await sleep(150); };
  const diffTabs = () => ev(() => Array.from(document.querySelectorAll('.tab[data-type="diff"]')).map(t => t.querySelector('span').textContent));
  const toolbar = () => ev(() => { const r = document.querySelector('.pane-active .df-root, .content-pane.active .df-root'); if (!r) return null; return { counter: r.querySelector('.df-counter').textContent, labels: [r.querySelector('.df-label-left').textContent, r.querySelector('.df-label-right').textContent], msg: r.querySelector('.df-msg').hidden ? '' : r.querySelector('.df-msg').textContent, unified: r.querySelector('.df-seg-btn[data-df="unified"]').classList.contains('active'), refreshHidden: r.querySelector('[data-df="refresh"]').hidden, splitDisabled: r.querySelector('.df-seg-btn[data-df="split"]').disabled, prevDisabled: r.querySelector('[data-df="prev"]').disabled }; });
  const click = async (k) => { await ev((k) => document.querySelector('.content-pane.active .df-root [data-df="' + k + '"]').click(), k); await sleep(350); };
  const modifiedEditor = "document.querySelector('.content-pane.active')._diff.editor.getModifiedEditor()";
  const pos = () => ev(() => { const n = document.querySelector('.content-pane.active')._diff.editor.getModifiedEditor().getPosition().lineNumber; return typeof n === 'number' ? n : null; });
  const sbs = () => ev(() => { const d = document.querySelector('.content-pane.active .monaco-diff-editor'); return d ? d.classList.contains('side-by-side') : null; });
  const waitDiff = async (ms) => { await sleep(ms || 1800); };

  console.log('\n[Explorer: Select for Compare, Compare with Selected]');
  await seed();
  await rightClick('a.js');
  ok(await menuItem('Select for Compare').count() === 1, 'a file offers Select for Compare');
  ok(await menuItem('Compare with Selected').count() === 0, 'but not Compare with Selected until something is selected');
  await menuItem('Select for Compare').click(); await sleep(250);
  await rightClick('a.js');
  ok(await menuItem('Compare with Selected').count() === 0, 'the selected file itself cannot be compared with itself');
  await closeMenu();
  await rightClick('b.js');
  ok(await menuItem('Compare with Selected').count() === 1, 'another file now offers Compare with Selected');
  await menuItem('Compare with Selected').click(); await waitDiff();
  ok((await diffTabs()).join() === 'a.js \u2194 b.js', 'a diff tab opens, titled with both names', await diffTabs());
  let tb = await toolbar();
  ok(tb && tb.labels[0] === 'a.js' && tb.labels[1] === 'b.js', 'the two sides are labeled', tb && tb.labels);
  real(await ev(() => !!document.querySelector('.content-pane.active .monaco-diff-editor')), 'Monaco\'s diff editor is shown');
  real(tb && tb.counter === '2 changes', 'the counter says how many changes there are', tb && tb.counter);
  real(await ev(() => document.querySelector('.content-pane.active')._diff.editor.getModifiedEditor().getValue() === 'one\nTWO\nthree\nfour\n'), 'the modified side holds the second file\'s text');
  ok(await ev(() => document.querySelector('.tab[data-type="diff"]').dataset.fileId === undefined), 'a diff tab has no file of its own (so a restored session cannot mistake it for one)');

  console.log('\n[stepping through changes]');
  await click('next'); real((await toolbar()).counter === '1 of 2' && (await pos()) === 2, 'Next goes to the first change (line 2) and says "1 of 2"', [(await toolbar()).counter, await pos()]);
  await click('next'); real((await toolbar()).counter === '2 of 2' && (await pos()) === 4, 'Next goes to the second change (line 4)', [(await toolbar()).counter, await pos()]);
  await click('next'); real((await toolbar()).counter === '1 of 2', 'Next wraps around to the first', (await toolbar()).counter);
  await click('prev'); real((await toolbar()).counter === '2 of 2', 'Previous wraps back to the last', (await toolbar()).counter);

  console.log('\n[layout, whitespace, refresh]');
  real((await sbs()) === true, 'it starts in Split view');
  await click('unified'); real((await sbs()) === false && (await toolbar()).unified, 'Unified switches to the inline view');
  ok(await ev(() => localStorage.getItem('codemini_diff_view')) === 'unified', 'and the choice is remembered');
  await click('split'); real((await sbs()) === true, 'Split switches back');
  // refresh sees edits made to the files since
  await ev(() => new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put({ id: 'fb', parentId: 'root', name: 'b.js', type: 'file', content: 'one\ntwo\nthree\n', timestamp: Date.now() }); tx.oncomplete = res; }));
  await click('refresh'); await waitDiff(1500);
  real((await toolbar()).msg === 'No differences', 'Refresh re-reads the files: now identical, so it says "No differences"', await toolbar());
  real((await toolbar()).prevDisabled, 'and the change arrows are disabled');

  console.log('\n[same pair again is one tab]');
  await rightClick('b.js'); await menuItem('Select for Compare').click(); await sleep(250);
  await rightClick('a.js'); await menuItem('Compare with Selected').click(); await waitDiff(1000);
  ok((await diffTabs()).length === 2, 'a different pair (b vs a) is its own tab', await diffTabs());
  await rightClick('a.js'); await menuItem('Select for Compare').click(); await sleep(250);
  await rightClick('b.js'); await menuItem('Compare with Selected').click(); await waitDiff(1000);
  ok((await diffTabs()).length === 2, 'asking for the same pair again shows the existing tab instead of opening another', await diffTabs());

  console.log('\n[whitespace-only differences]');
  await seed();
  await rightClick('c.js'); await menuItem('Select for Compare').click(); await sleep(250);
  await rightClick('d.js'); await menuItem('Compare with Selected').click(); await waitDiff();
  real((await toolbar()).counter !== 'No changes', 'a whitespace difference is a change by default', (await toolbar()).counter);
  await ev(() => { const b = document.querySelector('.content-pane.active .df-root input[data-df="ws"]'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); }); await waitDiff(1500);
  real(/except whitespace/.test((await toolbar()).msg), 'Ignore whitespace leaves nothing and says why', (await toolbar()).msg);

  console.log('\n[identical, binary, locked]');
  await seed();
  await rightClick('a.js'); await menuItem('Select for Compare').click(); await sleep(250);
  await rightClick('e.js'); await menuItem('Compare with Selected').click(); await waitDiff();
  real((await toolbar()).msg === 'No differences', 'identical files show "No differences"', await toolbar());
  await rightClick('pic.png'); await menuItem('Select for Compare').click(); await sleep(250);
  await rightClick('a.js'); await menuItem('Compare with Selected').click(); await waitDiff(900);
  ok(/Binary file, diff not available/.test((await toolbar()).msg) && !(await ev(() => !!document.querySelector('.content-pane.active .monaco-diff-editor'))), 'a binary file says so, without a diff editor', (await toolbar()).msg);
  await rightClick('a.js'); await menuItem('Select for Compare').click(); await sleep(250);
  await rightClick('secret.js'); await menuItem('Compare with Selected').click(); await waitDiff(900);
  ok(/is locked/.test((await toolbar()).msg), 'a locked file is refused with a reason (its text is encrypted)', (await toolbar()).msg);

  console.log('\n[closing the tab frees the editor]');
  await seed();
  await rightClick('a.js'); await menuItem('Select for Compare').click(); await sleep(250);
  await rightClick('b.js'); await menuItem('Compare with Selected').click(); await waitDiff();
  await ev(() => { document.querySelector('.tab[data-type="diff"] .tab-close').click(); });
  await sleep(500);
  ok((await diffTabs()).length === 0, 'the tab closes');
  real(await ev(() => monaco.editor.getModels().filter(m => m.getValue() === 'one\nTWO\nthree\nfour\n').length === 0), 'and its text models are disposed, not leaked');

  console.log('\n[the tab\'s right-click menu: Compare with Saved]');
  await seed();
  await ev(() => { handleFileClick({ id: 'fa', parentId: 'root', name: 'a.js', type: 'file', content: 'one\ntwo\nthree\n' }, document.createElement('div')); });
  await sleep(2000);
  real(await ev(() => !!getActiveMonacoEditor()), 'a file opens in the real editor');
  await ev(() => { const ed = getActiveMonacoEditor(); ed.executeEdits('t', [{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 }, text: 'EDITED' }]); });
  await page.locator('.tab', { hasText: 'a.js' }).first().click({ button: 'right' }); await sleep(300);
  const items = await ev(() => Array.from(document.querySelectorAll('.df-menu-item')).map(i => i.textContent));
  ok(items.join() === 'Compare with Saved,Local History...,Close,Close Others', 'right-clicking a file tab offers Compare with Saved, Local History..., Close and Close Others', items);
  await page.keyboard.press('Escape'); await sleep(200);
  ok(!(await ev(() => !!document.querySelector('.df-menu'))), 'Esc closes the menu');
  await page.locator('.tab', { hasText: 'a.js' }).first().click({ button: 'right' }); await sleep(300);
  await page.locator('.df-menu-item', { hasText: 'Compare with Saved' }).click(); await waitDiff(2000);
  ok((await diffTabs()).join() === 'a.js (Saved \u2194 Editor)', 'Compare with Saved opens a diff tab', await diffTabs());
  tb = await toolbar(); ok(tb && tb.labels.join() === 'Saved,Editor', 'labeled Saved and Editor', tb && tb.labels);
  real(await ev(() => { const v = document.querySelector('.content-pane.active')._diff.editor.getModifiedEditor().getValue(); return v.includes('EDITED') && !v.includes('two'); }), 'the Editor side holds the unsaved text');
  real(await ev(() => document.querySelector('.content-pane.active')._diff.editor.getOriginalEditor().getValue() === 'one\ntwo\nthree\n'), 'and the Saved side holds what is stored');
  real((await toolbar()).counter === '1 change', 'with exactly one change', (await toolbar()).counter);
  await page.locator('.tab[data-type="diff"]').first().click({ button: 'right' }); await sleep(300);
  ok((await ev(() => Array.from(document.querySelectorAll('.df-menu-item')).map(i => i.textContent))).join() === 'Close,Close Others', 'a diff tab\'s own menu has no Compare with Saved');
  await page.keyboard.press('Escape');
  await page.locator('.tab', { hasText: 'a.js' }).first().click({ button: 'right', position: { x: 10, y: 10 } }); await sleep(300);
  await page.locator('.df-menu-item', { hasText: 'Close Others' }).click(); await sleep(700);
  ok(await ev(() => document.querySelectorAll('.tab').length === 1), 'Close Others keeps only that tab', await ev(() => document.querySelectorAll('.tab').length));

  console.log('\n[Source Control: popup, Open in tab, double-click]');
  await seed();
  await ev(async () => {
    const dbName = db.name, repo = getGitRepo(dbName), cfg = getGitConfig(dbName);
    const sha = await gitCreateCommitObject(repo, 'first', [null], [{ path: '/a.js', name: 'a.js', status: 'added', content: 'one\ntwo\nthree\n', encoding: 'text' }], { author: 't', authorEmail: 't@x' });
    gitMoveRef(dbName, repo, cfg.currentBranch, sha, 'test'); saveGitRepo(dbName, repo);
    await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put({ id: 'fa', parentId: 'root', name: 'a.js', type: 'file', content: 'one\nTWO\nthree\n', timestamp: Date.now() }); tx.oncomplete = res; });
    document.getElementById('menuSource').click();
  });
  await sleep(1500);
  const scRow = page.locator('#sourceControlSidebar [data-git-action="diff"][data-path="/a.js"]').first();
  ok(await scRow.count() === 1, 'the changed file is listed in Source Control');
  await scRow.click(); await sleep(900);
  ok(await ev(() => !!document.getElementById('gitDiffOverlay')), 'a single click still shows the popup');
  ok(await ev(() => !!document.getElementById('gitDiffOpenTab')), 'the popup has an "Open in tab" icon');
  await page.locator('#gitDiffOpenTab').click(); await waitDiff();
  ok(!(await ev(() => !!document.getElementById('gitDiffOverlay'))) && (await diffTabs()).join() === 'a.js (HEAD \u2194 Working tree)', 'Open in tab closes the popup and opens the tab', await diffTabs());
  real((await toolbar()).counter === '1 change', 'showing the one changed line', (await toolbar()).counter);
  ok(!(await toolbar()).refreshHidden, 'a working-tree diff can be refreshed');
  await ev(() => document.querySelector('.tab[data-type="diff"] .tab-close').click()); await sleep(400);
  await scRow.dblclick(); await waitDiff();
  ok((await diffTabs()).join() === 'a.js (HEAD \u2194 Working tree)' && !(await ev(() => !!document.getElementById('gitDiffOverlay'))), 'double-clicking the file opens the tab and leaves no popup behind', await diffTabs());
  await ev(() => new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put({ id: 'fa', parentId: 'root', name: 'a.js', type: 'file', content: 'one\nTWO\nthree\nmore\n', timestamp: Date.now() }); tx.oncomplete = res; }));
  await click('refresh'); await waitDiff(1500);
  real((await toolbar()).counter === '2 changes', 'Refresh picks up a later edit to the working file', (await toolbar()).counter);
  await ev(() => { window.gitShowDiff('x.txt', 'a\nb\n', 'a\nc\n', 'text', { name: 'x.txt', key: 'git:test:static', originalLabel: 'Before', modifiedLabel: 'After', openInTab: true }); }); await waitDiff();
  ok((await diffTabs()).includes('x.txt (Before \u2194 After)') && !(await ev(() => !!document.getElementById('gitDiffOverlay'))) && (await toolbar()).refreshHidden, 'a snapshot diff opens straight in a tab, with no Refresh', await diffTabs());

  console.log('\n[Quick Open: compare commands]');
  await seed();
  await ev(() => { handleFileClick({ id: 'fa', parentId: 'root', name: 'a.js', type: 'file', content: 'one\ntwo\nthree\n' }, document.createElement('div')); });
  await sleep(2000);
  await page.keyboard.press('Control+P'); await sleep(400);
  await page.fill('.top-center .search-bar input', '>compare'); await sleep(300);
  const cmds = await ev(() => Array.from(document.querySelectorAll('#topSearchIsland .qo-label')).map(l => l.textContent));
  ok(cmds.includes('Compare Active File With...') && cmds.includes('Compare Active File with Saved'), 'both compare commands are in the command list', cmds);
  await page.fill('.top-center .search-bar input', '>compare active file with...'); await sleep(300);
  await page.keyboard.press('Enter'); await sleep(700);
  ok(await ev(() => /Compare \u201ca\.js\u201d with/.test(document.querySelector('#topSearchIsland .qo-pick').textContent)), 'it asks for the other file, naming this one', await ev(() => document.querySelector('#topSearchIsland').innerText.slice(0, 80)));
  const pickable = await ev(() => Array.from(document.querySelectorAll('#topSearchIsland .qo-label')).map(l => l.textContent));
  ok(!pickable.includes('a.js') && pickable.includes('b.js'), 'the list is files only, without the file itself', pickable);
  await page.fill('.top-center .search-bar input', 'b.js'); await sleep(300); await page.keyboard.press('Enter'); await waitDiff();
  ok((await diffTabs()).join() === 'a.js \u2194 b.js', 'choosing a file opens the comparison', await diffTabs());
  await page.keyboard.press('Control+P'); await sleep(400);
  ok(await ev(() => !document.querySelector('#topSearchIsland .qo-pick') && !!document.querySelector('#topSearchIsland .qo-hint-chip')), 'the next Ctrl+P is a normal Quick Open again');
  await page.keyboard.press('Escape');
  await ev(() => { document.querySelector('.tab[data-type="diff"] .tab-close').click(); }); await sleep(300);
  await ev(() => { const t = Array.from(document.querySelectorAll('.tab')).find(x => x.dataset.fileId === 'fa'); t.click(); }); await sleep(500);
  await page.keyboard.press('Control+P'); await sleep(300);
  await page.fill('.top-center .search-bar input', '>compare active file with...'); await sleep(300); await page.keyboard.press('Enter'); await sleep(500);
  await page.mouse.click(5, 500); await sleep(300); // abandon the pick by clicking away
  await page.keyboard.press('Control+P'); await sleep(400);
  ok(await ev(() => !document.querySelector('#topSearchIsland .qo-pick')), 'abandoning a pick (clicking away) does not leave the next open stuck in pick mode');
  await page.keyboard.press('Escape');
  await ev(() => { const ed = getActiveMonacoEditor(); if (ed) ed.executeEdits('t', [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }, text: 'XYZ' }]); });
  await page.keyboard.press('Control+P'); await sleep(300); await page.fill('.top-center .search-bar input', '>compare active file with saved'); await sleep(300); await page.keyboard.press('Enter'); await waitDiff(2000);
  ok((await diffTabs()).join() === 'a.js (Saved \u2194 Editor)', 'Compare Active File with Saved works from the palette', await diffTabs());
  await ev(() => { document.querySelector('.tab[data-type="diff"] .tab-close').click(); }); await sleep(300);

  console.log('\n[a diff tab is not part of a restored session]');
  const ensureExplorer = async () => { if (!(await ev(() => document.getElementById('explorerSidebar').classList.contains('open') || document.getElementById('explorerSidebar').offsetWidth > 100))) { await ev(() => document.getElementById('folderIconItem').click()); await sleep(900); } };
  await ensureExplorer();
  await rightClick('a.js'); await menuItem('Select for Compare').click(); await sleep(250);
  await rightClick('b.js'); await menuItem('Compare with Selected').click(); await waitDiff(1200);
  ok((await diffTabs()).length === 1, 'a diff tab is open before the reload');
  await sleep(1200);
  await page.reload(); await sleep(REAL ? 6500 : 5200);
  ok((await diffTabs()).length === 0, 'after a reload there is no diff tab (nothing to reopen)', await diffTabs());

  console.log('\n[phone]');
  await page.setViewportSize({ width: 390, height: 800 }); await sleep(400);
  await ev(() => { document.querySelectorAll('.sidebar.open').forEach(sb => sb.classList.remove('open')); }); await sleep(300); // a diff is read with the sidebars closed
  await ev(() => { window.CodeMiniDiff.openStatic({ key: 'phone:1', name: 'x.txt', original: 'a\nb\n', modified: 'a\nc\n', originalLabel: 'Before', modifiedLabel: 'After' }); }); await waitDiff();
  tb = await toolbar();
  ok(tb && tb.splitDisabled && tb.unified, 'under 768px the layout is Unified and Split is not offered', tb);
  real((await sbs()) === false, 'and the editor really is inline');
  ok(await ev(() => { const bar = document.querySelector('.content-pane.active .df-toolbar'); return bar.getBoundingClientRect().right <= innerWidth + 1; }), 'the toolbar stays within the screen');
  await page.setViewportSize({ width: 1280, height: 800 }); await sleep(500);
  real((await sbs()) === true, 'widening the screen goes back to the remembered Split layout', await toolbar());
  ok(!(await toolbar()).splitDisabled, 'Split is enabled again on a wide screen');

  const rel = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined|importScripts|\[object Event\]/i.test(e));
  ok(rel.length === 0, 'no unexpected page errors', rel);
  console.log(`\n${pass} passed, ${fail} failed${skipped ? ', ' + skipped + ' skipped (no MONACO_DIR)' : ''}`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
