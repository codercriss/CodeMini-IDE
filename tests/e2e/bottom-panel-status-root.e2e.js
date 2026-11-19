// Three small fixes, checked in a real browser:
//   1. the bottom panel's tabs (Problems / Console / Debug Console / Tasks) scroll sideways instead of wrapping;
//   2. on a phone the status bar cuts a long tab name with an ellipsis instead of pushing the right-hand items off the screen (desktop is unchanged);
//   3. Move to Root / Copy to Root with a folder AND its contents selected (what Tree View's multi-select produces) keeps the folder's structure.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const boot = async (browser, viewport) => {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); }; window.require.config = () => {};
  });
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.goto('http://localhost:8765/index.html'); await sleep(5200);
  return { ctx, page, errors };
};

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  console.log('\n[the bottom panel\'s tabs scroll sideways instead of wrapping]');
  {
    const { ctx, page, errors } = await boot(browser, { width: 1280, height: 800 });
    const ev = (f, a) => page.evaluate(f, a);
    await ev(() => { document.getElementById('problemsPanel').style.display = 'flex'; });
    const geo = () => ev(() => {
      const bar = document.querySelector('.bottom-panel-tabs'), tabs = [...bar.querySelectorAll('.bottom-panel-tab')], r = (e) => e.getBoundingClientRect();
      const panel = document.getElementById('problemsPanel'), actions = document.querySelector('.bottom-panel-actions'), header = document.querySelector('.bottom-panel-header');
      return { overflows: bar.scrollWidth > bar.clientWidth, scrollLeft: Math.round(bar.scrollLeft), tabTops: tabs.map(t => Math.round(r(t).top)), tabHeights: tabs.map(t => Math.round(r(t).height)),
        headerH: Math.round(r(header).height), actionsInside: r(actions).right <= r(panel).right + 1 && r(actions).left >= r(panel).left - 1, actionsW: Math.round(r(actions).width),
        names: tabs.map(t => t.textContent.trim()), n: tabs.length };
    });
    const style = await ev(() => { const b = document.querySelector('.bottom-panel-tabs'), t = document.querySelector('.bottom-panel-tab'); const cb = getComputedStyle(b), ct = getComputedStyle(t);
      return { ox: cb.overflowX, oy: cb.overflowY, wrap: cb.flexWrap, ws: ct.whiteSpace, shrink: ct.flexShrink, grow: ct.flexGrow }; });
    ok(style.ox === 'auto' && style.oy === 'hidden' && style.wrap === 'nowrap', 'the tab row scrolls sideways, never wraps', style);
    ok(style.ws === 'nowrap' && style.shrink === '0', 'a tab keeps its size and its label on one line', style);
    const wide = await geo();
    ok(wide.n === 4 && wide.names.join('|') === 'Problems|Console|Debug Console|Tasks', 'the four tabs', wide.names);
    ok(!wide.overflows && wide.scrollLeft === 0, 'with room, nothing scrolls', wide);
    // a wheel over a row that does not overflow is left alone (the page can scroll)
    const wheelWide = await ev(() => { const bar = document.querySelector('.bottom-panel-tabs'); const e = new WheelEvent('wheel', { deltaY: 60, cancelable: true, bubbles: true }); bar.dispatchEvent(e); return e.defaultPrevented; });
    ok(wheelWide === false, 'a mouse wheel over a row with room is not taken');

    // not enough room: the panel is only 170px wide
    await ev(() => { const p = document.getElementById('problemsPanel'); p.style.width = '170px'; p.style.maxWidth = '170px'; p.style.flex = '0 0 170px'; });
    await sleep(150);
    const narrow = await geo();
    ok(narrow.overflows, 'with little room the row overflows (and scrolls)', narrow);
    ok(new Set(narrow.tabTops).size === 1 && narrow.tabHeights.every(h => h === narrow.tabHeights[0]), 'every tab is still on one line (nothing wrapped)', narrow);
    ok(narrow.headerH === wide.headerH, 'so the header is no taller than before', [wide.headerH, narrow.headerH]);
    ok(narrow.actionsInside && narrow.actionsW === wide.actionsW, 'the panel\'s own buttons keep their size and stay in view', narrow);
    // choosing the last tab scrolls it into view
    await ev(() => document.querySelector('.bottom-panel-tab[data-target="tasksPanelContent"]').click()); await sleep(250);
    const last = await ev(() => { const b = document.querySelector('.bottom-panel-tabs'), t = document.querySelector('.bottom-panel-tab[data-target="tasksPanelContent"]'), rb = b.getBoundingClientRect(), rt = t.getBoundingClientRect();
      return { active: t.classList.contains('active'), visible: rt.left >= rb.left - 1 && rt.right <= rb.right + 1, scrollLeft: Math.round(b.scrollLeft) }; });
    ok(last.active && last.visible && last.scrollLeft > 0, 'choosing the last tab makes it active and scrolls it into view', last);
    await ev(() => document.querySelector('.bottom-panel-tab[data-target="problemsPanelContent"]').click()); await sleep(250);
    const first = await ev(() => { const b = document.querySelector('.bottom-panel-tabs'), t = document.querySelector('.bottom-panel-tab[data-target="problemsPanelContent"]'), rb = b.getBoundingClientRect(), rt = t.getBoundingClientRect();
      return { visible: rt.left >= rb.left - 1, scrollLeft: Math.round(b.scrollLeft) }; });
    ok(first.visible && first.scrollLeft === 0, 'and choosing the first brings it back', first);
    // the wheel scrolls an overflowing row sideways
    const wheel = await ev(() => { const b = document.querySelector('.bottom-panel-tabs'); b.scrollLeft = 0; const e = new WheelEvent('wheel', { deltaY: 40, cancelable: true, bubbles: true }); b.dispatchEvent(e); return { prevented: e.defaultPrevented, scrollLeft: Math.round(b.scrollLeft) }; });
    ok(wheel.prevented && wheel.scrollLeft > 0, 'a mouse wheel over an overflowing row scrolls it sideways', wheel);
    ok(errors.length === 0, 'no script errors', errors);
    await ctx.close();
  }

  console.log('\n[the status bar on a phone cuts a long tab name; the desktop is unchanged]');
  {
    const LONG = 'a-very-long-name-for-a-file-that-keeps-going-and-going-and-going-until-it-cannot-fit-on-a-phone.component.test.spec.js';
    const probe = (long) => `(() => { const s = document.getElementById('activeFileStatus'); s.textContent = ${long ? JSON.stringify(LONG) : "'x.js'"};
      const bar = document.querySelector('.status-bar'), left = document.querySelector('.status-left'), right = document.querySelector('.status-right'), r = (e) => e.getBoundingClientRect(), cs = getComputedStyle(s);
      const icons = [...left.querySelectorAll('.status-item')].slice(0, -1).map(e => Math.round(r(e).width));
      return { ellipsis: cs.textOverflow, overflow: cs.overflowX, ws: cs.whiteSpace, nameClipped: s.scrollWidth > s.clientWidth, nameW: Math.round(r(s).width), vw: window.innerWidth,
        barFits: bar.scrollWidth <= bar.clientWidth + 1, rightInside: r(right).right <= window.innerWidth + 1, rightW: Math.round(r(right).width), icons, rightLeft: Math.round(r(right).left) }; })()`;
    const phone = await boot(browser, { width: 390, height: 844 });
    const short = await phone.page.evaluate(probe(false));
    const long = await phone.page.evaluate(probe(true));
    ok(short.vw <= 768, 'this is a phone-sized window', short.vw);
    ok(long.ellipsis === 'ellipsis' && long.overflow === 'hidden' && long.ws === 'nowrap', 'the name is cut with an ellipsis, on one line', long);
    ok(long.nameClipped && long.nameW < 390, 'a long name is clipped (not wider than the screen)', long);
    ok(long.barFits && long.rightInside, 'the status bar does not overflow and the right-hand items stay on screen', long);
    ok(long.rightW === short.rightW, 'the right-hand group keeps its size', [short.rightW, long.rightW]);
    ok(JSON.stringify(long.icons) === JSON.stringify(short.icons), 'the icons on the left keep their size (only the name gives way)', [short.icons, long.icons]);
    ok(!short.nameClipped, 'a short name is not clipped', short);
    ok(phone.errors.length === 0, 'no script errors', phone.errors);
    await phone.ctx.close();

    const desk = await boot(browser, { width: 1280, height: 800 });
    const d = await desk.page.evaluate(probe(true));
    ok(d.ellipsis !== 'ellipsis', 'on a desktop the rule is not applied', d);
    await desk.ctx.close();
  }

  console.log('\n[Move to Root / Copy to Root keep a folder\'s structure when its contents are selected too (Tree View)]');
  {
    const { ctx, page, errors } = await boot(browser, { width: 1280, height: 800 });
    const ev = (f, a) => page.evaluate(f, a);
    // outer/ dirA/ { sub/ { f1.txt }, f2.txt }   (dirA is not at the root, so "Move to Root" is on offer)
    await ev(async () => {
      const recs = [
        { id: 'outer', parentId: 'root', name: 'outer', type: 'folder' }, { id: 'dirA', parentId: 'outer', name: 'dirA', type: 'folder' },
        { id: 'sub', parentId: 'dirA', name: 'sub', type: 'folder' }, { id: 'f1', parentId: 'sub', name: 'f1.txt', type: 'file', content: 'one' },
        { id: 'f2', parentId: 'dirA', name: 'f2.txt', type: 'file', content: 'two' }, { id: 'keep', parentId: 'root', name: 'keep.txt', type: 'file', content: 'k' }];
      for (const r of recs) await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put(Object.assign({ timestamp: Date.now() }, r)); tx.oncomplete = res; });
    });
    const all = () => ev(() => new Promise(res => { db.transaction('filesystem', 'readonly').objectStore('filesystem').getAll().onsuccess = e => res(e.target.result); }));
    const byId = (rs) => Object.fromEntries(rs.map(r => [r.id, r]));
    // exactly what Tree View's multi-select hands over after ticking the folder: the folder and everything inside it
    const targets = ['dirA', 'sub', 'f1', 'f2'];
    const pick = () => ev((ids) => new Promise(res => { db.transaction('filesystem', 'readonly').objectStore('filesystem').getAll().onsuccess = e => res(e.target.result.filter(r => ids.includes(r.id))); }), targets);

    const before = (await all()).length;
    await ev(async (t) => { const recs = await new Promise(res => { db.transaction('filesystem', 'readonly').objectStore('filesystem').getAll().onsuccess = e => res(e.target.result.filter(r => t.includes(r.id))); });
      await transferToExternalDBDeep(recs, db.name, 'move', 'root', undefined, 'the root'); }, targets);
    await sleep(600);
    const m = byId(await all());
    ok(m.dirA && m.dirA.parentId === 'root', 'Move to Root: the folder is at the root', m.dirA && m.dirA.parentId);
    ok(m.sub && m.sub.parentId === 'dirA' && m.f2 && m.f2.parentId === 'dirA', 'its contents are still inside it (not pulled out to the root)', [m.sub && m.sub.parentId, m.f2 && m.f2.parentId]);
    ok(m.f1 && m.f1.parentId === 'sub' && m.f1.content === 'one', 'and the nested file is still inside its sub-folder, with its content', m.f1);
    ok((await all()).length === before, 'nothing was duplicated or lost', [before, (await all()).length]);
    ok(m.outer && m.outer.parentId === 'root' && m.keep && m.keep.parentId === 'root', 'unrelated items are untouched');

    // Copy to Root from a nested place: put the folder back under "outer" first, then copy it
    await ev(async () => { await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); const st = tx.objectStore('filesystem'); st.get('dirA').onsuccess = e => { const r = e.target.result; r.parentId = 'outer'; st.put(r); }; tx.oncomplete = res; }); });
    const rootKids = async () => (await all()).filter(r => r.parentId === 'root').length;
    const rootBefore = await rootKids(), totalBefore = (await all()).length;
    await ev(async (t) => { const recs = await new Promise(res => { db.transaction('filesystem', 'readonly').objectStore('filesystem').getAll().onsuccess = e => res(e.target.result.filter(r => t.includes(r.id))); });
      await transferToExternalDBDeep(recs, db.name, 'copy', 'root', undefined, 'the root'); }, targets);
    await sleep(600);
    const after = await all();
    ok(after.length === totalBefore + 4, 'Copy to Root: four new items (the folder, its sub-folder and two files), not more', [totalBefore, after.length]);
    ok((await rootKids()) === rootBefore + 1, 'only the folder itself lands at the root', [rootBefore, await rootKids()]);
    const origIds = new Set(['outer', 'dirA', 'sub', 'f1', 'f2', 'keep']);
    const fresh = after.filter(r => !origIds.has(r.id));
    const top = fresh.filter(r => r.parentId === 'root');
    ok(top.length === 1 && top[0].type === 'folder', 'the one new top-level item is the copied folder', top.map(r => r.name));
    const kidsOf = (id) => fresh.filter(r => r.parentId === id).map(r => r.name).sort();
    const copiedSub = fresh.find(r => r.name === 'sub');
    ok(JSON.stringify(kidsOf(top[0].id)) === JSON.stringify(['f2.txt', 'sub']) && copiedSub && JSON.stringify(kidsOf(copiedSub.id)) === JSON.stringify(['f1.txt']), 'the copy has the same shape: sub/f1.txt and f2.txt', kidsOf(top[0].id));
    ok(m.f1.content === 'one' && fresh.find(r => r.name === 'f1.txt').content === 'one', 'with the contents');
    ok(errors.length === 0, 'no script errors', errors);
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
