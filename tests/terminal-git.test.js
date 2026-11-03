// The terminal's `git` command (js/terminal/terminal-git.js), run for real against the real js/git/git.js, with an
// in-memory stand-in for IndexedDB (no browser). What matters most here is that the terminal and the Source Control
// panel really share one repository, that nothing is lost silently (switching branches, resetting, merging), and
// that the output is what a git user expects.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const nodeCrypto = require('crypto');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };

// ---- a small IndexedDB: the 'filesystem' and 'gitobjects' stores, getAll / put / delete -------------------------
function makeDb(name) {
  const stores = { filesystem: new Map(), gitobjects: new Map() }, keyPath = { filesystem: 'id', gitobjects: 'sha' };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  return {
    name, stores, closed: 0, close() { this.closed++; },
    transaction(storeName) {
      const store = stores[storeName]; if (!store) throw new Error('NotFoundError: ' + storeName);
      const tx = {}; let pending = 0, done = false;
      const settle = () => setImmediate(() => { if (!pending && !done) { done = true; if (tx.oncomplete) tx.oncomplete(); } });
      const later = (fn) => { pending++; setImmediate(() => { fn(); pending--; settle(); }); };
      tx.objectStore = () => ({
        getAll() { const r = {}; later(() => { r.result = [...store.values()].map(clone); if (r.onsuccess) r.onsuccess({ target: r }); }); return r; },
        put(v) { store.set(v[keyPath[storeName]], clone(v)); later(() => {}); return {}; },
        delete(id) { store.delete(id); later(() => {}); return {}; }
      });
      settle();
      return tx;
    }
  };
}

// ---- the code under test, loaded whole -----------------------------------------------------------------------
function world({ dbName = 'CodeMiniDB', rootId = 'root' } = {}) {
  const ls = new Map();
  const localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), get length() { return ls.size; }, key: (i) => [...ls.keys()][i] };
  const win = { addEventListener() {}, removeEventListener() {} };
  const ctx = vm.createContext({ window: win, localStorage, document: { getElementById: () => null, addEventListener() {}, querySelector: () => null }, crypto: nodeCrypto.webcrypto, TextEncoder, console, setTimeout, setImmediate, Date, JSON, Math, Set, Map, Object, Array, Uint32Array, RegExp, Error, Promise, String, Number, parseInt });
  win.window = win; Object.assign(win, { localStorage });
  vm.runInContext(read('js/core/html-escape.js'), ctx);
  vm.runInContext(read('js/git/git.js'), ctx);
  vm.runInContext(read('js/terminal/terminal-git.js'), ctx);
  const db = makeDb(dbName);
  ctx.db = db; // the Explorer's open database, which the panel's own saves flush commit objects to
  let seq = 0; const nid = () => 'id' + (++seq);
  const W = { ctx, db, localStorage, rootId, changed: 0, calls: 0 };
  const records = () => [...db.stores.filesystem.values()];
  const folderId = (parts) => { let parent = rootId; for (const p of parts) { let f = records().find((r) => r.parentId === parent && r.name === p && r.type === 'folder'); if (!f) { f = { id: nid(), parentId: parent, name: p, type: 'folder' }; db.stores.filesystem.set(f.id, f); } parent = f.id; } return parent; };
  W.write = (p, content, extra) => { const parts = p.split('/').filter(Boolean), name = parts.pop(); const parentId = folderId(parts); const ex = records().find((r) => r.parentId === parentId && r.name === name && r.type === 'file'); const rec = Object.assign(ex || { id: nid(), parentId, name, type: 'file' }, { content, encoding: 'text' }, extra || {}); db.stores.filesystem.set(rec.id, rec); };
  W.remove = (p) => { const tree = vm.runInContext('gitGetWorkingTree', ctx); return tree(db).then((m) => { const f = m.get(p); db.stores.filesystem.delete(f.id); }); };
  W.tree = async () => { const m = await vm.runInContext('gitGetWorkingTree', ctx)(db); const o = {}; m.forEach((v, k) => { o[k] = v.content; }); return o; };
  W.files = async () => Object.keys(await W.tree()).sort();
  W.folders = () => records().filter((r) => r.type === 'folder').map((r) => r.name).sort();
  // run a command line like the terminal would (quotes group words)
  W.git = async (line, cwd = []) => {
    const args = []; line.replace(/"([^"]*)"|'([^']*)'|(\S+)/g, (m, a, b, c) => { args.push(a !== undefined ? a : b !== undefined ? b : c); });
    const html = [];
    W.calls++;
    await win.CodeMiniGitCli.run(args, {
      rootId, cwd, printHtml: (h) => html.push(h),
      withDb: async (fn) => fn(db),
      onChanged: () => { W.changed++; }
    });
    const raw = html.join('\n');
    const text = raw.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    return { text, html: raw, lines: text.split('\n') };
  };
  W.run = vm.runInContext;
  return W;
}
const has = (r, s, m) => assert.ok(r.text.includes(s), `${m || ''}\n--- expected to contain: ${s}\n--- got:\n${r.text}`);
const hasNot = (r, s, m) => assert.ok(!r.text.includes(s), `${m || ''}\n--- expected NOT to contain: ${s}\n--- got:\n${r.text}`);
const deq = (a, b, m) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);

