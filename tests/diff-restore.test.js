// Restore Session for diff tabs. A diff tab has no file of its own, so it saves a small descriptor of how it was opened
// (validRestore in js/core/diff-editor.js) and is rebuilt from it at startup. What matters: a descriptor read back from
// storage is never trusted, a tab whose files or commit are gone is skipped rather than opened empty, every tab goes back
// into its own editor group, and none of them takes over what a group is showing.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const { validRestore } = require('../js/core/diff-editor.js');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const files = { de: read('js/core/diff-editor.js'), git: read('js/git/git.js'), hist: read('js/core/file-history.js'), ed: read('js/core/editor.js'), app: read('js/core/app.js') };
const grab = (key, from, to) => { const s = files[key], i = s.indexOf(from), j = s.indexOf(to, i + from.length); assert(i >= 0 && j > i, `cannot find ${from}`); return s.slice(i, j); };
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };
const plain = (x) => JSON.parse(JSON.stringify(x));

(async () => {
  console.log('the descriptor is a gate, not a trust');
  await t('every kind comes back as a clean copy with only its own fields', () => {
    const cases = [
      { k: 'cmp', a: { id: 'f1', name: 'a.js', dbName: 'ws' }, b: { id: 'f2', name: 'b.js', dbName: 'ws' } },
      { k: 'saved', fileId: 'f1', name: 'a.js', dbName: 'ws' },
      { k: 'git-work', dbName: 'ws', path: '/src/a.js' },
      { k: 'git-commit', dbName: 'ws', sha: 'abc123', path: '/src/a.js' },
      { k: 'git-conflict', dbName: 'ws', path: '/src/a.js' },
      { k: 'hist', dbName: 'ws', fileId: 'f1', name: 'a.js', a: 'e1', b: 'current' },
    ];
    for (const c of cases) {
      assert.deepStrictEqual(plain(validRestore(c)), c);
      assert.deepStrictEqual(plain(validRestore({ ...c, extra: 1, onclick: 'x()' })), c, 'unknown fields are dropped');
    }
  });
  await t('"the open workspace" may be left empty for files and history, but a Source Control tab must name its workspace', () => {
    assert.strictEqual(validRestore({ k: 'saved', fileId: 'f', name: 'a', dbName: '' }).dbName, '');
    assert.strictEqual(validRestore({ k: 'saved', fileId: 'f', name: 'a', dbName: null }).dbName, '');
    assert.strictEqual(validRestore({ k: 'cmp', a: { id: '1', name: 'a' }, b: { id: '2', name: 'b', dbName: null } }).b.dbName, '');
    assert.strictEqual(validRestore({ k: 'git-work', dbName: '', path: '/a' }), null);
    assert.strictEqual(validRestore({ k: 'git-work', path: '/a' }), null);
  });
  await t('anything malformed, unknown or oversized is refused', () => {
    const bad = [null, undefined, 0, 'git-work', [], [{ k: 'git-work' }], {}, { k: 'nope' }, { k: 'git-work', dbName: 'ws' }, { k: 'git-work', dbName: 'ws', path: 5 },
      { k: 'git-work', dbName: 'ws', path: '' }, { k: 'git-work', dbName: 'ws', path: 'x'.repeat(601) }, { k: 'git-work', dbName: { a: 1 }, path: '/a' },
      { k: 'cmp', a: { id: 'f1', name: 'a' } }, { k: 'cmp', a: null, b: null }, { k: 'cmp', a: { id: 1, name: 'a' }, b: { id: 'f2', name: 'b' } },
      { k: 'saved', fileId: 'f', dbName: 'ws' }, { k: 'hist', dbName: 'ws', fileId: 'f', name: 'a', a: 'e1' }, { k: '__proto__' }, { k: 'constructor' }];
    for (const b of bad) assert.strictEqual(validRestore(b), null, JSON.stringify(b));
    assert.notStrictEqual(validRestore({ k: 'git-work', dbName: 'ws', path: 'x'.repeat(600) }), null, '600 is the longest allowed');
  });
  await t('a hostile object cannot smuggle fields through prototypes', () => {
    const o = JSON.parse('{"k":"git-work","dbName":"ws","path":"/a","__proto__":{"polluted":true},"constructor":{"x":1}}');
    const r = validRestore(o);
    assert.deepStrictEqual(Object.keys(r), ['k', 'dbName', 'path']); assert.strictEqual({}.polluted, undefined);
  });

  console.log('restoreOne: which opener runs, and when nothing opens');
  const mkOne = ({ records = {}, tabs = [], W = {} } = {}) => {
    const calls = { compareFiles: [], compareWithSaved: [] };
    const ctx = {
      document: { querySelectorAll: () => tabs }, W,
      getRecord: async (id, dbName) => records[`${dbName}|${id}`] || null,
      compareFiles: (a, b) => { calls.compareFiles.push([a, b]); return {}; },
      compareWithSaved: (tab) => { calls.compareWithSaved.push(tab); return {}; },
      validRestore,
    };
    vm.createContext(ctx); vm.runInContext(grab('de', 'async function restoreOne(', 'function moveTabToGroup('), ctx);
    return { ctx, calls };
  };
  await t('cmp: both files must exist, and the tab is titled with their names as they are now', async () => {
    const w = mkOne({ records: { 'ws|1': { id: '1', name: 'renamed.js' }, 'ws|2': { id: '2', name: 'b.js' } } });
    const d = { k: 'cmp', a: { id: '1', name: 'old-name.js', dbName: 'ws' }, b: { id: '2', name: 'b.js', dbName: 'ws' } };
    assert.strictEqual(await w.ctx.restoreOne(d), true);
    assert.deepStrictEqual(plain(w.calls.compareFiles[0]), [{ id: '1', name: 'renamed.js', dbName: 'ws' }, { id: '2', name: 'b.js', dbName: 'ws' }]);
    const gone = mkOne({ records: { 'ws|1': { id: '1', name: 'a.js' } } });
    assert.strictEqual(await gone.ctx.restoreOne(d), false); assert.strictEqual(gone.calls.compareFiles.length, 0);
  });
  await t('saved: needs the file\'s own editor tab (it is the modified side); another file\'s or another workspace\'s tab does not count', async () => {
    const tab = { dataset: { type: 'monaco', fileId: 'f1', dbName: 'ws' } };
    const d = { k: 'saved', fileId: 'f1', name: 'a.js', dbName: 'ws' };
    let w = mkOne({ tabs: [tab] }); assert.strictEqual(await w.ctx.restoreOne(d), true); assert.strictEqual(w.calls.compareWithSaved[0], tab);
    w = mkOne({ tabs: [{ dataset: { fileId: 'f2', dbName: 'ws' } }] }); assert.strictEqual(await w.ctx.restoreOne(d), false);
    w = mkOne({ tabs: [{ dataset: { fileId: 'f1', dbName: 'other' } }] }); assert.strictEqual(await w.ctx.restoreOne(d), false);
    w = mkOne({ tabs: [] }); assert.strictEqual(await w.ctx.restoreOne(d), false); assert.strictEqual(w.calls.compareWithSaved.length, 0);
  });
  await t('git and history kinds go to their own module, and without it nothing opens', async () => {
    const seen = [];
    const W = { gitRestoreDiffTab: async (d) => { seen.push(['git', d.k]); return true; }, CodeMiniHistory: { restoreDiff: async (d) => { seen.push(['hist', d.k]); return false; } } };
    const w = mkOne({ W });
    assert.strictEqual(await w.ctx.restoreOne({ k: 'git-work', dbName: 'ws', path: '/a' }), true);
    assert.strictEqual(await w.ctx.restoreOne({ k: 'git-commit', dbName: 'ws', sha: 's', path: '/a' }), true);
    assert.strictEqual(await w.ctx.restoreOne({ k: 'hist', dbName: 'ws', fileId: 'f', name: 'a', a: 'e', b: 'current' }), false);
    assert.deepStrictEqual(seen, [['git', 'git-work'], ['git', 'git-commit'], ['hist', 'hist']]);
    const bare = mkOne({});
    assert.strictEqual(await bare.ctx.restoreOne({ k: 'git-work', dbName: 'ws', path: '/a' }), false);
    assert.strictEqual(await bare.ctx.restoreOne({ k: 'hist', dbName: 'ws', fileId: 'f', name: 'a', a: 'e', b: 'current' }), false);
  });
  await t('a descriptor that fails the gate opens nothing, whatever it says', async () => {
    const W = { gitRestoreDiffTab: async () => { throw new Error('must not be called'); } };
    const w = mkOne({ W });
    for (const bad of [null, { k: 'git-work' }, { k: 'eval', code: 'x' }, 'git-work']) assert.strictEqual(await w.ctx.restoreOne(bad), false);
    assert.strictEqual(w.calls.compareFiles.length + w.calls.compareWithSaved.length, 0);
  });

  console.log('restoreTabs: right group, nothing takes over the screen');
  function world() {
    const groups = {}, tabs = [], log = { switched: [], registry: 0 };
    const mkGroup = (id) => {
      const g = { id, bar: null, panes: null };
      g.bar = { insertBefore: (tab) => { tab.group = g; } }; g.panes = { appendChild: () => {} };
      g.querySelector = (sel) => (sel === '.tab.active' ? tabs.find((x) => x.group === g && x.active) || null : sel === '.tabs-bar' ? g.bar : sel === '.panes-container' ? g.panes : null);
      return (groups[id] = g);
    };
    mkGroup('editorGroup1'); mkGroup('editorGroup2');
    const mkTab = (type, group, active, target) => {
      const tab = { dataset: { type, target }, group, active, isConnected: true, classList: { contains: (c) => c === 'active' && tab.active }, closest: (sel) => (sel === '.editor-group' ? tab.group : null) };
      tabs.push(tab); return tab;
    };
    let activeGroup = 'editorGroup1';
    const W = { switchTab: (target) => { const tab = tabs.find((x) => x.dataset.target === target); tabs.filter((x) => x.group === tab.group).forEach((x) => { x.active = false; }); tab.active = true; log.switched.push(target); } };
    const document = {
      querySelectorAll: (sel) => (sel === '.editor-group' ? Object.values(groups) : sel === '.tab[data-type="diff"]' ? tabs.filter((x) => x.dataset.type === 'diff') : []),
      getElementById: (id) => groups[id] || (tabs.find((x) => x.dataset.target === id) ? { id } : null),
    };
    // opening a diff tab the way createNewTab does: it lands in the ACTIVE group and becomes the active tab there
    const openDiff = (target) => { tabs.filter((x) => x.group === groups[activeGroup]).forEach((x) => { x.active = false; }); mkTab('diff', groups[activeGroup], true, target); };
    return { groups, tabs, log, W, document, mkTab, openDiff, setActiveGroup: (g) => { activeGroup = g; } };
  }
  const runRestoreTabs = (w, restoreOneImpl) => {
    const ctx = { document: w.document, W: w.W, console: { warn() {} }, updateOpenedTabsRegistry: () => { w.log.registry++; }, restoreOne: restoreOneImpl };
    vm.createContext(ctx); vm.runInContext(grab('de', 'function moveTabToGroup(', 'function activeFileTab('), ctx);
    return ctx.restoreTabs;
  };
  await t('a diff tab goes into the group it was saved from, and the file that group was showing stays showing', async () => {
    const w = world();
    const f1 = w.mkTab('monaco', w.groups.editorGroup1, true, 'pane-f1'), f2 = w.mkTab('monaco', w.groups.editorGroup2, true, 'pane-f2');
    const restoreTabs = runRestoreTabs(w, async () => { w.openDiff('pane-d1'); return true; }); // opens in the active group (1)
    assert.strictEqual(await restoreTabs([{ groupId: 'editorGroup2', restore: {} }]), 1);
    const d = w.tabs.find((x) => x.dataset.type === 'diff');
    assert.strictEqual(d.group, w.groups.editorGroup2, 'moved to the group it came from');
    assert.strictEqual(f2.active, true, 'group 2 shows its file again'); assert.strictEqual(f1.active, true, 'group 1 was never disturbed');
    assert.strictEqual(w.log.registry, 1, 'the saved session is updated once, at the end');
  });
  await t('a diff tab that opens in the right group still does not take over', async () => {
    const w = world(); const f1 = w.mkTab('monaco', w.groups.editorGroup1, true, 'pane-f1');
    const restoreTabs = runRestoreTabs(w, async () => { w.openDiff('pane-d1'); return true; });
    await restoreTabs([{ groupId: 'editorGroup1', restore: {} }]);
    assert.strictEqual(f1.active, true); assert.deepStrictEqual(w.log.switched, ['pane-f1']);
  });
  await t('in a group with nothing in it the restored tab is simply shown', async () => {
    const w = world(); const restoreTabs = runRestoreTabs(w, async () => { w.openDiff('pane-d1'); return true; });
    await restoreTabs([{ groupId: 'editorGroup1', restore: {} }]);
    assert.strictEqual(w.tabs[0].active, true); assert.strictEqual(w.log.switched.length, 0);
  });
  await t('several tabs restore in order, and one that cannot be restored or throws does not stop the rest', async () => {
    const w = world(); w.mkTab('monaco', w.groups.editorGroup1, true, 'pane-f1');
    let i = 0; const restoreTabs = runRestoreTabs(w, async (d) => { if (d.skip) return false; if (d.boom) throw new Error('boom'); w.openDiff('pane-d' + (++i)); return true; });
    const opened = await restoreTabs([{ groupId: 'editorGroup1', restore: { skip: 1 } }, { groupId: 'editorGroup1', restore: {} }, { groupId: 'editorGroup1', restore: { boom: 1 } }, { groupId: 'editorGroup2', restore: {} }]);
    assert.strictEqual(opened, 2);
    assert.deepStrictEqual(w.tabs.filter((x) => x.dataset.type === 'diff').map((x) => [x.dataset.target, x.group.id]), [['pane-d1', 'editorGroup1'], ['pane-d2', 'editorGroup2']]);
  });
  await t('an unknown group leaves the tab where it opened; a bad list is ignored', async () => {
    const w = world(); const restoreTabs = runRestoreTabs(w, async () => { w.openDiff('pane-d1'); return true; });
    assert.strictEqual(await restoreTabs([{ groupId: 'no-such-group', restore: {} }]), 1);
    assert.strictEqual(w.tabs[0].group, w.groups.editorGroup1);
    assert.strictEqual(await restoreTabs(null), 0); assert.strictEqual(await restoreTabs('x'), 0);
  });
  await t('nothing restored means the saved session is not touched again', async () => {
    const w = world(); const restoreTabs = runRestoreTabs(w, async () => false);
    assert.strictEqual(await restoreTabs([{ groupId: 'editorGroup1', restore: {} }]), 0); assert.strictEqual(w.log.registry, 0);
  });

  console.log('Source Control: gitRestoreDiffTab');
  const mkGit = ({ dbName = 'ws', head = {}, working = {}, commits = {}, merge = null, rebase = null } = {}) => {
    const opened = [];
    const ctx = {
      db: { name: dbName }, window: {},
      gitLoadChangeDiff: async (p) => ({ fileId: working[p] || null, inHead: !!head[p] }),
      gitOpenChangeDiff: async (p, tab) => { opened.push(['work', p, tab]); },
      gitOpenCommitFileDiff: (sha, p, tab) => { opened.push(['commit', sha, p, tab]); },
      gitOpenConflictDiff: async (p, tab) => { opened.push(['conflict', p, tab]); },
      getGitRepo: () => ({ objects: commits }), gitGetPendingMerge: () => merge, gitGetPendingRebase: () => rebase,
    };
    vm.createContext(ctx); vm.runInContext(grab('git', 'window.gitRestoreDiffTab = async function', '// --- Staging & committing'), ctx);
    return { fn: ctx.window.gitRestoreDiffTab, opened };
  };
  await t('working-tree diff: reopened as a tab if the file is in the working tree or in HEAD, skipped if in neither', async () => {
    let g = mkGit({ working: { '/a.js': 'f1' } }); assert.strictEqual(await g.fn({ k: 'git-work', dbName: 'ws', path: '/a.js' }), true); assert.deepStrictEqual(g.opened, [['work', '/a.js', true]]);
    g = mkGit({ head: { '/gone.js': 1 } }); assert.strictEqual(await g.fn({ k: 'git-work', dbName: 'ws', path: '/gone.js' }), true, 'deleted since: the diff still shows what was removed');
    g = mkGit({}); assert.strictEqual(await g.fn({ k: 'git-work', dbName: 'ws', path: '/nowhere.js' }), false); assert.strictEqual(g.opened.length, 0);
  });
  await t('commit diff: only if the commit is still there and touched that file', async () => {
    const commits = { abc: { files: [{ path: '/a.js' }] } };
    let g = mkGit({ commits }); assert.strictEqual(await g.fn({ k: 'git-commit', dbName: 'ws', sha: 'abc', path: '/a.js' }), true); assert.deepStrictEqual(g.opened, [['commit', 'abc', '/a.js', true]]);
    g = mkGit({ commits }); assert.strictEqual(await g.fn({ k: 'git-commit', dbName: 'ws', sha: 'zzz', path: '/a.js' }), false);
    assert.strictEqual(await g.fn({ k: 'git-commit', dbName: 'ws', sha: 'abc', path: '/other.js' }), false); assert.strictEqual(g.opened.length, 0);
  });
  await t('conflict diff: only while that file is still conflicted in a merge or a rebase', async () => {
    let g = mkGit({ merge: { conflictPaths: ['/a.js'] } }); assert.strictEqual(await g.fn({ k: 'git-conflict', dbName: 'ws', path: '/a.js' }), true); assert.deepStrictEqual(g.opened, [['conflict', '/a.js', true]]);
    g = mkGit({ rebase: { conflictPaths: ['/a.js'] } }); assert.strictEqual(await g.fn({ k: 'git-conflict', dbName: 'ws', path: '/a.js' }), true);
    g = mkGit({ merge: { conflictPaths: ['/other.js'] } }); assert.strictEqual(await g.fn({ k: 'git-conflict', dbName: 'ws', path: '/a.js' }), false);
    g = mkGit({}); assert.strictEqual(await g.fn({ k: 'git-conflict', dbName: 'ws', path: '/a.js' }), false); assert.strictEqual(g.opened.length, 0);
  });
  await t('a tab saved from another workspace is not opened in this one', async () => {
    const g = mkGit({ dbName: 'ws', working: { '/a.js': 'f1' } });
    assert.strictEqual(await g.fn({ k: 'git-work', dbName: 'a-different-workspace', path: '/a.js' }), false); assert.strictEqual(g.opened.length, 0);
    assert.strictEqual(await g.fn(null), false);
  });

  console.log('Local History: restoreDiff');
  const mkHist = ({ rows = [], contents = {}, current = { text: 'now', live: false } } = {}) => {
    const opened = [];
    const ctx = {
      W: { CodeMiniDiff: { openStatic: (o) => { opened.push(o); } } },
      history: { list: async () => rows, getContent: async (id) => (id in contents ? contents[id] : null) },
      quiet: (p) => p, currentText: async () => current, fnv1a: (s) => 'h' + s.length, versionLabel: (m) => 'v' + m.id,
    };
    vm.createContext(ctx); vm.runInContext(grab('hist', 'async function restoreDiff(', 'async function diffWithPrevious('), ctx);
    return { fn: ctx.restoreDiff, opened };
  };
  const hd = (b) => ({ k: 'hist', dbName: 'ws', fileId: 'f1', name: 'a.js', a: 'e1', b });
  await t('entry against the current text: reopened with the text as it is now, and still restorable next time', async () => {
    const h = mkHist({ rows: [{ id: 'e1' }], contents: { e1: 'old' }, current: { text: 'now!', live: true } });
    assert.strictEqual(await h.fn(hd('current')), true);
    const o = h.opened[0]; assert.deepStrictEqual([o.original, o.modified, o.modifiedLabel, o.originalLabel, o.key], ['old', 'now!', 'Editor', 've1', 'hist:e1:h4']);
    assert.deepStrictEqual(plain(o.restore), hd('current'));
  });
  await t('entry against another entry: both must still be kept', async () => {
    const h = mkHist({ rows: [{ id: 'e1' }, { id: 'e2' }], contents: { e1: 'one', e2: 'two' } });
    assert.strictEqual(await h.fn(hd('e2')), true); assert.deepStrictEqual([h.opened[0].original, h.opened[0].modified, h.opened[0].key], ['one', 'two', 'hist:e1:e2']);
  });
  await t('a pruned entry (gone from the list, or its text gone) opens nothing', async () => {
    const cases = [
      ['entry no longer listed', mkHist({ rows: [], contents: {} }), 'current'],
      ['entry listed but its text is gone', mkHist({ rows: [{ id: 'e1' }], contents: {} }), 'current'],
      ['the other entry is no longer listed', mkHist({ rows: [{ id: 'e1' }], contents: { e1: 'x' } }), 'e2'],
      ['the other entry\'s text is gone', mkHist({ rows: [{ id: 'e1' }, { id: 'e2' }], contents: { e1: 'x' } }), 'e2'],
      ['the first entry\'s text is gone', mkHist({ rows: [{ id: 'e1' }, { id: 'e2' }], contents: { e2: 'x' } }), 'e2'],
    ];
    for (const [why, h, b] of cases) { assert.strictEqual(await h.fn(hd(b)), false, why); assert.strictEqual(h.opened.length, 0, why); }
  });

  console.log('wired up: saved with the tabs, rebuilt at startup');
  await t('every diff opener leaves a descriptor', () => {
    assert.ok(/restore: \{ k: 'cmp', a: \{ id: a\.id/.test(files.de), 'compare files');
    assert.ok(/restore: \{ k: 'saved', fileId, name, dbName/.test(files.de), 'compare with saved');
    assert.ok(/restore: \{ k: 'git-work', dbName, path \}/.test(files.git), 'working tree');
    assert.ok(/restore: \{ k: 'git-commit', dbName, sha: commitSha, path \}/.test(files.git), 'commit');
    assert.ok(/restore: \{ k: 'git-conflict', dbName, path \}/.test(files.git), 'conflict');
    assert.strictEqual((files.hist.match(/restore: \{ k: 'hist'/g) || []).length, 2, 'both history diffs');
    assert.ok(/restore: meta\.restore \}\);\n/.test(files.git) && /encoding, restore: meta\.restore/.test(files.git), 'git hands it on to both tab openers');
    assert.ok(/restore: o\.restore/.test(files.de), 'the diff module hands it on');
  });
  await t('the tab keeps its descriptor and the session is saved again once the tab has it', () => {
    const open = grab('de', 'function open(opts) {', '// ---- the ways in ----');
    assert.ok(/tab\.dataset\.diffRestore = JSON\.stringify\(restore\)/.test(open) && /validRestore\(opts\.restore\)/.test(open));
    assert.ok(open.indexOf('tab.dataset.diffRestore') < open.indexOf('updateOpenedTabsRegistry()'), 'saved after the tab has it, not before');
  });
  await t('the saved session carries it, and startup rebuilds diff tabs after every file tab exists', () => {
    assert.ok(/restore: diffRestoreOf\(t\)/.test(files.ed) && /function diffRestoreOf\(tab\)/.test(files.ed));
    assert.ok(/t\.type === 'diff'/.test(files.app) && /diffTabsToRestore\.push\(\{ groupId: t\.groupId, restore: t\.restore \}\)/.test(files.app));
    const a = files.app; assert.ok(a.indexOf('tabsToRestore.forEach') < a.indexOf('CodeMiniDiff.restoreTabs(diffTabsToRestore)'), 'after the loop that restores file tabs');
    assert.ok(a.indexOf('CodeMiniDiff.restoreTabs(diffTabsToRestore)') < a.indexOf("// Revert to original active group"));
  });
  await t('Local History exposes restoreDiff', () => { assert.ok(/activeTab, restoreDiff\n/.test(files.hist)); });
  console.log(`\n${n} diff-restore checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
