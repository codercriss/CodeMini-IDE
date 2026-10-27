// webR stand-in for the e2e tests: served in place of https://webr.r-wasm.org/latest/webr.mjs, for the app page and for the runner host alike.
// It understands a handful of R lines. Every WebR / REnvironment it creates counts itself in the window of the page that created it
// (window.__webrCount, window.__rEnvCount), and installPackages records its arguments in window.__rInstalled.
export class WebR {
  constructor() {
    window.__webrCount = (window.__webrCount || 0) + 1;
    const files = {};
    this.global = {};
    this.pngBase = null;
    this.FS = {
      mkdir: async () => {},
      readdir: async (dir) => ['.', '..'].concat(Object.keys(files).filter((f) => f.indexOf(dir + '/') === 0).map((f) => f.slice(dir.length + 1))),
      readFile: async (p) => files[p],
      unlink: async (p) => { delete files[p]; },
    };
    const self = this;
    this.REnvironment = class {
      constructor() { window.__rEnvCount = (window.__rEnvCount || 0) + 1; this.vars = {}; }
      destroy() { window.__rEnvDestroyed = (window.__rEnvDestroyed || 0) + 1; }
    };
    this.Shelter = class {
      async captureR(code, opts) {
        const scope = opts && opts.env ? opts.env.vars : self.global;
        const output = [];
        for (const raw of code.split('\n')) {
          const line = raw.trim();
          if (!line) continue;
          let m;
          if ((m = /^cat\("(.*)"\)$/.exec(line))) output.push({ type: 'stdout', data: m[1] });
          else if ((m = /^(\w+) <- (\d+)$/.exec(line))) scope[m[1]] = m[2];
          else if ((m = /^(\w+)$/.exec(line))) {
            if (m[1] in scope) output.push({ type: 'stdout', data: '[1] ' + scope[m[1]] });
            else throw new Error("object '" + m[1] + "' not found");
          } else if (/^plot\(/.test(line)) files[(self.pngBase || '/tmp/none_') + '001.png'] = new Uint8Array([65, 66, 67]);
          else if (/^warning_out\(/.test(line)) output.push({ type: 'stderr', data: 'Warning message: careful' });
          else if ((m = /^stop\("(.*)"\)$/.exec(line))) throw new Error(m[1]);
        }
        return { result: null, output };
      }
      purge() {}
    };
  }
  async init() {}
  async installPackages(p) { window.__rInstalled = (window.__rInstalled || []).concat(p); }
  async evalRVoid(code) {
    const m = /file="([^"]*?)%03d\.png"/.exec(code);
    if (m) this.pngBase = m[1];
    if (/rm\(list/.test(code)) this.global = {};
  }
}
