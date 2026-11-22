// Keeps the in-app project metadata (Settings > About, feedback address) consistent with the repository.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

const win = {};
vm.runInContext(read('js/core/app-info.js'), vm.createContext({ window: win }));
const info = win.APP_INFO, pkg = JSON.parse(read('package.json'));

console.log('app-info');
t('version matches package.json and the service worker cache name', () => {
  assert.strictEqual(info.version, pkg.version);
  assert.ok(read('sw.js').includes(`'codemini-static-v${pkg.version}'`), 'CACHE_NAME should be codemini-static-v' + pkg.version);
});
t('repo link matches package.json repository', () => {
  assert.strictEqual(info.links.repo + '.git', pkg.repository.url.replace(/^git\+/, ''));
  assert.strictEqual(info.links.issues, pkg.bugs.url);
});
t('live link matches package.json homepage', () => assert.strictEqual(info.links.live, pkg.homepage));
t('every linked repo file exists in the repository', () => {
  for (const k of ['license', 'privacy', 'usage', 'security', 'notices', 'changelog']) {
    const file = info.links[k].split('/blob/main/')[1];
    assert.ok(fs.existsSync(path.join(root, file)), `${k} -> ${file} is missing`);
  }
});
t('feedback email is the maintainer address from package.json', () => assert.ok(pkg.author.includes(info.feedbackEmail)));
t('license matches LICENSE and package.json', () => {
  assert.strictEqual(info.license, pkg.license);
  assert.ok(read('LICENSE').startsWith('MIT License'));
});

console.log('wiring');
t('app-info.js loads before settings-profile.js and help-feedback.js, and is precached', () => {
  const html = read('index.html'), at = (f) => html.indexOf(`js/core/${f}.js`);
  assert.ok(at('app-info') > -1 && at('app-info') < at('settings-profile') && at('app-info') < at('help-feedback'));
  assert.ok(read('sw.js').includes("'/js/core/app-info.js'"));
});
t('Settings > About has no placeholder "#" links', () => {
  const s = read('js/core/settings-profile.js');
  const about = s.slice(s.indexOf('id="set-about"'));
  assert.ok(!/href="#"/.test(about), 'found href="#" in About');
  assert.ok(!/All rights reserved/i.test(about), 'About should state the MIT license, not "All rights reserved"');
});
t('Send Feedback addresses a recipient', () => assert.ok(/mailto:\$\{to\}/.test(read('js/core/help-feedback.js'))));
// The terminal's `uname` reports the app's own version. It is read from APP_INFO when the command runs, so a release
// only has to change app-info.js (which this test already ties to package.json and the service worker).
console.log('terminal uname');
const termWin = {};
vm.runInContext(read('js/terminal/terminal-commands.js'), vm.createContext({ window: termWin, console, setTimeout, clearTimeout }));
const noop = () => {};
const unameOut = [];
// One command table, built once (as when a terminal opens). APP_INFO is swapped underneath it between calls.
const termCommands = termWin.getTerminalCommands((line) => unameOut.push(line), noop, noop, noop, noop, noop, noop, noop, noop, noop, noop,
  { workspaceSynced: true, folderStack: [{ id: 'root' }], interrupted: false }, noop, noop, {}, {}, {}, {}, noop, noop, noop).commands;
const uname = (args, appInfo) => {
  termWin.APP_INFO = appInfo;
  unameOut.length = 0;
  termCommands.uname(args); // prints before its first await
  return unameOut.join('\n');
};
t('uname -r and uname -a show the version of the running app', () => {
  assert.strictEqual(uname(['uname', '-r'], info), pkg.version);
  assert.strictEqual(uname(['uname', '-a'], info), `CodeMiniOS codemini ${pkg.version} WebAssembly x86_64 GNU/Linux`);
});
t('they follow APP_INFO when it changes under an open terminal (read when the command runs, not when it was created)', () => {
  assert.strictEqual(uname(['uname', '-r'], { version: '9.9.9' }), '9.9.9');
  assert.ok(uname(['uname', '-a'], { version: '10.0.0-beta.1' }).includes(' 10.0.0-beta.1 '));
});
t('without APP_INFO they say "unknown" instead of failing or guessing', () => {
  assert.strictEqual(uname(['uname', '-r'], undefined), 'unknown');
  assert.ok(uname(['uname', '-a'], undefined).startsWith('CodeMiniOS codemini unknown '));
  assert.strictEqual(uname(['uname', '-r'], {}), 'unknown');
});
t('the other uname flags are unchanged', () => {
  assert.strictEqual(uname(['uname'], info), 'CodeMiniOS');
  assert.strictEqual(uname(['uname', '-s'], info), 'CodeMiniOS');
  assert.strictEqual(uname(['uname', '-m'], info), 'x86_64');
});
t('terminal-commands.js holds no copy of the version (it would go stale at the next release)', () => {
  assert.ok(!read('js/terminal/terminal-commands.js').includes(pkg.version), 'the version is written into terminal-commands.js: read window.APP_INFO.version instead');
});
console.log('terminal version');
t('APP_INFO carries the terminal\'s own version, a plain x.y.z', () => {
  assert.ok(/^\d+\.\d+\.\d+$/.test(info.terminalVersion), 'APP_INFO.terminalVersion should look like 1.1.0, got ' + info.terminalVersion);
});
t('the banner that restart prints shows it, read when the command runs (a release changes app-info.js only)', () => {
  for (const v of ['7.8.9', '10.0.0']) {
    termWin.APP_INFO = { terminalVersion: v }; unameOut.length = 0; termCommands.restart(); // prints before its first await
    assert.ok(unameOut.join('\n').includes('CodeMini Terminal Environment v' + v + '</div>'), 'restart banner for ' + v + ': ' + unameOut.join('|'));
  }
});
t('without a terminal version the banner says no number instead of a stale one, and a hostile value is cut down', () => {
  termWin.APP_INFO = undefined; unameOut.length = 0; termCommands.restart();
  assert.ok(unameOut.join('\n').includes('CodeMini Terminal Environment</div>') && !/Environment v\d/.test(unameOut.join('\n')));
  termWin.APP_INFO = { terminalVersion: '1.0<img src=x>' }; assert.ok(!/[<>]/.test(termWin.terminalVersionLabel()) && termWin.terminalVersionLabel().startsWith(' v1.0'));
});
t('neither banner holds a copy of the number: terminal-window.js (the first one) and terminal-commands.js (restart) both read it', () => {
  for (const f of ['js/terminal/terminal-window.js', 'js/terminal/terminal-commands.js']) {
    const s = read(f);
    assert.ok(!/Terminal Environment v\d/.test(s), f + ' writes a terminal version by hand: use window.terminalVersionLabel()');
    assert.ok(s.includes('terminalVersionLabel'), f + ' does not read the terminal version');
  }
});

console.log(`\n${n} app-info checks passed`);
