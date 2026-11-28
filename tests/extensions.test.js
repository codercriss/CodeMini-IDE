// The Extensions engine (js/core/extensions.js): reading a .cmpack safely, checking it, validating a theme and a snippet pack, the installed store,
// and the rules for applying a theme; plus how the sidebar (js/core/extensions-ui.js) is wired in. The sidebar itself is covered in a real browser
// by tests/e2e/extensions.e2e.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('../js/core/extensions.js');
const S = require('../js/core/snippets.js');
const M = require('./lib/make-cmpack.js');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let n = 0; const t = (name, fn) => Promise.resolve().then(fn).then(() => { n++; console.log('  ok', name); });

// What the browser's DecompressionStream does, in Node: stop as soon as more than `max` bytes come out.
const inflate = async (u8, max) => { const out = zlib.inflateRawSync(Buffer.from(u8), { maxOutputLength: Math.max(1, max) + 1 }); if (out.length > max) throw new Error('A file in the package is larger than it says.'); return new Uint8Array(out); };
const io = { inflate, parseSnippets: S.parseSnippets, sha256: E.sha256Hex };
const THEME = { name: 'Midnight', version: '1.0', author: 'Ana', description: 'A dark blue theme.', base: 'dark', colors: { '--accent-blue': '#7aa2f7', '--bg-white': '#1a1b26', '--text-main': '#c0caf5' } };
const PACK = { name: 'JS helpers', version: '1.2.0', author: 'Bo', language: 'javascript', snippets: { Log: { prefix: 'cl', body: 'console.log($1)' }, Fn: { prefix: 'fn', body: ['function ${1:name}() {', '\t$0', '}'] } } };
const read1 = (buf, existing) => E.readPack(new Uint8Array(buf), io, existing || []);
const fails = async (buf, re, label) => { const r = await read1(buf); assert.strictEqual(r.ok, false, label + ' should be refused'); assert.ok(re.test(r.error), label + ': ' + r.error); return r; };

