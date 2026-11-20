// Reverting one change (js/core/diff-editor.js: revertLineChange, revertLineChanges, revertParts). Two independent ways to
// undo a change are checked against each other: the line-based one the diff tab uses (Monaco line numbers) and the
// parts-based one the Source Control popup uses (jsdiff parts, which carry their own line endings). If they ever disagree,
// one of them loses or invents text. They agree byte for byte when both files use the same line endings. When the two
// files use different ones they agree on the text but not on the endings of the lines put back, on purpose: the diff tab
// (Monaco cannot even see an endings-only difference) puts lines back with the working file's own endings so a CRLF file
// never gains LF lines, while the popup, which does show them, restores the original's text exactly.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { revertLineChange, revertLineChanges, revertParts, splitKeepingEols } = require('../js/core/diff-editor.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };
// Monaco's shape: end 0 = no lines on that side, and start is then the line the change happened after.
const ch = (os_, oe, ms, me) => ({ originalStartLineNumber: os_, originalEndLineNumber: oe, modifiedStartLineNumber: ms, modifiedEndLineNumber: me });

console.log('splitting keeps every line ending');
t('lines and their own terminators, the last one with none', () => {
  assert.deepStrictEqual(splitKeepingEols('a\r\nb\nc'), { lines: ['a', 'b', 'c'], eols: ['\r\n', '\n', ''] });
  assert.deepStrictEqual(splitKeepingEols('a\n'), { lines: ['a', ''], eols: ['\n', ''] });
  assert.deepStrictEqual(splitKeepingEols(''), { lines: [''], eols: [''] });
});

console.log('one change at a time');
t('a replaced line goes back', () => {
  assert.strictEqual(revertLineChange('a\nX\nc\n', 'a\nb\nc\n', ch(2, 2, 2, 2)), 'a\nb\nc\n');
});
t('added lines (original has none there) are removed', () => {
  assert.strictEqual(revertLineChange('a\nb\nc\n', 'a\nc\n', ch(1, 0, 2, 2)), 'a\nc\n');
  assert.strictEqual(revertLineChange('a\nb\nb2\nc\n', 'a\nc\n', ch(1, 0, 2, 3)), 'a\nc\n');
});
t('deleted lines (modified has none there) come back', () => {
  assert.strictEqual(revertLineChange('a\nc\n', 'a\nb\nc\n', ch(2, 2, 1, 0)), 'a\nb\nc\n');
});
t('at the very top: lines added before line 1, and lines deleted from the top', () => {
  assert.strictEqual(revertLineChange('NEW\na\nb\n', 'a\nb\n', ch(0, 0, 1, 1)), 'a\nb\n');
  assert.strictEqual(revertLineChange('b\n', 'a\nb\n', ch(1, 1, 0, 0)), 'a\nb\n');
});
t('at the end of the file', () => {
  assert.strictEqual(revertLineChange('a\nb\nTAIL\n', 'a\nb\n', ch(2, 0, 3, 3)), 'a\nb\n');
  assert.strictEqual(revertLineChange('a\n', 'a\nb\n', ch(2, 2, 1, 0)), 'a\nb\n');
});
t('no newline at the end of the file is kept as the file had it', () => {
  // modified gained a last line and no final newline; original had "a\nb" (no final newline) too
  assert.strictEqual(revertLineChange('a\nb\nc', 'a\nb', ch(2, 0, 3, 3)), 'a\nb');
  // original ended with a newline, modified lost the last line and its newline: the line and the newline come back
  assert.strictEqual(revertLineChange('a', 'a\nb\n', ch(2, 3, 1, 0)), 'a\nb\n');
  // the whole file is one line without a newline, edited
  assert.strictEqual(revertLineChange('X', 'a', ch(1, 1, 1, 1)), 'a');
});
t('CRLF files stay CRLF, and the put-back lines take the file\'s own ending', () => {
  assert.strictEqual(revertLineChange('a\r\nX\r\nc\r\n', 'a\r\nb\r\nc\r\n', ch(2, 2, 2, 2)), 'a\r\nb\r\nc\r\n');
  // the original used LF, the working file CRLF: the line put back follows the working file
  assert.strictEqual(revertLineChange('a\r\nX\r\nc\r\n', 'a\nb\nc\n', ch(2, 2, 2, 2)), 'a\r\nb\r\nc\r\n');
});
t('mixed line endings elsewhere in the file are not touched', () => {
  assert.strictEqual(revertLineChange('a\r\nX\nc\r\nd\n', 'a\r\nb\nc\r\nd\n', ch(2, 2, 2, 2)), 'a\r\nb\nc\r\nd\n');
});
t('an empty file on either side', () => {
  assert.strictEqual(revertLineChange('a\nb\n', '', ch(0, 0, 1, 2)), '');
  assert.strictEqual(revertLineChange('', 'a\nb\n', ch(1, 2, 0, 0)), 'a\nb\n');
});
t('a change that does not fit the texts is refused, not guessed at', () => {
  assert.strictEqual(revertLineChange('a\n', 'a\n', ch(1, 1, 5, 6)), null);
  assert.strictEqual(revertLineChange('a\n', 'a\n', ch(9, 9, 1, 1)), null);
});

