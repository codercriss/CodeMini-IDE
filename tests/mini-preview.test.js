// Mini Preview's pure rules (js/core/mini-preview.js) and how it is wired into the app. The browser half (the section, the editor hooks, the
// pill, the runner) is covered in a real browser by tests/e2e/mini-preview.e2e.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../js/core/mini-preview.js');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

console.log('what can be previewed');
t('the file name decides; the language id is only for a name with no extension', () => {
  assert.strictEqual(M.kindFor('index.html', 'html'), 'html');
  assert.strictEqual(M.kindFor('a.HTM', ''), 'html');
  assert.strictEqual(M.kindFor('app.js', 'javascript'), 'javascript');
  assert.strictEqual(M.kindFor('logo.svg', 'xml'), 'svg');
  assert.strictEqual(M.kindFor('data.csv', 'plaintext'), 'csv');
  assert.strictEqual(M.kindFor('notes.md', 'markdown'), 'markdown');
  assert.strictEqual(M.kindFor('Untitled', 'css'), 'css');
  assert.strictEqual(M.kindFor('Untitled', 'python'), null);
  assert.strictEqual(M.kindFor('main.py', 'html'), null, 'a known-but-unsupported extension is never guessed from the language');
  assert.strictEqual(M.kindFor('App.jsx', 'javascript'), null);
});
t('checkSelection: empty, unsupported and oversized selections say why', () => {
  assert.deepStrictEqual(M.checkSelection('a.html', 'html', '   \n'), { ok: false, reason: 'empty', message: 'Select some code first.' });
  assert.strictEqual(M.checkSelection('a.py', 'python', 'print(1)').reason, 'kind');
  assert.strictEqual(M.checkSelection('a.html', 'html', '<p>hi</p>').kind, 'html');
  const big = M.checkSelection('a.html', 'html', 'x'.repeat(M.MAX_BYTES + 1));
  assert.strictEqual(big.reason, 'size');
  assert.ok(/200 KB/.test(big.message));
  assert.ok(M.checkSelection('a.html', 'html', 'x'.repeat(M.MAX_BYTES)).ok, 'exactly 200 KB is allowed');
  assert.strictEqual(M.checkSelection('a.html', 'html', 'é'.repeat(M.MAX_BYTES / 2 + 1)).reason, 'size', 'the limit is in bytes, not characters');
});

