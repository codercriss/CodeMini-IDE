// The only addresses allowed to embed this runner and send it work. Keep it in step with the frame-ancestors
// value in vercel.json (the browser enforces that one; this list is the second, in-page check).
(function () {
    'use strict';
    var parents = ['https://codemini-ide.vercel.app'];
    // Development: a runner served from localhost may also be driven by a CodeMini served from localhost.
    // The deployed runner (a vercel.app host) never includes these.
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
        parents.push('http://localhost:8765', 'http://127.0.0.1:8765');
    }
    window.CM_RUNNER_CONFIG = Object.freeze({ allowedParents: Object.freeze(parents) });
})();
