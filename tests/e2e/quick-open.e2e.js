// Quick Open in the real app (js/core/quick-open.js): Ctrl+P / F1, fuzzy matching, keyboard navigation, the > : @ #
// modes, recent files, open-to-the-side, name:line, hostile names, and phone-size rows. Monaco is stubbed (its CDN is
// blocked here), so go-to-line is checked against a stand-in editor: it proves we ask the editor for the right line,
// not that Monaco scrolls there.
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

  // ---- a small project in the real database
  await ev(() => new Promise(res => {
    const tx = db.transaction('filesystem', 'readwrite'), st = tx.objectStore('filesystem'); const now = Date.now();
    const folder = (id, name, parentId) => st.put({ id, parentId, name, type: 'folder', timestamp: now });
    const file = (id, name, parentId, content) => st.put({ id, parentId, name, type: 'file', content: content || 'x\n'.repeat(60), timestamp: now });
    folder('d-src', 'src', 'root'); folder('d-utils', 'utils', 'd-src'); folder('d-docs', 'docs', 'root'); folder('d-lib', 'lib', 'root');
    file('f-app', 'app.js', 'd-src'); file('f-help', 'helpers.js', 'd-utils'); file('f-readme', 'README.md', 'root'); file('f-guide', 'guide.md', 'd-docs');
    file('f-icon', 'getFileIcon.js', 'd-lib'); file('f-pwn', '<img src=x onerror=window.__pwn=1>.txt', 'root');
    tx.oncomplete = res;
  }));
  await ev(() => { window.__prevented = []; document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') window.__prevented.push(e.defaultPrevented); }/* capture phase, registered after quick-open's own */, true); });
  const input = '.top-center .search-bar input';
  const isOpen = () => ev(() => document.getElementById('topSearchIsland').style.display === 'flex');
  const rows = () => ev(() => [...document.querySelectorAll('#topSearchIsland .qo-item')].map(r => ({ label: r.querySelector('.qo-label').textContent, detail: (r.querySelector('.qo-detail') || {}).textContent || '', sel: r.classList.contains('selected') })));
  const sections = () => ev(() => [...document.querySelectorAll('#topSearchIsland .qo-section')].map(s => s.firstChild.textContent));
  const type = async (t) => { await page.fill(input, t); await sleep(250); };
  const activeFileName = () => ev(() => { const t = document.querySelector('.editor-group.active-group .tab.active') || document.querySelector('.tab.active'); return t ? (t.dataset.fileId || '') : ''; });
  const reset = async () => { await page.keyboard.press('Escape'); await sleep(100); };

  console.log('\n[opening it]');
  await page.keyboard.press('Control+P'); await sleep(500);
  ok(await isOpen(), 'Ctrl+P opens the island');
  ok(await ev(() => document.activeElement === document.querySelector('.top-center .search-bar input')), 'and focuses the search box');
  ok((await ev(() => window.__prevented)).every(Boolean) && (await ev(() => window.__prevented.length)) >= 1, 'the browser\'s Print dialog is suppressed', await ev(() => window.__prevented));
  ok(await ev(() => !!document.querySelector('#topSearchIsland .qo-hint')), 'a hint row shows the prefixes');
  ok((await ev(() => [...document.querySelectorAll('.qo-hint-chip')].map(c => c.textContent))).join('|') === 'files|>commands|:line|@symbol|#workspace', 'hint row lists files, >, :, @ and #', await ev(() => [...document.querySelectorAll('.qo-hint-chip')].map(c => c.textContent)));
  ok((await sections()).includes('FILES') && (await sections()).includes('COMMANDS') && (await sections()).includes('FOLDERS'), 'the empty box lists FILES, COMMANDS and FOLDERS', await sections());
  await reset();
  ok(!(await isOpen()), 'Esc closes it');

  console.log('\n[fuzzy search]');
  await page.keyboard.press('Control+P'); await sleep(300);
  await type('sapp');
  let r = await rows();
  ok(r.length >= 1 && r[0].label === 'app.js' && /src/.test(r[0].detail), '"sapp" finds src/app.js first', r.slice(0, 3));
  const hl = await ev(() => [...document.querySelectorAll('#topSearchIsland .qo-item:first-of-type .qo-hl, #topSearchIsland .qo-item .qo-hl')].slice(0, 6).map(b => b.textContent).join(''));
  ok(hl.toLowerCase().includes('app'), 'the matched letters are highlighted', hl);
  ok(r[0].sel, 'the first result is selected');
  await type('gfic'); r = await rows();
  ok(r[0] && r[0].label === 'getFileIcon.js', '"gfic" finds getFileIcon.js by its capital letters', r.slice(0, 2));
  await type('zzzqqq'); 
  ok(/No results found/.test(await ev(() => document.querySelector('#topSearchIsland').innerText)) && /Tip: type >/.test(await ev(() => document.querySelector('#topSearchIsland').innerText)), 'no match shows "No results found" and a tip');

  console.log('\n[keyboard navigation]');
  await type('s'); r = await rows();
  ok(r.length >= 3 && r[0].sel, 'several rows for "s"', r.length);
  await page.keyboard.press('ArrowDown'); r = await rows();
  ok(r[1].sel && !r[0].sel, 'ArrowDown moves the selection');
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); r = await rows();
  ok(r[r.length - 1].sel, 'ArrowUp from the top wraps to the last row');
  await sleep(600); // the app fades colors; measure after the fade
  const bar = await ev(() => {
    const s = document.querySelector('#topSearchIsland .qo-item.selected'); if (!s) return null;
    const probe = document.createElement('i'); probe.style.color = 'var(--accent-blue)'; document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color; probe.remove();
    const c = getComputedStyle(s); return { width: c.borderLeftWidth, color: c.borderLeftColor, accent };
  });
  ok(bar && bar.width === '2px' && bar.color === bar.accent, 'the selected row has a 2px accent bar', bar);
  await type('sapp'); await page.keyboard.press('Enter'); await sleep(900);
  ok(!(await isOpen()), 'Enter closes the island');
  ok((await activeFileName()) === 'f-app', 'and opens the selected file', await activeFileName());

  console.log('\n[recently opened]');
  await page.keyboard.press('Control+P'); await sleep(500);
  ok((await sections())[0] === 'RECENTLY OPENED', 'an empty box starts with RECENTLY OPENED', await sections());
  r = await rows(); ok(r[0] && r[0].label === 'app.js', 'the file just opened is first', r.slice(0, 2));
  await type('guide'); await page.keyboard.press('Enter'); await sleep(900);
  await page.keyboard.press('Control+P'); await sleep(500); r = await rows();
  ok(r[0].label === 'guide.md' && r[1].label === 'app.js', 'the newest is first, then the one before', r.slice(0, 3));
  await reset();

  console.log('\n[click, and Alt+Enter]');
  await page.keyboard.press('Control+P'); await sleep(300); await type('readme');
  await page.locator('#topSearchIsland .qo-item').first().click(); await sleep(900);
  ok((await activeFileName()) === 'f-readme', 'clicking a result opens it', await activeFileName());
  await page.keyboard.press('Control+P'); await sleep(300); await type('helpers');
  await page.keyboard.press('Alt+Enter'); await sleep(1200);
  const side = await ev(() => { const g2 = document.getElementById('editorGroup2'); return { split: !!g2, inSide: !!(g2 && g2.querySelector('.tab[data-file-id="f-help"]')), inFirst: !!document.querySelector('#editorGroup1 .tab[data-file-id="f-help"]') }; });
  ok(side.split && side.inSide && !side.inFirst, 'Alt+Enter opens the file in the other editor group', side);
  await ev(() => document.getElementById('splitLayoutBtn').click()); await sleep(300);

  console.log('\n[commands: > and F1]');
  await page.keyboard.press('Control+P'); await sleep(300); await type('>zen');
  r = await rows(); ok(r.length === 1 && r[0].label === 'Toggle Zen Mode', '">zen" lists only the matching command', r);
  ok(await ev(() => document.querySelector('.qo-hint-chip.active').textContent === '>commands'), 'the hint row marks command mode');
  await page.keyboard.press('Enter'); await sleep(300);
  ok(await ev(() => document.body.classList.contains('zen-mode')), 'Enter runs it');
  await ev(() => document.body.classList.remove('zen-mode'));
  await page.keyboard.press('F1'); await sleep(400);
  ok((await isOpen()) && (await ev(() => document.querySelector('.top-center .search-bar input').value)) === '>', 'F1 opens it already in command mode');
  r = await rows(); ok(r.length >= 8 && r.some(x => x.label === 'Format Code') && r.some(x => x.label === 'Split Editor'), 'all commands are listed', r.map(x => x.label));
  ok(await ev(() => [...document.querySelectorAll('#topSearchIsland .qo-kbd')].map(k => k.textContent).includes('Ctrl+B')), 'commands show their shortcuts');
  await reset();

  console.log('\n[line and symbol modes]');
  await ev(() => { window.__rev = null; window.__pos = null; window.__act = null; window.getActiveMonacoEditor = () => ({ getModel: () => ({ getLineCount: () => 200 }), revealLineInCenter: (l) => { window.__rev = l; }, setPosition: (p) => { window.__pos = p; }, focus() {}, getAction: (id) => ({ run: () => { window.__act = id; } }) }); });
  await page.keyboard.press('Control+P'); await sleep(300); await type(':42');
  r = await rows(); ok(r.length === 1 && /Go to line 42/.test(r[0].label), '":42" offers "Go to line 42"', r);
  await page.keyboard.press('Enter'); await sleep(200);
  ok((await ev(() => window.__rev)) === 42 && (await ev(() => window.__pos.lineNumber)) === 42, 'Enter asks the editor for line 42', await ev(() => [window.__rev, window.__pos]));
  await page.keyboard.press('Control+P'); await sleep(300); await type(':9999');
  r = await rows(); ok(/Go to line 200/.test(r[0].label), 'a line past the end clamps to the last line', r);
  await type(':12:5'); await page.keyboard.press('Enter'); await sleep(200);
  ok((await ev(() => window.__pos.column)) === 5 && (await ev(() => window.__rev)) === 12, ':12:5 sets line and column', await ev(() => window.__pos));
  await page.keyboard.press('Control+P'); await sleep(300); await type('@');
  r = await rows(); ok(r.length === 1 && /symbols/i.test(r[0].label), '"@" offers the symbol browser', r);
  await page.keyboard.press('Enter'); await sleep(200);
  ok((await ev(() => window.__act)) === 'editor.action.quickOutline', 'Enter runs Monaco\'s outline picker', await ev(() => window.__act));
  await ev(() => { window.__rev = null; });
  await page.keyboard.press('Control+P'); await sleep(300); await type('guide.md:7'); await page.keyboard.press('Enter'); await sleep(1000);
  ok((await ev(() => window.__rev)) === 7 && (await activeFileName()) === 'f-guide', 'name:line opens the file and goes to the line', await ev(() => window.__rev));
  await ev(() => { window.getActiveMonacoEditor = () => null; });
  await page.keyboard.press('Control+P'); await sleep(300); await type(':5');
  ok(/Open a file in the editor/.test(await ev(() => document.getElementById('topSearchIsland').innerText)), 'with no editor open, ":" says so instead of failing');
  await reset();

  console.log('\n[folders]');
  await page.keyboard.press('Control+P'); await sleep(300); await type('utils');
  r = await rows(); ok(r.some(x => x.label === 'utils' && /src\/utils/.test(x.detail)), 'a folder is found by name with its path', r);
  const fi = r.findIndex(x => x.label === 'utils');
  for (let i = 0; i < fi; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter'); await sleep(700);
  ok((await ev(() => folderStack.map(f => f.name).join('/'))).endsWith('src/utils'), 'opening a nested folder builds the whole breadcrumb', await ev(() => folderStack.map(f => f.name)));

  console.log('\n[hint chips]');
  await page.keyboard.press('Control+P'); await sleep(300);
  await page.locator('.qo-hint-chip', { hasText: 'line' }).click(); await sleep(250);
  ok((await ev(() => document.querySelector('.top-center .search-bar input').value)) === ':', 'clicking a hint chip types its prefix');
  await reset();

  console.log('\n[safety: names are text, never markup]');
  await page.keyboard.press('Control+P'); await sleep(300); await type('img');
  r = await rows();
  ok(r.some(x => x.label.includes('<img src=x')), 'a file named like an <img> tag is listed as text', r.map(x => x.label));
  ok(await ev(() => document.querySelector('#topSearchIsland img') === null && window.__pwn === undefined), 'no element was created from the name and nothing ran');
  await reset();

  console.log('\n[workspaces: the same icons as the Explorer, and they open]');
  await ev(() => new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put({ id: 'w1', parentId: 'root', name: 'Alpha Project', type: 'workspace', db: 'CodeMiniDB_WS_w1', timestamp: Date.now() }); tx.oncomplete = res; }));
  await ev(() => loadFilesFromDB()); await sleep(600);
  await page.keyboard.press('Control+P'); await sleep(400); await type('alpha');
  const wsRow = await ev(() => { const rows = [...document.querySelectorAll('#topSearchIsland .qo-item')]; const r = rows.find(x => x.querySelector('.qo-label').textContent === 'Alpha Project'); if (!r) return null; const i = r.querySelector('.qo-icon i'); return { icon: i && i.className, enter: !!r.querySelector('.qo-enter') }; });
  ok(wsRow && /ri-folder-2-line/.test(wsRow.icon) && /icon-folder/.test(wsRow.icon) && /file-icon/.test(wsRow.icon), 'a workspace uses the Explorer\'s folder icon (ri-folder-2-line, file-icon, icon-folder)', wsRow);
  ok(wsRow && wsRow.enter, 'and the Explorer\'s "enter" arrow, so it still reads as a workspace');
  const folderIcon = await ev(() => { document.querySelector('.top-center .search-bar input').value = ''; return null; });
  await type('utils'); const fIcon = await ev(() => { const r = [...document.querySelectorAll('#topSearchIsland .qo-item')].find(x => x.querySelector('.qo-label').textContent === 'utils'); const i = r && r.querySelector('.qo-icon i'); return i && i.className; });
  ok(fIcon && /ri-folder-2-line/.test(fIcon) && /icon-folder/.test(fIcon), 'a folder uses the same icon', fIcon);
  ok(!(await ev(() => !!document.querySelector('#topSearchIsland .ri-briefcase-line'))), 'the invented briefcase icon is gone');
  await type('alpha');
  await page.keyboard.press('Enter'); await sleep(1500);
  ok((await ev(() => db.name)) === 'CodeMiniDB_WS_w1', 'choosing a workspace opens its own database, like clicking it in the Explorer', await ev(() => db.name));
  ok((await ev(() => folderStack[0].name)) === 'Alpha Project', 'and the breadcrumb starts at the workspace', await ev(() => folderStack.map(f => f.name)));

  console.log('\n[the island hangs from the top bar, wherever the bar is]');
  const gap = () => ev(() => { const m = document.querySelector('.top-menu').getBoundingClientRect(), i = document.getElementById('topSearchIsland').getBoundingClientRect(); return { menuBottom: Math.round(m.bottom), islandTop: Math.round(i.top), gap: Math.round(i.top - m.bottom), shown: document.getElementById('topSearchIsland').style.display === 'flex' }; });
  const scenario = async (label, setup, viewport) => {
    await page.setViewportSize(viewport); await ev(setup); await sleep(500);
    await page.keyboard.press('Escape'); await sleep(100);
    await page.keyboard.press('Control+P'); await sleep(500);
    const g = await gap();
    ok(g.shown && g.gap >= 0 && g.gap <= 6, label, g);
  };
  const clear = () => { document.documentElement.classList.remove('is-android', 'is-ios'); document.body.classList.remove('hide-window-bar'); };
  await scenario('desktop, window bar showing: just under the top bar', clear, { width: 1280, height: 800 });
  await scenario('desktop, window bar hidden: moves up with the bar', () => { document.documentElement.classList.remove('is-android'); document.body.classList.add('hide-window-bar'); }, { width: 1280, height: 800 });
  const desk = await gap();
  await scenario('phone (iOS layout), window bar showing', clear, { width: 390, height: 800 });
  const ios = await gap();
  await scenario('phone (iOS layout), window bar hidden', () => { document.body.classList.add('hide-window-bar'); }, { width: 390, height: 800 });
  const iosHidden = await gap();
  await scenario('Android, window bar showing (it is shorter there: no 120px gap)', () => { document.documentElement.classList.remove('is-ios'); document.body.classList.remove('hide-window-bar'); document.documentElement.classList.add('is-android'); }, { width: 390, height: 800 });
  const andr = await gap();
  await scenario('Android, window bar hidden', () => { document.documentElement.classList.add('is-android'); document.body.classList.add('hide-window-bar'); }, { width: 390, height: 800 });
  const andrHidden = await gap();
  ok(desk.islandTop < 60, 'with the bar hidden the island really is higher than the old fixed 80px', desk);
  ok(andr.islandTop < ios.islandTop, 'on Android the island sits higher than on iOS, whose bars are taller', { andr: andr.islandTop, ios: ios.islandTop });
  ok(andrHidden.islandTop < andr.islandTop && iosHidden.islandTop < ios.islandTop, 'hiding the window bar raises it on both phones', { andrHidden: andrHidden.islandTop, andr: andr.islandTop, iosHidden: iosHidden.islandTop, ios: ios.islandTop });
  ok(andr.islandTop < 120 && andrHidden.islandTop < 120, 'neither is stuck at the old 120px');
  await ev(() => document.body.classList.remove('hide-window-bar'));
  await sleep(300);
  ok((await gap()).gap >= 0 && (await gap()).gap <= 6, 'toggling the window bar while the island is open moves it right away', await gap());
  await ev(clear); await page.setViewportSize({ width: 1280, height: 800 }); await sleep(300);
  await page.keyboard.press('Escape'); await sleep(200);

  console.log('\n[the old behaviors still work]');
  await page.click(input); await sleep(500);
  ok(await isOpen(), 'clicking the search box still opens the island');
  await page.mouse.click(5, 400); await sleep(200);
  ok(!(await isOpen()), 'clicking outside closes it');
  await ev(() => { document.querySelector('.top-center .search-bar input').value = ''; });

  console.log('\n[phone size]');
  await page.setViewportSize({ width: 390, height: 800 }); await sleep(500);
  await page.click(input); await sleep(500);
  const h = await ev(() => { const r = document.querySelector('#topSearchIsland .qo-item'); return r ? r.getBoundingClientRect().height : 0; });
  ok(h >= 44, 'rows are at least 44px tall for touch', h);
  ok(await ev(() => { const b = document.getElementById('topSearchIsland').getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth; }), 'the island fits the screen width');
  await ev(() => document.querySelector('#topSearchIsland').dispatchEvent(new Event('touchmove')));
  ok(await ev(() => document.activeElement !== document.querySelector('.top-center .search-bar input')), 'scrolling the list puts the keyboard away');

  const rel = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i.test(e));
  ok(rel.length === 0, 'no unexpected page errors', rel);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
