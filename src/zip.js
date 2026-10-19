'use strict';
// "Preview" of a remote zip before downloading: read the central directory with Range requests only.
const U = require('./util');
const { fetchBuf } = require('./hls');

async function range(url, a, b, ctx) {
  const buf = await fetchBuf(url, { ...ctx, headers: { ...ctx.headers, Range: `bytes=${a}-${b}` } });
  return buf;
}

async function previewZip(url, ctx, size) {
  if (size == null) {
    const { res } = await U.open(url, { ...ctx, headers: { ...ctx.headers, Range: 'bytes=0-0' } });
    res.destroy();
    const m = /\/(\d+)\s*$/.exec(res.headers['content-range'] || '');
    if (res.statusCode !== 206 || !m) throw Object.assign(new Error('Server does not support range requests, cannot preview'), { status: 400 });
    size = +m[1];
  }
  const tailLen = Math.min(size, 65557);
  const tail = await range(url, size - tailLen, size - 1, ctx);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw Object.assign(new Error('Not a zip file'), { status: 400 });
  const count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
  if (cdOff === 0xffffffff || count === 0xffff) throw Object.assign(new Error('Zip64 archives are not previewable'), { status: 400 });
  if (cdSize > 8e6) throw Object.assign(new Error('Archive directory too large to preview'), { status: 400 });
  const cd = await range(url, cdOff, cdOff + cdSize - 1, ctx);
  const files = [];
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50 && files.length < 5000;) {
    const nl = cd.readUInt16LE(p + 28), el = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
    const flags = cd.readUInt16LE(p + 8);
    files.push({
      name: cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nl),
      compressed: cd.readUInt32LE(p + 20), size: cd.readUInt32LE(p + 24), encrypted: !!(flags & 1),
    });
    p += 46 + nl + el + cl;
  }
  return { count, files };
}

module.exports = { previewZip };
