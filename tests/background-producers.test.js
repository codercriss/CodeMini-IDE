// Background tasks, the producers (build-order item 5): Git push/pull/fetch, Terminal and Console runs, the editor's Run, notebook runs
// and ZIP export all report to js/core/background-tasks.js. The real functions are cut out of their files and run against a real registry
// with a fake clock (no browser). What the island draws is in tests/e2e/background-tasks.e2e.js; the registry's own rules are in
// tests/background-tasks.test.js.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const { createRegistry } = require('../js/core/background-tasks.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };
const tick = () => new Promise((r) => setImmediate(r));

// A registry on a fake clock. hidden=true means "the person cannot see it", so tasks are listed at once (otherwise they appear after 800 ms).
function makeBg({ hidden = true } = {}) {
  const e = { time: 5000000, hiddenNow: hidden, notes: [] };
  e.reg = createRegistry({
    now: () => e.time, hidden: () => e.hiddenNow, activeWin: () => 'win_a', notify: (x) => e.notes.push(x),
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}
  });
  return e;
}
const grab = (src, from, to) => { const i = src.indexOf(from); const j = src.indexOf(to, i); assert(i >= 0 && j > i, 'cannot find ' + from); return src.slice(i, j); };
const fnEnd = (src, from) => { const i = src.indexOf(from); assert(i >= 0, 'cannot find ' + from); const j = src.indexOf('\n}\n', i); return src.slice(i, j + 3); };

