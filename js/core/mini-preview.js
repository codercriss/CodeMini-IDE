// ==========================================
// mini-preview.js: Mini Preview, UI/UX specs feature 15
// ==========================================
// A small live preview of the selected block of code, shown as a MINI PREVIEW section at the top of the Now Island's Now pane, without
// opening the full Live Preview dock.
//
//   Trigger     the editor's right-click action "Preview selected" (id preview-selection, order 1.6, only with a selection), Alt+P, and on a
//               touch screen a small floating "Preview selected" pill that appears above a steady selection.
//   Previewable HTML, CSS, JavaScript, Markdown, SVG, JSON, CSV. An HTML fragment is wrapped in a document; CSS is applied to the project's
//               index.html (or a sample page, switchable); JavaScript runs on a blank page with <div id="app"> and a console capture;
//               Markdown uses the same renderer as the Live Preview; JSON and CSV are drawn as a formatted tree and a table.
//   Safety      the page is rendered by the SAME runner surface and the SAME Isolation setting as the Live Preview (Settings > Security):
//               isolated it is a blob: page minted by the runner (it cannot read files, the GitHub token or My Keys); if the runner cannot
//               be reached it falls back to the app's own origin with the amber "Normal" indicator, exactly like the Live Preview.
//               It is guarded by WorkspaceTrust like "Run in console". Everything the page sends back is untrusted text: it is cleaned
//               here (cleanPageMessage) and only ever drawn with textContent.
//   Limits      200 KB per snippet, one Mini Preview per window.
//
// The pure rules (kinds, the page builders, the CSV and JSON drawing, the message cleaning, the geometry, the console log) are exported
// for Node (tests/mini-preview.test.js); the browser half (the section, the editor hooks, the pill, the runner use) follows them.
(function (root) {
    'use strict';
    const W = root;

    // ---------------------------------------------------------------------------------------------
    // Pure: what can be previewed, and whether this selection can be
    // ---------------------------------------------------------------------------------------------
    const MAX_BYTES = 200 * 1024;
    const KINDS = ['html', 'css', 'javascript', 'markdown', 'svg', 'json', 'csv'];
    const KIND_LABEL = { html: 'HTML', css: 'CSS', javascript: 'JavaScript', markdown: 'Markdown', svg: 'SVG', json: 'JSON', csv: 'CSV' };
    const EXT_KIND = { html: 'html', htm: 'html', css: 'css', js: 'javascript', mjs: 'javascript', cjs: 'javascript', md: 'markdown', markdown: 'markdown', svg: 'svg', json: 'json', csv: 'csv' };
    const LANG_KIND = { html: 'html', css: 'css', javascript: 'javascript', markdown: 'markdown', json: 'json' };
    const UNSUPPORTED = 'Mini Preview works on HTML, CSS, JavaScript, Markdown, SVG, JSON and CSV.';

    function extOf(name) { const m = /\.([A-Za-z0-9]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }

    // The file's extension decides. The editor's language id is only used when the name has no extension (an untitled tab); a file
    // that has a known-but-unsupported extension (.py, .jsx) is never guessed at from its language.
    function kindFor(fileName, languageId) {
        const ext = extOf(fileName);
        if (ext) return Object.prototype.hasOwnProperty.call(EXT_KIND, ext) ? EXT_KIND[ext] : null;
        const lang = String(languageId || '').toLowerCase();
        return Object.prototype.hasOwnProperty.call(LANG_KIND, lang) ? LANG_KIND[lang] : null;
    }

    function byteLength(text) {
        const s = String(text);
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
        if (typeof Buffer !== 'undefined') return Buffer.byteLength(s, 'utf8');
        return s.length * 3;
    }

    // `text` is the selection. Returns { ok: true, kind } or { ok: false, reason, message }.
    function checkSelection(fileName, languageId, text) {
        if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty', message: 'Select some code first.' };
        const kind = kindFor(fileName, languageId);
        if (!kind) return { ok: false, reason: 'kind', message: UNSUPPORTED };
        const bytes = byteLength(text);
        if (bytes > MAX_BYTES) return { ok: false, reason: 'size', message: 'The selection is ' + Math.ceil(bytes / 1024) + ' KB. Mini Preview takes up to ' + (MAX_BYTES / 1024) + ' KB.' };
        return { ok: true, kind };
    }

    const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ESC[c]); }
    // Text that goes inside a <script> or <style> element must not be able to close it (or open an HTML comment that swallows the close).
    function escapeScript(code) { return String(code).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--'); }
    function escapeStyle(css) { return String(css).replace(/<\/(style)/gi, '<\\/$1').replace(/<!--/g, '<\\!--'); }

    // ---------------------------------------------------------------------------------------------
    // Pure: the program that runs inside the previewed page (captures console.* and errors, tells the app)
    // ---------------------------------------------------------------------------------------------
    // Written as a function so it is checked as code, then turned into ONE line of text (no comments, every statement ends in a semicolon):
    // a single line means inserting it never moves the line numbers of the person's own code.
    function pageProgram() {
        var MAX = 400, P = window.parent;
        function post(m) { try { P.postMessage(m, '*'); } catch (e) { /* the app is gone */ } }
        function fmt(v) {
            try {
                if (typeof v === 'string') return v;
                if (v instanceof Error) return String(v.name || 'Error') + ': ' + String(v.message || '');
                if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
                if (v && typeof v === 'object') { var j = JSON.stringify(v); return j === undefined ? String(v) : j; }
                return String(v);
            } catch (e) { return '[unprintable]'; }
        }
        ['log', 'info', 'warn', 'error', 'debug'].forEach(function (lvl) {
            var orig = console[lvl];
            console[lvl] = function () {
                var parts = [];
                for (var i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i]));
                post({ cmMini: 1, type: 'console', level: lvl, text: parts.join(' ').slice(0, MAX) });
                try { if (orig) orig.apply(console, arguments); } catch (e) { /* the browser console is not ours */ }
            };
        });
        window.addEventListener('error', function (e) {
            post({ cmMini: 1, type: 'error', text: String(e.message || 'Error').slice(0, MAX), line: e.lineno | 0, col: e.colno | 0 });
        });
        window.addEventListener('unhandledrejection', function (e) {
            var r = e.reason;
            post({ cmMini: 1, type: 'error', text: ('Unhandled rejection: ' + fmt(r)).slice(0, MAX), line: 0, col: 0 });
        });
        window.addEventListener('load', function () {
            var ms = 0;
            try { ms = Math.round(performance.now()); } catch (e) { /* no timer */ }
            post({ cmMini: 1, type: 'loaded', ms: ms });
        });
    }
    const PAGE_PROGRAM = '(' + String(pageProgram).replace(/\s*\n\s*/g, ' ') + ')();';
    const CONSOLE_SNIPPET = '<script>' + escapeScript(PAGE_PROGRAM) + '</script>';

    // ---------------------------------------------------------------------------------------------
    // Pure: the page for each kind. Each builder returns { html, codeStartLine } or { error: { message, line?, col? } }.
    // codeStartLine is the line of the page (1-based) where the first line of the person's selection sits, so an error the page reports
    // can be walked back to a line of the editor (mapErrorToEditor).
    // ---------------------------------------------------------------------------------------------
    const META = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
    const BASE_STYLE = '<style>html,body{background:#fff;color:#1f2328}body{margin:8px;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}</style>';

    function linesBefore(prefix) { return prefix.split('\n').length; }
    function build(prefix, code, suffix) { return { html: prefix + code + suffix, codeStartLine: linesBefore(prefix) }; }

    // Put the console program right after <head> (or <html>, or first). One line, so nothing below it moves.
    function injectIntoDocument(doc, snippet) {
        let m = /<head(\s[^>]*)?>/i.exec(doc);
        if (m) return doc.slice(0, m.index + m[0].length) + snippet + doc.slice(m.index + m[0].length);
        m = /<html(\s[^>]*)?>/i.exec(doc);
        if (m) return doc.slice(0, m.index + m[0].length) + '<head>' + snippet + '</head>' + doc.slice(m.index + m[0].length);
        return snippet + doc;
    }

    function buildHtml(text, snip) {
        if (/<html[\s>]/i.test(text) || /^\s*<!doctype/i.test(text)) return { html: injectIntoDocument(text, snip), codeStartLine: 1 };
        return build('<!doctype html><html><head>' + META + snip + BASE_STYLE + '</head><body>\n', text, '\n</body></html>');
    }

    function buildJavascript(text, snip) {
        return build('<!doctype html><html><head>' + META + snip + BASE_STYLE + '</head><body><div id="app"></div>\n<script>\n', escapeScript(text), '\n</script></body></html>');
    }

    // The page CSS is tried against when the project has no index.html (or when the person chooses it).
    const SAMPLE_BODY = '<main class="container">\n'
        + '<h1>Heading</h1>\n<p>A paragraph with <a href="#">a link</a>, <strong>bold</strong> and <em>emphasis</em> text.</p>\n'
        + '<button class="btn button" type="button">Button</button>\n'
        + '<ul><li>First item</li><li>Second item</li><li>Third item</li></ul>\n'
        + '<form><label>Name <input type="text" placeholder="Type here"></label></form>\n'
        + '<div class="card"><h2>Card</h2><p>Some card text.</p></div>\n</main>';
    function buildCss(text, snip, opts) {
        const style = '<style data-cm-mini>\n' + escapeStyle(text) + '\n</style>';
        const index = opts && typeof opts.indexHtml === 'string' ? opts.indexHtml : '';
        if (index && !(opts && opts.sample)) {
            // Last in <head> so it wins over the page's own rules the way the person's edit would.
            const withSnippet = injectIntoDocument(index, snip);
            const m = /<\/head\s*>/i.exec(withSnippet);
            const html = m ? withSnippet.slice(0, m.index) + style + withSnippet.slice(m.index) : injectIntoDocument(withSnippet, style);
            return { html, codeStartLine: 1 };
        }
        return build('<!doctype html><html><head>' + META + snip + BASE_STYLE + '</head><body>' + SAMPLE_BODY + '\n' + '<style data-cm-mini>\n', escapeStyle(text), '\n</style></body></html>');
    }

    function buildSvg(text, snip) {
        const body = String(text).replace(/^\s*<\?xml[\s\S]*?\?>/i, '').replace(/<!doctype[^>]*>/i, '').trim();
        if (!/<svg[\s>]/i.test(body)) return { error: { message: 'There is no <svg> element in the selection.' } };
        return build('<!doctype html><html><head>' + META + snip + '<style>html,body{margin:0;height:100%;background:#fff}body{display:flex;align-items:center;justify-content:center}svg{max-width:100%;max-height:100%}</style></head><body>\n', body, '\n</body></html>');
    }

    // Markdown: the same renderer and sanitizer as the Live Preview (marked, then CodeMiniEscape.sanitize). `opts.sanitizeSource` is the text of
    // that function; without it (Node) the text is shown escaped, never as markup.
    function buildMarkdown(text, snip, opts) {
        const sanitize = opts && typeof opts.sanitizeSource === 'string' ? opts.sanitizeSource : '';
        const head = '<!doctype html><html><head>' + META + snip
            + '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.2.0/github-markdown.min.css">'
            + '<script src="https://cdn.jsdelivr.net/npm/marked@18.0.14/lib/marked.umd.js"></script>'
            + '<style>body{box-sizing:border-box;margin:0;padding:16px;background:#fff}#content{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}</style></head>'
            + '<body class="markdown-body"><textarea id="raw-md" style="display:none;">\n';
        const tail = '</textarea><div id="content"></div><script>'
            + (sanitize ? 'var __cmSanitize=' + escapeScript(sanitize) + ';marked.use({gfm:true,breaks:true});var __c=document.getElementById("content");'
                + '__c.replaceChildren.apply(__c,Array.prototype.slice.call(new DOMParser().parseFromString(__cmSanitize(marked.parse(document.getElementById("raw-md").value)),"text/html").body.childNodes));'
                : 'document.getElementById("content").textContent=document.getElementById("raw-md").value;')
            + '</script></body></html>';
        return build(head, escapeHtml(text), tail);
    }

    // JSON: where an error is. Some engines say "(line 1 column 13)" or "at position 12"; recent V8 says neither for a bad token. When the
    // message has no position, it is found: a prefix of valid JSON is still "viable" (it parses, or only runs out of input), and viability
    // never comes back once lost, so a binary search finds the first character that spoils it (about 18 parses for 200 KB).
    function jsonViable(prefix) {
        try { JSON.parse(prefix); return true; }
        catch (e) {
            const msg = String((e && e.message) || '');
            const at = /position (\d+)/i.exec(msg);
            if (at && +at[1] >= prefix.length) return true;          // the error is the end of the prefix: it only ran out of input
            return /end of (json )?(input|data)|unterminated|unexpected eof/i.test(msg);
        }
    }
    function lineColOf(text, offset) {
        const upTo = String(text).slice(0, offset).split('\n');
        return { line: upTo.length, col: upTo[upTo.length - 1].length + 1 };
    }
    function jsonErrorPosition(message, text) {
        const lc = /line (\d+) column (\d+)/i.exec(message || '');
        if (lc) return { line: +lc[1], col: +lc[2] };
        const p = /position (\d+)/i.exec(message || '');
        if (p) return lineColOf(text, +p[1]);
        const s = String(text);
        if (!s.length) return { line: 1, col: 1 };
        let lo = 0, hi = s.length;                                   // lo is viable; the whole text is not
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (jsonViable(s.slice(0, mid))) lo = mid; else hi = mid; }
        return lineColOf(s, lo);
    }
    // Pretty JSON as markup with a class per token. The text is tokenized FIRST and each piece escaped on its own (escaping first would turn
    // the quotes into &quot; and nothing would match); only escaped text and fixed class names are produced.
    function jsonToHtml(value) {
        const pretty = JSON.stringify(value, null, 2);
        if (pretty === undefined) return '';
        const re = /("(?:\\.|[^\\"])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
        let out = '', last = 0, m;
        while ((m = re.exec(pretty))) {
            out += escapeHtml(pretty.slice(last, m.index));
            const tok = escapeHtml(m[0]);
            if (m[1]) out += m[2] ? '<span class="k">' + escapeHtml(m[1]) + '</span>' + escapeHtml(m[2]) : '<span class="s">' + tok + '</span>';
            else if (m[3]) out += '<span class="b">' + tok + '</span>';
            else if (m[0] === 'null') out += '<span class="z">null</span>';
            else out += '<span class="n">' + tok + '</span>';
            last = m.index + m[0].length;
        }
        return out + escapeHtml(pretty.slice(last));
    }
    function buildJson(text, snip) {
        let value;
        try { value = JSON.parse(text); }
        catch (e) {
            const pos = jsonErrorPosition(e && e.message, text);
            return { error: Object.assign({ message: 'Invalid JSON: ' + String((e && e.message) || e).slice(0, 200) }, pos || {}) };
        }
        const style = '<style>html,body{background:#fff}body{margin:0;padding:12px}pre{margin:0;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;color:#24292f}'
            + '.k{color:#0550ae}.s{color:#0a3069}.n{color:#116329}.b{color:#cf222e}.z{color:#6e7781;font-style:italic}</style>';
        return build('<!doctype html><html><head>' + META + snip + style + '</head><body><pre>', jsonToHtml(value), '</pre></body></html>');
    }

    // CSV: quoted fields, "" for a quote, CRLF, a trailing newline, and a delimiter found from the first line (comma, semicolon or tab).
    function detectDelimiter(text) {
        const first = String(text).split(/\r?\n/, 1)[0] || '';
        let best = ',', bestN = 0;
        [',', ';', '\t'].forEach((d) => {
            let n = 0, q = false;
            for (let i = 0; i < first.length; i++) { const c = first[i]; if (c === '"') q = !q; else if (c === d && !q) n++; }
            if (n > bestN) { best = d; bestN = n; }
        });
        return best;
    }
    function parseCsv(text) {
        const s = String(text), d = detectDelimiter(s), rows = [];
        let row = [], field = '', q = false, i = 0;
        while (i < s.length) {
            const c = s[i];
            if (q) {
                if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
                field += c; i++; continue;
            }
            if (c === '"' && field === '') { q = true; i++; continue; }
            if (c === d) { row.push(field); field = ''; i++; continue; }
            if (c === '\r' || c === '\n') {
                if (c === '\r' && s[i + 1] === '\n') i++;
                row.push(field); rows.push(row); row = []; field = ''; i++; continue;
            }
            field += c; i++;
        }
        if (field !== '' || row.length) { row.push(field); rows.push(row); }
        return rows.filter((r) => !(r.length === 1 && r[0] === ''));
    }
    const CSV_MAX_ROWS = 200;
    function csvToHtml(rows, maxRows) {
        const cap = maxRows || CSV_MAX_ROWS;
        if (!rows.length) return '';
        const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
        const cell = (tag, v) => '<' + tag + '>' + escapeHtml(v === undefined ? '' : v) + '</' + tag + '>';
        const line = (r, tag) => '<tr>' + Array.from({ length: cols }, (_, i) => cell(tag, r[i])).join('') + '</tr>';
        const body = rows.slice(1, cap + 1).map((r) => line(r, 'td')).join('');
        const more = rows.length - 1 > cap ? '<p class="more">Showing the first ' + cap + ' of ' + (rows.length - 1) + ' rows.</p>' : '';
        return '<table><thead>' + line(rows[0], 'th') + '</thead><tbody>' + body + '</tbody></table>' + more;
    }
    function buildCsv(text, snip) {
        const rows = parseCsv(text);
        if (!rows.length) return { error: { message: 'There is no data in the selection.' } };
        const style = '<style>html,body{background:#fff}body{margin:0;padding:8px}table{border-collapse:collapse;font:12px/1.4 system-ui,sans-serif;color:#1f2328}'
            + 'th,td{border:1px solid #d0d7de;padding:4px 8px;text-align:left;white-space:nowrap}th{background:#f6f8fa;font-weight:600}.more{font:11px system-ui,sans-serif;color:#6e7781;margin:6px 0 0}</style>';
        return { html: '<!doctype html><html><head>' + META + snip + style + '</head><body>' + csvToHtml(rows) + '</body></html>', codeStartLine: 1 };
    }

    // opts: { indexHtml, sample } for CSS; { sanitizeSource } for Markdown; { clean: true } leaves the console program out (the page that is
    // handed to the Live Preview, which has its own).
    function buildDocument(kind, text, opts) {
        const t = String(text), snip = opts && opts.clean ? '' : CONSOLE_SNIPPET;
        switch (kind) {
            case 'html': return buildHtml(t, snip);
            case 'css': return buildCss(t, snip, opts);
            case 'javascript': return buildJavascript(t, snip);
            case 'markdown': return buildMarkdown(t, snip, opts);
            case 'svg': return buildSvg(t, snip);
            case 'json': return buildJson(t, snip);
            case 'csv': return buildCsv(t, snip);
            default: return { error: { message: UNSUPPORTED } };
        }
    }

    // "Open in Live Preview": the Live Preview already knows md, json, csv, svg, css and js files by name, so those go as the raw text; HTML
    // goes as a whole page (a fragment is wrapped, without the console program: the Live Preview brings its own).
    const SNIPPET_NAME = { html: 'snippet.html', css: 'snippet.css', javascript: 'snippet.js', markdown: 'snippet.md', svg: 'snippet.svg', json: 'snippet.json', csv: 'snippet.csv' };
    function snippetForLivePreview(kind, text) {
        if (!Object.prototype.hasOwnProperty.call(SNIPPET_NAME, kind)) return null;
        if (kind === 'html') { const d = buildDocument('html', text, { clean: true }); return { name: SNIPPET_NAME.html, content: d.html }; }
        return { name: SNIPPET_NAME[kind], content: String(text) };
    }

    // ---------------------------------------------------------------------------------------------
    // Pure: what comes back from the page (untrusted), and how an error is walked back to the editor
    // ---------------------------------------------------------------------------------------------
    const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
    const TYPES = ['console', 'error', 'loaded'];
    const clampInt = (v, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 && n <= max ? n : 0; };
    // The page shares the runner's origin, so anything it sends is data: a known type, short text, small integers; nothing else survives.
    function cleanPageMessage(d) {
        if (!d || typeof d !== 'object' || d.cmMini !== 1 || TYPES.indexOf(d.type) === -1) return null;
        if (d.type === 'loaded') return { type: 'loaded', ms: clampInt(d.ms, 600000) };
        const text = typeof d.text === 'string' ? d.text.slice(0, 400) : String(d.text === undefined ? '' : d.text).slice(0, 400);
        if (d.type === 'console') return { type: 'console', level: LEVELS.indexOf(d.level) === -1 ? 'log' : d.level, text };
        return { type: 'error', text, line: clampInt(d.line, 1e6), col: clampInt(d.col, 1e6) };
    }

    // err: { line, col } from the page; sel: { startLine, startColumn } of the selection; snippetLines: how many lines the selection has.
    function mapErrorToEditor(err, codeStartLine, sel, snippetLines) {
        const start = { line: sel.startLine, col: sel.startColumn };
        if (!err || !err.line) return start;
        const rel = Math.min(Math.max(1, err.line - codeStartLine + 1), Math.max(1, snippetLines || 1));
        const line = sel.startLine + rel - 1;
        const col = rel === 1 ? sel.startColumn + Math.max(0, (err.col || 1) - 1) : Math.max(1, err.col || 1);
        return { line, col };
    }

    // ---------------------------------------------------------------------------------------------
    // Pure: the console strip, the status row, the viewport row, the labels
    // ---------------------------------------------------------------------------------------------
    function createLog(max) {
        const cap = max || 100;
        let entries = [], errors = 0;
        return {
            push(e) {
                if (!e || (e.type !== 'console' && e.type !== 'error')) return;
                const isErr = e.type === 'error' || e.level === 'error';
                if (isErr) errors++;
                entries.push({ level: e.type === 'error' ? 'error' : e.level, text: e.text });
                if (entries.length > cap) entries = entries.slice(entries.length - cap);
            },
            clear() { entries = []; errors = 0; },
            last(n) { return entries.slice(Math.max(0, entries.length - n)); },
            errorCount() { return errors; },
            size() { return entries.length; }
        };
    }

    const VIEWPORTS = [{ id: 'fit', label: 'Fit', width: null }, { id: '320', label: '320', width: 320 }, { id: '768', label: '768', width: 768 }];
    // A fixed width is drawn at its real size and scaled down to fit the panel, so 768 really lays out as a 768px page.
    function frameGeometry(viewportId, containerWidth, areaHeight) {
        const vp = VIEWPORTS.find((v) => v.id === viewportId) || VIEWPORTS[0];
        const cw = Math.max(1, containerWidth | 0), ah = Math.max(1, areaHeight | 0);
        if (!vp.width) return { width: cw, height: ah, scale: 1 };
        const scale = Math.min(1, cw / vp.width);
        return { width: vp.width, height: Math.round(ah / scale), scale };
    }

    function formatMs(ms) { return typeof ms !== 'number' || !(ms >= 0) ? '' : ms < 1 ? '<1 ms' : ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s'; }
    function sourcePill(fileName, startLine, endLine) { return String(fileName || 'untitled') + ':' + (endLine > startLine ? startLine + '-' + endLine : startLine); }
    // The runner's status (CodeMiniRunner.status()) as the indicator the Live Preview shows: the same icons and colours (preview.js,
    // renderIsolationBadge). "Normal" is amber whenever the page runs in the app's own origin, whatever the reason.
    function isolationInfo(status, lastError) {
        if (status === 'isolated') return { text: 'Isolated', tone: 'ok', icon: 'ri-shield-check-line', title: 'Isolated: this preview runs on a separate origin and cannot read CodeMini\'s storage or call its functions.' };
        const why = { fallback: 'the preview runner could not be used' + (lastError ? ' (' + String(lastError).slice(0, 120) + ')' : ''), off: 'Same origin mode is on (Settings > Security > Isolation)', unavailable: 'Isolation is not configured' }[status];
        return { text: 'Normal', tone: 'warn', icon: 'ri-error-warning-line', title: 'Not isolated: ' + (why || 'the preview runner has not answered yet') + ', so this preview runs inside the app\'s own origin.' };
    }
    function errorLabel(n) { return n + (n === 1 ? ' error' : ' errors'); }

    const api = {
        MAX_BYTES, KINDS, KIND_LABEL, VIEWPORTS, CSV_MAX_ROWS, UNSUPPORTED, PAGE_PROGRAM,
        kindFor, checkSelection, byteLength, escapeHtml, escapeScript, escapeStyle, buildDocument, snippetForLivePreview,
        parseCsv, csvToHtml, detectDelimiter, jsonErrorPosition, jsonToHtml,
        cleanPageMessage, mapErrorToEditor, createLog, frameGeometry, formatMs, sourcePill, isolationInfo, errorLabel
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof document === 'undefined') return; // Node: the rules only


    // ---------------------------------------------------------------------------------------------
    // Browser: the section in the Now pane, the editor hooks, the touch pill
    // ---------------------------------------------------------------------------------------------
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    function iconBtn(icon, label, onClick) {
        const b = el('button', 'ni-icon-btn'); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
        b.appendChild(el('i', icon)); b.addEventListener('click', onClick); return b;
    }
    function linkBtn(text, label, onClick) {
        const b = el('button', 'ni-link', text); b.type = 'button'; if (label) b.setAttribute('aria-label', label);
        b.addEventListener('click', onClick); return b;
    }
    const isPhone = () => !!(W.matchMedia && W.matchMedia('(max-width: 768px)').matches);
    const isTouch = () => !!(W.matchMedia && W.matchMedia('(pointer: coarse)').matches);
    const activeWindow = () => { try { return localStorage.getItem('codemini_active_window') || 'win_default'; } catch (e) { return 'win_default'; } };
    const setting = (key, fallback) => { const st = W.appSettings; return st && st[key] !== undefined ? st[key] : fallback; };
    // Settings > Editor. "Follow selection by default" is Auto (on for a desktop, off for a phone), On or Off.
    const followDefault = () => { const v = setting('miniPreviewFollow', 'Auto'); return v === 'On' ? true : v === 'Off' ? false : !isPhone(); };
    const openIslandOnPreview = () => setting('miniPreviewOpenIsland', true) !== false;
    const showConsoleStrip = () => setting('miniPreviewConsole', true) !== false;

    // The same sandbox flags as the Live Preview's own frame, and the same runner surface ('preview'), so the Isolation setting means the same.
    const SANDBOX = 'allow-scripts allow-same-origin allow-modals allow-popups allow-forms';
    const AREA_DEFAULT = 220, AREA_MIN = 120;
    const ni = () => W.CodeMiniNowIsland || null;

    const S = {
        active: false, view: 'empty',               // view: 'empty' (nothing yet), 'error' (this selection cannot be drawn), 'live'
        source: null, editor: null, model: null, decoIds: [], contentSub: null,
        frame: null, url: null, owner: '', token: 0, codeStartLine: 1, pageUp: false,
        follow: false, followTimer: 0, viewport: 'fit', areaH: AREA_DEFAULT, sample: false, hasIndex: false,
        stale: false, err: null, log: createLog(100), t0: 0, hostMs: null, pageMs: null, consoleOpen: true, winId: ''
    };
    let ui = null;
    const fileCtx = (ed) => {
        try { const c = typeof W.getFileContextFromEditor === 'function' ? W.getFileContextFromEditor(ed) : null; return { fileId: c && c.fileId, fileName: (c && c.fileName) || 'untitled' }; }
        catch (e) { return { fileId: null, fileName: 'untitled' }; }
    };
    const trustOk = (cooldownMs) => !(W.WorkspaceTrust && typeof W.WorkspaceTrust.guard === 'function' && !W.WorkspaceTrust.guard('Previewing code', cooldownMs ? { cooldownMs } : {}));

    function buildUi() {
        const root = el('div', 'ni-sec mp-sec'); root.hidden = true; root.setAttribute('role', 'region'); root.setAttribute('aria-label', 'Mini Preview');
        // Header row: eye, MINI PREVIEW, the source pill; bare icons on the right.
        const head = el('div', 'sb-section-header mp-head');
        const left = el('span', 'mp-head-left');
        left.append(el('i', 'ri-eye-line'), el('span', 'mp-title', 'MINI PREVIEW'));
        const src = el('button', 'mp-src'); src.type = 'button'; src.hidden = true; src.title = 'Go to the selection';
        src.addEventListener('click', () => showInEditor(null));
        left.appendChild(src);
        const tools = el('span', 'mp-tools');
        const follow = iconBtn('ri-crosshair-2-line', 'Follow selection', () => setFollow(!S.follow));
        const refresh = iconBtn('ri-refresh-line', 'Refresh', () => refreshNow());
        const live = iconBtn('ri-external-link-line', 'Open in Live Preview', () => openInLivePreview());
        const close = iconBtn('ri-close-line', 'Close Mini Preview', () => closeSection());
        tools.append(follow, refresh, live, close);
        head.append(left, tools);
        // Viewport row: Fit, 320, 768 (and, for CSS, which page it is applied to).
        const vpRow = el('div', 'mp-viewport');
        const seg = el('div', 'sb-segmented'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Preview width');
        const segBtns = VIEWPORTS.map((v) => {
            const b = el('button', 'sb-seg', v.label); b.type = 'button'; b.dataset.mpViewport = v.id;
            b.addEventListener('click', () => setViewport(v.id)); seg.appendChild(b); return b;
        });
        const cssSeg = el('div', 'sb-segmented mp-css-seg'); cssSeg.setAttribute('role', 'group'); cssSeg.setAttribute('aria-label', 'Apply the CSS to'); cssSeg.hidden = true;
        const cssBtns = [['index', 'index.html'], ['sample', 'Sample']].map(([id, label]) => {
            const b = el('button', 'sb-seg', label); b.type = 'button'; b.dataset.mpCss = id;
            b.addEventListener('click', () => { S.sample = id === 'sample'; syncControls(); render(); }); cssSeg.appendChild(b); return b;
        });
        vpRow.append(seg, cssSeg);
        // Source changed
        const note = el('div', 'mp-note'); note.hidden = true;
        note.append(el('span', null, 'Source changed'), linkBtn('Refresh', 'Refresh the preview', () => refreshNow()));
        // Preview area: the one framed element.
        const stage = el('div', 'mp-stage'); const box = el('div', 'mp-box'); stage.appendChild(box);
        const grip = el('div', 'mp-grip'); grip.tabIndex = 0; grip.setAttribute('role', 'separator'); grip.setAttribute('aria-orientation', 'horizontal'); grip.setAttribute('aria-label', 'Resize the preview (arrow keys)');
        grip.appendChild(el('span', 'mp-grip-bar'));
        // Status row
        const status = el('div', 'mp-status'); status.setAttribute('aria-live', 'polite');
        const iso = el('span', 'mp-iso'), isoIcon = el('i'), isoText = el('span');
        iso.append(isoIcon, isoText);
        const time = el('span', 'mp-time'), errs = el('span', 'mp-errs');
        status.append(iso, time, errs);
        // Error row
        const error = el('div', 'mp-error'); error.hidden = true;
        const errIcon = el('i', 'ri-close-circle-fill'), errText = el('span', 'mp-error-text');
        const errGo = linkBtn('Show in editor', 'Show the error in the editor', () => showInEditor(S.err));
        error.append(errIcon, errText, errGo);
        // Console strip
        const cons = el('div', 'mp-console');
        const consHead = el('div', 'mp-console-head');
        const consToggle = el('button', 'mp-console-toggle'); consToggle.type = 'button'; consToggle.setAttribute('aria-expanded', 'true');
        const chev = el('i', 'ri-arrow-down-s-line'); consToggle.append(chev, el('span', null, 'Console'));
        const consCount = el('span', 'mp-console-count');
        consToggle.appendChild(consCount);
        consToggle.addEventListener('click', () => { S.consoleOpen = !S.consoleOpen; renderConsole(); });
        const clear = linkBtn('Clear', 'Clear the console', () => { S.log.clear(); renderConsole(); renderStatus(); });
        consHead.append(consToggle, clear);
        const consRows = el('div', 'mp-console-rows');
        cons.append(consHead, consRows);
        // Empty state
        const empty = el('div', 'ni-empty mp-empty');
        empty.append(el('i', 'ri-eye-line'), el('span', null, 'Select code in an HTML, CSS, JS, Markdown or SVG file, then choose Preview selected (Alt+P)'));
        root.append(head, empty, vpRow, note, error, stage, grip, status, cons);

        ui = { root, src, follow, refresh, live, segBtns, cssSeg, cssBtns, vpRow, note, stage, box, grip, status, isoIcon, isoText, iso, time, errs, error, errText, errGo, cons, consToggle, chev, consCount, consRows, empty };
        wireGrip(grip);
        if (typeof ResizeObserver === 'function') new ResizeObserver(() => layoutFrame()).observe(stage);
        W.addEventListener('resize', () => { if (S.active) layoutFrame(); });
        return ui;
    }

    // ---- drawing the section from the state ----
    function syncView() {
        if (!ui) return;
        const live = S.view === 'live';
        ui.empty.hidden = S.view !== 'empty';
        ui.vpRow.hidden = !live; ui.stage.hidden = !live; ui.grip.hidden = !live; ui.status.hidden = !live;
        ui.refresh.hidden = !S.source; ui.live.hidden = !live;
        ui.note.hidden = !(live && S.stale);
        ui.error.hidden = !S.err;
        ui.cons.hidden = !(live && showConsoleStrip());
        if (S.err) {
            ui.errText.textContent = S.err.message;
            ui.errGo.hidden = !(S.err.line && canShowInEditor());
        }
        ui.src.hidden = !S.source;
        if (S.source) ui.src.textContent = sourcePill(S.source.fileName, S.source.startLine, S.source.endLine);
        syncControls(); renderStatus(); renderConsole(); layoutFrame();
    }
    function syncControls() {
        if (!ui) return;
        ui.follow.setAttribute('aria-pressed', String(!!S.follow));
        ui.follow.title = S.follow ? 'Following the selection (click to stop)' : 'Follow selection';
        ui.segBtns.forEach((b) => b.classList.toggle('active', b.dataset.mpViewport === S.viewport));
        const css = !!S.source && S.source.kind === 'css' && S.hasIndex;
        ui.cssSeg.hidden = !css;
        ui.cssBtns.forEach((b) => b.classList.toggle('active', (b.dataset.mpCss === 'sample') === (S.sample || !S.hasIndex)));
    }
    function renderStatus() {
        if (!ui) return;
        const R = W.CodeMiniRunner, info = isolationInfo(R ? R.status() : 'unknown', R && R.lastError ? R.lastError() : '');
        ui.iso.className = 'mp-iso ' + info.tone; ui.iso.title = info.title;
        ui.isoIcon.className = info.icon; ui.isoText.textContent = info.text;
        ui.time.textContent = formatMs(S.pageMs !== null ? S.pageMs : S.hostMs);
        const n = S.log.errorCount();
        ui.errs.textContent = errorLabel(n); ui.errs.classList.toggle('has-errors', n > 0);
    }
    function renderConsole() {
        if (!ui) return;
        const rows = S.log.last(3);
        ui.consRows.textContent = '';
        rows.forEach((r) => ui.consRows.appendChild(el('div', 'mp-log' + (r.level === 'error' ? ' err' : r.level === 'warn' ? ' warn' : ''), r.text)));
        ui.consRows.hidden = !S.consoleOpen;
        ui.consToggle.setAttribute('aria-expanded', String(S.consoleOpen));
        ui.chev.className = S.consoleOpen ? 'ri-arrow-down-s-line' : 'ri-arrow-right-s-line';
        ui.consCount.textContent = S.log.size() ? String(S.log.size()) : '';
        if (S.consoleOpen && !rows.length) ui.consRows.appendChild(el('div', 'mp-log none', 'Nothing logged'));
    }
    function layoutFrame() {
        if (!ui || !S.frame || S.view !== 'live') return;
        const cw = ui.stage.clientWidth || 300, g = frameGeometry(S.viewport, cw, S.areaH);
        ui.stage.style.height = S.areaH + 'px';
        ui.box.style.width = Math.round(g.width * g.scale) + 'px'; ui.box.style.height = S.areaH + 'px';
        S.frame.style.width = g.width + 'px'; S.frame.style.height = g.height + 'px';
        S.frame.style.transform = g.scale === 1 ? '' : 'scale(' + g.scale + ')';
    }
    function setViewport(id) { S.viewport = id; syncControls(); layoutFrame(); }
    function setFollow(on) { S.follow = !!on; syncControls(); }
    function wireGrip(grip) {
        const maxH = () => Math.max(AREA_MIN, Math.floor(W.innerHeight * 0.6));
        const set = (h) => { S.areaH = Math.min(maxH(), Math.max(AREA_MIN, Math.round(h))); layoutFrame(); };
        let start = null;
        grip.addEventListener('pointerdown', (e) => { start = { y: e.clientY, h: S.areaH }; try { grip.setPointerCapture(e.pointerId); } catch (x) { /* no capture */ } e.preventDefault(); });
        grip.addEventListener('pointermove', (e) => { if (start) set(start.h + (e.clientY - start.y)); });
        const end = () => { start = null; };
        grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
        grip.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { set(S.areaH + 20); e.preventDefault(); } else if (e.key === 'ArrowUp') { set(S.areaH - 20); e.preventDefault(); }
        });
    }

    // ---- the editor side: the selection, a tracked range, "Source changed" ----
    const canShowInEditor = () => { try { return !!(S.editor && S.model && !S.model.isDisposed() && S.editor.getModel() === S.model); } catch (e) { return false; } };
    function unbindSource() {
        try { if (S.contentSub) S.contentSub.dispose(); } catch (e) { /* gone */ }
        try { if (S.model && S.decoIds.length && !S.model.isDisposed()) S.model.deltaDecorations(S.decoIds, []); } catch (e) { /* gone */ }
        S.contentSub = null; S.decoIds = []; S.editor = null; S.model = null;
    }
    function bindSource(ed, sel, fileName, kind, text) {
        unbindSource();
        S.editor = ed; S.model = ed.getModel();
        S.source = { kind, fileName, text, startLine: sel.startLineNumber, startColumn: sel.startColumn, endLine: sel.endLineNumber, lines: text.split('\n').length };
        try {
            const stick = W.monaco && W.monaco.editor && W.monaco.editor.TrackedRangeStickiness ? W.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges : 1;
            S.decoIds = S.model.deltaDecorations([], [{ range: sel, options: { stickiness: stick } }]);
        } catch (e) { S.decoIds = []; }
        try { S.contentSub = S.model.onDidChangeContent(() => { if (S.active && S.view === 'live' && !S.stale) { S.stale = true; syncView(); } }); } catch (e) { S.contentSub = null; }
        S.stale = false;
    }
    // The text now: the tracked range follows edits, so a refresh previews the same block of code even after lines were added above it.
    function currentText() {
        try {
            if (canShowInEditor() && S.decoIds.length) {
                const r = S.model.getDecorationRange(S.decoIds[0]);
                if (r && !r.isEmpty()) {
                    S.source.startLine = r.startLineNumber; S.source.startColumn = r.startColumn; S.source.endLine = r.endLineNumber;
                    return S.model.getValueInRange(r);
                }
            }
        } catch (e) { /* use the text kept */ }
        return S.source.text;
    }
    function showInEditor(err) {
        if (!S.source || !canShowInEditor()) return;
        const pos = err ? mapErrorToEditor({ line: err.line, col: err.col }, err.docRelative ? 1 : S.codeStartLine, { startLine: S.source.startLine, startColumn: S.source.startColumn }, S.source.lines)
            : { line: S.source.startLine, col: S.source.startColumn };
        try {
            S.editor.setPosition({ lineNumber: pos.line, column: pos.col });
            S.editor.revealPositionInCenter({ lineNumber: pos.line, column: pos.col });
            S.editor.focus();
        } catch (e) { /* the editor went away */ }
    }

    // ---- showing the page ----
    // CSS is tried against the project's own index.html (the shallowest one), or a sample page.
    function findIndexHtml() {
        return new Promise((resolve) => {
            try {
                if (typeof db === 'undefined' || !db) return resolve('');
                const rq = db.transaction('filesystem', 'readonly').objectStore('filesystem').getAll();
                rq.onsuccess = () => {
                    const depth = (f) => String(f.absolutePath || '').split('/').length;
                    const hits = (rq.result || []).filter((f) => f && f.type === 'file' && String(f.name).toLowerCase() === 'index.html' && typeof f.content === 'string').sort((a, b) => depth(a) - depth(b));
                    resolve(hits[0] ? hits[0].content : '');
                };
                rq.onerror = () => resolve('');
            } catch (e) { resolve(''); }
        });
    }
    function ensureFrame() {
        if (S.frame) return S.frame;
        const f = el('iframe', 'mp-frame'); f.setAttribute('sandbox', SANDBOX); f.title = 'Mini Preview';
        ui.box.appendChild(f); S.frame = f;
        if (W.CodeMiniRunner && W.CodeMiniRunner.watch) W.CodeMiniRunner.watch(f);
        return f;
    }
    function revokeUrl(url, owner) {
        if (!url) return;
        try {
            if (owner === 'runner') { if (W.CodeMiniRunner && S.frame) W.CodeMiniRunner.revoke(S.frame, [url]); } else URL.revokeObjectURL(url);
        } catch (e) { /* already released */ }
    }
    function teardownFrame() {
        const R = W.CodeMiniRunner;
        if (S.frame) {
            try { if (R && R.active(S.frame)) R.clear(S.frame); } catch (e) { /* gone */ }
            try { if (R && R.unwatch) R.unwatch(S.frame); } catch (e) { /* gone */ }
            revokeUrl(S.url, S.owner);
            try { S.frame.remove(); } catch (e) { /* gone */ }
        } else revokeUrl(S.url, S.owner);
        S.frame = null; S.url = null; S.owner = '';
    }
    async function render() {
        const src = S.source;
        if (!S.active || !src || !ui) return;
        const mine = ++S.token;
        S.err = null;
        if (!trustOk(15000)) { S.err = { message: 'Previewing code is disabled in Restricted Mode.' }; S.view = 'error'; syncView(); return; }
        const opts = {};
        if (src.kind === 'markdown') opts.sanitizeSource = W.CodeMiniEscape && typeof W.CodeMiniEscape.sanitize === 'function' ? W.CodeMiniEscape.sanitize.toString() : '';
        if (src.kind === 'css') {
            const idx = await findIndexHtml();
            if (mine !== S.token) return;
            S.hasIndex = !!idx; opts.indexHtml = idx; opts.sample = S.sample || !idx;
        }
        const doc = buildDocument(src.kind, src.text, opts);
        if (doc.error) { S.err = { message: doc.error.message, line: doc.error.line, col: doc.error.col, docRelative: true }; S.view = 'error'; S.pageUp = false; syncView(); return; }
        S.codeStartLine = doc.codeStartLine; S.view = 'live'; S.pageUp = true;
        S.log.clear(); S.pageMs = null; S.hostMs = null; S.t0 = performance.now();
        syncView();
        const frame = ensureFrame(), R = W.CodeMiniRunner;
        let isolated = false;
        try { isolated = R ? !!(await R.ensure(frame, 'preview')) : false; } catch (e) { isolated = false; }
        if (mine !== S.token) return;
        renderStatus();
        const blob = new Blob([doc.html], { type: 'text/html' });
        const oldUrl = S.url, oldOwner = S.owner;
        try {
            if (isolated) {
                const url = await R.mint(frame, blob);
                if (mine !== S.token) { try { R.revoke(frame, [url]); } catch (e) { /* gone */ } return; }
                S.url = url; S.owner = 'runner';
                await R.show(frame, url);
            } else {
                const url = URL.createObjectURL(blob);
                S.url = url; S.owner = 'app';
                await new Promise((resolve) => { const t = setTimeout(resolve, 5000); frame.onload = () => { clearTimeout(t); resolve(); }; frame.src = url; });
            }
        } catch (e) {
            // The runner answered but could not show the page: use the same-origin preview once, like the Live Preview does.
            if (isolated && R) { try { R.fail(frame, e && e.message); } catch (x) { /* gone */ } if (mine === S.token) return render(); }
            S.err = { message: 'The preview could not be shown: ' + String((e && e.message) || e).slice(0, 160) }; syncView(); return;
        }
        if (mine !== S.token) return;
        if (oldUrl && oldUrl !== S.url) revokeUrl(oldUrl, oldOwner);
        S.hostMs = performance.now() - S.t0;
        renderStatus(); layoutFrame();
    }

    // What the page sends (console and errors) arrives as a window message from the frame: in Normal mode directly, in Isolated mode
    // wrapped and relayed by the runner (runner-client re-dispatches it with the frame as its source). Either way it is cleaned first.
    W.addEventListener('message', (e) => {
        if (!S.active || S.view !== 'live' || !S.frame || e.source !== S.frame.contentWindow) return;
        const m = cleanPageMessage(e.data);
        if (!m) return;
        if (m.type === 'loaded') { S.pageMs = m.ms; renderStatus(); return; }
        S.log.push(m);
        if (m.type === 'error') S.err = { message: m.text, line: m.line, col: m.col };
        syncView();
    });

    // ---- opening, refreshing, closing ----
    function activate() {
        const n = ni(); if (!n) return false;
        if (!ui) { buildUi(); n.mount(ui.root, 20); }
        if (!S.active) { S.active = true; S.follow = followDefault(); S.winId = activeWindow(); if (!S.source) { S.view = 'empty'; S.err = null; } }
        ui.root.hidden = false;
        n.setSectionActive('mini-preview', true);
        n.setPinned(true);                                   // an explicit trigger re-pins (the person may have released it before)
        if (openIslandOnPreview()) n.open({ tab: 'now' });   // never takes focus: the editor keeps it
        setEye(true);
        return true;
    }
    function setEye(on) {
        const btn = document.getElementById('nowIsland'); if (!btn) return;
        let dot = btn.querySelector('.mp-eye');
        if (on && !dot) { dot = el('i', 'ri-eye-fill mp-eye'); dot.title = 'Mini Preview is open'; btn.appendChild(dot); }
        if (dot) dot.hidden = !on;
    }
    function openFromEditor(ed) {
        if (!ed) { if (activate()) syncView(); return; }
        let sel = null, model = null, text = '';
        try { sel = ed.getSelection(); model = ed.getModel(); text = sel && !sel.isEmpty() && model ? model.getValueInRange(sel) : ''; } catch (e) { /* no editor */ }
        if (!model) { if (activate()) syncView(); return; }
        const ctx = fileCtx(ed), chk = checkSelection(ctx.fileName, model.getLanguageId(), text);
        if (!activate()) return;
        if (!chk.ok) {
            if (chk.reason === 'empty') { syncView(); return; }               // nothing selected: the empty state, or the preview that is already there
            S.err = { message: chk.message }; if (!S.source) S.view = 'error'; syncView(); return;
        }
        if (!trustOk()) { S.err = { message: 'Previewing code is disabled in Restricted Mode.' }; S.view = 'error'; syncView(); return; }
        bindSource(ed, sel, ctx.fileName, chk.kind, text);
        render();
    }
    function refreshNow() {
        if (!S.active || !S.source) return;
        const text = currentText(), chk = checkSelection(S.source.fileName, '', text);
        if (!chk.ok && chk.reason === 'size') { S.err = { message: chk.message }; syncView(); return; }
        S.source.text = text; S.source.lines = text.split('\n').length; S.stale = false;
        render();
    }
    function openInLivePreview() {
        if (!S.source) return;
        const snip = snippetForLivePreview(S.source.kind, currentText());
        if (snip && W.CodeMiniLivePreview && typeof W.CodeMiniLivePreview.openSnippet === 'function') W.CodeMiniLivePreview.openSnippet(snip.name, snip.content);
    }
    function closeSection() {
        S.token++; clearTimeout(S.followTimer);
        unbindSource(); teardownFrame();
        S.active = false; S.source = null; S.view = 'empty'; S.err = null; S.stale = false; S.pageUp = false; S.log.clear();
        if (ui) ui.root.hidden = true;
        const n = ni(); if (n) n.setSectionActive('mini-preview', false);
        setEye(false);
    }

    // ---- follow selection (debounced 400 ms) ----
    function followFrom(ed) {
        if (!S.active || !S.follow) return;
        clearTimeout(S.followTimer);
        S.followTimer = setTimeout(() => {
            if (!S.active || !S.follow) return;
            try {
                const sel = ed.getSelection(), model = ed.getModel();
                if (!sel || sel.isEmpty() || !model) return;                    // a cleared selection keeps the last preview
                const text = model.getValueInRange(sel), ctx = fileCtx(ed), chk = checkSelection(ctx.fileName, model.getLanguageId(), text);
                if (!chk.ok) return;                                            // an unsupported or oversized selection is ignored while following
                if (S.editor === ed && S.source && S.source.text === text && S.source.startLine === sel.startLineNumber) return;
                if (!trustOk(15000)) return;
                bindSource(ed, sel, ctx.fileName, chk.kind, text);
                render();
            } catch (e) { /* the editor went away */ }
        }, 400);
    }

    // ---- touch: the floating "Preview selected" pill ----
    let pill = null, pillTimer = 0;
    function pillHide() { clearTimeout(pillTimer); if (pill) pill.hidden = true; }
    function buildPill() {
        pill = el('button', 'mp-pill', 'Preview selected'); pill.type = 'button'; pill.hidden = true;
        // pointerdown must not move focus out of the editor (it would drop the selection on some browsers)
        ['pointerdown', 'mousedown'].forEach((t) => pill.addEventListener(t, (e) => e.preventDefault()));
        pill.addEventListener('click', (e) => { e.stopPropagation(); const ed = pill.__ed; pillHide(); if (ed) openFromEditor(ed); });
        document.body.appendChild(pill);
    }
    function pillSchedule(ed) {
        pillHide();
        if (!isTouch()) return;
        pillTimer = setTimeout(() => {
            try {
                const sel = ed.getSelection(), model = ed.getModel();
                if (!sel || sel.isEmpty() || !model) return;
                if (!checkSelection(fileCtx(ed).fileName, model.getLanguageId(), model.getValueInRange(sel)).ok) return;
                const vis = ed.getScrolledVisiblePosition(sel.getEndPosition()), dom = ed.getDomNode();
                if (!vis || !dom) return;
                const r = dom.getBoundingClientRect();
                if (!pill) buildPill();
                pill.__ed = ed; pill.hidden = false;
                const w = pill.offsetWidth, h = pill.offsetHeight;
                pill.style.left = Math.round(Math.min(Math.max(8, r.left + vis.left - w / 2), W.innerWidth - w - 8)) + 'px';
                pill.style.top = Math.round(Math.max(8, r.top + vis.top - h - 6)) + 'px';
            } catch (e) { /* no pill */ }
        }, 400);
    }

    // ---- the editor hook (called by editor.js for every editor it creates; it can never stop an editor from opening) ----
    const attached = new WeakSet();
    function attachEditor(ed) {
        if (!ed || attached.has(ed)) return;
        attached.add(ed);
        const key = typeof ed.createContextKey === 'function' ? ed.createContextKey('cmMiniPreviewable', false) : null;
        const syncKey = () => { try { const m = ed.getModel(); if (key) key.set(!!m && !!kindFor(fileCtx(ed).fileName, m.getLanguageId())); } catch (e) { /* keep the key as it was */ } };
        syncKey();
        ed.addAction({
            id: 'preview-selection', label: 'Preview selected', contextMenuGroupId: '1_modification', contextMenuOrder: 1.6,
            precondition: key ? 'editorHasSelection && cmMiniPreviewable' : 'editorHasSelection',
            run: (editor) => openFromEditor(editor)
        });
        ed.onDidChangeCursorSelection(() => { syncKey(); pillSchedule(ed); followFrom(ed); });
        ed.onDidScrollChange(() => pillHide());
        if (typeof ed.onDidChangeModel === 'function') ed.onDidChangeModel(syncKey);
    }

    function openActive() {
        const ed = typeof W.getActiveMonacoEditor === 'function' ? W.getActiveMonacoEditor() : null;
        openFromEditor(ed);
    }

    // One Mini Preview per window: switching windows closes it (the island itself is shared by all windows).
    (function whenIslandReady() {
        const n = ni();
        if (n && typeof n.onRestore === 'function') n.onRestore(() => { if (S.active && S.winId !== activeWindow()) closeSection(); });
    })();

    W.CodeMiniMiniPreview = Object.freeze({
        attachEditor, openActive, openFromEditor, refresh: refreshNow, close: closeSection,
        isActive: () => S.active, state: () => ({ active: S.active, view: S.view, follow: S.follow, viewport: S.viewport, kind: S.source && S.source.kind, stale: S.stale, errors: S.log.errorCount() })
    });
})(typeof window !== 'undefined' ? window : globalThis);
