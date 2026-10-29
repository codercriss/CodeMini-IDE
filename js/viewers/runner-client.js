// runner-client.js - talks to the CodeMini runner: a tiny page on a DIFFERENT origin that hosts previews, so
// previewed code cannot read this app's storage (vault, token record, device key) or call its functions.
// See runner/ for the other half and SECURITY.md for what this does and does not protect.
//
//   CodeMiniRunner.ensure(iframe)       load the runner into the preview frame; true when isolated, false = fall back
//   CodeMiniRunner.mint(iframe, blob)   a blob: URL that pages in the runner can load (made by the runner)
//   CodeMiniRunner.show(iframe, url)    navigate the previewed page; resolves when it has loaded
//   CodeMiniRunner.revoke(urls)         release URLs made by mint
//   CodeMiniRunner.owns(url)            was this URL made by the runner (so it must be released through it)?
//   CodeMiniRunner.active(iframe)       is this frame currently in runner mode?
//
// Page messages (console, network, inspector...) arrive wrapped by the runner and are re-dispatched on window as
// ordinary message events whose source is the preview frame, so the existing preview code needs no changes.
// Control messages must carry the per-frame nonce; anything else from the frame is ignored.
//
// Settings: Settings > Security > Isolation (read through window.getIsolationSettings(): a global Isolated/Normal choice
// and a per-surface override). Default is Isolated. Escape hatches in localStorage: codemini_runner = "off" forces
// Normal everywhere; on localhost only, codemini_runner_url points at a local runner for development. The runner can
// never be the app's own origin.
(function () {
    'use strict';
    var DEFAULT_URL = 'https://codemini-runner.vercel.app';
    // HANDSHAKE_MS bounds the whole attempt; LOAD_GRACE_MS is how long after the frame fires `load` we still wait for
    // the runner's announcement (a healthy runner sends it before load; an unreachable host loads an error page at once).
    var HANDSHAKE_MS = 6000, LOAD_GRACE_MS = 1200, RPC_MS = 30000, RETRY_AFTER_MS = 60000;
    var sessions = new WeakMap();
    var popups = [];                                                // pop-out windows we opened, as frame-like targets
    var failedUntil = 0, lastError = '';
    var status = 'unknown';

    // The runner is a separate deployment, so it can be older than this app (deployed in the wrong order, or not at all). Each runner page says
    // which level it is in its hello-ack (runner/config.js: `version`, `build`). RUNNER_NEEDS is the level this app needs from each page; a runner
    // below it is not used, and the person is told why instead of getting odd behaviour from old code. A runner from before version numbers
    // sends nothing, which counts as 0. Raise `exec` together with `version` in runner/config.js when the app starts to depend on something new
    // in the execution host (tests/runner-version.test.js checks the app never needs more than the runner in the repository has).
    // `preview` is only recorded: every runner level can show a preview.
    var RUNNER_NEEDS = { preview: 0, exec: 4 };
    var lastInfo = { preview: null, exec: null };
    // What a runner page says about itself is untrusted text: keep a small integer and a short plain string, nothing else.
    function cleanInfo(d) {
        var v = d && Number.isInteger(d.version) && d.version >= 0 && d.version < 1000 ? d.version : 0;
        var b = d && typeof d.build === 'string' && /^[0-9A-Za-z._-]{1,40}$/.test(d.build) ? d.build : '';
        return { version: v, build: b };
    }
    function outdatedText(info, needs) {
        var have = info.version > 0 ? 'version ' + info.version + (info.build ? ', built ' + info.build : '') : 'from before version numbers';
        return 'the runner is out of date: it is ' + have + ', and this CodeMini needs version ' + needs + ' or newer. Redeploy the runner project (codemini-runner) and try again';
    }

    var isLocal = function (h) { return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'; };
    // 'runner' (isolated) or 'normal' for a surface (today only 'preview'): its own override if it has one, else the global
    // mode, else isolated. codemini_runner=off overrides everything.
    function modeFor(surface) {
        try { if (localStorage.getItem('codemini_runner') === 'off') return 'normal'; } catch (e) { /* storage unavailable */ }
        var s = null;
        try { s = typeof window.getIsolationSettings === 'function' ? window.getIsolationSettings() : null; } catch (e) { /* settings not ready */ }
        if (!s) return 'runner';
        var own = s.surfaces && s.surfaces[surface];
        return own === 'runner' || own === 'normal' ? own : (s.global === 'normal' ? 'normal' : 'runner');
    }
    function config() {
        var url = DEFAULT_URL;
        try {
            var o = localStorage.getItem('codemini_runner_url');
            if (o && isLocal(location.hostname)) url = o;
        } catch (e) { /* storage unavailable: defaults */ }
        var u;
        try { u = new URL(url); } catch (e) { return { enabled: false, reason: 'bad-url' }; }
        // A "runner" on the app's own origin would give none of the isolation, so it is refused outright.
        if (u.origin === location.origin) return { enabled: false, reason: 'same-origin' };
        if (!(u.protocol === 'https:' || (u.protocol === 'http:' && isLocal(u.hostname)))) return { enabled: false, reason: 'insecure' };
        return { enabled: true, reason: '', origin: u.origin, shell: u.origin + '/shell.html' };
    }
    function randomHex(n) {
        var a = new Uint8Array(n); crypto.getRandomValues(a);
        return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }
    function setStatus(next, iframe) {
        if (next === status && !iframe) return;
        status = next;
        try { window.dispatchEvent(new CustomEvent('codemini:runner-status', { detail: { status: next } })); } catch (e) { /* nothing listens */ }
    }
    function post(iframe, s, msg) { iframe.contentWindow.postMessage(Object.assign({ cmRunner: 1 }, msg), s.cfg.origin); }

    function rpc(iframe, op, extra, ms) {
        var s = sessions.get(iframe);
        if (!s || !s.ready) return Promise.reject(new Error('runner not ready'));
        return new Promise(function (resolve, reject) {
            var id = ++s.seq;
            var timer = setTimeout(function () { s.pending.delete(id); reject(new Error('runner did not answer (' + op + ')')); }, ms || RPC_MS);
            s.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
            try { post(iframe, s, Object.assign({ op: op, id: id }, extra)); }
            catch (e) { clearTimeout(timer); s.pending.delete(id); reject(e); }
        });
    }
    function failAll(s, why) {
        s.pending.forEach(function (p) { clearTimeout(p.timer); p.reject(new Error(why)); });
        s.pending.clear();
    }

    window.addEventListener('message', function (e) {
        if (!e.isTrusted) return;                                   // our own re-dispatched page messages
        // Whose message? The preview frame, or one of the pop-out windows we opened. Nobody else is listened to.
        var iframe = document.getElementById('lpIframe'), isMain = true;
        var s = iframe && sessions.get(iframe);
        if (!s || e.source !== iframe.contentWindow) {
            iframe = null; s = null; isMain = false;
            for (var i = 0; i < popups.length; i++) { if (popups[i].contentWindow === e.source) { iframe = popups[i]; s = sessions.get(iframe); break; } }
        }
        if (!s || e.origin !== s.cfg.origin) return;
        var d = e.data;
        if (!d || d.cmRunner !== 1) return;
        if (d.op === 'ready') {
            // First load, or the runner page reloaded under us (its URLs are gone): say hello again.
            if (s.ready) { s.ready = false; iframe.dataset.cmRunner = ''; failAll(s, 'runner reloaded'); }
            if (s.onReady) { s.onReady(); }
            return;
        }
        if (d.op === 'page') {
            if (!isMain) return;                                    // a pop-out's page is not wired to the preview panels
            // Wrapped page message: hand it to the preview code as if it had come straight from the frame.
            window.dispatchEvent(new MessageEvent('message', { data: d.data, origin: e.origin, source: iframe.contentWindow }));
            return;
        }
        if (d.nonce !== s.nonce) return;                            // control messages must prove who sent them
        if (d.op === 'hello-ack') { if (s.onAck) s.onAck(d); return; }
        // Output and questions from a code-execution host (the Console and Terminal, see exec-client.js).
        if (d.op === 'exec-out') { var onOut = s.streams && s.streams.get(d.id); if (onOut) onOut(d); return; }
        if (d.op === 'exec-prompt') {
            var ask = s.asks && s.asks.get(d.id), reply = function (v) { try { post(iframe, s, { op: 'prompt-reply', pid: d.pid, value: String(v === null || v === undefined ? '' : v) }); } catch (x) { /* host gone */ } };
            if (ask) Promise.resolve(ask(String(d.text || ''))).then(reply, function () { reply(''); }); else reply('');
            return;
        }
        var p = s.pending.get(d.id);
        if (!p) return;
        s.pending.delete(d.id); clearTimeout(p.timer);
        // A finished command is a result even when it carries an `error` (the code's own error is a normal outcome); only a
        // failed REQUEST (a string error) rejects.
        if (d.op === 'exec-done') { p.resolve(d); return; }
        if (d.error) { p.reject(new Error(d.error)); return; }
        if (d.op === 'minted') {
            // Only URLs the runner itself could have made are ever handed on.
            if (typeof d.url !== 'string' || d.url.indexOf('blob:' + s.cfg.origin + '/') !== 0) { p.reject(new Error('unexpected URL from runner')); return; }
            p.resolve(d.url);
        } else if (d.op === 'exported') p.resolve(Array.isArray(d.entries) ? d.entries : []);
        else if (d.op === 'exec-done') p.resolve(d);
        else p.resolve();
    });

    function handshake(iframe, s) {
        return new Promise(function (resolve) {
            var done = false, timer, loadTimer = null, sawReady = false, sawLoad = false;
            var finish = function (ok, why) {
                if (done) return; done = true; clearTimeout(timer); clearTimeout(loadTimer);
                if (iframe.removeEventListener) iframe.removeEventListener('load', onLoad);
                s.onReady = s.onAck = null; s.why = why || ''; resolve(ok);
            };
            var noReady = 'the runner page loaded but did not announce itself: it may be refusing to be embedded by this app (check frame-ancestors and allowedParents)';
            var onLoad = function () { sawLoad = true; if (!sawReady && !loadTimer) loadTimer = setTimeout(function () { finish(false, noReady); }, LOAD_GRACE_MS); };
            s.onAck = function (d) { s.info = cleanInfo(d); s.ready = true; iframe.dataset.cmRunner = '1'; finish(true); };
            s.onReady = function () { sawReady = true; clearTimeout(loadTimer); try { post(iframe, s, { op: 'hello', nonce: s.nonce }); } catch (e) { finish(false, 'could not message the runner'); } };
            timer = setTimeout(function () {
                finish(false, sawReady ? 'the runner announced itself but did not accept this app (is ' + location.origin + ' in allowedParents?)'
                    : sawLoad ? noReady : 'the runner page did not load (network, blocked, or not deployed)');
            }, HANDSHAKE_MS);
            if (iframe.addEventListener) iframe.addEventListener('load', onLoad);
            iframe.removeAttribute('srcdoc');
            iframe.dataset.cmRunner = '';
            iframe.src = s.url || s.cfg.shell;
        });
    }

    async function ensure(iframe, surface) {
        // Normal mode chosen for this surface: leave the runner (if this frame was using it) and report "off".
        if (modeFor(surface || 'preview') === 'normal') {
            var running = sessions.get(iframe);
            if (running) { failAll(running, 'isolation switched off'); sessions.delete(iframe); iframe.dataset.cmRunner = ''; iframe.src = 'about:blank'; }
            setStatus('off');
            return false;
        }
        var cfg = config();
        if (!cfg.enabled) { setStatus('unavailable'); return false; }
        var s = sessions.get(iframe);
        if (s && s.ready && iframe.dataset.cmRunner === '1' && s.cfg.origin === cfg.origin) return true;
        if (Date.now() < failedUntil) { setStatus('fallback'); return false; }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) { lastError = 'the browser is offline'; setStatus('fallback'); return false; } // offline: do not wait for a host we cannot reach
        if (s) failAll(s, 'runner restarted');
        s = { cfg: cfg, nonce: randomHex(16), pending: new Map(), seq: 0, ready: false };
        sessions.set(iframe, s);
        var ok = await handshake(iframe, s);
        if (!ok) {
            lastError = s.why || 'the runner did not answer';
            sessions.delete(iframe);
            failedUntil = Date.now() + RETRY_AFTER_MS;              // do not make every preview wait for a runner that is not there
            iframe.dataset.cmRunner = '';
            iframe.src = 'about:blank';
            setStatus('fallback');
            return false;
        }
        lastInfo.preview = s.info || null;
        setStatus('isolated');
        return true;
    }

    // The runner answered the handshake but a page could not be shown (blocked by the browser, a header, a crash):
    // stop using it for a while, so the caller can render the same-origin way instead of leaving a blank preview.
    function fail(iframe, reason) {
        var s = sessions.get(iframe);
        if (s) { failAll(s, 'runner failed'); sessions.delete(iframe); }
        failedUntil = Date.now() + RETRY_AFTER_MS;
        lastError = String(reason || 'unknown error').slice(0, 200);
        if (iframe) { iframe.dataset.cmRunner = ''; iframe.src = 'about:blank'; }
        try { console.warn('[CodeMini] Isolated preview failed, using same-origin preview: ' + lastError); } catch (e) { /* no console */ }
        setStatus('fallback', iframe);
    }

    // Open the page in its own window, still on the runner origin (so still isolated). The window is opened by the
    // caller, inside the click, so it is not blocked; here it shakes hands, receives everything the preview frame has
    // made (re-made under the new window), and shows `html`. The runner drops the window's link back to the app.
    async function popout(win, iframe, html) {
        var cfg = config();
        if (!cfg.enabled || !win) throw new Error('the runner is not available');
        var target = { contentWindow: win, dataset: {} };
        var s = { cfg: cfg, nonce: randomHex(16), pending: new Map(), seq: 0, ready: false };
        sessions.set(target, s); popups.push(target);
        var cleanup = function () { var i = popups.indexOf(target); if (i > -1) popups.splice(i, 1); sessions.delete(target); };
        try {
            await new Promise(function (resolve, reject) {
                var timer = setTimeout(function () { reject(new Error('the new window did not answer')); }, HANDSHAKE_MS);
                s.onAck = function () { clearTimeout(timer); s.ready = true; resolve(); };
                s.onReady = function () { try { post(target, s, { op: 'hello', nonce: s.nonce }); } catch (e) { reject(e); } };
            });
            var entries = await rpc(iframe, 'export', {});
            await rpc(target, 'import', { entries: entries, html: html }, RPC_MS);
        } catch (e) { cleanup(); throw e; }
        // The window keeps its own session for as long as it lives; drop ours when it closes.
        var watch = setInterval(function () { if (win.closed) { clearInterval(watch); cleanup(); } }, 2000);
    }

    // Clears what previewed pages stored in the runner's origin for one data domain (Factory Reset, Delete Profile). The
    // app cannot reach that storage itself. Uses the preview frame if it is connected, otherwise a hidden frame that
    // lives just long enough to do it. Resolves when done; rejects if the runner cannot be reached.
    async function wipe(domain) {
        var cfg = config();
        if (!cfg.enabled) return;
        var main = document.getElementById('lpIframe');
        if (main && sessions.get(main) && sessions.get(main).ready) { await rpc(main, 'wipe', { domain: String(domain || '') }, 10000); return; }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('the browser is offline');
        var frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        frame.style.cssText = 'position:absolute; width:0; height:0; border:0; visibility:hidden;';
        frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
        document.body.appendChild(frame);
        var s = { cfg: cfg, nonce: randomHex(16), pending: new Map(), seq: 0, ready: false };
        sessions.set(frame, s); popups.push(frame);
        try {
            if (!(await handshake(frame, s))) throw new Error(s.why || 'the runner did not answer');
            await rpc(frame, 'wipe', { domain: String(domain || '') }, 10000);
        } finally {
            var i = popups.indexOf(frame); if (i > -1) popups.splice(i, 1);
            sessions.delete(frame); frame.remove();
        }
    }

    // ---- code-execution hosts (Console and Terminal) -----------------------------------------------------------------
    // One hidden runner frame per window/profile, kept for as long as it is needed so JavaScript globals and the Python
    // namespace persist. Its failures are remembered SEPARATELY from the preview's: exec.html can be missing (the app was
    // deployed but the runner was not) while shell.html still works, and that must not switch preview isolation off.
    var hosts = {}, opening = {}, execFailedUntil = 0, execLastError = '';
    function dropHost(key) {
        var h = hosts[key]; delete hosts[key];
        if (!h) return;
        var s = sessions.get(h.frame); if (s) { failAll(s, 'the execution host was closed'); sessions.delete(h.frame); }
        var i = popups.indexOf(h.frame); if (i > -1) popups.splice(i, 1);
        try { h.frame.remove(); } catch (e) { /* already gone */ }
    }
    function hostApi(key, frame) {
        return {
            frame: frame,
            // Resolves with {value, plots, error, ms}; onOut gets each output event as it happens; onAsk answers Python's ainput().
            run: function (payload, onOut, onAsk) {
                var s = sessions.get(frame);
                if (!s || !s.ready) return Promise.reject(new Error('the execution host is not ready'));
                return new Promise(function (resolve, reject) {
                    var id = ++s.seq;
                    s.streams = s.streams || new Map(); s.asks = s.asks || new Map();
                    s.streams.set(id, onOut || function () {}); if (onAsk) s.asks.set(id, onAsk);
                    var done = function (fn) { return function (v) { s.streams.delete(id); s.asks.delete(id); fn(v); }; };
                    // No timeout: code may run for as long as the person lets it. kill() is how a runaway command is stopped.
                    s.pending.set(id, { resolve: done(resolve), reject: done(reject), timer: 0 });
                    try { post(frame, s, Object.assign({ op: 'exec', id: id }, payload)); }
                    catch (e) { s.pending.delete(id); s.streams.delete(id); s.asks.delete(id); reject(e); }
                });
            },
            reset: function (lang) { return rpc(frame, 'reset', { lang: lang }, 10000); },
            kill: function () { dropHost(key); }
        };
    }
    function newExecFrame(cfg) {
        var frame = document.createElement('iframe');
        // allow-modals: Python's input() uses a real prompt dialog, as it did when it ran inside the app.
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-modals');
        frame.style.cssText = 'position:absolute; width:0; height:0; border:0; visibility:hidden;';
        frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
        document.body.appendChild(frame);
        var s = { cfg: cfg, url: cfg.origin + '/exec.html', nonce: randomHex(16), pending: new Map(), seq: 0, ready: false };
        sessions.set(frame, s); popups.push(frame);
        return { frame: frame, s: s };
    }
    function discardFrame(frame) { sessions.delete(frame); var i = popups.indexOf(frame); if (i > -1) popups.splice(i, 1); frame.remove(); }
    async function execHost(key) {
        var cfg = config();
        if (!cfg.enabled) throw new Error('the runner is not configured');
        key = String(key || 'default');
        var h = hosts[key];
        if (h) { var hs = sessions.get(h.frame); if (hs && hs.ready && document.body.contains(h.frame)) return h.api; dropHost(key); }
        if (opening[key]) return opening[key];
        if (Date.now() < execFailedUntil) throw new Error(execLastError || 'the execution host is not reachable');
        if (typeof navigator !== 'undefined' && navigator.onLine === false) { execLastError = 'the browser is offline'; throw new Error(execLastError); }
        opening[key] = (async function () {
            var made = newExecFrame(cfg), frame = made.frame, s = made.s;
            var ok = await handshake(frame, s);
            if (!ok) {
                execLastError = s.why || 'the execution host did not answer'; execFailedUntil = Date.now() + RETRY_AFTER_MS;
                discardFrame(frame);
                throw new Error(execLastError);
            }
            lastInfo.exec = s.info || cleanInfo(null);
            if (lastInfo.exec.version < RUNNER_NEEDS.exec) {
                // It answered, but it is older than what this app relies on: do not run code on it. Callers fall back to the in-app engine
                // with a one-time note that carries this sentence.
                execLastError = outdatedText(lastInfo.exec, RUNNER_NEEDS.exec); execFailedUntil = Date.now() + RETRY_AFTER_MS;
                discardFrame(frame);
                throw new Error(execLastError);
            }
            var api = hostApi(key, frame);
            hosts[key] = { frame: frame, api: api };
            return api;
        })();
        try { return await opening[key]; } finally { delete opening[key]; }
    }

    // Ask the deployed runner which version it is, without running anything (Settings > Security > Check runner). Never throws; resolves
    // {state: 'ok' | 'outdated' | 'unreachable' | 'off', message, version, build, needs}. A runner that is fine clears the "try again later" wait,
    // so a runner that has just been redeployed is used at once.
    async function checkRunner() {
        var needs = RUNNER_NEEDS.exec, cfg = config();
        if (!cfg.enabled) return { state: 'off', message: 'The runner is not configured (Isolation is off, or this build has no runner address).', needs: needs };
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return { state: 'unreachable', message: 'The browser is offline.', needs: needs };
        var made = newExecFrame(cfg), ok;
        try { ok = await handshake(made.frame, made.s); } finally { discardFrame(made.frame); }
        if (!ok) return { state: 'unreachable', message: 'The runner could not be reached: ' + (made.s.why || 'it did not answer') + '.', needs: needs };
        var info = made.s.info || cleanInfo(null);
        lastInfo.exec = info;
        if (info.version < needs) return { state: 'outdated', message: outdatedText(info, needs).replace(/^the runner/, 'The runner') + '.', version: info.version, build: info.build, needs: needs };
        execFailedUntil = 0; execLastError = '';
        return { state: 'ok', message: 'The runner is up to date: version ' + info.version + (info.build ? ', built ' + info.build : '') + ' (this CodeMini needs ' + needs + ').', version: info.version, build: info.build, needs: needs };
    }

    window.CodeMiniRunner = Object.freeze({
        ensure: ensure,
        checkRunner: checkRunner,
        // What the runner last said about itself (null until a page has answered), and what this app needs.
        runnerInfo: function () { return { needs: { preview: RUNNER_NEEDS.preview, exec: RUNNER_NEEDS.exec }, preview: lastInfo.preview && Object.assign({}, lastInfo.preview), exec: lastInfo.exec && Object.assign({}, lastInfo.exec) }; },
        execHost: execHost,
        killHost: function (key) { dropHost(String(key || 'default')); },
        hasHost: function (key) { var h = hosts[String(key || 'default')]; var s = h && sessions.get(h.frame); return !!(s && s.ready); },
        hostApi: function (key) { var h = hosts[String(key || 'default')]; return h ? h.api : null; },
        execError: function () { return execLastError; },
        retryExec: function () { execFailedUntil = 0; execLastError = ''; },
        wipe: wipe,
        popout: popout,
        shellUrl: function () { var c = config(); return c.enabled ? c.shell : ''; },
        fail: fail,
        lastError: function () { return lastError; },
        active: function (iframe) { var s = iframe && sessions.get(iframe); return !!(s && s.ready && iframe.dataset.cmRunner === '1'); },
        mint: function (iframe, blob) { return rpc(iframe, 'mint', { blob: blob }); },
        show: function (iframe, url) { return rpc(iframe, 'show', { url: url }); },
        // Write HTML into the page that is already showing (the "in-place rewrite" reload mode). Rejects if none is.
        rewrite: function (iframe, html) { return rpc(iframe, 'rewrite', { html: html }); },
        diagnostics: function () {
            var c = config();
            return { status: status, mode: modeFor('preview'), lastError: lastError, runner: c.shell || '(not configured)', configNote: c.reason || '', app: location.origin,
                online: typeof navigator === 'undefined' ? null : navigator.onLine, retryInMs: Math.max(0, failedUntil - Date.now()) };
        },
        clear: function (iframe) { var s = sessions.get(iframe); if (s && s.ready) { try { post(iframe, s, { op: 'clear' }); } catch (e) { /* frame gone */ } } },
        revoke: function (iframe, urls) {
            var s = iframe && sessions.get(iframe);
            if (s && s.ready && urls && urls.length) { try { post(iframe, s, { op: 'revoke', urls: urls }); } catch (e) { /* frame gone */ } }
        },
        owns: function (url) { var c = config(); return !!(c.origin && typeof url === 'string' && url.indexOf('blob:' + c.origin + '/') === 0); },
        status: function () { return status; },
        modeFor: modeFor,
        retryNow: function () { failedUntil = 0; lastError = ''; }
    });
})();