console.log('the pages');
t('the page program is one line, parses, and never uses eval or new Function', () => {
  assert.ok(!/\n/.test(M.PAGE_PROGRAM));
  assert.doesNotThrow(() => new (require('vm').Script)(M.PAGE_PROGRAM));
  assert.ok(!/\beval\s*\(|new Function/.test(M.PAGE_PROGRAM));
});
t('an HTML fragment is wrapped, and its first line is where the code starts', () => {
  const d = M.buildDocument('html', '<p>hi</p>\n<b>x</b>');
  assert.strictEqual(d.html.split('\n')[d.codeStartLine - 1], '<p>hi</p>');
  assert.ok(/^<!doctype html>/i.test(d.html) && d.html.includes('cmMini'));
});
t('a whole HTML document is kept, with the console program put in right after <head> on the same line', () => {
  const src = '<!doctype html>\n<html>\n<head><title>x</title></head>\n<body>b</body>\n</html>';
  const d = M.buildDocument('html', src);
  assert.strictEqual(d.codeStartLine, 1);
  assert.strictEqual(d.html.split('\n').length, src.split('\n').length, 'no line was added, so reported lines still match');
  assert.ok(d.html.indexOf('<head><script>') > -1 && d.html.includes('<title>x</title>'));
});
t('JavaScript runs on a blank page with #app, and a closing script tag inside the code cannot end the script', () => {
  const d = M.buildDocument('javascript', 'console.log(1)\nvar s = "</script><img src=x onerror=alert(1)>"');
  assert.ok(d.html.includes('<div id="app"></div>'));
  assert.strictEqual(d.html.split('\n')[d.codeStartLine - 1], 'console.log(1)');
  assert.ok(!d.html.includes('</script><img'), 'the closer is escaped');
  assert.ok(d.html.includes('<\\/script><img'));
  assert.strictEqual(M.escapeScript('a<!--b'), 'a<\\!--b');
});
t('CSS goes last in the project\'s index.html head, or onto a sample page', () => {
  const idx = '<html><head><title>t</title><link rel="stylesheet" href="a.css"></head><body><h1>x</h1></body></html>';
  const a = M.buildDocument('css', 'h1{color:red}', { indexHtml: idx });
  assert.ok(a.html.indexOf('<style data-cm-mini>') > a.html.indexOf('href="a.css"') && a.html.indexOf('<style data-cm-mini>') < a.html.indexOf('</head>'));
  assert.ok(a.html.includes('<h1>x</h1>') && !a.html.includes('class="container"'));
  const b = M.buildDocument('css', 'h1{color:red}', { indexHtml: idx, sample: true });
  assert.ok(b.html.includes('class="container"') && !b.html.includes('<h1>x</h1>'));
  const c = M.buildDocument('css', 'h1{color:red}', {});
  assert.ok(c.html.includes('class="container"'), 'no index.html: the sample');
  assert.ok(!M.buildDocument('css', 'a{}</style><script>alert(1)</script>', {}).html.includes('</style><script>alert(1)'), 'CSS cannot close the style tag');
});
t('SVG needs an <svg>; the XML prolog and doctype are dropped', () => {
  assert.ok(/<svg/.test(M.buildDocument('svg', '<?xml version="1.0"?>\n<!DOCTYPE svg>\n<svg width="9"></svg>').html));
  assert.ok(!/<\?xml/.test(M.buildDocument('svg', '<?xml version="1.0"?><svg></svg>').html));
  assert.ok(/no <svg>/i.test(M.buildDocument('svg', '<div>').error.message));
});
t('Markdown uses marked and the app\'s sanitizer; without the sanitizer (Node) it is shown as text, never markup', () => {
  const d = M.buildDocument('markdown', '# Hi <img src=x onerror=1>', { sanitizeSource: 'function sanitize(h){return h}' });
  assert.ok(d.html.includes('marked@') && d.html.includes('__cmSanitize'));
  assert.ok(d.html.includes('&lt;img src=x onerror=1&gt;') && !d.html.includes('<img src=x'), 'the raw text sits escaped in a textarea');
  assert.ok(!/\.innerHTML\s*=/.test(d.html), 'no innerHTML assignment (the sink scan counts them)');
  const plain = M.buildDocument('markdown', '# Hi');
  assert.ok(!plain.html.includes('marked.parse') && plain.html.includes('textContent'));
});
t('JSON: a tree of escaped text; an error says where it is, for every kind of message', () => {
  const ok = M.buildDocument('json', '{"a":[1,true,null,"<b>"]}');
  assert.ok(ok.html.includes('class="k"') && ok.html.includes('&lt;b&gt;') && !ok.html.includes('<b>'));
  const at = (src) => { const e = M.buildDocument('json', src).error; return e.line + ':' + e.col; };
  assert.strictEqual(at('{"a":}'), '1:6');
  assert.strictEqual(at('{\n  "a": 1,\n  "b": [1, 2,, 3]\n}'), '3:14');
  assert.strictEqual(at('{"a": tru}'), '1:10');
  assert.strictEqual(at('[1 2]'), '1:4');
  assert.strictEqual(at('{"a":1,}'), '1:8');
  assert.deepStrictEqual(M.jsonErrorPosition('Unexpected token } in JSON at position 5', '{"a":}'), { line: 1, col: 6 }, 'an older engine\'s message');
  assert.deepStrictEqual(M.jsonErrorPosition('x (line 3 column 4)', ''), { line: 3, col: 4 }, 'a newer engine\'s message');
});
t('JSON error search stays fast on a big file', () => {
  const big = '[' + Array.from({ length: 30000 }, (_, i) => '{"id":' + i + '}').join(',') + ',oops]';
  const t0 = Date.now(); const e = M.buildDocument('json', big).error;
  assert.ok(e.line === 1 && e.col > 100000 && Date.now() - t0 < 2000);
});
t('CSV: quotes, "" , CRLF, a trailing newline, ; and tab delimiters, a header, everything escaped, capped rows', () => {
  assert.deepStrictEqual(M.parseCsv('a,b\r\n"x,1","he said ""hi"""\r\n3,4\r\n'), [['a', 'b'], ['x,1', 'he said "hi"'], ['3', '4']]);
  assert.deepStrictEqual(M.parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.deepStrictEqual(M.parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepStrictEqual(M.parseCsv('a,"multi\nline"\n'), [['a', 'multi\nline']]);
  const html = M.csvToHtml(M.parseCsv('<h>,b\n<img src=x onerror=1>,2'));
  assert.ok(html.includes('<th>&lt;h&gt;</th>') && html.includes('&lt;img') && !html.includes('<img'));
  const many = M.csvToHtml(M.parseCsv('h\n' + Array.from({ length: 500 }, (_, i) => i).join('\n')));
  assert.strictEqual((many.match(/<td>/g) || []).length, M.CSV_MAX_ROWS);
  assert.ok(/first 200 of 500 rows/.test(many));
  assert.ok(/no data/i.test(M.buildDocument('csv', '\n\n').error.message));
});
t('"clean" leaves the console program out; Open in Live Preview names the snippet for the Live Preview to understand', () => {
  M.KINDS.forEach((k) => {
    const src = k === 'svg' ? '<svg></svg>' : k === 'json' ? '{}' : 'a';
    assert.ok(M.buildDocument(k, src).html.includes('cmMini'), k + ' has the program');
    assert.ok(!M.buildDocument(k, src, { clean: true }).html.includes('cmMini'), k + ' clean has none');
  });
  assert.deepStrictEqual(M.snippetForLivePreview('markdown', '# hi'), { name: 'snippet.md', content: '# hi' });
  assert.strictEqual(M.snippetForLivePreview('json', '{}').name, 'snippet.json');
  const h = M.snippetForLivePreview('html', '<p>x</p>');
  assert.ok(h.name === 'snippet.html' && /<p>x<\/p>/.test(h.content) && !h.content.includes('cmMini'));
  assert.strictEqual(M.snippetForLivePreview('nope', 'x'), null);
});

console.log('what the page sends back (untrusted)');
t('only known message shapes survive, cut short, with small integers', () => {
  assert.strictEqual(M.cleanPageMessage(null), null);
  assert.strictEqual(M.cleanPageMessage({ type: 'console', text: 'x' }), null, 'no cmMini marker');
  assert.strictEqual(M.cleanPageMessage({ cmMini: 1, type: 'navigate', path: '/' }), null);
  assert.deepStrictEqual(M.cleanPageMessage({ cmMini: 1, type: 'console', level: 'warn', text: 'hi' }), { type: 'console', level: 'warn', text: 'hi' });
  assert.strictEqual(M.cleanPageMessage({ cmMini: 1, type: 'console', level: '<script>', text: 'x' }).level, 'log');
  assert.strictEqual(M.cleanPageMessage({ cmMini: 1, type: 'console', text: 'y'.repeat(5000) }).text.length, 400);
  assert.deepStrictEqual(M.cleanPageMessage({ cmMini: 1, type: 'error', text: 'boom', line: '7', col: -3 }), { type: 'error', text: 'boom', line: 7, col: 0 });
  assert.strictEqual(M.cleanPageMessage({ cmMini: 1, type: 'error', text: {}, line: 1e12 }).line, 0);
  assert.deepStrictEqual(M.cleanPageMessage({ cmMini: 1, type: 'loaded', ms: 42.4 }), { type: 'loaded', ms: 42 });
});
t('an error line is walked back to the editor (first line adds the selection\'s column; later lines keep theirs)', () => {
  const sel = { startLine: 10, startColumn: 5 };
  assert.deepStrictEqual(M.mapErrorToEditor({ line: 3, col: 7 }, 3, sel, 4), { line: 10, col: 11 });
  assert.deepStrictEqual(M.mapErrorToEditor({ line: 5, col: 3 }, 3, sel, 4), { line: 12, col: 3 });
  assert.deepStrictEqual(M.mapErrorToEditor({ line: 99, col: 1 }, 3, sel, 4), { line: 13, col: 1 }, 'clamped to the selection');
  assert.deepStrictEqual(M.mapErrorToEditor({ line: 0, col: 0 }, 3, sel, 4), { line: 10, col: 5 }, 'no line: the start of the selection');
  const js = M.buildDocument('javascript', 'a()\nb(');
  assert.deepStrictEqual(M.mapErrorToEditor({ line: js.codeStartLine + 1, col: 3 }, js.codeStartLine, sel, 2), { line: 11, col: 3 });
});

console.log('the console strip, status, geometry');
t('the log keeps the last entries, counts errors, and clears', () => {
  const log = M.createLog(5);
  for (let i = 0; i < 8; i++) log.push({ type: 'console', level: 'log', text: 'l' + i });
  log.push({ type: 'error', text: 'boom' }); log.push({ type: 'console', level: 'error', text: 'e' });
  log.push({ type: 'loaded', ms: 1 });
  assert.strictEqual(log.size(), 5);
  assert.deepStrictEqual(log.last(3).map((e) => e.text), ['l7', 'boom', 'e']);
  assert.strictEqual(log.errorCount(), 2);
  assert.strictEqual(log.last(3)[1].level, 'error');
  log.clear(); assert.ok(log.size() === 0 && log.errorCount() === 0);
});
t('Fit uses the panel; 320 and 768 are laid out at their real width and scaled down to fit', () => {
  assert.deepStrictEqual(M.frameGeometry('fit', 310, 220), { width: 310, height: 220, scale: 1 });
  const g = M.frameGeometry('768', 310, 220);
  assert.ok(g.width === 768 && Math.abs(g.scale - 310 / 768) < 1e-9 && Math.abs(g.height * g.scale - 220) < 1);
  assert.strictEqual(M.frameGeometry('320', 500, 220).scale, 1, 'never scaled up');
  assert.strictEqual(M.frameGeometry('bogus', 310, 220).width, 310);
});
t('labels', () => {
  assert.strictEqual(M.sourcePill('index.html', 12, 20), 'index.html:12-20');
  assert.strictEqual(M.sourcePill('a.js', 4, 4), 'a.js:4');
  assert.strictEqual(M.formatMs(0.2), '<1 ms'); assert.strictEqual(M.formatMs(45.4), '45 ms'); assert.strictEqual(M.formatMs(1234), '1.2 s'); assert.strictEqual(M.formatMs(null), '');
  assert.strictEqual(M.errorLabel(1), '1 error'); assert.strictEqual(M.errorLabel(0), '0 errors');
  assert.deepStrictEqual([M.isolationInfo('isolated').text, M.isolationInfo('isolated').tone, M.isolationInfo('isolated').icon], ['Isolated', 'ok', 'ri-shield-check-line']);
  ['fallback', 'off', 'unavailable', 'unknown'].forEach((s) => assert.deepStrictEqual([M.isolationInfo(s).text, M.isolationInfo(s).tone], ['Normal', 'warn']));
});

console.log('wiring');
t('the script is loaded after the Now Island and precached, and the test is in npm test', () => {
  const html = read('index.html');
  assert.ok(html.indexOf('js/core/mini-preview.js') > html.indexOf('js/core/now-island.js'), 'it mounts into the island, so it loads after it');
  assert.ok(read('sw.js').includes("'/js/core/mini-preview.js'"));
  assert.ok(JSON.parse(read('package.json')).scripts.test.includes('tests/mini-preview.test.js'));
});
t('editor.js attaches it to every editor, guarded', () => {
  const ed = read('js/core/editor.js');
  assert.ok(/CodeMiniMiniPreview\.attachEditor\(editorInstance\)/.test(ed));
  assert.ok(/try \{ window\.CodeMiniMiniPreview\.attachEditor/.test(ed), 'a failure can never stop an editor from opening');
});
t('the right-click action copies "Run in console": id preview-selection, order 1.6, needs a selection', () => {
  const src = read('js/core/mini-preview.js');
  assert.ok(/id: 'preview-selection'/.test(src) && /contextMenuOrder: 1\.6/.test(src) && /contextMenuGroupId: '1_modification'/.test(src) && /editorHasSelection/.test(src));
});
t('Alt+P is a rebindable command that opens the Mini Preview', () => {
  const K = require('../js/core/keybindings.js');
  const c = K.CATALOG.find((x) => x.id === 'preview.selected');
  assert.ok(c && c.defaults.join() === 'Alt+P' && c.scope === 'global');
  assert.ok(!K.CATALOG.some((x) => x.id !== 'preview.selected' && x.defaults.includes('Alt+P')), 'no other command uses Alt+P');
  assert.ok(/'preview\.selected': \(\) => \{ if \(W\.CodeMiniMiniPreview\) W\.CodeMiniMiniPreview\.openActive\(\)/.test(read('js/core/keybindings.js')));
});
t('it is guarded by Workspace Trust like Run in console', () => {
  assert.ok(/WorkspaceTrust\.guard\('Previewing code'/.test(read('js/core/mini-preview.js')));
});
t('it uses the Live Preview\'s runner surface and sandbox, and never builds markup with innerHTML', () => {
  const src = read('js/core/mini-preview.js'), lp = read('js/viewers/preview.js');
  assert.ok(/R\.ensure\(frame, 'preview'\)/.test(src));
  const flags = (s) => /sandbox="([^"]+)"/.exec(s)[1];
  assert.ok(src.includes("const SANDBOX = '" + flags(lp.slice(lp.indexOf('id="lpIframe"'), lp.indexOf('id="lpIframe"') + 200)) + "'"), 'the same sandbox flags as #lpIframe');
  assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|srcdoc/.test(src.replace(/\/\/.*$/gm, '')), 'no HTML sinks');
});
t('runner-client relays a watched frame\'s page messages, and the Live Preview ignores them', () => {
  const rc = read('js/viewers/runner-client.js');
  assert.ok(/watch: function/.test(rc) && /unwatch: function/.test(rc) && /watched\.indexOf\(iframe\) === -1/.test(rc));
  assert.ok(/event\.source !== iframe\.contentWindow\) return;/.test(read('js/viewers/preview.js')), 'the Live Preview only listens to its own frame');
});
t('the Now Island hosts sections in order, pins itself while one is open, and its empty state steps aside', () => {
  const ni = read('js/core/now-island.js');
  assert.ok(/window\.CodeMiniNowIsland = Object\.freeze/.test(ni) && /id="niPin"/.test(ni));
  assert.ok(/if \(keepsOpen\(\)\) return;/.test(ni) && /hosted\.active\.size > 0/.test(ni));
  assert.ok(/mount\(ui\.root, 20\)/.test(read('js/core/mini-preview.js')), 'order 20: below RUNNING and LIVE COLLAB, above TODAY');
});
t('the three settings exist with defaults, loading and rows, and Follow is Auto on desktop and off on a phone', () => {
  const sp = read('js/core/settings-profile.js');
  assert.ok(/miniPreviewFollow: 'Auto', miniPreviewOpenIsland: true, miniPreviewConsole: true/.test(sp));
  assert.ok(/miniPreviewFollow: pickOption\('miniPreviewFollow', \['Auto', 'On', 'Off'\], 'Auto'\)/.test(sp));
  ['miniPreviewFollow', 'miniPreviewOpenIsland', 'miniPreviewConsole'].forEach((k) => assert.ok(sp.includes('data-setting="' + k + '"'), k + ' row'));
});
t('theme packs: the pills and the framed area are listed in themes.css', () => {
  const th = read('css/themes.css');
  ['.mp-src', '.mp-pill', '.mp-grip-bar'].forEach((s) => assert.ok(th.includes('"codemini-premium"] ' + s), s));
  assert.ok(/\.mp-stage \{\s*border-radius: 14px !important/.test(th));
});

console.log(n + ' mini-preview checks passed');