(async () => {
console.log('colours');
await t('only hex colours are accepted, and they are normalised', () => {
  assert.deepStrictEqual(['#FFF', '#a1b2c3', '#A1B2C3FF', ' #abc '].map(E.normalizeColor), ['#ffffff', '#a1b2c3', '#a1b2c3ff', '#aabbcc']);
  ['red', 'rgb(1,2,3)', 'url(x)', '#12', '#12345', '#ggg', '', null, 5, 'var(--x)', '#abc; background: red'].forEach((v) => assert.strictEqual(E.normalizeColor(v), '', String(v)));
  assert.ok(E.contrast('#000000', '#ffffff') > 20 && E.contrast('#777777', '#808080') < 1.5);
});

console.log('the ZIP reader');
await t('stored and deflate entries are both read, and folder entries are ignored', async () => {
  for (const method of ['store', 'deflate']) {
    const z = E.openZip(M.zip([{ name: 'a.txt', data: 'hello hello hello hello', method }, { name: 'dir/', data: '' }, { name: 'dir/b.txt', data: 'b', method }]), inflate);
    assert.deepStrictEqual(z.names().sort(), ['a.txt', 'dir/b.txt']);
    assert.strictEqual(Buffer.from(await z.read('a.txt')).toString(), 'hello hello hello hello');
    await assert.rejects(() => z.read('nope'), /has no nope/);
  }
});
await t('what is not a ZIP, and what is damaged, is refused with a plain message', async () => {
  assert.throws(() => E.openZip(Buffer.from('not a zip at all, just some text that is long enough'), inflate), /not a \.cmpack/);
  assert.throws(() => E.openZip(Buffer.alloc(5), inflate), /not a \.cmpack/);
  const good = M.zip([{ name: 'a', data: 'x' }]), bad = Buffer.from(good); bad.writeUInt32LE(9999, bad.length - 6);   // the directory's offset points off the end
  assert.throws(() => E.openZip(bad, inflate), /damaged/);
  assert.throws(() => E.openZip(Buffer.alloc(E.LIMITS.pack + 1), inflate), /larger than a pack/);
});
await t('it refuses before inflating: unsafe paths, encryption, other compression, zip64, too many files, a huge declared size, duplicates', async () => {
  ['../evil.json', '/abs/x', 'a/../../b', 'a\\b', 'C:x.json', 'a/..'].forEach((name) => assert.throws(() => E.openZip(M.zip([{ name, data: 'x', method: 'store' }]), inflate), /unsafe path/, name));
  assert.doesNotThrow(() => E.openZip(M.zip([{ name: 'ok..name/file..json', data: 'x', method: 'store' }]), inflate), 'two dots inside a name are not a climb');
  assert.throws(() => E.openZip(M.zip([{ name: 'a', data: 'x', flags: 1 }]), inflate), /encrypted/);
  const m9 = Buffer.from(M.zip([{ name: 'a', data: 'x' }])); m9.writeUInt16LE(9, m9.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
  assert.throws(() => E.openZip(m9, inflate), /compression this reader does not support/);
  const many = M.zip(Array.from({ length: E.LIMITS.entries + 1 }, (_, i) => ({ name: 'f' + i, data: 'x', method: 'store' })));
  assert.throws(() => E.openZip(many, inflate), /at most/);
  assert.throws(() => E.openZip(M.zip([{ name: 'big', data: 'x', method: 'store', claimSize: E.LIMITS.entry + 1 }]), inflate), /larger than a pack file/);
  assert.throws(() => E.openZip(M.zip([{ name: 'a', data: 'x' }, { name: 'a', data: 'y' }]), inflate), /twice/);
  const z64 = Buffer.from(M.zip([{ name: 'a', data: 'x' }])); z64.writeUInt16LE(0xFFFF, z64.length - 12);
  assert.throws(() => E.openZip(z64, inflate), /ZIP64/);
});
await t('a zip bomb is stopped: an entry that inflates to more than it declares is an error, not a memory problem', async () => {
  const bomb = M.zip([{ name: 'a.txt', data: Buffer.alloc(900000, 65), claimSize: 10 }]);          // declares 10 bytes, inflates to 900 KB
  const z = E.openZip(bomb, inflate);
  await assert.rejects(() => z.read('a.txt'), /larger than it says|not the size|Cannot create a Buffer larger|ERR_BUFFER_TOO_LARGE/);
  const lie = M.zip([{ name: 'b.txt', data: 'hello world', method: 'store', claimSize: 5 }]);      // stored, but the size field is wrong
  await assert.rejects(() => E.openZip(lie, inflate).read('b.txt'), /not the size/);
});

console.log('the manifest');
await t('a manifest must say codemini-pack, version 1, and list well-formed items', () => {
  const ok = { format: 'codemini-pack', version: 1, items: [{ kind: 'theme', path: 'theme.json', size: 10, sha256: 'a'.repeat(64) }] };
  assert.strictEqual(E.parseManifest(JSON.stringify(ok)).ok, true);
  const bad = (mut, re) => { const m = JSON.parse(JSON.stringify(ok)); mut(m); const r = E.parseManifest(JSON.stringify(m)); assert.ok(!r.ok && re.test(r.error), JSON.stringify(r)); };
  assert.ok(/not valid JSON/.test(E.parseManifest('{nope').error));
  bad((m) => { m.format = 'other'; }, /not a CodeMini pack/); bad((m) => { m.version = 2; }, /version 2/); bad((m) => { m.items = []; }, /no items/); bad((m) => { m.encryption = { alg: 'x' }; }, /encrypted/);
  bad((m) => { m.items[0].kind = 'virus'; }, /unknown kind/); bad((m) => { m.items[0].path = '../x'; }, /unsafe path/); bad((m) => { m.items[0].size = -1; }, /size/);
  bad((m) => { m.items[0].sha256 = 'zz'; }, /SHA-256/); bad((m) => { for (let i = 1; i < 30; i++) m.items[i] = m.items[0]; }, /too many/);
  assert.ok(!E.parseManifest('[]').ok && !E.parseManifest('null').ok);
});

console.log('reading a pack into a review');
await t('a theme pack, stored or deflated, becomes a review: what it is, where from, a short hash, what it changes, the Guard verdict', async () => {
  for (const method of ['deflate', 'store']) {
    const r = await read1(M.cmpack('theme', THEME, { method, sender: 'Ana' }));
    assert.ok(r.ok, JSON.stringify(r));
    const v = r.review;
    assert.strictEqual(v.kind, 'theme'); assert.strictEqual(v.record.id, 'theme-midnight'); assert.strictEqual(v.record.source, 'File');
    assert.deepStrictEqual(v.rows.map((x) => x[0]), ['Name', 'Version', 'Author', 'Source', 'SHA-256']);
    assert.ok(/not verified/.test(v.rows[2][1]) && /sent by Ana/.test(v.rows[3][1]) && v.rows[4][1].length === 12);
    assert.deepStrictEqual(v.changes, ['Sets 3 colours on the Dark theme', 'Changes nothing else: it has no code.']);
    assert.strictEqual(v.guard.verdict, 'Not fully checked'); assert.ok(/Guard is not available/.test(v.guard.text));
    assert.strictEqual(v.record.hash, M.sha256(Buffer.from(JSON.stringify(THEME, null, 2))));
    assert.ok(v.sourceText.includes('"Midnight"'));
  }
});
await t('a snippet pack becomes a review that says how many snippets and for which language', async () => {
  const r = await read1(M.cmpack('snippets', PACK));
  assert.ok(r.ok); assert.strictEqual(r.review.kind, 'pack'); assert.strictEqual(r.review.record.id, 'pack-js-helpers');
  assert.deepStrictEqual(r.review.changes, ['Adds 2 snippets for javascript', 'Your own snippets are not touched. Uninstalling removes only these.']);
  assert.deepStrictEqual([r.review.record.payload.language, r.review.record.payload.count], ['javascript', 2]);
});
await t('the SHA-256 must match: a changed file, a wrong size and a missing item all stop the install', async () => {
  const r = await fails(M.cmpack('theme', THEME, { sha256: '0'.repeat(64) }), /Integrity check failed.*changed after the pack was made/, 'a wrong hash');
  assert.ok(!r.review);
  await fails(M.cmpack('theme', THEME, { size: 5 }), /not the size the manifest says/, 'a wrong size');
  await fails(M.cmpack('theme', THEME, { manifest: { items: [{ kind: 'theme', path: 'gone.json', size: 1, sha256: 'a'.repeat(64) }] } }), /does not contain it/, 'a missing item');
  const body = JSON.stringify(THEME, null, 2), tampered = body.replace('#7aa2f7', '#ff0000');   // the bytes changed after the manifest was written, same length
  assert.strictEqual(tampered.length, body.length);
  await fails(M.cmpack('theme', tampered, { sha256: M.sha256(Buffer.from(body)), size: body.length }), /Integrity check failed/, 'tampered bytes');
});
await t('what this release cannot install says so, and why', async () => {
  await fails(M.cmpack('extension', { x: 1 }, { itemPath: 'ext.json' }), /scripted extension, which cannot be installed yet.*CodeMini Guard/, 'an extension');
  await fails(M.cmpack('notebook', { x: 1 }, { itemPath: 'n.json' }), /kind "notebook"/, 'a notebook');
  const two = M.cmpack('theme', THEME, { manifest: { items: [{ kind: 'theme', path: 'theme.json', size: 1, sha256: 'a'.repeat(64) }, { kind: 'theme', path: 'two.json', size: 1, sha256: 'b'.repeat(64) }] } });
  await fails(two, /2 items\. Install one item at a time/, 'two items');
  await fails(M.cmpack('theme', THEME, { manifest: { encryption: { alg: 'aes' } } }), /encrypted/, 'an encrypted pack');
  await fails(M.cmpack('theme', THEME, { manifest: { format: 'zip' } }), /not a CodeMini pack/, 'the wrong format');
  await fails(M.zip([{ name: 'readme.txt', data: 'hi' }]), /no manifest\.json/, 'no manifest');
  await fails(Buffer.from('definitely not a zip file, only text, long enough'), /not a \.cmpack/, 'not a zip');
  await fails(M.cmpack('theme', 'this is { not json'), /not valid JSON/, 'bad JSON in the item');
});
await t('a theme or pack with problems lists each problem', async () => {
  const r = await read1(M.cmpack('theme', { name: '', version: 'x', base: 'purple', colors: { '--accent-blue': 'red', '--evil': '#fff', 'background': '#000' } }));
  assert.ok(!r.ok && /theme file has problems/.test(r.error));
  assert.ok(r.details.some((d) => /name/.test(d)) && r.details.some((d) => /version/.test(d)) && r.details.some((d) => /base/.test(d)) && r.details.some((d) => /hex colour/.test(d)) && r.details.filter((d) => /not a colour a theme can set/.test(d)).length === 2);
  const p = await read1(M.cmpack('snippets', { name: 'x', version: '1.0', language: 'Not A Language!', snippets: {} }));
  assert.ok(!p.ok && p.details.some((d) => /language/.test(d)));
});
await t('installing over an existing item says what it replaces; the same bytes are flagged as already installed', async () => {
  const first = (await read1(M.cmpack('theme', THEME))).review.record;
  const same = await read1(M.cmpack('theme', THEME), [Object.assign({}, first, { version: '1.0' })]);
  assert.deepStrictEqual([same.review.replaces.version, same.review.replaces.same], ['1.0', true]);
  const newer = await read1(M.cmpack('theme', Object.assign({}, THEME, { version: '1.1' })), [Object.assign({}, first, { version: '1.0' })]);
  assert.deepStrictEqual([newer.review.replaces.version, newer.review.replaces.same], ['1.0', false]);
  assert.strictEqual((await read1(M.cmpack('theme', THEME))).review.replaces, null);
});

console.log('themes and packs');
await t('a theme may set only the colour variables the app defines, and only as hex', () => {
  const ok = E.validateTheme(THEME); assert.ok(ok.ok); assert.strictEqual(ok.theme.colors['--accent-blue'], '#7aa2f7'); assert.strictEqual(ok.theme.base, 'dark');
  assert.ok(!E.validateTheme(Object.assign({}, THEME, { colors: { '--accent-blue': 'url(javascript:alert(1))' } })).ok);
  assert.ok(!E.validateTheme(Object.assign({}, THEME, { colors: { 'position': 'fixed' } })).ok, 'no variable that is not a colour of the app');
  assert.ok(!E.validateTheme(Object.assign({}, THEME, { colors: {} })).ok && !E.validateTheme(null).ok && !E.validateTheme([]).ok);
  const many = {}; E.THEME_VARS.forEach((k) => { many[k] = '#112233'; }); assert.ok(E.validateTheme(Object.assign({}, THEME, { colors: many })).ok, 'every allowed variable at once');
  E.THEME_VARS.forEach((k) => assert.ok(/^--[a-z-]+$/.test(k)));
});
await t('every colour a theme can set is a variable css/themes.css really defines', () => {
  const css = read('css/themes.css');
  E.THEME_VARS.forEach((k) => assert.ok(new RegExp('\\s' + k + ':').test(css), k + ' is defined in themes.css'));
});
await t('low contrast between the main text and the background is a warning, not a refusal', () => {
  const r = E.validateTheme(Object.assign({}, THEME, { colors: { '--text-main': '#777777', '--bg-white': '#808080' } }));
  assert.ok(r.ok && r.warnings.length === 1 && /Low contrast/.test(r.warnings[0]));
  assert.deepStrictEqual(E.validateTheme(THEME).warnings, []);
});
await t('a snippet pack is checked by the Snippets editor\'s own parser, with the same rules', () => {
  const ok = E.validatePack(PACK, S.parseSnippets); assert.ok(ok.ok); assert.strictEqual(ok.pack.count, 2);
  assert.ok(!E.validatePack(Object.assign({}, PACK, { snippets: {} }), S.parseSnippets).ok);
  assert.ok(!E.validatePack(Object.assign({}, PACK, { language: '../x' }), S.parseSnippets).ok);
  assert.ok(!E.validatePack(Object.assign({}, PACK, { snippets: { A: { prefix: 'a', body: 'x'.repeat(E.LIMITS.snippetBody + 1) } } }), S.parseSnippets).ok);
  const mixed = E.validatePack(Object.assign({}, PACK, { snippets: { Good: { prefix: 'g', body: 'x' }, Bad: { body: 'y' } } }), S.parseSnippets);
  assert.ok(mixed.ok && mixed.pack.count === 1 && mixed.warnings.length === 1 && /"Bad" will be skipped/.test(mixed.warnings[0]));
  const lots = {}; for (let i = 0; i < E.LIMITS.snippets + 1; i++) lots['s' + i] = { prefix: 'p' + i, body: 'b' };
  assert.ok(!E.validatePack(Object.assign({}, PACK, { snippets: lots }), S.parseSnippets).ok);
});

console.log('the installed items');
const mem = () => { let saved = null; return { io: { load: () => saved, save: (l) => { saved = JSON.parse(JSON.stringify(l)); } } }; };
const rec = (id, extra) => Object.assign({ id, kind: 'theme', name: id, version: '1.0', author: '', description: '', source: 'File', hash: 'h' + id, payload: { base: 'dark', colors: { '--accent-blue': '#112233' } } }, extra || {});
await t('add, replace (keeping when it was installed and what it replaced), enable, disable, remove, and they survive a reload', () => {
  const m = mem(), st = E.createStore(m.io); st.reload(); let changes = 0; st.onChange(() => changes++);
  const a = st.add(rec('theme-a')); assert.ok(a.enabled && a.installedAt > 0 && a.previous === null);
  const a2 = st.add(rec('theme-a', { version: '2.0', hash: 'new' }));
  assert.deepStrictEqual([a2.installedAt, a2.previous], [a.installedAt, { version: '1.0', hash: 'htheme-a' }]);
  assert.strictEqual(st.list().length, 1);
  st.add(rec('theme-b'), false); assert.strictEqual(st.get('theme-b').enabled, false);
  assert.ok(st.setEnabled('theme-b', true) && st.get('theme-b').enabled && !st.setEnabled('nope', true));
  assert.ok(st.remove('theme-a') && !st.remove('theme-a') && st.list().length === 1);
  assert.ok(changes >= 5);
  const st2 = E.createStore(m.io); st2.reload(); assert.deepStrictEqual(st2.list().map((r) => r.id), ['theme-b']);
});
await t('a damaged or hostile saved list is cleaned, not trusted; limits are kept', () => {
  const st = E.createStore({ load: () => [rec('theme-ok'), null, 5, { id: 1 }, { id: 'x', kind: 'script', name: 'n', payload: {} }, { id: 'y', kind: 'pack', name: 'n' }], save: () => {} }); st.reload();
  assert.deepStrictEqual(st.list().map((r) => r.id), ['theme-ok']);
  const bad = E.createStore({ load: () => { throw new Error('storage broke'); }, save: () => {} }); bad.reload(); assert.deepStrictEqual(bad.list(), []);
  const st2 = E.createStore(mem().io); st2.reload();
  assert.throws(() => st2.add({ id: 'x' }), /not an installable item/);
  assert.throws(() => st2.add(rec('big', { description: 'x'.repeat(E.LIMITS.item) })), /larger than an installed item/);
  for (let i = 0; i < E.LIMITS.records; i++) st2.add(rec('theme-' + i));
  assert.throws(() => st2.add(rec('theme-extra')), /already 100 installed/);
  assert.ok(st2.add(rec('theme-3', { version: '9.0' })), 'replacing one is still allowed at the limit');
  const st3 = E.createStore(mem().io); st3.reload();
  for (let i = 0; i < 6; i++) st3.add(rec('p' + i, { description: 'y'.repeat(500000) }));   // six of these fit in 3 MB
  assert.throws(() => st3.add(rec('p-last', { description: 'y'.repeat(500000) })), /no room/);
});
await t('a failing save (private mode) never breaks installing: it lasts for the page', () => {
  const st = E.createStore({ load: () => null, save: () => { throw new Error('quota'); } }); st.reload();
  assert.doesNotThrow(() => st.add(rec('theme-q'))); assert.strictEqual(st.list().length, 1);
  st.onChange(() => { throw new Error('a bad listener'); }); assert.doesNotThrow(() => st.setEnabled('theme-q', false));
});

console.log('applying');
await t('a theme\'s colours apply only on the base it was made for, never over a theme pack, never when disabled', () => {
  const r = rec('theme-a'), dark = { colorTheme: 'CodeMini Dark', themePack: 'None' };
  assert.deepStrictEqual(E.themeOverlay(r, dark), { '--accent-blue': '#112233' });
  assert.deepStrictEqual(E.themeOverlay(r, { colorTheme: 'CodeMini Light', themePack: 'None' }), {}, 'a dark theme on the light base would be unreadable');
  assert.deepStrictEqual(E.themeOverlay(r, { colorTheme: 'CodeMini Dark', themePack: 'CodeMini Premium' }), {}, 'a theme pack owns the whole look');
  assert.deepStrictEqual(E.themeOverlay(r, { colorTheme: 'CodeMini Dark' }), { '--accent-blue': '#112233' });
  assert.deepStrictEqual(E.themeOverlay(Object.assign({}, r, { enabled: false }), dark), {});
  assert.deepStrictEqual(E.themeOverlay(null, dark), {}); assert.deepStrictEqual(E.themeOverlay(rec('p', { kind: 'pack' }), dark), {}); assert.deepStrictEqual(E.themeOverlay(r, null), {});
  const sneaky = rec('theme-s', { payload: { base: 'dark', colors: { '--accent-blue': '#112233', '--evil': '#fff', '--bg-white': 'url(x)' } } });
  assert.deepStrictEqual(E.themeOverlay(sneaky, dark), { '--accent-blue': '#112233' }, 'a stored value is checked again when it is applied');
});
await t('enabled packs feed completion for their language only; disabled ones and other languages do not', () => {
  const packs = [rec('pack-a', { kind: 'pack', payload: { language: 'javascript', snippets: PACK.snippets, count: 2 } }), rec('pack-b', { kind: 'pack', enabled: false, payload: { language: 'javascript', snippets: { Z: { prefix: 'zz', body: 'z' } }, count: 1 } }), rec('pack-c', { kind: 'pack', payload: { language: 'python', snippets: { P: { prefix: 'pp', body: 'p' } }, count: 1 } }), rec('theme-t')];
  assert.deepStrictEqual(E.packEntries(packs, 'javascript', S.parseSnippets).map((e) => e.prefixes[0]).sort(), ['cl', 'fn']);
  assert.deepStrictEqual(E.packEntries(packs, 'python', S.parseSnippets).map((e) => e.prefixes[0]), ['pp']);
  assert.deepStrictEqual(E.packEntries(packs, 'go', S.parseSnippets), []); assert.deepStrictEqual(E.packEntries(null, 'go', S.parseSnippets), []);
});
await t('the Snippets store merges installed packs into what completion offers, and leaves the person\'s own numbers alone', () => {
  const store = S.createStore({ load: () => ({ javascript: JSON.stringify({ Mine: { prefix: 'mine', body: 'm' } }) }), save: () => {} });
  if (store.reload) store.reload();
  assert.deepStrictEqual(store.entries('javascript').map((e) => e.prefixes[0]), ['mine']); const countBefore = store.count('javascript');
  store.setExtra((lang) => (lang === 'javascript' ? E.packEntries([rec('pack-a', { kind: 'pack', payload: { language: 'javascript', snippets: PACK.snippets, count: 2 } })], 'javascript', S.parseSnippets) : []));
  assert.deepStrictEqual(store.entries('javascript').map((e) => e.prefixes[0]).sort(), ['cl', 'fn', 'mine']);
  assert.strictEqual(store.count('javascript'), countBefore, 'the editor\'s own count is the person\'s snippets only');
  assert.deepStrictEqual(store.entries('python'), []);
  store.setExtra(() => { throw new Error('a broken source'); }); assert.deepStrictEqual(store.entries('javascript').map((e) => e.prefixes[0]), ['mine'], 'a broken source never breaks completion');
  store.setExtra(null); assert.deepStrictEqual(store.entries('javascript').map((e) => e.prefixes[0]), ['mine']);
});

console.log('wiring');
await t('the scripts load after offline.js, are precached, and are in npm test; the sidebar element is there', () => {
  const html = read('index.html');
  assert.ok(html.indexOf('js/core/extensions.js') > html.indexOf('js/core/offline.js') && html.indexOf('js/core/extensions-ui.js') > html.indexOf('js/core/extensions.js'));
  assert.ok(/<div class="sidebar" id="extensionsSidebar"><\/div>/.test(html));
  const sw = read('sw.js'); assert.ok(sw.includes("'/js/core/extensions.js'") && sw.includes("'/js/core/extensions-ui.js'"));
  assert.ok(JSON.parse(read('package.json')).scripts.test.includes('tests/extensions.test.js'));
});
await t('script.js saves, restores and closes the sidebar like the others, and the plug item opens it', () => {
  const sc = read('js/core/script.js');
  assert.ok(/getElementById\('extensionsSidebar'\)\?\.classList\.contains\('open'\) \? 'extensions'/.test(sc));
  assert.ok(/uiState\.sidebar === 'extensions'/.test(sc));
  assert.ok((sc.match(/getElementById\('extensionsSidebar'\)\?\.classList\.remove\('open'\)/g) || []).length === 1);
  assert.ok(/closest\('#extensionIconItem'\)/.test(read('js/core/extensions-ui.js')), 'a delegated click: the item gets its id from script.js after load');
});
await t('the theme code layers an installed theme last, caches its colours against a flash, and leaves it when Settings chooses another theme', () => {
  const sp = read('js/core/settings-profile.js');
  const iClear = sp.indexOf('CodeMiniExtensions.clearOverlay'), iApply = sp.indexOf('CodeMiniExtensions.applyOverlay'), iTint = sp.indexOf("'--bg-tabs-bar'");
  assert.ok(iClear > 0 && iApply > iClear && iApply > iTint, 'cleared at the start of applyTheme, applied after the tint and status colours');
  assert.ok(/appliedVars\(\)/.test(sp), 'the early theme cache knows the extra colours, so a reload does not flash the base theme');
  assert.ok(/extTheme: ''/.test(sp) && /extTheme: localStorage\.getItem\(getPrefixedKey\('extTheme'\)\)/.test(sp));
  assert.ok(/key === 'colorTheme' \|\| key === 'themePack'\) && !window\.__extApplying && window\.appSettings\.extTheme\) window\.saveSetting\('extTheme', ''\)/.test(sp));
  assert.ok(read('tests/e2e/codemini-config.e2e.js').includes("'extTheme'"), 'extTheme is on the reviewed personal list');
  assert.ok(/CodeMiniExtensions\.reload\(\)/.test(sp), 'a window or profile switch loads that window\'s installed items');
});
await t('no HTML is built from text in either file, and the engine makes no network request', () => {
  ['js/core/extensions.js', 'js/core/extensions-ui.js'].forEach((f) => { const src = read(f).replace(/\/\/.*$/gm, ''); assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|srcdoc/.test(src), f); });
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|importScripts/.test(read('js/core/extensions.js').replace(/\/\/.*$/gm, '')), 'a pack is a file the person chose: nothing is fetched');
});
await t('every class the sidebar uses has a rule, and the theme packs know the new pills and cards', () => {
  const ui = read('js/core/extensions-ui.js'), css = read('css/style.css'), ni = read('js/core/now-island.js'), th = read('css/themes.css');
  const used = new Set();
  (ui.match(/el\('[a-z0-9]+', '([^']+)'/g) || []).forEach((m) => m.split("'")[3].split(' ').forEach((c) => { if (/^(ext|sb)-/.test(c)) used.add(c); }));
  (ui.match(/['"`](ext-[a-z0-9-]+)/g) || []).forEach((m) => used.add(m.slice(1)));
  const missing = Array.from(used).filter((c) => c !== 'ext-' && !css.includes('.' + c) && !ni.includes('.' + c));
  assert.deepStrictEqual(missing, [], 'classes without a rule: ' + missing.join(', '));
  ['.ext-pill', '.ext-switch', '.ext-switch-knob'].forEach((s) => assert.ok(th.includes('"codemini-premium"] ' + s), s));
  assert.ok(/input\.ext-search\[type="search"\] \{\s*border-radius: 0 !important/.test(th) && /\.ext-menu,\s*\n\[data-theme-pack\^="codemini-premium"\] \.ext-error \{\s*border-radius: 14px/.test(th));
  assert.ok(/\.sb-tabs \{/.test(css) && /\.sb-tab\.active/.test(css), 'the shared tabs are defined once, in style.css');
  assert.ok(/\.ext-root \{[^}]*white-space: normal/.test(css), 'the sidebar sets nowrap; text in it must wrap (it overflowed a phone before)');
  assert.ok(/@media \(pointer: coarse\)[\s\S]*min-height: 32px[\s\S]*\.ext-switch::after \{ content: ''; position: absolute; inset: -14px -8px/.test(css), 'touch targets are enlarged');
});
await t('the Offline section\'s Manage opens this sidebar\'s Components tab, and the UI uses the engine\'s own API', () => {
  const off = read('js/core/offline.js'), ui = read('js/core/extensions-ui.js'), exp = off.slice(off.indexOf('W.CodeMiniOffline = Object.freeze'));
  assert.ok(/CodeMiniExtensionsUI\.open\('components'\)/.test(off));
  ['refresh', 'rows', 'download', 'stop', 'removePackage', 'setKeep', 'isKept', 'verify', 'summary', 'needsDownload', 'packageBytes', 'onChange', 'wantSizes', 'missing', 'info'].forEach((k) => assert.ok(new RegExp('\\b' + k + '\\b').test(exp), 'offline.js exports ' + k));
  assert.ok(/W\.CodeMiniOfflineRules = api/.test(off) && /W\.CodeMiniExtensionsUI = Object\.freeze/.test(ui));
});

console.log(n + ' extensions checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
