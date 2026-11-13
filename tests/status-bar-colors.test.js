// Settings > Theme > Status Bar: a background color and a text-and-icons color for the bottom status bar. It applies on the four
// Color Themes (Light, Light +, Dark, Dark +) and never under a Theme Pack, where the bar stays as the pack draws it. The rules
// are run from the real settings-profile.js (the block between the "Status bar colors" markers, plus the theme registry above
// it), not from a copy. What a browser makes of the CSS (the dark rule winning over the base rule, the swatches, no flash on
// load) is covered by tests/e2e/status-bar-colors.e2e.js.
const assert = require('assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok', name); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const sp = read('js/core/settings-profile.js');
const begin = sp.indexOf('// ---- Status bar colors (begin)'), endMark = '// ---- Status bar colors (end)';
const end = sp.indexOf(endMark);
assert.ok(begin > 0 && end > begin, 'the status bar colors block markers are in settings-profile.js');
const regStart = sp.indexOf('window.THEME_REGISTRY = {');
assert.ok(regStart > 0 && regStart < begin, 'the theme registry comes before the status bar block');

// A fresh page: the real registry and helpers, with appSettings under the test's control.
function page(settings) {
  const win = { appSettings: Object.assign({ colorTheme: 'CodeMini Light', themePack: 'None', statusBarBackground: '', statusBarForeground: '' }, settings) };
  vm.runInContext(sp.slice(regStart, end + endMark.length), vm.createContext({ window: win }));
  return win;
}
// Objects made inside the vm context have another Object.prototype, which deepStrictEqual rejects: compare them as plain data.
const plain = (o) => JSON.parse(JSON.stringify(o));
// A stand-in for <html>: records the inline custom properties like style.setProperty / removeProperty do.
function fakeRoot() {
  const props = {};
  return { props, style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; } } };
}

console.log('what counts as a color');
t('#rgb and #rrggbb are accepted, in either case, and come out as lower-case #rrggbb', () => {
  const w = page();
  assert.strictEqual(w.normalizeStatusBarColor('#1E90FF'), '#1e90ff');
  assert.strictEqual(w.normalizeStatusBarColor('#abc'), '#aabbcc');
  assert.strictEqual(w.normalizeStatusBarColor('  #FFF  '), '#ffffff', 'spaces around it are ignored');
  assert.strictEqual(w.normalizeStatusBarColor('#000000'), '#000000', 'black is a color, not "nothing"');
});
t('anything else is "not chosen" (empty), so nothing but a plain hex color can reach the stylesheet', () => {
  const w = page();
  for (const bad of ['', 'red', 'rgb(1,2,3)', '#12', '#12345', '#1234567', '#gggggg', '1e90ff', 'url(x)', 'red;}body{display:none', '#fff;color:red', '#ffffff80', null, undefined, 5, {}, []]) {
    assert.strictEqual(w.normalizeStatusBarColor(bad), '', JSON.stringify(bad));
  }
});

console.log('readable text');
t('a dark background gets white text and a light one gets dark text', () => {
  const w = page();
  assert.strictEqual(w.readableTextOn('#000000'), '#ffffff'); assert.strictEqual(w.readableTextOn('#1e1e1e'), '#ffffff'); assert.strictEqual(w.readableTextOn('#0d47a1'), '#ffffff');
  assert.strictEqual(w.readableTextOn('#ffffff'), '#000000'); assert.strictEqual(w.readableTextOn('#f5f5f5'), '#000000'); assert.strictEqual(w.readableTextOn('#ffeb3b'), '#000000');
  assert.strictEqual(w.readableTextOn('nonsense'), '', 'no valid background: no text color');
});
t('across the whole color cube the choice has the higher contrast of the two', () => {
  const w = page();
  const lum = (hex) => { const lin = (i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5); };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  let checked = 0, worst = Infinity;
  for (let r = 0; r < 256; r += 15) for (let g = 0; g < 256; g += 15) for (let b = 0; b < 256; b += 15) {
    const bg = '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
    const pick = w.readableTextOn(bg), other = pick === '#ffffff' ? '#000000' : '#ffffff';
    assert.ok(['#ffffff', '#000000'].includes(pick), bg);
    assert.ok(ratio(bg, pick) >= ratio(bg, other), bg + ' -> ' + pick);
    worst = Math.min(worst, ratio(bg, pick)); checked++;
  }
  assert.ok(checked > 4000);
  assert.ok(worst >= 4.5, 'the worst case still reaches WCAG AA for normal text: ' + worst.toFixed(2));
});

