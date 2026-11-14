// ==========================================
// background-tasks.js: the registry behind Now Island's RUNNING section, the status-bar spinner and Peek
// ==========================================
// Anything that takes a while (a notebook run, a Console or Terminal command, an editor Run, a Git push or pull, a ZIP export,
// later Deploy, Tasks, tests and Agent Mini) tells this registry that it started and how it ended. The registry holds no DOM:
// js/core/now-island.js draws it, so a producer never has to know whether the island is open.
//
//   const task = CodeMiniBackground.start({ kind, title, detail?, winId?, onStop?, onGoto?, notify? });
//   task.update({ detail?, title?, progress? })    progress 0..1 (omit for "working, no percentage")
//   task.log(text, 'out' | 'err')                  one line (or several) for Peek's live tail
//   task.finish(state?, text?)                     state 'success' (default) | 'error' | 'stopped'; text is the one-line result
//   task.fail(message)                             same as finish('error', message)
//
// What the person sees, and when:
//   * A task is "surfaced" (listed, counted in the status bar) once it has run SURFACE_MS, or at once when it starts while they cannot
//     see it (the app is hidden, or another window/profile is active). A task that ends sooner than that never appears anywhere, so
//     a one-line Console command does not flash the status bar.
//   * "Backgrounded" is evaluated again every second and on visibility / window changes, because the person can look away mid-run.
//   * Only a task that was backgrounded at some point, and that did not end by the person's own Stop, adds a notification when it
//     ends (the island and a toast show it): a run they watched needs no announcement. Producers that already announce their own
//     result pass notify:false.
//
// Output lines are TEXT. The registry keeps the last LOG_MAX lines of a task and never interprets them; the island writes them with
// textContent only.
(function () {
    'use strict';

    var KINDS = {
        notebook: { icon: 'ri-book-2-line', label: 'Notebook' },
        console: { icon: 'ri-terminal-box-line', label: 'Console' },
        terminal: { icon: 'ri-terminal-line', label: 'Terminal' },
        run: { icon: 'ri-play-circle-line', label: 'Run' },
        git: { icon: 'ri-git-branch-line', label: 'Git' },
        install: { icon: 'ri-install-line', label: 'Install' },
        download: { icon: 'ri-download-cloud-2-line', label: 'Download' },
        export: { icon: 'ri-file-zip-line', label: 'Export' },
        task: { icon: 'ri-loader-4-line', label: 'Task' }
    };

    var SURFACE_MS = 800;        // a task shorter than this is never shown
    var FINISHED_KEEP_MS = 60000; // RECENTLY FINISHED
    var FINISHED_MAX = 20;
    var LOG_MAX = 200;           // lines kept per task
    var LINE_MAX = 2000;         // characters kept per line
    var WATCH_MS = 1000;         // how often "is the person looking?" is asked while something runs
    var COALESCE_MS = 120;       // log lines arrive in bursts: one repaint per burst

    function createRegistry(env) {
        env = env || {};
        var now = env.now || function () { return Date.now(); };
        var setTimer = env.setTimeout || setTimeout, clearTimer = env.clearTimeout || clearTimeout;
        var setTick = env.setInterval || setInterval, clearTick = env.clearInterval || clearInterval;
        var isHidden = env.hidden || function () { return false; };
        var activeWin = env.activeWin || function () { return null; };
        var notify = env.notify || function () {};

        var tasks = new Map();      // id -> task (running, and finished ones still within FINISHED_KEEP_MS)
        var order = [];             // ids in start order
        var pinned = new Set();     // ids the person detached into the floating Peek panel
        var listeners = new Set();
        var seq = 0, watchTimer = null, pendingEmit = null;
        var flash = null;           // { state, at } of the latest surfaced task that ended, for the status bar's brief check / cross

        function emit() {
            if (pendingEmit) { clearTimer(pendingEmit); pendingEmit = null; }
            listeners.forEach(function (fn) { try { fn(); } catch (e) { /* a bad listener must not break the rest */ } });
        }
        function emitSoon() {
            if (pendingEmit) return;
            pendingEmit = setTimer(function () { pendingEmit = null; emit(); }, COALESCE_MS);
        }

        // Why the person cannot see this task right now: '' (they can), 'app' (the app is hidden), 'window' (another window/profile is
        // active) or 'tab' (the producer's own tab or sidebar is not on screen).
        function awayReason(task) {
            if (isHidden()) return 'app';
            var w = activeWin();
            if (task.winId && w && w !== task.winId) return 'window';
            if (typeof task.isHidden === 'function') { try { if (task.isHidden()) return 'tab'; } catch (e) { /* treat as visible */ } }
            return '';
        }
        function surface(task) {
            if (task.surfaced || task.state !== 'running') return;
            task.surfaced = true;
            emit();
        }
        function refreshAway() {
            var changed = false;
            tasks.forEach(function (t) {
                if (t.state !== 'running') return;
                var r = awayReason(t);
                if (r !== t.awayReason) { t.awayReason = r; t.away = !!r; changed = true; }
                if (r) { t.wasAway = true; if (!t.surfaced) { t.surfaced = true; changed = true; } }
            });
            if (changed) emit();
        }
        function startWatch() {
            if (watchTimer) return;
            watchTimer = setTick(function () {
                if (!running().length && !anyUnsurfaced()) { stopWatch(); return; }
                refreshAway();
                emit(); // elapsed times in the island move once a second
            }, WATCH_MS);
        }
        function stopWatch() { if (watchTimer) { clearTick(watchTimer); watchTimer = null; } }
        function anyUnsurfaced() { var any = false; tasks.forEach(function (t) { if (t.state === 'running' && !t.surfaced) any = true; }); return any; }

        function snapshot(t) {
            return {
                id: t.id, kind: t.kind, icon: (KINDS[t.kind] || KINDS.task).icon, kindLabel: (KINDS[t.kind] || KINDS.task).label,
                title: t.title, detail: t.detail, state: t.state, text: t.text,
                startedAt: t.startedAt, endedAt: t.endedAt, progress: t.progress,
                away: t.away, awayReason: t.awayReason, wasAway: t.wasAway, surfaced: t.surfaced, winId: t.winId,
                stoppable: typeof t.onStop === 'function', stopping: t.stopping, canGoto: typeof t.onGoto === 'function',
                pinned: pinned.has(t.id), lines: t.log.length, dismissed: !!t.dismissed
            };
        }
        function all() { return order.map(function (id) { return tasks.get(id); }).filter(Boolean); }
        function running() { return all().filter(function (t) { return t.state === 'running' && t.surfaced; }).map(snapshot); }
        function finished() {
            var cutoff = now() - FINISHED_KEEP_MS; // age is checked here too: nothing runs to prune the list once the last task has ended
            return all().filter(function (t) { return t.state !== 'running' && t.surfaced && !t.dismissed && (t.endedAt > cutoff || pinned.has(t.id)); })
                .sort(function (a, b) { return b.endedAt - a.endedAt; }).map(snapshot);
        }
        function get(id) { var t = tasks.get(id); return t ? snapshot(t) : null; }

        function prune() {
            var cutoff = now() - FINISHED_KEEP_MS;
            var done = all().filter(function (t) { return t.state !== 'running'; }).sort(function (a, b) { return a.endedAt - b.endedAt; });
            done.forEach(function (t, i) {
                var tooOld = t.endedAt <= cutoff && !pinned.has(t.id);
                var tooMany = done.length - i > FINISHED_MAX && !pinned.has(t.id);
                if (t.dismissed || tooOld || tooMany) remove(t.id);
            });
        }
        function remove(id) {
            tasks.delete(id); pinned.delete(id);
            var i = order.indexOf(id); if (i >= 0) order.splice(i, 1);
        }

        function start(opts) {
            opts = opts || {};
            var id = opts.id ? String(opts.id) : 'bg_' + now().toString(36) + '_' + (++seq);
            var old = tasks.get(id);
            if (old && old.state === 'running') return old.handle; // the same id again is the same task (a producer that restarts its own run)
            if (old) remove(id);
            var kind = KINDS[opts.kind] ? opts.kind : 'task';
            var t = {
                id: id, kind: kind, title: String(opts.title || (KINDS[kind].label + ' task')), detail: opts.detail ? String(opts.detail) : '',
                state: 'running', text: '', startedAt: now(), endedAt: 0, progress: null, log: [],
                winId: opts.winId || activeWin() || null, onStop: opts.onStop, onGoto: opts.onGoto, isHidden: opts.isHidden,
                notify: opts.notify === false ? false : true, notifySource: opts.source ? String(opts.source) : 'CodeMini',
                away: false, awayReason: '', wasAway: false, surfaced: false, stopping: false, timer: null
            };
            t.awayReason = awayReason(t);
            t.away = !!t.awayReason;
            t.wasAway = t.away;
            t.surfaced = t.away; // started out of sight: it is listed straight away
            tasks.set(id, t); order.push(id);
            if (!t.surfaced) t.timer = setTimer(function () { t.timer = null; surface(t); }, SURFACE_MS);
            startWatch();
            // A handle belongs to THIS run. An id can be reused (Git always uses one), so a stale handle from an earlier run must not
            // be able to update, log to or end the run that replaced it.
            var live = function () { var x = tasks.get(id); return x && x === t ? x : null; };
            t.handle = Object.freeze({
                id: id,
                update: function (p) { if (live()) update(id, p); },
                log: function (text, stream) { if (live()) logLine(id, text, stream); },
                finish: function (state, text) { if (live()) finish(id, state, text); },
                fail: function (message) { if (live()) finish(id, 'error', message); },
                isRunning: function () { var x = live(); return !!x && x.state === 'running'; }
            });
            if (t.surfaced) emit();
            return t.handle;
        }

        function update(id, p) {
            var t = tasks.get(id); if (!t || t.state !== 'running' || !p) return;
            var changed = false;
            if (typeof p.detail === 'string' && p.detail !== t.detail) { t.detail = p.detail; changed = true; }
            if (typeof p.title === 'string' && p.title && p.title !== t.title) { t.title = p.title; changed = true; }
            if ('progress' in p) {
                var v = p.progress == null ? null : Number(p.progress);
                if (v !== null) v = isFinite(v) ? Math.max(0, Math.min(1, v)) : null; // not a number (or infinite) means "no percentage", not "full"
                if (v !== t.progress) { t.progress = v; changed = true; }
            }
            if (changed && t.surfaced) emitSoon();
        }

        function logLine(id, text, stream) {
            var t = tasks.get(id); if (!t || t.state !== 'running') return;
            String(text == null ? '' : text).split('\n').forEach(function (line, i, parts) {
                if (i === parts.length - 1 && line === '' && parts.length > 1) return; // the newline at the end of a chunk
                t.log.push({ at: now(), stream: stream === 'err' ? 'err' : 'out', text: line.length > LINE_MAX ? line.slice(0, LINE_MAX) + '...' : line });
            });
            if (t.log.length > LOG_MAX) t.log.splice(0, t.log.length - LOG_MAX);
            if (t.surfaced) emitSoon();
        }

        function finish(id, state, text) {
            var t = tasks.get(id); if (!t || t.state !== 'running') return;
            if (t.timer) { clearTimer(t.timer); t.timer = null; }
            t.state = state === 'error' || state === 'stopped' ? state : 'success';
            t.text = text ? String(text) : '';
            t.endedAt = now();
            t.progress = t.state === 'success' ? 1 : t.progress;
            t.stopping = false;
            if (t.state === 'error' && t.text) t.log.push({ at: t.endedAt, stream: 'err', text: t.text });
            var wasShown = t.surfaced;
            if (!wasShown) { remove(id); if (!running().length) stopWatch(); return; } // too quick to have been seen: no trace
            flash = { state: t.state, at: t.endedAt };
            // The person is told only when they were not watching, and not about a Stop they asked for themselves.
            if (t.notify && t.wasAway && t.state !== 'stopped') {
                var secs = Math.max(1, Math.round((t.endedAt - t.startedAt) / 1000));
                var took = secs >= 60 ? Math.floor(secs / 60) + ' min ' + (secs % 60) + ' s' : secs + ' s';
                try {
                    notify({
                        id: 'bg-' + t.id, source: t.notifySource, kind: 'task',
                        title: t.title + (t.state === 'error' ? ' failed' : ' finished'),
                        text: t.state === 'error' ? (t.text || 'It ended with an error.') : (t.text ? t.text + ' (' + took + ')' : 'Finished in ' + took + '.')
                    });
                } catch (e) { /* notifications are optional */ }
            }
            prune();
            if (!running().length) stopWatch();
            emit();
        }

        function stop(id) {
            var t = tasks.get(id);
            if (!t || t.state !== 'running' || typeof t.onStop !== 'function' || t.stopping) return false;
            t.stopping = true;
            emit();
            try { t.onStop(); } catch (e) { /* the producer ends the task itself, and says how */ }
            return true;
        }
        function goto_(id) {
            var t = tasks.get(id);
            if (!t || typeof t.onGoto !== 'function') return false;
            try { t.onGoto(); } catch (e) { return false; }
            return true;
        }
        function dismiss(id) {
            var t = tasks.get(id);
            if (!t || t.state === 'running') return;
            t.dismissed = true; pinned.delete(id);
            remove(id);
            emit();
        }
        function dismissAllFinished() {
            all().forEach(function (t) { if (t.state !== 'running') { pinned.delete(t.id); remove(t.id); } });
            emit();
        }
        function pin(id) { var t = tasks.get(id); if (!t || !t.surfaced) return false; pinned.add(id); emit(); return true; }
        function unpin(id) { if (pinned.delete(id)) emit(); }
        function isPinned(id) { return pinned.has(id); }
        function pinnedList() { return order.filter(function (id) { return pinned.has(id) && tasks.has(id); }).map(function (id) { return snapshot(tasks.get(id)); }); }

        function logOf(id) { var t = tasks.get(id); return t ? t.log.map(function (l) { return { at: l.at, stream: l.stream, text: l.text }; }) : []; }
        function tail(id, n) { var l = logOf(id); return l.slice(Math.max(0, l.length - (n || 4))); }

        function takeFlash() { var f = flash; flash = null; return f; }

        return {
            start: start, stop: stop, goto: goto_, dismiss: dismiss, dismissAllFinished: dismissAllFinished,
            pin: pin, unpin: unpin, isPinned: isPinned, pinned: pinnedList,
            running: running, finished: finished, get: get, log: logOf, tail: tail,
            runningCount: function () { return running().length; },
            subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
            takeFlash: takeFlash, refresh: refreshAway, prune: function () { prune(); emit(); },
            KINDS: KINDS, SURFACE_MS: SURFACE_MS, FINISHED_KEEP_MS: FINISHED_KEEP_MS, LOG_MAX: LOG_MAX
        };
    }

    // ---- Browser wiring ----
    function browserEnv() {
        var key = 'codemini_active_window';
        return {
            hidden: function () { return typeof document !== 'undefined' && !!document.hidden; },
            activeWin: function () { try { return localStorage.getItem(key) || 'win_default'; } catch (e) { return null; } },
            notify: function (n) { if (window.CodeMiniNotifications) window.CodeMiniNotifications.add(n); }
        };
    }

    var W = typeof window !== 'undefined' ? window : globalThis;
    if (typeof module !== 'undefined' && module.exports) module.exports = { createRegistry: createRegistry, KINDS: KINDS, SURFACE_MS: SURFACE_MS, FINISHED_KEEP_MS: FINISHED_KEEP_MS, LOG_MAX: LOG_MAX };
    if (typeof window !== 'undefined' && !W.CodeMiniBackground) {
        var reg = createRegistry(browserEnv());
        W.CodeMiniBackground = Object.freeze(reg);
        // Looking away mid-run: re-ask as soon as the tab is hidden or shown, not only on the next one-second beat.
        document.addEventListener('visibilitychange', function () { reg.refresh(); });
        window.addEventListener('storage', function (e) { if (e.key === 'codemini_active_window') reg.refresh(); });
    }
})();
