// Keeps USAGE.md (the content and usage rules, ids P1 to P6) well formed and linked. Anything that will later show a rule id next to a
// finding (the planned CodeMini Guard and the CodeMini Share import review) depends on these ids staying stable, so a gap, a duplicate,
// a missing response or a broken link fails here instead of being found by a user.
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

const doc = read('USAGE.md');
const RESPONSES = ['Held by policy', 'Suspicious', 'Notice'];

// The rules table at the top: | P1 | Rule | Default response |
const table = [...doc.matchAll(/^\|\s*(P\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm)].map((m) => ({ id: m[1], rule: m[2], response: m[3] }));
// The sections: ### P1. Title ... up to the next ### or ##
const sections = [...doc.matchAll(/^### (P\d+)\. (.+)$/gm)].map((m, i, all) => {
  const start = m.index, end = i + 1 < all.length ? all[i + 1].index : doc.indexOf('\n## ', start + 1);
  return { id: m[1], title: m[2], body: doc.slice(start, end === -1 ? undefined : end) };
});

t('the file states a rules version and date', () => {
  assert.ok(/^Rules version: \*\*v\d+\*\* \(\d{4}-\d{2}-\d{2}\)$/m.test(doc), 'expected a line like: Rules version: **v1** (2026-11-21)');
});

t('ids are P1, P2, ... with no gap and no duplicate, in the table and in the sections', () => {
  const want = (k) => Array.from({ length: k }, (_, i) => 'P' + (i + 1));
  assert.ok(table.length >= 6, 'the rules table must list at least P1 to P6');
  assert.deepStrictEqual(table.map((r) => r.id), want(table.length));
  assert.deepStrictEqual(sections.map((s) => s.id), want(sections.length));
  assert.deepStrictEqual(table.map((r) => r.id), sections.map((s) => s.id), 'the table and the sections must list the same ids');
});

t('every rule has a rule statement, what it covers, what it does not, and a default response', () => {
  for (const s of sections) {
    for (const label of ['**Rule.**', '**Covers.**', '**Does not cover.**', '**Default response:**']) {
      assert.ok(s.body.includes(label), s.id + ' is missing ' + label);
    }
  }
});

t('each default response is one of the known verdict words and matches the table', () => {
  for (const s of sections) {
    const m = s.body.match(/\*\*Default response:\*\* (.+)/);
    assert.ok(m, s.id + ' has no default response line');
    const resp = m[1].trim();
    assert.ok(RESPONSES.includes(resp), s.id + ' uses "' + resp + '"; allowed: ' + RESPONSES.join(', '));
    assert.strictEqual(table.find((r) => r.id === s.id).response, resp, s.id + ': the table and the section disagree');
  }
});

t('the table title matches the section title for every rule', () => {
  for (const s of sections) assert.strictEqual(table.find((r) => r.id === s.id).rule, s.title, s.id + ': table and heading differ');
});

t('every relative link in USAGE.md points at a file that exists', () => {
  const links = [...doc.matchAll(/\]\(([^)#\s]+)\)/g)].map((m) => m[1]).filter((u) => !/^[a-z]+:/i.test(u));
  assert.ok(links.length >= 3, 'expected links to LICENSE, SECURITY.md and PRIVACY.md');
  for (const l of links) assert.ok(fs.existsSync(path.join(root, l)), 'broken link: ' + l);
});

t('the README and SECURITY.md both link to USAGE.md', () => {
  assert.ok(/\]\(USAGE\.md\)/.test(read('README.md')), 'README.md must link to USAGE.md');
  assert.ok(/\]\(USAGE\.md\)/.test(read('SECURITY.md')), 'SECURITY.md must link to USAGE.md');
});

t('Settings > About links to USAGE.md, through APP_INFO like the other project links', () => {
  const info = read('js/core/app-info.js');
  assert.ok(/usage:\s*REPO \+ '\/blob\/main\/USAGE\.md'/.test(info), "app-info.js must set links.usage to REPO + '/blob/main/USAGE.md'");
  const s = read('js/core/settings-profile.js');
  const about = s.slice(s.indexOf('id="set-about"'));
  assert.ok(about.includes("${_L('usage')}"), "the About links must include ${_L('usage')}");
});

t('the rules are part of npm test, so CI runs them', () => {
  assert.ok(/node tests\/usage-rules\.test\.js/.test(JSON.parse(read('package.json')).scripts.test), 'add node tests/usage-rules.test.js to the "test" script');
});

t('PRIVACY.md and USAGE.md point at each other', () => {
  assert.ok(/\]\(PRIVACY\.md\)/.test(doc), 'USAGE.md must link to PRIVACY.md');
  assert.ok(/\]\(USAGE\.md\)/.test(read('PRIVACY.md')), 'PRIVACY.md must link to USAGE.md');
});

t('the document does not claim a checker exists until one does', () => {
  // The Status section says CodeMini Guard is planned. The day js/core/guard.js exists, that wording is wrong and has to be updated.
  const guardBuilt = fs.existsSync(path.join(root, 'js', 'core', 'guard.js'));
  const saysPlanned = /Planned, not built/.test(doc);
  assert.ok(/^## Status: what enforces these rules today$/m.test(doc), 'the Status section is missing');
  assert.strictEqual(saysPlanned, !guardBuilt, guardBuilt
    ? 'js/core/guard.js exists, so the Status section must stop saying "Planned, not built"'
    : 'no js/core/guard.js yet, so the Status section must say "Planned, not built"');
});

t('the document does not call anything "safe" or "virus-free"', () => {
  const claims = doc.match(/\b(virus-free|100% safe|guaranteed safe)\b/gi);
  assert.strictEqual(claims, null, 'overclaim found: ' + (claims || []).join(', '));
});

console.log(`\n${n} usage-rules checks passed`);
