// Source Control > Remote > "Your Repositories" (js/git/git.js), checked from the source (no browser).
// Bug: repo names showed as "owner/..." on a phone. .git-file-name is capped at 45% (35% under 480px) for the file
// lists, where the name shares a line with the path; a repo's name sits on its own line, so it was cut far too early.
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'js/git/git.js'), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };
const rule = (sel) => { const m = src.match(new RegExp(`(?:^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)); return m ? m[1] : null; };

t('the shared name cap still exists for file lists (45%, 35% on phones)', () => {
  assert(/\.git-file-name \{[^}]*max-width:45%/.test(src));
  assert(/@media \(max-width: 480px\) \{[^\n]*\.git-file-name \{ max-width:35%; \}/.test(src));
});
t('repo rows override it: the name may use the full column', () => {
  const r = rule('.git-repo-row .git-file-name');
  assert(r, 'missing .git-repo-row .git-file-name rule');
  assert(/max-width:\s*100%/.test(r), 'must lift the percentage cap');
  assert(/flex-shrink:\s*1/.test(r));
});
t('the override beats the phone media rule (two classes vs one), wherever it sits in the file', () => {
  assert(/\.git-repo-row \.git-file-name/.test(src));
});
t('the repo name is on its own line above the description (so a full-width name is right)', () => {
  const i = src.indexOf('<div class="git-repo-row');
  const block = src.slice(i, src.indexOf('<div class="git-file-actions">', i));
  assert(/<div style="min-width:0; flex:1;">\s*<div class="git-file-name"[^>]*>[\s\S]*?<\/div>\s*<div class="git-file-path">/.test(block));
});
t('it is the only place .git-file-name is a full-line block; the others are inline spans next to a path', () => {
  assert.strictEqual((src.match(/<div class="git-file-name"/g) || []).length, 1);
});
console.log(`\n${n} passed`);