console.log('what is applied');
t('nothing chosen: nothing applied (the bar is what the theme draws)', () => {
  const w = page(); assert.deepStrictEqual(plain(w.getStatusBarColors()), { background: '', foreground: '' });
});
t('both chosen: both applied, and the chosen text color wins over the automatic one', () => {
  const w = page({ statusBarBackground: '#112233', statusBarForeground: '#ffeeaa' });
  assert.deepStrictEqual(plain(w.getStatusBarColors()), { background: '#112233', foreground: '#ffeeaa' });
  assert.deepStrictEqual(plain(page({ statusBarBackground: '#ffffff', statusBarForeground: '#ffffff' }).getStatusBarColors()), { background: '#ffffff', foreground: '#ffffff' }, 'it is the user\u2019s choice, even if unreadable');
});
t('only a background: the text and icons follow it with black or white', () => {
  assert.deepStrictEqual(plain(page({ statusBarBackground: '#101820' }).getStatusBarColors()), { background: '#101820', foreground: '#ffffff' });
  assert.deepStrictEqual(plain(page({ statusBarBackground: '#fafafa' }).getStatusBarColors()), { background: '#fafafa', foreground: '#000000' });
});
t('only a text color: it is applied alone, on the theme\u2019s own background', () => {
  assert.deepStrictEqual(plain(page({ statusBarForeground: '#00ff88' }).getStatusBarColors()), { background: '', foreground: '#00ff88' });
});
t('a bad stored value counts as not chosen', () => {
  assert.deepStrictEqual(plain(page({ statusBarBackground: 'red', statusBarForeground: '#zzz' }).getStatusBarColors()), { background: '', foreground: '' });
});
t('all four Color Themes use the chosen colors', () => {
  for (const colorTheme of ['CodeMini Light', 'CodeMini Light +', 'CodeMini Dark', 'CodeMini Dark +']) {
    const w = page({ colorTheme, statusBarBackground: '#336699', statusBarForeground: '#fedcba' });
    assert.strictEqual(w.isThemePackActive(), false, colorTheme);
    assert.deepStrictEqual(plain(w.getStatusBarColors()), { background: '#336699', foreground: '#fedcba' }, colorTheme);
  }
});
t('under either Theme Pack nothing is applied, however the colors were chosen', () => {
  for (const themePack of ['CodeMini Premium', 'CodeMini Premium Light']) for (const colorTheme of ['CodeMini Light', 'CodeMini Dark +']) {
    const w = page({ themePack, colorTheme, statusBarBackground: '#336699', statusBarForeground: '#fedcba' });
    assert.strictEqual(w.isThemePackActive(), true, themePack);
    assert.deepStrictEqual(plain(w.getStatusBarColors()), { background: '', foreground: '' }, themePack + ' / ' + colorTheme);
  }
  assert.deepStrictEqual(plain(page({ themePack: 'CodeMini Premium', statusBarBackground: '#336699' }).getStatusBarColors()), { background: '', foreground: '' }, 'not even the automatic text color');
});
t('an unknown pack name is not a pack (the colors still apply, as for the Color Theme)', () => {
  assert.deepStrictEqual(plain(page({ themePack: 'Gone', statusBarBackground: '#336699' }).getStatusBarColors()).background, '#336699');
});

