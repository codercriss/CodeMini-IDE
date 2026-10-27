// Source Control > Remote: the live "Fetching 5/7: path" / "Pushing 3/9: path" line (js/git/git.js), run against a fake
// panel (no browser). Bug: Pull and Push set ui.busy.sync but never asked the panel to redraw, so with no earlier
// result on screen there was no #gitRemoteStatus box to update and the progress stayed invisible until something else
// re-rendered the panel (switching sidebar tabs, closing and reopening it). Fetch always redrew first.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'js/git/git.js'), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };

// The code under test: gitSetResult, gitSetRemoteProgress, gitStartRemoteProgress.
const grab = (from, to) => { const i = src.indexOf(from); const j = src.indexOf(to, i); assert(i > 0 && j > i, `cannot find ${from}`); return src.slice(i, j); };
const code = grab('function gitSetResult(', '\n') + '\n' + grab('function gitSetRemoteProgress(', 'function gitReadRemoteFields(');

// A fake panel: renderGitPanel() builds the status box from ui.results AFTER an async gap, like the real one (it awaits
// the object cache and the working tree before it builds its template), so ticks can arrive before the box exists.
function makeEnv({ existing } = {}) {
  const ui = { results: {}, busy: {} };
  let box = existing || null, renders = 0;
  const mkBox = (level, text) => ({ level, text, classList: { contains: (c) => c === `git-result-${level}` || c === 'git-result' }, querySelector: () => box });
  const ctx = vm.createContext({
    console, String, Object,
    document: { getElementById: (id) => (id === 'gitRemoteStatus' ? box : null) },
    window: { renderGitPanel: async () => { renders++; await new Promise((r) => setImmediate(r)); const r = ui.results.remote; box = r ? mkBox(r.level, r.text) : null; if (box) box.querySelector = () => box; } }
  });
  vm.runInContext(code, ctx);
  return { ui, ctx, renders: () => renders, box: () => box, settle: () => new Promise((r) => setTimeout(r, 20)) };
}
// the box's text: .textContent once updated in place; before that, whatever the render wrote
const live = (e) => { const b = e.box(); return b ? (b.textContent !== undefined ? b.textContent : b.text) : null; };

(async () => {
  console.log('gitStartRemoteProgress / gitSetRemoteProgress');
  await t('starting an operation stores the text AND redraws the panel (so the box exists from the start)', async () => {
    const e = makeEnv();
    e.ctx.gitStartRemoteProgress(e.ui, 'Fetching repository tree...');
    assert.strictEqual(e.ui.results.remote.level, 'info');
    assert.strictEqual(e.renders(), 1);
    await e.settle();
    assert(e.box(), 'a status box is on screen');
    assert.strictEqual(live(e), 'Fetching repository tree...');
  });
  await t('ticks that arrive BEFORE the redraw finishes still end up on screen (the box is built from the latest text)', async () => {
    const e = makeEnv();
    e.ctx.gitStartRemoteProgress(e.ui, 'Fetching repository tree...');
    e.ctx.gitSetRemoteProgress(e.ui, 'Fetching 1/7: a.txt');          // box does not exist yet
    e.ctx.gitSetRemoteProgress(e.ui, 'Fetching 2/7: b.txt');
    await e.settle();
    assert.strictEqual(live(e), 'Fetching 2/7: b.txt');
  });
  await t('once the box is up, every tick updates it in place - no further redraws', async () => {
    const e = makeEnv();
    e.ctx.gitStartRemoteProgress(e.ui, 'Fetching repository tree...');
    await e.settle();
    for (let i = 1; i <= 7; i++) { e.ctx.gitSetRemoteProgress(e.ui, `Fetching ${i}/7: f${i}.svg`); assert.strictEqual(live(e), `Fetching ${i}/7: f${i}.svg`, `tick ${i} is live`); }
    assert.strictEqual(e.renders(), 1, 'ticks must not re-render the whole panel');
  });
  await t('an old success box is NOT overwritten by progress text (it would read "Fetching 3/7" under a green tick)', async () => {
    const old = { classList: { contains: (c) => c === 'git-result-success' }, textContent: 'Pulled 7 file(s).' }; old.querySelector = () => old;
    const e = makeEnv({ existing: old });
    e.ctx.gitSetRemoteProgress(e.ui, 'Fetching 1/7: a.txt');
    assert.strictEqual(old.textContent, 'Pulled 7 file(s).');
    assert.strictEqual(e.ui.results.remote.text, 'Fetching 1/7: a.txt', 'the new text is still stored for the next redraw');
  });
  await t('the sidebar being closed (no box, no panel) does not throw', async () => {
    const e = makeEnv(); e.ctx.window.renderGitPanel = async () => {};
    e.ctx.gitStartRemoteProgress(e.ui, 'x'); e.ctx.gitSetRemoteProgress(e.ui, 'y');
  });

  console.log('wiring (source checks)');
  const fnBody = (name) => { const i = src.indexOf(`async function ${name}(`); const j = src.indexOf('\nasync function ', i + 10); return src.slice(i, j > 0 ? j : i + 6000); };
  await t('Pull starts with gitStartRemoteProgress, after busy is set', () => {
    const b = fnBody('gitPullFromGitHub');
    const k = b.indexOf('const doPull = async () => {'); const body = b.slice(k);
    assert(body.indexOf('ui.busy.sync = true;') > 0 && body.indexOf('ui.busy.sync = true;') < body.indexOf("gitStartRemoteProgress(ui, 'Fetching repository tree...')"));
    assert(!/gitSetRemoteProgress\(ui, 'Fetching repository tree\.\.\.'\)/.test(body), 'the first tick must be the redrawing one');
  });
  await t('Push starts with gitStartRemoteProgress, after busy is set and before its first tick', () => {
    const b = fnBody('gitPushToGitHub');
    const iBusy = b.indexOf('ui.busy.sync = true;'), iStart = b.indexOf('gitStartRemoteProgress('), iTick = b.indexOf('gitSetRemoteProgress(');
    assert(iBusy > 0 && iStart > iBusy && iTick > iStart);
  });
  await t('Fetch is unchanged: busy, a result, then a redraw', () => {
    const b = fnBody('gitFetchOnly');
    assert(/ui\.busy\.sync = true;\s*gitSetResult\(ui, 'remote', 'info'[^\n]*\n\s*window\.renderGitPanel\(\);/.test(b));
  });
  console.log(`\n${n} passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
