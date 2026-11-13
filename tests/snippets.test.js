// Snippets (js/core/snippets.js): the file format and its checks, the New Snippet form, autocomplete items, prefix matching,
// the per-language store, and the wiring. The editor in Settings, autocomplete in a real Monaco, and saving across a reload
// are covered in a browser by tests/e2e/snippets.e2e.js.
const assert = require('assert');
const fs = require('fs'), path = require('path');
const S = require('../js/core/snippets.js');
const { SNIPPET_SCHEMA, parseSnippets, bodyText, addSnippetToText, completionItems, prefixTailStart, statusText, createStore } = S;
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok', name); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

console.log('the file format');
t('an empty file is no snippets, and text that is not JSON is an error with the reason', () => {
  assert.deepStrictEqual(parseSnippets(''), { ok: true, entries: [], skipped: [] });
  assert.deepStrictEqual(parseSnippets('   \n '), { ok: true, entries: [], skipped: [] });
  assert.deepStrictEqual(parseSnippets(null), { ok: true, entries: [], skipped: [] });
  const bad = parseSnippets('{ "a": ');
  assert.strictEqual(bad.ok, false); assert.ok(bad.error.length > 3);
  assert.strictEqual(parseSnippets('[1,2]').ok, false, 'a list is not a snippets file');
  assert.strictEqual(parseSnippets('"text"').ok, false);
  assert.strictEqual(parseSnippets('null').ok, false);
});
t('a snippet may have one prefix or several, and a body of one text or a list of lines', () => {
  const r = parseSnippets(JSON.stringify({
    One: { prefix: 'a', body: 'x' },
    Many: { prefix: ['b', ' c '], body: ['l1', 'l2'], description: 'desc' }
  }));
  assert.strictEqual(r.ok, true); assert.strictEqual(r.skipped.length, 0);
  assert.deepStrictEqual(r.entries[0], { name: 'One', prefixes: ['a'], body: 'x', description: '' });
  assert.deepStrictEqual(r.entries[1], { name: 'Many', prefixes: ['b', 'c'], body: ['l1', 'l2'], description: 'desc' }, 'prefixes are trimmed');
  assert.strictEqual(bodyText(['l1', 'l2']), 'l1\nl2'); assert.strictEqual(bodyText('x'), 'x'); assert.strictEqual(bodyText([]), '');
});
t('a snippet that cannot work is skipped and named, and the others still work', () => {
  const r = parseSnippets(JSON.stringify({
    Good: { prefix: 'g', body: 'ok' },
    NoPrefix: { body: 'x' },
    BlankPrefix: { prefix: '   ', body: 'x' },
    EmptyList: { prefix: [], body: 'x' },
    ListWithBlank: { prefix: ['a', ''], body: 'x' },
    NoBody: { prefix: 'p' },
    NumberBody: { prefix: 'p', body: 5 },
    MixedBody: { prefix: 'p', body: ['a', 2] },
    BadDesc: { prefix: 'p', body: 'x', description: 7 },
    NotObject: 'text'
  }));
  assert.deepStrictEqual(r.entries.map((e) => e.name), ['Good']);
  assert.deepStrictEqual(r.skipped.map((s) => s.name), ['NoPrefix', 'BlankPrefix', 'EmptyList', 'ListWithBlank', 'NoBody', 'NumberBody', 'MixedBody', 'BadDesc', 'NotObject']);
  r.skipped.forEach((s) => assert.ok(s.reason.length > 5, s.name + ' says why'));
});
t('an empty body is allowed (a snippet can insert nothing but its tab stops later)', () => {
  assert.strictEqual(parseSnippets(JSON.stringify({ E: { prefix: 'e', body: '' } })).entries.length, 1);
});
t('the schema asks for what the checks ask for', () => {
  const e = SNIPPET_SCHEMA.additionalProperties;
  assert.deepStrictEqual(e.required, ['prefix', 'body']); assert.strictEqual(e.additionalProperties, false);
  assert.deepStrictEqual(Object.keys(e.properties).sort(), ['body', 'description', 'prefix']);
  assert.strictEqual(SNIPPET_SCHEMA.type, 'object');
});

