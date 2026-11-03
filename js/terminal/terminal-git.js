// ==========================================
// terminal-git.js
// ==========================================
// The `git` command of the integrated Terminal.
//
// It works on exactly the same data as the Source Control panel (js/git/git.js): the repository of a
// database (a profile's root, or a workspace) is kept in localStorage + the 'gitobjects' IndexedDB store, and
// the "index" is the list of staged paths. This file never keeps a copy of any of it, so a commit made here
// shows up in the panel and the other way round, and nothing has to be kept in step.
//
// It is a separate file because git.js is written around the panel: most of its actions read the Explorer's
// global `db`, read their input from the panel's form fields, and ask for confirmation with a dialog. The
// terminal is bound to its OWN database (see isolatedDbName in terminal-window.js), which can differ from the
// Explorer's, and it must not pop dialogs. So this file uses git.js's building blocks that take a database
// or a database name (trees, changes, commit objects, refs, the reflog, merge, ignore rules) and adds the
// command-line behaviour around them.
//
// Where the panel and real git differ, the terminal follows real git where that is safer: switching
// branches or merging with uncommitted work is refused (use -f, or `git stash`) instead of discarding it,
// and files that .gitignore hides are left alone instead of being deleted by a checkout.
//
// Not here: push, pull, fetch and clone (they drive the panel's Remote form and need the network), and
// rebase, cherry-pick and revert (their pause-and-continue flow lives in the panel). `git help` says so.
//
// The only entry point is window.CodeMiniGitCli.run(argv, ctx); see the comment above `run` for ctx.
(function () {
    'use strict';

    const esc = (v) => window.CodeMiniEscape.html(v);
    const COLOR = { green: 'var(--term-green)', red: 'var(--term-red)', yellow: 'var(--term-yellow)', blue: 'var(--term-blue)', muted: 'var(--term-muted)' };
    const paint = (color, text) => `<span style="color:${color}">${esc(text)}</span>`;

    class GitFatal extends Error {}
    const fatal = (message) => { throw new GitFatal(message); };

    // ---------------------------------------------------------------------------------------------------------
    // Output: lines are collected and printed as ONE preformatted block, so spacing survives and a pipe
    // (`git log | grep fix`) sees plain text. Everything put in a line is already HTML-escaped.
    function makeOut(ctx) {
        const lines = [];
        return {
            line: (html) => { lines.push(html === undefined ? '' : html); },
            text: (text) => { lines.push(esc(text)); },
            flush() {
                if (!lines.length) return;
                ctx.printHtml(`<pre style="margin:0; font-family:inherit; white-space:pre-wrap; word-break:break-all; color:var(--term-output-text);">${lines.join('\n')}</pre>`);
                lines.length = 0;
            }
        };
    }

    // ---------------------------------------------------------------------------------------------------------
    // Options. spec.flags: { '-a': 'all', '--all': 'all' }   spec.values: { '-m': 'message', '--message': 'message' }
    // Values are collected into arrays (so `-m a -m b` works). Handles `--name=value`, clusters such as `-am "x"`
    // and `-mx`, and `--` (everything after it is a path). spec.dashNumber turns `-5` into opts.number = 5.
    function parseOpts(argv, spec) {
        const opts = { rest: [], afterDashes: [], hasDashes: false };
        const flags = spec.flags || {}, values = spec.values || {};
        const addValue = (key, v) => { (opts[key] = opts[key] || []).push(v); };
        for (let i = 0; i < argv.length; i++) {
            const a = argv[i];
            if (opts.hasDashes) { opts.afterDashes.push(a); continue; }
            if (a === '--') { opts.hasDashes = true; continue; }
            if (a.startsWith('--')) {
                const eq = a.indexOf('=');
                const name = eq > 0 ? a.slice(0, eq) : a;
                const inline = eq > 0 ? a.slice(eq + 1) : undefined;
                if (Object.prototype.hasOwnProperty.call(flags, name)) opts[flags[name]] = true;
                else if (Object.prototype.hasOwnProperty.call(values, name)) {
                    const v = inline !== undefined ? inline : argv[++i];
                    if (v === undefined) fatal(`option '${name.slice(2)}' requires a value`);
                    addValue(values[name], v);
                } else fatal(`unknown option: ${name}`);
            } else if (spec.dashNumber && /^-\d+$/.test(a)) {
                opts.number = parseInt(a.slice(1), 10);
            } else if (a.length > 1 && a[0] === '-') {
                for (let j = 1; j < a.length; j++) {
                    const f = '-' + a[j];
                    if (Object.prototype.hasOwnProperty.call(flags, f)) opts[flags[f]] = true;
                    else if (Object.prototype.hasOwnProperty.call(values, f)) {
                        const attached = a.slice(j + 1);
                        const v = attached !== '' ? attached : argv[++i];
                        if (v === undefined) fatal(`switch '${a[j]}' requires a value`);
                        addValue(values[f], v);
                        break;
                    } else fatal(`unknown switch: ${a[j]}`);
                }
            } else opts.rest.push(a);
        }
        return opts;
    }
    const lastOf = (list) => (list && list.length ? list[list.length - 1] : undefined);

    // ---------------------------------------------------------------------------------------------------------
    // Paths. Repository paths look like "/src/app.js" (the same as in git.js). The terminal's folder stack
    // gives the current folder; ctx.cwd is the list of folder names below the repository root.
    function resolveSpec(ctx, spec) {
        const base = spec.startsWith('/') ? '' : (ctx.cwd.length ? '/' + ctx.cwd.join('/') : '');
        const parts = [];
        for (const seg of (base + '/' + spec).split('/')) {
            if (!seg || seg === '.') continue;
            if (seg === '..') { if (!parts.length) fatal(`'${spec}' is outside the repository`); parts.pop(); } else parts.push(seg);
        }
        return '/' + parts.join('/');
    }
    // A path matches a spec if it is that file, is inside that folder, or matches its * / ? pattern.
    function specMatcher(abs) {
        if (abs === '/') return () => true;
        if (/[*?]/.test(abs)) {
            const re = new RegExp('^' + abs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '(/.*)?$');
            return (p) => re.test(p);
        }
        return (p) => p === abs || p.startsWith(abs + '/');
    }
    // How a path is shown: relative to the current folder, like real git.
    function displayPath(ctx, path) {
        const target = path.split('/').filter(Boolean), here = ctx.cwd;
        let common = 0;
        while (common < here.length && common < target.length - 1 && here[common] === target[common]) common++;
        return '../'.repeat(here.length - common) + target.slice(common).join('/');
    }

    // ---------------------------------------------------------------------------------------------------------
    // Revisions: HEAD, a branch, a tag, a (unique) commit id prefix, each followed by any of ~N and ^N.
    const headSha = (R) => R.repo.refs[R.config.currentBranch] || null;
    function resolveRev(R, spec) {
        const base = spec.replace(/([~^]\d*)+$/, '');
        const steps = spec.slice(base.length).match(/[~^]\d*/g) || [];
        let sha = null;
        if (base === 'HEAD' || base === '@') {
            sha = headSha(R);
            if (!sha) fatal(`your current branch '${R.config.currentBranch}' does not have any commits yet`);
        } else if (gitBranchExists(R.repo, base)) sha = R.repo.refs[base];
        else if (gitTagExists(R.repo, base)) sha = R.repo.tags[base].sha;
        else if (/^[0-9a-f]{4,40}$/i.test(base)) {
            const hits = Object.keys(R.repo.objects).filter((s) => s.startsWith(base.toLowerCase()));
            if (hits.length > 1) fatal(`short object ID ${base} is ambiguous`);
            sha = hits[0] || null;
        }
        if (!sha || !R.repo.objects[sha]) fatal(`bad revision '${spec}'`);
        for (const step of steps) {
            const n = step.length > 1 ? parseInt(step.slice(1), 10) : 1;
            if (step[0] === '~') {
                for (let i = 0; i < n; i++) {
                    const parent = R.repo.objects[sha] && R.repo.objects[sha].parents[0];
                    if (!parent || !R.repo.objects[parent]) fatal(`bad revision '${spec}'`);
                    sha = parent;
                }
            } else if (n > 0) {
                const parent = R.repo.objects[sha].parents[n - 1];
                if (!parent || !R.repo.objects[parent]) fatal(`bad revision '${spec}'`);
                sha = parent;
            }
        }
        return sha;
    }
    const subject = (commit) => String((commit && commit.message) || '').split('\n')[0];

    // sha -> ["HEAD -> main", "dev", "tag: v1"], shown after the id in `git log`
    function decorations(R) {
        const map = new Map();
        const add = (sha, label) => { if (sha) { if (!map.has(sha)) map.set(sha, []); map.get(sha).push(label); } };
        Object.keys(R.repo.refs).forEach((name) => add(R.repo.refs[name], name === R.config.currentBranch ? `HEAD -> ${name}` : name));
        Object.keys(R.repo.tags).forEach((name) => add(R.repo.tags[name].sha, `tag: ${name}`));
        map.forEach((labels) => labels.sort((a, b) => (b.startsWith('HEAD') ? 1 : 0) - (a.startsWith('HEAD') ? 1 : 0)));
        return map;
    }

    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function gitDate(ts) {
        const d = new Date(ts), pad = (n) => String(n).padStart(2, '0');
        const off = -d.getTimezoneOffset(), a = Math.abs(off);
        return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()} ${off < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}${pad(a % 60)}`;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Diff. Written here (not the panel's CDN diff library) so the terminal works offline. A line is a token
    // {text, eol}; a last line without a newline differs from the same text with one, as in real git.
    const DIFF_MAX_CELLS = 2500000;
    function tokenize(text) {
        if (!text) return [];
        const parts = text.split('\n');
        const toks = [];
        for (let i = 0; i < parts.length; i++) {
            const last = i === parts.length - 1;
            if (last && parts[i] === '') break; // the text ended with a newline
            toks.push({ text: parts[i], eol: !last, key: parts[i] + (last ? '\u0001' : '\n') });
        }
        return toks;
    }
    function diffTokens(a, b) {
        let s = 0;
        while (s < a.length && s < b.length && a[s].key === b[s].key) s++;
        let ea = a.length, eb = b.length;
        while (ea > s && eb > s && a[ea - 1].key === b[eb - 1].key) { ea--; eb--; }
        const ops = [];
        for (let i = 0; i < s; i++) ops.push({ t: ' ', tok: a[i] });
        const n = ea - s, m = eb - s;
        if (n * m > DIFF_MAX_CELLS) { // too big to compare line by line: show the middle as replaced
            for (let i = s; i < ea; i++) ops.push({ t: '-', tok: a[i] });
            for (let j = s; j < eb; j++) ops.push({ t: '+', tok: b[j] });
        } else {
            const w = m + 1;
            const dp = new Uint32Array((n + 1) * w);
            for (let i = n - 1; i >= 0; i--) {
                for (let j = m - 1; j >= 0; j--) {
                    dp[i * w + j] = a[s + i].key === b[s + j].key ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
                }
            }
            let i = 0, j = 0;
            while (i < n && j < m) {
                if (a[s + i].key === b[s + j].key) { ops.push({ t: ' ', tok: a[s + i] }); i++; j++; }
                else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push({ t: '-', tok: a[s + i] }); i++; }
                else { ops.push({ t: '+', tok: b[s + j] }); j++; }
            }
            while (i < n) { ops.push({ t: '-', tok: a[s + i] }); i++; }
            while (j < m) { ops.push({ t: '+', tok: b[s + j] }); j++; }
        }
        for (let i = ea; i < a.length; i++) ops.push({ t: ' ', tok: a[i] });
        return ops;
    }
    const isBinaryFile = (f) => !!f && f.encoding === 'base64';
    function countChanges(oldFile, newFile) {
        if (isBinaryFile(oldFile) || isBinaryFile(newFile)) return { add: 0, del: 0, binary: true };
        const ops = diffTokens(tokenize(oldFile ? oldFile.content : ''), tokenize(newFile ? newFile.content : ''));
        return { add: ops.filter((o) => o.t === '+').length, del: ops.filter((o) => o.t === '-').length, binary: false };
    }
    // One file as a unified diff (3 lines of context), as coloured HTML lines.
    function patchLines(path, oldFile, newFile) {
        const p = path.replace(/^\//, '');
        const head = [paint(COLOR.muted, `diff --git a/${p} b/${p}`)];
        if (!oldFile) head.push(paint(COLOR.muted, 'new file mode 100644'));
        if (!newFile) head.push(paint(COLOR.muted, 'deleted file mode 100644'));
        if (isBinaryFile(oldFile) || isBinaryFile(newFile)) {
            head.push(paint(COLOR.muted, `Binary files ${oldFile ? 'a/' + p : '/dev/null'} and ${newFile ? 'b/' + p : '/dev/null'} differ`));
            return head;
        }
        const ops = diffTokens(tokenize(oldFile ? oldFile.content : ''), tokenize(newFile ? newFile.content : ''));
        const changed = [];
        ops.forEach((o, i) => { if (o.t !== ' ') changed.push(i); });
        if (!changed.length) return head;
        head.push(paint(COLOR.muted, `--- ${oldFile ? 'a/' + p : '/dev/null'}`), paint(COLOR.muted, `+++ ${newFile ? 'b/' + p : '/dev/null'}`));
        const CONTEXT = 3;
        const ranges = [];
        let start = Math.max(0, changed[0] - CONTEXT), end = Math.min(ops.length, changed[0] + CONTEXT + 1);
        for (let k = 1; k < changed.length; k++) {
            const s = Math.max(0, changed[k] - CONTEXT), e = Math.min(ops.length, changed[k] + CONTEXT + 1);
            if (s <= end) end = e; else { ranges.push([start, end]); start = s; end = e; }
        }
        ranges.push([start, end]);
        const aBefore = [0], bBefore = [0];
        ops.forEach((o, i) => { aBefore[i + 1] = aBefore[i] + (o.t !== '+' ? 1 : 0); bBefore[i + 1] = bBefore[i] + (o.t !== '-' ? 1 : 0); });
        const out = head;
        ranges.forEach(([s, e]) => {
            const aLen = aBefore[e] - aBefore[s], bLen = bBefore[e] - bBefore[s];
            const aStart = aLen ? aBefore[s] + 1 : aBefore[s], bStart = bLen ? bBefore[s] + 1 : bBefore[s];
            out.push(paint(COLOR.blue, `@@ -${aStart}${aLen === 1 ? '' : ',' + aLen} +${bStart}${bLen === 1 ? '' : ',' + bLen} @@`));
            for (let i = s; i < e; i++) {
                const o = ops[i];
                const text = `${o.t}${o.tok.text}`;
                out.push(o.t === '+' ? paint(COLOR.green, text) : o.t === '-' ? paint(COLOR.red, text) : esc(text));
                if (!o.tok.eol) out.push(paint(COLOR.muted, '\\ No newline at end of file'));
            }
        });
        return out;
    }
    // changes: [{ path, status, oldFile, newFile }]  mode: 'patch' | 'stat' | 'name-only' | 'name-status'
    function renderChangeSet(out, ctx, changes, mode) {
        const letter = { added: 'A', modified: 'M', deleted: 'D' };
        if (mode === 'name-only') { changes.forEach((c) => out.text(displayPath(ctx, c.path))); return; }
        if (mode === 'name-status') { changes.forEach((c) => out.text(`${letter[c.status] || 'M'}\t${displayPath(ctx, c.path)}`)); return; }
        if (mode === 'stat') {
            const rows = changes.map((c) => ({ path: displayPath(ctx, c.path), n: countChanges(c.oldFile, c.newFile) }));
            const width = Math.max(0, ...rows.map((r) => r.path.length));
            let add = 0, del = 0;
            rows.forEach((r) => {
                add += r.n.add; del += r.n.del;
                const bar = r.n.binary ? esc('Bin') : `${esc(String(r.n.add + r.n.del))} ${paint(COLOR.green, '+'.repeat(Math.min(r.n.add, 30)))}${paint(COLOR.red, '-'.repeat(Math.min(r.n.del, 30)))}`;
                out.line(`${esc(r.path.padEnd(width))} | ${bar}`);
            });
            if (rows.length) out.text(` ${rows.length} file${rows.length === 1 ? '' : 's'} changed, ${add} insertion${add === 1 ? '' : 's'}(+), ${del} deletion${del === 1 ? '' : 's'}(-)`);
            return;
        }
        changes.forEach((c) => patchLines(c.path, c.oldFile, c.newFile).forEach((l) => out.line(l)));
    }
    // The changes a set of tree differences amounts to, with both versions of each file attached.
    function changeSet(newTree, oldTree) {
        return gitComputeChanges(newTree, oldTree).map((c) => ({ path: c.path, status: c.status, oldFile: oldTree.get(c.path) || null, newFile: newTree.get(c.path) || null }));
    }

    // ---------------------------------------------------------------------------------------------------------
    // The repository of the terminal's database, loaded for one command.
    async function openRepo(ctx, database) {
        await gitHydrateObjectCache(database); // without this a repo that the panel has not opened yet looks empty
        const dbName = database.name;
        const config = getGitConfig(dbName), repo = getGitRepo(dbName);
        const R = { ctx, database, dbName, config, repo, rootId: ctx.rootId };
        if (!gitBranchExists(repo, config.currentBranch)) { // same repair the panel makes
            config.currentBranch = Object.keys(repo.refs)[0] || 'main';
            if (!gitBranchExists(repo, config.currentBranch)) repo.refs[config.currentBranch] = null;
            saveGitConfig(dbName, config);
            await saveRepo(R);
        }
        return R;
    }
    // Like git.js's saveGitRepo, but flushes new commit objects to THIS database, not the Explorer's.
    async function saveRepo(R) {
        saveGitRepoMetaOnly(R.dbName, R.repo);
        const known = gitObjectCacheKnownShas.get(R.dbName) || new Set();
        const fresh = [];
        for (const sha in R.repo.objects) if (!known.has(sha)) fresh.push({ sha, commit: R.repo.objects[sha] });
        await gitPutObjectsToDB(R.database, fresh);
        fresh.forEach((e) => known.add(e.sha));
        gitObjectCacheKnownShas.set(R.dbName, known);
    }
    // Working tree, HEAD, ignore rules, staged paths and what differs, the way the panel's Changes tab works it out.
    async function snapshot(R) {
        const workingTree = await gitGetWorkingTree(R.database);
        const headTree = gitComputeHeadTree(R.repo, R.config.currentBranch);
        const rules = gitGetIgnoreRules(workingTree);
        const staged = getStagedPaths(R.dbName);
        const raw = gitComputeChanges(workingTree, headTree);
        const hidden = (c) => c.status === 'added' && !staged.includes(c.path) && gitIsIgnored(c.path, rules);
        const pendingMerge = gitGetPendingMerge(R.dbName), pendingRebase = gitGetPendingRebase(R.dbName);
        const conflictState = pendingMerge || (pendingRebase && pendingRebase.conflictPaths.length > 0 ? pendingRebase : null);
        return {
            workingTree, headTree, rules, staged, raw,
            changes: raw.filter((c) => !hidden(c)),
            ignoredPaths: raw.filter(hidden).map((c) => c.path),
            pendingMerge, pendingRebase,
            unresolved: gitFindUnresolvedConflicts(conflictState, workingTree),
            tip: headSha(R)
        };
    }
    // Make the files match `target`. git.js's gitApplyTree deletes every file the target does not list, which
    // would also delete files .gitignore hides (node_modules/, logs). Those are carried into the target here.
    // keepAllUntracked also carries files that were never staged (what `git reset --hard` leaves alone).
    async function applyTarget(R, S, target, keepAllUntracked) {
        const t = new Map(target);
        S.workingTree.forEach((data, path) => {
            if (t.has(path) || S.headTree.has(path)) return;
            if (S.ignoredPaths.includes(path) || (keepAllUntracked && !S.staged.includes(path))) t.set(path, data);
        });
        await gitApplyTree(R.database, t, R.rootId);
    }
    function requireNoOperation(S, what) {
        if (S.pendingMerge) fatal(`you are in the middle of a merge, so ${what} is not possible. Finish it with 'git commit' or undo it with 'git merge --abort'`);
        if (S.pendingRebase) fatal(`a rebase is in progress, so ${what} is not possible. Continue or abort it in the Source Control panel`);
    }
    function requireClean(S, what, force) {
        if (force || S.changes.length === 0) return;
        const names = S.changes.slice(0, 10).map((c) => '\t' + c.path.replace(/^\//, ''));
        fatal(`your local changes would be lost by ${what}:\n${names.join('\n')}${S.changes.length > 10 ? `\n\t... and ${S.changes.length - 10} more` : ''}\nCommit or stash them (git stash), or add -f to discard them.`);
    }
    const toFiles = (changes) => changes.map((c) => ({ path: c.path, name: c.name, status: c.status, content: c.content, encoding: c.encoding }));
    async function makeCommit(R, message, parents, changes) {
        return gitCreateCommitObject(R.repo, message, parents, toFiles(changes), gitAuthorFields(R.dbName));
    }
    // ---------------------------------------------------------------------------------------------------------
    // status
    async function cmdStatus(R, argv, out) {
        const o = parseOpts(argv, { flags: { '-s': 'short', '--short': 'short', '--porcelain': 'short', '-b': 'branch', '--branch': 'branch' } });
        const S = await snapshot(R);
        const ctx = R.ctx, name = R.config.currentBranch;
        const inStaged = (c) => S.staged.includes(c.path);
        const conflicts = S.unresolved;
        const rest = S.changes.filter((c) => !conflicts.includes(c.path));
        const toCommit = rest.filter(inStaged);
        const notStaged = rest.filter((c) => !inStaged(c) && c.status !== 'added');
        const untracked = rest.filter((c) => !inStaged(c) && c.status === 'added');
        const letter = { added: 'A', modified: 'M', deleted: 'D' };
        const word = { added: 'new file:   ', modified: 'modified:   ', deleted: 'deleted:    ' };
        const shown = (c) => displayPath(ctx, c.path);

        if (o.short) {
            if (o.branch) out.text(`## ${S.tip ? name : 'No commits yet on ' + name}`);
            conflicts.forEach((p) => out.line(`${paint(COLOR.red, 'UU')} ${esc(displayPath(ctx, p))}`));
            toCommit.forEach((c) => out.line(`${paint(COLOR.green, letter[c.status])}  ${esc(shown(c))}`));
            notStaged.forEach((c) => out.line(` ${paint(COLOR.red, letter[c.status])} ${esc(shown(c))}`));
            untracked.forEach((c) => out.line(`${paint(COLOR.red, '??')} ${esc(shown(c))}`));
            return false;
        }
        out.text(`On branch ${name}`);
        if (!S.tip) { out.line(); out.text('No commits yet'); }
        if (S.pendingMerge) {
            out.line();
            out.text(conflicts.length ? 'You have unmerged paths.' : 'All conflicts are fixed but you are still merging.');
            out.text(conflicts.length ? '  (fix conflicts, stage the files with "git add", then run "git commit")' : '  (use "git commit" to conclude merge)');
            out.text('  (use "git merge --abort" to abort the merge)');
        } else if (S.pendingRebase) {
            out.line();
            out.text('A rebase is in progress. Continue or abort it in the Source Control panel.');
        }
        if (conflicts.length) {
            out.line(); out.text('Unmerged paths:');
            conflicts.forEach((p) => out.line(`\t${paint(COLOR.red, 'both modified:   ' + displayPath(ctx, p))}`));
        }
        if (toCommit.length) {
            out.line(); out.text('Changes to be committed:'); out.text('  (use "git restore --staged <file>..." to unstage)');
            toCommit.forEach((c) => out.line(`\t${paint(COLOR.green, word[c.status] + shown(c))}`));
        }
        if (notStaged.length) {
            out.line(); out.text('Changes not staged for commit:');
            out.text('  (use "git add <file>..." to update what will be committed)');
            out.text('  (use "git restore <file>..." to discard changes in working directory)');
            notStaged.forEach((c) => out.line(`\t${paint(COLOR.red, word[c.status] + shown(c))}`));
        }
        if (untracked.length) {
            out.line(); out.text('Untracked files:'); out.text('  (use "git add <file>..." to include in what will be committed)');
            untracked.forEach((c) => out.line(`\t${paint(COLOR.red, shown(c))}`));
        }
        out.line();
        if (toCommit.length === 0 && !conflicts.length && !S.pendingMerge) {
            if (notStaged.length) out.text('no changes added to commit (use "git add" and/or "git commit -a")');
            else if (untracked.length) out.text('nothing added to commit but untracked files present (use "git add" to track)');
            else out.text(S.tip ? 'nothing to commit, working tree clean' : 'nothing to commit (create/copy files and use "git add" to track)');
        }
        return false;
    }

    // add
    async function cmdAdd(R, argv, out) {
        const o = parseOpts(argv, { flags: { '-A': 'all', '--all': 'all', '-u': 'update', '--update': 'update', '-f': 'force', '--force': 'force' } });
        const specs = o.rest.concat(o.afterDashes);
        if (!o.all && !o.update && specs.length === 0) { out.text('Nothing specified, nothing added.'); out.text("hint: Maybe you wanted to say 'git add .'?"); return false; }
        const S = await snapshot(R);
        let picks;
        if (o.all) picks = S.changes;
        else if (o.update) picks = S.changes.filter((c) => c.status !== 'added');
        else {
            const known = [...new Set([...S.workingTree.keys(), ...S.headTree.keys()])];
            const map = new Map();
            const blocked = [];
            specs.forEach((spec) => {
                const abs = resolveSpec(R.ctx, spec), match = specMatcher(abs);
                if (!known.some(match)) fatal(`pathspec '${spec}' did not match any files`);
                S.raw.filter((c) => match(c.path)).forEach((c) => {
                    const ignored = S.ignoredPaths.includes(c.path);
                    if (ignored && !o.force) { if (!/[*?]/.test(abs) && c.path === abs) blocked.push(c.path); return; } // named outright: say so; found inside a folder: skip quietly
                    map.set(c.path, c);
                });
            });
            if (blocked.length) {
                out.text('The following paths are ignored by one of your .gitignore files:');
                blocked.forEach((p) => out.text(displayPath(R.ctx, p)));
                out.text("hint: Use 'git add -f' if you really want to add them.");
                if (!map.size) return false;
            }
            picks = [...map.values()];
        }
        const staged = new Set(S.staged);
        picks.forEach((c) => staged.add(c.path));
        saveStagedPaths(R.dbName, [...staged]);
        return true;
    }

    // reset
    async function cmdReset(R, argv, out) {
        const o = parseOpts(argv, { flags: { '--soft': 'soft', '--mixed': 'mixed', '--hard': 'hard', '-q': 'quiet', '--quiet': 'quiet' } });
        const S = await snapshot(R);
        let revSpec = null, specs = [];
        if (o.hasDashes) { revSpec = o.rest[0] || null; specs = o.afterDashes; }
        else if (o.rest.length) {
            let isRev = !!(o.soft || o.hard); // with --soft/--hard the first word can only be a commit
            if (!isRev) { isRev = true; try { resolveRev(R, o.rest[0]); } catch (e) { isRev = false; } }
            if (isRev) { revSpec = o.rest[0]; specs = o.rest.slice(1); } else specs = o.rest;
        }
        const mode = o.hard ? 'hard' : o.soft ? 'soft' : 'mixed';
        if (specs.length) { // unstage paths
            if ((o.soft || o.hard) || (revSpec && resolveRev(R, revSpec) !== S.tip)) fatal('resetting individual paths to another commit is not supported; use "git restore --source=<commit> <file>"');
            const matchers = specs.map((s) => specMatcher(resolveSpec(R.ctx, s)));
            saveStagedPaths(R.dbName, S.staged.filter((p) => !matchers.some((m) => m(p))));
            return true;
        }
        if (!revSpec && !o.soft && !o.hard) { saveStagedPaths(R.dbName, []); return true; } // plain `git reset`
        requireNoOperation(S, 'a reset');
        const target = revSpec ? resolveRev(R, revSpec) : resolveRev(R, 'HEAD');
        const tip = S.tip;
        if (target !== tip) {
            gitMoveRef(R.dbName, R.repo, R.config.currentBranch, target, `Reset (${mode}) from ${gitShortSha(tip)}`);
            await saveRepo(R);
        }
        if (mode === 'hard') {
            await applyTarget(R, S, gitComputeHeadTree(R.repo, target), true);
            saveStagedPaths(R.dbName, []);
            out.text(`HEAD is now at ${gitShortSha(target)} ${subject(R.repo.objects[target])}`);
        } else if (mode === 'mixed') {
            saveStagedPaths(R.dbName, []);
        } else if (tip && target !== tip) {
            // soft: what the undone commits changed stays staged
            const keep = gitWalkAncestors(R.repo, target);
            const undone = new Set();
            gitWalkAncestors(R.repo, tip).filter((s) => !keep.includes(s)).forEach((s) => (R.repo.objects[s].files || []).forEach((f) => undone.add(f.path)));
            const now = await snapshot(R);
            const staged = new Set(now.staged);
            now.changes.filter((c) => undone.has(c.path)).forEach((c) => staged.add(c.path));
            saveStagedPaths(R.dbName, [...staged]);
        }
        gitLog('reset', `Reset "${R.config.currentBranch}" to ${gitShortSha(target)} (${mode}) from the terminal`, 'info', { branch: R.config.currentBranch, mode, target: gitShortSha(target) }, R.dbName);
        return true;
    }

    // restore (and checkout -- <paths>)
    async function restorePaths(R, specs, { staged, worktree, source }, out) {
        const S = await snapshot(R);
        if (!specs.length) fatal('you must specify path(s) to restore');
        if (staged) {
            const matchers = specs.map((s) => specMatcher(resolveSpec(R.ctx, s)));
            if (!worktree) {
                const known = [...S.staged, ...S.workingTree.keys(), ...S.headTree.keys()];
                specs.forEach((s) => { if (!known.some(specMatcher(resolveSpec(R.ctx, s)))) fatal(`pathspec '${s}' did not match any file(s) known to git`); });
            }
            saveStagedPaths(R.dbName, S.staged.filter((p) => !matchers.some((m) => m(p))));
        }
        if (!staged || worktree) {
            const srcTree = source ? gitComputeHeadTree(R.repo, resolveRev(R, source)) : S.headTree;
            const known = [...srcTree.keys(), ...S.headTree.keys()];
            const target = new Map(S.workingTree);
            const unstage = [];
            specs.forEach((spec) => {
                const match = specMatcher(resolveSpec(R.ctx, spec));
                if (!known.some(match)) fatal(`pathspec '${spec}' did not match any file(s) known to git`);
                new Set([...S.workingTree.keys(), ...srcTree.keys()]).forEach((path) => {
                    if (!match(path)) return;
                    if (srcTree.has(path)) target.set(path, srcTree.get(path));
                    else if (S.headTree.has(path)) target.delete(path); // tracked, but the source does not have it
                    // else: never tracked - restore leaves it alone
                    unstage.push(path);
                });
            });
            await applyTarget(R, S, target, true);
            if (!staged) saveStagedPaths(R.dbName, S.staged.filter((p) => !unstage.includes(p)));
        }
        return true;
    }
    async function cmdRestore(R, argv, out) {
        const o = parseOpts(argv, { flags: { '-S': 'staged', '--staged': 'staged', '-W': 'worktree', '--worktree': 'worktree' }, values: { '-s': 'source', '--source': 'source' } });
        return restorePaths(R, o.rest.concat(o.afterDashes), { staged: !!o.staged, worktree: !!o.worktree, source: lastOf(o.source) }, out);
    }

    // commit
    async function cmdCommit(R, argv, out) {
        const o = parseOpts(argv, { flags: { '-a': 'all', '--all': 'all', '--amend': 'amend', '--no-edit': 'noEdit', '-q': 'quiet', '--quiet': 'quiet' }, values: { '-m': 'message', '--message': 'message' } });
        if (o.rest.length || o.afterDashes.length) fatal("committing named paths is not supported; stage them with 'git add' first");
        const S = await snapshot(R);
        const name = R.config.currentBranch;
        if (S.pendingRebase && S.pendingRebase.conflictPaths.length > 0) fatal('a rebase is stopped on a conflict. Continue it in the Source Control panel');
        const message = (o.message || []).join('\n\n').trim();

        if (S.pendingMerge) { // finishing a merge (or a cherry-pick the panel started)
            if (o.amend) fatal('you are in the middle of a merge, so --amend is not possible');
            const pending = S.pendingMerge;
            if (S.unresolved.length) {
                out.text('error: Committing is not possible because you have unmerged files.');
                S.unresolved.forEach((p) => out.text('\t' + displayPath(R.ctx, p)));
                out.text("hint: Fix them up in the work tree (remove the <<<<<<< ======= >>>>>>> lines), then 'git add' them and commit again.");
                return false;
            }
            const isCherryPick = pending.targetSha === pending.sourceSha;
            const parents = isCherryPick ? [pending.targetSha] : [pending.targetSha, pending.sourceSha];
            const finalMessage = message || pending.cherryPickMessage || `Merge branch '${pending.sourceBranch}' into '${pending.targetBranch}'`;
            const changes = gitComputeChanges(S.workingTree, gitComputeHeadTree(R.repo, pending.targetSha));
            const sha = await makeCommit(R, finalMessage, parents, changes);
            gitMoveRef(R.dbName, R.repo, pending.targetBranch, sha, isCherryPick ? `Cherry-pick onto "${pending.targetBranch}"` : `Merge "${pending.sourceBranch}" into "${pending.targetBranch}"`);
            await saveRepo(R);
            saveStagedPaths(R.dbName, []);
            gitSavePendingMerge(R.dbName, null);
            gitLog(isCherryPick ? 'cherry-pick' : 'merge', `Completed ${isCherryPick ? 'cherry-pick' : 'merge'} onto "${pending.targetBranch}" (${changes.length} file(s)) from the terminal`, 'success', { sha: gitShortSha(sha) }, R.dbName);
            out.text(`[${pending.targetBranch} ${gitShortSha(sha)}] ${finalMessage.split('\n')[0]}`);
            return true;
        }

        const staged = new Set(S.staged);
        if (o.all) S.changes.filter((c) => c.status !== 'added').forEach((c) => staged.add(c.path));

        if (o.amend) {
            const tipSha = S.tip;
            if (!tipSha) fatal('you have nothing to amend');
            const tipCommit = R.repo.objects[tipSha];
            const stagedChanges = S.changes.filter((c) => staged.has(c.path));
            const fileMap = new Map(tipCommit.files.map((f) => [f.path, f]));
            toFiles(stagedChanges).forEach((f) => fileMap.set(f.path, f));
            const newMessage = message || tipCommit.message;
            const sha = await gitCreateCommitObject(R.repo, newMessage, [tipCommit.parents[0] || null], [...fileMap.values()], gitAuthorFields(R.dbName));
            gitMoveRef(R.dbName, R.repo, name, sha, `Amend: replaced ${gitShortSha(tipSha)}`);
            await saveRepo(R);
            saveStagedPaths(R.dbName, [...staged].filter((p) => !stagedChanges.some((c) => c.path === p)));
            gitLog('amend', `Amended commit on "${name}" from the terminal`, 'success', { branch: name, sha: gitShortSha(sha), previousSha: gitShortSha(tipSha) }, R.dbName);
            out.text(`[${name} ${gitShortSha(sha)}] ${newMessage.split('\n')[0]}`);
            return true;
        }

        const changes = S.changes.filter((c) => staged.has(c.path));
        if (changes.length === 0) {
            out.text(`On branch ${name}`);
            if (S.changes.length === 0) out.text('nothing to commit, working tree clean');
            else if (S.changes.every((c) => c.status === 'added')) out.text('nothing added to commit but untracked files present (use "git add" to track)');
            else out.text('no changes added to commit (use "git add" and/or "git commit -a")');
            saveStagedPaths(R.dbName, [...staged].filter((p) => S.changes.some((c) => c.path === p)));
            return false;
        }
        if (!message) { out.text('Aborting commit due to empty commit message. Use: git commit -m "message"'); return false; }
        const first = !S.tip;
        const sha = await makeCommit(R, message, [S.tip], changes);
        gitMoveRef(R.dbName, R.repo, name, sha, `Commit: ${message.split('\n')[0]}`);
        await saveRepo(R);
        saveStagedPaths(R.dbName, [...staged].filter((p) => !changes.some((c) => c.path === p)));
        gitLog('commit', `Committed ${changes.length} file(s) to "${name}": ${message} (from the terminal)`, 'success', { branch: name, files: changes.length, sha: gitShortSha(sha) }, R.dbName);
        out.text(`[${name}${first ? ' (root-commit)' : ''} ${gitShortSha(sha)}] ${message.split('\n')[0]}`);
        out.text(` ${changes.length} file${changes.length === 1 ? '' : 's'} changed`);
        changes.filter((c) => c.status === 'added').forEach((c) => out.text(` create mode 100644 ${c.path.replace(/^\//, '')}`));
        changes.filter((c) => c.status === 'deleted').forEach((c) => out.text(` delete mode 100644 ${c.path.replace(/^\//, '')}`));
        return true;
    }

    // ---------------------------------------------------------------------------------------------------------
    // log
    async function cmdLog(R, argv, out) {
        const o = parseOpts(argv, {
            flags: { '--oneline': 'oneline', '--all': 'all', '--graph': 'graph', '--decorate': 'decorate', '--no-decorate': 'noDecorate' },
            values: { '-n': 'max', '--max-count': 'max', '--author': 'author', '--grep': 'grep' },
            dashNumber: true
        });
        const paths = o.afterDashes.map((s) => specMatcher(resolveSpec(R.ctx, s)));
        let tips;
        if (o.all) tips = [...Object.values(R.repo.refs), ...Object.values(R.repo.tags).map((t) => t.sha)].filter(Boolean);
        else if (o.rest.length) tips = o.rest.map((r) => resolveRev(R, r));
        else tips = [resolveRev(R, 'HEAD')];
        const limit = o.number !== undefined ? o.number : (lastOf(o.max) !== undefined ? parseInt(lastOf(o.max), 10) : Infinity);
        if (!(limit >= 0)) fatal(`'${lastOf(o.max)}' is not a number`);
        const author = lastOf(o.author), grep = lastOf(o.grep);
        const deco = o.noDecorate ? new Map() : decorations(R);
        const graphRows = o.graph ? new Map(gitBuildGraphRows(R.repo, tips).map((r) => [r.sha, r])) : null;
        let activeBefore = [];
        let shownCount = 0;
        for (const sha of gitTopoOrder(R.repo, tips)) {
            const c = R.repo.objects[sha];
            if (!c) continue;
            if (author && !`${c.author} <${c.authorEmail || ''}>`.toLowerCase().includes(author.toLowerCase())) continue;
            if (grep && !String(c.message).toLowerCase().includes(grep.toLowerCase())) continue;
            if (paths.length && !(c.files || []).some((f) => paths.some((m) => m(f.path)))) continue;
            if (shownCount >= limit) break;
            shownCount++;
            let prefix = '', contPrefix = '';
            if (graphRows) {
                const row = graphRows.get(sha);
                const width = Math.max(row.lane, ...activeBefore, ...row.activeLanesAfter) + 1;
                const cells = [], cont = [];
                for (let i = 0; i < width; i++) {
                    const live = i === row.lane || activeBefore.includes(i) || row.activeLanesAfter.includes(i);
                    cells.push(i === row.lane ? '*' : (live ? '|' : ' '));
                    cont.push(row.activeLanesAfter.includes(i) ? '|' : ' ');
                }
                prefix = cells.join(' ') + ' ';
                contPrefix = cont.join(' ') + ' ';
                activeBefore = row.activeLanesAfter;
            }
            const labels = deco.get(sha);
            const decor = labels ? ` ${paint(COLOR.yellow, '(' + labels.join(', ') + ')')}` : '';
            if (o.oneline) { out.line(`${esc(prefix)}${paint(COLOR.yellow, gitShortSha(sha))}${decor} ${esc(subject(c))}`); continue; }
            out.line(`${esc(prefix)}${paint(COLOR.yellow, 'commit ' + sha)}${decor}`);
            if (c.parents.length > 1) out.text(`${contPrefix}Merge: ${c.parents.map(gitShortSha).join(' ')}`);
            out.text(`${contPrefix}Author: ${c.author}${c.authorEmail ? ' <' + c.authorEmail + '>' : ''}`);
            out.text(`${contPrefix}Date:   ${gitDate(c.timestamp)}`);
            out.text(contPrefix.trimEnd());
            String(c.message).split('\n').forEach((l) => out.text(`${contPrefix}    ${l}`));
            out.text(contPrefix.trimEnd());
        }
        return false;
    }

    // show
    async function cmdShow(R, argv, out) {
        const o = parseOpts(argv, { flags: { '--stat': 'stat', '--name-only': 'nameOnly', '--name-status': 'nameStatus', '-s': 'noPatch', '--no-patch': 'noPatch' } });
        const sha = resolveRev(R, o.rest[0] || 'HEAD');
        const c = R.repo.objects[sha];
        out.line(paint(COLOR.yellow, 'commit ' + sha) + (decorations(R).get(sha) ? ' ' + paint(COLOR.yellow, '(' + decorations(R).get(sha).join(', ') + ')') : ''));
        if (c.parents.length > 1) out.text(`Merge: ${c.parents.map(gitShortSha).join(' ')}`);
        out.text(`Author: ${c.author}${c.authorEmail ? ' <' + c.authorEmail + '>' : ''}`);
        out.text(`Date:   ${gitDate(c.timestamp)}`);
        out.line();
        String(c.message).split('\n').forEach((l) => out.text('    ' + l));
        if (o.noPatch) return false;
        out.line();
        const before = gitComputeHeadTree(R.repo, c.parents[0] || null), after = gitComputeHeadTree(R.repo, sha);
        const mode = o.stat ? 'stat' : o.nameOnly ? 'name-only' : o.nameStatus ? 'name-status' : 'patch';
        renderChangeSet(out, R.ctx, changeSet(after, before), mode);
        return false;
    }

    // diff
    async function cmdDiff(R, argv, out) {
        const o = parseOpts(argv, { flags: { '--staged': 'staged', '--cached': 'staged', '--stat': 'stat', '--name-only': 'nameOnly', '--name-status': 'nameStatus' } });
        const S = await snapshot(R);
        let specs = o.afterDashes, revs = o.rest;
        if (!o.hasDashes && revs.length > 1) { specs = revs.slice(1); revs = revs.slice(0, 1); } // `git diff HEAD file`
        else if (!o.hasDashes && revs.length === 1) { // one word: a revision if it is one, otherwise a path
            let isRev = true;
            try { resolveRev(R, revs[0]); } catch (e) { isRev = false; }
            if (!isRev) { specs = revs; revs = []; }
        }
        const matchers = specs.map((s) => specMatcher(resolveSpec(R.ctx, s)));
        const wanted = (p) => !matchers.length || matchers.some((m) => m(p));
        let list;
        if (revs.length) { // working tree against a commit; untracked files are not part of it
            const base = gitComputeHeadTree(R.repo, resolveRev(R, revs[0]));
            list = changeSet(S.workingTree, base).filter((c) => wanted(c.path) && (c.status !== 'added' || S.headTree.has(c.path) || S.staged.includes(c.path)));
        } else if (o.staged) {
            list = changeSet(S.workingTree, S.headTree).filter((c) => S.staged.includes(c.path) && wanted(c.path));
        } else { // like real git: tracked files that are not staged (new files appear once they are staged)
            list = changeSet(S.workingTree, S.headTree).filter((c) => !S.staged.includes(c.path) && c.status !== 'added' && wanted(c.path));
        }
        const mode = o.stat ? 'stat' : o.nameOnly ? 'name-only' : o.nameStatus ? 'name-status' : 'patch';
        renderChangeSet(out, R.ctx, list, mode);
        return false;
    }

    // reflog
    async function cmdReflog(R, argv, out) {
        const branch = argv[0] || R.config.currentBranch;
        const entries = gitGetReflog(R.dbName, branch).slice().reverse();
        if (!entries.length) { out.text(`no reflog entries for '${branch}'`); return false; }
        entries.forEach((e, i) => out.line(`${paint(COLOR.yellow, gitShortSha(e.to) || '0000000')} ${esc(branch)}@{${i}}: ${esc(e.reason || '')}`));
        return false;
    }

    // rev-parse
    async function cmdRevParse(R, argv, out) {
        const o = parseOpts(argv.map((a) => (a === '--short' ? '--short=7' : a)), { flags: { '--abbrev-ref': 'abbrev', '--is-inside-work-tree': 'inside' }, values: { '--short': 'short' } });
        if (o.inside) { out.text('true'); return false; }
        if (!o.rest.length) fatal('usage: git rev-parse [--short[=<n>]] [--abbrev-ref] <revision>');
        o.rest.forEach((spec) => {
            if (o.abbrev && (spec === 'HEAD' || spec === '@')) { out.text(R.config.currentBranch); return; }
            const sha = resolveRev(R, spec);
            const n = lastOf(o.short);
            out.text(n !== undefined ? sha.slice(0, Math.max(4, parseInt(n, 10) || 7)) : sha);
        });
        return false;
    }
    // ---------------------------------------------------------------------------------------------------------
    // branch
    async function cmdBranch(R, argv, out) {
        const o = parseOpts(argv, { flags: { '-a': 'all', '--all': 'all', '-l': 'list', '--list': 'list', '-v': 'verbose', '-vv': 'verbose', '--verbose': 'verbose', '-d': 'del', '--delete': 'del', '-D': 'forceDel', '-m': 'move', '--move': 'move', '--show-current': 'current' } });
        const repo = R.repo, cur = R.config.currentBranch;
        if (o.current) { out.text(cur); return false; }
        if (o.del || o.forceDel) {
            if (!o.rest.length) fatal('branch name required');
            const S = await snapshot(R);
            let changed = false;
            for (const name of o.rest) {
                if (!gitBranchExists(repo, name)) { out.line(paint(COLOR.red, `error: branch '${name}' not found.`)); continue; }
                if (name === cur) { out.line(paint(COLOR.red, `error: cannot delete branch '${name}' because it is the one you are on. Switch to another branch first.`)); continue; }
                const busy = (S.pendingMerge && (name === S.pendingMerge.targetBranch || name === S.pendingMerge.sourceBranch)) || (S.pendingRebase && (name === S.pendingRebase.branch || name === S.pendingRebase.ontoBranch));
                if (busy) { out.line(paint(COLOR.red, `error: branch '${name}' is part of a merge or rebase in progress.`)); continue; }
                const tip = repo.refs[name];
                const merged = !tip || gitWalkAncestors(repo, S.tip).includes(tip);
                if (!merged && !o.forceDel) {
                    out.line(paint(COLOR.red, `error: the branch '${name}' is not fully merged.`));
                    out.text(`If you are sure you want to delete it, run 'git branch -D ${name}'.`);
                    continue;
                }
                delete repo.refs[name];
                changed = true;
                gitLog('branch-delete', `Deleted branch "${name}" from the terminal`, 'info', null, R.dbName);
                out.text(`Deleted branch ${name} (was ${tip ? gitShortSha(tip) : 'empty'}).`);
            }
            if (changed) await saveRepo(R);
            return changed;
        }
        if (o.move) {
            const [a, b] = o.rest;
            const oldName = b === undefined ? cur : a, newName = b === undefined ? a : b;
            if (!newName) fatal('branch name required');
            if (!gitBranchExists(repo, oldName)) fatal(`no branch named '${oldName}'`);
            const bad = gitValidateBranchName(newName);
            if (bad) fatal(bad);
            if (newName === oldName) return false;
            if (gitBranchExists(repo, newName)) fatal(`a branch named '${newName}' already exists`);
            const moved = repo.refs[oldName];
            repo.refs[newName] = moved;
            delete repo.refs[oldName];
            await saveRepo(R);
            const history = gitGetReflog(R.dbName, oldName);
            if (history.length) localStorage.setItem(gitReflogKey(R.dbName, newName), JSON.stringify(history));
            const entries = gitGetReflog(R.dbName, newName);
            entries.push({ id: gitNewId('rl'), ts: Date.now(), branch: newName, from: moved, to: moved, reason: `Renamed from "${oldName}"` });
            localStorage.setItem(gitReflogKey(R.dbName, newName), JSON.stringify(entries.slice(-GIT_REFLOG_MAX)));
            if (R.config.currentBranch === oldName) { R.config.currentBranch = newName; saveGitConfig(R.dbName, R.config); }
            const pm = gitGetPendingMerge(R.dbName); if (pm && pm.targetBranch === oldName) { pm.targetBranch = newName; gitSavePendingMerge(R.dbName, pm); }
            const pr = gitGetPendingRebase(R.dbName); if (pr && pr.branch === oldName) { pr.branch = newName; gitSavePendingRebase(R.dbName, pr); }
            gitLog('branch-rename', `Renamed branch "${oldName}" to "${newName}" from the terminal`, 'success', { from: oldName, to: newName }, R.dbName);
            return true;
        }
        if (o.rest.length && !o.list) { // create
            const name = o.rest[0];
            const bad = gitValidateBranchName(name);
            if (bad) fatal(bad);
            if (gitBranchExists(repo, name)) fatal(`a branch named '${name}' already exists`);
            let sha;
            if (o.rest[1]) sha = resolveRev(R, o.rest[1]);
            else { sha = headSha(R); if (!sha) fatal(`not a valid object name: '${cur}'`); }
            gitMoveRef(R.dbName, repo, name, sha, `Branch created from "${o.rest[1] || cur}"`);
            await saveRepo(R);
            gitLog('branch-create', `Created branch "${name}" from the terminal`, 'success', { branch: name }, R.dbName);
            return true;
        }
        const names = Object.keys(repo.refs).sort();
        const width = Math.max(0, ...names.map((n) => n.length));
        names.filter((n) => !o.rest.length || o.rest.some((p) => specMatcher('/' + p)('/' + n))).forEach((n) => {
            const tip = repo.refs[n];
            const mark = n === cur ? '* ' : '  ';
            const label = n === cur ? paint(COLOR.green, n) : esc(n);
            if (o.verbose) out.line(`${mark}${label}${esc(' '.repeat(width - n.length))} ${tip ? paint(COLOR.yellow, gitShortSha(tip)) + ' ' + esc(subject(repo.objects[tip])) : esc('(no commits yet)')}`);
            else out.line(`${mark}${label}`);
        });
        return false;
    }

    // tag
    async function cmdTag(R, argv, out) {
        const o = parseOpts(argv, { flags: { '-l': 'list', '--list': 'list', '-a': 'annotate', '--annotate': 'annotate', '-d': 'del', '--delete': 'del' }, values: { '-m': 'message', '--message': 'message' } });
        const repo = R.repo;
        if (o.del) {
            if (!o.rest.length) fatal('tag name required');
            let changed = false;
            o.rest.forEach((name) => {
                if (!gitTagExists(repo, name)) { out.line(paint(COLOR.red, `error: tag '${name}' not found.`)); return; }
                const sha = repo.tags[name].sha;
                delete repo.tags[name];
                changed = true;
                gitLog('tag-delete', `Deleted tag "${name}" from the terminal`, 'info', { tag: name }, R.dbName);
                out.text(`Deleted tag '${name}' (was ${gitShortSha(sha)})`);
            });
            if (changed) await saveRepo(R);
            return changed;
        }
        if (o.rest.length && !o.list) {
            const name = o.rest[0];
            const sha = o.rest[1] ? resolveRev(R, o.rest[1]) : resolveRev(R, 'HEAD');
            let annotation = null;
            if (o.annotate || o.message) {
                const message = (o.message || []).join('\n\n').trim();
                if (!message) fatal('no tag message. Use: git tag -a <name> -m "message"');
                annotation = { message, tagger: gitAuthorFields(R.dbName).author, timestamp: Date.now() };
            }
            const result = gitCreateTag(R.dbName, name, sha, annotation); // validates the name; stores through git.js
            if (result.error) fatal(result.error.replace(/^Tag "(.*)" already exists\.$/, "tag '$1' already exists"));
            return true;
        }
        const pattern = o.rest[0];
        const re = pattern ? new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null;
        Object.keys(repo.tags).sort().filter((n) => !re || re.test(n)).forEach((n) => out.text(n));
        return false;
    }

    // stash
    const stashLabel = (R, entry) => `${entry.message ? 'On ' + entry.branch + ': ' + entry.message : 'WIP on ' + entry.branch}`;
    function pickStash(R, spec) {
        const list = R.repo.stash || [];
        const m = spec === undefined ? [null, '0'] : /^(?:stash@\{)?(\d+)\}?$/.exec(spec);
        if (!m) fatal(`'${spec}' is not a stash reference`);
        const n = parseInt(m[1], 10);
        const entry = list[list.length - 1 - n];
        if (!entry) fatal(list.length ? `stash@{${n}} does not exist` : 'no stash entries found');
        return { entry, n };
    }
    async function cmdStash(R, argv, out) {
        let sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'push';
        const args = sub === argv[0] ? argv.slice(1) : argv;
        const repo = R.repo;
        if (sub === 'list') {
            const list = repo.stash || [];
            for (let n = 0; n < list.length; n++) out.text(`stash@{${n}}: ${stashLabel(R, list[list.length - 1 - n])}`);
            return false;
        }
        if (sub === 'clear') { repo.stash = []; await saveRepo(R); return true; }
        if (sub === 'drop') {
            const { entry, n } = pickStash(R, args[0]);
            repo.stash = repo.stash.filter((s) => s.id !== entry.id);
            await saveRepo(R);
            gitLog('stash-drop', 'Dropped a stash from the terminal', 'info', null, R.dbName);
            out.text(`Dropped stash@{${n}}`);
            return true;
        }
        const S = await snapshot(R);
        if (sub === 'pop' || sub === 'apply') {
            requireNoOperation(S, `git stash ${sub}`);
            const { entry, n } = pickStash(R, args[0]);
            const touched = entry.files.map((f) => f.path).filter((p) => S.changes.some((c) => c.path === p));
            if (touched.length) fatal(`your local changes to these files would be overwritten by the stash:\n${touched.slice(0, 10).map((p) => '\t' + p.replace(/^\//, '')).join('\n')}\nCommit or stash them first.`);
            const target = new Map(S.workingTree);
            entry.files.forEach((f) => { if (f.status === 'deleted') target.delete(f.path); else target.set(f.path, { content: f.content, encoding: f.encoding, name: f.name }); });
            await applyTarget(R, S, target, true);
            if (sub === 'pop') { repo.stash = repo.stash.filter((s) => s.id !== entry.id); await saveRepo(R); }
            gitLog(sub === 'pop' ? 'stash-pop' : 'stash-apply', `Applied a stash from "${entry.branch}" from the terminal`, 'info', null, R.dbName);
            out.text(sub === 'pop' ? `Applied and dropped stash@{${n}}` : `Applied stash@{${n}}`);
            return true;
        }
        if (sub !== 'push' && sub !== 'save') fatal(`unknown stash command '${sub}'. Use: push, list, pop, apply, drop, clear`);
        const o = parseOpts(args, { flags: { '-u': 'untracked', '--include-untracked': 'untracked' }, values: { '-m': 'message', '--message': 'message' } });
        const message = (lastOf(o.message) || o.rest.join(' ')).trim();
        requireNoOperation(S, 'git stash');
        if (S.changes.length === 0) { out.text('No local changes to save'); return false; }
        const entry = { id: gitNewId('s'), branch: R.config.currentBranch, timestamp: Date.now(), files: toFiles(S.changes) };
        if (message) entry.message = message;
        repo.stash = repo.stash || [];
        repo.stash.push(entry);
        await saveRepo(R);
        await applyTarget(R, S, S.headTree, false);
        saveStagedPaths(R.dbName, []);
        gitLog('stash', `Stashed ${S.changes.length} file(s) from "${R.config.currentBranch}" from the terminal`, 'info', null, R.dbName);
        out.text(`Saved working directory and index state ${stashLabel(R, entry)}`);
        return true;
    }

    // ---------------------------------------------------------------------------------------------------------
    // checkout / switch
    async function switchBranch(R, name, { create, start, force }, out) {
        const S = await snapshot(R);
        requireNoOperation(S, create ? 'creating and switching to a branch' : 'switching branches');
        const repo = R.repo, cur = R.config.currentBranch;
        if (create) {
            const bad = gitValidateBranchName(name);
            if (bad) fatal(bad);
            if (gitBranchExists(repo, name)) fatal(`a branch named '${name}' already exists`);
            let sha = S.tip;
            if (start) sha = resolveRev(R, start);
            const sameCommit = sha === S.tip;
            if (!sameCommit) requireClean(S, 'the checkout', force);
            gitMoveRef(R.dbName, repo, name, sha || null, `Branch created from "${start || cur}"`);
            await saveRepo(R);
            if (!sameCommit) { await applyTarget(R, S, gitComputeHeadTree(repo, sha), false); saveStagedPaths(R.dbName, []); }
            R.config.currentBranch = name;
            saveGitConfig(R.dbName, R.config);
            gitLog('branch-create', `Created branch "${name}" from "${start || cur}" and switched to it (terminal)`, 'success', { branch: name, from: cur }, R.dbName);
            out.text(`Switched to a new branch '${name}'`);
            return true;
        }
        if (!gitBranchExists(repo, name)) {
            if (gitTagExists(repo, name) || (/^[0-9a-f]{7,40}$/i.test(name) && Object.keys(repo.objects).some((s) => s.startsWith(name.toLowerCase())))) {
                fatal(`'${name}' is a tag or a commit, not a branch. CodeMini has no detached HEAD: create a branch there with 'git switch -c <name> ${name}'`);
            }
            fatal(`invalid reference: ${name}`);
        }
        if (name === cur) { out.text(`Already on '${name}'`); return false; }
        requireClean(S, 'the checkout', force);
        await applyTarget(R, S, gitComputeHeadTree(repo, name), false);
        R.config.currentBranch = name;
        saveGitConfig(R.dbName, R.config);
        saveStagedPaths(R.dbName, []);
        gitLog('branch-switch', `Switched from "${cur}" to "${name}" (terminal)`, 'info', null, R.dbName);
        out.text(`Switched to branch '${name}'`);
        return true;
    }
    async function cmdCheckout(R, argv, out) {
        const o = parseOpts(argv, { flags: { '-f': 'force', '--force': 'force', '--ours': 'ours', '--theirs': 'theirs' }, values: { '-b': 'create' } });
        const force = !!o.force;
        if (o.ours || o.theirs) return resolveConflictSide(R, o.rest.concat(o.afterDashes), o.ours ? 'mine' : 'theirs', out);
        if (o.create) return switchBranch(R, lastOf(o.create), { create: true, start: o.rest[0], force }, out);
        if (o.hasDashes) { // git checkout [<rev>] -- <paths>
            return restorePaths(R, o.afterDashes, { staged: false, worktree: true, source: o.rest[0] }, out);
        }
        if (!o.rest.length) fatal('you must say which branch to switch to');
        if (o.rest.length > 1) fatal("too many arguments; to restore files use 'git checkout -- <file>'");
        return switchBranch(R, o.rest[0], { force }, out);
    }
    async function cmdSwitch(R, argv, out) {
        const o = parseOpts(argv, { flags: { '-f': 'force', '--force': 'force' }, values: { '-c': 'create', '--create': 'create' } });
        if (o.create) return switchBranch(R, lastOf(o.create), { create: true, start: o.rest[0], force: !!o.force }, out);
        if (o.rest.length !== 1) fatal('usage: git switch [-c <new-branch>] <branch>');
        return switchBranch(R, o.rest[0], { force: !!o.force }, out);
    }
    // git checkout --ours|--theirs <paths> while a merge waits for conflicts to be fixed
    async function resolveConflictSide(R, specs, choice, out) {
        const S = await snapshot(R);
        if (!S.pendingMerge) fatal('--ours/--theirs only work while a merge has conflicts');
        if (!specs.length) fatal('you must name the conflicted file(s)');
        const pending = S.pendingMerge;
        const mine = gitComputeHeadTree(R.repo, pending.targetSha), theirs = gitComputeHeadTree(R.repo, pending.sourceSha);
        const target = new Map(S.workingTree);
        const resolvedPaths = [];
        specs.forEach((spec) => {
            const match = specMatcher(resolveSpec(R.ctx, spec));
            const hits = pending.conflictPaths.filter(match);
            if (!hits.length) fatal(`pathspec '${spec}' is not one of the conflicted files`);
            hits.forEach((path) => {
                const pick = (choice === 'mine' ? mine : theirs).get(path) || null;
                if (pick) target.set(path, pick); else target.delete(path);
                resolvedPaths.push(path);
            });
        });
        await gitApplyTree(R.database, target, R.rootId);
        if (pending.unresolvedBinary && pending.unresolvedBinary.length) {
            pending.unresolvedBinary = pending.unresolvedBinary.filter((p) => !resolvedPaths.includes(p));
            gitSavePendingMerge(R.dbName, pending);
        }
        out.text(`Updated ${resolvedPaths.length} path${resolvedPaths.length === 1 ? '' : 's'} from the ${choice === 'mine' ? 'current branch' : 'merged branch'}. Stage them with 'git add' and commit.`);
        return true;
    }

    // merge
    async function cmdMerge(R, argv, out) {
        const o = parseOpts(argv, { flags: { '--abort': 'abort' }, values: { '-m': 'message', '--message': 'message' } });
        const S = await snapshot(R);
        const repo = R.repo, targetBranch = R.config.currentBranch;
        if (o.abort) {
            const pending = S.pendingMerge;
            if (!pending) fatal('there is no merge to abort');
            await applyTarget(R, S, gitComputeHeadTree(repo, pending.targetBranch), false);
            saveStagedPaths(R.dbName, []);
            gitSavePendingMerge(R.dbName, null);
            gitLog('merge-abort', `Aborted merge of "${pending.sourceBranch}" into "${pending.targetBranch}" (terminal)`, 'info', null, R.dbName);
            out.text('Merge aborted.');
            return true;
        }
        if (S.pendingMerge) fatal("you have not concluded your merge. Fix the conflicts and 'git commit', or run 'git merge --abort'");
        if (S.pendingRebase) fatal('a rebase is in progress. Continue or abort it in the Source Control panel');
        if (o.rest.length !== 1) fatal('usage: git merge [-m <message>] <branch>   |   git merge --abort');
        const sourceBranch = o.rest[0];
        if (!gitBranchExists(repo, sourceBranch)) fatal(`'${sourceBranch}' is not a branch`);
        if (sourceBranch === targetBranch) { out.text('Already up to date.'); return false; }
        const targetSha = repo.refs[targetBranch] || null, sourceSha = repo.refs[sourceBranch] || null;
        if (!sourceSha) { out.text('Already up to date.'); return false; }
        const base = gitMergeBase(repo, targetSha, sourceSha);
        if (base === sourceSha) { out.text('Already up to date.'); return false; }
        requireClean(S, 'the merge', false);

        if (base === targetSha) { // fast-forward
            const before = S.headTree, after = gitComputeHeadTree(repo, sourceSha);
            gitMoveRef(R.dbName, repo, targetBranch, sourceSha, `Fast-forward merge from "${sourceBranch}"`);
            await saveRepo(R);
            await applyTarget(R, S, after, false);
            saveStagedPaths(R.dbName, []);
            gitLog('merge', `Fast-forwarded "${targetBranch}" to "${sourceBranch}" (terminal)`, 'success', { source: sourceBranch, target: targetBranch, fastForward: true }, R.dbName);
            out.text(`Updating ${targetSha ? gitShortSha(targetSha) : '0000000'}..${gitShortSha(sourceSha)}`);
            out.text('Fast-forward');
            renderChangeSet(out, R.ctx, changeSet(after, before), 'stat');
            return true;
        }

        const targetHead = S.headTree, sourceHead = gitComputeHeadTree(repo, sourceSha), baseHead = gitComputeHeadTree(repo, base);
        const { merged, conflicts } = gitThreeWayMerge(baseHead, targetHead, sourceHead, targetBranch, sourceBranch);
        const mergeChanges = gitComputeChanges(merged, targetHead);
        if (mergeChanges.length === 0 && conflicts.length === 0) { out.text('Already up to date.'); return false; }
        await applyTarget(R, S, merged, false);
        saveStagedPaths(R.dbName, []);
        if (conflicts.length) {
            gitSavePendingMerge(R.dbName, {
                targetBranch, sourceBranch, targetSha, sourceSha, baseSha: base,
                conflictPaths: conflicts.map((c) => c.path),
                unresolvedBinary: conflicts.filter((c) => c.kind === 'binary').map((c) => c.path),
                startedAt: Date.now()
            });
            gitLog('merge', `Merge of "${sourceBranch}" into "${targetBranch}" has ${conflicts.length} conflict(s) (terminal)`, 'error', { source: sourceBranch, target: targetBranch, conflicts: conflicts.length }, R.dbName);
            conflicts.forEach((c) => {
                const p = displayPath(R.ctx, c.path);
                out.line(paint(COLOR.red, c.kind === 'delete-modify' ? `CONFLICT (modify/delete): ${p} deleted in ${targetBranch} and modified in ${sourceBranch}.`
                    : c.kind === 'modify-delete' ? `CONFLICT (modify/delete): ${p} deleted in ${sourceBranch} and modified in ${targetBranch}.`
                    : c.kind === 'binary' ? `CONFLICT (binary): Merge conflict in ${p} (resolve with 'git checkout --ours|--theirs ${p}')`
                    : `CONFLICT (content): Merge conflict in ${p}`));
            });
            out.text("Automatic merge failed; fix conflicts, then 'git add' the files and 'git commit'.");
            return true;
        }
        const message = (lastOf(o.message) || '').trim() || `Merge branch '${sourceBranch}' into '${targetBranch}'`;
        const sha = await makeCommit(R, message, [targetSha, sourceSha], mergeChanges);
        gitMoveRef(R.dbName, repo, targetBranch, sha, `Merge "${sourceBranch}" into "${targetBranch}"`);
        await saveRepo(R);
        gitLog('merge', `Merged "${sourceBranch}" into "${targetBranch}" (${mergeChanges.length} file(s)) (terminal)`, 'success', { source: sourceBranch, target: targetBranch, sha: gitShortSha(sha) }, R.dbName);
        out.text("Merge made by the 'ort' strategy.");
        renderChangeSet(out, R.ctx, changeSet(merged, targetHead), 'stat');
        return true;
    }

    // ---------------------------------------------------------------------------------------------------------
    // remote / config / init / help
    async function cmdRemote(R, argv, out) {
        const o = parseOpts(argv, { flags: { '-v': 'verbose', '--verbose': 'verbose' } });
        if (o.rest.length) fatal("adding or removing remotes is not supported here; choose the repository in Source Control > Remote");
        const full = localStorage.getItem(gitStorageKey(R.dbName, 'remoteRepo')) || '';
        if (!full) return false;
        if (o.verbose) { out.text(`origin\thttps://github.com/${full}.git (fetch)`); out.text(`origin\thttps://github.com/${full}.git (push)`); }
        else out.text('origin');
        return false;
    }
    const CONFIG_KEYS = ['user.name', 'user.email'];
    async function cmdConfig(R, argv, out) {
        const o = parseOpts(argv, { flags: { '-l': 'list', '--list': 'list', '--get': 'get', '--global': 'global', '--local': 'local' } });
        const id = gitResolveIdentity(R.dbName);
        const read = { 'user.name': id.name, 'user.email': id.email };
        if (o.list || (!o.rest.length)) { CONFIG_KEYS.forEach((k) => out.text(`${k}=${read[k]}`)); return false; }
        const key = o.rest[0].toLowerCase();
        if (!CONFIG_KEYS.includes(key)) fatal(`unsupported key '${o.rest[0]}'. Supported: ${CONFIG_KEYS.join(', ')}`);
        if (o.rest.length === 1 || o.get) { out.text(read[key]); return false; }
        const value = o.rest.slice(1).join(' ').trim();
        if (key === 'user.name') {
            if (!value) fatal('name cannot be empty');
            if (value.length > 100 || /[<>\x00-\x1f]/.test(value)) fatal('name must be 100 characters or fewer and cannot contain < > or control characters');
        } else if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) fatal('that email address does not look valid');
        const config = getGitConfig(R.dbName);
        if (!(config.customName || '').trim()) { config.customName = id.name; config.customEmail = id.email; } // start from the current author
        if (key === 'user.name') config.customName = value; else config.customEmail = value;
        config.identitySource = 'custom';
        saveGitConfig(R.dbName, config);
        gitLog('identity', `Commit identity set from the terminal (${config.customName} <${config.customEmail}>)`, 'info', null, R.dbName);
        return true;
    }

    const HELP = [
        ['status [-s] [-b]', 'show staged, unstaged and untracked changes'],
        ['add [-A|-u|-f] <path>...', 'stage changes (git add . stages the current folder)'],
        ['commit -m <msg> [-a] [--amend]', 'record staged changes (also finishes a merge)'],
        ['log [--oneline] [--graph] [--all] [-n N]', 'show history (--author=, --grep=, -- <path>)'],
        ['diff [--staged] [<commit>] [-- <path>]', 'show changes (--stat, --name-only, --name-status)'],
        ['show [<commit>]', 'show one commit with its changes'],
        ['branch [<name>] [-d|-D|-m|-v|-a]', 'list, create, delete or rename branches'],
        ['checkout / switch [-c|-b] [-f] <branch>', 'change branch (refuses to discard work without -f)'],
        ['restore [--staged] [-s <commit>] <path>', 'unstage, or discard changes to a file'],
        ['reset [--soft|--mixed|--hard] [<commit>]', 'unstage, or move the branch to another commit'],
        ['merge <branch> | merge --abort', 'merge a branch (conflicts are left in the files)'],
        ['stash [push|list|pop|apply|drop|clear]', 'put uncommitted work aside'],
        ['tag [-a -m <msg>] [<name>] [<commit>] | tag -d', 'list, create or delete tags'],
        ['reflog [<branch>]', 'where a branch used to point'],
        ['rev-parse [--short] <rev>', 'print a commit id'],
        ['remote [-v]', 'the repository chosen in Source Control > Remote'],
        ['config user.name|user.email [<value>]', 'who commits are made as']
    ];
    function helpLines(out) {
        out.text('usage: git <command> [<args>]');
        out.line();
        HELP.forEach(([cmd, what]) => out.line(`  ${paint(COLOR.blue, cmd.padEnd(46))} ${esc(what)}`));
        out.line();
        out.text('Commits, branches and stashes are shared with the Source Control panel.');
        out.text('For push, pull, fetch, clone, rebase, cherry-pick and revert, use the Source Control panel.');
    }
    const IN_PANEL = {
        push: 'Source Control > Remote', pull: 'Source Control > Remote', fetch: 'Source Control > Remote', clone: 'Source Control (import a repository)',
        rebase: 'the Source Control panel (branch menu)', 'cherry-pick': 'the Source Control panel (History tab)', revert: 'the Source Control panel (History tab)'
    };

    // ---------------------------------------------------------------------------------------------------------
    const COMMANDS = {
        status: cmdStatus, add: cmdAdd, commit: cmdCommit, log: cmdLog, show: cmdShow, diff: cmdDiff, branch: cmdBranch,
        checkout: cmdCheckout, switch: cmdSwitch, restore: cmdRestore, reset: cmdReset, merge: cmdMerge, stash: cmdStash,
        tag: cmdTag, reflog: cmdReflog, 'rev-parse': cmdRevParse, remote: cmdRemote, config: cmdConfig
    };

    // argv: the words after `git`.
    // ctx (supplied by terminal-commands.js):
    //   withDb(fn)   opens the terminal's database, awaits fn(database), closes it again
    //   rootId       id of the folder that is the repository root (folderStack[0].id)
    //   cwd          folder names from the root down to the current folder
    //   printHtml(html)   print an HTML line in the terminal
    //   onChanged()  called after a command changed files or Git state, so the Explorer and panel can redraw
    async function run(argv, ctx) {
        const out = makeOut(ctx);
        try {
            const args = argv.filter((a) => a !== '--no-pager');
            const sub = args[0];
            if (!sub || sub === 'help' || sub === '--help' || sub === '-h') { helpLines(out); return; }
            if (sub === '--version' || sub === 'version') { out.text('git version (CodeMini terminal)'); return; }
            if (sub === 'init') { out.text('Every CodeMini workspace is already a Git repository. Use "git status" to see its state.'); return; }
            if (IN_PANEL[sub]) { out.line(paint(COLOR.yellow, `git ${sub} is not available in the terminal. Use ${IN_PANEL[sub]}.`)); return; }
            const handler = Object.prototype.hasOwnProperty.call(COMMANDS, sub) ? COMMANDS[sub] : null;
            if (!handler) fatal(`'${sub}' is not a git command. See 'git help'.`);
            let changed = false;
            await ctx.withDb(async (database) => {
                const R = await openRepo(ctx, database);
                changed = !!(await handler(R, args.slice(1), out));
            });
            if (changed && ctx.onChanged) ctx.onChanged();
        } catch (e) {
            if (e instanceof GitFatal) out.line(paint(COLOR.red, `fatal: ${e.message}`));
            else out.line(paint(COLOR.red, `git: ${e && e.message ? e.message : e}`));
        } finally {
            out.flush();
        }
    }

    window.CodeMiniGitCli = { run, helpText: () => HELP.map(([cmd, what]) => `${cmd}  -  ${what}`) };
})();
