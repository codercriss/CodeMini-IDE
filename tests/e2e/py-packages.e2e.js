// Python packages in the real Console, the editor's bottom Console and the Terminal, in a real browser with two origins (app :8765, runner :8766):
// !pip install, auto-install and the pip command, on the runner's host (Isolated) and in the page's own Pyodide (Same origin).
// Pyodide comes from a CDN the sandbox cannot reach, so a small stand-in is served instead. It answers the package step the way the real program
// does (the real program is run on a real Pyodide by tests/real-pyodide.manual.js), so this suite checks the PLUMBING in the page: that each surface
// sends the step first, runs the prepared code after it, shows the lines (escaped), skips the step when there is nothing to do, and honours the settings.
const path = require('path');
const { chromium } = require('playwright');
const { createServer } = require('./lib/static-server');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x).slice(0, 360) : '')); };
const APP = 'http://localhost:8765', RUNNER = 'http://localhost:8766';
const CORS = { 'access-control-allow-origin': '*' };

// The stand-in Pyodide. Served for the app page (Same origin mode) and for the runner's host frame (Isolated). window.__py is the engine, so a test can read
// what it was asked to run (py.__codes) and the package steps it was handed (py.__pkg, the decoded payloads).
const FAKE = '(' + function () {
  window.loadPyodide = async function () {
    let out = '', err = '';
    const dict = () => ({ set(k, v) { this['_' + k] = v; } });
    const py = {
      async loadPackage() {}, async loadPackagesFromImports() {}, registerJsModule() {}, pyimport() { return {}; },
      globals: { set(k, v) { py['g_' + k] = v; }, get(k) { return k === 'dict' ? dict : py['g_' + k]; } },
      runPython(code) {
        if (/_cm_stdout = io\.StringIO/.test(code) || /sys\.stdout = io\.StringIO\(\)/.test(code)) { out = ''; err = ''; return; }
        if (code === '_cm_stdout.getvalue()' || code === 'sys.stdout.getvalue()') return out;
        if (code === '_cm_stderr.getvalue()' || code === 'sys.stderr.getvalue()') return err;
      },
      async runPythonAsync(code) {
        (py.__codes = py.__codes || []).push(code);
        if (/^import os/.test(code)) return;                                   // the host's own start-up program
        if (code.indexOf('get_fignums') > -1) return { toJs: () => [], destroy() {} };
        if (code.indexOf('import json, sys, types, builtins') > -1) return '[]';
        if (code.indexOf('_cm_pkg_main') > -1) {                                // the package step: answer it like the real program would
          const head = '_cm_pkg_res = await _cm_pkg_main(';
          const line = code.split('\n').find((l) => l.indexOf(head) === 0);
          const payload = JSON.parse(JSON.parse(line.slice(head.length, -1)));
          (py.__pkg = py.__pkg || []).push(payload);
          const log = [], installed = [], failed = [];
          (payload.ops || []).forEach((op) => {
            if (op.op === 'install') {
              if (op.pkgs.some((p) => p === 'hostilereply')) { log.push(['out', '<img src=x onerror=window.__pwn=5>']); log.push(['ok', '</pre><script>window.__pwn=5</script>']); }
              else if (op.pkgs.some((p) => /^nopkg/.test(p))) failed.push(['op', 'install', op.pkgs.join(', '), 'Unsupported content type: text/plain; charset=utf-8']);
              else { installed.push.apply(installed, op.pkgs); log.push(['ok', 'Successfully installed ' + op.pkgs.join(', ')]); }
            } else if (op.op === 'list') { log.push(['out', 'Package  Version']); log.push(['out', 'zzpkg    1.0']); }
            else if (op.op === 'freeze') log.push(['out', 'zzpkg==1.0']);
          });
          if (payload.auto) {
            const names = []; payload.auto.code.replace(/^\s*import\s+([A-Za-z_]\w*)/gm, (m, n) => { names.push(n); });
            names.filter((n) => ['os', 'sys', 'json'].indexOf(n) < 0 && payload.auto.skip.indexOf(n) < 0).forEach((n) => {
              if (/^bad/.test(n)) failed.push(['auto', n, n, "Can't find a pure Python 3 wheel for '" + n + "'."]);
              else { installed.push(n); log.push(['auto', n]); }
            });
          }
          return JSON.stringify({ log, installed, failed });
        }
        const m = code.match(/(?:^|[\n;]\s*)print\((.*)\)\s*$/);              // the program's last statement, if it is a print
        if (m) { out += String(eval(m[1])) + '\n'; return undefined; }
        return undefined;
      }
    };
    window.__py = py;
    return py;
  };
}.toString() + ')();';

