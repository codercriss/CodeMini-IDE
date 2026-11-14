// Background tasks (Now Island core, build-order item 5): the registry in js/core/background-tasks.js, run against a fake clock and a
// fake environment (no browser). The island, the status bar and the floating Peek panel are checked in
// tests/e2e/background-tasks.e2e.js; the producers' wiring is checked at the bottom of this file.
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const { createRegistry, SURFACE_MS, FINISHED_KEEP_MS, LOG_MAX } = require('../js/core/background-tasks.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };

// A clock that only moves when the test says so. Timers and intervals fire in order of their due time.
function makeEnv(extra) {
  const e = { time: 1000000, hiddenNow: false, win: 'win_a', notes: [], timers: [], seq: 0, ticks: 0 };
  e.env = Object.assign({
    now: () => e.time,
    hidden: () => e.hiddenNow,
    activeWin: () => e.win,
    notify: (x) => e.notes.push(x),
    setTimeout: (fn, ms) => { const id = ++e.seq; e.timers.push({ id, fn, at: e.time + ms }); return id; },
    clearTimeout: (id) => { e.timers = e.timers.filter((x) => x.id !== id); },
    setInterval: (fn, ms) => { const id = ++e.seq; e.timers.push({ id, fn, at: e.time + ms, every: ms }); e.ticks++; return id; },
    clearInterval: (id) => { e.timers = e.timers.filter((x) => x.id !== id); e.ticks--; }
  }, extra || {});
  e.advance = (ms) => {
    const end = e.time + ms;
    for (;;) {
      const due = e.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      e.time = due.at;
      if (due.every) due.at += due.every; else e.timers = e.timers.filter((x) => x.id !== due.id);
      due.fn();
    }
    e.time = end;
  };
  return e;
}
const make = (extra) => { const e = makeEnv(extra); e.reg = createRegistry(e.env); return e; };

(async () => {
  console.log('when a task appears');
  await t('a task that ends before it was ever shown leaves no trace: not listed, not counted, no notification', () => {
    const e = make();
    let calls = 0; e.reg.subscribe(() => calls++);
    const task = e.reg.start({ kind: 'console', title: 'Console: python' });
    assert.strictEqual(e.reg.runningCount(), 0, 'not shown yet');
    e.advance(SURFACE_MS - 50);
    task.finish('success', 'done');
    assert.deepStrictEqual([e.reg.running().length, e.reg.finished().length, e.notes.length, calls], [0, 0, 0, 0]);
    assert.strictEqual(e.reg.get(task.id), null, 'and it is gone from the registry');
  });
  await t('after SURFACE_MS of running it is listed, and the change reaches subscribers', () => {
    const e = make();
    let calls = 0; e.reg.subscribe(() => calls++);
    const task = e.reg.start({ kind: 'git', title: 'Git: push' });
    e.advance(SURFACE_MS + 1);
    assert.strictEqual(e.reg.runningCount(), 1);
    assert.ok(calls >= 1);
    assert.strictEqual(e.reg.running()[0].title, 'Git: push');
    assert.strictEqual(e.reg.running()[0].icon, 'ri-git-branch-line');
    task.finish();
  });
  await t('a task started while the app is hidden is listed at once, and marked as away', () => {
    const e = make(); e.hiddenNow = true;
    e.reg.start({ kind: 'notebook', title: 'Notebook: a.ipynb' });
    const r = e.reg.running();
    assert.strictEqual(r.length, 1); assert.strictEqual(r[0].away, true); assert.strictEqual(r[0].wasAway, true);
  });
  await t('a task started in another window/profile than the active one is listed at once', () => {
    const e = make();
    e.reg.start({ kind: 'console', title: 'Console: js', winId: 'win_b' });
    assert.strictEqual(e.reg.runningCount(), 1);
    assert.strictEqual(e.reg.running()[0].away, true);
  });
  await t('a task without a winId belongs to the window that was active when it started', () => {
    const e = make();
    const task = e.reg.start({ kind: 'console', title: 'x' });
    e.advance(SURFACE_MS + 1);
    assert.strictEqual(e.reg.get(task.id).winId, 'win_a');
    assert.strictEqual(e.reg.get(task.id).away, false);
    e.win = 'win_b'; e.advance(1000);
    assert.strictEqual(e.reg.get(task.id).away, true, 'switching windows mid-run makes it backgrounded within a second');
  });
  await t('looking away mid-run is noticed on the next beat and remembered after looking back', () => {
    const e = make();
    const task = e.reg.start({ kind: 'run', title: 'Run' });
    e.advance(SURFACE_MS + 1);
    assert.strictEqual(e.reg.get(task.id).wasAway, false);
    e.hiddenNow = true; e.advance(1000);
    assert.strictEqual(e.reg.get(task.id).away, true);
    e.hiddenNow = false; e.advance(1000);
    const s = e.reg.get(task.id);
    assert.strictEqual(s.away, false); assert.strictEqual(s.wasAway, true, 'it stays "was away"');
  });
  await t('a visibility change can be applied at once with refresh() instead of waiting for the beat', () => {
    const e = make();
    const task = e.reg.start({ kind: 'run', title: 'Run' });
    e.advance(SURFACE_MS + 1);
    e.hiddenNow = true; e.reg.refresh();
    assert.strictEqual(e.reg.get(task.id).away, true);
  });
  await t("a producer's own isHidden() counts too (a tab that is not on screen)", () => {
    const e = make();
    let hidden = false;
    const task = e.reg.start({ kind: 'notebook', title: 'nb', isHidden: () => hidden });
    e.advance(SURFACE_MS + 1);
    assert.strictEqual(e.reg.get(task.id).away, false);
    hidden = true; e.advance(1000);
    assert.strictEqual(e.reg.get(task.id).away, true);
  });
  await t('it says WHY the task is out of sight: app, window or tab (and nothing when it is in sight)', () => {
    const e = make();
    const seen = e.reg.start({ kind: 'run', title: 'seen', isHidden: () => false });
    e.advance(SURFACE_MS + 1);
    assert.strictEqual(e.reg.get(seen.id).awayReason, '');
    const tab = e.reg.start({ kind: 'run', title: 'tab', isHidden: () => true });
    assert.strictEqual(e.reg.get(tab.id).awayReason, 'tab');
    const win = e.reg.start({ kind: 'run', title: 'win', winId: 'win_b', isHidden: () => true });
    assert.strictEqual(e.reg.get(win.id).awayReason, 'window', 'another window outranks a hidden tab');
    e.hiddenNow = true; e.reg.refresh();
    assert.deepStrictEqual([seen, tab, win].map((x) => e.reg.get(x.id).awayReason), ['app', 'app', 'app'], 'a hidden app outranks everything');
    e.hiddenNow = false; e.reg.refresh();
    assert.strictEqual(e.reg.get(seen.id).awayReason, ''); assert.strictEqual(e.reg.get(seen.id).wasAway, true);
  });
  await t('a throwing isHidden() is treated as visible', () => {
    const e = make();
    e.reg.start({ kind: 'notebook', title: 'nb', isHidden: () => { throw new Error('boom'); } });
    e.advance(SURFACE_MS + 1);
    assert.strictEqual(e.reg.running()[0].away, false);
  });

  console.log('how it ends');
  await t('success: moves to RECENTLY FINISHED with its text, and the status bar can take one flash of it', () => {
    const e = make();
    const task = e.reg.start({ kind: 'export', title: 'Export ZIP' });
    e.advance(SURFACE_MS + 1);
    task.finish('success', '12 files');
    assert.strictEqual(e.reg.running().length, 0);
    const f = e.reg.finished();
    assert.strictEqual(f.length, 1); assert.strictEqual(f[0].state, 'success'); assert.strictEqual(f[0].text, '12 files');
    assert.strictEqual(f[0].progress, 1);
    assert.strictEqual(e.reg.takeFlash().state, 'success');
    assert.strictEqual(e.reg.takeFlash(), null, 'a flash is taken once');
  });
  await t('an unknown state is a success; error keeps its message and puts it in the log', () => {
    const e = make();
    const a = e.reg.start({ kind: 'run', title: 'a' }), b = e.reg.start({ kind: 'run', title: 'b' });
    e.advance(SURFACE_MS + 1);
    a.finish('weird'); b.fail('Network down');
    const by = Object.fromEntries(e.reg.finished().map((x) => [x.title, x]));
    assert.strictEqual(by.a.state, 'success'); assert.strictEqual(by.b.state, 'error'); assert.strictEqual(by.b.text, 'Network down');
    assert.strictEqual(e.reg.tail(b.id, 4).pop().text, 'Network down');
    assert.strictEqual(e.reg.tail(b.id, 4).pop().stream, 'err');
  });
  await t('watched runs are not announced: the person was looking', () => {
    const e = make();
    const task = e.reg.start({ kind: 'git', title: 'Git: pull' });
    e.advance(5000); task.finish('success', 'Pulled 3 files');
    assert.strictEqual(e.notes.length, 0);
  });
  await t('a run that was backgrounded is announced once, with its time', () => {
    const e = make();
    const task = e.reg.start({ kind: 'git', title: 'Git: pull', source: 'Source Control' });
    e.advance(SURFACE_MS + 1); e.hiddenNow = true; e.reg.refresh(); e.advance(41000);
    task.finish('success', 'Pulled 3 files');
    assert.strictEqual(e.notes.length, 1);
    const x = e.notes[0];
    assert.strictEqual(x.id, 'bg-' + task.id); assert.strictEqual(x.source, 'Source Control'); assert.strictEqual(x.kind, 'task');
    assert.strictEqual(x.title, 'Git: pull finished'); assert.ok(/Pulled 3 files/.test(x.text) && /4\d s/.test(x.text), x.text);
  });
  await t('a failure that happened out of sight is announced as failed, with the reason', () => {
    const e = make(); e.hiddenNow = true;
    const task = e.reg.start({ kind: 'git', title: 'Git: push' });
    task.fail('401 Bad credentials');
    assert.strictEqual(e.notes.length, 1);
    assert.strictEqual(e.notes[0].title, 'Git: push failed'); assert.strictEqual(e.notes[0].text, '401 Bad credentials');
  });
  await t("the person's own Stop is never announced, and notify:false (a producer that tells it itself) is respected", () => {
    const e = make(); e.hiddenNow = true;
    const a = e.reg.start({ kind: 'run', title: 'a', onStop() {} }), b = e.reg.start({ kind: 'notebook', title: 'b', notify: false });
    e.reg.stop(a.id); a.finish('stopped'); b.finish('success');
    assert.strictEqual(e.notes.length, 0);
    assert.strictEqual(e.reg.finished().length, 2, 'both still show in RECENTLY FINISHED');
  });
  await t('a failing notify() or listener never breaks the registry', () => {
    const e = make({ notify() { throw new Error('no notifications'); } }); e.hiddenNow = true;
    e.reg.subscribe(() => { throw new Error('bad listener'); });
    const task = e.reg.start({ kind: 'run', title: 'x' });
    task.finish('success');
    assert.strictEqual(e.reg.finished().length, 1);
  });
  await t('update, log and finish after the end are ignored', () => {
    const e = make(); e.hiddenNow = true;
    const task = e.reg.start({ kind: 'run', title: 'x' });
    task.finish('success', 'ok');
    task.update({ detail: 'late', title: 'late' }); task.log('late'); task.finish('error', 'late'); task.fail('late');
    const s = e.reg.get(task.id);
    assert.strictEqual(s.state, 'success'); assert.strictEqual(s.title, 'x'); assert.strictEqual(s.detail, ''); assert.strictEqual(e.reg.log(task.id).length, 0);
    assert.strictEqual(task.isRunning(), false);
  });

  console.log('progress and output');
  await t('progress is clamped to 0..1; null or a non-number means "working, no percentage"', () => {
    const e = make(); e.hiddenNow = true;
    const task = e.reg.start({ kind: 'export', title: 'x' });
    const p = (v) => { task.update({ progress: v }); return e.reg.get(task.id).progress; };
    assert.strictEqual(p(0.4), 0.4); assert.strictEqual(p(7), 1); assert.strictEqual(p(-3), 0);
    assert.strictEqual(p(null), null); assert.strictEqual(p(NaN), null); assert.strictEqual(p(Infinity), null);
  });
  await t('detail and title can change while running; a repaint is asked for once per burst, not per update', () => {
    const e = make(); e.hiddenNow = true;
    const task = e.reg.start({ kind: 'git', title: 'Git: pull' });
    let calls = 0; e.reg.subscribe(() => calls++);
    for (let i = 0; i < 50; i++) task.update({ detail: 'Fetching ' + i + '/50' });
    task.log('a'); task.log('b');
    assert.strictEqual(calls, 0, 'nothing fires synchronously');
    e.advance(500);
    assert.strictEqual(calls, 1, 'one repaint for the whole burst');
    assert.strictEqual(e.reg.get(task.id).detail, 'Fetching 49/50');
    task.update({ title: 'Git: pull origin' }); e.advance(500);
    assert.strictEqual(e.reg.get(task.id).title, 'Git: pull origin');
  });
  await t('log splits lines, drops the newline at the end of a chunk, marks stderr, and the tail is the last N', () => {
    const e = make(); e.hiddenNow = true;
    const task = e.reg.start({ kind: 'console', title: 'x' });
    task.log('one\ntwo\n'); task.log('three', 'err'); task.log('four'); task.log('five'); task.log('six');
    const all = e.reg.log(task.id);
    assert.deepStrictEqual(all.map((l) => l.text), ['one', 'two', 'three', 'four', 'five', 'six']);
    assert.strictEqual(all[2].stream, 'err'); assert.strictEqual(all[0].stream, 'out');
    assert.deepStrictEqual(e.reg.tail(task.id, 4).map((l) => l.text), ['three', 'four', 'five', 'six']);
    task.log(''); assert.strictEqual(e.reg.log(task.id).pop().text, '', 'an empty line is a line');
  });
  await t(`only the last ${LOG_MAX} lines are kept, and a very long line is cut`, () => {
    const e = make(); e.hiddenNow = true;
    const task = e.reg.start({ kind: 'console', title: 'x' });
    for (let i = 0; i < LOG_MAX + 50; i++) task.log('line ' + i);
    const l = e.reg.log(task.id);
    assert.strictEqual(l.length, LOG_MAX); assert.strictEqual(l[0].text, 'line 50'); assert.strictEqual(l[l.length - 1].text, 'line ' + (LOG_MAX + 49));
    task.log('x'.repeat(5000));
    assert.ok(e.reg.log(task.id).pop().text.length <= 2003);
  });
  await t('log text is data: markup in it is returned as it was, never interpreted (the island uses textContent)', () => {
    const e = make(); e.hiddenNow = true;
    const task = e.reg.start({ kind: 'console', title: '<img src=x onerror=alert(1)>' });
    task.log('<b>hi</b>');
    assert.strictEqual(e.reg.log(task.id)[0].text, '<b>hi</b>');
    assert.strictEqual(e.reg.get(task.id).title, '<img src=x onerror=alert(1)>');
  });

  console.log('Stop, Go to, dismiss, pin');
  await t('stop() calls the producer once, shows "stopping", and the producer says how it ended', () => {
    const e = make(); e.hiddenNow = true;
    let stops = 0; const task = e.reg.start({ kind: 'run', title: 'x', onStop: () => { stops++; } });
    assert.strictEqual(e.reg.get(task.id).stoppable, true);
    assert.strictEqual(e.reg.stop(task.id), true); assert.strictEqual(e.reg.stop(task.id), false, 'a second click does nothing');
    assert.strictEqual(stops, 1); assert.strictEqual(e.reg.get(task.id).stopping, true);
    task.finish('stopped', 'Stopped');
    assert.strictEqual(e.reg.get(task.id).state, 'stopped'); assert.strictEqual(e.reg.get(task.id).stopping, false);
  });
  await t('a task with no onStop is not stoppable; one whose onStop throws stays running until its producer ends it', () => {
    const e = make(); e.hiddenNow = true;
    const a = e.reg.start({ kind: 'run', title: 'a' }), b = e.reg.start({ kind: 'run', title: 'b', onStop() { throw new Error('x'); } });
    assert.strictEqual(e.reg.get(a.id).stoppable, false); assert.strictEqual(e.reg.stop(a.id), false);
    e.reg.stop(b.id); assert.strictEqual(e.reg.get(b.id).state, 'running');
  });
  await t('goto() runs the producer\'s onGoto and reports whether there was one', () => {
    const e = make(); e.hiddenNow = true;
    let went = 0; const a = e.reg.start({ kind: 'notebook', title: 'a', onGoto: () => { went++; } }), b = e.reg.start({ kind: 'run', title: 'b' });
    assert.strictEqual(e.reg.get(a.id).canGoto, true); assert.strictEqual(e.reg.goto(a.id), true); assert.strictEqual(went, 1);
    assert.strictEqual(e.reg.goto(b.id), false);
  });
  await t('dismiss removes a finished task but not a running one', () => {
    const e = make(); e.hiddenNow = true;
    const a = e.reg.start({ kind: 'run', title: 'a' }), b = e.reg.start({ kind: 'run', title: 'b' });
    a.finish();
    e.reg.dismiss(b.id); assert.strictEqual(e.reg.runningCount(), 1);
    e.reg.dismiss(a.id); assert.strictEqual(e.reg.finished().length, 0);
  });
  await t('dismissAllFinished clears the finished list and leaves running tasks alone', () => {
    const e = make(); e.hiddenNow = true;
    const a = e.reg.start({ kind: 'run', title: 'a' }), b = e.reg.start({ kind: 'run', title: 'b' }); e.reg.start({ kind: 'run', title: 'c' });
    a.finish(); b.fail('x');
    e.reg.dismissAllFinished();
    assert.strictEqual(e.reg.finished().length, 0); assert.strictEqual(e.reg.runningCount(), 1);
  });
  await t('only a shown task can be pinned; a pinned task is listed until unpinned and survives the 60 s expiry', () => {
    const e = make();
    const quick = e.reg.start({ kind: 'run', title: 'quick' });
    assert.strictEqual(e.reg.pin(quick.id), false, 'not shown yet');
    quick.finish();
    e.hiddenNow = true; const a = e.reg.start({ kind: 'run', title: 'a' });
    assert.strictEqual(e.reg.pin(a.id), true); assert.strictEqual(e.reg.get(a.id).pinned, true);
    a.finish('success', 'ok');
    e.advance(FINISHED_KEEP_MS + 5000);
    assert.strictEqual(e.reg.pinned().length, 1, 'still there');
    assert.strictEqual(e.reg.finished().length, 1);
    e.reg.unpin(a.id);
    assert.strictEqual(e.reg.finished().length, 0, 'now it has expired');
  });
  await t('dismissing a pinned finished task also unpins it', () => {
    const e = make(); e.hiddenNow = true;
    const a = e.reg.start({ kind: 'run', title: 'a' }); e.reg.pin(a.id); a.finish('error', 'bad');
    e.reg.dismiss(a.id);
    assert.deepStrictEqual([e.reg.pinned().length, e.reg.isPinned(a.id)], [0, false]);
  });

  console.log('lists and identity');
  await t('RECENTLY FINISHED is newest first, expires after 60 s, and keeps at most 20', () => {
    const e = make(); e.hiddenNow = true;
    for (let i = 0; i < 25; i++) { const x = e.reg.start({ kind: 'run', title: 't' + i }); e.advance(10); x.finish(); }
    const f = e.reg.finished();
    assert.strictEqual(f.length, 20); assert.strictEqual(f[0].title, 't24'); assert.strictEqual(f[19].title, 't5');
    e.advance(FINISHED_KEEP_MS);
    assert.strictEqual(e.reg.finished().length, 0);
  });
  await t('running tasks are listed oldest first', () => {
    const e = make(); e.hiddenNow = true;
    e.reg.start({ kind: 'run', title: 'first' }); e.advance(5); e.reg.start({ kind: 'run', title: 'second' });
    assert.deepStrictEqual(e.reg.running().map((x) => x.title), ['first', 'second']);
  });
  await t('the same id while running is the same task; after it ends the id can be used again', () => {
    const e = make(); e.hiddenNow = true;
    const a = e.reg.start({ id: 'nb-1', kind: 'notebook', title: 'one' }), b = e.reg.start({ id: 'nb-1', kind: 'notebook', title: 'two' });
    assert.strictEqual(a, b); assert.strictEqual(e.reg.runningCount(), 1); assert.strictEqual(e.reg.get('nb-1').title, 'one');
    a.finish();
    const c = e.reg.start({ id: 'nb-1', kind: 'notebook', title: 'three' });
    assert.notStrictEqual(a, c); assert.strictEqual(e.reg.get('nb-1').title, 'three'); assert.strictEqual(e.reg.get('nb-1').state, 'running');
    assert.strictEqual(e.reg.finished().length, 0, 'the old result is replaced, not listed beside it');
  });
  await t('a stale handle (from a run that already ended, whose id was reused) cannot touch the run that replaced it', () => {
    const e = make(); e.hiddenNow = true;
    const old = e.reg.start({ id: 'git-remote', kind: 'git', title: 'old' }); old.finish('success');
    const cur = e.reg.start({ id: 'git-remote', kind: 'git', title: 'new' });
    old.update({ title: 'hijacked', detail: 'x', progress: 0.9 }); old.log('stale'); old.finish('error', 'stale'); old.fail('stale');
    const s = e.reg.get('git-remote');
    assert.deepStrictEqual([s.state, s.title, s.detail, s.progress, e.reg.log('git-remote').length, old.isRunning(), cur.isRunning()], ['running', 'new', '', null, 0, false, true]);
  });
  await t('an unknown kind is a generic task, a missing title gets a default, and a task is told apart by id otherwise', () => {
    const e = make(); e.hiddenNow = true;
    const a = e.reg.start({ kind: 'nonsense' }), b = e.reg.start({ kind: 'git' });
    assert.strictEqual(e.reg.get(a.id).kind, 'task'); assert.strictEqual(e.reg.get(a.id).title, 'Task task');
    assert.strictEqual(e.reg.get(b.id).title, 'Git task'); assert.notStrictEqual(a.id, b.id);
  });
  await t("snapshots never hand out the producer's callbacks or the log, and the API is frozen", () => {
    const e = make(); e.hiddenNow = true;
    const task = e.reg.start({ kind: 'run', title: 'x', onStop() {}, onGoto() {} }); task.log('a');
    const s = e.reg.get(task.id);
    assert.ok(!('onStop' in s) && !('onGoto' in s) && !('log' in s) && !('handle' in s) && !('timer' in s));
    assert.strictEqual(s.lines, 1);
    assert.ok(Object.isFrozen(task));
    s.title = 'changed'; assert.strictEqual(e.reg.get(task.id).title, 'x', 'a snapshot is a copy');
  });

  console.log('the one-second beat');
  await t('the beat runs only while something runs, and stops when the last task ends', () => {
    const e = make();
    assert.strictEqual(e.ticks, 0);
    const a = e.reg.start({ kind: 'run', title: 'a' }), b = e.reg.start({ kind: 'run', title: 'b' });
    assert.strictEqual(e.ticks, 1, 'one beat for both');
    e.advance(SURFACE_MS + 1);
    a.finish(); assert.strictEqual(e.ticks, 1, 'still one task running');
    b.finish(); assert.strictEqual(e.ticks, 0);
  });
  await t('a task that ends before it was shown also lets the beat stop', () => {
    const e = make();
    e.reg.start({ kind: 'run', title: 'a' }).finish();
    assert.strictEqual(e.ticks, 0);
  });
  await t('every beat tells subscribers, so the elapsed time in the island moves', () => {
    const e = make(); e.hiddenNow = true;
    e.reg.start({ kind: 'run', title: 'a' });
    let calls = 0; e.reg.subscribe(() => calls++);
    e.advance(3000);
    assert.ok(calls >= 3, 'got ' + calls);
  });

  console.log('wiring');
  const html = read('index.html');
  await t('the script loads before every producer (editor, notebooks, git, terminal) and after nothing it needs', () => {
    const tags = Array.from(html.matchAll(/<script src="([^"]+)"/g), (m) => m[1]);
    const at = (f) => tags.indexOf(f);
    assert.ok(at('js/core/background-tasks.js') > -1, 'is in index.html');
    ['js/core/editor.js', 'js/notebook/notebook-kernels.js', 'js/notebook/notebook-ui.js', 'js/core/up-down.js', 'js/git/git.js', 'js/terminal/console.js',
      'js/terminal/terminal-window.js', 'js/viewers/exec-client.js', 'js/core/now-island.js'].forEach((f) => {
      assert.ok(at('js/core/background-tasks.js') < at(f), 'before ' + f);
    });
  });
  await t('it is precached so the island works offline', () => {
    assert.ok(read('sw.js').includes("'/js/core/background-tasks.js'"));
  });
  await t('it touches no DOM of its own and writes no HTML (the island draws it with textContent)', () => {
    const src = read('js/core/background-tasks.js');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createElement/.test(src.replace(/\/\/.*$/gm, '')));
  });
  console.log(n + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
