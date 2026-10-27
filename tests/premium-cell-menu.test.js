// Premium themes vs the notebook cell's "..." menu (css/themes.css), checked from the CSS source (no browser).
// Bug: the premium pack gave .cell-input `overflow: hidden` so its rounded corners would clip the editor. The cell's
// "..." menu (.ct-responsive-dropdown) is absolutely positioned INSIDE .cell-input, so it was cut off at the cell's
// bottom edge - a one-line cell showed only "Add Tag" and "New Cell Before". Default themes never clip it.
const fs = require('fs'), path = require('path'), assert = require('assert');
const css = fs.readFileSync(path.join(__dirname, '..', 'css/themes.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(path.join(__dirname, '..', 'js/notebook/notebook-ui.js'), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

// [{ selectors: [..], body }] for every plain rule (no @media nesting needed here)
const rules = [];
css.replace(/([^{}]+)\{([^{}]*)\}/g, (_, sel, body) => { rules.push({ selectors: sel.split(',').map((x) => x.trim()), body }); return ''; });
const premium = (cls) => rules.filter((r) => r.selectors.some((s) => /codemini-premium/.test(s) && new RegExp(`\\.${cls}(?![\\w-])\\s*$`).test(s)));
const clips = (body) => /overflow(-x|-y)?\s*:\s*(hidden|clip|auto|scroll)/.test(body);

// Everything the dropdown sits inside (from the toolbar markup): .cell > .cell-content-wrapper > .cell-input > .cell-toolbar > .ct-left
const ancestors = ['cell', 'cell-content-wrapper', 'cell-input', 'cell-toolbar', 'ct-left'];

t('the dropdown really is inside .cell-input > .cell-toolbar > .ct-left (so the ancestors list above is right)', () => {
  const i = html.indexOf('<div class="cell-toolbar">'); const j = html.indexOf('<div class="ct-responsive-dropdown">');
  assert(i > 0 && j > i, 'dropdown must be in the toolbar markup');
  assert(/<div class="cell-input">\s*<div class="cell-tags"><\/div>\s*\$\{CELL_TOOLBAR_HTML\}/.test(html), 'toolbar must sit in .cell-input');
  assert(html.slice(i, j).includes('class="ct-left"'), 'dropdown must be in .ct-left');
});
for (const cls of ancestors) {
  t(`no premium rule clips .${cls} (it would cut off the "..." menu)`, () => {
    const bad = premium(cls).filter((r) => clips(r.body));
    assert.strictEqual(bad.length, 0, `.${cls} has overflow clipping in the premium pack: ${bad.map((r) => r.body.trim()).join(' | ')}`);
  });
}
t('the card is still rounded', () => {
  assert(premium('cell-input').some((r) => /border-radius:\s*14px/.test(r.body)));
});
t('the editor area carries the bottom corners instead (so the clip was not simply dropped)', () => {
  const r = premium('cell-monaco-container');
  assert(r.some((x) => /border-radius:\s*0 0 12px 12px/.test(x.body) && /overflow:\s*hidden/.test(x.body)));
});
t('the toolbar and tag strip keep their own top radii', () => {
  assert(premium('cell-toolbar').some((r) => /border-radius:\s*14px 14px 0 0/.test(r.body)));
  assert(premium('cell-tags').some((r) => /border-radius:\s*14px 14px 0 0/.test(r.body)));
});
console.log(`\n${n} passed`);
