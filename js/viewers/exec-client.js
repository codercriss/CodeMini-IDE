// exec-client.js - the app's side of running Console and Terminal code on the runner (see runner/exec.js).
//
//   await CodeMiniExec.use('console' | 'terminal', winId)   true when this surface is set to Isolated and the runner's
//                                                            execution host is ready; false means "use the in-app engine"
//   CodeMiniExec.fallbackNotice(surface)                     a one-time sentence for when Isolated was wanted but not possible
//   await CodeMiniExec.run(winId, { lang, code, opts }, onOut, onAsk)
//                                                            resolves {value, plots, error, ms}; onOut(event) per output event
//                                                            ({kind: stdout|stderr|log|info|warn|error|html, text}); onAsk(text)
//                                                            answers Python's ainput()
//   CodeMiniExec.reset(winId, lang) / CodeMiniExec.kill(winId)
//
// Whatever the host returns is UNTRUSTED text. The callers escape it (or, for html events, sanitize it) before it is shown.
// One host per window/profile, so the Console and the Terminal of a window share JavaScript globals and the Python namespace.
(function () {
    'use strict';
    var noted = {};
    var key = function (winId) { var w = winId; try { w = w || localStorage.getItem('codemini_active_window'); } catch (e) { /* storage unavailable */ } return String(w || 'win_default'); };
    var runner = function () { return window.CodeMiniRunner || null; };

    window.CodeMiniExec = Object.freeze({
        async use(surface, winId) {
            var R = runner();
            if (!R || R.modeFor(surface) !== 'runner') return false;
            try { await R.execHost(key(winId)); return true; } catch (e) { return false; }
        },
        fallbackNotice(surface) {
            var R = runner();
            if (!R || R.modeFor(surface) !== 'runner' || noted[surface]) return '';
            noted[surface] = true;
            return 'Isolation is on for the ' + surface + ', but the runner could not be used (' + (R.execError() || 'unknown reason') + '), so this ran inside CodeMini itself.';
        },
        async run(winId, req, onOut, onAsk) {
            var api = await runner().execHost(key(winId));
            return api.run(req, onOut, onAsk);
        },
        // For callers that print everything at the end (the Terminal). Resolves {events, res}, or null when the in-app engine
        // should be used (Normal mode, or the runner is unavailable: `notify` then gets the one-time explanation).
        async runCollected(surface, req, notify) {
            if (!(await window.CodeMiniExec.use(surface))) {
                var note = window.CodeMiniExec.fallbackNotice(surface);
                if (note && notify) notify(note);
                return null;
            }
            var events = [];
            var ask = function (text) { return window.inlineInputPrompt ? window.inlineInputPrompt(text) : Promise.resolve(window.prompt(text) || ''); };
            try { return { events: events, res: await window.CodeMiniExec.run(undefined, req, function (e) { events.push(e); }, ask) }; }
            catch (e) { return { events: events, res: { value: null, plots: [], error: { name: 'Error', message: e.message, text: e.message } } }; }
        },
        async reset(winId, lang) { var api = await runner().execHost(key(winId)); return api.reset(lang); },
        kill(winId) { var R = runner(); if (R) R.killHost(key(winId)); },
        // A window is being left (isClosing false) or deleted (true). Never creates a host: a window that never ran code has nothing to clean up.
        forget(winId, isClosing) {
            var R = runner(); if (!R) return;
            var k = key(winId);
            if (isClosing) { R.killHost(k); return; }
            var api = R.hostApi(k);
            if (api) { api.reset('python').catch(function () { /* the host is going away anyway */ }); api.reset('sql').catch(function () { /* likewise */ }); api.reset('r').catch(function () { /* likewise */ }); }
        }
    });
})();
