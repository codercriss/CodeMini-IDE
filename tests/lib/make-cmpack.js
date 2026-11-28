// Builds .cmpack files (ZIPs) for the tests: stored or deflate entries, with real CRCs, so the same bytes go through the unit tests and a real
// browser. Not shipped with the app.
const zlib = require('zlib');
const crypto = require('crypto');

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
// files: [{ name, data (Buffer|string), method: 'store' | 'deflate' (default 'deflate'), claimSize? (a lie, for a zip-bomb test), flags? }]
function zip(files) {
  const locals = [], central = []; let offset = 0;
  files.forEach((f) => {
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8'), method = f.method === 'store' ? 0 : 8;
    const comp = method === 0 ? raw : zlib.deflateRawSync(raw), name = Buffer.from(f.name, 'utf8'), size = f.claimSize != null ? f.claimSize : raw.length;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(f.flags || 0, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(f.flags || 0, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  });
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, end]));
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
// A well-formed pack with one item. kind: 'theme' | 'snippets'. opts: { method, itemPath, manifest (overrides), sha256 (a wrong one), size }
function cmpack(kind, obj, opts) {
  const o = opts || {}, itemPath = o.itemPath || (kind === 'theme' ? 'theme.json' : 'snippets.json'), body = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2), 'utf8');
  const manifest = Object.assign({ format: 'codemini-pack', version: 1, appVersion: '1.6.0', sender: o.sender || '', items: [{ kind, path: itemPath, size: o.size != null ? o.size : body.length, sha256: o.sha256 || sha256(body) }] }, o.manifest || {});
  return zip([{ name: 'manifest.json', data: JSON.stringify(manifest), method: o.method }, { name: itemPath, data: body, method: o.method }].concat(o.extra || []));
}
module.exports = { zip, cmpack, sha256, crc32 };
