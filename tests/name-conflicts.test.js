// The planner behind the Replace / Skip / Rename dialog (js/core/name-conflicts.js). The dialog itself is covered in a
// real browser by tests/e2e/name-conflicts.e2e.js; here `ask` is a stand-in that records what it was shown and answers.
const assert = require('assert');
const { planPlacement, descendantsOf } = require('../js/core/name-conflicts.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };

const file = (id, name, parentId, extra) => Object.assign({ id, name, parentId: parentId || 'root', type: 'file', content: 'x', timestamp: 1000 }, extra);
const folder = (id, name, parentId, extra) => Object.assign({ id, name, parentId: parentId || 'root', type: 'folder', timestamp: 1000 }, extra);
const item = (id, name, type, extra) => Object.assign({ id, name, type: type || 'file', timestamp: 5000 }, extra);
// answers: a list consumed in order, or a function; every question is kept in `asked`
const asker = (answers) => { const asked = []; let i = 0; const fn = async (info) => { asked.push(info); const a = typeof answers === 'function' ? answers(info) : answers[Math.min(i++, answers.length - 1)]; return a; }; fn.asked = asked; return fn; };
const names = (plan) => plan.entries.map((e) => `${e.action}:${e.name}`);

(async () => {
  console.log('no clash, no question');
  await t('items with free names are placed as they are and nothing is asked', async () => {
    const ask = asker([{ choice: 'stop' }]);
    const plan = await planPlacement({ items: [item('a', 'a.txt'), item('b', 'b.txt')], existing: [file('z', 'z.txt')], parentId: 'root', ask });
    assert.deepStrictEqual(names(plan), ['place:a.txt', 'place:b.txt']); assert.strictEqual(ask.asked.length, 0); assert.strictEqual(plan.stopped, false);
  });
  await t('the same name in a different folder is not a clash', async () => {
    const ask = asker([{ choice: 'stop' }]);
    const plan = await planPlacement({ items: [item('a', 'a.txt')], existing: [folder('f', 'f'), file('x', 'a.txt', 'f')], parentId: 'root', ask });
    assert.strictEqual(ask.asked.length, 0); assert.deepStrictEqual(names(plan), ['place:a.txt']);
  });
  await t('names are compared ignoring case, like the rest of the app', async () => {
    const ask = asker([{ choice: 'skip' }]);
    await planPlacement({ items: [item('a', 'README.md')], existing: [file('x', 'readme.md')], parentId: 'root', ask });
    assert.strictEqual(ask.asked.length, 1);
  });

  console.log('the three answers');
  await t('Rename keeps both and numbers the newcomer the way it always has', async () => {
    const plan = await planPlacement({ items: [item('a', 'a.txt')], existing: [file('x', 'a.txt'), file('y', 'a(1).txt')], parentId: 'root', ask: asker([{ choice: 'rename' }]) });
    assert.deepStrictEqual(names(plan), ['rename:a(2).txt']); assert.strictEqual(plan.counts.renamed, 1);
  });
  await t('Skip leaves the item out', async () => {
    const plan = await planPlacement({ items: [item('a', 'a.txt')], existing: [file('x', 'a.txt')], parentId: 'root', ask: asker([{ choice: 'skip' }]) });
    assert.deepStrictEqual(names(plan), ['skip:a.txt']); assert.strictEqual(plan.counts.skipped, 1);
  });
  await t('Replace names the existing records to delete: a file is just itself', async () => {
    const plan = await planPlacement({ items: [item('a', 'a.txt')], existing: [file('x', 'a.txt')], parentId: 'root', ask: asker([{ choice: 'replace' }]) });
    assert.deepStrictEqual(names(plan), ['replace:a.txt']); assert.deepStrictEqual(plan.entries[0].removed.map((r) => r.id), ['x']);
  });
  await t('Replace of a folder removes everything inside it, at any depth', async () => {
    const existing = [folder('f', 'src'), file('f1', 'a.js', 'f'), folder('g', 'lib', 'f'), file('g1', 'b.js', 'g'), file('other', 'keep.js')];
    const plan = await planPlacement({ items: [item('n', 'src', 'folder')], existing, parentId: 'root', ask: asker([{ choice: 'replace' }]) });
    assert.deepStrictEqual(plan.entries[0].removed.map((r) => r.id).sort(), ['f', 'f1', 'g', 'g1']);
  });
  await t('Stop cancels the whole plan, even after earlier answers', async () => {
    const plan = await planPlacement({ items: [item('a', 'a.txt'), item('b', 'b.txt')], existing: [file('x', 'a.txt'), file('y', 'b.txt')], parentId: 'root', ask: asker([{ choice: 'replace' }, { choice: 'stop' }]) });
    assert.strictEqual(plan.stopped, true); assert.deepStrictEqual(plan.entries, []);
  });

  console.log('what the dialog is shown');
  await t('both names and both last-modified times, plus where it is going and how many are left', async () => {
    const ask = asker([{ choice: 'skip' }]);
    await planPlacement({ items: [item('a', 'a.txt', 'file', { timestamp: 7000, size: 12 }), item('b', 'b.txt')], existing: [file('x', 'a.txt', 'root', { timestamp: 3000 })], parentId: 'root', ask, verb: 'copying', where: 'Workspace A' });
    const q = ask.asked[0];
    assert.strictEqual(q.item.name, 'a.txt'); assert.strictEqual(q.item.timestamp, 7000); assert.strictEqual(q.existing.name, 'a.txt'); assert.strictEqual(q.existing.timestamp, 3000);
    assert.strictEqual(q.verb, 'copying'); assert.strictEqual(q.where, 'Workspace A');
    assert.strictEqual(q.index, 0); assert.strictEqual(q.total, 2); assert.strictEqual(q.remaining, 1); assert.strictEqual(q.renameTo, 'a(1).txt'); assert.strictEqual(q.canReplace, true);
  });
  await t('an existing folder reports how many items are inside it', async () => {
    const ask = asker([{ choice: 'skip' }]);
    await planPlacement({ items: [item('n', 'src', 'folder')], existing: [folder('f', 'src'), file('a', 'a.js', 'f'), file('b', 'b.js', 'f')], parentId: 'root', ask });
    assert.strictEqual(ask.asked[0].existing.count, 2);
  });

  console.log('apply to all');
  await t('"apply to all" answers every later clash without asking again', async () => {
    const ask = asker([{ choice: 'replace', applyToAll: true }]);
    const existing = [file('x', 'a.txt'), file('y', 'b.txt'), file('z', 'c.txt')];
    const plan = await planPlacement({ items: [item('1', 'a.txt'), item('2', 'b.txt'), item('3', 'c.txt')], existing, parentId: 'root', ask });
    assert.strictEqual(ask.asked.length, 1); assert.deepStrictEqual(names(plan), ['replace:a.txt', 'replace:b.txt', 'replace:c.txt']);
  });
  await t('it only covers clashes: free names are still placed normally in between', async () => {
    const ask = asker([{ choice: 'skip', applyToAll: true }]);
    const plan = await planPlacement({ items: [item('1', 'a.txt'), item('2', 'new.txt'), item('3', 'c.txt')], existing: [file('x', 'a.txt'), file('z', 'c.txt')], parentId: 'root', ask });
    assert.deepStrictEqual(names(plan), ['skip:a.txt', 'place:new.txt', 'skip:c.txt']); assert.strictEqual(ask.asked.length, 1);
  });
  await t('without the box, every clash is asked on its own', async () => {
    const ask = asker([{ choice: 'replace' }, { choice: 'skip' }, { choice: 'rename' }]);
    const plan = await planPlacement({ items: [item('1', 'a.txt'), item('2', 'b.txt'), item('3', 'c.txt')], existing: [file('x', 'a.txt'), file('y', 'b.txt'), file('z', 'c.txt')], parentId: 'root', ask });
    assert.strictEqual(ask.asked.length, 3); assert.deepStrictEqual(names(plan), ['replace:a.txt', 'skip:b.txt', 'rename:c(1).txt']);
  });
  await t('a remembered Replace is not applied to something that cannot be replaced: that one is asked again', async () => {
    const existing = [file('x', 'a.txt'), file('y', 'b.txt', 'root', { isLocked: true })];
    const ask = asker([{ choice: 'replace', applyToAll: true }, { choice: 'skip' }]);
    const plan = await planPlacement({ items: [item('1', 'a.txt'), item('2', 'b.txt')], existing, parentId: 'root', ask });
    assert.strictEqual(ask.asked.length, 2); assert.strictEqual(ask.asked[1].canReplace, false); assert.deepStrictEqual(names(plan), ['replace:a.txt', 'skip:b.txt']);
  });

  console.log('what can never be replaced');
  await t('a locked item', async () => {
    const ask = asker([{ choice: 'replace' }]);
    const plan = await planPlacement({ items: [item('a', 'a.txt')], existing: [file('x', 'a.txt', 'root', { isLocked: true })], parentId: 'root', ask });
    assert.strictEqual(ask.asked[0].canReplace, false); assert.strictEqual(ask.asked[0].blockedReason, 'locked');
    assert.deepStrictEqual(names(plan), ['rename:a(1).txt'], 'a Replace answer that is not allowed falls back to keeping both');
  });
  await t('a folder with a locked file somewhere inside it', async () => {
    const existing = [folder('f', 'src'), folder('g', 'deep', 'f'), file('l', 'secret.txt', 'g', { isLocked: true })];
    const ask = asker([{ choice: 'skip' }]);
    await planPlacement({ items: [item('n', 'src', 'folder')], existing, parentId: 'root', ask });
    assert.strictEqual(ask.asked[0].canReplace, false);
  });
  await t('something that holds the very items being moved or copied (a folder named like its own child)', async () => {
    const existing = [folder('P', 'P'), folder('c', 'P', 'P')];
    const ask = asker([{ choice: 'replace' }]);
    await planPlacement({ items: [item('c', 'P', 'folder')], existing, parentId: 'root', ask, protectIds: ['c'] });
    assert.strictEqual(ask.asked[0].canReplace, false); assert.strictEqual(ask.asked[0].blockedReason, 'source');
  });
  await t('a name taken by an earlier item of the same batch (only Skip or Rename)', async () => {
    const ask = asker([{ choice: 'replace' }]);
    const plan = await planPlacement({ items: [item('1', 'a.txt'), item('2', 'a.txt')], existing: [], parentId: 'root', ask });
    assert.strictEqual(ask.asked[0].canReplace, false); assert.strictEqual(ask.asked[0].blockedReason, 'batch'); assert.deepStrictEqual(names(plan), ['place:a.txt', 'rename:a(1).txt']);
  });

  console.log('moves and copies in the same place');
  await t('moving an item within its own folder is not a clash with itself (ignoreIds)', async () => {
    const ask = asker([{ choice: 'stop' }]);
    const plan = await planPlacement({ items: [item('a', 'a.txt')], existing: [file('a', 'a.txt')], parentId: 'root', ignoreIds: ['a'], ask });
    assert.strictEqual(ask.asked.length, 0); assert.deepStrictEqual(names(plan), ['place:a.txt']);
  });
  await t('copying into the folder it came from just numbers the copy, without a question', async () => {
    const ask = asker([{ choice: 'stop' }]);
    const plan = await planPlacement({ items: [item('a', 'a.txt')], existing: [file('a', 'a.txt')], parentId: 'root', ask });
    assert.strictEqual(ask.asked.length, 0); assert.deepStrictEqual(names(plan), ['rename:a(1).txt']);
  });
  await t('a replaced name is free for later items, and a skipped one does not take a name', async () => {
    const plan = await planPlacement({ items: [item('1', 'a.txt'), item('2', 'b.txt')], existing: [file('x', 'a.txt')], parentId: 'root', ask: asker([{ choice: 'skip' }]) });
    assert.deepStrictEqual(names(plan), ['skip:a.txt', 'place:b.txt']);
  });
  await t('the destination is only the given folder: clashes deeper down are not touched', async () => {
    const existing = [folder('f', 'f'), file('x', 'a.txt', 'f')];
    const ask = asker([{ choice: 'stop' }]);
    await planPlacement({ items: [item('a', 'a.txt')], existing, parentId: 'root', ask });
    assert.strictEqual(ask.asked.length, 0);
  });
  await t('records with no parentId count as being in the root', async () => {
    const ask = asker([{ choice: 'skip' }]);
    await planPlacement({ items: [item('a', 'a.txt')], existing: [{ id: 'x', name: 'a.txt', type: 'file' }], parentId: undefined, ask });
    assert.strictEqual(ask.asked.length, 1);
  });
  await t('an item can carry its own destination folder (a restore puts each item back where it came from)', async () => {
    const existing = [folder('f', 'f'), file('x', 'a.txt', 'f'), file('y', 'a.txt')];
    const ask = asker([{ choice: 'skip' }]);
    const plan = await planPlacement({ items: [item('1', 'a.txt', 'file', { destParentId: 'f' }), item('2', 'b.txt', 'file', { destParentId: 'f' }), item('3', 'a.txt', 'file', { destParentId: 'g' })], existing, parentId: 'root', ask });
    assert.deepStrictEqual(names(plan), ['skip:a.txt', 'place:b.txt', 'place:a.txt']); assert.strictEqual(ask.asked.length, 1);
  });
  await t('descendantsOf finds children at every depth and tolerates a cycle', () => {
    const list = [folder('a', 'a'), folder('b', 'b', 'a'), file('c', 'c', 'b'), folder('loop', 'l', 'loop')];
    assert.deepStrictEqual(descendantsOf(list, 'a').map((r) => r.id).sort(), ['b', 'c']);
    assert.ok(descendantsOf(list, 'loop').length <= 1);
  });

  console.log(`\n${n} name-conflicts checks passed`);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
