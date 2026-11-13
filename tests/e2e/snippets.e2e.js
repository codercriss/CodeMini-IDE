// Snippets (js/core/snippets.js) in the real app with a real Monaco: the Settings > Snippets tab and its New Snippet form,
// the schema checks in the file, what is kept across a reload, and autocomplete offering a snippet in a file of its language.
// Needs a real Monaco (MONACO_DIR, see tests/e2e/lib/monaco-local.js); without one it reports SKIP.
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

  const modelText = (lang) => ev((lang) => { const m = monaco.editor.getModels().find(x => x.uri.toString().endsWith('/snippets/' + lang + '.json')); return m ? m.getValue() : null; }, lang);
  const setModel = (lang, text) => ev(([lang, text]) => { const m = monaco.editor.getModels().find(x => x.uri.toString().endsWith('/snippets/' + lang + '.json')); m.setValue(text); }, [lang, text]);
  const stored = () => ev(() => { const v = localStorage.getItem(window.getPrefixedKey('snippets')); return v ? JSON.parse(v) : null; });
  const status = () => ev(() => ({ text: document.getElementById('snStatus').textContent, cls: document.getElementById('snStatus').className }));
  const formError = () => ev(() => { const e = document.getElementById('snFormError'); return e.hidden ? '' : e.textContent; });
  const openTab = async () => {
    await ev(() => document.getElementById('settingsIconItem').click()); await sleep(1300);
    await ev(() => document.querySelector('.settings-sidebar-item[data-tab="snippets"]').click()); await sleep(1500);
  };
  const pick = async (lang) => { await ev((l) => { const s = document.getElementById('snLang'); s.value = l; s.dispatchEvent(new Event('change')); }, lang); await sleep(400); };
  const fill = async (name, prefix, body, desc) => { await page.fill('#snName', name); await page.fill('#snPrefix', prefix); await page.fill('#snBody', body); await page.fill('#snDesc', desc || ''); };
  const markers = (lang) => ev((lang) => { const m = monaco.editor.getModels().find(x => x.uri.toString().endsWith('/snippets/' + lang + '.json')); return monaco.editor.getModelMarkers({ resource: m.uri }).map(x => x.message); }, lang);

  console.log('\n[the Snippets tab]');
  await ev(() => document.getElementById('settingsIconItem').click()); await sleep(1300);
  const order = await ev(() => [...document.querySelectorAll('.settings-sidebar-item')].map(i => i.textContent.trim()));
  ok(order.indexOf('Snippets') === order.indexOf('Editor') + 1, 'Snippets sits right after Editor in the Settings list', order);
  ok(await ev(() => !!document.querySelector('.settings-tab[data-tab="snippets"]')), 'and in the phone tab bar too');
  await ev(() => document.querySelector('.settings-sidebar-item[data-tab="snippets"]').click()); await sleep(1500);
  ok(await ev(() => document.querySelector('#set-snippets').offsetParent !== null && !!document.querySelector('#snEditor .monaco-editor')), 'it opens with the file in a Monaco editor');
  const langs = await ev(() => [...document.querySelectorAll('#snLang option')].map(o => o.textContent));
  ok(langs.length > 40 && langs.includes('JavaScript') && langs.includes('Python'), 'a picker lists every language the editor knows', langs.length);
  ok(await ev(() => document.getElementById('snLang').value) === 'javascript', 'on JavaScript when no file is open');
  ok((await status()).text === 'No snippets yet.' && await modelText('javascript') === '{}', 'with nothing yet');
  ok(await ev(() => document.querySelector('#set-snippets .settings-item') !== null && document.querySelectorAll('#set-snippets .settings-item').length >= 6), 'the form rows are the Settings screen\u2019s own rows');

  console.log('\n[the New Snippet form]');
  await page.click('#snAdd'); await sleep(200);
  ok(/name/i.test(await formError()), 'an empty form says what is missing', await formError());
  await fill('Log to console', 'log', 'console.log($1);', 'Print a value');
  await page.click('#snAdd'); await sleep(900);
  const t1 = JSON.parse(await modelText('javascript'));
  ok(t1['Log to console'] && t1['Log to console'].prefix === 'log' && t1['Log to console'].body === 'console.log($1);' && t1['Log to console'].description === 'Print a value', 'Add Snippet writes it into the file', t1);
  ok((await status()).text === '1 snippet ready in autocomplete.' && (await status()).cls.includes('sn-ok'), 'and says it is ready', await status());
  ok(await ev(() => ['snName', 'snPrefix', 'snDesc', 'snBody'].every(id => document.getElementById(id).value === '')) && (await formError()) === '', 'the form is cleared and the error gone');
  ok(JSON.parse((await stored()).javascript)['Log to console'].prefix === 'log', 'it is saved under this window\u2019s own key', await stored());
  ok(await ev(() => [...document.querySelectorAll('#snLang option')].find(o => o.value === 'javascript').textContent) === 'JavaScript (1)', 'the picker shows the count as soon as there is one');
  await fill('Log to console', 'l2', 'x');
  await page.click('#snAdd'); await sleep(200);
  ok(/already exists/.test(await formError()), 'a name already used is refused', await formError());
  await fill('Loop', 'for-each, fe', 'for (const $1 of $2) {\n  $0\n}', '');
  await page.click('#snAdd'); await sleep(900);
  const t2 = JSON.parse(await modelText('javascript'));
  ok(Array.isArray(t2.Loop.prefix) && t2.Loop.prefix.join() === 'for-each,fe' && Array.isArray(t2.Loop.body) && t2.Loop.body.length === 3, 'several prefixes and a multi-line body become lists', t2.Loop);
  ok(Object.keys(t2).join() === 'Log to console,Loop', 'earlier snippets are untouched');
  await ev(() => { const ed = monaco.editor.getEditors().find(e => e.getContainerDomNode().closest('#snEditor')); ed.focus(); ed.trigger('t', 'undo', null); }); await sleep(900);
  ok(Object.keys(JSON.parse(await modelText('javascript'))).join() === 'Log to console', 'one undo takes an added snippet back out');
  await ev(() => { const ed = monaco.editor.getEditors().find(e => e.getContainerDomNode().closest('#snEditor')); ed.trigger('t', 'redo', null); }); await sleep(900);

  console.log('\n[checks in the file]');
  await setModel('javascript', '{ "Bad": { "body": "x" } }'); await sleep(2500);
  ok((await markers('javascript')).some(m => /prefix/i.test(m)), 'a snippet with no prefix is underlined, naming what is missing', await markers('javascript'));
  ok((await status()).cls.includes('sn-warn') && /Skipped: \u201cBad\u201d needs a prefix/.test((await status()).text), 'and the status says it is skipped');
  await setModel('javascript', JSON.stringify({ Good: { prefix: 'g', body: 'ok' } }, null, 2)); await sleep(900);
  const good = (await stored()).javascript;
  await setModel('javascript', '{ "Good": '); await sleep(1000);
  ok((await status()).cls.includes('sn-error') && /^Not saved: /.test((await status()).text), 'text that is not JSON says it was not saved', await status());
  ok((await stored()).javascript === good && await ev(() => window.CodeMiniSnippets.entries('javascript').length) === 1, 'and the last good version stays in use');
  await setModel('javascript', JSON.stringify({ Log: { prefix: 'log', body: 'console.log($1);', description: 'Print a value' }, Loop: { prefix: ['for-each'], body: 'items.forEach($1)' } }, null, 2)); await sleep(900);

  console.log('\n[each language has its own]');
  await pick('python'); ok(await modelText('python') === '{}' && (await status()).text === 'No snippets yet.', 'Python starts empty');
  await fill('Main guard', 'main', 'if __name__ == "__main__":\n    $0', ''); await page.click('#snAdd'); await sleep(900);
  ok(Object.keys(JSON.parse(await modelText('python'))).join() === 'Main guard' && Object.keys(JSON.parse((await stored()).python)).join() === 'Main guard', 'a snippet added there is Python\u2019s');
  await pick('javascript'); ok(Object.keys(JSON.parse(await modelText('javascript'))).join() === 'Log,Loop', 'switching back shows JavaScript\u2019s own');
  ok(await ev(() => ['javascript', 'python'].map(l => [...document.querySelectorAll('#snLang option')].find(o => o.value === l).textContent).join()) === 'JavaScript (2),Python (1)', 'both are counted');

  console.log('\n[autocomplete in a file]');
  await ev(() => document.querySelector('.tab[data-type="settings"] .tab-close').click()); await sleep(500);
  ok(await ev(() => monaco.editor.getModels().filter(m => m.uri.toString().includes('/snippets/')).length) === 0, 'closing Settings frees the editor and its models');
  await ev(async () => {
    await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').clear(); tx.oncomplete = res; });
    await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); [{ id: 'fj', name: 'a.js' }, { id: 'fp', name: 'b.py' }].forEach(f => tx.objectStore('filesystem').put({ id: f.id, parentId: 'root', name: f.name, type: 'file', content: '', timestamp: 1 })); tx.oncomplete = res; });
    folderStack = [folderStack[0]]; loadFilesFromDB();
  }); await sleep(500);
  const open = async (id, name) => { await ev(([id, name]) => handleFileClick({ id, parentId: 'root', name, type: 'file', content: '', timestamp: 1 }, document.createElement('div')), [id, name]); await sleep(1800); };
  const suggest = async (typed) => {
    await ev(() => { const ed = getActiveMonacoEditor(); ed.focus(); ed.trigger('t', 'hideSuggestWidget', {}); }); await sleep(250); // a finished session must not swallow the next one
    await ev((t) => { const ed = getActiveMonacoEditor(); ed.setValue(''); ed.trigger('t', 'type', { text: t }); }, typed); await sleep(300);
    await ev(() => getActiveMonacoEditor().trigger('t', 'editor.action.triggerSuggest', {})); await sleep(1300);
    // Each editor has its own suggest widget: read the one inside the editor being typed in, not the first in the page.
    return ev(() => { const w = getActiveMonacoEditor().getContainerDomNode().querySelector('.suggest-widget'); return { visible: !!w && w.classList.contains('visible'), rows: w ? [...w.querySelectorAll('.monaco-list-row')].map(r => r.textContent.trim()) : [], icon: !!(w && w.querySelector('.codicon-symbol-snippet')) }; });
  };
  await open('fj', 'a.js');
  let s = await suggest('lo');
  ok(s.visible && s.rows[0] === 'logPrint a value' && s.icon, 'typing a prefix offers the snippet first, with its description and the snippet icon', s);
  await page.keyboard.press('Tab'); await sleep(300);
  ok(await ev(() => getActiveMonacoEditor().getValue()) === 'console.log();', 'Tab expands it');
  ok(await ev(() => { const ed = getActiveMonacoEditor(); const p = ed.getPosition(); return p.column; }) === 13, 'with the cursor on its tab stop, inside the brackets');
  s = await suggest('for-e');
  ok(s.rows[0] && s.rows[0].startsWith('for-each'), 'a prefix with a dash is offered as you type it', s.rows.slice(0, 2));
  await page.keyboard.press('Tab'); await sleep(300);
  ok(await ev(() => getActiveMonacoEditor().getValue()) === 'items.forEach()', 'and replaces what was typed instead of adding to it');
  await open('fp', 'b.py');
  s = await suggest('mai');
  ok(s.visible && s.rows[0] && s.rows[0].startsWith('main') && s.icon, 'a Python file is offered its own snippet', s.rows.slice(0, 2));
  s = await suggest('lo');
  ok(!s.rows.some(r => /Print a value/.test(r)), 'and not JavaScript\u2019s (the widget works there, as the check above shows)', s.rows.slice(0, 3));

  console.log('\n[after a reload, and ways in]');
  await boot();
  ok(await ev(() => window.CodeMiniSnippets.entries('javascript').length) === 2 && await ev(() => window.CodeMiniSnippets.entries('python').length) === 1, 'the snippets are still there');
  await open('fp', 'b.py');
  await page.keyboard.press('Control+p'); await sleep(300); await page.keyboard.type('>configure snip'); await sleep(400);
  ok(await ev(() => [...document.querySelectorAll('#topSearchIsland .qo-label')].map(l => l.textContent).includes('Configure Snippets')), 'the command palette has Configure Snippets');
  await page.keyboard.press('Enter'); await sleep(2500);
  ok(await ev(() => document.querySelector('#set-snippets').offsetParent !== null) && await ev(() => document.getElementById('snLang').value) === 'python', 'it opens Settings on Snippets, on the language of the file you are in', await ev(() => document.getElementById('snLang').value));
  await ev(() => document.querySelector('.tab[data-type="settings"] .tab-close').click()); await sleep(400);
  await ev(() => document.getElementById('settingsIconItem').click()); await sleep(1300);
  await ev(() => document.querySelector('.settings-sidebar-item[data-tab="snippets"]').click()); await sleep(1500);
  ok(await ev(() => !!document.querySelector('#snEditor .monaco-editor')) && await ev(() => document.getElementById('snLang').value) === 'python', 'reopening Settings returns to the language you were on (Python)', await ev(() => document.getElementById('snLang').value));
  ok(Object.keys(JSON.parse(await modelText('python'))).join() === 'Main guard', 'with what was saved');
  ok(await ev(() => [...document.querySelectorAll('#snLang option')].slice(0, 2).map(o => o.textContent).join()) === 'JavaScript (2),Python (1)', 'and languages with snippets are listed first');
  await ev(() => document.querySelector('.tab[data-type="settings"] .tab-close').click()); await sleep(300);
  ok(await ev(() => localStorage.removeItem(window.getPrefixedKey('snippets')) === undefined), 'tidied up');

  ok(errors.length === 0, 'no uncaught errors in the page', errors.slice(0, 3));
  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
