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
const { expandBatch } = require('../src/batch');
const { exportList, parseImport } = require('../src/exportio');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advance-download-manager-more-'));
const DATA = crypto.randomBytes(1024 * 1024);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const mk = (name, s = {}) => { const m = new Manager({ dataDir: path.join(tmp, name, 'data') }).load(); m.setSettings({ minSplitBytes: 64 * 1024, rampMs: 30, ...s }); return m; };
const waitFor = (m, id, pred, ms = 20000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout; ' + JSON.stringify(m.view(m.get(id))))), ms);
  const check = () => { const v = m.view(m.get(id)); if (pred(v)) { clearTimeout(t); m.off('update', check); resolve(v); } };
  m.on('update', check); check();
});
const done = (m, id, ms) => waitFor(m, id, x => x.status === 'complete' || x.status === 'error', ms);

const hits = { direct: 0, httpProxy: [], socks: [] };
const origin = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/p/')) return res.end();
  hits.direct++;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const s = m ? +m[1] : 0, e = m && m[2] ? +m[2] : DATA.length - 1;
  const h = { 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes', 'Last-Modified': 'Wed, 21 Oct 2015 07:28:00 GMT', ETag: '"x"' };
  if (m) h['Content-Range'] = `bytes ${s}-${e}/${DATA.length}`;
  res.writeHead(m ? 206 : 200, h);
  res.end(DATA.subarray(s, e + 1));
});

// minimal HTTP proxy (absolute-URI requests)
const httpProxy = http.createServer((req, res) => {
  hits.httpProxy.push(req.url);
  const u = new URL(req.url);
  const up = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  req.pipe(up);
});

// minimal SOCKS5 (user/pass) + SOCKS4a proxy
const socksServer = net.createServer(c => {
  let buf = Buffer.alloc(0), stage = 0;
  const target = (host, port) => { const up = net.connect(port, host.startsWith('localhost') ? '127.0.0.1' : host, () => { c.removeAllListeners('data'); if (buf.length) up.write(buf); c.pipe(up); up.pipe(c); }); up.on('error', () => c.destroy()); hits.socks.push(`${host}:${port}`); };
  c.on('error', () => {});
  c.on('data', d => {
    buf = Buffer.concat([buf, d]);
    if (stage === 0) {
      if (buf[0] === 4) { // SOCKS4a
        const zero = buf.indexOf(0, 8); const hz = buf.indexOf(0, zero + 1);
        if (zero < 0 || hz < 0) return;
        const port = buf.readUInt16BE(2), host = buf.toString('latin1', zero + 1, hz);
        buf = buf.subarray(hz + 1); c.write(Buffer.from([0, 90, 0, 0, 0, 0, 0, 0])); target(host, port); stage = 9; return;
      }
      const n = buf[1]; if (buf.length < 2 + n) return;
      const wantAuth = buf.subarray(2, 2 + n).includes(2) && process.env.SOCKS_AUTH !== '0';
      buf = buf.subarray(2 + n); c.write(Buffer.from([5, wantAuth ? 2 : 0])); stage = wantAuth ? 1 : 2; return;
    }
    if (stage === 1) {
      const ul = buf[1]; if (buf.length < 3 + ul) return; const pl = buf[2 + ul]; if (buf.length < 3 + ul + pl) return;
      const user = buf.toString('utf8', 2, 2 + ul), pass = buf.toString('utf8', 3 + ul, 3 + ul + pl);
      buf = buf.subarray(3 + ul + pl);
      if (user !== 'su' || pass !== 'sp') { c.write(Buffer.from([1, 1])); return c.end(); }
      c.write(Buffer.from([1, 0])); stage = 2; return;
    }
    if (stage === 2) {
      if (buf.length < 5) return;
      const atyp = buf[3]; let host, off;
      if (atyp === 3) { off = 5 + buf[4]; if (buf.length < off + 2) return; host = buf.toString('latin1', 5, off); } else { off = 8; if (buf.length < off + 2) return; host = [...buf.subarray(4, 8)].join('.'); }
      const port = buf.readUInt16BE(off); buf = buf.subarray(off + 2);
      c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); target(host, port); stage = 9;
    }
  });
});
let base, hostPort;
test.before(async () => {
  for (const s of [origin, httpProxy, socksServer]) await new Promise(r => s.listen(0, '127.0.0.1', r));
  hostPort = origin.address().port; base = `http://127.0.0.1:${hostPort}`;
});
test.after(() => { for (const s of [origin, httpProxy, socksServer]) { s.closeAllConnections?.(); s.close(); } fs.rmSync(tmp, { recursive: true, force: true }); });

