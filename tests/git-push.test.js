// Source Control > Remote > Push (js/git/git.js), run for real against a fake GitHub (no browser, no network).
// Push used to PUT every file of the branch through the Contents API: one GitHub commit per file ("Update <path> via
// CodeMini"), local commit messages lost, every file re-sent every time, deletions never synced, and a failure
// midway left the remote half-updated. It is now one atomic push through the Git Data API (blobs -> trees -> commits
// -> a single ref update). The fake below is strict on purpose: it refuses what real GitHub refuses (a tree entry
// pointing at a missing blob, deleting a path that is not there, a non-fast-forward ref update, anything but the
// Contents API on an empty repository), so a mistake in the push shows up here as a failure, not as a silent pass.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const nodeCrypto = require('crypto'), { execFileSync } = require('child_process');
const src = fs.readFileSync(path.join(__dirname, '..', 'js/git/git.js'), 'utf8');
// Values built inside the vm context have another realm's Array/Object prototypes, which assert.deepStrictEqual rejects;
// comparing their JSON form is the same check for plain data.
const deq = (a, b, m) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };

// ---- the code under test, cut out of git.js by name --------------------------------------------------------------
const grab = (from, to) => { const i = src.indexOf(from); const j = src.indexOf(to, i + from.length); assert(i >= 0 && j > i, `cannot find ${from}`); return src.slice(i, j); };
const code = [
  grab('function gitStorageKey(', '\n'),
  grab('function gitEsc(', 'function gitRelativeTime('),
  grab('function gitWalkAncestors(', '// --- Log graph'),
  grab('function gitEncodePath(', '\n'),
  grab('async function gitHubRequest(', 'function gitBuildProfile('),
  grab('function gitRemoteTrackingKey(', '// Looks up the remote branch'),
  grab('function gitSetResult(', '\n'),
  grab('function gitSetRemoteProgress(', 'function gitReadRemoteFields('),
  grab('// --- Push: one atomic push', '// User-facing "Fetch"'),
  grab('// One line, shown right above the Push button', 'function renderRemoteTab(')
].join('\n');

