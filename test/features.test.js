'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Manager } = require('../src/manager');
const { createServer } = require('../src/server');
const { explore, convertLinks } = require('../src/grabber');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advance-download-manager-feat-'));
const FILE = crypto.randomBytes(2 * 1024 * 1024);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const mk = name => { const m = new Manager({ dataDir: path.join(tmp, name, 'data') }).load(); m.setSettings({ minSplitBytes: 64 * 1024, rampMs: 30 }); return m; };
const waitFor = (m, id, pred, ms = 20000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout; ' + JSON.stringify(m.view(m.get(id))))), ms);
  const check = () => { const v = m.view(m.get(id)); if (pred(v)) { clearTimeout(t); m.off('update', check); resolve(v); } };
  m.on('update', check); check();
});

// ---------------- mock FTP server (passive mode, REST, auth) ----------------
const ftpLog = { rests: [], logins: 0 };
const ftpServer = net.createServer(sock => {
  let user = '', rest = 0, dataSrv = null, dataSock = null, pending = null;
  const say = s => sock.write(s + '\r\n');
  say('220 mock ftp');
  let buf = '';
  sock.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); handle(line); }
  });
  sock.on('error', () => {});
  sock.on('close', () => { dataSrv && dataSrv.close(); });
  function handle(line) {
    const [cmd, ...rest_] = line.split(' '); const arg = rest_.join(' ');
    switch (cmd.toUpperCase()) {
      case 'USER': user = arg; say('331 need pass'); break;
      case 'PASS': if (user === 'ftpuser' && arg === 'ftppass') { ftpLog.logins++; say('230 ok'); } else say('530 denied'); break;
      case 'TYPE': say('200 binary'); break;
      case 'SIZE': arg === 'pub/data.bin' ? say('213 ' + FILE.length) : say('550 no such file'); break;
      case 'MDTM': say('213 20240101000000'); break;
      case 'REST': rest = +arg; ftpLog.rests.push(rest); say('350 restarting'); break;
      case 'EPSV':
        dataSrv = net.createServer(ds => { dataSock = ds; ds.on('error', () => {}); if (pending) pending(); });
        dataSrv.listen(0, '127.0.0.1', () => say(`229 Entering Extended Passive Mode (|||${dataSrv.address().port}|)`));
        break;
      case 'RETR': {
        const go = () => { // stream in 64 KB pieces so that several connections overlap in time
          say('150 opening'); const body = FILE.subarray(rest); rest = 0; let off = 0;
          const pump = () => { if (dataSock.destroyed) return; if (off >= body.length) return dataSock.end(() => say('226 done')); dataSock.write(body.subarray(off, off + 65536)); off += 65536; setTimeout(pump, 4); };
          pump();
        };
        dataSock ? go() : (pending = go);
        break;
      }
      case 'QUIT': say('221 bye'); sock.end(); break;
      default: say('502 not implemented');
    }
  }
});

// ---------------- HLS origin ----------------
const SEGS = Array.from({ length: 5 }, () => crypto.randomBytes(100 * 1024));
const KEY = crypto.randomBytes(16);
const enc = SEGS.map((s, seq) => { const iv = Buffer.alloc(16); iv.writeUInt32BE(seq, 12); const c = crypto.createCipheriv('aes-128-cbc', KEY, iv); return Buffer.concat([c.update(s), c.final()]); });
const media = (prefix, key) => '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n' +
  (key ? '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n' : '') + SEGS.map((_, i) => `#EXTINF:4,\n${prefix}${i}.ts\n`).join('') + '#EXT-X-ENDLIST\n';

