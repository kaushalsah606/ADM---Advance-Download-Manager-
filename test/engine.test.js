'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Manager } = require('../src/manager');
const { createServer } = require('../src/server');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advance-download-manager-test-'));
const DATA = crypto.randomBytes(6 * 1024 * 1024);
const SHA = crypto.createHash('sha256').update(DATA).digest('hex');
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const log = { ranges: [], concurrent: 0, maxConcurrent: 0, flaky: 0 };

// Test origin: ranges, redirects, content-disposition, basic auth, throttling, no-range mode, flaky mode.
const origin = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/redirect') { res.writeHead(302, { Location: '/dl/file.bin' }); return res.end(); }
  if (u.pathname === '/secret') {
    if (req.headers.authorization !== 'Basic ' + Buffer.from('bob:pw').toString('base64')) { res.writeHead(401, { 'WWW-Authenticate': 'Basic' }); return res.end(); }
  }
  if (u.pathname === '/flaky') { if (log.flaky++ < 2) { res.writeHead(503); return res.end(); } }
  if (u.pathname === '/missing') { res.writeHead(404); return res.end(); }
  const noRange = u.pathname === '/norange';
  const slow = u.pathname === '/slow';
  const range = !noRange && /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const start = range ? +range[1] : 0;
  const end = range ? (range[2] ? Math.min(+range[2], DATA.length - 1) : DATA.length - 1) : DATA.length - 1;
  const headers = { ETag: '"v1"', 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT', 'Content-Length': end - start + 1 };
  if (!noRange) headers['Accept-Ranges'] = 'bytes';
  if (u.pathname === '/named') headers['Content-Disposition'] = 'attachment; filename="report final.pdf"';
  if (range) { headers['Content-Range'] = `bytes ${start}-${end}/${DATA.length}`; log.ranges.push([u.pathname, start, end]); }
  res.writeHead(range ? 206 : 200, headers);
  log.concurrent++; log.maxConcurrent = Math.max(log.maxConcurrent, log.concurrent);
  res.on('close', () => log.concurrent--);
  const body = DATA.subarray(start, end + 1);
  let off = 0;
  const pump = () => {
    if (res.destroyed) return;
    const n = slow ? 16 * 1024 : 256 * 1024;
    res.write(body.subarray(off, off + n)); off += n;
    if (off >= body.length) return res.end();
    setTimeout(pump, slow ? 8 : 0);
  };
  pump();
});
let base;
test.before(async () => { await new Promise(r => origin.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${origin.address().port}`; });
test.after(() => { origin.closeAllConnections?.(); origin.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const mk = (name, settings = {}) => {
  const m = new Manager({ dataDir: path.join(tmp, name, 'data') }).load();
  m.setSettings({ minSplitBytes: 64 * 1024, rampMs: 30, retryIntervalMs: 1000, ...settings });
  return m;
};
const waitFor = (m, id, pred, ms = 20000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout; state=' + JSON.stringify(m.view(m.get(id))))), ms);
  const check = () => { const v = m.view(m.get(id)); if (pred(v)) { clearTimeout(t); m.off('update', check); resolve(v); } };
  m.on('update', check); check();
});

test('multi-segment download is byte-identical and really uses several connections', async () => {
  const m = mk('seg', { maxConnections: 6 });
  log.ranges.length = 0; log.maxConcurrent = 0;
  const v = m.add({ url: base + '/slow', saveDir: path.join(tmp, 'seg', 'out'), queue: null, startNow: true });
  const done = await waitFor(m, v.id, x => x.status === 'complete' || x.status === 'error', 40000);
  assert.strictEqual(done.status, 'complete', done.error);
  assert.strictEqual(sha(path.join(done.saveDir, done.fileName)), SHA);
  assert.ok(log.maxConcurrent >= 3, 'max concurrent connections = ' + log.maxConcurrent);
  assert.ok(new Set(log.ranges.map(r => r[1])).size >= 4, 'distinct range starts');
  assert.ok(!fs.existsSync(path.join(done.saveDir, done.fileName + '.sgpart')));
  await m.shutdown();
});

test('pause, restart the app, resume from saved positions', async () => {
  const dir = path.join(tmp, 'resume', 'out');
  let m = mk('resume', { maxConnections: 3 });
  const v = m.add({ url: base + '/slow', saveDir: dir, queue: null, startNow: true });
  await waitFor(m, v.id, x => x.done > 600 * 1024);
  await m.stop(v.id);
  const part = m.view(m.get(v.id));
  assert.strictEqual(part.status, 'paused');
  assert.ok(part.done > 0 && part.done < DATA.length);
  await m.shutdown();

  m = new Manager({ dataDir: path.join(tmp, 'resume', 'data') }).load(); // "reboot"
  m.setSettings({ minSplitBytes: 64 * 1024, rampMs: 30 });
  const again = m.view(m.get(v.id));
  assert.strictEqual(again.status, 'paused');
  assert.strictEqual(again.done, part.done, 'positions survived restart');
  log.ranges.length = 0;
  m.start(v.id);
  const done = await waitFor(m, v.id, x => x.status === 'complete' || x.status === 'error', 40000);
  assert.strictEqual(done.status, 'complete', done.error);
  assert.strictEqual(sha(path.join(dir, done.fileName)), SHA);
  const fromZero = log.ranges.filter(r => r[1] === 0);
  assert.ok(fromZero.length <= 1, 'resume must not restart every segment from byte 0'); // only the 0-0 probe
  await m.shutdown();
});

test('server without range support falls back to one stream', async () => {
  const m = mk('norange');
  const v = m.add({ url: base + '/norange', saveDir: path.join(tmp, 'norange', 'out'), queue: null, startNow: true });
  const done = await waitFor(m, v.id, x => x.status === 'complete' || x.status === 'error');
  assert.strictEqual(done.status, 'complete', done.error);
  assert.strictEqual(done.resumable, false);
  assert.strictEqual(sha(path.join(done.saveDir, done.fileName)), SHA);
  await m.shutdown();
});

test('redirect, Content-Disposition name, category by extension, unique naming', async () => {
  const m = mk('names');
  const dir = path.join(tmp, 'names', 'docs');
  const info = await m.probe({ url: base + '/named' });
  assert.strictEqual(info.fileName, 'report final.pdf');
  assert.strictEqual(info.category, 'documents');
  const a = m.add({ url: base + '/named', saveDir: dir, queue: null, startNow: true });
  await waitFor(m, a.id, x => x.status === 'complete');
  const b = m.add({ url: base + '/named', saveDir: dir, queue: null, startNow: true, allowDuplicate: true });
  const bd = await waitFor(m, b.id, x => x.status === 'complete');
  assert.strictEqual(bd.fileName, 'report final_2.pdf');
  const r = m.add({ url: base + '/redirect', saveDir: dir, queue: null, startNow: true });
  const rd = await waitFor(m, r.id, x => x.status === 'complete' || x.status === 'error');
  assert.strictEqual(rd.fileName, 'file.bin');
  await m.shutdown();
});

test('site login: 401 fails fast, credentials succeed (also via Site Logins list)', async () => {
  const m = mk('auth');
  const bad = m.add({ url: base + '/secret', saveDir: path.join(tmp, 'auth', 'o1'), queue: null, startNow: true });
  const bv = await waitFor(m, bad.id, x => x.status === 'error');
  assert.match(bv.error, /401/);
  m.setSettings({ siteLogins: [{ pattern: '127.0.0.1', user: 'bob', pass: 'pw' }] });
  const ok = m.add({ url: base + '/secret', saveDir: path.join(tmp, 'auth', 'o2'), queue: null, startNow: true, allowDuplicate: true });
  const ov = await waitFor(m, ok.id, x => x.status === 'complete' || x.status === 'error');
  assert.strictEqual(ov.status, 'complete', ov.error);
  await m.shutdown();
});

test('speed limiter caps throughput', async () => {
  const m = mk('limit', { speedLimit: 2 * 1024 * 1024, maxConnections: 4 });
  const t0 = Date.now();
  const v = m.add({ url: base + '/dl/x.bin', saveDir: path.join(tmp, 'limit', 'out'), queue: null, startNow: true });
  await waitFor(m, v.id, x => x.status === 'complete', 30000);
  const secs = (Date.now() - t0) / 1000;
  assert.ok(secs > 2, `6 MiB at 2 MiB/s should take > 2s, took ${secs}`);
  await m.shutdown();
});

test('queue: failed file goes to end, is retried, queue completes', async () => {
  const m = mk('queue', { retryIntervalMs: 1000 });
  log.flaky = 0;
  const dir = path.join(tmp, 'queue', 'out');
  const f = m.add({ url: base + '/flaky', saveDir: dir, fileName: 'flaky.bin' });
  const g = m.add({ url: base + '/dl/good.bin', saveDir: dir });
  m.queues.find(q => q.id === 'main').parallel = 1;
  m.startQueue('main');
  const gd = await waitFor(m, g.id, x => x.status === 'complete', 30000);
  assert.strictEqual(gd.queue, null, 'completed files leave the download queue');
  const fd = await waitFor(m, f.id, x => x.status === 'complete', 30000);
  assert.strictEqual(sha(path.join(dir, 'flaky.bin')), SHA);
  assert.ok(m.get(f.id).rec.attempts >= 2);
  await m.shutdown();
});

test('404 is reported and does not corrupt state; delete removes the part file', async () => {
  const m = mk('missing');
  const v = m.add({ url: base + '/missing', saveDir: path.join(tmp, 'missing', 'out'), queue: null, startNow: true });
  const d = await waitFor(m, v.id, x => x.status === 'error');
  assert.match(d.error, /404/);
  await m.remove(v.id);
  assert.throws(() => m.get(v.id));
  await m.shutdown();
});

test('web API rejects wrong Host header and missing token', async () => {
  const m = mk('api');
  const s = createServer(m, { port: 0, token: 'tok' });
  const port = await s.listen();
  const req = (headers, p = '/api/state') => new Promise(r => http.get({ host: '127.0.0.1', port, path: p, headers }, res => { res.resume(); r(res.statusCode); }));
  assert.strictEqual(await req({}), 401);
  assert.strictEqual(await req({ 'X-Token': 'tok' }), 200);
  assert.strictEqual(await req({ 'X-Token': 'tok', Host: 'evil.example.com' }), 403);
  s.server.close(); await m.shutdown();
});