async function open(browser, extraLs) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(([runnerUrl, extraLs]) => {
    if (location.port === '8765') { localStorage.setItem('codemini_runner_url', runnerUrl); Object.keys(extraLs || {}).forEach(k => localStorage.setItem(k, extraLs[k])); }
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); }; window.require.config = () => {};
  }, [RUNNER, extraLs || {}]);
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.route('https://cdn.jsdelivr.net/pyodide/v0.24.1/full/pyodide.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', headers: CORS, body: FAKE }));
  await page.goto(APP + '/index.html'); await sleep(3500);
  return { ctx, page, errors };
}
async function openConsole(page, language) {
  await page.evaluate((l) => window.openLanguageConsole(l), language); await sleep(900);
  return async (cmd, wait) => {
    await page.evaluate((cmd) => { const i = [...document.querySelectorAll('.console-input')].pop(); i.value = cmd; [...document.querySelectorAll('.run-btn')].pop().click(); }, cmd);
    await sleep(wait || 1800);
    return page.evaluate(() => [...document.querySelectorAll('.console-output')].pop().innerText);
  };
}
const lastBlock = (t) => String(t).split(/In \[\d+\]:/).pop();      // the newest command's part of the Console's running output
const hostFrame = (page) => page.frames().filter(f => /\/exec\.html/.test(f.url()))[0];
// what the engine was asked to run, and the package steps it was handed, in the host frame or (frame = null) in the app page
const codesOf = (page, frame) => (frame || page).evaluate(() => (window.__py && window.__py.__codes) || []);
const stepsOf = (page, frame) => (frame || page).evaluate(() => (window.__py && window.__py.__pkg) || []);
const isStep = (c) => c.indexOf('_cm_pkg_main') > -1;

