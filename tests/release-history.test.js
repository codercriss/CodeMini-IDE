// Keeps the in-app version history (Settings > Updates and the Version History tab, `_RELEASES` in js/core/settings-profile.js)
// in step with CHANGELOG.md and with the app's own version. It drifted before: the newest card was labelled as the current
// release but carried the notes of an older one, and three releases were missing.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

const win = {};
vm.runInContext(read('js/core/app-info.js'), vm.createContext({ window: win }));
const V = win.APP_INFO.version;

// Pull the real array out of the source and evaluate it exactly as the app does (with _V in scope).
const src = read('js/core/settings-profile.js');
const start = src.indexOf('const _RELEASES = [');
assert.ok(start > -1, 'const _RELEASES was not found in settings-profile.js');
const end = src.indexOf('\n  ].map(', start);
assert.ok(end > -1, '_RELEASES must end with ].map(...) that sets `current`');
const stmtEnd = src.indexOf(';', end);
// JSON round trip: arrays made inside a vm context have another prototype, which deepStrictEqual would reject.
const releases = JSON.parse(vm.runInNewContext('(function(){ const _V = ' + JSON.stringify(V) + '; ' + src.slice(start, stmtEnd + 1) + ' return JSON.stringify(_RELEASES); })()'));

const log = read('CHANGELOG.md');
const logVersions = [...log.matchAll(/^## (\d+\.\d+\.\d+)\b/gm)].map(m => m[1]);
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

console.log('version history');
t('there is one card for every version in CHANGELOG.md, in the same order', () => {
  assert.deepStrictEqual(releases.map(r => r.version).filter(v => logVersions.includes(v)), logVersions,
    'CHANGELOG.md lists ' + logVersions.join(', ') + ' but _RELEASES has ' + releases.map(r => r.version).join(', '));
  for (const v of logVersions) assert.ok(releases.some(r => r.version === v), `CHANGELOG.md has ${v} but _RELEASES has no card for it`);
});
t('versions are unique and newest first', () => {
  const vs = releases.map(r => r.version);
  assert.strictEqual(new Set(vs).size, vs.length, 'duplicate version in _RELEASES');
  for (let i = 1; i < vs.length; i++) assert.ok(cmp(vs[i - 1], vs[i]) > 0, `${vs[i - 1]} must come before ${vs[i]} only if it is newer`);
});
t('the newest card is the installed version (APP_INFO.version), and only it is Current', () => {
  assert.strictEqual(releases[0].version, V, `the top card is v${releases[0].version} but the app is v${V}: add a card for v${V}`);
  assert.deepStrictEqual(releases.filter(r => r.current).map(r => r.version), [V]);
});
t('no card is newer than the installed version', () => assert.ok(releases.every(r => cmp(r.version, V) <= 0)));
t('every card has an icon, a date, a one-line summary and at least one change', () => {
  for (const r of releases) {
    assert.ok(/^ri-[a-z0-9-]+$/.test(r.icon), `v${r.version}: icon`);
    assert.ok(r.date && !/latest release/i.test(r.date), `v${r.version}: a real date (a moving label such as "Latest release" goes stale)`);
    assert.ok(r.summary && r.summary.length > 10 && r.summary.length < 140, `v${r.version}: summary should be one short line`);
    assert.ok(Array.isArray(r.features) && r.features.length >= 1, `v${r.version}: features`);
    for (const f of r.features) assert.ok(typeof f === 'string' && f.trim(), `v${r.version}: empty feature`);
  }
});
t('card text is static, trusted markup: only <strong> and entities, no raw & or other tags', () => {
  for (const r of releases) for (const s of [r.summary, ...r.features]) {
    assert.ok(!/<(?!\/?strong>)/i.test(s), `v${r.version}: only <strong> is allowed in "${s.slice(0, 40)}..."`);
    assert.ok(!/&(?!(amp|lt|gt|quot|rsquo|lsquo|ldquo|rdquo|rsaquo|lsaquo|middot|#\d+);)/.test(s), `v${r.version}: unescaped & in "${s.slice(0, 40)}..."`);
  }
});
t('the CHANGELOG intro names the installed version', () => {
  const m = log.match(/reports itself as v(\d+\.\d+\.\d+)/);
  assert.ok(m, 'CHANGELOG.md should say which version the app reports');
  assert.strictEqual(m[1], V);
});

console.log('wiring');
t('Updates lists the newest releases and a View all versions button; the tab lists all of them', () => {
  assert.ok(/_releaseCards\(_RELEASES\.slice\(0, _RELEASES_SHOWN\), 'relS'\)/.test(src));
  assert.ok(/data-action="view-all-versions"/.test(src));
  assert.ok(/_releaseCards\(_RELEASES, 'relV'\)/.test(src), 'the Version History tab must show every release');
});
console.log(`\n${n} release-history checks passed`);
