'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Manager } = require('../src/manager');
const { createServer } = require('../src/server');
const captureProxy = require('../src/captureproxy');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advance-download-manager-cp-'));
const ZIP = Buffer.alloc(200000, 5);
const seen = [];
const origin = http.createServer((req, res) => {
  seen.push({ url: req.url, headers: req.headers });
  if (req.url === '/files/big.zip') { res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': ZIP.length, 'Accept-Ranges': 'bytes' }); return res.end(ZIP); }
  if (req.url === '/dl.php') { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="report.dat"' }); return res.end('data!'); }
  if (req.url === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>hello</html>'); }
  if (req.url === '/echo' && req.method === 'POST') { const c = []; req.on('data', d => c.push(d)); req.on('end', () => { res.writeHead(200); res.end('got:' + Buffer.concat(c)); }); return; }
  res.writeHead(404); res.end('nope');
});
const echo = net.createServer(s => s.on('data', d => s.write(Buffer.concat([Buffer.from('ECHO:'), d]))));
let originPort, echoPort, manager, proxy, pport;
test.before(async () => {
  await new Promise(r => origin.listen(0, '127.0.0.1', r)); originPort = origin.address().port;
  await new Promise(r => echo.listen(0, '127.0.0.1', r)); echoPort = echo.address().port;
  manager = new Manager({ dataDir: path.join(tmp, 'data') }).load();
  manager.setSettings({ rampMs: 30, confirmDownloads: false }); // these tests are about the take-over itself; the confirmation dialog has its own test at the end
  proxy = captureProxy.create(manager, { port: 0, apiPort: 1 });
  pport = await proxy.listen();
});
test.after(async () => { await proxy.close(); await manager.shutdown(); origin.closeAllConnections?.(); origin.close(); echo.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const viaProxy = (target, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: pport, method, path: target, headers: { Host: new URL(target).host, ...headers } }, res => {
    const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) }));
  });
  req.on('error', reject); req.end(body);
});

test('ordinary pages and POSTs pass through the proxy unchanged', async () => {
  const before = manager.downloads.size;
  const page = await viaProxy(`http://127.0.0.1:${originPort}/index.html`);
  assert.strictEqual(page.status, 200); assert.strictEqual(page.body.toString(), '<html>hello</html>');
  const post = await viaProxy(`http://127.0.0.1:${originPort}/echo`, { method: 'POST', body: 'abc' });
  assert.strictEqual(post.body.toString(), 'got:abc');
  const nf = await viaProxy(`http://127.0.0.1:${originPort}/missing`);
  assert.strictEqual(nf.status, 404);
  assert.strictEqual(manager.downloads.size, before, 'nothing was captured');
});

test('a download (by MIME type) is taken over: client gets the Advance Download Manager page, the manager downloads the file with the client\'s referer, cookie and User-Agent', async () => {
  seen.length = 0;
  const r = await viaProxy(`http://127.0.0.1:${originPort}/files/big.zip`, { headers: { Referer: 'http://shop.example/page', Cookie: 'sid=77', 'User-Agent': 'TestBrowser/1' } });
  assert.strictEqual(r.status, 200);
  assert.match(r.body.toString(), /Advance Download Manager took over this download/);
  const d = [...manager.downloads.values()].find(x => x.rec.url.endsWith('/files/big.zip'));
  assert.ok(d, 'download created');
  assert.strictEqual(d.rec.referer, 'http://shop.example/page');
  assert.strictEqual(d.rec.cookie, 'sid=77');
  assert.strictEqual(d.rec.userAgent, 'TestBrowser/1');
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('timeout')), 15000); const c = () => { if (d.rec.status === 'complete' || d.rec.status === 'error') { clearTimeout(t); resolve(); } }; manager.on('update', c); c(); });
  assert.strictEqual(d.rec.status, 'complete', d.rec.error);
  assert.ok(seen.some(s => s.headers.cookie === 'sid=77' && s.headers['user-agent'] === 'TestBrowser/1'), 'Advance Download Manager reused the client\'s cookie and UA');
  assert.ok(fs.readFileSync(path.join(d.rec.saveDir, d.rec.fileName)).equals(ZIP));
});

