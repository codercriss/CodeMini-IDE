# Third-party notices

CodeMini, Copyright (c) 2026 Christian Forson, is MIT licensed (see `LICENSE`). Almost all third-party code is not in this repository:
the libraries below are loaded at runtime from public CDNs and cached by the service worker for offline use.
The one exception is `diff`, which is vendored in `js/vendor/` (see the table). Each library remains under its own license. Check each project for the exact license of the version you deploy.

| Library | Used for | Source |
| --- | --- | --- |
| Monaco Editor | Code editor | https://github.com/microsoft/monaco-editor |
| emmet-monaco-es | Emmet in the editor | https://github.com/troy351/emmetio-monaco |
| Pyodide | Python in the browser | https://github.com/pyodide/pyodide |
| WebR | R in the browser | https://github.com/r-wasm/webr |
| sql.js | SQLite in the browser | https://github.com/sql-js/sql.js |
| php-wasm | PHP in the browser | https://github.com/seanmorris/php-wasm |
| pdf.js (`pdfjs-dist`) | PDF viewer | https://github.com/mozilla/pdf.js |
| archive-wasm | Archive extraction | https://github.com/Nexus-Mods/node-archive-wasm |
| JSZip | Zip creation | https://github.com/Stuk/jszip |
| fflate | Compression | https://github.com/101arrowz/fflate |
| marked | Markdown rendering | https://github.com/markedjs/marked |
| diff (jsdiff 9.0.0, BSD-3-Clause, vendored in `js/vendor/`, license in `js/vendor/diff-LICENSE.txt`) | Text diffing | https://github.com/kpdecker/jsdiff |
| Babel standalone | JSX/TS transform in previews | https://github.com/babel/babel |
| github-markdown-css | Markdown styling | https://github.com/sindresorhus/github-markdown-css |
| Remix Icon | Icons | https://github.com/Remix-Design/RemixIcon |
| Font Awesome Free | Icons | https://fontawesome.com/license/free |