console.log('the two CSS variables on <html>');
t('chosen colors are set as --status-bar-bg and --status-bar-fg', () => {
  const w = page({ statusBarBackground: '#112233', statusBarForeground: '#ffeeaa' }), root = fakeRoot();
  w.applyStatusBarColors(root);
  assert.deepStrictEqual(root.props, { '--status-bar-bg': '#112233', '--status-bar-fg': '#ffeeaa' });
});
t('a Theme Pack removes them, and turning it off brings them back', () => {
  const w = page({ statusBarBackground: '#112233', statusBarForeground: '#ffeeaa' }), root = fakeRoot();
  w.applyStatusBarColors(root); assert.strictEqual(Object.keys(root.props).length, 2);
  w.appSettings.themePack = 'CodeMini Premium'; w.applyStatusBarColors(root);
  assert.deepStrictEqual(root.props, {}, 'the pack\u2019s own status bar, as it was');
  assert.strictEqual(w.appSettings.statusBarBackground, '#112233', 'the choice itself is kept');
  w.appSettings.themePack = 'None'; w.applyStatusBarColors(root);
  assert.deepStrictEqual(root.props, { '--status-bar-bg': '#112233', '--status-bar-fg': '#ffeeaa' });
});
t('Reset (both empty) removes them, and a half reset leaves only the other one', () => {
  const w = page({ statusBarBackground: '#112233', statusBarForeground: '#ffeeaa' }), root = fakeRoot();
  w.applyStatusBarColors(root);
  w.appSettings.statusBarBackground = ''; w.applyStatusBarColors(root);
  assert.deepStrictEqual(root.props, { '--status-bar-fg': '#ffeeaa' });
  w.appSettings.statusBarForeground = ''; w.applyStatusBarColors(root);
  assert.deepStrictEqual(root.props, {});
});
t('only a background sets both variables (the text follows it)', () => {
  const w = page({ statusBarBackground: '#101820' }), root = fakeRoot();
  w.applyStatusBarColors(root);
  assert.deepStrictEqual(root.props, { '--status-bar-bg': '#101820', '--status-bar-fg': '#ffffff' });
});