test('Content-Disposition: attachment also triggers a take-over, unless the address/site is excluded', async () => {
  const r = await viaProxy(`http://127.0.0.1:${originPort}/dl.php`);
  assert.match(r.body.toString(), /took over/);
  manager.setSettings({ excludeAddresses: [`http://127.0.0.1:${originPort}/dl.php`] });
  const n = manager.downloads.size;
  const again = await viaProxy(`http://127.0.0.1:${originPort}/dl.php`);
  assert.strictEqual(again.body.toString(), 'data!', 'excluded: passes through');
  assert.strictEqual(manager.downloads.size, n);
  manager.setSettings({ excludeAddresses: [] });
});

test('Range requests are never captured (they are already someone\'s partial download)', async () => {
  const n = manager.downloads.size;
  const r = await viaProxy(`http://127.0.0.1:${originPort}/files/big.zip`, { headers: { Range: 'bytes=0-9' } });
  assert.ok([200, 206].includes(r.status));
  assert.strictEqual(manager.downloads.size, n);
});

test('CONNECT tunnels bytes without looking at them (HTTPS is never decrypted)', async () => {
  const sock = net.connect(pport, '127.0.0.1');
  const reply = await new Promise((resolve, reject) => {
    let buf = '';
    sock.on('data', d => { buf += d; if (buf.includes('\r\n\r\n') && !buf.includes('ECHO:')) sock.write('hello tunnel'); if (buf.includes('ECHO:hello tunnel')) resolve(buf); });
    sock.on('error', reject);
    sock.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
  assert.match(reply, /200 Connection Established/);
  sock.destroy();
});

test('abuse guards: origin-form requests, non-http schemes, Advance Download Manager\'s own API port', async () => {
  const origForm = await new Promise(resolve => http.get({ host: '127.0.0.1', port: pport, path: '/api/state' }, res => { res.resume(); resolve(res.statusCode); }));
  assert.strictEqual(origForm, 400, 'a web page cannot use the proxy as a normal server');
  const guarded = captureProxy.create(manager, { port: 0, apiPort: originPort });
  const gp = await guarded.listen();
  const blocked = await new Promise(resolve => http.request({ host: '127.0.0.1', port: gp, path: `http://127.0.0.1:${originPort}/index.html`, headers: { Host: `127.0.0.1:${originPort}` } }, res => { res.resume(); resolve(res.statusCode); }).end());
  assert.strictEqual(blocked, 403);
  const tunnel = await new Promise(resolve => { const s = net.connect(gp, '127.0.0.1', () => s.write(`CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\n\r\n`)); s.on('data', d => { resolve(String(d).split('\r\n')[0]); s.destroy(); }); });
  assert.match(tunnel, /403/);
  await guarded.close();
});

test('API: capture proxy can be started and stopped at run time', async () => {
  const m = new Manager({ dataDir: path.join(tmp, 'data2') }).load();
  const s = createServer(m, { port: 0, token: 't' });
  const p = await s.listen();
  const call = (method, route, body) => new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port: p, path: route, method, headers: { 'X-Token': 't', 'Content-Type': 'application/json' } }, res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString()))); });
    r.end(body ? JSON.stringify(body) : undefined);
  });
  const on = await call('POST', '/api/capture-proxy', { enabled: true, port: 0 });
  assert.strictEqual(on.running, true);
  assert.ok(on.port > 0 && (await call('GET', '/api/capture-proxy')).running);
  const off = await call('POST', '/api/capture-proxy', { enabled: false });
  assert.strictEqual(off.running, false);
  s.server.close(); await m.shutdown();
});

test('with confirmation on, a taken-over download waits as a "Download File Info" request and starts only when accepted', async () => {
  manager.setSettings({ confirmDownloads: true, excludeAddresses: [] });
  const before = manager.downloads.size;
  const r = await viaProxy(`http://127.0.0.1:${originPort}/files/big.zip`);
  assert.match(r.body.toString(), /took over/);
  assert.strictEqual(manager.downloads.size, before, 'nothing started yet');
  const pending = manager.snapshot().proposals.find(p => /files\/big\.zip$/.test(p.url));
  assert.ok(pending, 'a confirmation request exists');
  assert.strictEqual(pending.source, 'capture');
  manager.proposalReject(pending.id);
  manager.setSettings({ confirmDownloads: false });
});