// ---- a fake GitHub ------------------------------------------------------------------------------------------------
const sha1 = (s) => nodeCrypto.createHash('sha1').update(s).digest('hex');
const gitBlob = (buf) => sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])); // real git's blob id
function fakeGitHub({ files = null, branch = 'main', emptyRefStatus = 404, missingRepo = false, refuseBranchOnEmpty = false, defaultBranch = 'main' } = {}) {
  const blobs = new Map(), trees = new Map(), commits = new Map(), refs = new Map();
  const S = { log: [], commitBodies: [], truncate: false, failWhen: null, beforeRefPatch: null, missingRepo };
  let seq = 0;
  const putBlob = (buf) => { const s = gitBlob(buf); blobs.set(s, buf); return s; };
  const putTree = (entries) => { entries.sort((a, b) => (a.path < b.path ? -1 : 1)); const s = sha1('tree' + JSON.stringify(entries)); trees.set(s, entries); return s; };
  const putCommit = (o) => { const s = sha1('commit' + (seq++) + JSON.stringify(o)); commits.set(s, o); return s; };
  const isAncestor = (a, b) => { const st = [b], seen = new Set(); while (st.length) { const c = st.pop(); if (c === a) return true; if (seen.has(c)) continue; seen.add(c); const o = commits.get(c); if (o) st.push(...o.parents); } return false; };
  const seedTree = (fs_) => putTree(Object.entries(fs_).map(([p, v]) => ({ path: p, mode: (v && v.mode) || '100644', type: 'blob', sha: putBlob(Buffer.from(typeof v === 'string' ? v : v.c)) })));
  if (files) refs.set(branch, putCommit({ message: 'Initial', tree: seedTree(files), parents: [] }));
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const err = (status, message) => json(status, { message });
  const empty = () => commits.size === 0;

  S.fetch = async (url, opts = {}) => {
    const u = new URL(url); const method = (opts.method || 'GET').toUpperCase();
    const p = decodeURIComponent(u.pathname).replace(/^\/repos\/o\/r/, '');
    S.log.push(`${method} ${p}`);
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (S.missingRepo) return err(404, 'Not Found');
    if (S.failWhen) { const f = S.failWhen(method, p, body); if (f) return err(f.status, f.message); }
    let m;
    if (method === 'GET' && p === '') return json(200, { default_branch: defaultBranch });
    if (method === 'GET' && p === '/branches') return json(200, empty() ? [] : [{ name: [...refs.keys()][0] }]);
    if (method === 'GET' && (m = p.match(/^\/git\/refs\/heads\/(.+)$/))) {
      if (refs.has(m[1])) return json(200, { ref: `refs/heads/${m[1]}`, object: { sha: refs.get(m[1]), type: 'commit' } });
      const prefixed = [...refs.keys()].filter(k => k.startsWith(m[1] + '/'));
      if (prefixed.length) return json(200, prefixed.map(k => ({ ref: `refs/heads/${k}`, object: { sha: refs.get(k) } })));
      return empty() ? err(emptyRefStatus, emptyRefStatus === 409 ? 'Git Repository is empty.' : 'Not Found') : err(404, 'Not Found');
    }
    if (method === 'GET' && (m = p.match(/^\/git\/commits\/([0-9a-f]+)$/))) { const c = commits.get(m[1]); return c ? json(200, { sha: m[1], message: c.message, tree: { sha: c.tree }, parents: c.parents.map(s => ({ sha: s })) }) : err(404, 'Not Found'); }
    if (method === 'GET' && (m = p.match(/^\/git\/trees\/([0-9a-f]+)$/))) { const tr = trees.get(m[1]); return tr ? json(200, { sha: m[1], tree: tr, truncated: S.truncate }) : err(404, 'Not Found'); }
    if (method === 'PUT' && (m = p.match(/^\/contents\/(.+)$/))) {
      if (!empty()) return err(500, 'test: the Contents API must only be used to bootstrap an empty repository');
      if (refuseBranchOnEmpty && body.branch) return err(404, 'Branch not found');
      const buf = Buffer.from(body.content, 'base64'); const bs = putBlob(buf);
      const tr = putTree([{ path: m[1], mode: '100644', type: 'blob', sha: bs }]);
      const c = putCommit({ message: body.message, tree: tr, parents: [] }); refs.set(body.branch || defaultBranch, c);
      return json(201, { content: { sha: bs, path: m[1] }, commit: { sha: c, tree: { sha: tr } } });
    }
    if (method === 'POST' && /^\/git\/(blobs|trees|commits)$/.test(p) && empty()) return err(409, 'Git Repository is empty.');
    if (method === 'POST' && p === '/git/blobs') { if (body.encoding !== 'base64') return err(422, 'test: expected base64'); return json(201, { sha: putBlob(Buffer.from(body.content, 'base64')) }); }
    if (method === 'POST' && p === '/git/trees') {
      const entries = new Map();
      if (body.base_tree) { const bt = trees.get(body.base_tree); if (!bt) return err(422, 'base_tree does not exist'); bt.forEach(e => entries.set(e.path, e)); }
      if (!Array.isArray(body.tree)) return err(422, 'tree must be an array');
      for (const e of body.tree) {
        if (e.type !== 'blob' || !/^100(644|755)$|^120000$/.test(e.mode)) return err(422, `bad tree entry ${JSON.stringify(e)}`);
        if (e.sha === null) { if (!entries.has(e.path)) return err(422, `cannot delete ${e.path}: not in base tree`); entries.delete(e.path); }
        else { if (!blobs.has(e.sha)) return err(422, `blob ${e.sha} does not exist`); entries.set(e.path, { path: e.path, mode: e.mode, type: 'blob', sha: e.sha }); }
      }
      return json(201, { sha: putTree([...entries.values()]) });
    }
    if (method === 'POST' && p === '/git/commits') {
      S.commitBodies.push(body);
      if (!trees.has(body.tree)) return err(422, 'tree does not exist');
      if (!Array.isArray(body.parents) || body.parents.some(x => !commits.has(x))) return err(422, 'parent does not exist');
      if (!body.message) return err(422, 'message required');
      return json(201, { sha: putCommit({ message: body.message, tree: body.tree, parents: body.parents, author: body.author, committer: body.committer }) });
    }
    if (method === 'PATCH' && (m = p.match(/^\/git\/refs\/heads\/(.+)$/))) {
      if (S.beforeRefPatch) S.beforeRefPatch();
      if (!refs.has(m[1])) return err(422, 'Reference does not exist');
      if (!commits.has(body.sha)) return err(422, 'Object does not exist');
      if (!body.force && !isAncestor(refs.get(m[1]), body.sha)) return err(422, 'Update is not a fast forward');
      refs.set(m[1], body.sha); return json(200, { ref: `refs/heads/${m[1]}`, object: { sha: body.sha } });
    }
    return err(404, `test: unhandled ${method} ${p}`);
  };
  // test helpers: look inside, or move the remote underneath the pusher
  S.tip = (b = branch) => refs.get(b);
  S.tree = (b = branch) => { const o = {}; (trees.get(commits.get(refs.get(b)).tree) || []).forEach(e => { o[e.path] = blobs.get(e.sha).toString('utf8'); }); return o; };
  S.entry = (p, b = branch) => trees.get(commits.get(refs.get(b)).tree).find(e => e.path === p);
  S.blobBytes = (p, b = branch) => blobs.get(S.entry(p, b).sha);
  S.history = (b = branch) => { const out = []; let c = refs.get(b); while (c) { const o = commits.get(c); out.push({ sha: c, message: o.message, parents: o.parents.length }); c = o.parents[0]; } return out; };
  S.advance = (files_, b = branch) => { const tr = trees.get(commits.get(refs.get(b)).tree).slice(); Object.entries(files_).forEach(([p, c]) => tr.push({ path: p, mode: '100644', type: 'blob', sha: putBlob(Buffer.from(c)) })); refs.set(b, putCommit({ message: 'someone else', tree: putTree(tr), parents: [refs.get(b)] })); };
  S.remove = (p, b = branch) => { const tr = trees.get(commits.get(refs.get(b)).tree).filter(e => e.path !== p); refs.set(b, putCommit({ message: 'someone else removed ' + p, tree: putTree(tr), parents: [refs.get(b)] })); };
  S.count = (re) => S.log.filter(l => re.test(l)).length;
  S.writes = () => S.log.filter(l => !l.startsWith('GET '));
  return S;
}

// ---- a local repo ------------------------------------------------------------------------------------------------
let cid = 0;
const base = (p) => p.split('/').pop();
const mkRepo = () => ({ objects: {}, refs: { main: null }, stash: [] });
// changes: { '/a.txt': 'text' | null (delete) | Buffer (binary) }
function commit(repo, branch, message, changes, meta = {}) {
  const parent = meta.parent !== undefined ? meta.parent : repo.refs[branch];
  const files = Object.entries(changes).map(([p, v]) => v === null ? { path: p, name: base(p), status: 'deleted', content: '', encoding: 'text' }
    : Buffer.isBuffer(v) ? { path: p, name: base(p), status: 'added', content: v.toString('base64'), encoding: 'base64' }
    : { path: p, name: base(p), status: 'added', content: v, encoding: 'text' });
  const sha = 'c' + String(++cid).padStart(3, '0');
  repo.objects[sha] = { message, author: meta.author || 'you', authorEmail: meta.email || 'you@codemini.local', timestamp: 1700000000000 + cid * 1000, parents: parent ? [parent] : [], files };
  if (!meta.detached) repo.refs[branch] = sha;
  return sha;
}

