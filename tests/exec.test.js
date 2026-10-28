// The runner's execution host (runner/exec.js) and the app's exec client, driven against fake windows. The JavaScript engine
// runs for real (in a vm); Python, PHP and Ruby need their CDN engines, so those are covered with stand-in engines in
// tests/e2e/runner-exec.e2e.js, and the real engines were not available in the sandbox this was built in.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const paths = require('./lib/paths');   // where the runner is is worked out there, once
const root = paths.ROOT;
const read = paths.read;
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };
const IDE = 'https://codemini-ide.vercel.app', RUNNER = 'https://codemini-runner.vercel.app', NONCE = 'c'.repeat(32);
const tick = () => new Promise((r) => setImmediate(r));
// Poll in real time (counting event-loop turns is not a clock: a 30 ms timer can outlast thousands of them).
const until = async (cond) => { const end = Date.now() + 4000; while (Date.now() < end && !cond()) await new Promise((r) => setTimeout(r, 2)); };

function host() {
  const handlers = [], toApp = [];
  const parent = { postMessage: (m, o) => toApp.push({ m, o }) };
  const win = { parent, addEventListener: (type, fn) => { if (type === 'message') handlers.push(fn); }, prompt: () => '' };
  const sandboxConsole = { log() {}, info() {}, warn() {}, error() {} };
  const ctx = vm.createContext({ window: win, document: { createElement() { return {}; }, head: { appendChild() {} } }, location: { origin: RUNNER, hostname: 'codemini-runner.vercel.app', ancestorOrigins: [IDE] },
    console: sandboxConsole, setTimeout, clearTimeout, JSON, Object, Array, Promise, Error, TypeError, Math, String, Number, Date, parseInt });
  vm.runInContext(read('runner/config.js'), ctx);
  vm.runInContext(read('runner/exec.js'), ctx);
  const send = (source, origin, data) => handlers.forEach((h) => h({ source, origin, data }));
  const hello = (nonce) => send(parent, IDE, { cmRunner: 1, op: 'hello', nonce: nonce || NONCE });
  let seq = 0;
  const exec = async (lang, code, opts) => {
    const id = ++seq; toApp.length = 0;
    send(parent, IDE, { cmRunner: 1, op: 'exec', id, lang, code, opts: opts || {} });
    await until(() => toApp.some((x) => x.m.op === 'exec-done' && x.m.id === id));
    const done = toApp.find((x) => x.m.op === 'exec-done' && x.m.id === id);
    const plain = (o) => (o === undefined ? o : JSON.parse(JSON.stringify(o)));   // objects made inside the vm have another prototype
    return { done: plain(done && done.m), events: plain(toApp.filter((x) => x.m.op === 'exec-out' && x.m.id === id).map((x) => x.m)) };
  };
  return { parent, win, ctx, toApp, send, hello, exec, sandboxConsole };
}

