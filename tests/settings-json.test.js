// Settings (JSON) (js/core/settings-json.js) and the shared JSON schema registrar (js/core/json-schemas.js): what goes in the
// file, the schema, the checks before anything is applied, and the wiring. Run against the real default settings. The tab itself
// (editing, squiggles, Ctrl+S applying, reload) is covered in a browser by tests/e2e/settings-json.e2e.js.
const assert = require('assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const J = require('../js/core/settings-json.js');
const { mergeSchema } = require('../js/core/json-schemas.js');
const { isSecurity, buildDocument, buildSchema, validateDocument, summarize } = J;
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok', name); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// The real default settings, taken out of settings-profile.js.
const sp = read('js/core/settings-profile.js');
const defSrc = sp.slice(sp.indexOf('window.getDefaultSettings = function() {'), sp.indexOf('window.getPrefixedKey') > sp.indexOf('window.getDefaultSettings = function() {') ? sp.indexOf('window.getPrefixedKey') : sp.indexOf('window.reloadSettings = function'));
const win = {}; vm.runInContext(defSrc, vm.createContext({ window: win }));
const DEFAULTS = win.getDefaultSettings();
const KEYS = Object.keys(DEFAULTS);
// The Settings screen's controls: every data-setting in the template and its kind.
const tpl = sp.slice(sp.indexOf('const settingsHTML = `'), sp.indexOf('\n  `;', sp.indexOf('const settingsHTML = `')));
const uiKeys = Array.from(new Set((tpl.match(/data-setting="([A-Za-z0-9_]+)"/g) || []).map((m) => m.slice(14, -1))));

console.log('the defaults this is built from');
t('there is one list of defaults: every value is a boolean, a number or text, and Reset uses it', () => {
  assert.ok(KEYS.length >= 80, 'about 89 settings: ' + KEYS.length);
  for (const k of KEYS) assert.ok(['boolean', 'number', 'string'].includes(typeof DEFAULTS[k]), k + ' is ' + typeof DEFAULTS[k]);
  assert.ok(/Object\.assign\(window\.appSettings, window\.getDefaultSettings\(\)\)/.test(sp), 'Reset reads the same list');
  assert.notStrictEqual(win.getDefaultSettings(), win.getDefaultSettings(), 'each call is a fresh object, so nobody can change the defaults');
});
t('every control on the Settings screen has a default, so it is in the file (themePack is handled separately)', () => {
  const missing = uiKeys.filter((k) => !(k in DEFAULTS));
  assert.deepStrictEqual(missing, ['themePack'], 'a new control without a default would be missing from settings.json: ' + missing.join(', '));
});

console.log('security settings are not in the file');
t('isolation, Workspace Trust and the sync switch are security settings', () => {
  for (const k of ['isolationMode', 'isolationPreview', 'isolationConsole', 'isolationTerminal', 'isolationNotebooks', 'workspaceTrustEnabled', 'workspaceTrustUntrustedFiles', 'workspaceTrustEmptyWindow', 'workspaceTrustStartupPrompt', 'workspaceTrustBanner', 'syncProfileSettings']) {
    assert.strictEqual(isSecurity(k), true, k); assert.ok(k in DEFAULTS, k + ' is a real setting (so this list is not stale)');
  }
  for (const k of ['fontSize', 'autoSave', 'hotExit', 'theme', 'wordWrap']) assert.strictEqual(isSecurity(k), false, k);
});
t('every setting whose name starts like a security one is excluded, whichever is added later', () => {
  const doc = buildDocument(DEFAULTS, {});
  for (const k of KEYS) assert.strictEqual(k in doc, !isSecurity(k), k);
  assert.ok(KEYS.filter((k) => /^(isolation|workspaceTrust)/.test(k)).every((k) => !(k in doc)));
});

console.log('the document');
t('it lists the settings in the order of the defaults, with the current value where it has the right type', () => {
  const doc = buildDocument(DEFAULTS, { fontSize: 19, hotExit: 'Off', tabSize: 'wide', wordWrap: 'maybe', notASetting: 5 });
  assert.deepStrictEqual(Object.keys(doc), KEYS.filter((k) => !isSecurity(k)));
  assert.strictEqual(doc.fontSize, 19); assert.strictEqual(doc.hotExit, 'Off');
  assert.strictEqual(doc.tabSize, DEFAULTS.tabSize, 'a value of the wrong type falls back to the default');
  assert.ok(!('notASetting' in doc));
  assert.deepStrictEqual(buildDocument(DEFAULTS, null), buildDocument(DEFAULTS, {}), 'no current settings: the defaults');
});
t('it round-trips as JSON', () => {
  const doc = buildDocument(DEFAULTS, { fontSize: 15 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(doc, null, 2)), doc);
});

console.log('the schema');
const DESC = [
  { key: 'autoSave', kind: 'select', options: ['After Delay', 'On Tab Change', 'On Focus Change', 'Off'], title: 'Auto Save', description: 'When to save' },
  { key: 'fontSize', kind: 'number', min: 8, max: 40, title: 'Font Size' },
  { key: 'tabSize', kind: 'select', options: ['2', '4', '8'] },
  { key: 'wordWrap', kind: 'checkbox' },
  { key: 'isolationMode', kind: 'select', options: ['A', 'B'] }
];
const D = { autoSave: 'After Delay', fontSize: 14, tabSize: 4, wordWrap: false, isolationMode: 'A', quiet: 'x' };
t('each setting has the type of its default, its allowed options and its range', () => {
  const sc = buildSchema(D, DESC), p = sc.properties;
  assert.strictEqual(sc.additionalProperties, false); assert.strictEqual(sc.type, 'object');
  assert.deepStrictEqual(p.autoSave, { type: 'string', default: 'After Delay', enum: ['After Delay', 'On Tab Change', 'On Focus Change', 'Off'], description: 'Auto Save. When to save' });
  assert.deepStrictEqual([p.fontSize.type, p.fontSize.minimum, p.fontSize.maximum], ['number', 8, 40]);
  assert.deepStrictEqual(p.tabSize.enum, [2, 4, 8], 'options of a number setting are numbers');
  assert.deepStrictEqual([p.wordWrap.type, 'enum' in p.wordWrap], ['boolean', false]);
  assert.strictEqual(p.quiet.type, 'string', 'a setting with no control still gets its type'); assert.ok(!('description' in p.quiet));
});
t('security settings are not properties, so the editor flags them as unknown', () => {
  assert.ok(!('isolationMode' in buildSchema(D, DESC).properties));
  const real = buildSchema(DEFAULTS, []);
  assert.ok(KEYS.filter(isSecurity).every((k) => !(k in real.properties)) && KEYS.filter((k) => !isSecurity(k)).every((k) => k in real.properties));
});
t('a missing or odd descriptor list does not break it', () => {
  assert.doesNotThrow(() => buildSchema(D, null)); assert.doesNotThrow(() => buildSchema(null, null)); assert.deepStrictEqual(buildSchema({}, []).properties, {});
  assert.deepStrictEqual(buildSchema({ n: 1 }, [{ key: 'n', kind: 'select', options: ['x', 'y'] }]).properties.n.enum, undefined, 'no usable number options: no enum');
});

console.log('checking before anything is applied');
const SC = buildSchema(D, DESC), BASE = { autoSave: 'After Delay', fontSize: 14, tabSize: 4, wordWrap: false, quiet: 'x' };
const check = (obj, base) => validateDocument(typeof obj === 'string' ? obj : JSON.stringify(obj), SC, base === undefined ? BASE : base);
t('only what you changed is returned, compared with what the file showed when it opened', () => {
  const r = check({ autoSave: 'Off', fontSize: 14, tabSize: 4, wordWrap: false, quiet: 'x' });
  assert.strictEqual(r.ok, true); assert.deepStrictEqual(r.changes, { autoSave: 'Off' });
  assert.deepStrictEqual(check(BASE).changes, {}, 'nothing edited: nothing to apply');
});
t('a setting you removed from the file is left as it is', () => {
  const r = check({ fontSize: 16 });
  assert.strictEqual(r.ok, true); assert.deepStrictEqual(r.changes, { fontSize: 16 });
});
t('with no baseline, everything in the file counts as a change', () => {
  assert.deepStrictEqual(check({ fontSize: 14 }, null).changes, { fontSize: 14 });
});
t('JSON that does not parse, or is not an object, is refused with the reason', () => {
  const bad = check('{ "fontSize": ');
  assert.strictEqual(bad.ok, false); assert.ok(bad.error.length > 3); assert.ok(!('changes' in bad));
  for (const t2 of ['[1]', '"x"', '5', 'null']) assert.strictEqual(check(t2).ok, false, t2);
});
t('a wrong type, a value that is not an option, and a number out of range are each a problem with a reason', () => {
  const r = check({ fontSize: '16', wordWrap: 'yes', autoSave: 'Sometimes', tabSize: 3 });
  assert.strictEqual(r.ok, false);
  const msg = Object.fromEntries(r.problems.map((p) => [p.key, p.message]));
  assert.match(msg.fontSize, /must be a number/); assert.match(msg.wordWrap, /true or false/);
  assert.match(msg.autoSave, /must be one of "After Delay", "On Tab Change"/); assert.match(msg.tabSize, /must be one of 2, 4, 8/);
  assert.match(check({ fontSize: 7 }).problems[0].message, /between 8 and 40/); assert.match(check({ fontSize: 41 }).problems[0].message, /between 8 and 40/);
  assert.strictEqual(check({ fontSize: 8 }).ok, true); assert.strictEqual(check({ fontSize: 40 }).ok, true, 'the limits are allowed');
  assert.strictEqual(check({ quiet: 5 }).ok, false); assert.strictEqual(check({ quiet: null }).ok, false); assert.strictEqual(check({ fontSize: null }).ok, false);
  assert.match(check({ fontSize: 8 }, null).ok ? 'ok' : 'x', /ok/);
});
t('a name that is not a setting is a problem, and a security setting says where to change it', () => {
  const r = check({ colour: 'red', isolationMode: 'B' });
  assert.deepStrictEqual(r.problems.map((p) => p.key), ['colour', 'isolationMode']);
  assert.match(r.problems[0].message, /not a CodeMini setting/); assert.match(r.problems[1].message, /Settings > Security/);
  assert.strictEqual(r.ok, false);
});
t('one problem means nothing is applied: ok is false and the good changes are not offered as a plan', () => {
  const r = check({ autoSave: 'Off', fontSize: 'big' });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.problems.length, 1);
  assert.strictEqual(summarize(r).kind, 'error'); assert.match(summarize(r).text, /Not applied: 1 problem/);
});
t('the message after saving says how many were applied, or that nothing changed, or what is wrong', () => {
  assert.deepStrictEqual(summarize(check({ fontSize: 16 })), { kind: 'ok', text: 'Applied 1 setting.', problems: [] });
  assert.strictEqual(summarize(check({ fontSize: 16, autoSave: 'Off' })).text, 'Applied 2 settings.');
  assert.strictEqual(summarize(check(BASE)).text, 'Nothing changed.');
  const e = summarize(check('{ nope')); assert.strictEqual(e.kind, 'error'); assert.match(e.text, /^Not applied: /);
  const many = {}; for (let i = 0; i < 7; i++) many['bad' + i] = 1;
  const s = summarize(check(many)); assert.match(s.text, /7 problems/); assert.strictEqual(s.problems.length, 4, 'the first four are listed');
});
t('real defaults: the whole document, as it opens, is valid and changes nothing', () => {
  const doc = buildDocument(DEFAULTS, {});
  const schema = buildSchema(DEFAULTS, KEYS.map((k) => ({ key: k, kind: 'text' })));
  const r = validateDocument(JSON.stringify(doc), schema, doc);
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems)); assert.deepStrictEqual(r.changes, {});
  const edited = Object.assign({}, doc, { fontSize: doc.fontSize + 1 });
  assert.deepStrictEqual(validateDocument(JSON.stringify(edited), schema, doc).changes, { fontSize: doc.fontSize + 1 });
});