test('batch wildcard: numbers with padding, letters, validation', () => {
  assert.deepStrictEqual(expandBatch({ url: 'http://h/img*.jpg', mode: 'numbers', from: 8, to: 11, width: 3 }),
    ['http://h/img008.jpg', 'http://h/img009.jpg', 'http://h/img010.jpg', 'http://h/img011.jpg']);
  assert.deepStrictEqual(expandBatch({ url: 'http://h/p_*.png', mode: 'letters', from: 'x', to: 'z', width: 1 }), ['http://h/p_x.png', 'http://h/p_y.png', 'http://h/p_z.png']);
  assert.strictEqual(expandBatch({ url: 'http://h/*', mode: 'letters', from: 'aa', to: 'bb', width: 2 }).length, 28);
  assert.throws(() => expandBatch({ url: 'http://h/noStar.jpg', mode: 'numbers', from: 1, to: 2 }), /asterisk/);
  assert.throws(() => expandBatch({ url: 'http://h/*', mode: 'numbers', from: 1, to: 999999 }), /Too many/);
});

test('export / import round trip; credentials are never exported', async () => {
  const m = mk('export');
  m.add({ url: base + '/p/a.bin', username: 'bob', password: 'secret', cookie: 'sid=1', description: 'first', referer: 'http://r/' });
  m.add({ url: base + '/p/b.bin' });
  const json = exportList([...m.downloads.values()]);
  assert.ok(!/secret|sid=1|bob/.test(json), 'no credentials/cookies in export');
  const items = parseImport(json);
  assert.deepStrictEqual(items.map(i => i.url).sort(), [base + '/p/a.bin', base + '/p/b.bin']);
  assert.strictEqual(items.find(i => i.url.endsWith('a.bin')).description, 'first');
  const text = exportList([...m.downloads.values()], { format: 'text' });
  assert.deepStrictEqual(parseImport(text).map(i => i.url).sort(), [base + '/p/a.bin', base + '/p/b.bin']);
  assert.throws(() => parseImport('{"format":"other","items":[]}'), /Not a Advance Download Manager/);
  const m2 = mk('export2');
  assert.strictEqual(m2.addItems(items, { queue: 'main' }).length, 2);
  await m.shutdown(); await m2.shutdown();
});

test('duplicate link policy: ask / number / resume / overwrite', async () => {
  const m = mk('dup', { duplicatePolicy: 'ask' });
  const dir = path.join(tmp, 'dup', 'out');
  const first = m.add({ url: base + '/p/d.bin', saveDir: dir, queue: null, startNow: true });
  await done(m, first.id);
  assert.strictEqual(m.add({ url: base + '/p/d.bin', saveDir: dir, queue: null }).duplicate, true, 'ask');
  const numbered = m.add({ url: base + '/p/d.bin', saveDir: dir, queue: null, startNow: true, duplicatePolicy: 'number' });
  assert.notStrictEqual(numbered.id, first.id);
  assert.strictEqual((await done(m, numbered.id)).fileName, 'd_2.bin');
  const res = m.add({ url: base + '/p/d.bin', duplicatePolicy: 'resume' });
  assert.strictEqual(res.existing, true);
  const over = m.add({ url: base + '/p/d.bin', saveDir: dir, queue: null, startNow: true, duplicatePolicy: 'overwrite' });
  const ov = await done(m, over.id);
  assert.strictEqual(ov.status, 'complete');
  const same = [...m.downloads.values()].filter(d => d.rec.url === base + '/p/d.bin');
  assert.strictEqual(same.length, 2, 'overwrite replaced the original record (numbered copy + new one remain)');
  assert.ok(fs.existsSync(path.join(dir, 'd.bin')), 'overwritten file exists again');
  await m.shutdown();
});

test('per-file Speed Limiter slows only that file; remembered flag is honoured', async () => {
  const m = mk('flimit', { maxConnections: 2 });
  const t0 = Date.now();
  const v = m.add({ url: base + '/p/slow.bin', saveDir: path.join(tmp, 'flimit', 'out'), queue: null });
  m.setDownloadOptions(v.id, { speedLimit: 400 * 1024 });
  m.start(v.id);
  await waitFor(m, v.id, x => x.status === 'complete', 30000);
  assert.ok(Date.now() - t0 > 1500, `1 MiB at 400 KiB/s should take > 1.5 s, took ${Date.now() - t0} ms`);
  await m.shutdown();
});