(async () => {
  const runnerServer = createServer(require('../lib/paths').runnerDir(), { headers: { 'Content-Security-Policy': "frame-ancestors 'self' http://localhost:8765 http://127.0.0.1:8765" } });
  await new Promise(r => runnerServer.listen(8766, r));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  let o;

  console.log('\n[Console, Python, Isolated: the package step runs on the host, before the code]');
  {
    const { ctx, page, errors } = await open(browser);
    const run = await openConsole(page, 'Python');
    o = await run('!pip install zzpkg\nprint(1+1)', 3000);
    ok(/Successfully installed zzpkg/.test(o) && /(^|\n)2(\n|$)/.test(o), '!pip install shows its result and the code after it still runs', o);
    let f = hostFrame(page), codes = await codesOf(page, f);
    const i = codes.findIndex(isStep);
    ok(f && f.url().startsWith(RUNNER + '/exec.html') && i > -1 && codes.slice(i + 1).includes('pass\nprint(1+1)'), 'the host got the package step first, then the prepared code (the pip line is now `pass`)', codes.map(c => c.slice(0, 40)));
    ok(!(await codesOf(page, null)).some(isStep), 'and the page\'s own Pyodide was never asked (Isolation is on)');
    const before = (await stepsOf(page, f)).length;
    o = await run('print(2+3)', 1500);
    ok(/5/.test(o) && (await stepsOf(page, f)).length === before, 'a plain command makes no package round trip', o);
    o = await run('import zzauto\nprint(3)', 3000);
    ok(/Auto-installed: zzauto/.test(o) && /(^|\n)3(\n|$)/.test(o), 'auto-install: what the code imports is installed, then it runs', o);
    const steps = await stepsOf(page, f);
    ok(steps.length && steps[steps.length - 1].auto && steps[steps.length - 1].auto.code === 'import zzauto\nprint(3)' && steps[steps.length - 1].auto.never.includes('micropip'), 'the step carried the code to read and the never-list');
    o = await run('import badmod\nprint(4)', 3000);
    ok(/Could not auto-install badmod: no pure-Python wheel/.test(o) && /(^|\n)4(\n|$)/.test(o), 'a module that cannot be installed is one note, and the code still runs', o);
    o = await run('!pip install nopkg1', 3000);
    ok(/ERROR: Could not install nopkg1: not found on PyPI/.test(o), 'a failed install is an error in plain words (not micropip\'s raw message)', o);
    o = await run('!pip install -r requirements.txt', 2000);
    ok(/requirements file\) is not supported/.test(o) && /Nothing to install/.test(o), 'what cannot be done is said, not half done', o);
    o = await run('!pip install "<img src=x onerror=window.__pwn=1>"', 2500);
    ok(await page.evaluate(() => !window.__pwn && document.querySelectorAll('.console-output img[src="x"]').length === 0), 'a hostile package name is escaped: no HTML is injected into the app', o);
    o = await run('%time print(6)', 2500);
    ok(/CPU Time/.test(o) && (await codesOf(page, f)).includes('print(6)'), '%time still times the run (and is not sent to Python)', o);
    await page.evaluate(() => window.saveSetting('consoleAutoInstall', false));
    const n = (await stepsOf(page, f)).length;
    o = await run('import zzoff\nprint(7)', 2500);
    ok(/(^|\n)7(\n|$)/.test(lastBlock(o)) && !/Auto-installed/.test(lastBlock(o)) && (await stepsOf(page, f)).length === n, 'with the Console\'s Auto-Install off, no step is sent', lastBlock(o));
    o = await run('!pip install zzstill', 3000);
    ok(/Successfully installed zzstill/.test(lastBlock(o)), 'but a !pip line always works, whatever the setting says', lastBlock(o));
    ok(errors.filter(e => !/monaco|pyodide|Failed to fetch|net::|require is not defined/i.test(e)).length === 0, 'no script errors', errors);
    await ctx.close();
  }

  console.log('\n[Console, Python, Same origin: the same, in the page\'s own Pyodide]');
  {
    const { ctx, page } = await open(browser);
    await page.evaluate(() => window.saveSetting('isolationConsole', 'Normal'));
    const run = await openConsole(page, 'Python');
    o = await run('!pip install zzpkg\nprint(1+1)', 3500);
    const codes = await codesOf(page, null), i = codes.findIndex(isStep);
    ok(/Successfully installed zzpkg/.test(o), 'the result of !pip install is shown', o);
    ok(i > -1 && codes.slice(i + 1).includes('pass\nprint(1+1)'), 'the page\'s Pyodide got the package step, then the prepared code', codes.map(c => c.slice(0, 40)));
    ok(!hostFrame(page), 'and no host frame was used');
    o = await run('import zzauto\nprint(3)', 3000);
    ok(/Auto-installed: zzauto/.test(o), 'auto-install works here too', o);
    await ctx.close();
  }

  console.log('\n[the Terminal: pip, pip3, python -m pip, python -c and python file.py]');
  {
    const { ctx, page } = await open(browser);
    const jsConsole = await openConsole(page, 'JavaScript'); await jsConsole('1');
    await page.evaluate(() => document.getElementById('terminalIconItem').click()); await sleep(1500);
    const TERM = '[data-term-index]';
    const termText = () => page.evaluate((T) => [...document.querySelectorAll(T + ' .term-output')].pop().innerText, TERM);
    const term = async (cmd, wait) => {
      const before = (await termText()).length;
      await page.evaluate(([cmd, T]) => { const i = [...document.querySelectorAll(T + ' .term-input')].pop(); i.value = cmd; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }, [cmd, TERM]);
      await sleep(wait || 2500);
      const delta = (await termText()).slice(before), at = delta.indexOf('$ ' + cmd);
      return at < 0 ? null : delta.slice(at + 2 + cmd.length).trim();
    };
    const has = (s, re) => s !== null && re.test(s);
    o = await term('pip install zzterm'); ok(has(o, /Installing packages: zzterm/) && has(o, /Successfully installed zzterm/), 'pip install prints its progress and its result', o);
    o = await term('pip3 list'); ok(has(o, /Package\s+Version/) && has(o, /zzpkg\s+1\.0/), 'pip3 list prints the table, spacing kept', o);
    o = await term('pip freeze'); ok(has(o, /zzpkg==1\.0/), 'pip freeze prints name==version', o);
    o = await term('python -m pip install zzterm2'); ok(has(o, /Successfully installed zzterm2/), 'python -m pip is the same command', o);
    o = await term('pip'); ok(has(o, /Usage: pip install/), 'pip alone says how to use it', o);
    o = await term('pip install nopkg2'); ok(has(o, /ERROR: Could not install nopkg2: not found on PyPI/), 'a failed install is an error line', o);
    o = await term('pip install hostilereply');
    ok(await page.evaluate((T) => !window.__pwn && document.querySelectorAll(T + ' .term-output img[src="x"], ' + T + ' .term-output script').length === 0, TERM) && has(o, /<img src=x onerror=window\.__pwn=5>/), 'a hostile reply is shown as text in the Terminal, never as markup', o);
    const f = hostFrame(page);
    ok(f && (await stepsOf(page, f)).length >= 4, 'it all went to the runner\'s host');
    o = await term("python -c 'import zzauto2; print(7)'"); ok(has(o, /Auto-installed: zzauto2/), 'python -c installs what it imports', o);
    await page.evaluate(async () => {
      const put = (r) => new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put(r); tx.oncomplete = res; });
      await put({ id: 'app-py', parentId: 'root', name: 'app.py', type: 'file', content: 'import zzauto3\nimport mine\nprint(8)', timestamp: Date.now() });
      await put({ id: 'mine-py', parentId: 'root', name: 'mine.py', type: 'file', content: 'X = 1', timestamp: Date.now() });
      loadFilesFromDB();
    }); await sleep(600);
    await term('chmod +x app.py');
    o = await term('./app.py', 3500);
    ok(has(o, /Auto-installed: zzauto3/) && has(o, /(^|\n)8(\n|$)/) && !has(o, /Auto-installed:[^\n]*mine/), 'a script file installs what it imports and then runs, but never the person\'s own module next to it', o);
    const last = (await stepsOf(page, f)).pop();
    ok(last && last.auto && last.auto.skip.includes('mine'), 'the step was told which modules are the person\'s own', last && last.auto && last.auto.skip);
    await page.evaluate(() => window.saveSetting('terminalAutoInstall', false));
    const n = (await stepsOf(page, f)).length;
    o = await term('./app.py', 3000);
    ok(has(o, /(^|\n)8(\n|$)/) && !has(o, /Auto-installed/) && (await stepsOf(page, f)).length === n, 'with the Terminal\'s Auto-Install off, a script runs without a step', o);
    o = await term('pip install zzstill2'); ok(has(o, /Successfully installed zzstill2/), 'but pip still works', o);
    await ctx.close();
  }

  console.log('\n[the editor\'s bottom Console]');
  {
    const { ctx, page } = await open(browser);
    const bpAll = () => page.evaluate(() => document.getElementById('bpConsoleOutput').innerText);
    const bpRun = async (code, ext, wait) => { await page.evaluate(([c, e]) => { window.runInBottomConsole(c, e); }, [code, ext]); await sleep(wait || 3000); };
    await bpRun('!pip install zzbp\nprint(9)', 'py');
    let t = await bpAll();
    ok(/Installing packages: zzbp/.test(t) && /Successfully installed zzbp/.test(t) && /(^|\n)9(\n|$)/.test(t), 'a Python run shows the install, then its own output', t);
    const f = hostFrame(page), codes = await codesOf(page, f), i = codes.findIndex(isStep);
    ok(f && i > -1 && codes.slice(i + 1).includes('pass\nprint(9)'), 'on the host: the step first, then the prepared code');
    await bpRun('import zzauto4\nprint(10)', 'py');
    t = await bpAll(); ok(/Auto-installed: zzauto4/.test(t), 'auto-install', t);
    const n = (await stepsOf(page, f)).length;
    await bpRun('console.log(11)', 'js', 2000);
    ok((await stepsOf(page, f)).length === n, 'JavaScript makes no package step');
    await bpRun('%time print(12)', 'py'); t = await bpAll(); ok(/Wall time: \d/.test(t), '%time adds the wall time', t);
    await page.evaluate(() => window.saveSetting('editorAutoInstall', false));
    const m = (await stepsOf(page, f)).length;
    await bpRun('import zzoff2\nprint(13)', 'py'); t = await bpAll();
    ok(/(^|\n)13(\n|$)/.test(t) && !/Auto-installed: zzoff2/.test(t) && (await stepsOf(page, f)).length === m, 'with Settings > Editor > Auto-Install off, no step is sent');
    await bpRun('!pip install zzstill3\nprint(14)', 'py'); t = await bpAll(); ok(/Successfully installed zzstill3/.test(t), 'but a !pip line still works', t);
    await ctx.close();
  }
  {
    // Same origin: the page's own Pyodide
    const { ctx, page } = await open(browser);
    await page.evaluate(() => window.saveSetting('isolationConsole', 'Normal'));
    await page.evaluate(() => { window.runInBottomConsole('!pip install zzbp5\nprint(15)', 'py'); }); await sleep(3500);
    const t = await page.evaluate(() => document.getElementById('bpConsoleOutput').innerText);
    const codes = await codesOf(page, null), i = codes.findIndex(isStep);
    ok(/Successfully installed zzbp5/.test(t) && i > -1 && codes.slice(i + 1).includes('pass\nprint(15)') && !hostFrame(page), 'Same origin: the page\'s Pyodide gets the step, then the prepared code', t);
    await ctx.close();
  }

  await browser.close(); runnerServer.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