console.log('the New Snippet form');
t('a snippet is added with a one-line body as text and a multi-line body as a list', () => {
  let r = addSnippetToText('', { name: 'Log', prefix: 'log', body: 'console.log($1);', description: 'Print' });
  assert.strictEqual(r.ok, true); assert.deepStrictEqual(JSON.parse(r.text), { Log: { prefix: 'log', body: 'console.log($1);', description: 'Print' } });
  r = addSnippetToText('', { name: 'Fn', prefix: 'fn', body: 'function $1() {\r\n  $0\r\n}' });
  assert.deepStrictEqual(JSON.parse(r.text).Fn.body, ['function $1() {', '  $0', '}'], 'Windows line endings too');
  assert.ok(!('description' in JSON.parse(r.text).Fn), 'no empty description is written');
});
t('several prefixes can be given with commas or spaces', () => {
  assert.deepStrictEqual(JSON.parse(addSnippetToText('', { name: 'N', prefix: 'a, b  c', body: 'x' }).text).N.prefix, ['a', 'b', 'c']);
  assert.strictEqual(JSON.parse(addSnippetToText('', { name: 'N', prefix: ' a ', body: 'x' }).text).N.prefix, 'a');
});
t('it is added to what is there, leaving the rest alone, and it can be read back', () => {
  const start = JSON.stringify({ Old: { prefix: 'old', body: 'o' } });
  const r = addSnippetToText(start, { name: 'New', prefix: 'new', body: 'n' });
  const o = JSON.parse(r.text);
  assert.deepStrictEqual(Object.keys(o), ['Old', 'New']); assert.deepStrictEqual(o.Old, { prefix: 'old', body: 'o' });
  assert.strictEqual(parseSnippets(r.text).entries.length, 2);
  assert.strictEqual(addSnippetToText('  ', { name: 'N', prefix: 'n', body: 'b' }).ok, true, 'a blank editor is fine');
});
t('what is missing, a name already used, and a broken editor are explained and change nothing', () => {
  assert.match(addSnippetToText('', { name: '', prefix: 'p', body: 'b' }).error, /name/i);
  assert.match(addSnippetToText('', { name: 'N', prefix: '  ', body: 'b' }).error, /prefix/i);
  assert.match(addSnippetToText('', { name: 'N', prefix: 'p', body: ' \n ' }).error, /inserts/i);
  assert.match(addSnippetToText(JSON.stringify({ N: { prefix: 'p', body: 'b' } }), { name: 'N', prefix: 'q', body: 'b' }).error, /already exists/);
  assert.match(addSnippetToText('{ broken', { name: 'N', prefix: 'p', body: 'b' }).error, /Fix the JSON/);
  assert.match(addSnippetToText('[1]', { name: 'N', prefix: 'p', body: 'b' }).error, /snippets object/);
  assert.strictEqual(addSnippetToText('', null).ok, false);
});
t('a name like "constructor" or "__proto__" is a normal name, not a way to break the object', () => {
  const r = addSnippetToText('', { name: 'constructor', prefix: 'c', body: 'x' });
  assert.strictEqual(r.ok, true); assert.strictEqual(parseSnippets(r.text).entries[0].name, 'constructor');
  assert.strictEqual(addSnippetToText(r.text, { name: 'constructor', prefix: 'd', body: 'y' }).ok, false);
  assert.strictEqual(addSnippetToText('', { name: 'toString', prefix: 't', body: 'x' }).ok, true, 'inherited names are not "already used"');
  const p = addSnippetToText('', { name: '__proto__', prefix: 'p', body: 'x' });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(parseSnippets(p.text).entries.length, 1, 'it was really added: assigning obj["__proto__"] would have set a prototype and added nothing');
  assert.strictEqual(parseSnippets(p.text).entries[0].name, '__proto__');
  assert.strictEqual(addSnippetToText(p.text, { name: '__proto__', prefix: 'q', body: 'y' }).ok, false, 'and it counts as used');
  assert.strictEqual(addSnippetToText(p.text, { name: 'Other', prefix: 'o', body: 'z' }).ok && parseSnippets(addSnippetToText(p.text, { name: 'Other', prefix: 'o', body: 'z' }).text).entries.length === 2, true, 'and survives the next add');
});

