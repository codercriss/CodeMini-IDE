// ==========================================
// py-packages.js: Python packages for every place that runs Python (CodeMiniPyPkgs)
// ==========================================
// Notebooks could always `!pip install` and auto-install what a cell imports. The Console, the editor's Run and the bottom Console,
// Debug, the Terminal and Tasks could not. This is the one implementation they all use now, so they behave alike:
//
//   * the notebook magics in any Python the person runs:  !pip install x   %pip install x   !python -m pip install x   !pip uninstall x
//     !pip list   !pip freeze   !pip show x   and  !ls  !pwd  !echo  %time  %%time  %matplotlib   (the same set the notebooks have);
//   * auto-install: the modules the code imports that are neither in the standard library, nor already importable, nor on the engine's
//     own package list, are installed from PyPI (through micropip) before the code runs;
//   * a `pip` command for the Terminal and for Tasks (`pip install x`, `pip3`, `python -m pip`).
//
// Where it runs: in whichever Python the surface uses, either the page's own Pyodide or the runner's per-window host. A caller hands over an
// `engine` ({ key, run(pythonSource) -> text }); this file never talks to Pyodide or the runner itself, so the rules below are tested in Node
// (tests/py-packages.test.js), and the Python it generates is run for real in tests/real-pyodide.manual.js.
//
// A line that starts with ! or % is never valid Python, so reading the magics cannot change a program that ran before. Lines inside a
// triple-quoted string are left alone, and a magic line is replaced by `pass` (not removed) so line numbers in a traceback stay right.
(function (root) {
    'use strict';

    // Import names that are provided by the engine itself (or are not packages at all): never looked up on PyPI.
    const NEVER_INSTALL = ['js', 'pyodide', 'pyodide_js', 'pyodide_ffi', 'micropip', 'IPython', 'ainput', 'display_html', 'custom_input', '__main__', '__future__'];

    // import name -> the name on PyPI, for the usual cases where they differ. (Pyodide's own packages, such as scikit-learn and pillow, are
    // found first by Pyodide from the import name; this table is for the pure-Python ones it does not ship.)
    const ALIASES = {
        cv2: 'opencv-python', PIL: 'pillow', sklearn: 'scikit-learn', skimage: 'scikit-image', bs4: 'beautifulsoup4', yaml: 'pyyaml',
        dateutil: 'python-dateutil', dotenv: 'python-dotenv', jwt: 'pyjwt', Crypto: 'pycryptodome', OpenSSL: 'pyopenssl', attr: 'attrs',
        serial: 'pyserial', git: 'gitpython', docx: 'python-docx', pptx: 'python-pptx', fitz: 'pymupdf', magic: 'python-magic', zmq: 'pyzmq',
        slugify: 'python-slugify', nacl: 'pynacl', jose: 'python-jose', socks: 'pysocks', socketio: 'python-socketio', engineio: 'python-engineio',
        telegram: 'python-telegram-bot', discord: 'discord.py', ruamel: 'ruamel.yaml', mpl_toolkits: 'matplotlib', Levenshtein: 'levenshtein'
    };

    // A whole run's worth of code is sent to the engine to be read for imports; past this the auto-install step is skipped (the run is not).
    const AUTO_MAX_CODE = 400000;
    const MAX_OPS = 50, MAX_PKGS = 100, MAX_REQ = 300;

    // ---------------------------------------------------------------------------------------------
    // Pure: reading a command line and the magics
    // ---------------------------------------------------------------------------------------------

    // `pip install "pandas>=2" numpy  # note` -> ['pip','install','pandas>=2','numpy']. Single and double quotes group, an unquoted word that starts
    // with # ends the line, nothing else is special. null for an unclosed quote.
    function splitArgs(str) {
        const out = []; let cur = '', quote = null, any = false;
        for (const c of String(str)) {
            if (quote) { if (c === quote) quote = null; else cur += c; continue; }
            if (c === '"' || c === "'") { quote = c; any = true; continue; }
            if (/\s/.test(c)) { if (cur || any) { out.push(cur); cur = ''; any = false; } continue; }
            if (c === '#' && !cur && !any) return out;      // a shell comment
            cur += c;
        }
        if (quote) return null;
        if (cur || any) out.push(cur);
        return out;
    }

    // Options pip takes that mean nothing here (there is one environment, no cache, no user site): accepted and ignored, so a line copied from a
    // tutorial still works.
    const IGNORED_FLAGS = new Set(['-q', '-qq', '-qqq', '--quiet', '-v', '-vv', '-vvv', '--verbose', '--user', '--no-cache-dir', '--disable-pip-version-check',
        '--no-warn-script-location', '--no-warn-conflicts', '--break-system-packages', '-y', '--yes', '--no-input', '--no-compile', '--compile', '--no-clean',
        '--no-build-isolation', '--use-pep517', '--no-use-pep517', '--prefer-binary', '--require-virtualenv', '-I', '--ignore-installed', '--force-reinstall']);
    const IGNORED_WITH_VALUE = new Set(['--progress-bar', '--root-user-action', '--only-binary', '--no-binary', '-t', '--target', '--prefix', '--root', '-c', '--constraint',
        '--python', '--timeout', '--retries', '--cache-dir', '--proxy', '--trusted-host', '--cert', '--client-cert', '--global-option', '--config-settings',
        '--log', '--exists-action', '--src', '--platform', '--implementation', '--abi', '--python-version']);
    const SUBCOMMANDS = new Set(['install', 'uninstall', 'list', 'freeze', 'show']);

    // The requirement a package argument names, or why it cannot be used. micropip takes names with version specifiers, and the URL of a wheel.
    function checkRequirement(req) {
        if (!req || req.length > MAX_REQ || /[\u0000-\u001f]/.test(req)) return 'is not a package name';
        if (/^(git|hg|svn|bzr)\+/i.test(req)) return 'cannot be installed from a repository here (only a package name, or the URL of a .whl file)';
        if (/^file:|^[./~]|^[A-Za-z]:[\\/]/.test(req)) return 'is a path on a computer, which this Python cannot see (use a package name, or the URL of a .whl file)';
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(req)) return /^https?:\/\//i.test(req) ? '' : 'is not an http(s) address';
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]+\])?\s*([<>=!~]=?=?[^\s;]*(\s*,\s*[<>=!~]=?=?[^\s;]*)*)?(\s*;.*)?$/.test(req)) return 'is not a package name pip would accept';
        return '';
    }

    // `tokens` are what follows the word pip: ['install', '-q', 'numpy>=1.2', '--upgrade'].
    // -> { op: 'install'|'uninstall'|'list'|'freeze'|'show'|'version'|'unsupported', pkgs, pre, deps, upgrade, index, notes, error }
    function parsePip(tokens) {
        const r = { op: null, pkgs: [], pre: false, deps: true, upgrade: false, index: [], notes: [], error: '' };
        const t = Array.isArray(tokens) ? tokens.slice() : [];
        let i = 0;
        // options before the subcommand (`pip -q install x`)
        while (i < t.length && t[i].startsWith('-') && t[i] !== '--version' && t[i] !== '-V') {
            const a = t[i].split('=')[0];
            if (IGNORED_WITH_VALUE.has(a) && !t[i].includes('=')) i += 1;
            i += 1;
        }
        if (i >= t.length) { r.op = 'unsupported'; r.error = 'pip needs a command: install, uninstall, list, freeze or show.'; return r; }
        const sub = t[i++];
        if (sub === '--version' || sub === '-V' || sub === 'version') { r.op = 'version'; return r; }
        if (!SUBCOMMANDS.has(sub)) { r.op = 'unsupported'; r.error = 'pip ' + sub + ' is not available here. This Python manages packages with micropip: install, uninstall, list, freeze and show.'; return r; }
        r.op = sub;
        for (; i < t.length; i++) {
            const tok = t[i];
            if (!tok.startsWith('-') || tok === '-') { r.pkgs.push(tok); continue; }
            const eq = tok.indexOf('='), flag = eq > 0 ? tok.slice(0, eq) : tok, inline = eq > 0 ? tok.slice(eq + 1) : null;
            const value = () => (inline !== null ? inline : (i + 1 < t.length ? t[++i] : ''));
            if (flag === '-U' || flag === '--upgrade') r.upgrade = true;
            else if (flag === '--pre') r.pre = true;
            else if (flag === '--no-deps') r.deps = false;
            else if (flag === '-i' || flag === '--index-url' || flag === '--extra-index-url') { const v = value(); if (/^https?:\/\//i.test(v)) r.index.push(v); else r.notes.push('Ignored ' + flag + ' (not an http(s) address).'); }
            else if (flag === '-r' || flag === '--requirement') { value(); r.notes.push('-r (a requirements file) is not supported: that file is not visible to this Python. Install the packages by name instead.'); }
            else if (flag === '-e' || flag === '--editable') { value(); r.notes.push('-e (an editable install) is not supported here.'); }
            else if (flag === '-f' || flag === '--find-links') { value(); r.notes.push('Ignored ' + flag + '.'); }
            else if (IGNORED_FLAGS.has(flag)) { /* nothing to do */ }
            else if (IGNORED_WITH_VALUE.has(flag)) value();
            else r.notes.push('Ignored the option ' + flag + '.');
        }
        if (r.op === 'install' || r.op === 'uninstall' || r.op === 'show') {
            if (!r.pkgs.length) {
                if (r.notes.some((n) => /^-r |^-e /.test(n))) { r.error = 'Nothing to ' + r.op + ': name the packages.'; }
                else r.error = 'Name the packages to ' + r.op + ', for example: pip ' + r.op + ' numpy';
            } else if (r.pkgs.length > MAX_PKGS) r.error = 'Too many packages in one command (the most is ' + MAX_PKGS + ').';
            else if (r.op === 'install') {
                for (const p of r.pkgs) { const why = checkRequirement(p); if (why) { r.error = '"' + p + '" ' + why + '.'; break; } }
            } else {
                for (const p of r.pkgs) { if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p)) { r.error = '"' + p + '" is not a package name.'; break; } }
            }
        }
        return r;
    }

    // One line of Python source: updates the string state `st` ({ tri: null | '"""' | "'''" }) after reading the line, so the next line knows whether it
    // starts inside a triple-quoted string. Handles # comments and single-line strings (with backslash escapes) well enough for this purpose.
    function scanLine(line, st) {
        let i = 0; const n = line.length;
        while (i < n) {
            if (st.tri) {
                const j = line.indexOf(st.tri, i);
                if (j < 0) return;                     // the string goes on to the next line
                i = j + 3; st.tri = null; continue;
            }
            const c = line[i];
            if (c === '#') return;
            if (c === '"' || c === "'") {
                if (line.startsWith(c + c + c, i)) { st.tri = c + c + c; i += 3; continue; }
                i++;
                while (i < n && line[i] !== c) { if (line[i] === '\\') i++; i++; }
                i++; continue;
            }
            i++;
        }
    }

    const MAGIC_PIP = /^[!%](?:pip3?(?:\.\d+)?|python3?(?:\.\d+)?\s+-m\s+pip3?|py\s+-m\s+pip)(?=\s|$)/i;

    // Turns notebook magics into what Python can run.
    // -> { code, ops: [parsePip result...], notes: [text], timed: bool, changed: bool }
    // `pass` replaces each magic line (same line count). Pip lines are collected in order, to run before the code does (as in the notebooks).
    function preprocess(code) {
        const src = String(code == null ? '' : code);
        const lines = src.split('\n');
        const out = [], ops = [], notes = [];
        const st = { tri: null };
        let timed = false, changed = false;
        for (const line of lines) {
            if (st.tri) { out.push(line); scanLine(line, st); continue; }       // inside a triple-quoted string: not code
            const m = /^(\s*)([!%].*)$/.exec(line.replace(/\r$/, ''));
            if (!m) { out.push(line); scanLine(line, st); continue; }
            const indent = m[1], body = m[2].trim();
            let repl = null;
            if (MAGIC_PIP.test(body)) {
                const after = body.replace(MAGIC_PIP, '').trim();
                const toks = splitArgs(after);
                if (toks === null) { notes.push('A pip line has an unclosed quote: ' + body.slice(0, 60)); repl = 'pass'; }
                else {
                    // `%pip`, `!pip3`, `!pip` and `!python -m pip` all take the sub-command next
                    const p = parsePip(toks);
                    if (ops.length >= MAX_OPS) { notes.push('Too many pip lines in one run; the rest were skipped.'); }
                    else ops.push(p);
                    repl = 'pass';
                }
            } else if (/^!ls(\s|$)/.test(body)) {
                const toks = splitArgs(body.slice(3)) || [];
                const target = toks.find((x) => !x.startsWith('-'));
                repl = "import os; print('\\n'.join(os.listdir(" + (target ? JSON.stringify(target) : "'.'") + ')))';
            } else if (/^!pwd(\s|$)/.test(body)) repl = 'import os; print(os.getcwd())';
            else if (/^!echo(\s|$)/.test(body)) repl = 'print(' + JSON.stringify(body.slice(5).trim()) + ')';
            else if (/^%%time(\s|$)/.test(body)) { timed = true; repl = 'pass'; }
            else if (/^%time(\s|$)/.test(body)) { timed = true; const rest = body.slice(5).trim(); repl = rest || 'pass'; }
            else if (/^%matplotlib(\s|$)/.test(body)) repl = 'pass';
            if (repl === null) { out.push(line); scanLine(line, st); continue; }       // not a magic we know: leave it (Python reports it)
            changed = true;
            out.push(indent + repl);
        }
        return { code: changed ? out.join('\n') : src, ops, notes, timed, changed };
    }

    // ---------------------------------------------------------------------------------------------
    // The Python the engine runs
    // ---------------------------------------------------------------------------------------------

    // A JSON text as a Python string literal (JSON's escapes are valid Python escapes), so nothing a person typed is ever pasted in as code.
    const pyLiteral = (data) => JSON.stringify(JSON.stringify(data));

    // The engine-side work: pip operations, then auto-install. Returns a JSON text: { log: [[kind, text]...], installed: [...], failed: [[name, dist, why]...] }.
    // Everything lives inside one function (and the underscore names) so nothing is left in the person's namespace or its Variables list.
    const PY_MAIN = [
        'async def _cm_pkg_main(_cm_payload):',
        '    import json, sys, inspect, importlib, importlib.util',
        '    P = json.loads(_cm_payload)',
        '    log = []; installed = []; failed = []',
        '    def say(kind, text): log.append([kind, text])',
        '    state = {"mp": None}',
        '    async def mp():',
        '        if state["mp"] is None:',
        '            try:',
        '                import micropip as m',
        '            except ImportError:',
        '                import pyodide_js',
        '                await pyodide_js.loadPackage("micropip")',
        '                import micropip as m',
        '            state["mp"] = m',
        '        return state["mp"]',
        '    def short(e):',
        '        s = str(e).strip().split("\\n")[0]',
        '        return s[:300]',
        '    def norm(req):',
        '        import re',
        '        m = re.match(r"[A-Za-z0-9][A-Za-z0-9._-]*", req.strip())',
        '        return re.sub(r"[-_.]+", "-", m.group(0)).lower() if m else req.lower()',
        '    async def do_install(m, pkgs, op):',
        '        params = inspect.signature(m.install).parameters',
        '        kw = {}',
        '        if op.get("pre") and "pre" in params: kw["pre"] = True',
        '        if op.get("deps") is False and "deps" in params: kw["deps"] = False',
        '        if op.get("upgrade") and "reinstall" in params: kw["reinstall"] = True',
        '        if op.get("index") and "index_urls" in params: kw["index_urls"] = op["index"]',
        '        await m.install(pkgs, **kw)',
        '        importlib.invalidate_caches()',
        '    for op in P.get("ops", []):',
        '        kind = op["op"]',
        '        try:',
        '            if kind == "install":',
        '                m = await mp()',
        '                have = {norm(k) for k in m.list().keys()}',
        '                import re',
        '                already = [p for p in op["pkgs"] if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", p) and norm(p) in have and not op.get("upgrade")]',
        '                todo = [p for p in op["pkgs"] if p not in already]',
        '                for p in already: say("info", "Requirement already satisfied: " + p)',
        '                if todo:',
        '                    await do_install(m, todo, op)',
        '                    installed.extend(todo)',
        '                    say("ok", "Successfully installed " + ", ".join(todo))',
        '            elif kind == "uninstall":',
        '                m = await mp()',
        '                have = {norm(k) for k in m.list().keys()}',
        '                present = []',
        '                for p in op["pkgs"]:',
        '                    if norm(p) == "micropip": say("err", "ERROR: micropip is what installs packages here, so it cannot be uninstalled.")',
        '                    elif norm(p) in have: present.append(p)',
        '                    else: say("info", "WARNING: Skipping " + p + " as it is not installed.")',
        '                if present:',
        '                    r = m.uninstall(present)',
        '                    if inspect.isawaitable(r): await r',
        '                    importlib.invalidate_caches()',
        '                    say("ok", "Successfully uninstalled " + ", ".join(present))',
        '            elif kind in ("list", "freeze"):',
        '                m = await mp()',
        '                rows = sorted(((k, str(getattr(v, "version", ""))) for k, v in m.list().items()), key=lambda r: r[0].lower())',
        '                if kind == "freeze":',
        '                    for n, v in rows: say("out", n + "==" + v)',
        '                else:',
        '                    w = max([len("Package")] + [len(n) for n, v in rows])',
        '                    say("out", "Package".ljust(w) + " Version"); say("out", "-" * w + " -------")',
        '                    for n, v in rows: say("out", n.ljust(w) + " " + v)',
        '            elif kind == "show":',
        '                from importlib import metadata',
        '                for n in op["pkgs"]:',
        '                    try:',
        '                        md = metadata.metadata(n)',
        '                    except metadata.PackageNotFoundError:',
        '                        say("err", "WARNING: Package(s) not found: " + n); continue',
        '                    for f in ("Name", "Version", "Summary", "Home-page", "Author", "License"):',
        '                        if md.get(f): say("out", f + ": " + md.get(f))',
        '                    say("out", "---")',
        '            elif kind == "version":',
        '                m = await mp()',
        '                say("out", "micropip " + str(getattr(m, "__version__", "")) + " (this Python installs with micropip, not pip)")',
        '        except Exception as e:',
        '            failed.append(["op", kind, ", ".join(op.get("pkgs", [])), short(e)])',
        '    A = P.get("auto")',
        '    if A:',
        '        import ast',
        '        code = A["code"]',
        '        names = set()',
        '        tree = None',
        '        try:',
        '            tree = ast.parse(code)',
        '        except SyntaxError:',
        '            tree = None   # the run reports the syntax error itself',
        '        if tree is not None:',
        '            for node in ast.walk(tree):',
        '                if isinstance(node, ast.Import):',
        '                    for a in node.names: names.add(a.name.split(".")[0])',
        '                elif isinstance(node, ast.ImportFrom):',
        '                    if node.level == 0 and node.module: names.add(node.module.split(".")[0])',
        '            try:',
        '                import pyodide_js',
        '                await pyodide_js.loadPackagesFromImports(code)',
        '            except Exception:',
        '                pass',
        '            importlib.invalidate_caches()',
        '            skip = set(A.get("never", [])) | set(A.get("skip", []))',
        '            missing = []',
        '            for n in sorted(names):',
        '                if n in skip or n.startswith("_") or n in sys.stdlib_module_names or n in sys.builtin_module_names: continue',
        '                try:',
        '                    if importlib.util.find_spec(n) is not None: continue',
        '                except (ValueError, ImportError, AttributeError):',
        '                    continue',
        '                missing.append(n)',
        '            if missing:',
        '                m = await mp()',
        '                for n in missing:',
        '                    dist = A.get("aliases", {}).get(n, n)',
        '                    try:',
        '                        await m.install(dist)',
        '                        importlib.invalidate_caches()',
        '                        installed.append(dist)',
        '                        say("auto", dist)',
        '                    except Exception as e:',
        '                        failed.append(["auto", n, dist, short(e)])',
        '    return json.dumps({"log": log, "installed": installed, "failed": failed})'
    ].join('\n');

    // The program to hand an engine: -> text that, when run, ends with the JSON result above.
    function buildProgram(payload) {
        return PY_MAIN + '\n_cm_pkg_res = await _cm_pkg_main(' + pyLiteral(payload) + ')\ndel _cm_pkg_main\nglobals().pop("_cm_pkg_res")';
    }

    // ---------------------------------------------------------------------------------------------
    // Pure: turning the engine's answer into lines a surface can show
    // ---------------------------------------------------------------------------------------------

    // A micropip / pip failure in words a person can act on.
    function explain(why) {
        const s = String(why || '');
        if (/pure Python 3 wheel/i.test(s)) return 'no pure-Python wheel exists for it, so it cannot run in the browser (a package with compiled code works only if Pyodide ships it)';
        if (/Unsupported content type|404|not found/i.test(s) && !/network/i.test(s)) return 'not found on PyPI';
        if (/Failed to fetch|NetworkError|fetch failed|offline|ERR_INTERNET/i.test(s)) return 'the network is not reachable';
        return s.length > 160 ? s.slice(0, 157) + '...' : s;
    }

    // Parses the engine's text. -> { log: [[kind, text]], installed: [dist], failed: [['op', kind, packages, why] | ['auto', importName, dist, why]] }
    // Parses the engine's text. (an unreadable answer is one error line, never a throw)
    function parseResult(text) {
        try {
            const o = JSON.parse(String(text));
            return { log: Array.isArray(o.log) ? o.log : [], installed: Array.isArray(o.installed) ? o.installed : [], failed: Array.isArray(o.failed) ? o.failed : [] };
        } catch (e) {
            return { log: [['err', 'The package step returned something unreadable.']], installed: [], failed: [] };
        }
    }

    // Lines for a surface: [{ kind: 'info'|'ok'|'err'|'out', text }]: the engine's log, then what failed (a pip line is an error; an auto-install
    // that could not be done is a note, because the run goes on and Python names what is missing).
    function toLines(res) {
        const lines = [];
        const autoDone = [];
        res.log.forEach((row) => {
            const kind = row[0], text = String(row[1]);
            if (kind === 'auto') autoDone.push(text);
            else lines.push({ kind: kind === 'ok' || kind === 'err' || kind === 'out' ? kind : 'info', text });
        });
        if (autoDone.length) lines.push({ kind: 'info', text: 'Auto-installed: ' + autoDone.join(', ') });
        res.failed.forEach((f) => {
            if (f[0] === 'op') lines.push({ kind: 'err', text: 'ERROR: ' + (f[1] === 'install' ? 'Could not install ' + f[2] : 'pip ' + f[1] + ' failed') + ': ' + explain(f[3]) });
            else if (f[0] === 'auto') lines.push({ kind: 'info', text: 'Could not auto-install ' + f[2] + ': ' + explain(f[3]) + '. The run continues without it.' });
        });
        return lines;
    }

    // Names that must not be tried again this session because a look-up already failed (an optional import in a try block would otherwise cost a network
    // round trip on every run). Keyed by engine. An explicit `pip install` of the same name is always tried and clears the entry.
    const failedAuto = Object.create(null);
    const failedFor = (key) => (failedAuto[key] || (failedAuto[key] = new Set()));

    // A package was installed on purpose (or by auto-install): forget any earlier failed look-up for the names that map to it.
    function forgetInstalled(key, dists) {
        const set = failedFor(key);
        Array.from(set).forEach((n) => { if (dists.includes(n) || dists.includes(ALIASES[n])) set.delete(n); });
    }

    const describe = (pkgs) => pkgs.slice(0, 3).join(', ') + (pkgs.length > 3 ? ' and ' + (pkgs.length - 3) + ' more' : '');

    // Runs one program on an engine and reads the answer.
    async function runProgram(engine, payload) {
        const text = await engine.run(buildProgram(payload));
        return parseResult(text);
    }

    // ---------------------------------------------------------------------------------------------
    // What a surface calls
    // ---------------------------------------------------------------------------------------------

    // Before Python code runs: reads the magics, runs the pip lines, and (when asked) auto-installs the imports.
    //   opts: { autoInstall: bool, engine: { key, run(py) }, local: [module names that are the person's own files], onStatus(text), isStopped() }
    // -> { code (to run instead of the original), timed, logs: [{ kind, text }], ran: bool (the engine was used) }
    // It never throws for a package problem: the problem becomes a line, and the code runs (and says what is missing, as Python does).
    // An engine that is stopped (the host was shut down) does throw, so the caller's own stop handling takes over.
    async function prepare(code, opts) {
        opts = opts || {};
        const pre = preprocess(code);
        const logs = pre.notes.map((n) => ({ kind: 'info', text: n }));
        const result = { code: pre.code, timed: pre.timed, logs, ran: false };
        const engine = opts.engine;
        const status = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};
        const bad = pre.ops.filter((o) => o.error || o.op === 'unsupported');
        bad.forEach((o) => logs.push({ kind: 'err', text: 'ERROR: ' + o.error }));
        pre.ops.forEach((o) => (o.notes || []).forEach((n) => logs.push({ kind: 'info', text: n })));
        const ops = pre.ops.filter((o) => !o.error && o.op !== 'unsupported').map((o) => ({ op: o.op, pkgs: o.pkgs, pre: o.pre, deps: o.deps, upgrade: o.upgrade, index: o.index }));
        const wantAuto = !!opts.autoInstall && pre.code.length <= AUTO_MAX_CODE && /(^|\n)[ \t]*(import|from)[ \t]+[A-Za-z_.]/.test(pre.code);
        if (!engine) { if (ops.length) logs.push({ kind: 'err', text: 'ERROR: There is no Python to run pip in.' }); return result; }
        if (!ops.length && !wantAuto) return result;
        const key = engine.key || 'engine', failedSet = failedFor(key);
        const payload = { ops };
        if (wantAuto) payload.auto = { code: pre.code, skip: Array.from(failedSet).concat(opts.local || []), never: NEVER_INSTALL, aliases: ALIASES };
        const installing = ops.filter((o) => o.op === 'install').reduce((a, o) => a.concat(o.pkgs), []);
        status(installing.length ? 'Installing packages: ' + describe(installing) + '...' : (ops.length ? 'Running pip...' : 'Resolving Python dependencies...'));
        let res;
        try { res = await runProgram(engine, payload); result.ran = true; }
        catch (e) {
            if (typeof opts.isStopped === 'function' && opts.isStopped()) throw e;      // Stop shut the engine down: the caller stops the run too
            logs.push({ kind: 'err', text: 'The package step could not run: ' + (e && e.message ? e.message : String(e)) }); return result;
        }
        forgetInstalled(key, res.installed);
        res.failed.forEach((f) => { if (f[0] === 'auto') failedSet.add(f[1]); });
        toLines(res).forEach((l) => logs.push(l));
        return result;
    }

    // The `pip` command (the Terminal's `pip` / `pip3` / `python -m pip`, and a Task whose command is `pip install ...`).
    //   tokens: what follows the word pip; opts: { engine, onStatus }
    // -> { ok: bool, logs: [{ kind, text }] }
    async function pipCommand(tokens, opts) {
        opts = opts || {};
        const p = parsePip(tokens);
        const logs = [];
        (p.notes || []).forEach((n) => logs.push({ kind: 'info', text: n }));
        if (p.error || p.op === 'unsupported') { logs.push({ kind: 'err', text: 'ERROR: ' + (p.error || 'unsupported') }); return { ok: false, logs }; }
        if (!opts.engine) { logs.push({ kind: 'err', text: 'ERROR: There is no Python to install into.' }); return { ok: false, logs }; }
        const op = { op: p.op, pkgs: p.pkgs, pre: p.pre, deps: p.deps, upgrade: p.upgrade, index: p.index };
        if (typeof opts.onStatus === 'function') opts.onStatus(p.op === 'install' ? 'Installing packages: ' + describe(p.pkgs) + '...' : 'pip ' + p.op + '...');
        let res;
        try { res = await runProgram(opts.engine, { ops: [op] }); }
        catch (e) { logs.push({ kind: 'err', text: 'ERROR: ' + (e && e.message ? e.message : String(e)) }); return { ok: false, logs }; }
        forgetInstalled(opts.engine.key || 'engine', res.installed);
        toLines(res).forEach((l) => logs.push(l));
        return { ok: !logs.some((l) => l.kind === 'err'), logs };
    }

    // `Wall time: 12.34 ms`, the line %time adds.
    const timeLine = (ms) => 'Wall time: ' + Number(ms).toFixed(2) + ' ms';

    const api = { NEVER_INSTALL, ALIASES, AUTO_MAX_CODE, splitArgs, parsePip, checkRequirement, preprocess, scanLine, buildProgram, pyLiteral, explain, parseResult, toLines, prepare, pipCommand, timeLine, failedFor, forgetInstalled };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window === 'undefined') return; // Node: the rules and the program text only

    // ---------------------------------------------------------------------------------------------
    // Browser: engines
    // ---------------------------------------------------------------------------------------------
    // The page's own Pyodide (Same origin mode, or when the runner could not be used).
    api.appEngine = function () {
        return {
            key: 'app',
            async run(py) {
                if (typeof root.getPyodideInstance !== 'function') throw new Error('The Python engine is not loaded yet.');
                const p = await root.getPyodideInstance();
                if (!p) throw new Error('The Python engine did not start.');
                const r = await p.runPythonAsync(py);
                return r === undefined || r === null ? '' : String(r);
            }
        };
    };
    // The runner's per-window host (Isolated mode). Raw mode runs the program in the host's own namespace and sends back the text of its last value.
    api.hostEngine = function (winId) {
        return {
            key: 'host:' + String(winId || ''),
            async run(py) {
                const r = await root.CodeMiniExec.run(winId, { lang: 'python', code: py, opts: { raw: true, trusted: true, autoInstall: false } });
                if (r && r.error) throw new Error(String(r.error.message || r.error.text || 'The package step failed.'));
                return r && r.value && r.value.text ? String(r.value.text) : '';
            }
        };
    };
    root.CodeMiniPyPkgs = api;
})(typeof window !== 'undefined' ? window : globalThis);