(async () => {
  // ------------------------------------------------------------------------------------------------------------------
  console.log('Git push, pull, fetch');
  const gitSrc = read('js/git/git.js');
  const gitCode = grab(gitSrc, 'function gitSetResult(', '\n') + '\n' + grab(gitSrc, 'function gitSetRemoteProgress(', 'function gitReadRemoteFields(');
  function gitEnv({ sidebarOpen = false, bg = makeBg() } = {}) {
    const sb = { classList: { contains: (c) => c === 'open' && sidebarOpen } }, clicks = [];
    const win = { CodeMiniBackground: bg.reg, renderGitPanel() {} };
    const ctx = vm.createContext({ console, String, Object, Number, window: win,
      document: { getElementById: (id) => (id === 'sourceControlSidebar' ? sb : id === 'menuSource' ? { click: () => clicks.push('menuSource') } : null) } });
    vm.runInContext(gitCode, ctx);
    return { bg, ctx, ui: { results: {}, busy: {} }, setSidebar: (v) => { sidebarOpen = v; }, clicks };
  }
  const ref = { full: 'octo/cat' };
  await t('a push is a Git task named for the repository and branch, and Git keeps its own failure notice (notify off)', () => {
    const g = gitEnv();
    g.ctx.gitBgStart(g.ui, 'push', ref, 'main');
    const s = g.bg.reg.running()[0];
    assert.ok(s && s.kind === 'git' && s.title === 'Git: push octo/cat@main' && s.id === 'git-remote');
    g.ui.bgTask.finish('success');
    assert.strictEqual(g.bg.notes.length, 0, 'no second notification on top of Git\'s own');
  });
  await t('the step text that already goes to the status line also reaches Peek, with a percentage from "n/N"', () => {
    const g = gitEnv();
    g.ctx.gitBgStart(g.ui, 'pull', ref, 'main');
    g.ctx.gitSetRemoteProgress(g.ui, 'Fetching 12/48: src/app.js');
    const s = g.bg.reg.get('git-remote');
    assert.strictEqual(s.detail, 'Fetching 12/48: src/app.js'); assert.strictEqual(s.progress, 0.25);
    assert.deepStrictEqual(g.bg.reg.log('git-remote').map((l) => l.text), ['Fetching 12/48: src/app.js']);
    g.ctx.gitSetRemoteProgress(g.ui, 'Creating commit...');
    assert.strictEqual(g.bg.reg.get('git-remote').progress, null, 'text without n/N means no percentage');
    assert.strictEqual(g.ui.results.remote.text, 'Creating commit...', 'the status line is unchanged');
  });
  await t('"0/0" does not divide by zero', () => {
    const g = gitEnv(); g.ctx.gitBgStart(g.ui, 'pull', ref, 'main');
    g.ctx.gitSetRemoteProgress(g.ui, 'Fetching 0/0');
    assert.strictEqual(g.bg.reg.get('git-remote').progress, null);
  });
  await t('gitStartRemoteProgress feeds the task too, so the first line ("Checking...") is in Peek', () => {
    const g = gitEnv(); g.ctx.gitBgStart(g.ui, 'push', ref, 'main');
    g.ctx.gitStartRemoteProgress(g.ui, 'Checking octo/cat@main...');
    assert.strictEqual(g.bg.reg.log('git-remote')[0].text, 'Checking octo/cat@main...');
  });
  await t('it ends from what the operation left in ui.results.remote: success keeps its sentence, error fails with its message', () => {
    const a = gitEnv(); a.ctx.gitBgStart(a.ui, 'push', ref, 'main');
    a.ctx.gitSetResult(a.ui, 'remote', 'success', 'Pushed 2 commits to octo/cat@main.'); a.ctx.gitBgFinish(a.ui);
    const f = a.bg.reg.finished()[0];
    assert.deepStrictEqual([f.state, f.text], ['success', 'Pushed 2 commits to octo/cat@main.']);
    assert.strictEqual(a.ui.bgTask, null);
    const b = gitEnv(); b.ctx.gitBgStart(b.ui, 'pull', ref, 'main');
    b.ctx.gitSetResult(b.ui, 'remote', 'error', 'Bad credentials'); b.ctx.gitBgFinish(b.ui);
    assert.deepStrictEqual([b.bg.reg.finished()[0].state, b.bg.reg.finished()[0].text], ['error', 'Bad credentials']);
  });
  await t('gitBgFinish with no task is a no-op, and starting again first ends a task left over', () => {
    const g = gitEnv();
    g.ctx.gitBgFinish(g.ui); g.ctx.gitBgFinish({});
    g.ctx.gitBgStart(g.ui, 'push', ref, 'main');
    const first = g.ui.bgTask;
    g.ctx.gitBgStart(g.ui, 'fetch', ref, 'dev');
    assert.strictEqual(first.isRunning(), false, 'the earlier one was ended, not abandoned');
    assert.strictEqual(g.bg.reg.get('git-remote').title, 'Git: fetch octo/cat@dev');
  });
  await t('it counts as out of sight while Source Control is closed, and Go to opens it', () => {
    const closed = gitEnv({ sidebarOpen: false, bg: makeBg({ hidden: false }) });
    closed.ctx.gitBgStart(closed.ui, 'push', ref, 'main');
    assert.strictEqual(closed.bg.reg.get('git-remote').awayReason, 'tab', 'sidebar closed: another tab');
    assert.ok(closed.bg.reg.goto('git-remote')); assert.deepStrictEqual(closed.clicks, ['menuSource']);
    const open = gitEnv({ sidebarOpen: true, bg: makeBg({ hidden: false }) });
    open.ctx.gitBgStart(open.ui, 'push', ref, 'main');
    assert.strictEqual(open.bg.reg.get('git-remote').awayReason, '', 'sidebar open: in sight');
    open.bg.reg.goto('git-remote'); assert.deepStrictEqual(open.clicks, [], 'already open: nothing to click');
  });
  await t('without the registry (an older page) none of it throws', () => {
    const g = gitEnv(); g.ctx.window.CodeMiniBackground = undefined;
    g.ctx.gitBgStart(g.ui, 'push', ref, 'main'); g.ctx.gitSetRemoteProgress(g.ui, 'x 1/2'); g.ctx.gitBgFinish(g.ui);
    assert.strictEqual(g.ui.bgTask, undefined);
  });
  await t('push, fetch and pull each start the task before the work and end it in the finally block', () => {
    const body = (name) => { const i = gitSrc.indexOf('async function ' + name + '('); assert(i > 0, name); return gitSrc.slice(i, gitSrc.indexOf('\nasync function ', i + 10) > 0 ? gitSrc.indexOf('\nasync function ', i + 10) : undefined); };
    [['gitPushToGitHub', 'push'], ['gitFetchOnly', 'fetch'], ['gitPullFromGitHub', 'pull']].forEach(([fn, verb]) => {
      const b = body(fn);
      assert.ok(b.includes("gitBgStart(ui, '" + verb + "', ref, branch)"), fn + ' starts a ' + verb + ' task');
      assert.ok(b.includes('ui.busy.sync = false; gitBgFinish(ui);'), fn + ' ends it in finally');
      assert.ok(b.indexOf('gitBgStart') < b.indexOf('gitBgFinish'), fn + ': start before end');
    });
    assert.strictEqual((gitSrc.match(/gitBgFinish\(ui\)/g) || []).length, 5, 'its definition, the restart guard inside gitBgStart, and the three finally blocks');
  });

  // ------------------------------------------------------------------------------------------------------------------
  console.log('Terminal (runCollected)');
  const execSrc = read('js/viewers/exec-client.js');
  function termEnv(host) {
    const bg = makeBg();
    const win = { CodeMiniBackground: bg.reg, CodeMiniRunner: { modeFor: () => 'runner', execHost: async () => host, execError: () => '' },
      localStorage: { getItem: () => 'win_a' }, prompt: () => '' };
    const ctx = vm.createContext({ window: win, localStorage: win.localStorage, console, Promise, Object, String, Error });
    vm.runInContext(execSrc, ctx);
    return { bg, exec: win.CodeMiniExec };
  }
  await t('a Terminal run is a task titled with the language and the first line of the code; its output reaches Peek as it arrives', async () => {
    let seen = null;
    const e = termEnv({ run: async (req, onOut) => { onOut({ kind: 'stdout', text: 'hello' }); seen = e.bg.reg.running()[0]; onOut({ kind: 'stderr', text: 'warn' }); onOut({ kind: 'html', text: '<b>x</b>' }); return { value: null, plots: [] }; } });
    const out = await e.exec.runCollected('terminal', { lang: 'python', code: 'print("hello")\nprint(2)', opts: {} });
    assert.ok(seen && seen.kind === 'terminal' && seen.title === 'Terminal python: print("hello")', JSON.stringify(seen));
    assert.deepStrictEqual(e.bg.reg.finished()[0].state, 'success');
    assert.deepStrictEqual(e.bg.reg.log(e.bg.reg.finished()[0].id).map((l) => [l.stream, l.text]), [['out', 'hello'], ['err', 'warn']], 'html output is not text and is not logged');
    assert.strictEqual(out.events.length, 3, 'the Terminal still gets every event');
  });
  await t('a run that ends in an error is a failed task with the error message; a host that throws is too, and the caller still gets its result shape', async () => {
    const a = termEnv({ run: async () => ({ value: null, plots: [], error: { name: 'ZeroDivisionError', message: 'division by zero', text: 'Traceback...' } }) });
    await a.exec.runCollected('terminal', { lang: 'python', code: '1/0', opts: {} });
    assert.deepStrictEqual([a.bg.reg.finished()[0].state, a.bg.reg.finished()[0].text], ['error', 'division by zero']);
    const b = termEnv({ run: async () => { throw new Error('host gone'); } });
    const out = await b.exec.runCollected('terminal', { lang: 'js', code: 'x', opts: {} });
    assert.deepStrictEqual([b.bg.reg.finished()[0].state, b.bg.reg.finished()[0].text], ['error', 'host gone']);
    assert.strictEqual(out.res.error.message, 'host gone');
  });
  await t('a Terminal task has no Stop (the Terminal has none, and stopping would reset the host)', async () => {
    let s; const e = termEnv({ run: async () => { s = e.bg.reg.running()[0]; return { value: null, plots: [] }; } });
    await e.exec.runCollected('terminal', { lang: 'js', code: '1', opts: {} });
    assert.strictEqual(s.stoppable, false);
  });
  await t('when the in-app engine is used instead (null result) no task is made', async () => {
    const bg = makeBg(); const win = { CodeMiniBackground: bg.reg, CodeMiniRunner: { modeFor: () => 'normal' }, localStorage: { getItem: () => 'w' } };
    const ctx = vm.createContext({ window: win, localStorage: win.localStorage, console, Promise, Object, String });
    vm.runInContext(execSrc, ctx);
    assert.strictEqual(await win.CodeMiniExec.runCollected('terminal', { lang: 'js', code: '1' }), null);
    assert.strictEqual(bg.reg.running().length + bg.reg.finished().length, 0);
  });

  // ------------------------------------------------------------------------------------------------------------------
  console.log('Console and the editor\'s Run (wiring)');
  const consoleSrc = read('js/terminal/console.js'), editorSrc = read('js/core/editor.js');
  await t('a Console command is a console task with the window id, its output goes to Peek, and Stop uses the Console\'s own interrupt (kill the host)', () => {
    assert.ok(/CodeMiniBackground\.start\(\{\s*kind: 'console'/.test(consoleSrc));
    const i = consoleSrc.indexOf("kind: 'console', title:"); const blk = consoleSrc.slice(i, i + 1200);
    assert.ok(blk.includes('winId: activeWinId') && /onStop: \(\) => \{ run\.interrupted = true; if \(window\.CodeMiniExec\) window\.CodeMiniExec\.kill\(activeWinId\); \}/.test(blk));
    assert.ok(/if \(run\.interrupted\) bgTask\.finish\('stopped'[^)]*\); else if \(run\.errorText\) bgTask\.fail\(run\.errorText\); else bgTask\.finish\('success'\);/.test(consoleSrc), 'it ends as stopped, failed or succeeded, in finally');
    assert.ok(/a\.task\.log\(String\(e\.text\)/.test(consoleSrc) && consoleSrc.includes("e.kind !== 'html'"), 'host output is logged as text; html output is not');
  });
  await t('the Console\'s own Stop button still does what it did (the task did not replace it)', () => {
    assert.ok(consoleSrc.includes('if (inFlightRun && window.CodeMiniExec) { inFlightRun.interrupted = true; window.CodeMiniExec.kill(activeWinId); return; }'));
  });
  await t('the editor\'s Run is a run task: Stop kills the host like the bottom Stop button, Go to opens the Console, and it ends in finally', () => {
    const i = editorSrc.indexOf('async function _runOnHost('); const blk = editorSrc.slice(i, editorSrc.indexOf('\nwindow.runInBottomConsole', i));
    assert.ok(/CodeMiniBackground\.start\(\{\s*kind: 'run'/.test(blk));
    assert.ok(blk.includes('onStop: () => { run.interrupted = true; window.CodeMiniExec.kill(winId); }'));
    assert.ok(blk.includes('bottom-panel-tab[data-target="consolePanelContent"]'));
    assert.ok(/finally \{\s*if \(bgTask\) \{ if \(run\.interrupted\) bgTask\.finish\('stopped'[^)]*\); else if \(failure\) bgTask\.fail\(failure\); else bgTask\.finish\('success'\); \}/.test(blk));
    assert.ok(blk.includes("failure = String(err.message || err.text"), 'an error in the code is a failed task');
    assert.ok(blk.includes("failure = e.message;"), 'and so is a host error');
  });

  // ------------------------------------------------------------------------------------------------------------------
  console.log('Notebooks');
  const nbSrc = read('js/notebook/notebook-kernels.js'), nbUi = read('js/notebook/notebook-ui.js');
  const nbCode = grab(nbSrc, '// ---- Now Island: a notebook run is a background task', 'function getNextExecutionCount');
  function nbEnv({ bg = makeBg(), tabActive = true, core } = {}) {
    const tab = { classList: { contains: (c) => c === 'active' && tabActive }, click() { tab.clicked = (tab.clicked || 0) + 1; } };
    const interrupt = { click() { interrupt.clicked = (interrupt.clicked || 0) + 1; } };
    const pane = { id: 'nbpane1', querySelector: (q) => (q === '.tb-interrupt' ? interrupt : null) };
    const ctx = vm.createContext({ console, Promise, Object, String, RegExp, window: { CodeMiniBackground: bg.reg },
      document: { querySelector: (q) => (/nbpane1/.test(q) ? tab : null) },
      _getWinId: () => 'win_a', _nbTitleOf: () => 'analysis.ipynb', getNextExecutionCount: (c) => c.n, switchWindow() {}, setTimeout,
      _runCellCore: core || (async () => {}) });
    vm.runInContext(nbCode, ctx);
    return { bg, ctx, win: ctx.window, pane, tab, interrupt };
  }
  const cellWith = (n, prompt, output) => ({ n, querySelector: (q) => (q === '.cell-prompt' ? { textContent: prompt } : q === '.cell-output' ? (output === null ? null : { textContent: output }) : null) });
  await t('a cell run on its own is a notebook task named for the file and the cell; it ends as success when the prompt shows [n]:', async () => {
    let live;
    const e = nbEnv({ core: async () => { live = e.bg.reg.get('nb:nbpane1'); } });
    await e.ctx.runCell(cellWith(4, '[4]:', 'x'), e.pane);
    assert.ok(live && live.kind === 'notebook' && live.title === 'Notebook: analysis.ipynb, cell [4]' && live.id === 'nb:nbpane1', JSON.stringify(live));
    assert.strictEqual(e.bg.reg.finished()[0].state, 'success');
  });
  await t('a cell that errors fails the task with the first line of its error; one that was interrupted is stopped', async () => {
    const a = nbEnv(); await a.ctx.runCell(cellWith(1, '[ ]:', 'Error: NameError: x is not defined\nmore'), a.pane);
    assert.deepStrictEqual([a.bg.reg.finished()[0].state, a.bg.reg.finished()[0].text], ['error', 'Error: NameError: x is not defined']);
    const b = nbEnv(); await b.ctx.runCell(cellWith(1, '[ ]:', '[Execution Interrupted] The kernel was stopped by the user.'), b.pane);
    assert.strictEqual(b.bg.reg.finished()[0].state, 'stopped');
  });
  await t('a cell the wrapper cannot describe (no closest(), as in the Workspace Trust test) still runs, with no task', async () => {
    let ran = 0; const e = nbEnv({ core: async () => { ran++; } });
    e.ctx.getNextExecutionCount = () => { throw new TypeError('cell.closest is not a function'); };
    await e.ctx.runCell({}, e.pane);
    assert.strictEqual(ran, 1); assert.strictEqual(e.bg.reg.get('nb:nbpane1'), null);
  });
  await t('a cell that throws still ends its task (and the error reaches the caller)', async () => {
    const e = nbEnv({ core: async () => { throw new Error('boom'); } });
    await assert.rejects(() => e.ctx.runCell(cellWith(1, '[ ]:', null), e.pane), /boom/);
    assert.strictEqual(e.bg.reg.running().length, 0);
  });
  await t('Run All owns one task for the whole notebook; the cells it runs only change its title, and nothing ends it until nbBgEnd', async () => {
    const e = nbEnv();
    const task = e.win.nbBgBegin(e.pane);
    assert.ok(task && e.bg.reg.get('nb:nbpane1').title === 'Notebook: analysis.ipynb');
    await e.ctx.runCell(cellWith(2, '[2]:', 'ok'), e.pane);
    assert.strictEqual(e.bg.reg.get('nb:nbpane1').state, 'running', 'a cell does not end the run');
    assert.strictEqual(e.bg.reg.get('nb:nbpane1').title, 'Notebook: analysis.ipynb, cell [2]');
    task.update({ progress: 0.5 }); assert.strictEqual(e.bg.reg.get('nb:nbpane1').progress, 0.5);
    e.win.nbBgEnd(task, false);
    assert.deepStrictEqual([e.bg.reg.finished().length, e.bg.reg.finished()[0].state], [1, 'success']);
  });
  await t('nbBgBegin is for the first caller only: while a task runs it returns null and does not take over', async () => {
    const e = nbEnv(); const first = e.win.nbBgBegin(e.pane);
    assert.strictEqual(e.win.nbBgBegin(e.pane), null); assert.ok(first);
    e.win.nbBgEnd(null, false); // a null task is a no-op
    assert.strictEqual(e.bg.reg.get('nb:nbpane1').state, 'running');
  });
  await t('Stop during the LAST cell of a Run All (which clears the interrupt flag itself) still ends the run as stopped', async () => {
    const e = nbEnv(); const task = e.win.nbBgBegin(e.pane);
    await e.ctx.runCell(cellWith(3, '[ ]:', '[Execution Interrupted] The kernel was stopped by the user.'), e.pane);
    e.win.nbBgEnd(task, false); // the loop thinks it finished normally
    assert.strictEqual(e.bg.reg.finished()[0].state, 'stopped');
    // and the note does not leak into the next run
    const again = e.win.nbBgBegin(e.pane); e.win.nbBgEnd(again, false);
    assert.strictEqual(e.bg.reg.finished()[0].state, 'success');
  });
  await t('Stop from the island presses the notebook\'s own Interrupt Kernel button; Go to selects its tab', () => {
    const e = nbEnv(); e.win.nbBgBegin(e.pane);
    e.bg.reg.stop('nb:nbpane1'); assert.strictEqual(e.interrupt.clicked, 1);
    assert.ok(e.bg.reg.goto('nb:nbpane1')); assert.strictEqual(e.tab.clicked, 1);
  });
  await t('a notebook whose tab is not the active one counts as out of sight', () => {
    const e = nbEnv({ tabActive: false, bg: makeBg({ hidden: false }) }); e.win.nbBgBegin(e.pane);
    assert.strictEqual(e.bg.reg.get('nb:nbpane1').awayReason, 'tab');
  });
  await t('notebook runs do not notify on their own (notifyNotebookRunDone already does, with its own rules)', () => {
    assert.ok(/notify: false/.test(nbCode));
    const e = nbEnv({ bg: makeBg({ hidden: true }) }); const task = e.win.nbBgBegin(e.pane); e.win.nbBgEnd(task, false);
    assert.strictEqual(e.bg.notes.length, 0);
  });
  await t('both Run All handlers start the task before the loop and end it in a finally; progress is updated per cell', () => {
    assert.strictEqual((nbUi.match(/const runTask = window\.nbBgBegin \? window\.nbBgBegin\(pane\) : null;/g) || []).length, 2);
    assert.strictEqual((nbUi.match(/finally \{ if \(window\.nbBgEnd\) window\.nbBgEnd\(runTask, runStopped\); \}/g) || []).length, 2);
    assert.strictEqual((nbUi.match(/if \(runTask\) runTask\.update\(\{ progress: i \/ allCells\.length \}\);/g) || []).length, 2);
  });
  await t('runCell keeps its name for every caller (Run, Shift+Enter, Run All, the tests): the old body is _runCellCore', () => {
    assert.ok(nbSrc.includes('async function _runCellCore(cell, pane)') && nbSrc.includes('async function runCell(cell, pane)'));
    assert.strictEqual((nbSrc.match(/async function runCell\(/g) || []).length, 1);
  });

  // ------------------------------------------------------------------------------------------------------------------
  console.log('ZIP export');
  const udSrc = read('js/core/up-down.js');
  const zipEnd = udSrc.indexOf('\n}\n', udSrc.indexOf('async function _downloadZipCore')); // the core is the last function in the file
const zipCode = udSrc.slice(udSrc.indexOf('async function handleDownloadZip()'), zipEnd < 0 ? undefined : zipEnd + 3);
  function zipEnv({ loadFails = false, generateFails = false, files } = {}) {
    const bg = makeBg(); const dl = [], progress = [];
    const all = files || [{ id: 'a', parentId: 'root', name: 'a.js', type: 'file', content: '1' }, { id: 'b', parentId: 'root', name: 'b.js', type: 'file', content: '2' }, { id: 'c', parentId: 'root', name: 'c.js', type: 'file', content: '3', isLocked: true }];
    class FakeZip { constructor() { this.files = {}; }
      folder(name) { const self = this; return { folder: (x) => this.folder(name + '/' + x), file: (nm, c) => { self.files[name + '/' + nm] = { dir: false }; } }; }
      file(nm) { this.files[nm] = { dir: false }; }
      async generateAsync(opts, cb) { if (generateFails) throw new Error('out of memory'); cb({ percent: 50, currentFile: 'b.js' }); progress.push(bg.reg.running()[0] && bg.reg.running()[0].progress); cb({ percent: 100, currentFile: null }); return 'BLOB'; } }
    const ctx = vm.createContext({ console, Promise, Object, Array, Date, setTimeout, String, Error,
      window: { CodeMiniBackground: bg.reg, showCustomModal: ({ text }) => { ctx.__failed = text; } },
      downloadSelectedFiles: new Set(['a', 'b', 'c']),
      db: { transaction: () => ({ objectStore: () => ({ getAll: () => { const r = {}; setTimeout(() => r.onsuccess({ target: { result: all } }), 0); return r; } }) }) },
      loadJSZip: async () => { if (loadFails) throw new Error('offline'); return FakeZip; },
      selectionRoots: (sel, list) => list.filter((f) => sel.has(f.id)), triggerBlobDownload: (b, name) => dl.push([b, name]),
      toggleDownloadMode() {}, notifyLockedSkipped(k) { ctx.__locked = k; }, closeGenModal() {} });
    vm.runInContext(zipCode + '\nthis.handleDownloadZip = handleDownloadZip; this.notifyZipFailed = typeof notifyZipFailed === "function" ? notifyZipFailed : null;', ctx);
    vm.runInContext(udSrc.slice(udSrc.indexOf('function notifyZipFailed('), udSrc.indexOf('async function handleDownloadZip()')), ctx);
    return { bg, ctx, dl, progress };
  }
  await t('a ZIP export is an export task: progress follows JSZip\'s percent, and it ends as success with the file count and the locked ones skipped', async () => {
    const z = zipEnv();
    await z.ctx.handleDownloadZip();
    assert.deepStrictEqual(z.progress, [0.5], 'progress followed JSZip\'s own percent callback');
    assert.strictEqual(z.dl.length, 1); assert.strictEqual(z.ctx.__locked, 1);
    const f = z.bg.reg.finished()[0];
    assert.deepStrictEqual([f.kind, f.title, f.state, f.text], ['export', 'Export ZIP', 'success', '2 files, 1 locked skipped']);
  });
  await t('a ZIP library that cannot load fails the task, and the person still gets the existing message', async () => {
    const z = zipEnv({ loadFails: true });
    await z.ctx.handleDownloadZip();
    assert.deepStrictEqual([z.bg.reg.finished()[0].state, z.bg.reg.finished()[0].text], ['error', 'The ZIP library could not be loaded']);
    assert.ok(/could not be loaded/.test(z.ctx.__failed));
  });
  await t('a build that fails fails the task, and nothing was downloaded', async () => {
    const z = zipEnv({ generateFails: true });
    await z.ctx.handleDownloadZip();
    assert.deepStrictEqual([z.bg.reg.finished()[0].state, z.bg.reg.finished()[0].text], ['error', 'The ZIP could not be built']);
    assert.strictEqual(z.dl.length, 0);
  });
  await t('an empty selection starts no task', async () => {
    const z = zipEnv(); z.ctx.downloadSelectedFiles = new Set();
    await z.ctx.handleDownloadZip();
    assert.strictEqual(z.bg.reg.running().length + z.bg.reg.finished().length, 0);
  });
  await t('something that throws before the end (the file store) still ends the task, as failed', async () => {
    const z = zipEnv(); z.ctx.db = { transaction: () => { throw new Error('db closed'); } };
    await assert.rejects(() => z.ctx.handleDownloadZip(), /db closed/);
    assert.strictEqual(z.bg.reg.finished()[0].state, 'error');
    assert.strictEqual(z.bg.reg.running().length, 0);
  });

  console.log(n + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