console.log('autocomplete items and prefix matching');
t('there is one item per prefix, shown with its description (or its name) and its text', () => {
  const entries = parseSnippets(JSON.stringify({ A: { prefix: ['a1', 'a2'], body: ['x', 'y'], description: 'Desc' }, B: { prefix: 'b', body: 'z' } })).entries;
  const items = completionItems(entries);
  assert.deepStrictEqual(items.map((i) => i.label), ['a1', 'a2', 'b']);
  assert.strictEqual(items[0].insertText, 'x\ny'); assert.strictEqual(items[0].detail, 'Desc'); assert.strictEqual(items[2].detail, 'B', 'no description: its name');
  assert.deepStrictEqual(completionItems([]), []); assert.deepStrictEqual(completionItems(null), []);
});
t('typing part of a prefix with a dash or symbol replaces what was typed instead of adding to it', () => {
  assert.strictEqual(prefixTailStart('for-e', 'for-each'), 0);
  assert.strictEqual(prefixTailStart('x = for-e', 'for-each'), 4);
  assert.strictEqual(prefixTailStart('  log', 'log'), 2);
  assert.strictEqual(prefixTailStart('#!', '#!/bin/sh'), 0);
  assert.strictEqual(prefixTailStart('LO', 'log'), 0, 'case does not matter');
  assert.strictEqual(prefixTailStart('xyz', 'log'), -1); assert.strictEqual(prefixTailStart('', 'log'), -1); assert.strictEqual(prefixTailStart('log ', 'log'), -1, 'a space ends it');
});
t('the status line says how many work, what was skipped, or why nothing was saved', () => {
  assert.deepStrictEqual(statusText(parseSnippets('{}')), { kind: 'ok', text: 'No snippets yet.' });
  assert.strictEqual(statusText(parseSnippets('{"a":{"prefix":"a","body":"b"}}')).text, '1 snippet ready in autocomplete.');
  assert.strictEqual(statusText(parseSnippets('{"a":{"prefix":"a","body":"b"},"b":{"prefix":"b","body":""}}')).text, '2 snippets ready in autocomplete.');
  const w = statusText(parseSnippets('{"a":{"prefix":"a","body":"b"},"bad":{"body":"x"}}'));
  assert.strictEqual(w.kind, 'warn'); assert.match(w.text, /Skipped: \u201cbad\u201d needs a prefix/);
  const e = statusText(parseSnippets('{ nope'));
  assert.strictEqual(e.kind, 'error'); assert.match(e.text, /^Not saved: /);
  const many = {}; for (let i = 0; i < 6; i++) many['s' + i] = { body: 'x' };
  assert.match(statusText(parseSnippets(JSON.stringify(many))).text, /and 3 more/);
});

console.log('the store');
const memIO = (init) => { const io = { data: init || null, saves: 0 }; io.load = () => io.data; io.save = (o) => { io.saves++; io.data = JSON.parse(JSON.stringify(o)); }; return io; };
const GOOD = JSON.stringify({ Log: { prefix: 'log', body: 'console.log($1);' } });
t('saved text is kept per language and read back as entries', () => {
  const io = memIO(), s = createStore(io); s.reload();
  assert.strictEqual(s.setText('javascript', GOOD), true);
  assert.deepStrictEqual(io.data, { javascript: GOOD }); assert.strictEqual(s.text('javascript'), GOOD);
  assert.strictEqual(s.entries('javascript')[0].name, 'Log'); assert.strictEqual(s.count('javascript'), 1); assert.strictEqual(s.count('python'), 0);
  assert.deepStrictEqual(s.entries('python'), []);
  s.setText('python', JSON.stringify({ P: { prefix: 'p', body: 'pass' } }));
  assert.deepStrictEqual(s.languages().sort(), ['javascript', 'python']);
});
t('text that is not valid JSON is never kept: the last good version stays in use', () => {
  const io = memIO(), s = createStore(io); s.reload(); s.setText('javascript', GOOD);
  const saves = io.saves;
  assert.strictEqual(s.setText('javascript', '{ "Log": '), false);
  assert.strictEqual(s.text('javascript'), GOOD); assert.strictEqual(s.count('javascript'), 1); assert.strictEqual(io.saves, saves, 'nothing was written');
  assert.strictEqual(s.setText('javascript', '[1]'), false);
});
t('an empty file or an empty object removes the language, so it stops listing', () => {
  const io = memIO(), s = createStore(io); s.reload(); s.setText('javascript', GOOD);
  s.setText('javascript', '{\n}'); assert.deepStrictEqual(io.data, {}); assert.strictEqual(s.count('javascript'), 0); assert.deepStrictEqual(s.languages(), []);
  s.setText('python', GOOD); s.setText('python', '  \n'); assert.deepStrictEqual(io.data, {});
});
t('a file with only skipped snippets is kept (the user is still fixing it) but lists no language', () => {
  const io = memIO(), s = createStore(io); s.reload();
  const half = JSON.stringify({ Bad: { body: 'x' } });
  assert.strictEqual(s.setText('javascript', half), true); assert.strictEqual(s.text('javascript'), half);
  assert.strictEqual(s.count('javascript'), 0); assert.deepStrictEqual(s.languages(), []);
  assert.strictEqual(s.parsed('javascript').skipped.length, 1);
});
t('a language called __proto__ or constructor is just a language', () => {
  const stored = JSON.parse('{"__proto__": "{\\"A\\":{\\"prefix\\":\\"a\\",\\"body\\":\\"b\\"}}", "constructor": "{\\"B\\":{\\"prefix\\":\\"b\\",\\"body\\":\\"c\\"}}"}');
  const s = createStore(memIO(stored)); s.reload();
  assert.deepStrictEqual(s.languages().sort(), ['__proto__', 'constructor']); assert.strictEqual(s.count('constructor'), 1);
  assert.strictEqual(s.count('toString'), 0, 'inherited names are not languages');
  const fresh = createStore(memIO()); // no reload first: the starting object must be safe too
  assert.strictEqual(fresh.setText('__proto__', GOOD), true);
  assert.strictEqual(fresh.count('__proto__'), 1); assert.deepStrictEqual(fresh.languages(), ['__proto__']);
});
t('reload reads what was stored for this window and ignores anything that is not a snippets file', () => {
  const s = createStore(memIO({ javascript: GOOD, python: 42, ruby: '   ', go: null }));
  s.reload();
  assert.deepStrictEqual(s.languages(), ['javascript']); assert.strictEqual(s.text('python'), '');
  for (const junk of ['text', 5, [], null]) { const x = createStore(memIO(junk)); assert.doesNotThrow(() => x.reload()); assert.deepStrictEqual(x.languages(), []); }
  const boom = createStore({ load() { throw new Error('private mode'); }, save() { throw new Error('private mode'); } });
  assert.doesNotThrow(() => boom.reload()); assert.doesNotThrow(() => boom.setText('javascript', GOOD)); assert.strictEqual(boom.count('javascript'), 1, 'it still lasts for this page');
});
t('changing a language\u2019s text refreshes its entries, and listeners hear of every change', () => {
  const s = createStore(memIO()); s.reload(); let calls = 0; const off = s.onChange(() => { calls++; });
  s.setText('javascript', GOOD);
  s.setText('javascript', JSON.stringify({ A: { prefix: 'a', body: 'b' }, B: { prefix: 'b', body: 'c' } }));
  assert.strictEqual(s.count('javascript'), 2); assert.strictEqual(calls, 2); off(); s.setText('javascript', GOOD); assert.strictEqual(calls, 2);
});