console.log('the stylesheet falls back to what it always used');
const css = read('css/style.css'), themes = read('css/themes.css');
const rule = (src, sel) => { const i = src.indexOf(sel + ' {'); assert.ok(i >= 0, sel + ' rule'); return src.slice(i, src.indexOf('}', i)); };
t('.status-bar reads the variables, falling back to its previous colors', () => {
  const r = rule(css, '.status-bar');
  assert.ok(/background-color:\s*var\(--status-bar-bg,\s*var\(--bg-panel\)\)/.test(r), 'background');
  assert.ok(/[^-]color:\s*var\(--status-bar-fg,\s*var\(--text-main\)\)/.test(r), 'text');
});
t('the icons read the text color, falling back to the gray they had', () => {
  assert.ok(/color:\s*var\(--status-bar-fg,\s*var\(--icon-gray\)\)/.test(rule(css, '.status-item i')));
});
t('the dark rule in themes.css (it outranks .status-bar) reads the background the same way', () => {
  const r = rule(themes, '[data-theme="dark"] .status-bar');
  assert.ok(/background-color:\s*var\(--status-bar-bg,\s*var\(--bg-panel\)\)/.test(r));
  assert.ok(/border-top:\s*1px solid var\(--border-color\)/.test(r), 'its border is unchanged');
});
t('no Theme Pack sets the variables: a pack\u2019s bar can only be its own', () => {
  assert.ok(!/--status-bar-(bg|fg)\s*:/.test(themes) && !/--status-bar-(bg|fg)\s*:/.test(css), 'the variables are set from JavaScript only, never in a stylesheet');
  assert.ok(!/codemini-premium[^{]*\.status-bar/.test(themes), 'and no pack rule styles .status-bar differently');
});
t('warning icons keep their own colors (auto save off, restricted mode)', () => {
  assert.ok(/#statusAutoSave\.as-off i\s*\{\s*color:\s*var\(--icon-yellow\)/.test(css));
  assert.ok(/\.wt-status i\s*\{\s*color:var\(--icon-yellow/.test(read('js/core/workspace-trust.js')));
});

console.log('wiring');
t('both settings have an empty default, so the bar is unchanged until one is chosen', () => {
  const src = sp.slice(sp.indexOf('window.getDefaultSettings = function() {'), sp.indexOf('window.reloadSettings = function'));
  const win = {}; vm.runInContext(src, vm.createContext({ window: win }));
  const d = win.getDefaultSettings();
  assert.strictEqual(d.statusBarBackground, ''); assert.strictEqual(d.statusBarForeground, '');
  const keys = Object.keys(d); assert.ok(keys.indexOf('statusBarBackground') > keys.indexOf('accentColor'), 'listed with the Theme settings, so settings.json shows it there');
});
t('loading reads and cleans both values', () => {
  assert.ok(/statusBarBackground: window\.normalizeStatusBarColor\(localStorage\.getItem\(getPrefixedKey\('statusBarBackground'\)\)\)/.test(sp));
  assert.ok(/statusBarForeground: window\.normalizeStatusBarColor\(localStorage\.getItem\(getPrefixedKey\('statusBarForeground'\)\)\)/.test(sp));
});
t('saving cleans the value first (settings.json can send anything) and re-applies the theme', () => {
  const fn = sp.slice(sp.indexOf('window.saveSetting = function'));
  assert.ok(fn.indexOf("window.normalizeStatusBarColor(value)") > 0 && fn.indexOf('window.normalizeStatusBarColor(value)') < fn.indexOf('window.appSettings[key] = value'), 'cleaned before it is stored');
  assert.ok(/\['colorTheme', 'themePack', 'accentColor', 'statusBarBackground', 'statusBarForeground',/.test(fn), 'a change applies at once');
});
t('applyTheme applies the colors, and the early-paint cache remembers both variables so the next load has no flash', () => {
  assert.ok(/window\.applyStatusBarColors\(document\.documentElement\)/.test(sp));
  assert.ok(/\['--accent-blue', '--bg-tabs-bar', '--bg-tab-inactive', '--status-bar-bg', '--status-bar-fg'\]\.forEach/.test(sp));
  assert.ok(/for \(var name in \(c\.vars \|\| \{\}\)\) root\.style\.setProperty\(name, c\.vars\[name\]\)/.test(read('index.html')), 'index.html puts every cached variable back before the first paint');
});
t('Settings > Theme has one Status Bar row: both swatches and Reset, wired and lockable', () => {
  const sec = sp.slice(sp.indexOf('id="set-theme"'), sp.indexOf('id="set-snippets"'));
  assert.ok(/<h3 class="settings-category-title">Status Bar<\/h3>/.test(sec));
  assert.ok(/id="statusBarBackgroundInput" data-setting="statusBarBackground"/.test(sec) && /id="statusBarForegroundInput" data-setting="statusBarForeground"/.test(sec));
  assert.ok(/id="btnResetStatusBarColors"/.test(sec) && /id="statusBarColorsHint"/.test(sec));
  assert.strictEqual((sec.match(/type="color"/g) || []).length, 3, 'accent color + the two new swatches');
  assert.ok(/btnResetStatusBar\.addEventListener\('click', \(\) => \{\s*window\.saveSetting\('statusBarBackground', ''\);\s*window\.saveSetting\('statusBarForeground', ''\);/.test(sp), 'Reset clears both');
  const sync = sp.slice(sp.indexOf('window.syncUI = function'), sp.indexOf('window.applyTheme();', sp.indexOf('window.syncUI = function')));
  assert.ok(/input\.disabled = packActive/.test(sync) && /sbReset\.disabled = packActive/.test(sync), 'swatches and Reset are locked under a Theme Pack');
});
t('the new keys are in settings.json (they have defaults and controls) and are not security settings', () => {
  const J = require('../js/core/settings-json.js');
  assert.strictEqual(J.isSecurity('statusBarBackground'), false); assert.strictEqual(J.isSecurity('statusBarForeground'), false);
});

console.log(`\n${n} passed`);
