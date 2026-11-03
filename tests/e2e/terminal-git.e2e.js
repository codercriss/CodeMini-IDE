// The terminal's `git` command in the real app: typed into the real terminal input (so the terminal's own word
// splitting, quoting, `cd` and pipes are in play), on real IndexedDB, with the real Source Control code loaded.
// terminal-git.test.js covers the logic against a fake database; this covers the wiring.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (deps, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); };
    window.require.config = () => {};
  });
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.goto('http://localhost:8765/index.html'); await sleep(5200);
  const ev = (f, a) => page.evaluate(f, a);
  const openTerminal = async () => { await ev(() => document.getElementById('terminalIconItem').click()); await sleep(800); };
  // The visible terminal: after a reload the app restores its terminal tabs, so there can be several inputs and only one is shown.
  const visibleInput = () => page.locator('[id^="pane-term"] .term-input:visible').last();
  // each command's output: whatever the terminal printed since just before it ran
  const run = async (cmd) => {
    const before = await ev(() => { const i = [...document.querySelectorAll('[id^="pane-term"] .term-input')].filter(x => x.offsetParent !== null).pop(); return i.closest('[id^="pane-term"]').querySelectorAll('.term-output > div').length; });
    await visibleInput().fill(cmd); await visibleInput().press('Enter'); await sleep(900);
    return ev((n) => { const i = [...document.querySelectorAll('[id^="pane-term"] .term-input')].filter(x => x.offsetParent !== null).pop(); return [...i.closest('[id^="pane-term"]').querySelectorAll('.term-output > div')].slice(n + 1).map(d => d.innerText).join('\n'); }, before);
  };
  const fsNames = () => ev(() => new Promise(res => { const tx = db.transaction('filesystem', 'readonly'); tx.objectStore('filesystem').getAll().onsuccess = (e) => res(e.target.result.map(f => f.name).sort()); }));

  console.log('\n[git in the terminal]');
  await openTerminal();
  ok(await ev(() => !!document.querySelector('.term-input')), 'terminal opened');
  ok(/git\b/.test(await run('help')), 'git is listed in the terminal help');
  const usage = await run('git help');
  ok(/usage: git <command>/.test(usage) && /commit -m/.test(usage), 'git help prints usage', usage.slice(0, 200));
  ok(/not a git command/.test(await run('git frobnicate')), 'unknown subcommand is reported');
  ok(/not available in the terminal/.test(await run('git push')), 'push points at Source Control');

  let r = await run('git status');
  ok(/On branch main/.test(r) && /No commits yet/.test(r), 'fresh repository: on main, no commits', r);
  await run('echo "hello world" > a.txt');
  r = await run('git status -s');
  ok(/\?\? a\.txt/.test(r), 'a file made with the terminal shows as untracked', r);
  await run('git add .');
  r = await run('git status');
  ok(/new file:\s+a\.txt/.test(r), 'git add . stages it', r);
  ok(await ev(() => getStagedPaths(db.name).join() === '/a.txt'), 'the staged list is the one the Source Control panel reads');
  r = await run('git commit -m "first commit here"');
  ok(/\(root-commit\)/.test(r) && /first commit here/.test(r), 'commit with a quoted multi-word message', r);
  r = await run('git log --oneline');
  ok(/\(HEAD -> main\) first commit here/.test(r), 'git log --oneline shows it with its decoration', r);
  r = await run('git log --oneline | grep first');
  ok(/first commit here/.test(r), 'output can be piped (git log | grep)', r);
  r = await run('git status -s | grep a.txt');
  ok(r.trim() === '', 'a clean tree pipes to nothing');

  console.log('\n[shared with Source Control]');
  const panel = await ev(() => { const repo = getGitRepo(db.name); const c = getGitConfig(db.name); return { branch: c.currentBranch, tip: !!repo.refs[c.currentBranch], commits: Object.keys(repo.objects).length, msg: repo.objects[repo.refs[c.currentBranch]].message }; });
  ok(panel.branch === 'main' && panel.tip && panel.commits === 1 && panel.msg === 'first commit here', 'the panel\'s repository holds the terminal\'s commit', panel);
  ok(await ev(() => new Promise(res => { const tx = db.transaction('gitobjects', 'readonly'); tx.objectStore('gitobjects').getAll().onsuccess = (e) => res(e.target.result.length === 1); })), 'the commit object was written to IndexedDB');

  console.log('\n[branches follow the files, and the UI follows the branch]');
  r = await run('git switch -c feature');
  ok(/Switched to a new branch 'feature'/.test(r), 'switch -c', r);
  await run('echo "feature only" > f.txt'); await run('git add f.txt'); await run('git commit -m "feature work"');
  ok((await fsNames()).includes('f.txt'), 'file exists on the feature branch');
  r = await run('git switch main');
  ok(/Switched to branch 'main'/.test(r), 'switch back', r);
  ok(!(await fsNames()).includes('f.txt'), 'the Explorer database no longer has the feature file');
  ok(/^\s*$/.test(await run('ls | grep f.txt')), 'ls agrees');
  ok(await ev(() => document.getElementById('statusBranchName').textContent === 'main'), 'the status-bar branch label shows main');
  await run('git switch feature');
  ok(await ev(() => document.getElementById('statusBranchName').textContent === 'feature'), 'and follows a switch to feature');
  await run('git switch main');

  console.log('\n[safety]');
  await run('echo "unsaved" > a.txt');
  r = await run('git switch feature');
  ok(/would be lost by the checkout/.test(r) && /a\.txt/.test(r), 'switching with uncommitted work is refused', r);
  ok(await ev(() => getGitConfig(db.name).currentBranch === 'main'), 'and the branch did not change');
  r = await run('cat a.txt'); ok(/unsaved/.test(r), 'the file was not touched', r);
  await run('git restore a.txt');
  ok(/hello world/.test(await run('cat a.txt')), 'git restore puts the committed text back');

  console.log('\n[merge, with a conflict]');
  await run('echo "main side" > c.txt'); await run('git add c.txt'); await run('git commit -m "c on main"');
  await run('git switch feature'); await run('echo "feature side" > c.txt'); await run('git add c.txt'); await run('git commit -m "c on feature"');
  await run('git switch main');
  r = await run('git merge feature');
  ok(/CONFLICT \(content\): Merge conflict in c\.txt/.test(r), 'conflict is reported', r);
  ok(await ev(() => !!gitGetPendingMerge(db.name)), 'the panel sees the pending merge');
  r = await run('cat c.txt'); ok(/<<<<<<< main/.test(r) && />>>>>>> feature/.test(r), 'markers are in the file', r);
  r = await run('git commit -m x'); ok(/unmerged files/.test(r), 'commit is refused while unresolved');
  await run('echo "resolved" > c.txt'); await run('git add c.txt');
  r = await run('git commit');
  ok(/Merge branch 'feature' into 'main'/.test(r), 'commit finishes the merge', r);
  r = await run('git log -n 1');
  ok(/Merge: [0-9a-f]{7} [0-9a-f]{7}/.test(r), 'the merge commit has two parents', r);

  console.log('\n[folders: paths follow the current directory]');
  await run('mkdir sub'); await run('cd sub'); await run('echo inner > in.txt');
  r = await run('git status -s'); ok(/\?\? in\.txt/.test(r), 'status shows paths relative to the current folder', r);
  await run('git add .');
  r = await run('git status -s'); ok(/A  in\.txt/.test(r), 'git add . inside a folder stages that folder', r);
  await run('git commit -m "sub"'); await run('cd ..');
  r = await run('git show --name-only HEAD'); ok(/sub\/in\.txt/.test(r), 'git show lists repository-relative paths', r);

  console.log('\n[stash]');
  await run('echo "wip" > a.txt');
  r = await run('git stash'); ok(/Saved working directory/.test(r), 'stash saves', r);
  ok(/hello world/.test(await run('cat a.txt')), 'and restores the committed file');
  r = await run('git stash pop'); ok(/Applied and dropped/.test(r), 'pop', r);
  ok(/wip/.test(await run('cat a.txt')), 'the work is back');
  await run('git restore a.txt');

  console.log('\n[after a reload, history comes back from IndexedDB]');
  const before = await run('git log --oneline');
  const expected = before.split('\n').filter(l => l.trim()).length;
  await page.reload(); await sleep(5200); await openTerminal();
  r = await run('git log --oneline');
  ok(r.split('\n').filter(l => l.trim()).length === expected && expected >= 5, 'the same commits are listed in a new session', { expected, r });
  r = await run('git status'); ok(/nothing to commit, working tree clean/.test(r), 'and the tree is clean', r);

  console.log('\n[output is not interpreted as HTML]');
  await ev(() => new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put({ id: 'pwn1', parentId: 'root', name: '<b id=pwn>.txt', type: 'file', content: 'x', timestamp: Date.now() }); tx.oncomplete = res; }));
  r = await run('git status -s');
  ok(/<b id=pwn>\.txt/.test(r) && await ev(() => !document.getElementById('pwn')), 'a file name with markup is shown as text', r);

  const rel = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i.test(e));
  ok(rel.length === 0, 'no unexpected page errors', rel);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
