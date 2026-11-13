// Keyboard shortcuts (js/core/keybindings.js): the combo rules, the catalog, the registry with the user's changes, the
// dispatcher, and the wiring that replaced the old scattered handlers. The Settings screen (recording a key, the rows,
// reload) is covered in a browser by tests/e2e/keybindings.e2e.js.
const assert = require('assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const K = require('../js/core/keybindings.js');
const { CATALOG, nameKey, comboFromEvent, parseCombo, normalizeCombo, formatCombo, validateBinding, reservedWarning, altGrWarning, scopesOverlap, createRegistry } = K;
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok', name); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const count = (src, re) => (src.match(re) || []).length;

// A keydown event stand-in that records what was done to it.
const ev = (o) => {
  const e = Object.assign({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, key: '', code: '', prevented: 0, stopped: 0 }, o);
  e.preventDefault = () => { e.prevented++; }; e.stopPropagation = () => { e.stopped++; };
  e.getModifierState = (name) => !!(e.altGraph && name === 'AltGraph');
  return e;
};
const memStore = (initial) => { const s = { data: initial || null, saved: [] }; s.load = () => s.data; s.save = (o) => { s.data = JSON.parse(JSON.stringify(o)); s.saved.push(s.data); }; return s; };
const mk = (store, extra) => {
  const r = createRegistry(store || memStore());
  CATALOG.forEach((c) => r.register(Object.assign({}, c, (extra && extra[c.id]) || {})));
  r.reload();
  return r;
};

console.log('key names and combos');
t('a letter is upper case, so Caps Lock does not change a shortcut', () => {
  assert.strictEqual(nameKey('s', 'KeyS'), 'S'); assert.strictEqual(nameKey('S', 'KeyS'), 'S');
  assert.strictEqual(comboFromEvent(ev({ ctrlKey: true, key: 'S' })), 'Ctrl+S', 'the old handler only saw a lower-case s');
});
t('modifiers are always written Ctrl, Shift, Alt, then the key, and Cmd counts as Ctrl', () => {
  assert.strictEqual(comboFromEvent(ev({ altKey: true, shiftKey: true, ctrlKey: true, key: 'f' })), 'Ctrl+Shift+Alt+F');
  assert.strictEqual(comboFromEvent(ev({ metaKey: true, key: 'p' })), 'Ctrl+P');
  assert.strictEqual(comboFromEvent(ev({ shiftKey: true, altKey: true, key: 'F' })), 'Shift+Alt+F');
});
t('named keys: Space, arrows, Enter, Escape and the function keys', () => {
  assert.strictEqual(nameKey(' ', 'Space'), 'Space'); assert.strictEqual(nameKey('ArrowUp', ''), 'Up'); assert.strictEqual(nameKey('Escape', ''), 'Esc');
  assert.strictEqual(nameKey('Enter', ''), 'Enter'); assert.strictEqual(nameKey('F1', ''), 'F1'); assert.strictEqual(nameKey('F24', ''), 'F24');
  assert.strictEqual(nameKey('F25', ''), null); assert.strictEqual(nameKey('`', 'Backquote'), '`');
});
t('a modifier on its own is not a combination', () => {
  for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']) assert.strictEqual(comboFromEvent(ev({ key, ctrlKey: key === 'Control' })), null, key);
});
t('Alt on a Mac turns N into a tilde: the physical key is used then', () => {
  assert.strictEqual(comboFromEvent(ev({ altKey: true, key: '\u02dc', code: 'KeyN' })), 'Alt+N');
  assert.strictEqual(comboFromEvent(ev({ altKey: true, key: 'Dead', code: 'Digit5' })), 'Alt+5');
  assert.strictEqual(comboFromEvent(ev({ altKey: true, key: '\u00e5', code: 'Minus' })), 'Alt+-');
  assert.strictEqual(comboFromEvent(ev({ altKey: true, key: '\u00e5', code: 'F13' })), null, 'no physical name to fall back on');
});
t('AltGr never forms a combination, so typing a character is never a shortcut', () => {
  assert.strictEqual(comboFromEvent(ev({ ctrlKey: true, altKey: true, key: 'n', altGraph: true })), null);
});
t('a combo can be written in many ways and is read back the same', () => {
  assert.strictEqual(normalizeCombo('ctrl + shift + f'), 'Ctrl+Shift+F'); assert.strictEqual(normalizeCombo('Cmd+Option+k'), 'Ctrl+Alt+K');
  assert.strictEqual(normalizeCombo('Control+Escape'), 'Ctrl+Esc'); assert.strictEqual(normalizeCombo('alt+arrowup'), 'Alt+Up');
  assert.strictEqual(normalizeCombo('Ctrl++'), 'Ctrl++'); assert.strictEqual(normalizeCombo('f1'), 'F1');
  assert.strictEqual(normalizeCombo('Ctrl+`'), 'Ctrl+`');
  for (const bad of ['', '   ', 'Ctrl+', 'Ctrl+Foo', 'Hyper+A', null, undefined, 42]) assert.strictEqual(normalizeCombo(bad), null, String(bad));
});
t('displayed combos are spaced the way the Keybindings tab shows them', () => {
  assert.strictEqual(formatCombo('ctrl+shift+f'), 'Ctrl + Shift + F'); assert.strictEqual(formatCombo('F1'), 'F1'); assert.strictEqual(formatCombo('Ctrl++'), 'Ctrl + +'); assert.strictEqual(formatCombo('nonsense+'), '');
});

console.log('what may be bound');
t('a shortcut needs Ctrl or Alt, or is a function key', () => {
  assert.strictEqual(validateBinding('A').ok, false); assert.strictEqual(validateBinding('Shift+A').ok, false);
  assert.strictEqual(validateBinding('Enter').ok, false); assert.strictEqual(validateBinding('Space').ok, false);
  assert.strictEqual(validateBinding('Ctrl+A').ok, true); assert.strictEqual(validateBinding('Shift+Alt+B').ok, true);
  assert.strictEqual(validateBinding('F5').ok, true); assert.strictEqual(validateBinding('Shift+F5').ok, true);
  assert.strictEqual(validateBinding('Shift+Enter').ok, true, 'Run Cell and Move On has always been Shift+Enter: it types nothing');
  assert.strictEqual(validateBinding('Shift+Up').ok, true); assert.strictEqual(validateBinding('Shift+Tab').ok, true);
  assert.strictEqual(validateBinding('Shift+Space').ok, false, 'Shift+Space types a space'); assert.strictEqual(validateBinding('Shift+1').ok, false); assert.strictEqual(validateBinding('Esc').ok, false);
  assert.strictEqual(validateBinding('not a key').ok, false);
  assert.ok(validateBinding('A').message.length > 10, 'and it says why');
});
t('keys the browser keeps for itself are flagged (that is why New File is Alt+N)', () => {
  for (const c of ['Ctrl+N', 'Ctrl+T', 'Ctrl+W', 'ctrl+shift+t', 'Ctrl+Tab', 'Alt+F4']) assert.ok(reservedWarning(c), c);
  for (const c of ['Alt+N', 'Alt+W', 'Ctrl+B', 'F1', 'junk']) assert.strictEqual(reservedWarning(c), null, c);
});
t('Ctrl+Alt without Shift is flagged as AltGr', () => {
  assert.ok(altGrWarning('Ctrl+Alt+N')); assert.strictEqual(altGrWarning('Ctrl+Shift+Alt+N'), null); assert.strictEqual(altGrWarning('Alt+N'), null); assert.strictEqual(altGrWarning('Ctrl+N'), null);
});

console.log('the catalog');
t('every command has a unique id, a name, a description and valid defaults', () => {
  const ids = CATALOG.map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const c of CATALOG) {
    assert.ok(c.name && c.description && c.category && c.when, c.id);
    assert.ok(['global', 'notebook', 'scm'].includes(c.scope), c.id);
    assert.ok(c.defaults.length >= 1, c.id);
    for (const d of c.defaults) { assert.strictEqual(normalizeCombo(d), d, c.id + ' ' + d + ' is written canonically'); assert.strictEqual(validateBinding(d).ok, true, c.id + ' ' + d); }
  }
});
t('no two defaults clash where their scopes overlap', () => {
  const seen = [];
  for (const c of CATALOG) for (const d of c.defaults) for (const o of seen) assert.ok(!(o.combo === d && scopesOverlap(o.scope, c.scope)), `${o.id} and ${c.id} both default to ${d}`);
  CATALOG.forEach((c) => c.defaults.forEach((d) => seen.push({ id: c.id, scope: c.scope, combo: d })));
});
t('the shortcuts that were fixed before are the defaults now', () => {
  const want = { 'file.save': ['Ctrl+S'], 'file.new': ['Alt+N'], 'tab.close': ['Alt+W'], 'notebook.runCell': ['Ctrl+Enter'], 'notebook.runAdvance': ['Shift+Enter'],
    'quickOpen.files': ['Ctrl+P'], 'quickOpen.commands': ['F1', 'Ctrl+Shift+P'], 'view.toggleSidebar': ['Ctrl+B'], 'view.toggleTerminal': ['Ctrl+`'],
    'view.searchFiles': ['Ctrl+Shift+F'], 'editor.format': ['Shift+Alt+F'], 'scm.commit': ['Ctrl+Enter'] };
  assert.deepStrictEqual(Object.fromEntries(CATALOG.map((c) => [c.id, c.defaults])), want);
});
t('every global command has an action in the browser half, and a scoped one has none to run', () => {
  const src = read('js/core/keybindings.js');
  const runBlock = src.slice(src.indexOf('const RUN = {'), src.indexOf('const TEST = {'));
  for (const c of CATALOG) {
    const has = new RegExp("'" + c.id.replace('.', '\\.') + "':").test(runBlock);
    assert.strictEqual(has, c.scope === 'global', c.id + (c.scope === 'global' ? ' has no action' : ' is scoped but has an action here'));
  }
});

