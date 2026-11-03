// Quick Open's pure logic (js/core/quick-open.js): fuzzy matching, ranking, query parsing and the recent list.
// The DOM half is covered in a real browser by tests/e2e/quick-open.e2e.js.
const assert = require('assert');
const { fuzzyMatch, parseQuery, rankFiles, rankByName, pushRecent } = require('../js/core/quick-open.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };
const mk = (path, id) => { const name = path.split('/').pop(); return { id: id || path, name, path }; };
const order = (files, q, recents) => rankFiles(files.map((p) => mk(p)), q, recents).map((h) => h.file.path);

(async () => {
  console.log('fuzzy matching');
  await t('needs the letters in order, and says no otherwise', () => {
    assert.ok(fuzzyMatch('sapp', 'src/app.js'));
    assert.strictEqual(fuzzyMatch('ppa', 'src/app.js'), null);
    assert.strictEqual(fuzzyMatch('xyz', 'src/app.js'), null);
    assert.strictEqual(fuzzyMatch('averyveryverylongquery', 'a.js'), null);
  });
  await t('reports where each letter landed (used to highlight them)', () => {
    assert.deepStrictEqual(fuzzyMatch('sapp', 'src/app.js').positions, [0, 4, 5, 6]);
    assert.deepStrictEqual(fuzzyMatch('app', 'src/app.js').positions, [4, 5, 6]);
  });
  await t('prefers a run of letters at the start of a word over scattered ones', () => {
    assert.deepStrictEqual(fuzzyMatch('app', 'a-big-pop-app.js').positions, [10, 11, 12]);
    assert.deepStrictEqual(fuzzyMatch('fb', 'foo/bar.js').positions, [0, 4]);
  });
  await t('understands camelCase and separators as word starts', () => {
    assert.deepStrictEqual(fuzzyMatch('gfic', 'getFileIcon.js').positions, [0, 3, 7, 8]);
    assert.deepStrictEqual(fuzzyMatch('gfi', 'getFileIcon.js').positions, [0, 3, 4]); // a consecutive run beats a later hump
    assert.deepStrictEqual(fuzzyMatch('mh', 'my_helper.py').positions, [0, 3]);
  });
  await t('ignores case, and spaces in the query', () => {
    assert.deepStrictEqual(fuzzyMatch('READ', 'readme.md').positions, [0, 1, 2, 3]);
    assert.deepStrictEqual(fuzzyMatch('src app', 'src/app.js').positions, fuzzyMatch('srcapp', 'src/app.js').positions);
  });
  await t('an empty query matches everything with no positions', () => {
    assert.deepStrictEqual(fuzzyMatch('', 'anything'), { score: 0, positions: [] });
  });
  await t('scores a tighter match higher', () => {
    assert.ok(fuzzyMatch('app', 'app.js').score > fuzzyMatch('app', 'a_p_p.js').score);
    assert.ok(fuzzyMatch('app', 'src/app.js').score > fuzzyMatch('app', 'src/apple/pie.js').score - 100);
  });

  console.log('ranking files');
  await t('the file whose name matches beats one that only matches in its folder', () => {
    const r = order(['src/app/index.js', 'src/app.js', 'lib/happy.js'], 'app');
    assert.strictEqual(r[0], 'src/app.js');
    assert.ok(r.indexOf('src/app.js') < r.indexOf('src/app/index.js'));
  });
  await t('an exact name wins, then a name that starts with it', () => {
    const r = order(['docs/readme.txt', 'readme.md', 'a/b/c/readme.md', 'readme-old.md'], 'readme.md');
    assert.strictEqual(r[0], 'readme.md');
    assert.deepStrictEqual(order(['x/appendix.md', 'app.js', 'happy/app2.js'], 'app')[0], 'app.js');
  });
  await t('a query can reach into the folder path ("src/ap")', () => {
    const r = order(['src/app.js', 'test/app.js', 'app.js'], 'src/ap');
    assert.strictEqual(r[0], 'src/app.js');
    assert.ok(!r.includes('app.js') || r.indexOf('app.js') > 0);
  });
  await t('recently opened files get a nudge, which does not beat a clearly better match', () => {
    const files = ['a/config.js', 'b/config.js'];
    assert.strictEqual(order(files, 'config', ['b/config.js'])[0], 'b/config.js');
    // ...between two files with the same name, the one you were just in comes first
    assert.strictEqual(order(['config.js', 'x/y/z/config.js'], 'config', ['x/y/z/config.js'])[0], 'x/y/z/config.js');
    // ...but a recent file that matches badly does not jump over one that matches well
    assert.strictEqual(order(['config.js', 'old/mis_c_o_n_fig.js'], 'config', ['old/mis_c_o_n_fig.js'])[0], 'config.js');
  });
  await t('ties go to the shorter path, then alphabetical order', () => {
    assert.deepStrictEqual(order(['b/x.js', 'a/x.js', 'x.js'], 'x'), ['x.js', 'a/x.js', 'b/x.js']);
  });
  await t('an empty query keeps every file', () => {
    assert.strictEqual(order(['a.js', 'b.js'], '').length, 2);
  });
  await t('stays fast on a big workspace (5,000 files)', () => {
    const files = [];
    for (let i = 0; i < 5000; i++) files.push(mk(`packages/pkg${i % 50}/src/module${i}/component_${i}.tsx`));
    const t0 = Date.now();
    const hits = rankFiles(files, 'pkg7mod12comp', []);
    const ms = Date.now() - t0;
    assert.ok(hits.length > 0 && ms < 1500, `took ${ms} ms`);
  });
  await t('rankByName filters and orders commands', () => {
    const cmds = [{ name: 'Toggle Zen Mode' }, { name: 'Toggle Sidebar' }, { name: 'New File' }];
    assert.deepStrictEqual(rankByName(cmds, 'zen', (c) => c.name).map((h) => h.item.name), ['Toggle Zen Mode']);
    assert.strictEqual(rankByName(cmds, 'tog', (c) => c.name).length, 2);
    assert.strictEqual(rankByName(cmds, '', (c) => c.name).length, 3);
  });

  console.log('reading what was typed');
  await t('a leading character picks the mode', () => {
    assert.deepStrictEqual(parseQuery('>format'), { mode: 'commands', text: 'format' });
    assert.deepStrictEqual(parseQuery('  > zen '), { mode: 'commands', text: 'zen' });
    assert.deepStrictEqual(parseQuery('@render'), { mode: 'symbol', text: 'render' });
    assert.deepStrictEqual(parseQuery('#my ws'), { mode: 'workspace', text: 'my ws' });
    assert.deepStrictEqual(parseQuery(''), { mode: 'all', text: '' });
    assert.deepStrictEqual(parseQuery('app'), { mode: 'all', text: 'app' });
  });
  await t(': is go-to-line, with an optional column', () => {
    assert.deepStrictEqual(parseQuery(':42'), { mode: 'line', text: '', line: 42, col: null });
    assert.deepStrictEqual(parseQuery(':12:5'), { mode: 'line', text: '', line: 12, col: 5 });
    assert.deepStrictEqual(parseQuery(':'), { mode: 'line', text: '', line: null, col: null });
    assert.deepStrictEqual(parseQuery(': 7'), { mode: 'line', text: '', line: 7, col: null });
  });
  await t('name:line opens a file at a line; a colon that is not followed by a number is just text', () => {
    assert.deepStrictEqual(parseQuery('app.js:42'), { mode: 'all', text: 'app.js', line: 42, col: null });
    assert.deepStrictEqual(parseQuery('src/app.js:42:7'), { mode: 'all', text: 'src/app.js', line: 42, col: 7 });
    assert.deepStrictEqual(parseQuery('app.js:'), { mode: 'all', text: 'app.js:' });
    assert.deepStrictEqual(parseQuery('a:b'), { mode: 'all', text: 'a:b' });
  });

  console.log('the recent list');
  await t('puts the newest first, never repeats, and stops at the limit', () => {
    assert.deepStrictEqual(pushRecent([], 'a'), ['a']);
    assert.deepStrictEqual(pushRecent(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
    assert.deepStrictEqual(pushRecent(['a', 'b', 'c'], 'd', 3), ['d', 'a', 'b']);
    assert.deepStrictEqual(pushRecent(undefined, 'x'), ['x']);
  });

  console.log(`\n${n} quick-open checks passed`);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
