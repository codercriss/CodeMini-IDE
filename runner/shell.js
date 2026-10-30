// CodeMini runner shell. This page lives on its OWN origin, so everything a previewed page does here (storage,
// cookies, scripts) is walled off from the CodeMini app. It does three small things and nothing else:
//
//   1. mint blob: URLs for files CodeMini sends (a blob URL only works for pages of the origin that made it, so
//      they have to be made here), and show one of them in the inner frame;
//   2. relay postMessage traffic between CodeMini and the previewed page (console, network, inspector, reload);
//   3. refuse everything that does not come from an allowed CodeMini origin.
//
// It holds no secrets and reads nothing from the app. The previewed page shares this origin, so it can reach this
// script's window; that is why CodeMini treats every message that comes back as untrusted data, wraps relayed page
// messages in an envelope, and authenticates control messages with a nonce only this shell and CodeMini know.
(function () {
    'use strict';
    var CFG = window.CM_RUNNER_CONFIG || { allowedParents: [] };
    var SELF = location.origin;
    // The CodeMini window. Embedded: the parent. Opened as a pop-out (?popout=1): the window that opened us. A runner
    // opened any other way has no host and does nothing.
    var popout = window.parent === window && /[?&]popout=1(&|$)/.test(location.search);
    var host = window.parent !== window ? window.parent : (popout ? window.opener : null);
    var hostOrigin = null, nonce = null;
    var page = document.getElementById('page');
    var minted = Object.create(null);                              // blob: URLs this shell made
    var shown = 0, current = '';                                   // current: the blob URL the frame is known to be showing                                                 // id of the latest 'show' request
    var MAX_BLOB = 256 * 1024 * 1024;
    var SHOW_MS = 4000;                                            // how long a frame may stay blank before we call the page failed

    function allowed(origin) { return CFG.allowedParents.indexOf(origin) !== -1; }
    function send(msg) {
        if (!host || !hostOrigin) return;
        if (msg.op !== 'page') msg.nonce = nonce;
        try { host.postMessage(msg, hostOrigin); } catch (e) { /* the app window is gone */ }
    }

    // Navigate the inner frame to a blob URL we made and report when the frame really shows it (or why it does not).
    function showUrl(id, url) {
        if (typeof url !== 'string' || !minted[url]) { send({ cmRunner: 1, op: 'shown', id: id, error: 'unknown url' }); return; }
    shown = id; current = '';
    var mine = id, want = url, done = false, deadline = Date.now() + SHOW_MS, timer = null;
    // Report once the frame really shows OUR page. The first `load` event can belong to the frame's old
    // about:blank (WebKit fires it), so events alone prove nothing: look at what the frame holds.
    //   our page, finished  -> loaded         our page, still going at the deadline -> loaded
    //   foreign / unreachable (blocked)  -> failed at once        still blank at the deadline -> failed
    var finish = function (error) {
        if (done) return; done = true; clearInterval(timer); page.onload = null;
        if (mine !== shown) return;
        send(error ? { cmRunner: 1, op: 'shown', id: mine, error: 'the page did not load: ' + error } : { cmRunner: 1, op: 'shown', id: mine });
    };
    var look = function () {
        if (done) return;
        if (mine !== shown) { finish(); return; }
        var w, doc;
        try { w = page.contentWindow; doc = w && w.document; }
        catch (err) { finish('the frame is not reachable (' + (err && err.name) + ')'); return; }
        var here = '';
        try { here = (doc && doc.documentElement) ? w.location.href : ''; }
        catch (err) { finish('the frame is not reachable (' + (err && err.name) + ')'); return; }
        if (here === want) { if (doc.readyState === 'complete' || Date.now() >= deadline) { current = want; finish(); } return; }
        if (Date.now() >= deadline) finish(here ? 'the frame still shows ' + here.split(':')[0] + ': after ' + (SHOW_MS / 1000) + ' s' : 'the frame stayed empty for ' + (SHOW_MS / 1000) + ' s');
    };
    page.onload = look;
    timer = setInterval(look, 100);
    page.src = url;
    }

    // Pop-out: take the blobs another shell made (the app brings them over), make them again HERE, and give back the
    // address of the page. Blob URLs belong to the document that made them, so every reference between the files has to
    // be rewritten to the new URLs: files that mention no other file first, then the ones that mention those, and so on.
    function importAll(d) {
        var entries = Array.isArray(d.entries) ? d.entries.filter(function (e) { return e && typeof e.url === 'string' && e.blob instanceof Blob; }) : [];
        if (typeof d.html !== 'string') return Promise.reject(new Error('no page to import'));
        var map = {}, textual = /^(text\/|application\/(javascript|json|xml|x-javascript)|image\/svg)/;
        function swap(text) { Object.keys(map).forEach(function (old) { text = text.split(old).join(map[old]); }); return text; }
        function make(e) {
            var blob = e.text !== undefined ? new Blob([swap(e.text)], { type: e.blob.type }) : e.blob;
            var url = URL.createObjectURL(blob); minted[url] = blob; map[e.url] = url;
        }
        return Promise.all(entries.map(function (e) { return textual.test(e.blob.type) ? e.blob.text().then(function (t) { e.text = t; }) : null; })).then(function () {
            var left = entries.slice(), progressed = true;
            while (left.length && progressed) {
                progressed = false;
                left = left.filter(function (e) {
                    var waiting = e.text !== undefined && entries.some(function (o) { return o !== e && !map[o.url] && e.text.indexOf(o.url) !== -1; });
                    if (waiting) return true;
                    make(e); progressed = true; return false;
                });
            }
            left.forEach(make);                          // files that refer to each other in a circle: made with what exists
            var html = new Blob([swap(d.html)], { type: 'text/html' });
            var url = URL.createObjectURL(html); minted[url] = html;
            return url;
        });
    }

    // Wipes what previewed pages stored here for ONE data domain (the same ownership rules as wipePreviewStorage in the
    // app, which can no longer reach this origin's storage). '' is the shared domain; otherwise the profile's own
    // "__cmd:<domain>:" namespace. Nothing outside the given domain is touched.
    function wipeStorage(domain) {
        var NS = domain ? '__cmd:' + domain + ':' : '';
        var ownsLocal = function (k) { return domain ? k.indexOf(NS) === 0 : !(k.indexOf('codemini_') === 0 || k.indexOf('codemini-') === 0 || k.indexOf('__cmd:') === 0); };
        var ownsSession = function (k) { return domain ? k.indexOf(NS) === 0 : k.indexOf('__cmd:') !== 0; };
        var ownsDb = function (n) { return domain ? n.indexOf(NS) === 0 : !(n.indexOf('CodeMiniDB') === 0 || n.indexOf('__cmd:') === 0); };
        [[window.localStorage, ownsLocal], [window.sessionStorage, ownsSession]].forEach(function (pair) {
            try {
                var store = pair[0], keys = [];
                for (var i = 0; i < store.length; i++) keys.push(store.key(i));
                keys.filter(pair[1]).forEach(function (k) { store.removeItem(k); });
            } catch (err) { /* storage unavailable */ }
        });
        if (!window.indexedDB || !window.indexedDB.databases) return Promise.resolve();
        var drop = function (name) {
            return new Promise(function (resolve) {
                try {
                    var req = window.indexedDB.deleteDatabase(name);
                    req.onsuccess = req.onerror = function () { resolve(); };
                    req.onblocked = function () { setTimeout(resolve, 1500); };
                    setTimeout(resolve, 4000);
                } catch (err) { resolve(); }
            });
        };
        return window.indexedDB.databases().then(function (list) { return Promise.all(list.map(function (x) { return x.name; }).filter(ownsDb).map(drop)); }).catch(function () { /* nothing to wipe */ });
    }

    function control(e, d) {
        if (d.op === 'hello') {
            if (hostOrigin) return;                                // the first valid hello pins the host for this load
            if (typeof d.nonce !== 'string' || d.nonce.length < 16 || d.nonce.length > 128) return;
            hostOrigin = e.origin; nonce = d.nonce;
            send({ cmRunner: 1, op: 'hello-ack', version: (CFG.version | 0), build: String(CFG.build || '') });   // see config.js: lets the app tell an out-of-date runner
            // A pop-out has no further need of the link back to the app, and the page inside it could use it (to
            // navigate the app's tab). We keep our own reference to talk to the app; the page gets no window.opener.
            if (popout) { try { window.opener = null; } catch (err) { /* read-only in some browsers */ } }
            return;
        }
        if (!hostOrigin) return;
        if (d.op === 'mint') {
            var b = d.blob;
            if (!(b instanceof Blob) || b.size > MAX_BLOB) { send({ cmRunner: 1, op: 'minted', id: d.id, error: 'bad blob' }); return; }
            try { var url = URL.createObjectURL(b); minted[url] = b; send({ cmRunner: 1, op: 'minted', id: d.id, url: url }); }
            catch (err) { send({ cmRunner: 1, op: 'minted', id: d.id, error: String(err && err.message || err) }); }
        } else if (d.op === 'revoke') {
            (Array.isArray(d.urls) ? d.urls : []).forEach(function (u) { if (minted[u]) { URL.revokeObjectURL(u); delete minted[u]; } });
        } else if (d.op === 'show') {
            showUrl(d.id, d.url);
        } else if (d.op === 'wipe') {
            if (typeof d.domain !== 'string' || d.domain.length > 200) { send({ cmRunner: 1, op: 'wiped', id: d.id, error: 'bad domain' }); return; }
            wipeStorage(d.domain).then(function () { send({ cmRunner: 1, op: 'wiped', id: d.id }); });
        } else if (d.op === 'export') {
            // Everything this shell has made, so a pop-out can re-make it under its own origin (blob URLs are not shared
            // between documents). The blobs travel by structured clone; no URL is fetched.
            var out = [];
            Object.keys(minted).forEach(function (u) { out.push({ url: u, blob: minted[u] }); });
            send({ cmRunner: 1, op: 'exported', id: d.id, entries: out });
        } else if (d.op === 'import') {
            importAll(d).then(function (docUrl) { showUrl(d.id, docUrl); }, function (err) { send({ cmRunner: 1, op: 'shown', id: d.id, error: 'import failed: ' + String(err && err.message || err) }); });
        } else if (d.op === 'rewrite') {
            // The "in-place rewrite" reload mode: write new HTML into the document that is already showing, keeping its
            // window. Only possible while the frame still holds a page we put there (same origin as this shell).
            try {
                var rw = page.contentWindow, rdoc = rw && rw.document;
                if (typeof d.html !== 'string' || d.html.length > MAX_BLOB) throw new Error('bad html');
                if (!current || !rdoc || !rdoc.documentElement || rw.location.href !== current) throw new Error('no page to rewrite');
                rdoc.open(); rdoc.write(d.html); rdoc.close();
                // document.open() makes the document adopt THIS script's address, so that is what the frame shows now;
                // remember it, or the next rewrite would think the page had been replaced.
                current = rw.location.href;
                send({ cmRunner: 1, op: 'rewritten', id: d.id });
            } catch (err) { send({ cmRunner: 1, op: 'rewritten', id: d.id, error: String(err && err.message || err) }); }
        } else if (d.op === 'clear') {
            current = ''; shown = 0; page.onload = null; page.src = 'about:blank';
        }
    }

    window.addEventListener('message', function (e) {
        var d = e.data;
        if (host && e.source === host) {
            if (!allowed(e.origin)) return;
            if (hostOrigin && e.origin !== hostOrigin) return;
            if (d && typeof d === 'object' && d.cmRunner === 1) { control(e, d); return; }
            if (!hostOrigin) return;                               // nothing is relayed before the handshake
            try { if (page.contentWindow) page.contentWindow.postMessage(d, SELF); } catch (err) { /* page is gone */ }
            return;
        }
        if (page.contentWindow && e.source === page.contentWindow) {
            // Only the page we put there, and only while it is still on this origin (a page that navigated to another
            // site does not get to talk to the app through us).
            if (e.origin !== SELF || !hostOrigin) return;
            send({ cmRunner: 1, op: 'page', data: d });
        }
    });

    // Tell the embedding window we are here. The message carries nothing private. Chrome and Safari tell us who
    // embeds us, so we can address them exactly; elsewhere the (empty) announcement goes to any parent and the real
    // exchange only starts when an allowed origin answers.
    if (host) {
        var guess = (location.ancestorOrigins && location.ancestorOrigins[0]) || null;
        if (!guess || allowed(guess)) host.postMessage({ cmRunner: 1, op: 'ready', v: 1 }, guess || '*');
    }
})();