// a repo with one commit on main: a.txt, src/b.js
async function seeded() {
  const W = world();
  W.write('/a.txt', 'one\ntwo\nthree\n'); W.write('/src/b.js', 'let b = 1;\n');
  await W.git('add -A'); await W.git('commit -m "first"');
  return W;
}

(async () => {
  console.log('terminal git');

  await t('the Explorer/panel are told to redraw after a change, and only then', async () => {
    const W = await seeded(); const base = W.changed;
    for (const c of ['status', 'log', 'diff', 'branch', 'show', 'stash list', 'tag', 'reflog', 'remote -v', 'config --list', 'add nothere.txt', 'switch nowhere', 'commit -m x']) await W.git(c);
    assert.strictEqual(W.changed, base, 'read-only commands and failures must not trigger a redraw');
    W.write('/n.txt', 'n'); await W.git('add n.txt'); assert.strictEqual(W.changed, base + 1);
    await W.git('commit -m n'); assert.strictEqual(W.changed, base + 2);
    await W.git('branch other'); assert.strictEqual(W.changed, base + 3);
  });

  await t('help lists the commands, and push/pull point at the panel instead of failing oddly', async () => {
    const W = world();
    const h = await W.git('help'); has(h, 'git <command>'); has(h, 'commit -m'); has(h, 'Source Control panel');
    has(await W.git(''), 'usage: git');
    has(await W.git('push'), 'not available in the terminal'); has(await W.git('push'), 'Source Control > Remote');
    has(await W.git('frobnicate'), "fatal: 'frobnicate' is not a git command");
    has(await W.git('init'), 'already a Git repository');
    assert.strictEqual(W.calls > 0, true);
  });

  await t('status → add → commit → log → clean, with the usual wording', async () => {
    const W = world();
    let r = await W.git('status'); has(r, 'On branch main'); has(r, 'No commits yet'); has(r, 'nothing to commit');
    W.write('/a.txt', 'hello\n');
    r = await W.git('status'); has(r, 'Untracked files'); has(r, 'a.txt'); has(r, 'nothing added to commit but untracked files present');
    assert.strictEqual((await W.git('add a.txt')).text, ''); assert.ok(W.changed >= 1);
    r = await W.git('status'); has(r, 'Changes to be committed'); has(r, 'new file:   a.txt');
    r = await W.git('commit -m "first commit"'); has(r, '[main (root-commit) '); has(r, '] first commit'); has(r, '1 file changed'); has(r, 'create mode 100644 a.txt');
    has(await W.git('status'), 'nothing to commit, working tree clean');
    r = await W.git('log'); has(r, 'commit '); has(r, '(HEAD -> main)'); has(r, 'Author: '); has(r, '    first commit');
    r = await W.git('log --oneline'); assert.match(r.lines[0], /^[0-9a-f]{7} \(HEAD -> main\) first commit$/);
  });

  await t('status -s and -b use the short letters', async () => {
    const W = await seeded();
    W.write('/a.txt', 'changed\n'); W.write('/new.txt', 'n'); await W.remove('/src/b.js');
    await W.git('add new.txt');
    const r = await W.git('status -s -b');
    deq(r.lines, ['## main', 'A  new.txt', ' M a.txt', ' D src/b.js']);
  });

  await t('commit refuses an empty message and an empty stage, -a stages tracked files only, --amend keeps or replaces the message', async () => {
    const W = await seeded();
    W.write('/a.txt', 'two\n'); W.write('/untracked.txt', 'u');
    has(await W.git('commit'), 'no changes added to commit');
    await W.git('add a.txt');
    has(await W.git('commit'), 'Aborting commit due to empty commit message');
    has(await W.git('commit -a -m "tracked only"'), '] tracked only');
    let tree = await W.git('show --name-only'); has(tree, 'a.txt'); hasNot(tree, 'untracked.txt');
    has(await W.git('status -s'), '?? untracked.txt');
    W.write('/a.txt', 'three\n'); await W.git('add a.txt');
    const before = (await W.git('rev-parse HEAD')).text.trim();
    let r = await W.git('commit --amend'); has(r, '] tracked only');
    assert.notStrictEqual((await W.git('rev-parse HEAD')).text.trim(), before);
    r = await W.git('commit --amend -m "renamed"'); has(r, '] renamed');
    has(await W.git('log --oneline -n 1'), 'renamed');
    assert.strictEqual((await W.git('log --oneline')).lines.filter(Boolean).length, 2, 'amend must not add a commit');
    has(await W.git('commit -a'), 'nothing added to commit but untracked files present');
  });

  await t('paths are relative to the current folder; unknown paths and ignored files are handled like git', async () => {
    const W = await seeded();
    W.write('/src/c.js', 'c'); W.write('/top.txt', 't');
    await W.git('add .', ['src']);
    let r = await W.git('status -s', ['src']); has(r, 'A  c.js'); has(r, '?? ../top.txt');
    r = await W.git('add nope.txt'); has(r, "fatal: pathspec 'nope.txt' did not match any files");
    r = await W.git('add ../top.txt', ['src']); assert.strictEqual(r.text, '');
    has(await W.git('status -s'), 'A  top.txt');
    r = await W.git('add ../../x', ['src']); has(r, 'outside the repository');
    // .gitignore
    W.write('/.gitignore', '*.log\nnode_modules/\n'); W.write('/debug.log', 'x'); W.write('/node_modules/p/i.js', 'x');
    await W.git('add .gitignore');
    r = await W.git('status -s'); hasNot(r, 'debug.log'); hasNot(r, 'node_modules');
    r = await W.git('add debug.log'); has(r, 'ignored by one of your .gitignore files'); has(r, 'git add -f');
    assert.strictEqual((await W.git('add .')).text, ''); hasNot(await W.git('status -s'), 'debug.log');
    await W.git('add -f debug.log'); has(await W.git('status -s'), 'A  debug.log');
  });

  await t('add -u / -A, and git add * style patterns', async () => {
    const W = await seeded();
    W.write('/a.txt', 'z\n'); W.write('/x1.md', '1'); W.write('/x2.md', '2');
    await W.git('add -u'); let r = await W.git('status -s'); has(r, 'M  a.txt'); has(r, '?? x1.md');
    await W.git('add *.md'); r = await W.git('status -s'); has(r, 'A  x1.md'); has(r, 'A  x2.md');
  });

  await t('diff: unstaged, --staged, against a commit, --stat, context hunks, no-newline marker, binary', async () => {
    const W = await seeded();
    const lines = Array.from({ length: 20 }, (_, i) => 'line' + (i + 1)).join('\n') + '\n';
    W.write('/long.txt', lines); await W.git('add long.txt'); await W.git('commit -m long');
    W.write('/long.txt', lines.replace('line10\n', 'LINE10\n')); W.write('/a.txt', 'one\ntwo\nthree');
    let r = await W.git('diff');
    has(r, 'diff --git a/long.txt b/long.txt'); has(r, '--- a/long.txt'); has(r, '+++ b/long.txt');
    has(r, '@@ -7,7 +7,7 @@'); has(r, '-line10'); has(r, '+LINE10'); has(r, ' line7'); hasNot(r, ' line6'); hasNot(r, ' line14');
    has(r, '-three'); has(r, '+three'); has(r, '\\ No newline at end of file');
    await W.git('add long.txt');
    r = await W.git('diff'); hasNot(r, 'long.txt'); has(r, 'a.txt');
    r = await W.git('diff --staged'); has(r, 'long.txt'); hasNot(r, 'a.txt');
    r = await W.git('diff --stat HEAD'); has(r, 'long.txt'); has(r, '2 files changed, 2 insertions(+), 2 deletions(-)');
    r = await W.git('diff --name-status HEAD'); has(r, 'M\tlong.txt'); has(r, 'M\ta.txt');
    r = await W.git('diff -- a.txt'); has(r, 'a.txt'); hasNot(r, 'long.txt');
    W.write('/img.png', 'AAAA', { encoding: 'base64' }); await W.git('add img.png');
    r = await W.git('diff --staged'); has(r, 'Binary files /dev/null and b/img.png differ');
    W.write('/new.txt', 'brand new\n'); await W.git('add new.txt');
    r = await W.git('diff --staged -- new.txt'); has(r, 'new file mode'); has(r, '@@ -0,0 +1 @@'); has(r, '+brand new');
    await W.remove('/src/b.js'); r = await W.git('diff'); has(r, 'deleted file mode'); has(r, '@@ -1 +0,0 @@'); has(r, '-let b = 1;');
  });

  await t('log: decorations, -n and -N, --author, --grep, a path filter, --graph, --all', async () => {
    const W = await seeded();
    W.write('/a.txt', 'v2\n'); await W.git('commit -am "second thing"');
    W.write('/src/b.js', 'v3\n'); await W.git('commit -am "third thing"');
    await W.git('tag v1 HEAD~2'); await W.git('branch dev HEAD~1');
    let r = await W.git('log --oneline'); assert.strictEqual(r.lines.filter(Boolean).length, 3);
    has(r, '(HEAD -> main)'); has(r, '(dev)'); has(r, '(tag: v1)');
    assert.strictEqual((await W.git('log --oneline -n 2')).lines.filter(Boolean).length, 2);
    assert.strictEqual((await W.git('log --oneline -1')).lines.filter(Boolean).length, 1);
    r = await W.git('log --oneline --grep=second'); assert.strictEqual(r.lines.filter(Boolean).length, 1); has(r, 'second thing');
    r = await W.git('log --oneline -- src'); assert.strictEqual(r.lines.filter(Boolean).length, 2);
    assert.strictEqual((await W.git('log --oneline --author=nobody')).text, '');
    r = await W.git('log --oneline --graph'); assert.ok(r.lines.every((l) => /^\* /.test(l)), r.text);
    r = await W.git('log --oneline dev'); assert.strictEqual(r.lines.filter(Boolean).length, 2);
    has(await W.git('log --oneline nonexistent'), "fatal: bad revision 'nonexistent'");
    has(await world().git('log'), "does not have any commits yet");
    r = await W.git('log --all --oneline'); assert.strictEqual(r.lines.filter(Boolean).length, 3);
  });

  await t('show prints the message and the changes; revisions accept HEAD~N, ^, a tag, a short id', async () => {
    const W = await seeded();
    W.write('/a.txt', 'one\nTWO\nthree\n'); await W.git('commit -am "edit two"');
    let r = await W.git('show'); has(r, 'edit two'); has(r, '-two'); has(r, '+TWO');
    r = await W.git('show HEAD~1 --stat'); has(r, 'first'); has(r, 'a.txt'); has(r, 'src/b.js');
    r = await W.git('show HEAD^ --name-only'); has(r, 'src/b.js');
    const full = (await W.git('rev-parse HEAD~1')).text.trim(); assert.match(full, /^[0-9a-f]{40}$/);
    has(await W.git(`show ${full.slice(0, 6)} -s`), 'first');
    assert.strictEqual((await W.git('rev-parse --short HEAD')).text.trim().length, 7);
    assert.strictEqual((await W.git('rev-parse --abbrev-ref HEAD')).text.trim(), 'main');
    has(await W.git('show HEAD~5'), "fatal: bad revision 'HEAD~5'");
  });

  await t('branch: create, list, verbose, rename, delete (merged / not merged / current)', async () => {
    const W = await seeded();
    assert.strictEqual((await W.git('branch')).text.trim(), '* main');
    assert.strictEqual((await W.git('branch --show-current')).text.trim(), 'main');
    assert.strictEqual((await W.git('branch dev')).text, '');
    let r = await W.git('branch'); has(r, '* main'); has(r, '  dev');
    has(await W.git('branch dev'), "fatal: a branch named 'dev' already exists");
    has(await W.git('branch bad..name'), 'cannot contain');
    has(await W.git('branch -v'), 'first');
    assert.strictEqual((await W.git('branch -m dev develop')).text, ''); has(await W.git('branch'), 'develop'); hasNot(await W.git('branch'), '  dev\n');
    assert.strictEqual((await W.git('branch -m main')).text, '', 'renaming a branch to its own name is a no-op');
    has(await W.git('branch -d main'), 'because it is the one you are on');
    has(await W.git('branch -d ghost'), "branch 'ghost' not found");
    has(await W.git('branch -d develop'), 'Deleted branch develop');
    // unmerged
    await W.git('switch -c feat'); W.write('/f.txt', 'f'); await W.git('add f.txt'); await W.git('commit -m "on feat"'); await W.git('switch main');
    r = await W.git('branch -d feat'); has(r, 'not fully merged'); has(r, 'git branch -D feat'); has(await W.git('branch'), 'feat');
    has(await W.git('branch -D feat'), 'Deleted branch feat');
    const emptyRepo = world(); has(await emptyRepo.git('branch newone'), 'not a valid object name');
  });

  await t('switching: carries nothing away silently, -f discards, checkout -b keeps work, files follow the branch', async () => {
    const W = await seeded();
    await W.git('switch -c feat'); W.write('/f.txt', 'only on feat'); await W.git('add f.txt'); await W.git('commit -m feat1');
    W.write('/a.txt', 'dirty\n');
    let r = await W.git('switch main'); has(r, 'fatal: your local changes would be lost by the checkout'); has(r, 'a.txt'); has(r, 'git stash');
    assert.strictEqual((await W.tree())['/a.txt'], 'dirty\n', 'refusal must not touch files');
    assert.strictEqual((await W.git('branch --show-current')).text.trim(), 'feat');
    has(await W.git('checkout -f main'), "Switched to branch 'main'");
    assert.strictEqual((await W.tree())['/a.txt'], 'one\ntwo\nthree\n'); assert.ok(!(await W.files()).includes('/f.txt'));
    await W.git('switch feat'); assert.ok((await W.files()).includes('/f.txt'));
    has(await W.git('switch feat'), "Already on 'feat'");
    // checkout -b from a dirty tree keeps the changes and the staging
    W.write('/a.txt', 'carried\n'); await W.git('add a.txt');
    r = await W.git('checkout -b topic'); has(r, "Switched to a new branch 'topic'");
    assert.strictEqual((await W.tree())['/a.txt'], 'carried\n'); has(await W.git('status -s'), 'M  a.txt');
    has(await W.git('switch nowhere'), 'invalid reference: nowhere');
    await W.git('tag rel'); has(await W.git('switch rel'), 'no detached HEAD');
    has(await W.git('checkout -b topic'), "a branch named 'topic' already exists");
    // untracked files block a switch too (they would be removed), but ignored ones are left alone
    await W.git('commit -m carried'); W.write('/loose.txt', 'x');
    has(await W.git('switch main'), 'loose.txt');
    await W.remove('/loose.txt');
    W.write('/.gitignore', '*.log\n'); await W.git('add .gitignore'); await W.git('commit -m ign'); W.write('/keep.log', 'precious');
    await W.git('switch main'); assert.strictEqual((await W.tree())['/keep.log'], 'precious', 'an ignored file must survive a branch switch');
    assert.ok(!(await W.files()).includes('/.gitignore'));
  });

  await t('restore and checkout -- <path>: discard, unstage, from another commit; never touches untracked files', async () => {
    const W = await seeded();
    W.write('/a.txt', 'oops\n'); await W.git('add a.txt'); W.write('/new.txt', 'n');
    await W.git('restore --staged a.txt'); has(await W.git('status -s'), ' M a.txt');
    await W.git('restore a.txt'); assert.strictEqual((await W.tree())['/a.txt'], 'one\ntwo\nthree\n'); hasNot(await W.git('status -s'), 'a.txt');
    has(await W.git('restore new.txt'), "did not match any file(s) known to git"); assert.ok((await W.files()).includes('/new.txt'));
    await W.remove('/a.txt'); await W.git('restore a.txt'); assert.ok((await W.files()).includes('/a.txt'));
    W.write('/a.txt', 'v2\n'); await W.git('commit -am v2'); W.write('/a.txt', 'junk');
    await W.git('restore --source=HEAD~1 a.txt'); assert.strictEqual((await W.tree())['/a.txt'], 'one\ntwo\nthree\n');
    W.write('/a.txt', 'again'); await W.git('checkout -- a.txt'); assert.strictEqual((await W.tree())['/a.txt'], 'v2\n');
    W.write('/src/b.js', 'x'); W.write('/a.txt', 'y'); await W.git('restore .'); assert.strictEqual((await W.tree())['/src/b.js'], 'let b = 1;\n'); assert.strictEqual((await W.tree())['/a.txt'], 'v2\n');
    has(await W.git('restore'), 'you must specify path(s) to restore');
  });

  await t('reset: plain unstages, --soft keeps the undone work staged, --mixed unstages it, --hard rewinds files but spares untracked ones', async () => {
    const W = await seeded();
    W.write('/a.txt', 'v2\n'); await W.git('commit -am v2'); W.write('/b2.txt', 'b2'); await W.git('add b2.txt'); await W.git('commit -m v3');
    W.write('/a.txt', 'wip'); await W.git('add a.txt'); await W.git('reset'); has(await W.git('status -s'), ' M a.txt'); await W.git('restore a.txt');
    await W.git('reset --soft HEAD~1'); has(await W.git('status -s'), 'A  b2.txt'); assert.ok((await W.files()).includes('/b2.txt'));
    await W.git('commit -m v3again');
    await W.git('reset HEAD~1'); has(await W.git('status -s'), '?? b2.txt'); assert.ok((await W.files()).includes('/b2.txt'));
    W.write('/loose.txt', 'keep me'); W.write('/a.txt', 'garbage');
    let r = await W.git('reset --hard HEAD~1'); has(r, 'HEAD is now at '); has(r, 'first');
    assert.strictEqual((await W.tree())['/a.txt'], 'one\ntwo\nthree\n'); assert.strictEqual((await W.tree())['/loose.txt'], 'keep me');
    r = await W.git('reflog'); has(r, 'Reset (hard)'); has(r, 'main@{0}');
    has(await W.git('reset --hard nope'), "bad revision 'nope'");
    await W.git('add a.txt'); await W.git('reset a.txt'); hasNot(await W.git('status -s'), 'A  a.txt');
  });

  await t('merge: up to date, fast-forward, a real merge commit with two parents, a custom message', async () => {
    const W = await seeded();
    has(await W.git('merge main'), 'Already up to date.');
    await W.git('switch -c feat'); W.write('/f.txt', 'f\n'); await W.git('add f.txt'); await W.git('commit -m "feat work"');
    await W.git('switch main');
    let r = await W.git('merge feat'); has(r, 'Fast-forward'); has(r, 'f.txt'); assert.ok((await W.files()).includes('/f.txt'));
    has(await W.git('merge feat'), 'Already up to date.');
    await W.git('switch feat'); W.write('/g.txt', 'g\n'); await W.git('add g.txt'); await W.git('commit -m "more feat"');
    await W.git('switch main'); W.write('/m.txt', 'm\n'); await W.git('add m.txt'); await W.git('commit -m "main work"');
    r = await W.git('merge feat -m "joined"'); has(r, "Merge made by the 'ort' strategy"); has(r, 'g.txt');
    const files = await W.files(); assert.ok(files.includes('/g.txt') && files.includes('/m.txt'));
    r = await W.git('log -n 1'); has(r, 'Merge: '); has(r, '    joined');
    const repo = W.run('getGitRepo', W.ctx)(W.db.name); const tip = repo.refs.main; assert.strictEqual(repo.objects[tip].parents.length, 2);
    has(await W.git('merge nope'), "'nope' is not a branch");
    W.write('/dirty.txt', 'd'); await W.git('switch -c other'); // untracked file carried by checkout -b
    has(await W.git('merge main'), 'Already up to date.');
  });

  await t('merge conflicts: markers in the file, unmerged status, commit refused until fixed, then a two-parent commit; --abort, --ours, --theirs', async () => {
    const W = await seeded();
    await W.git('switch -c feat'); W.write('/a.txt', 'one\nFEAT\nthree\n'); await W.git('commit -am "feat edit"');
    await W.git('switch main'); W.write('/a.txt', 'one\nMAIN\nthree\n'); await W.git('commit -am "main edit"');
    let r = await W.git('merge feat'); has(r, 'CONFLICT (content): Merge conflict in a.txt'); has(r, 'Automatic merge failed');
    const content = (await W.tree())['/a.txt']; assert.ok(content.includes('<<<<<<< main') && content.includes('>>>>>>> feat') && content.includes('MAIN') && content.includes('FEAT'));
    const pending = W.run('gitGetPendingMerge', W.ctx)(W.db.name); assert.ok(pending && pending.conflictPaths.includes('/a.txt'), 'the panel must see the same pending merge');
    r = await W.git('status'); has(r, 'You have unmerged paths'); has(r, 'both modified:   a.txt'); has(r, 'git merge --abort');
    has(await W.git('status -s'), 'UU a.txt');
    r = await W.git('commit -m "too soon"'); has(r, 'Committing is not possible because you have unmerged files'); has(r, 'a.txt');
    has(await W.git('merge feat'), 'you have not concluded your merge');
    has(await W.git('switch feat'), 'in the middle of a merge');
    // fix by hand
    W.write('/a.txt', 'one\nBOTH\nthree\n'); await W.git('add a.txt');
    r = await W.git('commit'); has(r, "] Merge branch 'feat' into 'main'");
    assert.strictEqual(W.run('gitGetPendingMerge', W.ctx)(W.db.name), null);
    const repo = W.run('getGitRepo', W.ctx)(W.db.name); assert.strictEqual(repo.objects[repo.refs.main].parents.length, 2);
    assert.strictEqual((await W.tree())['/a.txt'], 'one\nBOTH\nthree\n');
    // abort
    await W.git('reset --hard HEAD~1'); // back to main edit
    await W.git('merge feat'); r = await W.git('merge --abort'); has(r, 'Merge aborted'); assert.strictEqual((await W.tree())['/a.txt'], 'one\nMAIN\nthree\n');
    has(await W.git('merge --abort'), 'there is no merge to abort');
    // --theirs / --ours
    await W.git('merge feat'); has(await W.git('checkout --theirs a.txt'), 'Updated 1 path'); assert.strictEqual((await W.tree())['/a.txt'], 'one\nFEAT\nthree\n');
    await W.git('add a.txt'); has(await W.git('commit -m "took theirs"'), '] took theirs');
    await W.git('reset --hard HEAD~1'); await W.git('merge feat'); await W.git('checkout --ours a.txt'); assert.strictEqual((await W.tree())['/a.txt'], 'one\nMAIN\nthree\n');
    has(await W.git('checkout --ours nothere.txt'), 'not one of the conflicted files');
    await W.git('merge --abort');
    has(await W.git('checkout --ours a.txt'), 'only work while a merge has conflicts');
  });

  await t('merge refuses to run over uncommitted work', async () => {
    const W = await seeded();
    await W.git('switch -c feat'); W.write('/f.txt', 'f'); await W.git('add f.txt'); await W.git('commit -m f'); await W.git('switch main');
    W.write('/a.txt', 'dirty\n');
    const r = await W.git('merge feat'); has(r, 'would be lost by the merge'); assert.strictEqual((await W.tree())['/a.txt'], 'dirty\n'); assert.ok(!(await W.files()).includes('/f.txt'));
  });

  await t('stash: push (with a message), list, pop, apply, drop, clear; refuses to overwrite local changes', async () => {
    const W = await seeded();
    has(await W.git('stash'), 'No local changes to save');
    W.write('/a.txt', 'wip1\n'); W.write('/untracked.txt', 'u');
    let r = await W.git('stash push -m "first wip"'); has(r, 'Saved working directory and index state On main: first wip');
    assert.strictEqual((await W.tree())['/a.txt'], 'one\ntwo\nthree\n'); assert.ok(!(await W.files()).includes('/untracked.txt'));
    W.write('/a.txt', 'wip2\n'); await W.git('stash');
    r = await W.git('stash list'); has(r, 'stash@{0}: WIP on main'); has(r, 'stash@{1}: On main: first wip');
    r = await W.git('stash pop'); has(r, 'Applied and dropped stash@{0}'); assert.strictEqual((await W.tree())['/a.txt'], 'wip2\n');
    r = await W.git('stash pop stash@{0}'); has(r, 'your local changes to these files would be overwritten'); assert.strictEqual((await W.tree())['/a.txt'], 'wip2\n');
    await W.git('restore a.txt'); has(await W.git('stash apply 0'), 'Applied stash@{0}'); assert.strictEqual((await W.tree())['/a.txt'], 'wip1\n');
    assert.strictEqual((await W.git('stash list')).lines.filter(Boolean).length, 1);
    has(await W.git('stash drop'), 'Dropped stash@{0}'); has(await W.git('stash pop'), 'no stash entries found');
    W.write('/a.txt', 'again\n'); await W.git('stash'); await W.git('stash clear'); assert.strictEqual((await W.git('stash list')).text, '');
    has(await W.git('stash bogus'), "unknown stash command 'bogus'");
    // the panel sees the same entries
    W.write('/a.txt', 'panel\n'); await W.git('stash'); assert.strictEqual(W.run('getGitRepo', W.ctx)(W.db.name).stash.length, 1);
  });

  await t('tags: lightweight, annotated (needs a message), duplicates, list with a pattern, delete', async () => {
    const W = await seeded();
    assert.strictEqual((await W.git('tag v1.0')).text, ''); has(await W.git('tag'), 'v1.0');
    has(await W.git('tag v1.0'), "tag 'v1.0' already exists");
    has(await W.git('tag -a v2'), 'no tag message');
    await W.git('tag -a v2.0 -m "release two"'); await W.git('tag -m "implied" v2.1');
    const repo = W.run('getGitRepo', W.ctx)(W.db.name); assert.strictEqual(repo.tags['v2.0'].annotation.message, 'release two'); assert.strictEqual(repo.tags['v1.0'].annotation, null);
    deq((await W.git('tag -l "v2*"')).lines.filter(Boolean), ['v2.0', 'v2.1']);
    has(await W.git('tag bad..name'), 'cannot contain');
    has(await W.git('tag -d v1.0 nope'), "Deleted tag 'v1.0'"); has(await W.git('tag -d nope'), "tag 'nope' not found"); hasNot(await W.git('tag'), 'v1.0');
    has(await world().git('tag x'), 'does not have any commits yet');
  });

  await t('config: who commits are made as, validation, and the author that ends up on commits', async () => {
    const W = world();
    has(await W.git('config --list'), 'user.name='); has(await W.git('config user.email'), '@');
    assert.strictEqual((await W.git('config user.name "Ada Lovelace"')).text, '');
    assert.strictEqual((await W.git('config user.email ada@example.org')).text, '');
    has(await W.git('config user.name'), 'Ada Lovelace');
    has(await W.git('config user.email notanemail'), 'does not look valid'); has(await W.git('config user.name "<x>"'), 'cannot contain');
    has(await W.git('config core.editor vim'), "unsupported key 'core.editor'");
    W.write('/a.txt', 'x'); await W.git('add a.txt'); await W.git('commit -m c');
    const r = await W.git('log'); has(r, 'Author: Ada Lovelace <ada@example.org>');
    const cfg = W.run('getGitConfig', W.ctx)(W.db.name); assert.strictEqual(cfg.identitySource, 'custom'); // the same setting the panel's Config tab uses
  });

  await t('remote -v shows what is chosen in the panel; nothing when nothing is', async () => {
    const W = world();
    assert.strictEqual((await W.git('remote -v')).text, '');
    W.localStorage.setItem(`codemini_git_remoteRepo_${W.db.name}`, 'octo/cat');
    has(await W.git('remote'), 'origin'); has(await W.git('remote -v'), 'origin\thttps://github.com/octo/cat.git (push)');
    has(await W.git('remote add x y'), 'not supported here');
  });

  await t('terminal and panel share one repository, in both directions, and commit objects reach IndexedDB', async () => {
    const W = await seeded();
    const repo = W.run('getGitRepo', W.ctx)(W.db.name);
    assert.strictEqual(Object.keys(repo.objects).length, 1);
    assert.strictEqual(W.db.stores.gitobjects.size, 1, 'the commit must be flushed to this database, not only kept in memory');
    // the panel's own primitives make a commit; the terminal's log sees it
    const cfg = W.run('getGitConfig', W.ctx)(W.db.name);
    W.write('/p.txt', 'panel'); const wt = await W.run('gitGetWorkingTree', W.ctx)(W.db);
    const sha = await W.run('gitCreateCommitObject', W.ctx)(repo, 'made in the panel', [repo.refs[cfg.currentBranch]], [{ path: '/p.txt', name: 'p.txt', status: 'added', content: 'panel', encoding: 'text' }], { author: 'p', authorEmail: 'p@x' });
    W.run('gitMoveRef', W.ctx)(W.db.name, repo, cfg.currentBranch, sha, 'test'); W.run('saveGitRepo', W.ctx)(W.db.name, repo);
    has(await W.git('log --oneline'), 'made in the panel'); has(await W.git('status'), 'nothing to commit');
    // staging made in the terminal is what the panel reads
    W.write('/q.txt', 'q'); await W.git('add q.txt'); deq(W.run('getStagedPaths', W.ctx)(W.db.name), ['/q.txt']);
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); // the panel flushes without waiting
    // a fresh page load: the in-memory cache is empty, history must come back from IndexedDB
    W.run('gitObjectCache', W.ctx).delete(W.db.name); W.run('gitObjectCacheKnownShas', W.ctx).delete(W.db.name);
    const r = await W.git('log --oneline'); assert.strictEqual(r.lines.filter(Boolean).length, 2, r.text);
    // the commit log of Source Control records terminal actions too
    assert.ok(W.run('gitGetLog', W.ctx)(W.db.name).some((e) => e.action === 'commit' && /terminal/.test(e.message)));
  });

  await t('a workspace database: files are created under the workspace root id, and its Explorer-independent root is respected', async () => {
    const W = world({ dbName: 'CodeMiniDB_WS_7', rootId: 'ws7' });
    W.write('/docs/readme.md', 'r1\n'); W.write('/top.txt', 't');
    await W.git('add -A'); await W.git('commit -m base');
    await W.git('switch -c b2'); await W.remove('/docs/readme.md'); W.write('/deep/er/new.txt', 'n'); await W.git('add -A'); await W.git('commit -m b2');
    await W.git('switch main');
    const recs = [...W.db.stores.filesystem.values()];
    const readme = recs.find((r) => r.name === 'readme.md'); assert.ok(readme, 'file restored by the switch');
    const docs = recs.find((r) => r.id === readme.parentId); assert.strictEqual(docs.name, 'docs'); assert.strictEqual(docs.parentId, 'ws7');
    await W.git('switch b2');
    const deeper = [...W.db.stores.filesystem.values()].find((r) => r.name === 'deep'); assert.strictEqual(deeper.parentId, 'ws7', 'new folders hang off the workspace root, not off "root"');
    assert.ok(![...W.db.stores.filesystem.values()].some((r) => r.parentId === 'root'));
    assert.ok(!W.folders().includes('docs'), 'a folder that became empty is removed, as the panel does');
  });

  await t('output is HTML-escaped: a hostile file name or commit message cannot inject markup', async () => {
    const W = world();
    W.write('/<img src=x onerror=alert(1)>.txt', 'x');
    let r = await W.git('status'); assert.ok(!/<img/.test(r.html), r.html); has(r, '<img src=x onerror=alert(1)>.txt');
    await W.git('add -A'); await W.git('commit -m "<script>alert(1)</script>"');
    r = await W.git('log'); assert.ok(!/<script/.test(r.html)); has(r, '<script>alert(1)</script>');
    r = await W.git('show'); assert.ok(!/<script|<img/.test(r.html));
    r = await W.git('diff --staged HEAD'); assert.ok(!/<img/.test(r.html));
  });

  await t('failures inside a command are reported on one red line and never throw into the terminal', async () => {
    const W = world();
    const r1 = await W.git('log --bogus'); has(r1, 'fatal: unknown option: --bogus');
    has(await W.git('commit -m'), "fatal: switch 'm' requires a value");
    has(await W.git('branch -d'), 'branch name required');
    const html = [];
    await W.ctx.window.CodeMiniGitCli.run(['status'], { rootId: 'root', cwd: [], printHtml: (h) => html.push(h), withDb: async () => { throw new Error("This terminal's workspace no longer exists."); } });
    assert.ok(html.join('').includes('workspace no longer exists'));
  });

  console.log(`\n${n} terminal git checks passed`);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
