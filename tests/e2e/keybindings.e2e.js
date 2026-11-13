// Keyboard shortcuts in the real app (js/core/keybindings.js): the defaults still do what they did, and Settings >
// Keybindings changes, warns about, saves and resets them. Spies on the controls a shortcut drives keep this independent
// of what the UI looks like afterwards; no real Monaco is needed.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const URL = 'http://localhost:8765/index.html';

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (deps, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); }; window.require.config = () => {};
  });
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  const ev = (f, a) => page.evaluate(f, a);
  const boot = async () => { await page.goto(URL); await sleep(5200); };
  await boot();

  // Spies: how often the control each shortcut drives was used.
  const spy = () => ev(() => {
    window.__n = {};
    ['folderIconItem', 'terminalIconItem', 'searchIconItem', 'menuNewFile'].forEach((id) => { const el = document.getElementById(id); if (el && !el.__spy) { el.__spy = true; el.addEventListener('click', () => { window.__n[id] = (window.__n[id] || 0) + 1; }); } });
    if (!window.__origSave) { window.__origSave = window.performActiveSave; window.performActiveSave = function () { window.__n.save = (window.__n.save || 0) + 1; return true; }; }
    // A stand-in editor: it records the format request and shrugs at anything else the app asks of an editor.
    window.getActiveMonacoEditor = () => new Proxy({ getAction: (id) => ({ run: () => { window.__n.format = id; } }) }, { get: (t, k) => (k in t ? t[k] : () => {}) });
  });
  const n = (k) => ev((k) => (window.__n && window.__n[k]) || 0, k);
  const key = async (combo) => { await page.keyboard.press(combo); await sleep(160); };
  const keyN = async (combo, k) => { const before = await n(k); await key(combo); return (await n(k)) - before; };
  await spy();

  console.log('\n[the shortcuts that existed still do what they did]');
  ok(await keyN('Control+b', 'folderIconItem') === 1, 'Ctrl+B toggles the sidebar');
  ok(await keyN('Meta+b', 'folderIconItem') === 1, 'Cmd+B does too now (it never did before)');
  ok(await keyN('Control+Backquote', 'terminalIconItem') === 1, 'Ctrl+` opens the terminal');
  ok(await keyN('Control+Shift+f', 'searchIconItem') === 1, 'Ctrl+Shift+F opens search');
  ok(await keyN('Alt+n', 'menuNewFile') === 1, 'Alt+N starts a new file');
  ok(await keyN('Control+s', 'save') === 1 && await keyN('Control+S', 'save') === 1, 'Ctrl+S saves, whatever the key\u2019s case');
  await ev(() => { window.__n.format = null; }); await key('Shift+Alt+f');
  ok(await ev(() => window.__n.format) === 'editor.action.formatDocument', 'Shift+Alt+F runs Monaco\u2019s formatter');
  await ev(() => { const c = document.querySelector('.btn-cancel'); if (c) c.click(); }); await sleep(200); // Alt+N opened the new-file dialog
  await key('Escape');
  const isOpen = () => ev(() => document.getElementById('topSearchIsland').style.display === 'flex');
  await key('Control+p'); ok(await isOpen(), 'Ctrl+P opens Quick Open');
  ok(!String(await ev(() => document.activeElement.value)).startsWith('>'), 'in file mode (no > typed)');
  await key('Escape');
  await key('F1'); ok(await isOpen() && String(await ev(() => document.activeElement.value)).startsWith('>'), 'F1 opens it in command mode');
  await key('Escape');
  await key('Control+Shift+p'); ok(await isOpen() && String(await ev(() => document.activeElement.value)).startsWith('>'), 'Ctrl+Shift+P too');
  await key('Escape');
  ok(await ev(() => !!window.CodeMiniKeybindings && window.CodeMiniKeybindings.registry.commands().length === 12), 'twelve commands are in the registry');

  // ------------------------------------------------------------------------------------------------
  console.log('\n[Settings > Keybindings]');
  const openKb = async () => {
    await ev(() => document.getElementById('settingsIconItem').click()); await sleep(1300);
    await ev(() => document.querySelector('.settings-sidebar-item[data-tab="keybinds"]').click()); await sleep(300);
  };
  const row = (id) => ev((id) => {
    const r = document.querySelector(`#kbRows .kb-row[data-kb-id="${id}"]`); if (!r) return null;
    const note = r.querySelector('.kb-note');
    return { keys: [...r.querySelectorAll('.kbd-badge')].map(b => b.textContent), source: r.querySelector('.kb-source') && r.querySelector('.kb-source').textContent, none: !!r.querySelector('.kb-none'),
      note: note && !note.hidden ? note.textContent : '', acts: [...r.querySelectorAll('.kb-btn')].map(b => b.dataset.kbAct), isItem: r.classList.contains('settings-item') };
  }, id);
  const rec = (id) => `#kbRows .kb-row[data-kb-id="${id}"]`;
  const storeKey = () => ev(() => window.getPrefixedKey('keybindings'));
  const stored = () => ev(() => { const k = window.getPrefixedKey('keybindings'); return localStorage.getItem(k); });
  await openKb();
  const names = await ev(() => [...document.querySelectorAll('#kbRows .kb-row strong')].map(s => s.textContent));
  ok(names.length === 12 && names[0] === 'Save File' && names.includes('Command Palette') && names.includes('Commit') && names.includes('Run Cell'), 'a row for each of the 12 commands', names);
  ok(await ev(() => [...document.querySelectorAll('#kbRows h3')].map(h => h.textContent).join('|')) === 'File Management|Execution|Navigation & Formatting|Source Control', 'grouped as before');
  let r = await row('view.toggleSidebar');
  ok(r.isItem && r.keys.join() === 'Ctrl + B' && r.source === 'Default' && r.acts.join() === 'edit,clear', 'a row is a Settings row: the command, Ctrl + B, "Default", a pencil and a remove', r);
  r = await row('quickOpen.commands');
  ok(r.keys.join() === 'F1,Ctrl + Shift + P', 'the Command Palette shows both its keys', r);
  ok(/When: Not while typing in a Word document/.test(await ev(() => document.querySelector(`#kbRows .kb-row[data-kb-id="view.toggleSidebar"] .kb-meta`).textContent)), 'and when it applies');
  ok(await ev(() => document.querySelector('#set-keybinds').innerText.includes('Open to the Side')) && await ev(() => document.querySelector('#set-keybinds').innerText.includes('Autocomplete')), 'the fixed shortcuts are still listed');
  await ev(() => { const i = document.querySelector('.settings-search-bar input'); i.value = 'quick open'; i.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(300);
  const visible = await ev(() => [...document.querySelectorAll('#kbRows .kb-row')].filter(r => !r.classList.contains('search-hidden')).map(r => r.dataset.kbId));
  ok(visible.join() === 'quickOpen.files', 'the Settings search box finds a shortcut by its name', visible);
  await ev(() => { const i = document.querySelector('.settings-search-bar input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(300);

  console.log('\n[changing a shortcut]');
  await page.click(rec('view.toggleSidebar') + ' [data-kb-act="edit"]'); await sleep(200);
  const recText = () => ev(() => { const t = document.querySelector('.kb-recorder .kb-rec-text'); return t ? t.textContent : null; });
  ok(await recText() === 'Press desired key combination' && await ev(() => document.activeElement.classList.contains('kb-recorder')), 'the pencil opens a recorder that asks for the keys and has focus');
  const before = await n('folderIconItem');
  await key('Control+b');
  ok(await n('folderIconItem') === before, 'while recording, Ctrl+B is recorded and does not also toggle the sidebar', [before, await n('folderIconItem')]);
  ok(await recText() === 'Ctrl + B', 'it shows what was pressed');
  await page.keyboard.down('Alt'); await page.keyboard.down('Shift'); await sleep(150);
  ok(/Shift \+ Alt \+ \u2026/.test(await recText()), 'holding modifiers shows them as you hold them', await recText());
  await page.keyboard.press('b'); await sleep(150);
  await page.keyboard.up('Shift'); await page.keyboard.up('Alt');
  ok(await recText() === 'Shift + Alt + B', 'Alt+Shift+B is shown in the canonical order', await recText());
  await key('Enter');
  r = await row('view.toggleSidebar');
  ok(r.keys.join() === 'Shift + Alt + B' && r.source === 'User' && r.acts.join() === 'edit,clear,reset', 'Enter saves it: the new key, "User", and a reset icon appears', r);
  ok(JSON.parse(await stored())['view.toggleSidebar'].join() === 'Shift+Alt+B', 'it is stored under this window\u2019s own key', await stored());
  ok(await keyN('Alt+Shift+b', 'folderIconItem') === 1, 'the new key toggles the sidebar');
  ok(await keyN('Control+b', 'folderIconItem') === 0, 'and the old one no longer does');

  await page.click(rec('view.toggleSidebar') + ' [data-kb-act="reset"]'); await sleep(200);
  r = await row('view.toggleSidebar');
  ok(r.keys.join() === 'Ctrl + B' && r.source === 'Default' && r.acts.join() === 'edit,clear' && await stored() === null, 'reset brings the default back and clears what was stored', [r, await stored()]);
  ok(await keyN('Control+b', 'folderIconItem') === 1, 'Ctrl+B works again');

  await page.click(rec('view.toggleSidebar') + ' [data-kb-act="edit"]'); await sleep(150);
  await key('Control+Alt+Shift+k'); ok(await recText() === 'Ctrl + Shift + Alt + K', 'a combination is shown');
  await key('Escape');
  ok(await ev(() => !document.querySelector('.kb-recorder')) && (await row('view.toggleSidebar')).source === 'Default' && await stored() === null, 'Esc cancels and changes nothing');
  await page.click(rec('view.toggleSidebar') + ' [data-kb-act="edit"]'); await sleep(150);
  await page.click(rec('view.toggleSidebar') + ' [data-kb-act="cancel"]'); await sleep(150);
  ok(await ev(() => !document.querySelector('.kb-recorder')), 'so does the cross button');

  console.log('\n[what is refused and what is warned about]');
  await page.click(rec('file.new') + ' [data-kb-act="edit"]'); await sleep(150);
  const confirmDisabled = () => ev(() => document.querySelector('.kb-btn[data-kb-act="confirm"]').disabled);
  const noteText = () => ev(() => { const r = document.querySelector('.kb-recorder').closest('.kb-row'); const nn = r.querySelector('.kb-note'); return nn && !nn.hidden ? nn.textContent : ''; });
  await key('a');
  ok(await confirmDisabled() && /Add Ctrl or Alt/.test(await noteText()), 'a bare letter is refused, with the reason');
  await key('Enter');
  ok(await ev(() => !!document.querySelector('.kb-recorder')) && (await stored()) === null, 'and Enter does not accept it');
  await key('Shift+a'); ok(await confirmDisabled(), 'Shift+letter is refused too');
  await key('Shift+Enter'); ok(!(await confirmDisabled()), 'Shift+Enter is fine: it types nothing');
  await key('Control+t');
  ok(!(await confirmDisabled()) && /browser keeps Ctrl\+T for itself/.test(await noteText()), 'Ctrl+T is allowed but the browser-reserved warning shows', await noteText());
  await key('Control+Alt+n');
  ok(/AltGr/.test(await noteText()), 'Ctrl+Alt+N warns about AltGr', await noteText());
  await key('Control+Backquote');
  ok(/Also used by Open Terminal/.test(await noteText()), 'a key another command has says so before you accept it', await noteText());
  await key('Escape');

  await page.click(rec('view.toggleSidebar') + ' [data-kb-act="edit"]'); await sleep(150);
  await key('Control+Backquote'); await key('Enter'); await sleep(200);
  r = await row('view.toggleSidebar'); const rt = await row('view.toggleTerminal');
  ok(/Also used by Open Terminal/.test(r.note) && /Also used by Toggle Sidebar/.test(rt.note), 'a conflict is shown on both rows once saved', [r.note, rt.note]);
  await page.click(rec('view.toggleSidebar') + ' [data-kb-act="reset"]'); await sleep(200);
  ok((await row('view.toggleTerminal')).note === '', 'and goes when it is resolved');

  console.log('\n[removing, reset all, and the palette]');
  await page.click(rec('tab.close') + ' [data-kb-act="clear"]'); await sleep(200);
  r = await row('tab.close');
  ok(r.none && r.keys.length === 0 && r.source === 'User' && !r.acts.includes('clear'), '"Remove" leaves the command with no shortcut ("Not set", "User")', r);
  await ev(() => { window.__closed = 0; });
  ok(JSON.parse(await stored())['tab.close'].length === 0, 'an empty list is stored, which is different from the default');
  await page.click(rec('view.toggleSidebar') + ' [data-kb-act="edit"]'); await sleep(150);
  await key('Alt+Shift+b'); await key('Enter'); await sleep(200);
  await key('Control+p'); await sleep(200); await page.keyboard.type('>toggle sid'); await sleep(300);
  const palette = await ev(() => [...document.querySelectorAll('#topSearchIsland .qo-item')].map(r => ({ l: r.querySelector('.qo-label').textContent, k: (r.querySelector('.qo-kbd') || {}).textContent })));
  ok(palette.some(p => p.l === 'Toggle Sidebar' && p.k === 'Shift+Alt+B'), 'the command palette shows the key you set, not the old one', palette);
  await key('Escape');
  await ev(() => { document.querySelector('#kbResetAll').click(); }); await sleep(400);
  await page.locator('.btn-submit', { hasText: 'Reset all' }).click(); await sleep(500);
  const all = await ev(() => [...document.querySelectorAll('#kbRows .kb-row')].map(r => r.querySelector('.kb-source').textContent));
  ok(all.length === 12 && all.every(s => s === 'Default') && await stored() === null, 'Reset all puts every shortcut back and clears what was stored', all);
  ok(await keyN('Control+b', 'folderIconItem') === 1, 'and the defaults work');

  console.log('\n[a reload, and recording never leaves shortcuts off]');
  await page.click(rec('file.new') + ' [data-kb-act="edit"]'); await sleep(150);
  await key('Alt+Shift+m'); await key('Enter'); await sleep(200);
  await boot(); await spy();
  ok(await keyN('Alt+Shift+m', 'menuNewFile') === 1 && await keyN('Alt+n', 'menuNewFile') === 0, 'after a reload the changed shortcut is still the one that works');
  await ev(() => { const c = document.querySelector('.btn-cancel'); if (c) c.click(); }); await sleep(300); // the new-file dialog it opened
  await openKb();
  ok((await row('file.new')).keys.join() === 'Shift + Alt + M' && (await row('file.new')).source === 'User', 'and Settings shows it');
  await page.click(rec('file.save') + ' [data-kb-act="edit"]'); await sleep(150);
  ok(await ev(() => window.CodeMiniKeybindings.registry.isRecording()), 'a recorder is open');
  await ev(() => document.querySelector('.tab[data-type="settings"] .tab-close').click()); await sleep(500);
  ok(await keyN('Control+s', 'save') === 1, 'closing Settings with a recorder open does not leave shortcuts off');
  await openKb();
  await page.click(rec('file.new') + ' [data-kb-act="reset"]'); await sleep(200);
  ok(await stored() === null, 'tidied up');

  ok(errors.length === 0, 'no uncaught errors in the page', errors.slice(0, 3));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