console.log('the shared schema registrar');
t('registrations for one schema are joined, others kept, and nothing is lost when a second feature registers', () => {
  let list = mergeSchema([], 'a', ['m1'], { type: 'object' });
  list = mergeSchema(list, 'b', ['m2'], { type: 'array' });
  list = mergeSchema(list, 'a', ['m3', 'm1'], { type: 'object' });
  assert.deepStrictEqual(list.map((s) => [s.uri, s.fileMatch]), [['a', ['m1', 'm3']], ['b', ['m2']]]);
  assert.deepStrictEqual(list[1].schema, { type: 'array' });
  const before = list; mergeSchema(list, 'c', ['x'], {}); assert.strictEqual(list, before); assert.strictEqual(list.length, 2, 'the input list is not changed');
  assert.deepStrictEqual(mergeSchema([{ uri: 'a', fileMatch: ['m'], schema: { type: 'object' } }], 'a', ['n']).slice(0, 1)[0].schema, { type: 'object' }, 'a later add without a schema keeps the schema');
});

console.log('wiring (source checks)');
t('Settings has the { } button in its header, and Reset, the schema and the tab all read the one defaults list', () => {
  assert.ok(/id="openSettingsJson"[^>]*title="Open Settings \(JSON\)"[^>]*aria-label="Open Settings \(JSON\)"/.test(sp));
  assert.ok(sp.indexOf('id="openSettingsJson"') < sp.indexOf('id="set-general"') || sp.indexOf('id="openSettingsJson"') < sp.indexOf('settings-sidebar'), 'it is in the header');
  assert.ok(/window\.CodeMiniSettingsJson\.open\(\)/.test(sp) && /window\.getSettingsDescriptors = function/.test(sp));
  assert.ok(/new DOMParser\(\)\.parseFromString\(settingsHTML/.test(sp), 'descriptors are read from the screen\u2019s own template');
  const sj = read('js/core/settings-json.js');
  assert.ok(/W\.getDefaultSettings\(\)/.test(sj) && /W\.getSettingsDescriptors/.test(sj) && /W\.saveSetting\(k/.test(sj), 'every change goes through saveSetting, so it takes effect the way a Settings change does');
});
t('saving the tab applies the settings, and the tab has no file for autosave to write', () => {
  const script = read('js/core/script.js');
  const fn = script.slice(script.indexOf('window.performActiveSave = function'));
  assert.ok(fn.indexOf('CodeMiniSettingsJson.isVirtual(activeTab)') > 0 && fn.indexOf('CodeMiniSettingsJson.isVirtual(activeTab)') < fn.indexOf("activeTab.dataset.type === 'monaco'"), 'before the file branch');
  assert.ok(/W\.createNewTab\('settings\.json', 'ri-braces-line', false, [^;]*'monaco', null\)/.test(read('js/core/settings-json.js')), 'no file id: autoSaveFile returns at once');
  assert.ok(/if \(!fileId \|\| fileId === 'workspace'\) return|if \(!fileId/.test(read('js/core/editor.js').slice(read('js/core/editor.js').indexOf('window.autoSaveFile = '))), 'autoSaveFile ignores a tab with no file id');
});
t('it comes back after a reload, as a fresh copy of the current settings', () => {
  assert.ok(/virtual: t\.dataset\.virtual/.test(read('js/core/editor.js')));
  const sj = read('js/core/settings-json.js');
  const marked = sj.indexOf('tab.dataset.virtual = KIND;'), resaved = sj.indexOf('W.updateOpenedTabsRegistry()');
  assert.ok(marked > 0 && resaved > marked, 'the session is saved again AFTER the tab is marked: it was first saved when the tab was made, without the mark, so a reload would not have brought it back');
  assert.ok(/t\.virtual === 'settings-json'[\s\S]{0,120}CodeMiniSettingsJson\.open\(\)/.test(read('js/core/app.js')));
});
t('Quick Open has the three ways in', () => {
  const qo = read('js/core/quick-open.js');
  assert.ok(/name: 'Open Keyboard Shortcuts'[^\n]*openSettingsTab\('keybinds'\)/.test(qo));
  assert.ok(/name: 'Open Settings \(JSON\)'[^\n]*CodeMiniSettingsJson\.open\(\)/.test(qo));
});

console.log(`\n${n} settings-json checks passed`);