(async () => {
  console.log('the execution host: who it talks to');
  await t('announces itself only to an allowed embedder, and only an allowed origin can shake hands (once)', () => {
    const h = host(); assert.deepStrictEqual(h.toApp.map((x) => [x.m.op, x.o]), [['ready', IDE]]);
    h.toApp.length = 0;
    h.send(h.parent, 'https://evil.example', { cmRunner: 1, op: 'hello', nonce: NONCE }); assert.strictEqual(h.toApp.length, 0);
    h.send(h.win, IDE, { cmRunner: 1, op: 'hello', nonce: NONCE }); assert.strictEqual(h.toApp.length, 0, 'the code that runs inside the host cannot say hello to itself');
    h.hello('short'); assert.strictEqual(h.toApp.length, 0, 'a weak nonce is refused');
    h.hello(); assert.deepStrictEqual([h.toApp[0].m.op, h.toApp[0].m.nonce, h.toApp[0].o], ['hello-ack', NONCE, IDE]);
    h.hello('d'.repeat(32)); assert.strictEqual(h.toApp.length, 1, 'a second hello does not re-pin');
  });
  await t('runs nothing before the handshake, and nothing sent by the code itself', async () => {
    const h = host(); h.toApp.length = 0;
    h.send(h.parent, IDE, { cmRunner: 1, op: 'exec', id: 1, lang: 'javascript', code: '1', opts: {} }); await tick();
    assert.strictEqual(h.toApp.length, 0);
    h.hello(); h.toApp.length = 0;
    h.send(h.win, IDE, { cmRunner: 1, op: 'exec', id: 2, lang: 'javascript', code: '2', opts: {} }); await tick(); await tick();
    assert.strictEqual(h.toApp.length, 0, 'a message posted by code in the host is not from the app');
  });
  await t('every message it sends carries the nonce, and rejects unsupported languages, huge code and bad ids', async () => {
    const h = host(); h.hello();
    const bad = await h.exec('cobol', '1'); assert.strictEqual(bad.done.error.name, 'BadRequest'); assert.strictEqual(bad.done.nonce, NONCE);
    const big = await h.exec('javascript', 'x'.repeat(1000001)); assert.strictEqual(big.done.error.name, 'BadRequest');
    h.toApp.length = 0; h.send(h.parent, IDE, { cmRunner: 1, op: 'exec', id: 'not a number', lang: 'javascript', code: '1' });
    assert.strictEqual(h.toApp[0].m.error.name, 'BadRequest');
    const ok = await h.exec('javascript', '1'); assert.ok(ok.done.nonce === NONCE && ok.events.every((e) => e.nonce === NONCE));
  });

  console.log('JavaScript');
  await t('describes every kind of result', async () => {
    const h = host(); h.hello();
    const v = async (code) => (await h.exec('javascript', code)).done.value;
    assert.deepStrictEqual(await v('6*7'), { type: 'number', text: '42' });
    assert.deepStrictEqual(await v('true'), { type: 'number', text: 'true' });
    assert.deepStrictEqual(await v('"hi"'), { type: 'string', text: 'hi' });
    assert.deepStrictEqual(await v('({a: 1, b: [2]})'), { type: 'object', text: JSON.stringify({ a: 1, b: [2] }, null, 2) });
    assert.deepStrictEqual(await v('(function namedFn() {})'), { type: 'function', text: 'namedFn' });
    assert.deepStrictEqual(await v('null'), { type: 'text', text: 'null' });
    assert.strictEqual(await v('undefined'), null, 'undefined prints nothing');
    assert.deepStrictEqual(await v('const o = {}; o.self = o; o'), { type: 'object', text: '{\n  "self": "[Circular Reference]"\n}' }, 'a circular object is printed, not thrown');
  });
  await t('captures console output in order, with the right levels, and restores the real console afterwards', async () => {
    const h = host(); h.hello();
    const before = h.sandboxConsole.log;
    const r = await h.exec('javascript', "console.log('a', {x: 1}); console.info('i'); console.warn('w'); console.error(new Error('bad').message); 5");
    assert.deepStrictEqual(r.events.map((e) => [e.kind, e.text]), [['log', 'a {\n  "x": 1\n}'], ['info', 'i'], ['warn', 'w'], ['error', 'bad']]);
    assert.deepStrictEqual(r.done.value, { type: 'number', text: '5' });
    assert.strictEqual(h.sandboxConsole.log, before, 'console.log is the original again');
  });
  await t('reports errors as data (name, message, stack) and keeps working afterwards', async () => {
    const h = host(); h.hello();
    const r = await h.exec('javascript', "throw new TypeError('boom')");
    assert.strictEqual(r.done.error.name, 'TypeError'); assert.strictEqual(r.done.error.message, 'boom'); assert.strictEqual(r.done.value, null);
    const syn = await h.exec('javascript', 'var = ;'); assert.strictEqual(syn.done.error.name, 'SyntaxError');
    assert.deepStrictEqual((await h.exec('javascript', '1+1')).done.value, { type: 'number', text: '2' });
    assert.strictEqual(h.sandboxConsole.log.toString().includes('out('), false, 'console restored even after an error');
  });
  await t('top-level await: expression form, statement form with return, and a runtime error is NOT run a second time', async () => {
    const h = host(); h.hello();
    assert.deepStrictEqual((await h.exec('javascript', 'await Promise.resolve(5)')).done.value, { type: 'number', text: '5' });
    assert.deepStrictEqual((await h.exec('javascript', 'const a = await Promise.resolve(2); return a * 3')).done.value, { type: 'number', text: '6' });
    await h.exec('javascript', 'globalThis.__runs = 0');
    const r = await h.exec('javascript', "await (globalThis.__runs = globalThis.__runs + 1, Promise.reject(new Error('x')))");
    assert.strictEqual(r.done.error.message, 'x');
    assert.deepStrictEqual((await h.exec('javascript', 'globalThis.__runs')).done.value, { type: 'number', text: '1' }, 'the failing command ran exactly once');
  });
  await t('globals persist between commands (a REPL), and a new host starts clean', async () => {
    const h = host(); h.hello();
    await h.exec('javascript', 'var kept = 41'); assert.deepStrictEqual((await h.exec('javascript', 'kept + 1')).done.value, { type: 'number', text: '42' });
    const other = host(); other.hello(); assert.strictEqual((await other.exec('javascript', 'typeof kept')).done.value.text, 'undefined');
  });
  await t('runs one command at a time, in order, and attributes output to the right command', async () => {
    const h = host(); h.hello(); h.toApp.length = 0;
    h.send(h.parent, IDE, { cmRunner: 1, op: 'exec', id: 101, lang: 'javascript', code: "await new Promise(r => setTimeout(r, 30)); console.log('first'); return 'one'", opts: {} });
    h.send(h.parent, IDE, { cmRunner: 1, op: 'exec', id: 102, lang: 'javascript', code: "console.log('second'); 'two'", opts: {} });
    await until(() => h.toApp.some((x) => x.m.op === 'exec-done' && x.m.id === 102));
    const seq = h.toApp.map((x) => `${x.m.op}:${x.m.id}:${x.m.text || (x.m.value && x.m.value.text) || ''}`);
    assert.deepStrictEqual(seq, ['exec-out:101:first', 'exec-done:101:one', 'exec-out:102:second', 'exec-done:102:two']);
  });
  await t('reset of a language that was never started just acknowledges', async () => {
    const h = host(); h.hello(); h.toApp.length = 0;
    h.send(h.parent, IDE, { cmRunner: 1, op: 'reset', id: 9, lang: 'python' });
    assert.deepStrictEqual([h.toApp[0].m.op, h.toApp[0].m.id], ['reset-done', 9]);
  });
  await t('a prompt reply is only accepted as a string and only for a question that was asked', async () => {
    const h = host(); h.hello(); h.toApp.length = 0;
    h.send(h.parent, IDE, { cmRunner: 1, op: 'prompt-reply', pid: 999, value: 'x' }); h.send(h.parent, IDE, { cmRunner: 1, op: 'prompt-reply', pid: 1, value: { not: 'a string' } });
    assert.strictEqual(h.toApp.length, 0);
  });

  console.log('the app side');
  await t('a command that ends in an error is a RESULT, not a failed request (regression: it used to reject as "[object Object]")', () => {
    const src = read('js/viewers/runner-client.js');
    const at = src.indexOf("if (d.op === 'exec-done') { p.resolve(d); return; }");
    assert.ok(at > -1 && at < src.indexOf('if (d.error) { p.reject(new Error(d.error)); return; }'), 'exec-done is resolved BEFORE the generic error check');
  });
  await t('exec.js is on the runner, shipped with the page, and the app loads exec-client after the runner client', () => {
    assert.ok(paths.exists('runner/exec.html') && paths.exists('runner/exec.js'));
    const html = read('index.html'); assert.ok(html.indexOf('js/viewers/runner-client.js') < html.indexOf('js/viewers/exec-client.js') && html.indexOf('js/viewers/exec-client.js') < html.indexOf('js/viewers/preview.js'));
    assert.ok(read('sw.js').includes("'/js/viewers/exec-client.js'"));
  });
  await t('the Console and Terminal only use the host through CodeMiniExec, and never `eval` into the app when Isolated', () => {
    const con = read('js/terminal/console.js'), tw = read('js/terminal/terminal-window.js'), tc = read('js/terminal/terminal-commands.js');
    assert.ok(/CodeMiniExec\.use\('console', activeWinId\)/.test(con) && /runConsoleViaRunner\(/.test(con));
    assert.strictEqual((tw.match(/isolatedRun\('(javascript|python|php|ruby)'/g) || []).length, 4, 'every script type run from a file has an isolated path');
    assert.strictEqual((tc.match(/isolatedRun\('(javascript|python|php|ruby)'/g) || []).length, 4, 'js, python -c, php -r and ruby -e have an isolated path');
    // each in-app engine call must sit AFTER the isolated attempt (else-branch), never before it
    assert.ok(/if \(iso\) \{[\s\S]{0,600}?\} else try \{\s*const result = eval\(target\.content\)/.test(tw));
  });
  await t('the host never sends HTML to be trusted: only Python display_html output is html, and the Console sanitizes it', () => {
    const con = read('js/terminal/console.js'), host = read('runner/exec.js');
    assert.ok(/e\.kind === 'html' && window\.CodeMiniEscape\) outHtml \+= window\.CodeMiniEscape\.sanitize\(e\.text\)/.test(con));
    assert.strictEqual((host.match(/'html'/g) || []).length, 2, 'only the two display_html hooks produce html events');
    assert.ok(/String\(b64\)\.replace\(\/\[\^A-Za-z0-9\+\/=\]\/g, ''\)/.test(con), 'plot data is reduced to base64 characters');
  });

  console.log(`\n${n} execution-host checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