(async () => {
  // jsdiff, the vendored copy (a .js file is CommonJS to Node, so load a .mjs copy of it)
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'diff-revert-')), 'diff.mjs');
  fs.copyFileSync(path.join(__dirname, '..', 'js/vendor/diff-9.0.0.js'), tmp);
  const { diffLines } = await import(require('url').pathToFileURL(tmp).href);

  // The changes of a diffLines() result as Monaco-style line changes, plus the part indices each one covers.
  const eolCount = (v) => v.split(/\r\n|\r|\n/).length - 1;
  function changesOf(parts) {
    const out = []; let o = 0, m = 0, i = 0;
    while (i < parts.length) {
      const p = parts[i];
      if (!p.added && !p.removed) { const c = eolCount(p.value); o += c; m += c; i++; continue; }
      const idx = []; let oc = 0, mc = 0;
      while (i < parts.length && (parts[i].added || parts[i].removed)) { idx.push(i); const c = eolCount(parts[i].value); if (parts[i].removed) oc += c; else mc += c; i++; }
      out.push({ change: ch(oc ? o + 1 : o, oc ? o + oc : 0, mc ? m + 1 : m, mc ? m + mc : 0), idx });
      o += oc; m += mc;
    }
    return out;
  }

  console.log('the two ways agree on random files');
  let seed = 12345; const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const mk = (eol) => { const k = Math.floor(rnd() * 8); let s = ''; for (let i = 0; i < k; i++) s += pick(['a', 'b', 'c', 'd', 'e', '', 'a b', '  ']) + (typeof eol === 'function' ? eol() : eol); return s; };
  let cases = 0, changesChecked = 0;
  const flat = (x) => x.replace(/\r\n|\r/g, '\n');
  const run = (A, B, exact = true) => {
    const same = (a, b, msg) => assert.strictEqual(exact ? a : flat(a), exact ? b : flat(b), msg);
    const parts = diffLines(A, B); const list = changesOf(parts);
    assert.strictEqual(revertParts(parts, []), B, 'reverting nothing must give the modified text');
    assert.strictEqual(revertParts(parts, parts.map((_, i) => i)), A, 'reverting everything must give the original');
    same(revertLineChanges(B, A, list.map((x) => x.change)), A, `all changes reverted must give the original\n${JSON.stringify([A, B])}`);
    const k = Math.min(list.length, 6);
    for (let mask = 0; mask < (1 << k); mask++) {
      const chosen = list.slice(0, k).filter((_, j) => mask & (1 << j));
      const viaLines = revertLineChanges(B, A, chosen.map((x) => x.change));
      const viaParts = revertParts(parts, chosen.flatMap((x) => x.idx));
      same(viaLines, viaParts, `subset ${mask} disagrees\n${JSON.stringify([A, B, chosen.map((x) => x.change)])}`);
      changesChecked++;
    }
    cases++;
  };
  t('LF files, 3000 random pairs: every subset of changes reverts the same either way', () => { for (let i = 0; i < 3000; i++) run(mk('\n'), mk('\n')); });
  t('CRLF files, 1500 random pairs', () => { for (let i = 0; i < 1500; i++) run(mk('\r\n'), mk('\r\n')); });
  t('mixed line endings inside the working file, 1500 random pairs (same text; endings of put-back lines may differ)', () => { for (let i = 0; i < 1500; i++) run(mk('\n'), mk(() => (rnd() < 0.5 ? '\n' : '\r\n')), false); });
  console.log(`    (${cases} file pairs, ${changesChecked} change subsets compared)`);

  console.log('parts');
  t('a hunk is its parts: reverting one change leaves the others as they are', () => {
    const A = 'a\nb\nc\nd\ne\n', B = 'a\nB\nc\nD\ne\n';
    const parts = diffLines(A, B); const list = changesOf(parts);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(revertParts(parts, list[0].idx), 'a\nb\nc\nD\ne\n');
    assert.strictEqual(revertParts(parts, list[1].idx), 'a\nB\nc\nd\ne\n');
  });
  t('a missing final newline is a change of its own and reverts exactly', () => {
    const parts = diffLines('a\nb', 'a\nb\n');
    assert.strictEqual(revertParts(parts, parts.map((_, i) => i)), 'a\nb');
  });
  console.log(`\n${n} diff-revert checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