console.log('the registry and what the user changed');
t('with nothing changed, every command has its defaults and none is custom', () => {
  const r = mk();
  for (const c of CATALOG) { assert.deepStrictEqual(r.bindings(c.id), c.defaults); assert.strictEqual(r.isCustom(c.id), false); }
  assert.strictEqual(r.label('file.new'), 'Alt+N'); assert.strictEqual(r.label('quickOpen.commands'), 'F1', 'the palette shows the first one');
  assert.strictEqual(r.customCount(), 0);
});
t('a changed shortcut replaces the defaults, is saved, and the old key stops matching', () => {
  const s = memStore(), r = mk(s);
  assert.strictEqual(r.setBinding('view.toggleSidebar', ['Shift+Alt+B']), true);
  assert.deepStrictEqual(r.bindings('view.toggleSidebar'), ['Shift+Alt+B']); assert.strictEqual(r.isCustom('view.toggleSidebar'), true);
  assert.deepStrictEqual(s.data, { 'view.toggleSidebar': ['Shift+Alt+B'] }, 'only what changed is stored');
  assert.strictEqual(r.matches(ev({ altKey: true, shiftKey: true, key: 'B' }), 'view.toggleSidebar'), true);
  assert.strictEqual(r.matches(ev({ ctrlKey: true, key: 'b' }), 'view.toggleSidebar'), false);
});
t('setting a command back to its own defaults is not a change', () => {
  const s = memStore(), r = mk(s);
  r.setBinding('file.new', ['Ctrl+Shift+Alt+N']); assert.strictEqual(r.isCustom('file.new'), true);
  r.setBinding('file.new', ['Alt+N']); assert.strictEqual(r.isCustom('file.new'), false); assert.deepStrictEqual(s.data, {});
});
t('"no shortcut" is a change too, and reset brings the defaults back', () => {
  const r = mk();
  r.setBinding('tab.close', []);
  assert.deepStrictEqual(r.bindings('tab.close'), []); assert.strictEqual(r.isCustom('tab.close'), true); assert.strictEqual(r.label('tab.close'), '');
  r.reset('tab.close'); assert.deepStrictEqual(r.bindings('tab.close'), ['Alt+W']); assert.strictEqual(r.isCustom('tab.close'), false);
});
t('reset all clears every change', () => {
  const s = memStore(), r = mk(s);
  r.setBinding('file.new', ['Shift+Alt+N']); r.setBinding('tab.close', []);
  assert.strictEqual(r.customCount(), 2); r.resetAll(); assert.strictEqual(r.customCount(), 0); assert.deepStrictEqual(s.data, {});
});
t('what is stored is read back, and bad entries are dropped instead of breaking anything', () => {
  const r = mk(memStore({
    'file.new': ['alt + shift + n'],            // written loosely: kept, canonical
    'tab.close': ['W'],                         // a bare letter would fire while typing
    'no.such.command': ['Ctrl+Q'],              // a command that no longer exists
    'view.searchFiles': 'Ctrl+K',               // not a list
    'editor.format': ['Ctrl+K', 'Ctrl+K', 'junk'], // duplicate and junk inside a list
    'file.save': ['Ctrl+S']                     // equal to the default: not a change
  }));
  assert.deepStrictEqual(r.bindings('file.new'), ['Shift+Alt+N'], 'written loosely, kept in canonical order');
  assert.deepStrictEqual(r.bindings('tab.close'), [], 'every entry was invalid, so it is "no shortcut", not the bare letter');
  assert.deepStrictEqual(r.bindings('view.searchFiles'), ['Ctrl+Shift+F']);
  assert.deepStrictEqual(r.bindings('editor.format'), ['Ctrl+K']);
  assert.strictEqual(r.isCustom('file.save'), false); assert.strictEqual(r.get('no.such.command'), null);
  for (const bad of ['not json object', [], 5, null]) assert.doesNotThrow(() => mk(memStore(bad)));
});
t('a store that throws does not break the registry', () => {
  const r = createRegistry({ load() { throw new Error('private mode'); }, save() { throw new Error('private mode'); } });
  CATALOG.forEach((c) => r.register(c));
  assert.doesNotThrow(() => r.reload()); assert.doesNotThrow(() => r.setBinding('file.new', ['Shift+Alt+N']));
  assert.deepStrictEqual(r.bindings('file.new'), ['Shift+Alt+N'], 'it still lasts for this page');
});
t('listeners hear about every change', () => {
  const r = mk(); let calls = 0; const off = r.onChange(() => { calls++; });
  r.setBinding('file.new', ['Shift+Alt+N']); r.reset('file.new'); r.resetAll();
  assert.strictEqual(calls, 3); off(); r.setBinding('file.new', []); assert.strictEqual(calls, 3);
});
t('a conflict is another command on the same key whose scope overlaps', () => {
  const r = mk();
  r.setBinding('view.toggleSidebar', ['Ctrl+`']);
  assert.deepStrictEqual(r.conflicts('view.toggleSidebar', 'Ctrl+`'), ['view.toggleTerminal']);
  assert.deepStrictEqual(r.conflicts('view.toggleTerminal', 'Ctrl+`'), ['view.toggleSidebar']);
  assert.deepStrictEqual(r.conflicts('file.new', 'Shift+Alt+Q'), []);
  assert.deepStrictEqual(r.conflicts('notebook.runCell', 'Ctrl+Enter'), [], 'Run Cell and Commit share Ctrl+Enter in different places: not a conflict');
  assert.deepStrictEqual(r.conflicts('scm.commit', 'Ctrl+Enter'), []);
  r.setBinding('file.save', ['Ctrl+Enter']);
  assert.deepStrictEqual(r.conflicts('file.save', 'Ctrl+Enter').sort(), ['notebook.runCell', 'scm.commit'], 'a global key shadows the scoped ones');
});