// ---- the environment ----------------------------------------------------------------------------------------------
function makeEnv({ server, repo, branch = 'main', local = 'main' }) {
  const store = new Map();
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const ui = { results: {}, busy: {} }; const texts = [], notices = [], logs = [], toasts = [];
  const env = { server, repo, branch, local, ui, texts, notices, logs, toasts, store, fields: { ref: { full: 'o/r', owner: 'o', repo: 'r' }, branch } };
  const ctx = vm.createContext({
    console, Map, Set, Array, Object, String, Number, Date, JSON, Promise, Error, RegExp, Uint8Array, TextEncoder, encodeURIComponent, atob, btoa,
    crypto: nodeCrypto.webcrypto, fetch: server.fetch, localStorage: ls,
    window: { renderGitPanel: async () => {}, gitUpdateStatusBranch: () => {} },
    document: { getElementById: () => null },
    db: { name: 'ws' },
    gitUi: () => ui, gitGetToken: () => 'tok', gitNoTokenMessage: () => 'no token',
    gitReadRemoteFields: () => ({ ref: env.fields.ref, branch: env.fields.branch }),
    gitSetRemote: (dbName, full, br) => { ls.setItem(ctx.gitStorageKey(dbName, 'remoteRepo'), full); ls.setItem(ctx.gitStorageKey(dbName, 'remoteBranch'), br); },
    gitLog: (a, m, l) => logs.push({ a, m, l }), gitToast: (m) => toasts.push(m), gitClearNotice: () => {}, gitNotify: (x) => notices.push(x),
    gitAutoClearResult: () => {},
    getGitConfig: () => ({ currentBranch: env.local }), getGitRepo: () => env.repo
  });
  vm.runInContext(code, ctx);
  const origSet = ctx.gitSetResult; ctx.gitSetResult = (u, k, level, text, extra) => { if (k === 'remote') texts.push(text); return origSet(u, k, level, text, extra); };
  env.ctx = ctx;
  env.push = async () => { await ctx.gitPushToGitHub(); return ui.results.remote; };
  env.synced = () => ctx.gitGetSynced('ws', env.fields.branch, 'o/r');
  return env;
}