// ---------------- generic origin: zip, hls, site for grabber ----------------
function makeZip(entries) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data); centrals.push(ch, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const ZIP = makeZip([['readme.txt', Buffer.from('hello')], ['docs/guide.pdf', crypto.randomBytes(5000)]]);
const BIG = crypto.randomBytes(300 * 1024), SMALL = crypto.randomBytes(2000);

const origin = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  const send = (body, type = 'application/octet-stream') => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) { const s = +m[1], e = m[2] ? +m[2] : body.length - 1; res.writeHead(206, { 'Content-Type': type, 'Content-Length': e - s + 1, 'Content-Range': `bytes ${s}-${e}/${body.length}` }); return res.end(body.subarray(s, e + 1)); }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) }); res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (p === '/a.zip') return send(ZIP, 'application/zip');
  if (p === '/hls/master.m3u8') return send('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000\nplain/index.m3u8\n', 'application/vnd.apple.mpegurl');
  if (p === '/hls/low/index.m3u8') return send('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nbad.ts\n#EXT-X-ENDLIST\n');
  if (p === '/hls/plain/index.m3u8') return send(media('', false), 'application/vnd.apple.mpegurl');
  const mseg = /^\/hls\/(plain|enc)\/(\d)\.ts$/.exec(p);
  if (mseg) return send((mseg[1] === 'enc' ? enc : SEGS)[+mseg[2]]);
  if (p === '/hls/enc/index.m3u8') return send(media('', true), 'application/vnd.apple.mpegurl');
  if (p === '/hls/enc/key.bin') return send(KEY);
  if (p === '/hls/live/index.m3u8') return send('#EXTM3U\n#EXTINF:4,\n0.ts\n');
  if (p === '/site/index.html') return send('<html><body><a href="sub/page2.html">p2</a><img src="big.bin"><a href="small.bin">s</a><a href="small-copy/small.bin">c</a><script>var x="/site/from-js.png";</script><link href="style.css"></body></html>', 'text/html');
  if (p === '/site/sub/page2.html') return send('<html><a href="../index.html">home</a><a href="http://elsewhere.invalid/x.zip">ext</a></html>', 'text/html');
  if (p === '/site/big.bin') return send(BIG);
  if (p === '/site/small.bin' || p === '/site/small-copy/small.bin') return send(SMALL);
  if (p === '/site/from-js.png') return send(Buffer.from('png'));
  if (p === '/site/style.css') return send('body{}', 'text/css');
  res.writeHead(404); res.end();
});
let base, ftpPort;
test.before(async () => {
  await new Promise(r => origin.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${origin.address().port}`;
  await new Promise(r => ftpServer.listen(0, '127.0.0.1', r)); ftpPort = ftpServer.address().port;
});
test.after(() => { origin.closeAllConnections?.(); origin.close(); ftpServer.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('FTP: segmented download with REST resume offsets, auth from URL', async () => {
  const m = mk('ftp'); ftpLog.rests.length = 0;
  const v = m.add({ url: `ftp://ftpuser:ftppass@127.0.0.1:${ftpPort}/pub/data.bin`, saveDir: path.join(tmp, 'ftp', 'out'), queue: null, startNow: true });
  const d = await waitFor(m, v.id, x => x.status === 'complete' || x.status === 'error', 30000);
  assert.strictEqual(d.status, 'complete', d.error);
  assert.strictEqual(d.fileName, 'data.bin');
  assert.strictEqual(sha(fs.readFileSync(path.join(d.saveDir, d.fileName))), sha(FILE));
  assert.ok(ftpLog.rests.some(r => r > 0), 'used REST with non-zero offsets (multi-connection)');
  await m.shutdown();
});

test('FTP: bad password fails fast; Site Logins list supplies credentials', async () => {
  const m = mk('ftp2');
  const bad = m.add({ url: `ftp://nobody:x@127.0.0.1:${ftpPort}/pub/data.bin`, saveDir: path.join(tmp, 'ftp2', 'o1'), queue: null, startNow: true });
  const bd = await waitFor(m, bad.id, x => x.status === 'error');
  assert.match(bd.error, /login failed/i);
  m.setSettings({ siteLogins: [{ pattern: '127.0.0.1', user: 'ftpuser', pass: 'ftppass' }] });
  const ok = m.add({ url: `ftp://127.0.0.1:${ftpPort}/pub/data.bin`, saveDir: path.join(tmp, 'ftp2', 'o2'), queue: null, startNow: true });
  const od = await waitFor(m, ok.id, x => x.status === 'complete' || x.status === 'error', 30000);
  assert.strictEqual(od.status, 'complete', od.error);
  await m.shutdown();
});

test('HLS: master playlist picks best variant; segments concatenated in order', async () => {
  const m = mk('hls');
  const v = m.add({ url: base + '/hls/master.m3u8', saveDir: path.join(tmp, 'hls', 'out'), queue: null, startNow: true });
  const d = await waitFor(m, v.id, x => x.status === 'complete' || x.status === 'error');
  assert.strictEqual(d.status, 'complete', d.error);
  assert.strictEqual(d.fileName, 'master.ts');
  assert.strictEqual(sha(fs.readFileSync(path.join(d.saveDir, d.fileName))), sha(Buffer.concat(SEGS)));
  await m.shutdown();
});

test('HLS: AES-128 encrypted stream is decrypted (IV from media sequence)', async () => {
  const m = mk('hlsenc');
  const v = m.add({ url: base + '/hls/enc/index.m3u8', saveDir: path.join(tmp, 'hlsenc', 'out'), queue: null, startNow: true });
  const d = await waitFor(m, v.id, x => x.status === 'complete' || x.status === 'error');
  assert.strictEqual(d.status, 'complete', d.error);
  assert.strictEqual(sha(fs.readFileSync(path.join(d.saveDir, d.fileName))), sha(Buffer.concat(SEGS)));
  await m.shutdown();
});

test('HLS: live streams are rejected with a clear error', async () => {
  const m = mk('hlslive');
  const v = m.add({ url: base + '/hls/live/index.m3u8', saveDir: path.join(tmp, 'hlslive', 'out'), queue: null, startNow: true });
  const d = await waitFor(m, v.id, x => x.status === 'error');
  assert.match(d.error, /live/i);
  await m.shutdown();
});

test('zip preview lists entries using only range requests', async () => {
  const m = mk('zip');
  const z = await m.previewZip({ url: base + '/a.zip' });
  assert.deepStrictEqual(z.files.map(f => f.name), ['readme.txt', 'docs/guide.pdf']);
  assert.strictEqual(z.files[0].size, 5);
  await m.shutdown();
});

test('grabber: JS link screening, size filter, duplicate hiding, offline mirror with converted links', async () => {
  const root = path.join(tmp, 'mirror');
  const files = [], pages = [];
  const stats = await explore({ startUrl: base + '/site/index.html', levelsThis: 2, savePages: true, saveRoot: root, minSize: 1000, hideDuplicates: true, sameSiteOnly: true, exts: ['bin', 'png', 'css'] },
    { signal: new AbortController().signal, onFile: f => files.push(f), onPage: (u, s, local) => local && pages.push({ url: u, local }) });
  const names = files.map(f => f.name).sort();
  // from-js.png (3 B) and style.css (6 B) fall under minSize; the second small.bin is a duplicate
  assert.deepStrictEqual(names, ['big.bin', 'small.bin']);
  assert.strictEqual(stats.filtered, 3);
  assert.ok(pages.length === 2, 'two pages saved: ' + pages.length);
  const converted = convertLinks(pages, files);
  assert.strictEqual(converted, 2);
  const idx = fs.readFileSync(pages.find(p => p.url.endsWith('index.html')).local, 'utf8');
  assert.match(idx, /href="sub\/page2\.html"/, 'page link relative');
  assert.match(idx, /src="big\.bin"/, 'file link relative');
  const p2 = fs.readFileSync(pages.find(p => p.url.endsWith('page2.html')).local, 'utf8');
  assert.match(p2, /href="\.\.\/index\.html"/, 'parent link relative');
  assert.match(p2, /href="http:\/\/elsewhere\.invalid\/x\.zip"/, 'unsaved remote link absolute');
});

test('grabber finds links that only exist inside JavaScript text', async () => {
  const files = [];
  await explore({ startUrl: base + '/site/index.html', levelsThis: 0, exts: ['png'] }, { signal: new AbortController().signal, onFile: f => files.push(f) });
  assert.deepStrictEqual(files.map(f => f.name), ['from-js.png']);
});

test('API: extension origin gets CORS, web origins do not; token still required', async () => {
  const m = mk('cors');
  const s = createServer(m, { port: 0 });
  const port = await s.listen();
  const get = (headers, method = 'GET') => new Promise(r => http.request({ host: '127.0.0.1', port, path: '/api/state', method, headers }, res => { res.resume(); r({ code: res.statusCode, acao: res.headers['access-control-allow-origin'] }); }).end());
  const ext = await get({ Origin: 'chrome-extension://abcdef', 'X-Token': s.token });
  assert.strictEqual(ext.acao, 'chrome-extension://abcdef');
  assert.strictEqual((await get({ Origin: 'chrome-extension://abcdef' }, 'OPTIONS')).code, 204);
  assert.strictEqual((await get({ Origin: 'https://evil.example', 'X-Token': s.token })).acao, undefined);
  assert.strictEqual((await get({ Origin: 'chrome-extension://abcdef' })).code, 401);
  assert.strictEqual(m.token(), s.token, 'token is persisted');
  s.server.close(); await m.shutdown();
});