console.log('the dispatcher');
const ran = [];
const withRun = () => { const o = {}; CATALOG.filter((c) => c.scope === 'global').forEach((c) => { o[c.id] = { run: () => ran.push(c.id) }; }); return o; };
t('a default key runs its command, and the event is taken (so Monaco and the browser do not also act on it)', () => {
  ran.length = 0; const r = mk(null, withRun());
  const e = ev({ ctrlKey: true, key: 'b' });
  assert.strictEqual(r.handle(e), true); assert.deepStrictEqual(ran, ['view.toggleSidebar']); assert.strictEqual(e.prevented, 1); assert.strictEqual(e.stopped, 1);
});
t('both defaults of the Command Palette work', () => {
  ran.length = 0; const r = mk(null, withRun());
  r.handle(ev({ key: 'F1' })); r.handle(ev({ ctrlKey: true, shiftKey: true, key: 'P' }));
  assert.deepStrictEqual(ran, ['quickOpen.commands', 'quickOpen.commands']);
});
t('Cmd works where only Ctrl did (Toggle Sidebar, Terminal, Search, Format)', () => {
  ran.length = 0; const r = mk(null, withRun());
  r.handle(ev({ metaKey: true, key: 'b' })); r.handle(ev({ metaKey: true, shiftKey: true, key: 'f' }));
  assert.deepStrictEqual(ran, ['view.toggleSidebar', 'view.searchFiles']);
});
t('Ctrl+S saves whatever the key\'s case', () => {
  ran.length = 0; const r = mk(null, withRun());
  r.handle(ev({ ctrlKey: true, key: 's' })); r.handle(ev({ ctrlKey: true, key: 'S' }));
  assert.deepStrictEqual(ran, ['file.save', 'file.save']);
});
t('a moved shortcut: the new key runs it and the old key does nothing', () => {
  ran.length = 0; const r = mk(null, withRun());
  r.setBinding('file.save', ['Shift+Alt+S']);
  const old = ev({ ctrlKey: true, key: 's' }), now = ev({ altKey: true, shiftKey: true, key: 'S' });
  assert.strictEqual(r.handle(old), false); assert.strictEqual(old.prevented, 0, 'the old key is left to the browser');
  assert.strictEqual(r.handle(now), true); assert.deepStrictEqual(ran, ['file.save']);
});
t('an unbound command does nothing', () => {
  ran.length = 0; const r = mk(null, withRun());
  r.setBinding('tab.close', []);
  assert.strictEqual(r.handle(ev({ altKey: true, key: 'w' })), false); assert.deepStrictEqual(ran, []);
});
t('a key the user set beats a default on the same key', () => {
  ran.length = 0; const r = mk(null, withRun());
  r.setBinding('view.searchFiles', ['Ctrl+B']); // Toggle Sidebar still defaults to Ctrl+B
  r.handle(ev({ ctrlKey: true, key: 'b' }));
  assert.deepStrictEqual(ran, ['view.searchFiles']);
});
t('a command whose condition fails lets the next one on that key run, or leaves the key alone', () => {
  ran.length = 0;
  const extra = withRun(); extra['view.toggleSidebar'].test = (e) => !e.inDocument;
  const r = mk(null, extra);
  const inDoc = ev({ ctrlKey: true, key: 'b' }); inDoc.inDocument = true;
  assert.strictEqual(r.handle(inDoc), false); assert.strictEqual(inDoc.prevented, 0, 'Bold in the document editor keeps Ctrl+B');
  r.setBinding('view.searchFiles', ['Ctrl+B']);
  const inDoc2 = ev({ ctrlKey: true, key: 'b' }); inDoc2.inDocument = true; ran.length = 0;
  r.handle(inDoc2); assert.deepStrictEqual(ran, ['view.searchFiles'], 'no condition on search, so it runs');
});
t('scoped commands are not run by the dispatcher (their feature asks with matches)', () => {
  ran.length = 0; const r = mk(null, withRun());
  const e = ev({ ctrlKey: true, key: 'Enter' });
  assert.strictEqual(r.handle(e), false); assert.strictEqual(e.prevented, 0);
  assert.strictEqual(r.matches(e, 'notebook.runCell'), true); assert.strictEqual(r.matches(e, 'scm.commit'), true);
  assert.strictEqual(r.matches(ev({ shiftKey: true, key: 'Enter' }), 'notebook.runAdvance'), true);
  r.setBinding('notebook.runCell', ['Alt+R']);
  assert.strictEqual(r.matches(e, 'notebook.runCell'), false); assert.strictEqual(r.matches(ev({ altKey: true, key: 'r' }), 'notebook.runCell'), true);
});
t('a lone modifier, AltGr, and an unrelated key do nothing', () => {
  ran.length = 0; const r = mk(null, withRun());
  assert.strictEqual(r.handle(ev({ key: 'Control', ctrlKey: true })), false);
  assert.strictEqual(r.handle(ev({ ctrlKey: true, altKey: true, key: 'n', altGraph: true })), false);
  assert.strictEqual(r.handle(ev({ key: 'a' })), false); assert.deepStrictEqual(ran, []);
});
t('while a key is being recorded no shortcut fires, and a recorder that went away ends it', () => {
  ran.length = 0; const r = mk(null, withRun()); let open = true;
  r.setRecording(() => open);
  assert.strictEqual(r.handle(ev({ ctrlKey: true, key: 's' })), false); assert.deepStrictEqual(ran, []);
  open = false; // the Settings tab was closed with the recorder open
  assert.strictEqual(r.handle(ev({ ctrlKey: true, key: 's' })), true); assert.deepStrictEqual(ran, ['file.save'], 'shortcuts must never stay off');
  assert.strictEqual(r.isRecording(), false);
});