(async () => {
  console.log('blob ids match real git');
  await t('gitBlobSha agrees with `git hash-object` for text, emoji, binary and empty files', async () => {
    const e = makeEnv({ server: fakeGitHub(), repo: mkRepo() });
    const samples = [Buffer.from('hello\n'), Buffer.from('caf\u00e9 \u{1F600}\n'), Buffer.from([0, 255, 1, 128, 10, 13, 200]), Buffer.alloc(0), Buffer.alloc(70000, 7)];
    for (const buf of samples) {
      const real = execFileSync('git', ['hash-object', '--stdin'], { input: buf }).toString().trim();
      assert.strictEqual(await e.ctx.gitBlobSha(new Uint8Array(buf)), real);
    }
  });
  await t('gitFileBytes: text is UTF-8, base64 files decode to their exact bytes, and base64 round-trips', () => {
    const e = makeEnv({ server: fakeGitHub(), repo: mkRepo() });
    deq(Buffer.from(e.ctx.gitFileBytes({ content: 'h\u00e9 \u{1F600}', encoding: 'text' })), Buffer.from('h\u00e9 \u{1F600}'));
    const bin = Buffer.from(Array.from({ length: 100000 }, (_, i) => i % 256));
    const f = { content: bin.toString('base64'), encoding: 'base64' };
    deq(Buffer.from(e.ctx.gitFileBytes(f)), bin);
    assert.strictEqual(e.ctx.gitBytesToBase64(e.ctx.gitFileBytes(f)), f.content, 'large input (chunked) survives');
  });

  console.log('plan: which commits a push sends');
  await t('incremental: only the commits after the last synced one, oldest first', () => {
    const e = makeEnv({ server: fakeGitHub(), repo: mkRepo() }); const r = e.repo;
    const a = commit(r, 'main', 'one', { '/a': '1' }); commit(r, 'main', 'two', { '/a': '2' }); const c = commit(r, 'main', 'three', { '/b': '3' });
    const plan = e.ctx.gitPlanPush(r, c, a, false);
    assert.strictEqual(plan.mode, 'incremental');
    deq(plan.commits.map(x => x.message), ['two', 'three']);
  });
  await t('full: an empty remote gets the whole first-parent history', () => {
    const e = makeEnv({ server: fakeGitHub(), repo: mkRepo() }); const r = e.repo;
    commit(r, 'main', 'one', { '/a': '1' }); const c = commit(r, 'main', 'two', { '/a': '2' });
    const plan = e.ctx.gitPlanPush(r, c, 'stale-sha-from-another-repo', true);
    assert.strictEqual(plan.mode, 'full'); deq(plan.commits.map(x => x.message), ['one', 'two']);
  });
  await t('squash when nothing is recorded, or the recorded commit is no longer on the line (rewritten history)', () => {
    const e = makeEnv({ server: fakeGitHub(), repo: mkRepo() }); const r = e.repo;
    const a = commit(r, 'main', 'one', { '/a': '1', '/gone': 'x' }); const b = commit(r, 'main', 'two', { '/gone': null, '/c': 'c' });
    const never = e.ctx.gitPlanPush(r, b, null, false);
    assert.strictEqual(never.mode, 'squash'); assert.strictEqual(never.reason, 'unlinked'); assert.strictEqual(never.deletionsKnown, false);
    deq(never.commits[0].files.map(f => f.path).sort(), ['/a', '/c'], 'whole tree, no deletions invented');
    const amended = commit(r, 'main', 'two (amended)', { '/d': 'd' }, { parent: a });
    const rew = e.ctx.gitPlanPush(r, amended, b, false);
    assert.strictEqual(rew.mode, 'squash'); assert.strictEqual(rew.reason, 'rewritten'); assert.strictEqual(rew.deletionsKnown, true);
    assert(rew.commits[0].files.some(f => f.path === '/c' && f.status === 'deleted'), 'the old tip\'s file that the amend dropped is a deletion');
    assert.strictEqual(rew.commits[0].message, 'two (amended)');
  });
  await t('a merge commit is one commit on the first-parent line; the merged-in branch arrives through it', () => {
    const e = makeEnv({ server: fakeGitHub(), repo: mkRepo() }); const r = e.repo;
    const a = commit(r, 'main', 'base', { '/a': '1' });
    const side = commit(r, 'feat', 'side work', { '/s': 's' }, { parent: a, detached: true });
    const m = commit(r, 'main', 'Merge feat', { '/s': 's' }, { parent: a });
    r.objects[m].parents.push(side);
    const plan = e.ctx.gitPlanPush(r, m, a, false);
    deq(plan.commits.map(x => x.message), ['Merge feat']);
  });
  await t('nothing committed -> nothing to plan', () => {
    const e = makeEnv({ server: fakeGitHub(), repo: mkRepo() });
    assert.strictEqual(e.ctx.gitPlanPush(e.repo, null, null, false).mode, 'none');
  });

  console.log('push: real commits, atomically');
  await t('first push to a repository that already has commits: ONE commit (not one per file), nothing from the Contents API', async () => {
    const server = fakeGitHub({ files: { 'README.md': '# hi', 'b.txt': 'same' } });
    const repo = mkRepo(); commit(repo, 'main', 'first', { '/a.txt': 'a1', '/b.txt': 'same' }); commit(repo, 'main', 'second', { '/a.txt': 'a2' }); commit(repo, 'main', 'Add sub dir', { '/src/deep/c.txt': 'c' });
    const e = makeEnv({ server, repo });
    const res = await e.push();
    assert.strictEqual(res.level, 'success', res.text);
    const h = server.history();
    assert.strictEqual(h.length, 2, 'Initial + exactly one pushed commit');
    assert.strictEqual(h[0].message, 'Add sub dir', 'the tip\'s message, not "Update <path> via CodeMini"');
    deq(server.tree(), { 'README.md': '# hi', 'a.txt': 'a2', 'b.txt': 'same', 'src/deep/c.txt': 'c' }, 'remote-only README is kept');
    assert.strictEqual(server.count(/contents/), 0);
    assert.strictEqual(server.count(/^POST \/git\/blobs/), 2, 'b.txt is already on GitHub, so only a.txt and c.txt are uploaded');
    assert.strictEqual(server.count(/^PATCH /), 1, 'one ref update for the whole push');
    assert(/single commit/.test(res.text), 'the user is told it went up as one commit');
  });
  await t('later pushes send each new local commit as its own commit, with its message, in order; deletions sync', async () => {
    const server = fakeGitHub({ files: { 'README.md': '# hi' } });
    const repo = mkRepo(); commit(repo, 'main', 'first', { '/a.txt': 'a1', '/old.txt': 'old', '/keep.txt': 'keep' });
    const e = makeEnv({ server, repo });
    assert.strictEqual((await e.push()).level, 'success');
    const before = server.history().length;
    commit(repo, 'main', 'Change a', { '/a.txt': 'a2' });
    commit(repo, 'main', 'Add new, drop old', { '/new.txt': 'n', '/old.txt': null });
    server.log.length = 0;
    const res = await e.push();
    assert.strictEqual(res.level, 'success', res.text);
    const h = server.history(); assert.strictEqual(h.length, before + 2);
    deq(h.slice(0, 2).map(x => x.message), ['Add new, drop old', 'Change a'], 'newest first on GitHub = oldest-first replay');
    deq(server.tree(), { 'README.md': '# hi', 'a.txt': 'a2', 'keep.txt': 'keep', 'new.txt': 'n' }, 'old.txt deleted; README (never known here) is NOT deleted');
    assert.strictEqual(server.count(/^POST \/git\/blobs/), 2, 'keep.txt is not re-uploaded: only the two changed contents');
    assert.strictEqual(server.count(/^POST \/git\/commits/), 2);
    assert.strictEqual(server.count(/^PATCH /), 1);
    assert(/2 commits/.test(res.text) && /1 deleted/.test(res.text), res.text);
    assert(!/single commit/.test(res.text));
  });
  await t('deleting locally a file that someone already removed on GitHub is not an error (nothing to delete there)', async () => {
    const server = fakeGitHub({ files: { 'README.md': 'r' } });
    const repo = mkRepo(); commit(repo, 'main', 'c1', { '/a': '1', '/b': '2' }); const e = makeEnv({ server, repo }); await e.push();
    server.remove('b'); commit(repo, 'main', 'c2', { '/b': null, '/a': '1b' });
    const res = await e.push();
    assert.strictEqual(res.level, 'success', res.text); deq(server.tree(), { 'README.md': 'r', a: '1b' });
  });
  await t('pushing again with nothing new changes nothing on GitHub (reads only)', async () => {
    const server = fakeGitHub({ files: { 'README.md': '# hi' } });
    const repo = mkRepo(); commit(repo, 'main', 'first', { '/a.txt': 'a1' });
    const e = makeEnv({ server, repo }); await e.push();
    server.log.length = 0;
    const res = await e.push();
    assert.strictEqual(res.level, 'success'); assert(/Nothing to push/.test(res.text), res.text);
    deq(server.writes(), [], 'no writes at all');
  });
  await t('a file already on GitHub with identical content is skipped even if a commit re-adds it (blob ids match GitHub\'s)', async () => {
    const server = fakeGitHub({ files: { 'a.txt': 'caf\u00e9 \u{1F600}' } });
    const repo = mkRepo(); commit(repo, 'main', 'first', { '/a.txt': 'caf\u00e9 \u{1F600}' });
    const e = makeEnv({ server, repo });
    const res = await e.push();
    assert(/Nothing to push/.test(res.text), res.text); deq(server.writes(), []);
  });
  await t('content GitHub already holds under another path (a copy or rename) is referenced, not uploaded again', async () => {
    const server = fakeGitHub({ files: { 'old/name.txt': 'shared content', 'README.md': 'r' } });
    const repo = mkRepo(); commit(repo, 'main', 'c1', { '/old/name.txt': 'shared content' });
    const e = makeEnv({ server, repo }); await e.push();
    commit(repo, 'main', 'rename', { '/new/name.txt': 'shared content', '/old/name.txt': null });
    server.log.length = 0;
    const res = await e.push();
    assert.strictEqual(res.level, 'success', res.text);
    assert.strictEqual(server.count(/^POST \/git\/blobs/), 0, 'the bytes are already in the repository');
    deq(server.tree(), { 'README.md': 'r', 'new/name.txt': 'shared content' });
  });
  await t('binary files arrive byte for byte; an executable keeps its mode', async () => {
    const server = fakeGitHub({ files: { 'run.sh': { c: '#!/bin/sh\necho 1\n', mode: '100755' } } });
    const bin = Buffer.from([0, 255, 1, 128, 10, 13, 200, 0, 0, 9]);
    const repo = mkRepo(); commit(repo, 'main', 'first', { '/img.png': bin, '/run.sh': '#!/bin/sh\necho 2\n' });
    const e = makeEnv({ server, repo });
    assert.strictEqual((await e.push()).level, 'success');
    deq(server.blobBytes('img.png'), bin);
    assert.strictEqual(server.entry('run.sh').mode, '100755');
    assert.strictEqual(server.tree()['run.sh'], '#!/bin/sh\necho 2\n');
  });
  await t('a pushed commit with a real identity keeps author and date; a default @codemini.local one is left for GitHub to attribute', async () => {
    const server = fakeGitHub({ files: { 'x': 'x' } });
    const repo = mkRepo(); const a = commit(repo, 'main', 'first', { '/a': '1' }, { author: 'Ada', email: 'ada@example.com' });
    const e = makeEnv({ server, repo }); await e.push();
    commit(repo, 'main', 'second', { '/a': '2' }, { author: 'Ada', email: 'ada@example.com' });
    commit(repo, 'main', 'third', { '/a': '3' }, { author: 'me', email: 'me@codemini.local' });
    server.commitBodies.length = 0; await e.push();
    const [second, third] = server.commitBodies;
    assert.strictEqual(second.author.name, 'Ada'); assert.strictEqual(second.author.email, 'ada@example.com');
    assert.strictEqual(second.author.date, new Date(1700000000000 + (cid - 1) * 1000).toISOString());
    deq(second.committer, second.author);
    assert.strictEqual(third.author, undefined); assert.strictEqual(third.committer, undefined);
  });
  await t('rewritten history (amend after a push): one commit, and the file the amend dropped is deleted', async () => {
    const server = fakeGitHub({ files: { 'README.md': 'r' } });
    const repo = mkRepo(); const c1 = commit(repo, 'main', 'one', { '/a': '1' }); const e = makeEnv({ server, repo }); await e.push();
    commit(repo, 'main', 'two', { '/x.txt': 'x' }); await e.push();
    assert.strictEqual(server.tree()['x.txt'], 'x');
    commit(repo, 'main', 'two (amended)', { '/y.txt': 'y' }, { parent: c1 }); // replaces the tip; the old object stays in the store
    const before = server.history().length;
    const res = await e.push();
    assert.strictEqual(res.level, 'success', res.text);
    assert.strictEqual(server.history().length, before + 1);
    assert.strictEqual(server.history()[0].message, 'two (amended)');
    const tree = server.tree(); assert.strictEqual(tree['x.txt'], undefined); assert.strictEqual(tree['y.txt'], 'y'); assert.strictEqual(tree['README.md'], 'r');
    assert(/rebase, reset or amend/.test(res.text), res.text);
  });
  await t('an empty repository: the first file goes through the Contents API, then the FULL history arrives', async () => {
    for (const emptyRefStatus of [404, 409]) {
      const server = fakeGitHub({ emptyRefStatus });
      const repo = mkRepo(); commit(repo, 'main', 'c1', { '/a.txt': 'a1', '/b.txt': 'b' }); commit(repo, 'main', 'c2', { '/a.txt': 'a2' }); commit(repo, 'main', 'c3', { '/b.txt': null, '/c.txt': 'c' });
      const e = makeEnv({ server, repo });
      const res = await e.push();
      assert.strictEqual(res.level, 'success', `${emptyRefStatus}: ${res.text}`);
      deq(server.history().map(h => h.message), ['c3', 'c2', 'c1', 'Initial commit via CodeMini'], 'every local commit message arrived');
      deq(server.tree(), { 'a.txt': 'a2', 'c.txt': 'c' });
      assert.strictEqual(server.count(/^PUT \/contents/), 1, 'exactly one Contents-API write: the bootstrap');
      assert.strictEqual(server.history().slice(-1)[0].parents, 0);
    }
  });
  await t('an empty repository that refuses an explicit branch: retried without it when the branch is the default; otherwise a clear failure', async () => {
    const server = fakeGitHub({ refuseBranchOnEmpty: true });
    const repo = mkRepo(); commit(repo, 'main', 'c1', { '/a': '1' }); commit(repo, 'main', 'c2', { '/a': '2', '/b': 'b' });
    const e = makeEnv({ server, repo });
    const res = await e.push();
    assert.strictEqual(res.level, 'success', res.text);
    deq(server.history().map(h => h.message), ['c2', 'c1', 'Initial commit via CodeMini']); deq(server.tree(), { a: '2', b: 'b' });
    const s2 = fakeGitHub({ refuseBranchOnEmpty: true, defaultBranch: 'trunk' }); const e2 = makeEnv({ server: s2, repo });
    const r2 = await e2.push();
    assert.strictEqual(r2.level, 'error'); assert(/Branch not found/.test(r2.text)); assert(/Nothing was changed on GitHub/.test(r2.text)); assert.strictEqual(s2.tip(), undefined);
  });
  await t('an empty repository with an empty committed tree has nothing to push', async () => {
    const server = fakeGitHub(); const repo = mkRepo(); commit(repo, 'main', 'add', { '/a': '1' }); commit(repo, 'main', 'remove', { '/a': null });
    const e = makeEnv({ server, repo }); const res = await e.push();
    assert.strictEqual(res.level, 'error'); assert(/Nothing committed yet/.test(res.text)); deq(server.writes(), []);
  });
  await t('nothing committed at all -> the same message as before, and the network is never touched', async () => {
    const server = fakeGitHub({ files: { a: 'a' } }); const e = makeEnv({ server, repo: mkRepo() });
    const res = await e.push();
    assert.strictEqual(res.level, 'error'); assert(/Nothing committed yet to push/.test(res.text)); deq(server.log, []);
  });

  console.log('push: failure leaves GitHub untouched');
  await t('a request failing midway changes nothing on GitHub, records nothing locally, and a retry completes', async () => {
    const server = fakeGitHub({ files: { 'README.md': 'r' } });
    const repo = mkRepo(); commit(repo, 'main', 'c1', { '/a': '1', '/b': '2', '/c': '3' });
    const e = makeEnv({ server, repo }); const tipBefore = server.tip(), treeBefore = server.tree();
    let blobs = 0; server.failWhen = (m, p) => (m === 'POST' && p === '/git/blobs' && ++blobs === 2 ? { status: 500, message: 'Server Error' } : null);
    const res = await e.push();
    assert.strictEqual(res.level, 'error'); assert(/Nothing was changed on GitHub/.test(res.text), res.text);
    assert.strictEqual(server.tip(), tipBefore, 'the branch did not move'); deq(server.tree(), treeBefore);
    assert.strictEqual(server.count(/^PATCH /), 0);
    assert.strictEqual(e.synced(), null, 'no "synced" record for a push that did not happen');
    assert.strictEqual(e.notices.length, 1); assert(/Nothing was changed/.test(e.notices[0].text));
    server.failWhen = null;
    const retry = await e.push();
    assert.strictEqual(retry.level, 'success', retry.text); deq(server.tree(), { 'README.md': 'r', a: '1', b: '2', c: '3' });
    assert.strictEqual(e.ui.busy.sync, false, 'busy flag always cleared');
  });
  await t('a full browser-storage quota AFTER the push finished does not turn it into a reported failure', async () => {
    const server = fakeGitHub({ files: { 'README.md': 'r' } });
    const repo = mkRepo(); commit(repo, 'main', 'c1', { '/a': '1' }); const e = makeEnv({ server, repo });
    const set = e.store.set.bind(e.store); const real = e.ctx.localStorage.setItem;
    e.ctx.localStorage.setItem = (k, v) => { if (/remotetrack_|synced_/.test(k)) throw new Error('QuotaExceededError'); return real(k, v); };
    const res = await e.push();
    assert.strictEqual(res.level, 'success', res.text); assert.strictEqual(server.tree()['a'], '1'); assert.strictEqual(e.notices.length, 0);
  });
  await t('a failure AFTER an empty repository got its first commit says so truthfully, and a retry finishes the job', async () => {
    const server = fakeGitHub();
    const repo = mkRepo(); commit(repo, 'main', 'c1', { '/a.txt': 'a', '/b.txt': 'b' }); commit(repo, 'main', 'c2', { '/b.txt': 'b2' });
    const e = makeEnv({ server, repo });
    server.failWhen = (m, p) => (m === 'POST' && p === '/git/blobs' ? { status: 500, message: 'Server Error' } : null);
    const res = await e.push();
    assert.strictEqual(res.level, 'error');
    assert(/first commit/.test(res.text) && /push again to finish/.test(res.text), res.text);
    assert(!/Nothing was changed on GitHub/.test(res.text), 'it must not claim the remote is untouched');
    deq(server.history().map(h => h.message), ['Initial commit via CodeMini'], 'the bootstrap commit really is there');
    assert.strictEqual(e.synced(), null);
    server.failWhen = null;
    const retry = await e.push();
    assert.strictEqual(retry.level, 'success', retry.text); deq(server.tree(), { 'a.txt': 'a', 'b.txt': 'b2' });
    assert.strictEqual(server.history()[0].message, 'c2');
  });
  await t('the branch moving on GitHub during the push -> refused (not forced), nothing lost, a clear message', async () => {
    const server = fakeGitHub({ files: { 'README.md': 'r' } });
    const repo = mkRepo(); commit(repo, 'main', 'c1', { '/a': '1' });
    const e = makeEnv({ server, repo });
    server.beforeRefPatch = () => { server.beforeRefPatch = null; server.advance({ 'theirs.txt': 't' }); };
    const res = await e.push();
    assert.strictEqual(res.level, 'error'); assert(/changed on GitHub while you were pushing/.test(res.text), res.text);
    assert.strictEqual(server.tree()['theirs.txt'], 't', 'their commit is still the tip');
    assert.strictEqual(server.tree()['a'], undefined, 'our files were not forced in');
    assert.strictEqual(e.synced(), null);
    assert.strictEqual((text => (text.match(/Nothing was changed/g) || []).length)(res.text), 1, 'the message does not say it twice');
  });
  await t('a different 422 (protected branch) keeps GitHub\'s own wording instead of the "branch moved" message', async () => {
    const server = fakeGitHub({ files: { 'README.md': 'r' } });
    const repo = mkRepo(); commit(repo, 'main', 'c1', { '/a': '1' });
    const e = makeEnv({ server, repo });
    server.failWhen = (m) => (m === 'PATCH' ? { status: 422, message: 'Protected branch update failed' } : null);
    const res = await e.push();
    assert(/Protected branch update failed/.test(res.text)); assert(!/while you were pushing/.test(res.text));
  });
  await t('a branch that does not exist on a non-empty repository is an error, not something silently created; same for a prefix-only match', async () => {
    const server = fakeGitHub({ files: { a: 'a' } });
    const repo = mkRepo(); commit(repo, 'main', 'c1', { '/a': '1' });
    const e = makeEnv({ server, repo }); e.fields.branch = 'dev';
    const res = await e.push();
    assert.strictEqual(res.level, 'error'); assert(/branch "dev" doesn't exist on o\/r/.test(res.text), res.text); deq(server.writes(), []);
    const s2 = fakeGitHub({ files: { a: 'a' }, branch: 'feature/x' }); const e2 = makeEnv({ server: s2, repo, branch: 'feature' });
    const r2 = await e2.push(); assert(/branch "feature" doesn't exist/.test(r2.text), r2.text); deq(s2.writes(), []);
  });
  await t('a repository GitHub cannot find gets a plain explanation', async () => {
    const server = fakeGitHub({ missingRepo: true }); const repo = mkRepo(); commit(repo, 'main', 'c1', { '/a': '1' });
    const e = makeEnv({ server, repo }); const res = await e.push();
    assert(/can't find o\/r/.test(res.text), res.text);
  });
  await t('if GitHub reports the remote tree as too big to list: files still go up, deletions are skipped, and it says so', async () => {
    const server = fakeGitHub({ files: { 'README.md': 'r' } });
    const repo = mkRepo(); commit(repo, 'main', 'c1', { '/a': '1', '/gone': 'g' }); const e = makeEnv({ server, repo }); await e.push();
    commit(repo, 'main', 'c2', { '/a': '2', '/gone': null });
    server.truncate = true;
    const res = await e.push();
    assert.strictEqual(res.level, 'success', res.text);
    assert.strictEqual(server.tree()['a'], '2'); assert.strictEqual(server.tree()['gone'], 'g', 'not deleted: it could not be checked');
    assert(/too large to compare/.test(res.text), res.text);
  });

  console.log('bookkeeping');
  await t('the synced record is only trusted for the repository it was recorded against', async () => {
    const server = fakeGitHub({ files: { 'README.md': 'r' } });
    const repo = mkRepo(); commit(repo, 'main', 'c1', { '/a': '1' }); const e = makeEnv({ server, repo }); await e.push();
    assert.strictEqual(e.synced().repo, 'o/r');
    assert(e.ctx.gitGetSynced('ws', 'main', 'O/R'), 'repo names compare case-insensitively');
    assert.strictEqual(e.ctx.gitGetSynced('ws', 'main', 'someone/else'), null);
  });
  await t('pushing to a different repository sends everything again instead of only what is new since the last (other) push', async () => {
    const s1 = fakeGitHub({ files: { 'README.md': 'r' } });
    const repo = mkRepo(); commit(repo, 'main', 'c1', { '/a': '1' }); commit(repo, 'main', 'c2', { '/b': '2' });
    const e = makeEnv({ server: s1, repo }); await e.push();
    commit(repo, 'main', 'c3', { '/c': '3' });
    const s2 = fakeGitHub({ files: { 'README.md': 'other' } });
    e.ctx.fetch = s2.fetch; e.fields.ref = { full: 'o/other', owner: 'o', repo: 'other' };
    // the fake routes everything under /repos/o/r, so keep the fake's path while the app believes it is another repo
    const realFetch = s2.fetch; e.ctx.fetch = (u, o) => realFetch(u.replace('/repos/o/other', '/repos/o/r'), o);
    await e.push();
    deq(s2.tree(), { 'README.md': 'other', a: '1', b: '2', c: '3' }, 'a and b were sent too, not only c');
  });
  await t('a pull records where the next push starts (source check)', () => {
    const b = grab('const doPull = async () => {', 'const doCheckAndPull');
    assert(/gitSaveSynced\(dbName, branch, \{ repo: ref\.full, localSha: repo\.refs\[config\.currentBranch\]/.test(b));
    assert(b.indexOf('gitSaveSynced(') > b.indexOf('gitMoveRef(') , 'recorded after the pull commit exists');
  });
  await t('unpushed count: 0 right after a push, then one per new commit (the old count used the remote\'s own id and never went down)', async () => {
    const server = fakeGitHub({ files: { 'README.md': 'r' } });
    const repo = mkRepo(); commit(repo, 'main', 'c1', { '/a': '1' }); commit(repo, 'main', 'c2', { '/a': '2' });
    const e = makeEnv({ server, repo });
    assert.strictEqual(e.ctx.gitCountUnpushed('ws', repo, 'main'), 0, 'no remote known yet');
    await e.push();
    assert.strictEqual(e.ctx.gitCountUnpushed('ws', repo, 'main'), 0);
    commit(repo, 'main', 'c3', { '/a': '3' }); assert.strictEqual(e.ctx.gitCountUnpushed('ws', repo, 'main'), 1);
    commit(repo, 'main', 'c4', { '/a': '4' }); assert.strictEqual(e.ctx.gitCountUnpushed('ws', repo, 'main'), 2);
    await e.push(); assert.strictEqual(e.ctx.gitCountUnpushed('ws', repo, 'main'), 0);
  });
  await t('checked but never pushed from here: every commit counts as unpushed (same as before this change)', async () => {
    const repo = mkRepo(); commit(repo, 'main', 'c1', { '/a': '1' }); commit(repo, 'main', 'c2', { '/a': '2' });
    const e = makeEnv({ server: fakeGitHub(), repo });
    e.store.set(e.ctx.gitStorageKey('ws', 'remoteRepo'), 'o/r');
    e.ctx.gitSaveRemoteTracking('ws', 'main', { branchSha: 'abc', message: '', fetchedAt: 1 });
    assert.strictEqual(e.ctx.gitCountUnpushed('ws', repo, 'main'), 2);
  });

  console.log('the Remote tab note');
  await t('says what Push will send, and that uncommitted changes stay behind', async () => {
    const server = fakeGitHub({ files: { 'README.md': 'r' } });
    const repo = mkRepo(); const e = makeEnv({ server, repo });
    const note = (unc) => e.ctx.gitPushNoteHtml('ws', repo, { currentBranch: 'main' }, 'o/r', 'main', unc).replace(/<[^>]+>/g, '');
    assert.strictEqual(note(0), ' Nothing is committed on main yet, so there is nothing to push.');
    assert.strictEqual(note(2), ' Nothing is committed on main yet, so there is nothing to push (2 uncommitted changes not included).');
    commit(repo, 'main', 'c1', { '/a': '1' });
    assert.strictEqual(note(3), ' Pushes the last commit on main (3 uncommitted changes not included).', 'the wording asked for');
    assert.strictEqual(note(1), ' Pushes the last commit on main (1 uncommitted change not included).');
    assert.strictEqual(note(0), ' Pushes the last commit on main.');
    await e.push();
    assert.strictEqual(note(0), ' Nothing new to push: main has no commits since the last push.');
    assert.strictEqual(note(4), ' Nothing new to push: main has no commits since the last push (4 uncommitted changes not included).');
    commit(repo, 'main', 'c2', { '/a': '2' }); assert.strictEqual(note(0), ' Pushes the last commit on main.');
    commit(repo, 'main', 'c3', { '/a': '3' }); assert.strictEqual(note(5), ' Pushes the 2 commits on main since the last push (5 uncommitted changes not included).');
    assert.strictEqual(e.ctx.gitPushNoteHtml('ws', repo, { currentBranch: 'main' }, 'someone/else', 'main', 0).replace(/<[^>]+>/g, ''), ' Pushes the last commit on main.', 'a different repo: no earlier push to compare with');
  });
  await t('the branch name is escaped', () => {
    const e = makeEnv({ server: fakeGitHub(), repo: mkRepo() });
    const html = e.ctx.gitPushNoteHtml('ws', mkRepo(), { currentBranch: '<img src=x onerror=1>' }, '', 'main', 0);
    assert(!/<img/.test(html) && /&lt;img/.test(html));
  });
  await t('the tab renders the note above the Push button and passes the uncommitted count in', () => {
    const tab = grab('function renderRemoteTab(', '\n    const r = state.repos;');
    assert(tab.indexOf('gitPushNoteHtml(') > 0 && tab.indexOf('gitPushNoteHtml(') < tab.indexOf('data-git-action="push"'));
    assert(/renderRemoteTab\(dbName, uiState, allChanges\.length\)/.test(src));
  });

  await t('renderRemoteTab itself runs with the new argument: the note sits between the branch field and the buttons', async () => {
    // the real function, with a stand-in for every other git* helper it calls
    const tabSrc = grab('function renderRemoteTab(', '\n// ', ) ;
    const e = makeEnv({ server: fakeGitHub(), repo: mkRepo() });
    commit(e.repo, 'main', 'c1', { '/a': '1' });
    const names = new Set((tabSrc.match(/\b(?:git|getGit)[A-Za-z]*(?=\()/g) || []));
    const sandbox = { gitGetLog: () => [], gitGetGhProfile: () => ({ login: 'me' }), gitGetToken: () => 'tok', gitDraft: (u, id, fb) => fb, gitParseRepoRef: (v) => (v ? { full: v } : null),
      gitGHState: () => ({ branches: {}, repos: { loaded: true, items: [], scope: 'owner', loading: false, hasMore: false } }), gitSectionOpen: () => false,
      getGitConfig: () => ({ currentBranch: 'main' }), getGitRepo: () => e.repo, gitGetRemoteTracking: () => null, gitStorageKey: e.ctx.gitStorageKey,
      gitEsc: e.ctx.gitEsc, gitPushNoteHtml: e.ctx.gitPushNoteHtml, gitGetSynced: e.ctx.gitGetSynced, gitFirstParentLine: e.ctx.gitFirstParentLine, localStorage: e.ctx.localStorage, console, Object };
    names.forEach(nm => { if (!(nm in sandbox) && nm !== 'renderRemoteTab') sandbox[nm] = () => ''; });
    const c2 = vm.createContext(sandbox); vm.runInContext(tabSrc, c2);
    e.store.set(e.ctx.gitStorageKey('ws', 'remoteRepo'), 'o/r');
    const html = c2.renderRemoteTab('ws', { busy: {}, results: {}, drafts: {}, sections: {} }, 3);
    const iNote = html.indexOf('id="gitPushNote"'), iBranch = html.indexOf('id="gitRemoteBranchInput"'), iPush = html.indexOf('data-git-action="push"');
    assert(iBranch > 0 && iNote > iBranch && iPush > iNote, 'order: branch field, note, buttons');
    assert(/Pushes the last commit on <strong>main<\/strong> \(<strong>3 uncommitted changes<\/strong> not included\)\./.test(html), html.slice(iNote, iNote + 260));
    assert(/never sent/.test(html), 'the help text says uncommitted changes are never sent');
    const noToken = makeEnv({ server: fakeGitHub(), repo: mkRepo() });
    c2.gitGetToken = () => ''; assert(!/gitPushNote/.test(c2.renderRemoteTab('ws', { busy: {}, results: {}, drafts: {}, sections: {} }, 3)), 'no token: the connect prompt, no push note');
  });

  console.log('wiring (source checks)');
  await t('the old one-commit-per-file push is gone', () => {
    assert(!/Update \$\{path\} via CodeMini/.test(src), 'no per-file commit message');
    const push = grab('async function gitSendCommitsToRemote(', '// User-facing "Fetch"');
    assert.strictEqual((push.match(/method: 'PUT'/g) || []).length, 1, 'the only PUT is the empty-repository bootstrap');
    assert(/force: false/.test(push), 'the ref update is never forced');
    assert(!/force: true/.test(src));
  });
  await t('stale statements about per-file pushing are gone from the comments', () => {
    assert(!/per-file Contents-API push/.test(src)); assert(!/one GitHub commit per file, see/.test(src));
  });
  await t('every ahead count in the UI goes through gitCountUnpushed (none uses the remote\'s own commit id)', () => {
    assert(!/gitCountAhead\([^)]*tracking\.branchSha/.test(src));
  });

  console.log(`\n${n} passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
