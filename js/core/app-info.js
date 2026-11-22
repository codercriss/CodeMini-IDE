// ==========================================
// app-info.js - single source of truth for version, project links and contact details.
// ==========================================
// Must load BEFORE settings-profile.js (its Settings > About markup is built when that file loads)
// and help-feedback.js. Keep `version` in sync with package.json and CACHE_NAME in sw.js;
// tests/app-info.test.js fails if the repository links or version drift apart.
(function () {
    const REPO = 'https://github.com/codercriss/CodeMini-IDE';
    window.APP_INFO = Object.freeze({
        name: 'CodeMini IDE',
        version: '1.6.0',
        // The integrated terminal's own version (the one in its banner). Raise it when the terminal gains or changes a capability.
        // Written here only: the banners read it when they print, so a release is one edit (tests/app-info.test.js checks both).
        terminalVersion: '1.1.0',
        build: '2026.11',
        copyright: 'Christian Forson',
        license: 'MIT',
        feedbackEmail: 'codercriss@gmail.com',
        links: Object.freeze({
            repo: REPO,
            license: REPO + '/blob/main/LICENSE',
            privacy: REPO + '/blob/main/PRIVACY.md',
            usage: REPO + '/blob/main/USAGE.md',
            issues: REPO + '/issues',
            security: REPO + '/blob/main/SECURITY.md',
            notices: REPO + '/blob/main/THIRD_PARTY_NOTICES.md',
            changelog: REPO + '/blob/main/CHANGELOG.md',
            live: 'https://codemini-ide.vercel.app/'
        })
    });
})();
