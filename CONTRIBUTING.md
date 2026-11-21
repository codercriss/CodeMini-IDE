# Contributing

Thanks for your interest in CodeMini.

## Setup

```bash
git clone https://github.com/codercriss/CodeMini-IDE.git
cd CodeMini-IDE
npm start      # http://localhost:3000
npm test
npm install && npx playwright install chromium   # only needed for e2e
npm run test:e2e
```

There is no build step and no dependencies to install. Edit a file, refresh the page.

## Guidelines

- Keep it dependency-free: plain HTML, CSS and JavaScript, with runtime libraries loaded from CDNs.
- Match the surrounding style (4-space indent, see `.editorconfig`).
- Comments should explain *why*, not *what*.
- Test in at least one Chromium-based browser and one other (Firefox or Safari) when touching storage, the service worker or the editor.
- If you touch the service worker: test a fresh install, an update from the previous version, and offline reload.

## Adding, renaming or moving files

When releasing a new version, change it in `package.json`, `js/core/app-info.js` and `CACHE_NAME` in `sw.js` together (`npm test` checks they match).

Update `index.html` (script order matters), the `STATIC_ASSETS` list in `sw.js`, and bump `CACHE_NAME`.

## Content and usage rules

[USAGE.md](USAGE.md) holds the rules (P1 to P6) for what content CodeMini hosts. Rule ids are stable: never renumber or reuse one, add a new id instead, and add a row to its "Changes to these rules" table. `npm test` (`tests/usage-rules.test.js`) checks the file's shape and links. The day `js/core/guard.js` exists, its Status section must stop saying "Planned, not built"; that test fails until it does.

## Tests

`npm test` runs every unit suite. Test Explorer's Python harness is checked on a real Pyodide by hand (`tests/real-pyodide-tests.manual.js`, see its header): run it when you change `PY_HARNESS` in `js/core/test-explorer.js`, because the Node suite can only check that the text is valid Python.

## Pull requests

Keep PRs focused, describe how you tested, and make sure `npm test` and `npm run test:e2e` pass. CI runs both on every PR. New user-facing behavior should come with an e2e suite or additions to an existing one (see `tests/e2e/`).

## Reporting bugs

Use the issue templates. Include browser, OS, whether the app was installed as a PWA, and any console errors.
