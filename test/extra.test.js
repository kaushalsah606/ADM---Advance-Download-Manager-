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
const { explore } = require('../src/grabber');
const U = require('../src/util');
const { Pac } = require('../src/pac');
const { startTray } = require('../src/tray');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advance-download-manager-extra-'));
const DATA = crypto.randomBytes(512 * 1024);
const mk = (name, s = {}) => { const m = new Manager({ dataDir: path.join(tmp, name, 'data') }).load(); m.setSettings({ minSplitBytes: 64 * 1024, rampMs: 30, ...s }); return m; };
const waitFor = (m, id, pred, ms = 20000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout; ' + JSON.stringify(m.view(m.get(id))))), ms);
  const check = () => { const v = m.view(m.get(id)); if (pred(v)) { clearTimeout(t); m.off('update', check); resolve(v); } };
  m.on('update', check); check();
});
const done = (m, id, ms) => waitFor(m, id, x => x.status === 'complete' || x.status === 'error', ms);

const seen = { sockets: new Map(), proxied: [], direct: 0 };
const origin = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/realm') { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Secret Area"' }); return res.end(); }
  if (u.pathname === '/gone') { res.writeHead(404); return res.end(); }
  if (u.pathname === '/reuse') { // second request on the same keep-alive socket is reset, like a server that timed the socket out
    const n = (seen.sockets.get(req.socket) || 0) + 1; seen.sockets.set(req.socket, n);
    if (n === 2) return req.socket.destroy();
    res.writeHead(200, { 'Content-Length': 2 }); return res.end('ok');
  }
  if (u.pathname === '/site/index.html') {
    if (req.headers.cookie !== 'sid=42') { res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<a href="a.bin">a</a>');
  }
  seen.direct++;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const s = m ? +m[1] : 0, e = m && m[2] ? +m[2] : DATA.length - 1;
  const h = { 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes' };
  if (m) h['Content-Range'] = `bytes ${s}-${e}/${DATA.length}`;
  res.writeHead(m ? 206 : 200, h); res.end(DATA.subarray(s, e + 1));
});
const proxy = http.createServer((req, res) => {
  seen.proxied.push(req.url);
  const u = new URL(req.url);
  const up = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  req.pipe(up);
});
let base, port;
test.before(async () => {
  for (const s of [origin, proxy]) await new Promise(r => s.listen(0, '127.0.0.1', r));
  port = origin.address().port; base = `http://127.0.0.1:${port}`;
});
test.after(() => { for (const s of [origin, proxy]) { s.closeAllConnections?.(); s.close(); } fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------------- regressions for the four bugs found earlier ----------------
test('regression: a keep-alive socket the server already closed is retried transparently', async () => {
  const get = async () => { const { res } = await U.open(base + '/reuse', { timeout: 5000 }); const b = []; for await (const c of res) b.push(c); return Buffer.concat(b).toString(); };
  assert.strictEqual(await get(), 'ok'); // request 1 on a fresh socket (kept alive)
  assert.strictEqual(await get(), 'ok'); // request 2 reuses it, the server resets it -> retried on a new connection
});

test('regression: changing a proxy password takes effect (agents are keyed by credentials)', async () => {
  const proxyOf = pass => ({ mode: 'manual', socks: { host: '127.0.0.1', port: 1, user: 'u', pass, version: 5 } });
  const { socksAgentFor } = require('../src/proxy');
  const a = socksAgentFor({ ...proxyOf('one').socks, type: 'socks' }, false);
  const b = socksAgentFor({ ...proxyOf('two').socks, type: 'socks' }, false);
  const a2 = socksAgentFor({ ...proxyOf('one').socks, type: 'socks' }, false);
  assert.notStrictEqual(a, b, 'different password -> different agent');
  assert.strictEqual(a, a2, 'same credentials -> cached agent');
});

test('regression: the download view carries referer, lastTry, speedLimit (columns + limiter box)', async () => {
  const m = mk('view');
  const v = m.add({ url: base + '/f/a.bin', referer: 'http://page/', saveDir: path.join(tmp, 'view', 'o'), queue: null });
  m.setDownloadOptions(v.id, { speedLimit: 123 * 1024 });
  m.start(v.id);
  const d = await done(m, v.id);
  assert.strictEqual(d.referer, 'http://page/');
  assert.ok(d.lastTry > 0);
  assert.strictEqual(d.speedLimit, 0, 'a per-file limit that is not remembered is cleared when the download ends/stops');
  await m.shutdown();
});

// ---------------- PAC ----------------
test('PAC: routes by host, DIRECT otherwise, SOCKS and fallback chains parse', () => {
  const pac = new Pac(`function FindProxyForURL(url, host) {
    if (isPlainHostName(host)) return 'DIRECT';
    if (shExpMatch(host, '*.corp.example')) return 'PROXY 10.0.0.1:3128; DIRECT';
    if (dnsDomainIs(host, '.socks.example')) return 'SOCKS5 10.0.0.2:1080';
    if (isInNet(host, '192.168.0.0', '255.255.0.0')) return 'DIRECT';
    return 'SOCKS4 10.0.0.3:9050';
  }`);
  assert.strictEqual(pac.find('http://intranet/', 'intranet'), null);
  assert.deepStrictEqual(pac.find('http://a.corp.example/', 'a.corp.example'), { type: 'http', host: '10.0.0.1', port: 3128 });
  assert.deepStrictEqual(pac.find('http://x.socks.example/', 'x.socks.example'), { type: 'socks', host: '10.0.0.2', port: 1080, version: 5 });
  assert.deepStrictEqual(pac.find('http://other.org/', 'other.org'), { type: 'socks', host: '10.0.0.3', port: 9050, version: 4 });
});

test('PAC: a runaway or broken script cannot hang or crash the app', () => {
  assert.throws(() => new Pac('while(true){}'), /timed out|Script execution/i);
  assert.throws(() => new Pac('var x = 1;'), /FindProxyForURL/);
  const pac = new Pac("function FindProxyForURL(u,h){ while(true){} }");
  assert.strictEqual(pac.find('http://a/', 'a'), undefined, 'runtime failure -> caller connects directly');
  const sandbox = new Pac("function FindProxyForURL(u,h){ return typeof process + typeof require + typeof globalThis.constructor; }");
  assert.ok(!/process|require/.test(String(sandbox.find('http://a/', 'a'))), 'no node globals in the sandbox');
});

test('PAC: a download uses the proxy chosen by the script and goes direct when told so', async () => {
  const pacFile = path.join(tmp, 'proxy.pac');
  fs.writeFileSync(pacFile, `function FindProxyForURL(url, host) { return shExpMatch(url, '*routed*') ? 'PROXY 127.0.0.1:${proxy.address().port}' : 'DIRECT'; }`);
  const m = mk('pac', { proxy: { mode: 'pac', pacUrl: pacFile } });
  await require('../src/pac').loadPac(m.settings.proxy);
  seen.proxied.length = 0;
  const a = m.add({ url: `${base}/routed/a.bin`, saveDir: path.join(tmp, 'pac', 'o1'), queue: null, startNow: true });
  assert.strictEqual((await done(m, a.id)).status, 'complete');
  assert.ok(seen.proxied.length >= 1, 'routed URL went through the PAC proxy');
  const n = seen.proxied.length;
  const b = m.add({ url: `${base}/plain/b.bin`, saveDir: path.join(tmp, 'pac', 'o2'), queue: null, startNow: true });
  assert.strictEqual((await done(m, b.id)).status, 'complete');
  assert.strictEqual(seen.proxied.length, n, 'other URL connected directly');
  const t = await m.testPac({ pacUrl: pacFile, url: `${base}/routed/x` });
  assert.match(t.result, /PROXY 127\.0\.0\.1:/);
  await m.shutdown();
});

// ---------------- Dial Up / VPN ----------------
test('Dial-up: connects with redial when offline, skips dialling when online, reports failure', async () => {
  const m = mk('dial', { dialup: { enabled: true, entry: 'Office VPN', user: '', pass: '', redialAttempts: 3, redialSeconds: 1 } });
  const calls = [];
  m._rasdial = async args => { calls.push(args); if (calls.length < 3) throw Object.assign(new Error('busy'), { out: 'Remote Access error 676' }); return 'ok'; };
  assert.strictEqual(await m.ensureOnline('does-not-exist.invalid'), true, 'offline host -> dial');
  assert.strictEqual(calls.length, 3, 'redialled twice before succeeding');
  assert.deepStrictEqual(calls[0], ['Office VPN']);
  calls.length = 0;
  assert.strictEqual(await m.ensureOnline('localhost'), true);
  assert.strictEqual(calls.length, 0, 'online -> no dial');
  m._rasdial = async () => { throw Object.assign(new Error('x'), { out: 'Remote Access error 619\nThe port is disconnected' }); };
  m.settings.dialup.redialAttempts = 2; m.settings.dialup.redialSeconds = 1;
  await assert.rejects(() => m.ensureOnline('does-not-exist.invalid'), /Could not connect Office VPN: The port is disconnected/);
  await m.shutdown();
});

test('Dial-up: starting a download while offline dials first, then downloads', async () => {
  const m = mk('dial2', { dialup: { enabled: true, entry: 'Home', redialAttempts: 1, redialSeconds: 1 } });
  let dialled = 0; m._rasdial = async () => { dialled++; return 'ok'; };
  m.ensureOnline = async () => { dialled++; return true; }; // pretend DNS failed for the first start
  const v = m.add({ url: `${base}/f/dial.bin`, saveDir: path.join(tmp, 'dial2', 'o'), queue: null, startNow: true });
  assert.strictEqual((await done(m, v.id)).status, 'complete');
  assert.strictEqual(dialled, 1);
  await m.shutdown();
});

// ---------------- login prompt, overwrite, grabber cookie ----------------
test('401 exposes the realm so the UI can ask for a login; other errors do not', async () => {
  const m = mk('auth');
  const a = m.add({ url: base + '/realm', saveDir: path.join(tmp, 'auth', 'o'), queue: null, startNow: true });
  const ad = await waitFor(m, a.id, x => x.status === 'error');
  assert.strictEqual(ad.authRealm, 'Secret Area');
  const b = m.add({ url: base + '/gone', saveDir: path.join(tmp, 'auth', 'o2'), queue: null, startNow: true });
  const bd = await waitFor(m, b.id, x => x.status === 'error');
  assert.strictEqual(bd.authRealm, null);
  await m.shutdown();
});

test('overwrite: replaces an existing file instead of numbering it', async () => {
  const dir = path.join(tmp, 'over'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'x.bin'), 'old contents');
  const m = mk('over');
  const v = m.add({ url: base + '/f/x.bin', saveDir: dir, queue: null, startNow: true, overwrite: true });
  const d = await done(m, v.id);
  assert.strictEqual(d.fileName, 'x.bin');
  assert.strictEqual(fs.statSync(path.join(dir, 'x.bin')).size, DATA.length);
  assert.ok(!fs.existsSync(path.join(dir, 'x_2.bin')));
  await m.shutdown();
});

test('grabber: the pasted Cookie header unlocks a login-protected site', async () => {
  const run = async cookie => { const f = []; await explore({ startUrl: base + '/site/index.html', levelsThis: 0, exts: ['bin'], cookie }, { signal: new AbortController().signal, onFile: x => f.push(x.name) }); return f; };
  assert.deepStrictEqual(await run(undefined), []);
  assert.deepStrictEqual(await run('sid=42'), ['a.bin']);
});

test('API: shutdown/dial-up/pac endpoints require the token', async () => {
  const m = mk('api2');
  const s = createServer(m, { port: 0, token: 'tk' });
  const p = await s.listen();
  const post = (route, headers = {}) => new Promise(r => { const q = http.request({ host: '127.0.0.1', port: p, path: route, method: 'POST', headers }, res => { res.resume(); r(res.statusCode); }); q.end('{}'); });
  for (const route of ['/api/shutdown', '/api/shutdown-cancel', '/api/shutdown-now', '/api/dialup/connect', '/api/pac/test']) assert.strictEqual(await post(route), 401, route);
  s.server.close(); await m.shutdown();
});

// ---------------- tray icon (Windows only) ----------------
test('tray icon: starts, stays alive while the server runs and exits when it disappears', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const m = mk('tray');
  const s = createServer(m, { port: 0, token: 'tray-token' });
  const p = await s.listen();
  const child = startTray({ port: p, token: 'tray-token' });
  await new Promise(r => setTimeout(r, 5000));
  assert.strictEqual(child.exitCode, null, 'tray process is running');
  s.server.close(); s.server.closeAllConnections?.(); await m.shutdown();
  const exited = await new Promise(r => { const t = setTimeout(() => r(false), 30000); child.on('exit', () => { clearTimeout(t); r(true); }); });
  assert.ok(exited, 'tray exits after the server is gone');
  if (!exited) child.kill();
});

test('settings: partial and legacy proxy/dialup objects are merged with defaults (Options page must never break)', async () => {
  const { normalizeSettings } = require('../src/manager');
  const n = normalizeSettings({ proxy: { mode: 'none' }, dialup: { enabled: true } });
  assert.strictEqual(n.proxy.socks.version, 5);
  assert.strictEqual(n.proxy.http.port, 8080);
  assert.strictEqual(n.dialup.redialAttempts, 3);
  const legacy = normalizeSettings({ proxy: { enabled: true, host: 'p.example', port: 3128, user: 'u', pass: 'x', bypass: ['*.local'] } });
  assert.strictEqual(legacy.proxy.mode, 'manual');
  assert.deepStrictEqual([legacy.proxy.http.host, legacy.proxy.https.port, legacy.proxy.bypass], ['p.example', 3128, ['*.local']]);
  assert.strictEqual(normalizeSettings({ proxy: { enabled: false, host: 'x' } }).proxy.mode, 'none');
  const m = mk('norm');
  m.setSettings({ proxy: { mode: 'system' }, quota: { enabled: true } });
  assert.strictEqual(m.settings.proxy.mode, 'system');
  assert.strictEqual(m.settings.quota.windowMs, 3600000);
  await m.shutdown();
});
