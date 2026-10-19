'use strict';
// Engine rules (see src/policy.js).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const policy = require('../src/policy');
const { Manager } = require('../src/manager');
const { exportList, parseImport, parseIef, toIef } = require('../src/exportio');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advance-download-manager-ief-'));
const DATA = crypto.randomBytes(6 * 1024 * 1024);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const mk = (name, s = {}) => { const m = new Manager({ dataDir: path.join(tmp, name, 'data') }).load(); m.setSettings({ minSplitBytes: 64 * 1024, rampMs: 30, ...s }); return m; };
const waitFor = (m, id, pred, ms = 30000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout; ' + JSON.stringify(m.view(m.get(id))))), ms);
  const check = () => { const v = m.view(m.get(id)); if (pred(v)) { clearTimeout(t); m.off('update', check); resolve(v); } };
  m.on('update', check); check();
});
const done = (m, id, ms) => waitFor(m, id, x => x.status === 'complete' || x.status === 'error', ms);

const reqs = []; // {path, start, t}
const origin = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const s = m ? +m[1] : 0, e = m && m[2] ? Math.min(+m[2], DATA.length - 1) : DATA.length - 1;
  reqs.push({ path: u.pathname, start: s, end: e, t: Date.now() });
  const corrupt = u.pathname === '/corrupt' && s > 0; // a broken mirror: every ranged continuation returns different bytes
  const body = Buffer.from(DATA.subarray(s, e + 1));
  if (corrupt) for (let i = 0; i < body.length; i++) body[i] ^= 0xff;
  const h = { 'Content-Length': body.length, 'Accept-Ranges': 'bytes' };
  if (m) h['Content-Range'] = `bytes ${s}-${e}/${DATA.length}`;
  res.writeHead(m ? 206 : 200, h);
  let off = 0;
  const pump = () => { if (res.destroyed) return; res.write(body.subarray(off, off + 16384)); off += 16384; off >= body.length ? res.end() : setTimeout(pump, 8); };
  pump();
});
let base;
test.before(async () => { await new Promise(r => origin.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${origin.address().port}`; });
test.after(() => { origin.closeAllConnections?.(); origin.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('policy: connection count follows policy (1 per 10 KB remaining, <= configured, <= 32)', () => {
  assert.strictEqual(policy.connectionsFor(5000, 8), 1, 'tiny file -> one connection');
  assert.strictEqual(policy.connectionsFor(0x2800, 8), 1, '10240 bytes is still one');
  assert.strictEqual(policy.connectionsFor(0x2801, 8), 1);
  assert.strictEqual(policy.connectionsFor(3 * 10240, 8), 3);
  assert.strictEqual(policy.connectionsFor(100000, 8), 8);
  assert.strictEqual(policy.connectionsFor(100000, 64), 9, 'floor(100000 / 10240)');
  assert.strictEqual(policy.connectionsFor(50e6, 64), 32, 'absolute ceiling');
  assert.strictEqual(policy.nextConnections(1), 2);
  assert.strictEqual(policy.nextConnections(4), 8);
  assert.deepStrictEqual([2, 4, 6, 8].map(n => policy.nextConnections(n, true)), [3, 6, 8, 16]);
  assert.strictEqual(policy.OVERLAP, 64);
  assert.strictEqual(policy.MIN_RETRY_MS, 30000);
  assert.strictEqual(new Manager({ dataDir: path.join(tmp, 'def') }).settings.retryIntervalMs, policy.MIN_RETRY_MS, 'default retry interval = 30 s');
});

test('ramp-up: starts with one connection, then doubles no sooner than rampMs, never beyond what the size allows', async () => {
  reqs.length = 0;
  const m = mk('ramp', { maxConnections: 8, rampMs: 400, autoTune: false }); // the fixed ramp-up (auto-tuning is tested in tuner.test.js / autotune.test.js)
  const v = m.add({ url: base + '/ok', saveDir: path.join(tmp, 'ramp', 'o'), queue: null, startNow: true });
  const d = await done(m, v.id);
  assert.strictEqual(d.status, 'complete', d.error);
  assert.strictEqual(sha(fs.readFileSync(path.join(d.saveDir, d.fileName))), sha(DATA));
  const t = reqs.filter(r => r.end > 0 && !(r.start === 0 && r.end === 0)).map(r => r.t); // exclude the 0-0 probe
  assert.ok(t.length >= 3, 'got connections: ' + t.length);
  assert.ok(t[1] - t[0] >= 250, `second connection must wait ~rampMs after the first (${t[1] - t[0]} ms)`);
  assert.ok(t[2] - t[1] >= 250, `third must wait another rampMs (${t[2] - t[1]} ms)`);
  if (t[3]) assert.ok(t[3] - t[2] < 300, '1 -> 2 -> 4: the two new connections start together');
  await m.shutdown();
});

test('resume re-reads the last 64 bytes before the saved position (corruption guard)', async () => {
  reqs.length = 0;
  const dir = path.join(tmp, 'resume', 'o');
  let m = mk('resume', { maxConnections: 2 });
  const v = m.add({ url: base + '/ok', saveDir: dir, queue: null, startNow: true });
  await waitFor(m, v.id, x => x.done > 500 * 1024);
  await m.stop(v.id);
  const saved = m.get(v.id).rec.segments.map(g => ({ ...g }));
  await m.shutdown();
  m = new Manager({ dataDir: path.join(tmp, 'resume', 'data') }).load();
  m.setSettings({ minSplitBytes: 64 * 1024, rampMs: 30, maxConnections: 2 });
  reqs.length = 0;
  m.start(v.id);
  const d = await done(m, v.id);
  assert.strictEqual(d.status, 'complete', d.error);
  assert.strictEqual(sha(fs.readFileSync(path.join(dir, d.fileName))), sha(DATA));
  const unfinished = saved.filter(g => g.p < g.e && g.p >= 64);
  assert.ok(unfinished.length > 0);
  for (const g of unfinished) assert.ok(reqs.some(r => r.start === g.p - 64), `a request must start at ${g.p} - 64; saved=${JSON.stringify(saved)} requests=${JSON.stringify(reqs.map(r => [r.start, r.end]))}`);
  assert.ok(!m.get(v.id).rec.singleConn, 'a consistent server never triggers the fallback');
  await m.shutdown();
});

test('inconsistent data from different connections -> detected -> restarted with ONE connection -> correct file', async () => {
  reqs.length = 0;
  const m = mk('corrupt', { maxConnections: 4 });
  const v = m.add({ url: base + '/corrupt', saveDir: path.join(tmp, 'corrupt', 'o'), queue: null, startNow: true });
  const d = await done(m, v.id, 60000);
  assert.strictEqual(d.status, 'complete', d.error);
  assert.strictEqual(sha(fs.readFileSync(path.join(d.saveDir, d.fileName))), sha(DATA), 'final file must be the correct bytes');
  const rec = m.get(v.id).rec;
  assert.strictEqual(rec.singleConn, true);
  assert.match(rec.warning, /one connection/);
  assert.match(m.view(m.get(v.id)).warning, /corruption/i, 'the view carries the warning for the UI');
  await m.shutdown();
});

test('IEF / EF2 export format: round trip + hand-written file with every field, LF or CRLF', () => {
  const m = new Manager({ dataDir: path.join(tmp, 'ief') });
  m.settings.dummy = 1;
  const fake = [{ rec: { url: 'http://a.example/x.zip', referer: 'http://a.example/', userAgent: 'UA/1', cookie: 'secret=1' } }, { rec: { url: 'ftp://f.example/y.iso' } }];
  const ief = exportList(fake, { format: 'ief' });
  assert.ok(ief.startsWith('<\r\nhttp://a.example/x.zip\r\nreferer: http://a.example/\r\nUser-Agent: UA/1\r\n>\r\n'));
  assert.ok(!ief.includes('secret'), 'cookies are never exported');
  assert.deepStrictEqual(parseImport(ief).map(i => i.url), ['http://a.example/x.zip', 'ftp://f.example/y.iso']);
  const iefText = '<\r\nhttp://h.example/a.bin\r\nreferer: http://h.example/p\r\ncookie: sid=9\r\npd: a=b\r\nUser-Agent: Mozilla\r\n>\r\n<\r\nhttps://h.example/b.bin\r\n>\r\n';
  const items = parseIef(iefText);
  assert.deepStrictEqual(items, [{ url: 'http://h.example/a.bin', referer: 'http://h.example/p', cookie: 'sid=9', userAgent: 'Mozilla' }, { url: 'https://h.example/b.bin' }]);
  assert.strictEqual(parseIef(iefText.replace(/\r\n/g, '\n')).length, 2, 'LF endings accepted');
  assert.throws(() => parseImport('<\r\nnot a url\r\n>\r\n'), /not a valid export file/);
  assert.strictEqual(toIef([]), '');
  const mgr = new Manager({ dataDir: path.join(tmp, 'ief2') }).load();
  const added = mgr.addItems(items, { queue: 'main' });
  assert.strictEqual(added[0].referer, 'http://h.example/p');
  assert.strictEqual(mgr.get(added[0].id).rec.cookie, 'sid=9', 'cookie from an IEF file is used for that download');
  mgr.shutdown();
});
