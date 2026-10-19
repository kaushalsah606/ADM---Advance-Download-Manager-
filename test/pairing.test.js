'use strict';
// Browser-extension pairing (no token pasting), the capture PAC script and the port fallback.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Manager } = require('../src/manager');
const { createServer } = require('../src/server');
const syscapture = require('../src/syscapture');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-pair-'));
let m, srv, port;
test.before(async () => {
  m = new Manager({ dataDir: path.join(tmp, 'data') }).load();
  srv = createServer(m, { port: 0 });
  port = await srv.listen();
});
test.after(async () => { await m.shutdown(); srv.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function call(method, p, { origin, token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(origin ? { Origin: origin } : {}), ...(token ? { 'X-Token': token } : {}), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => { const t = Buffer.concat(c).toString(); let j; try { j = JSON.parse(t); } catch { j = t; } resolve({ status: res.statusCode, body: j, headers: res.headers }); });
    });
    req.on('error', reject); req.end(data);
  });
}
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

test('a web page (non-extension origin) cannot pair', async () => {
  assert.strictEqual((await call('POST', '/api/pair', { origin: 'https://evil.example', body: {} })).status, 403);
  assert.strictEqual((await call('POST', '/api/pair', { body: {} })).status, 403);
});

test('extension pairs: pending until the user allows, then it receives the token and port', async () => {
  const first = await call('POST', '/api/pair', { origin: ORIGIN, body: { name: 'Advance Download Manager Integration', browser: 'Edge' } });
  assert.strictEqual(first.status, 202);
  assert.strictEqual(first.body.pending, true);
  assert.ok(!JSON.stringify(first.body).includes(srv.token), 'no token while pending');
  assert.strictEqual(m.snapshot().pendingPairs.length, 1, 'the request is visible to the UI');
  assert.strictEqual((await call('POST', '/api/pair', { origin: ORIGIN, body: {} })).status, 202, 'asking again does not create a second request');
  assert.strictEqual(m.snapshot().pendingPairs.length, 1);

  // only the token holder (the app UI) can decide
  assert.strictEqual((await call('POST', '/api/pair/decision', { body: { origin: ORIGIN, allow: true } })).status, 401);
  const ok = await call('POST', '/api/pair/decision', { token: srv.token, body: { origin: ORIGIN, allow: true } });
  assert.strictEqual(ok.body.ok, true);

  const paired = await call('POST', '/api/pair', { origin: ORIGIN, body: {} });
  assert.strictEqual(paired.status, 200);
  assert.strictEqual(paired.body.token, srv.token);
  assert.strictEqual(paired.body.port, port);
  assert.strictEqual(m.snapshot().pendingPairs.length, 0);
  assert.strictEqual(m.settings.pairedExtensions[0].origin, ORIGIN);
  assert.strictEqual(m.settings.pairedExtensions[0].browser, 'Edge');
});

test('another extension needs its own approval; the token works for the API; revoking pairing takes effect', async () => {
  const other = 'moz-extension://11111111-2222-4333-8444-555555555555';
  assert.strictEqual((await call('POST', '/api/pair', { origin: other, body: {} })).status, 202);
  assert.strictEqual((await call('GET', '/api/state', { origin: ORIGIN, token: srv.token })).status, 200);
  await call('POST', '/api/pair/decision', { token: srv.token, body: { origin: other, allow: false } });
  const denied = await call('POST', '/api/pair', { origin: other, body: {} });
  assert.strictEqual(denied.status, 202);
  assert.strictEqual(denied.body.denied, true, 'a refusal is remembered for a while');
  assert.strictEqual(m.snapshot().pendingPairs.length, 0);

  await call('POST', '/api/pair/revoke', { token: srv.token, body: { origin: ORIGIN } });
  assert.strictEqual((await call('POST', '/api/pair', { origin: ORIGIN, body: {} })).status, 202, 'revoked: must be approved again');
  assert.strictEqual((await call('GET', '/api/pair', { token: srv.token })).body.pending.length, 1);
});

test('pairing survives a restart (stored in the settings)', async () => {
  await call('POST', '/api/pair/decision', { token: srv.token, body: { origin: ORIGIN, allow: true } });
  m.saveNow();
  const again = new Manager({ dataDir: path.join(tmp, 'data') }).load();
  assert.ok(again.settings.pairedExtensions.some(p => p.origin === ORIGIN));
  await again.shutdown();
});

test('capture PAC: plain HTTP goes to the capture proxy, everything else direct, and every answer ends in DIRECT', async () => {
  const r = await call('GET', '/capture.pac');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['content-type'], /proxy-autoconfig/);
  const pac = String(r.body);
  assert.match(pac, /PROXY 127\.0\.0\.1:6801; DIRECT/);
  assert.match(pac, /url\.substring\(0, 5\) !== 'http:'\) return 'DIRECT'/);
  // evaluate the script like a browser would
  const vm = require('vm');
  const ctx = { isPlainHostName: h => !h.includes('.'), shExpMatch: (h, p) => new RegExp('^' + p.replace(/\*/g, '.*') + '$').test(h), isInNet: (h, a, mk) => /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(h) };
  vm.createContext(ctx); vm.runInContext(pac, ctx);
  assert.strictEqual(vm.runInContext("FindProxyForURL('http://files.example.com/a.zip', 'files.example.com')", ctx), 'PROXY 127.0.0.1:6801; DIRECT');
  assert.strictEqual(vm.runInContext("FindProxyForURL('https://files.example.com/a.zip', 'files.example.com')", ctx), 'DIRECT');
  assert.strictEqual(vm.runInContext("FindProxyForURL('http://192.168.1.5/x', '192.168.1.5')", ctx), 'DIRECT');
  assert.strictEqual(vm.runInContext("FindProxyForURL('http://localhost:6800/', 'localhost')", ctx), 'DIRECT');
  assert.ok(syscapture.pacScript(1234).includes('PROXY 127.0.0.1:1234; DIRECT'));
});

test('system capture API reports its state (switching it on is tested on Windows only)', async () => {
  const s = await call('GET', '/api/system-capture', { token: srv.token });
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.body.enabled, false);
  assert.strictEqual(s.body.supported, process.platform === 'win32');
  if (process.platform !== 'win32') assert.strictEqual((await call('POST', '/api/system-capture', { token: srv.token, body: { enabled: true } })).status, 400);
});

test('if the default port is taken the server uses a fallback port', async () => {
  const blocker = net.createServer(); await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port;
  const m2 = new Manager({ dataDir: path.join(tmp, 'data2') }).load();
  const s2 = createServer(m2, { port: taken, fallbackPorts: [0] });
  const p2 = await s2.listen();
  assert.notStrictEqual(p2, taken);
  assert.ok(p2 > 0);
  s2.server.close(); blocker.close(); await m2.shutdown();
  // no fallback: the error is reported
  const blocker2 = net.createServer(); await new Promise(r => blocker2.listen(0, '127.0.0.1', r));
  const m3 = new Manager({ dataDir: path.join(tmp, 'data3') }).load();
  await assert.rejects(createServer(m3, { port: blocker2.address().port }).listen(), /EADDRINUSE/);
  blocker2.close(); await m3.shutdown();
});