console.log('wiring (source checks)');
t('the old scattered handlers are gone and the registry is loaded and precached', () => {
  const script = read('js/core/script.js'), qo = read('js/core/quick-open.js');
  assert.ok(!/e\.key\.toLowerCase\(\) === 'b'/.test(script) && !/e\.key === '`'/.test(script), 'script.js no longer handles Ctrl+B / Ctrl+`');
  assert.ok(!/document\.addEventListener\('keydown'/.test(qo), 'quick-open.js no longer has its own Ctrl+P handler');
  assert.ok(!/key === 's'\)/.test(read('js/notebook/notebook-ui.js')), 'the notebook handler no longer saves');
  assert.ok(/<script src="js\/core\/keybindings\.js"><\/script>/.test(read('index.html')));
  assert.ok(/'\/js\/core\/keybindings\.js'/.test(read('sw.js')));
});
t('Run Cell, Run and Move On and Commit ask the registry, and the palette shows the live key', () => {
  const nb = read('js/notebook/notebook-ui.js'), git = read('js/git/git.js'), qo = read('js/core/quick-open.js');
  assert.ok(/kb\.matches\(e, 'notebook\.runCell'\)/.test(nb) && /kb\.matches\(e, 'notebook\.runAdvance'\)/.test(nb));
  assert.ok(/kb\.matches\(e, 'scm\.commit'\)/.test(git));
  assert.strictEqual(count(qo, /keys: '[^']+'/g), 0, 'no hard-coded key label is left in the palette');
  for (const id of ['file.new', 'view.toggleTerminal', 'view.toggleSidebar', 'view.searchFiles', 'editor.format', 'tab.close']) assert.ok(qo.includes("keyOf('" + id + "')"), id);
});
t('Settings: the rebindable rows are made by the module, the fixed ones stay, and windows switch with their shortcuts', () => {
  const sp = read('js/core/settings-profile.js');
  const sec = sp.slice(sp.indexOf('id="set-keybinds"'), sp.indexOf('id="set-application"'));
  assert.ok(sec.includes('id="kbRows"') && sec.includes('id="kbResetAll"'));
  assert.ok(!/<strong>Toggle Sidebar<\/strong>|<strong>Save File<\/strong>|<strong>Run Cell<\/strong>|<strong>Commit<\/strong>/.test(sec), 'no static copy of a rebindable row');
  for (const fixed of ['Open to the Side', 'Autocomplete', 'Cancel Input', 'Command History', 'Exit', 'Indent']) assert.ok(sec.includes('<strong>' + fixed + '</strong>'), fixed + ' is still listed');
  assert.ok(/window\.CodeMiniKeybindings\.renderSettings\(settingsContainer\)/.test(sp));
  assert.ok(/window\.CodeMiniKeybindings\.reloadFor\(winId, isProfile\)/.test(sp));
});
t('getPrefixedKey: one rule for global, isolated-profile and synced settings', () => {
  const sp = read('js/core/settings-profile.js');
  const src = sp.slice(sp.indexOf('window.getPrefixedKey = function'), sp.indexOf('window.reloadSettings = function'));
  const mkWin = (store) => { const w = {}; vm.runInContext(src, vm.createContext({ window: w, localStorage: { getItem: (k) => (k in store ? store[k] : null) }, JSON })); return w.getPrefixedKey; };
  const wins = JSON.stringify([{ id: 'win_default', profile: false }, { id: 'win_p1', profile: true }]);
  assert.strictEqual(mkWin({})('x'), 'codemini_x', 'nothing stored: the default window');
  assert.strictEqual(mkWin({ codemini_windows: wins, codemini_active_window: 'win_default' })('x'), 'codemini_x');
  assert.strictEqual(mkWin({ codemini_windows: wins, codemini_active_window: 'win_p1' })('x'), 'codemini_win_p1_x', 'an isolated profile has its own');
  assert.strictEqual(mkWin({ codemini_windows: wins, codemini_active_window: 'win_p1', codemini_syncProfileSettings: 'true' })('x'), 'codemini_x', 'unless sync is on');
  assert.strictEqual(mkWin({})('x', 'win_p1', true), 'codemini_win_p1_x', 'explicit window, as reloadSettings passes during a switch');
  assert.strictEqual(mkWin({})('x', 'win_p1', false), 'codemini_x');
  assert.strictEqual(mkWin({ codemini_windows: 'not json' })('x'), 'codemini_x', 'a damaged window list falls back');
  assert.strictEqual(mkWin({ codemini_windows: wins, codemini_active_window: 'win_p1' })('syncProfileSettings'), 'codemini_syncProfileSettings');
});

console.log(`\n${n} keybindings checks passed`);
