// Settings (JSON) (js/core/settings-json.js) in the real app with a real Monaco: the { } button, the virtual settings.json tab,
// the schema checks, applying on save (and only then, and only when everything is valid), what it leaves out, and coming back
// after a reload. Needs a real Monaco (MONACO_DIR, see tests/e2e/lib/monaco-local.js); without one it reports SKIP.
const { chromium } = require('playwright');
const monacoLocal = require('./lib/monaco-local');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0, skipped = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const URL = 'http://localhost:8765/index.html';

(async () => {
  if (!monacoLocal.available()) { skipped++; console.log('  SKIP everything (needs MONACO_DIR)'); console.log('\n0 passed, 0 failed, 1 skipped'); process.exit(0); }
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await monacoLocal.install(page);
  const ev = (f, a) => page.evaluate(f, a);
  const boot = async () => { await page.goto(URL); await sleep(6500); };
  await boot();

  const text = () => ev(() => window.CodeMiniSettingsJson.existing()._sjModel.getValue());
  const setText = (t) => ev((t) => { window.CodeMiniSettingsJson.existing()._sjModel.setValue(t); }, t);
  const edit = async (fn) => { const o = JSON.parse(await text()); fn(o); await setText(JSON.stringify(o, null, 2)); };
  const setting = (k) => ev((k) => window.appSettings[k], k);
  const storedSetting = (k) => ev((k) => localStorage.getItem(window.getPrefixedKey(k)), k);
  const banner = () => ev(() => { const t = window.CodeMiniSettingsJson.existing(); const b = t._sjBanner; return { state: b.state.textContent, cls: b.state.className, problems: [...b.problems.querySelectorAll('.sj-problem')].map(p => p.textContent), shown: !b.problems.hidden }; });
  const unsaved = () => ev(() => window.CodeMiniSettingsJson.existing().classList.contains('unsaved-blink'));
  const markers = () => ev(() => { const m = window.CodeMiniSettingsJson.existing()._sjModel; return monaco.editor.getModelMarkers({ resource: m.uri }).map(x => x.message); });
  const save = async () => { await page.keyboard.press('Control+s'); await sleep(500); };
  const tabCount = () => ev(() => [...document.querySelectorAll('.tab')].filter(t => t.dataset.virtual === 'settings-json').length);
  const openJson = async () => { await ev(() => window.CodeMiniSettingsJson.open()); await sleep(2000); };
  const closeJson = async () => { await ev(() => window.CodeMiniSettingsJson.existing().querySelector('.tab-close').click()); await sleep(500); };
  // A setting whose control has a range (Font Size has none): the Local History "versions per file" is 1 to 500.
  const desc = await ev(() => window.getSettingsDescriptors().find(d => d.key === 'historyMaxEntries'));

  console.log('\n[the { } button and the tab]');
  await ev(() => document.getElementById('settingsIconItem').click()); await sleep(1300);
  const btn = await ev(() => { const b = document.getElementById('openSettingsJson'); const h = b.closest('.settings-fixed-header').getBoundingClientRect(), r = b.getBoundingClientRect(); return { title: b.title, aria: b.getAttribute('aria-label'), icon: b.querySelector('i').className, gapToRight: Math.round(h.right - r.right), inHeader: true }; });
  ok(btn.title === 'Open Settings (JSON)' && btn.aria === 'Open Settings (JSON)' && btn.icon === 'ri-braces-line', 'Settings has a { } button labelled Open Settings (JSON)', btn);
  ok(btn.gapToRight < 40, 'at the top right of the Settings header', btn.gapToRight);
  await page.click('#openSettingsJson'); await sleep(2500);
  ok(await tabCount() === 1 && await ev(() => window.CodeMiniSettingsJson.existing().querySelector('span').textContent) === 'settings.json', 'it opens a settings.json tab');
  ok(await ev(() => !!window.CodeMiniSettingsJson.existing()._sjEditor) && await ev(() => window.CodeMiniSettingsJson.existing()._sjModel.uri.toString()) === 'inmemory://codemini/settings.json', 'with a Monaco editor on an in-memory settings.json (no file in your workspace)');
  ok(/Changes apply on save/.test(await ev(() => window.CodeMiniSettingsJson.existing()._sjBanner.root.textContent)), 'and a banner saying changes apply on save');
  await ev(() => document.querySelector('.tab[data-type="settings"]').click()); await sleep(400);
  await page.click('#openSettingsJson'); await sleep(800);
  ok(await tabCount() === 1 && await ev(() => window.CodeMiniSettingsJson.existing().classList.contains('active')), 'clicking it again goes to the same tab instead of making another');
  ok(await ev(() => !window.CodeMiniSettingsJson.existing().dataset.fileId), 'it has no file id, so autosave and history have nothing to write');

  console.log('\n[what is in the file]');
  const doc = JSON.parse(await text());
  const defaults = await ev(() => window.getDefaultSettings());
  const nonSecurity = Object.keys(defaults).filter(k => !/^(isolation|workspaceTrust)/.test(k) && k !== 'syncProfileSettings');
  ok(Object.keys(doc).join() === nonSecurity.join(), 'every default setting except the security ones, in the order of the defaults', [Object.keys(doc).length, nonSecurity.length]);
  ok(['isolationMode', 'isolationPreview', 'workspaceTrustEnabled', 'workspaceTrustBanner', 'syncProfileSettings'].every(k => !(k in doc)), 'security settings are not in it');
  ok(doc.fontSize === await setting('fontSize') && doc.autoSave === await setting('autoSave') && doc.hotExit === await setting('hotExit'), 'the values are the current ones', [doc.fontSize, doc.autoSave]);
  ok(Object.keys(doc).every(k => typeof doc[k] === typeof defaults[k]), 'each value has the type of its default');

  console.log('\n[checks while you type]');
  await edit(o => { o.fontSize = 'big'; }); await sleep(2500);
  ok((await markers()).some(m => /Expected "number"|number/i.test(m)), 'a wrong type is underlined', await markers());
  await edit(o => { o.historyMaxEntries = desc.max + 1; }); await sleep(2500);
  ok(desc.min === 1 && desc.max === 500 && (await markers()).some(m => /maximum/i.test(m)), 'a number above the Settings screen\u2019s maximum is underlined', [desc, await markers()]);
  await edit(o => { o.autoSave = 'Sometimes'; }); await sleep(2500);
  ok((await markers()).some(m => /Value is not accepted|enum|Valid values/i.test(m)), 'a value that is not one of the options is underlined', await markers());
  await edit(o => { o.colour = 'red'; o.isolationMode = 'x'; }); await sleep(2500);
  ok((await markers()).filter(m => /not allowed/i.test(m)).length >= 2, 'a name that is not a setting, and a security setting, are underlined as not allowed', await markers());
  await closeJson(); await openJson();

  console.log('\n[applying on save]');
  const before = { fontSize: await setting('fontSize'), autoSave: await setting('autoSave'), hotExit: await setting('hotExit'), tabSize: await setting('tabSize'), isolationMode: await setting('isolationMode') };
  await edit(o => { o.fontSize = 17; o.autoSave = 'Off'; }); await sleep(400);
  ok(await unsaved() && await setting('fontSize') === before.fontSize, 'editing changes nothing yet, and the tab shows unsaved');
  await ev(() => { window.appSettings.autoSave = 'After Delay'; window.appSettings.autoSaveDelay = 300; }); await sleep(1500);
  ok(await unsaved() && await setting('fontSize') === before.fontSize, 'autosave never applies it, however long you wait');
  await ev(() => { window.appSettings.autoSave = 'Off'; });
  await save();
  ok(await setting('fontSize') === 17 && await setting('autoSave') === 'Off', 'Ctrl+S applies the two changes', [await setting('fontSize'), await setting('autoSave')]);
  ok(await storedSetting('fontSize') === '17' && await storedSetting('autoSave') === 'Off', 'and saves them the way the Settings screen does');
  ok(/^Applied 2 settings\. /.test((await banner()).state) && (await banner()).cls.includes('sj-ok') && !(await unsaved()), 'the banner says Applied 2 settings, and the tab is no longer unsaved', await banner());
  await save();
  ok((await banner()).state.startsWith('Nothing changed.'), 'saving again with nothing new says so');
  await ev(() => document.querySelector('.tab[data-type="settings"]').click()); await sleep(500);
  ok(await ev(() => document.querySelector('[data-setting="fontSize"]').value) === '17', 'the Settings screen shows the new value', await ev(() => document.querySelector('[data-setting="fontSize"]').value));

  console.log('\n[nothing is applied while anything is wrong]');
  await ev(() => document.querySelector('.tab[data-virtual="settings-json"]').click()); await sleep(400);
  await edit(o => { o.autoSave = 'On Tab Change'; o.fontSize = 'huge'; }); await sleep(300);
  await save();
  ok(await setting('autoSave') === 'Off' && await setting('fontSize') === 17, 'a valid change next to a wrong one is not applied either', [await setting('autoSave'), await setting('fontSize')]);
  let b = await banner();
  ok(/^Not applied: 1 problem/.test(b.state) && b.cls.includes('sj-error') && b.problems.length === 1 && /\u201cfontSize\u201d must be a number/.test(b.problems[0]) && b.shown, 'the banner says what is wrong', b);
  ok(await unsaved(), 'and the tab stays unsaved');
  await edit(o => { o.autoSave = 'Off'; o.fontSize = 17; o.colour = 'red'; o.isolationMode = 'x'; }); await save();
  b = await banner();
  ok(b.problems.some(p => /\u201ccolour\u201d is not a CodeMini setting/.test(p)) && b.problems.some(p => /\u201cisolationMode\u201d is a security setting: change it in Settings > Security/.test(p)), 'an unknown name and a security setting are explained', b.problems);
  ok(await setting('isolationMode') === before.isolationMode && before.isolationMode !== 'x', 'and the security setting is not changed', [before.isolationMode, await setting('isolationMode')]);
  await setText('{ "fontSize": '); await save();
  ok(/^Not applied: /.test((await banner()).state) && (await banner()).cls.includes('sj-error'), 'JSON that does not parse is refused with the reason', (await banner()).state);
  await closeJson(); await openJson(); // the editor held broken JSON on purpose: start the next check from a fresh copy
  await edit(o => { o.historyMaxEntries = desc.max + 5; }); await save();
  ok(/between 1 and 500/.test((await banner()).problems.join()) && await setting('historyMaxEntries') !== desc.max + 5, 'a number out of range is refused with the range', (await banner()).problems);

  console.log('\n[only what you changed is applied]');
  await closeJson(); await openJson();
  await ev(() => window.saveSetting('hotExit', 'Off')); // changed in the Settings screen after the file was opened
  await edit(o => { o.fontSize = 18; }); await save();
  ok(await setting('fontSize') === 18 && await setting('hotExit') === 'Off', 'a setting you changed elsewhere meanwhile is not undone by the file still showing the old value', [await setting('fontSize'), await setting('hotExit')]);
  await edit(o => { delete o.tabSize; }); await save();
  ok(await setting('tabSize') === before.tabSize && /Nothing changed|Applied 0/.test((await banner()).state), 'a setting you delete from the file is left as it is', [await setting('tabSize'), (await banner()).state]);

  console.log('\n[ways in, reload, closing]');
  await closeJson();
  await page.keyboard.press('Control+p'); await sleep(300); await page.keyboard.type('>open settings (j'); await sleep(400);
  ok(await ev(() => [...document.querySelectorAll('#topSearchIsland .qo-label')].map(l => l.textContent).includes('Open Settings (JSON)')), 'the command palette has Open Settings (JSON)');
  await page.keyboard.press('Enter'); await sleep(2500);
  ok(await tabCount() === 1, 'and it opens the tab');
  await boot();
  await sleep(1500);
  ok(await tabCount() === 1 && JSON.parse(await text()).fontSize === 18, 'after a reload the tab is back, showing the settings as they are now (a fresh copy, not what was typed)', await tabCount());
  await closeJson();
  ok(await ev(() => monaco.editor.getModels().filter(m => m.uri.toString().endsWith('/settings.json')).length) === 0, 'closing it frees its model');
  await openJson();
  ok(await tabCount() === 1 && JSON.parse(await text()).fontSize === 18, 'and it opens again without trouble');
  await closeJson();
  await page.keyboard.press('Control+p'); await sleep(300); await page.keyboard.type('>keyboard shortcuts'); await sleep(400);
  await page.keyboard.press('Enter'); await sleep(2500);
  ok(await ev(() => document.querySelector('#set-keybinds').offsetParent !== null && document.querySelectorAll('#kbRows .kb-row').length === 12), 'Open Keyboard Shortcuts opens Settings on the shortcuts');

  // tidy up what this test changed
  await ev((d) => { ['fontSize', 'autoSave', 'hotExit', 'autoSaveDelay'].forEach(k => window.saveSetting(k, d[k])); }, defaults);
  ok(errors.length === 0, 'no uncaught errors in the page', errors.slice(0, 3));
  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