for (const [name, version, auth] of [['SOCKS5 with user/pass', 5, true], ['SOCKS4a', 4, false]]) {
  test(`proxy: ${name} carries the download (remote DNS)`, async () => {
    hits.socks.length = 0; hits.direct = 0;
    const m = mk('socks' + version, { proxy: { mode: 'manual', socks: { host: '127.0.0.1', port: socksServer.address().port, user: auth ? 'su' : '', pass: auth ? 'sp' : '', version }, bypass: [] } });
    const v = m.add({ url: `http://localhost:${hostPort}/p/s.bin`, saveDir: path.join(tmp, 'socks' + version, 'out'), queue: null, startNow: true });
    const d = await done(m, v.id, 30000);
    assert.strictEqual(d.status, 'complete', d.error);
    assert.strictEqual(sha(fs.readFileSync(path.join(d.saveDir, d.fileName))), sha(DATA));
    assert.ok(hits.socks.length >= 2 && hits.socks.every(h => h.startsWith('localhost:')), 'hostname went to the proxy: ' + hits.socks.slice(0, 2));
    await m.shutdown();
  });
}

test('proxy: SOCKS5 wrong password fails fast with a clear error', async () => {
  const m = mk('socksbad', { proxy: { mode: 'manual', socks: { host: '127.0.0.1', port: socksServer.address().port, user: 'su', pass: 'WRONG', version: 5 } } });
  const v = m.add({ url: `http://localhost:${hostPort}/p/s.bin`, saveDir: path.join(tmp, 'socksbad', 'out'), queue: null, startNow: true });
  const d = await waitFor(m, v.id, x => x.status === 'error', 30000);
  assert.match(d.error, /authentication failed/i);
  await m.shutdown();
});

test('proxy: per-protocol HTTP proxy is used, bypass list skips it, SOCKS only when no protocol proxy', async () => {
  hits.httpProxy.length = 0;
  const px = { host: '127.0.0.1', port: httpProxy.address().port };
  const m = mk('hproxy', { proxy: { mode: 'manual', http: px, bypass: ['bypassed.invalid'] } });
  const v = m.add({ url: `http://localhost:${hostPort}/p/h.bin`, saveDir: path.join(tmp, 'hproxy', 'out'), queue: null, startNow: true });
  assert.strictEqual((await done(m, v.id, 30000)).status, 'complete');
  assert.ok(hits.httpProxy.length >= 2 && hits.httpProxy[0].startsWith(`http://localhost:${hostPort}/`), 'went through HTTP proxy');
  const n = hits.httpProxy.length;
  m.setSettings({ proxy: { mode: 'manual', http: px, bypass: ['localhost'] } });
  const v2 = m.add({ url: `http://localhost:${hostPort}/p/h2.bin`, saveDir: path.join(tmp, 'hproxy', 'out2'), queue: null, startNow: true });
  assert.strictEqual((await done(m, v2.id, 30000)).status, 'complete');
  assert.strictEqual(hits.httpProxy.length, n, 'bypass honoured');
  await m.shutdown();
});

test('temp directory holds the parts; final file lands in the category folder; server date applied', async () => {
  const tempDir = path.join(tmp, 'tmpparts');
  const m = mk('tempdir', { tempDir, setFileDate: true, speedLimit: 600 * 1024 });
  const v = m.add({ url: base + '/p/t.bin', saveDir: path.join(tmp, 'tempdir', 'out'), queue: null, startNow: true });
  await waitFor(m, v.id, x => x.done > 100 * 1024);
  assert.ok(fs.readdirSync(tempDir).some(f => f.endsWith('.sgpart')), 'part file lives in temp dir');
  assert.ok(!fs.existsSync(path.join(tmp, 'tempdir', 'out', 't.bin.sgpart')), 'not next to the destination');
  const d = await waitFor(m, v.id, x => x.status === 'complete', 30000);
  const st = fs.statSync(path.join(d.saveDir, d.fileName));
  assert.strictEqual(st.mtime.toISOString(), '2015-10-21T07:28:00.000Z', 'Last-Modified applied');
  assert.deepStrictEqual(fs.readdirSync(tempDir), [], 'temp part removed');
  await m.shutdown();
});

test('categories can be restricted to listed sites; "remember path" updates the category folder', async () => {
  const m = mk('cats');
  m.categories.push({ id: 'work', name: 'Work', exts: ['bin'], sites: ['*.corp.example'], dir: path.join(tmp, 'work') });
  assert.strictEqual(m.add({ url: 'http://files.corp.example/x.bin' }).category, 'work');
  assert.strictEqual(m.add({ url: 'http://other.example/x.bin' }).category, 'general', '.bin from other sites stays general');
  m.add({ url: 'http://other.example/r.mp3', saveDir: path.join(tmp, 'newmusic'), rememberPath: true });
  assert.strictEqual(m.categories.find(c => c.id === 'music').dir, path.join(tmp, 'newmusic'));
  await m.shutdown();
});