console.log('wiring (source checks)');
t('the scripts are loaded in an order that works, and precached', () => {
  const html = read('index.html'), sw = read('sw.js');
  const order = ['keybindings.js', 'json-schemas.js', 'snippets.js', 'settings-json.js'].map((f) => html.indexOf('js/core/' + f));
  assert.ok(order.every((i) => i > 0) && order.every((v, i) => !i || v > order[i - 1]), 'json-schemas.js comes before the two features that use it');
  for (const f of ['json-schemas.js', 'snippets.js', 'settings-json.js']) assert.ok(sw.includes("'/js/core/" + f + "'"), f + ' is precached');
});
t('Settings has a Snippets tab after Editor (desktop and phone) with the form and the file', () => {
  const sp = read('js/core/settings-profile.js');
  assert.ok(sp.indexOf('data-tab="snippets"><i class="ri-braces-line"></i> Snippets') > sp.indexOf('data-tab="editor"><i class="ri-code-box-line"></i> Editor</div>'));
  assert.strictEqual((sp.match(/data-tab="snippets"/g) || []).length, 2, 'sidebar and phone bar');
  const sec = sp.slice(sp.indexOf('id="set-snippets"'), sp.indexOf('id="set-keybinds"'));
  for (const id of ['snLang', 'snName', 'snPrefix', 'snDesc', 'snBody', 'snAdd', 'snFormError', 'snEditor', 'snStatus']) assert.ok(sec.includes('id="' + id + '"'), id);
  assert.ok(!sec.includes('${1'), 'a literal ${ in the template would be run as code: it is written as an entity');
  assert.ok(sec.includes('$&#123;1:name&#125;'));
  assert.ok(/window\.CodeMiniSnippets\.renderSettings\(settingsContainer\)/.test(sp) && /window\.CodeMiniSnippets\.reloadFor\(winId, isProfile\)/.test(sp));
});
t('autocomplete is registered for each language by name (Monaco 0.39 ignores a * selector), and a pane can free what a feature put in it', () => {
  const src = read('js/core/snippets.js').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); // code only: the comment explains the wildcard
  assert.strictEqual((src.match(/registerCompletionItemProvider\(/g) || []).length, 1, 'one registration site');
  assert.ok(/registerCompletionItemProvider\(id, makeProvider\(\)\)/.test(src), 'by language id');
  assert.ok(!/registerCompletionItemProvider\('\*'/.test(src) && !/language: '\*'/.test(src), 'never a wildcard: Monaco does not call it');
  assert.ok(/getLanguages\(\)\.forEach\(\(l\) => ensureLanguage\(l\.id\)\)/.test(src) && /onDidCreateModel\(\(model\) => ensureLanguage\(model\.getLanguageId\(\)\)\)/.test(src), 'every known language, and later ones');
  assert.ok(/CompletionItemKind\.Snippet/.test(src) && /InsertAsSnippet/.test(src));
  assert.ok(/pane\._cmDispose/.test(src) && /paneElement\._cmDispose\(\)/.test(read('js/core/editor.js')));
});
t('Quick Open and the palette can open it', () => {
  const qo = read('js/core/quick-open.js');
  assert.ok(/name: 'Configure Snippets'[^\n]*CodeMiniSnippets\.open\(\)/.test(qo));
});

console.log(`\n${n} snippets checks passed`);