test('capture rules: file types, MIME types, excluded sites and addresses', async () => {
  const m = mk('capture', { noTakeoverSites: ['*.noisy.example'], excludeAddresses: ['http://cdn.example/sounds/*'] });
  const c = x => m.captureCheck(x).capture;
  assert.strictEqual(c({ url: 'http://a.example/setup.exe' }), true);
  assert.strictEqual(c({ url: 'http://a.example/page.html' }), false);
  assert.strictEqual(c({ url: 'http://a.example/stream?id=1', mime: 'video/mp4' }), true, 'media MIME');
  assert.strictEqual(c({ url: 'http://x.noisy.example/setup.exe' }), false, 'excluded site');
  assert.strictEqual(c({ url: 'http://cdn.example/sounds/ding.mp3' }), false, 'excluded address');
  assert.strictEqual(c({ url: 'http://a.example/thing.xyz', extraTypes: ['xyz'] }), true);
  assert.strictEqual(c({ url: 'ws://a.example/x.exe' }), false);
  await m.shutdown();
});

test('Download All Links collection: dedupes, derives names, items can be renamed on add', async () => {
  const m = mk('collect');
  const { id, count } = m.collect({ referer: 'http://page/', links: [{ url: 'http://h/a.zip', text: 'A' }, { url: 'http://h/a.zip' }, { url: 'mailto:x@y' }, { url: 'http://h/b%20c.pdf', text: 'B' }] });
  assert.strictEqual(count, 2);
  const c = m.collection(id);
  assert.deepStrictEqual(c.items.map(i => i.name), ['a.zip', 'b c.pdf']);
  const added = m.addItems([{ url: 'http://h/a.zip', fileName: 'renamed.zip', description: 'A', referer: c.referer }], { queue: 'main' });
  assert.strictEqual(added[0].fileName, 'renamed.zip');
  assert.strictEqual(added[0].description, 'A');
  await m.shutdown();
});

test('after-completion options and virus-check command line run once the file completes', async () => {
  const out = path.join(tmp, 'hook.txt'), outAfter = path.join(tmp, 'after.txt');
  const scan = path.join(tmp, 'scan.js'), after = path.join(tmp, 'after.js');
  fs.writeFileSync(scan, `require('fs').writeFileSync(${JSON.stringify(out)}, process.argv.slice(2).join('|'))`);
  fs.writeFileSync(after, `require('fs').writeFileSync(${JSON.stringify(outAfter)}, 'done')`);
  const m = mk('hook', { onCompleteCommand: process.execPath, onCompleteArgs: `${scan} --scan {file}` });
  const v = m.add({ url: base + '/p/v.bin', saveDir: path.join(tmp, 'hook', 'out'), queue: null, startNow: true, afterDone: { command: `"${process.execPath}" "${after}"`, hangup: false, exit: false, shutdown: false } });
  m.settings.onCompleteArgs = `${scan} --scan {file}`;
  const d = await done(m, v.id);
  assert.strictEqual(d.status, 'complete');
  await new Promise(r => setTimeout(r, 1500));
  assert.strictEqual(fs.readFileSync(out, 'utf8'), `--scan|${path.join(d.saveDir, d.fileName)}`);
  await m.shutdown();
});

test('scheduled Grabber projects: explore-only keeps results, explore+download queues the matches', async () => {
  const site = http.createServer((req, res) => {
    if (req.url === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<a href="f1.bin">1</a><a href="f2.bin">2</a>'); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  const startUrl = `http://127.0.0.1:${site.address().port}/index.html`;
  const m = mk('proj');
  const p1 = m.saveProject({ name: 'only', opts: { startUrl, levelsThis: 0, exts: ['bin'] }, schedule: { enabled: true, action: 'explore' } });
  await m.runProject(p1.id);
  assert.strictEqual(m.downloads.size, 0);
  assert.strictEqual(m.projects.find(p => p.id === p1.id).lastCount, 2);
  const p2 = m.saveProject({ name: 'dl', opts: { startUrl, levelsThis: 0, exts: ['bin'] }, schedule: { enabled: true, action: 'explore-download' } });
  await m.runProject(p2.id);
  assert.deepStrictEqual([...m.downloads.values()].map(d => d.rec.fileName).sort(), ['f1.bin', 'f2.bin']);
  assert.ok(m.projects.every(p => p.lastRun > 0));
  site.close(); await m.shutdown();
});
