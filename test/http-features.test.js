'use strict';
// HTTP behaviours of the request builder / response parser: Digest auth, cookie jar,
// "web page instead of the file", browser-style request headers.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Manager } = require('../src/manager');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advance-download-manager-http-'));
const DATA = crypto.randomBytes(1024 * 1024);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const mk = (name, s = {}) => { const m = new Manager({ dataDir: path.join(tmp, name, 'data') }).load(); m.setSettings({ minSplitBytes: 64 * 1024, rampMs: 30, ...s }); return m; };
const waitFor = (m, id, pred, ms = 30000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout; ' + JSON.stringify(m.view(m.get(id))))), ms);
  const check = () => { const v = m.view(m.get(id)); if (pred(v)) { clearTimeout(t); m.off('update', check); resolve(v); } };
  m.on('update', check); check();
});
const done = (m, id, ms) => waitFor(m, id, x => x.status === 'complete' || x.status === 'error', ms);

// ---- origin ----
const seen = { headers: [], digestNc: new Set(), digestReplays: 0, cookies: [] };
const NONCE = 'dcd98b7102dd2f0e8b11d0f600bfb0c093';
function digestOk(req, algo, user, pass) {
  const h = req.headers.authorization || '';
  if (!/^Digest /i.test(h)) return false;
  const p = {};
  for (const m of h.slice(7).matchAll(/([\w-]+)=("([^"]*)"|[^,\s]*)/g)) p[m[1]] = m[3] !== undefined ? m[3] : m[2];
  const H = s => crypto.createHash(algo).update(s).digest('hex');
  if (p.username !== user || p.nonce !== NONCE || p.qop !== 'auth') return false;
  const ha1 = H(`${user}:Secret Zone:${pass}`), ha2 = H(`${req.method}:${p.uri}`);
  const want = H(`${ha1}:${NONCE}:${p.nc}:${p.cnonce}:auth:${ha2}`);
  if (want !== p.response) return false;
  if (seen.digestNc.has(p.nc)) seen.digestReplays++; // nonce count must keep increasing
  seen.digestNc.add(p.nc);
  return true;
}
const serve = (req, res, body, extra = {}) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const s = m ? +m[1] : 0, e = m && m[2] ? Math.min(+m[2], body.length - 1) : body.length - 1;
  const h = { 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes', ...extra };
  if (m) h['Content-Range'] = `bytes ${s}-${e}/${body.length}`;
  res.writeHead(m ? 206 : 200, h);
  let off = s;
  const pump = () => { if (res.destroyed) return; res.write(body.subarray(off, Math.min(off + 16384, e + 1))); off += 16384; off > e ? res.end() : setTimeout(pump, 6); };
  pump();
};
const origin = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  seen.headers.push({ path: u.pathname, ...req.headers });
  if (u.pathname === '/digest' || u.pathname === '/digest256') {
    const algo = u.pathname === '/digest' ? 'md5' : 'sha256';
    if (!digestOk(req, algo, 'alice', 'wonderland')) {
      res.writeHead(401, { 'WWW-Authenticate': `Digest realm="Secret Zone", qop="auth", nonce="${NONCE}", opaque="xyz", algorithm=${algo === 'md5' ? 'MD5' : 'SHA-256'}` });
      return res.end();
    }
    return serve(req, res, DATA);
  }
  if (u.pathname === '/start') { res.writeHead(302, { Location: '/session/file.bin', 'Set-Cookie': ['sid=abc123; Path=/; HttpOnly', 'lang=en'] }); return res.end(); }
  if (u.pathname === '/session/file.bin') {
    seen.cookies.push(req.headers.cookie || '');
    if (!/sid=abc123/.test(req.headers.cookie || '')) { res.writeHead(403); return res.end(); }
    return serve(req, res, DATA);
  }
  if (u.pathname === '/expired.zip') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<html>Your link has expired</html>'); }
  if (u.pathname === '/attach.zip') return serve(req, res, DATA, { 'Content-Type': 'text/html', 'Content-Disposition': 'attachment; filename="real.zip"' });
  if (u.pathname === '/norange.bin') { res.writeHead(200, { 'Content-Length': 1000 }); return res.end(Buffer.alloc(1000, 7)); }
  if (u.pathname === '/page.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>just a page</html>'); }
  serve(req, res, DATA);
});
let base;
test.before(async () => { await new Promise(r => origin.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${origin.address().port}`; });
test.after(() => { origin.closeAllConnections?.(); origin.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('Digest authentication (MD5): challenge answered, nonce count increases across parallel segments', async () => {
  seen.digestNc.clear(); seen.digestReplays = 0;
  const m = mk('digest', { maxConnections: 4 });
  const v = m.add({ url: base + '/digest', username: 'alice', password: 'wonderland', saveDir: path.join(tmp, 'digest', 'o'), queue: null, startNow: true });
  const d = await done(m, v.id);
  assert.strictEqual(d.status, 'complete', d.error);
  assert.strictEqual(sha(fs.readFileSync(path.join(d.saveDir, d.fileName))), sha(DATA));
  assert.ok(seen.digestNc.size >= 2, 'several authenticated requests');
  assert.strictEqual(seen.digestReplays, 0, 'no nonce-count was ever reused');
  await m.shutdown();
});

test('Digest authentication (SHA-256) and a wrong password fails fast with the realm', async () => {
  const m = mk('digest2');
  const ok = m.add({ url: base + '/digest256', username: 'alice', password: 'wonderland', saveDir: path.join(tmp, 'digest2', 'o'), queue: null, startNow: true });
  assert.strictEqual((await done(m, ok.id)).status, 'complete');
  const bad = m.add({ url: base + '/digest', username: 'alice', password: 'WRONG', saveDir: path.join(tmp, 'digest2', 'o2'), queue: null, startNow: true });
  const bd = await waitFor(m, bad.id, x => x.status === 'error');
  assert.match(bd.error, /401/);
  assert.strictEqual(bd.authRealm, 'Secret Zone');
  await m.shutdown();
});

test('credentials are not sent until the server asks for them', async () => {
  seen.headers.length = 0;
  const m = mk('noauth');
  const v = m.add({ url: base + '/plain/x.bin', username: 'alice', password: 'wonderland', saveDir: path.join(tmp, 'noauth', 'o'), queue: null, startNow: true });
  assert.strictEqual((await done(m, v.id)).status, 'complete');
  assert.ok(seen.headers.every(h => !h.authorization), 'an open server never receives the password');
  await m.shutdown();
});

test('cookie jar: Set-Cookie from a redirect is sent on the file request and on every later segment request', async () => {
  seen.cookies.length = 0;
  const m = mk('jar', { maxConnections: 4 });
  const v = m.add({ url: base + '/start', fileName: 'file.bin', saveDir: path.join(tmp, 'jar', 'o'), queue: null, startNow: true });
  const d = await done(m, v.id);
  assert.strictEqual(d.status, 'complete', d.error);
  assert.strictEqual(sha(fs.readFileSync(path.join(d.saveDir, d.fileName))), sha(DATA));
  assert.ok(seen.cookies.length >= 2 && seen.cookies.every(c => /sid=abc123/.test(c) && /lang=en/.test(c)), seen.cookies.join(' | '));
  await m.shutdown();
});

test('a text/html answer for a .zip link is reported as a web page, unless Content-Disposition says attachment', async () => {
  const m = mk('html');
  const bad = m.add({ url: base + '/expired.zip', saveDir: path.join(tmp, 'html', 'o'), queue: null, startNow: true });
  const bd = await waitFor(m, bad.id, x => x.status === 'error');
  assert.match(bd.error, /web page instead of the file/);
  const good = m.add({ url: base + '/attach.zip', saveDir: path.join(tmp, 'html', 'o2'), queue: null, startNow: true });
  const gd = await done(m, good.id);
  assert.strictEqual(gd.status, 'complete', gd.error);
  assert.strictEqual(gd.fileName, 'real.zip');
  const page = m.add({ url: base + '/page.html', saveDir: path.join(tmp, 'html', 'o3'), queue: null, startNow: true });
  assert.strictEqual((await done(m, page.id)).status, 'complete', 'real HTML pages are still downloadable');
  await m.shutdown();
});

test('browser-style request headers: Accept-Language, Accept-Charset, Origin from the referer, identity encoding', async () => {
  seen.headers.length = 0;
  const m = mk('hdr');
  const v = m.add({ url: base + '/h/a.bin', referer: 'https://shop.example/page/1?x=2', saveDir: path.join(tmp, 'hdr', 'o'), queue: null, startNow: true });
  assert.strictEqual((await done(m, v.id)).status, 'complete');
  const h = seen.headers.find(x => x.path === '/h/a.bin');
  assert.match(h['accept-language'], /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/);
  assert.strictEqual(h['accept-charset'], '*');
  assert.strictEqual(h.origin, 'https://shop.example');
  assert.strictEqual(h.referer, 'https://shop.example/page/1?x=2');
  assert.strictEqual(h['accept-encoding'], 'identity');
  m.setSettings({ browserHeaders: false });
  seen.headers.length = 0;
  const v2 = m.add({ url: base + '/h/b.bin', referer: 'https://shop.example/', saveDir: path.join(tmp, 'hdr', 'o2'), queue: null, startNow: true });
  await done(m, v2.id);
  const h2 = seen.headers.find(x => x.path === '/h/b.bin');
  assert.ok(!h2.origin && !h2['accept-charset'], 'can be switched off');
  await m.shutdown();
});

test('servers known not to support resume get no-cache headers on later requests (first probe stays clean)', async () => {
  seen.headers.length = 0;
  const m = mk('nocache');
  const v = m.add({ url: base + '/norange.bin', saveDir: path.join(tmp, 'nocache', 'o'), queue: null, startNow: true });
  const d = await done(m, v.id);
  assert.strictEqual(d.status, 'complete', d.error);
  assert.strictEqual(fs.statSync(path.join(d.saveDir, d.fileName)).size, 1000);
  await m.redownload(v.id);
  await waitFor(m, v.id, x => x.status === 'complete');
  const reqs = seen.headers.filter(x => x.path === '/norange.bin');
  assert.ok(reqs.length >= 2);
  assert.ok(!reqs[0]['cache-control'], 'first probe: server not known yet');
  assert.strictEqual(reqs[reqs.length - 1]['cache-control'], 'no-cache');
  assert.strictEqual(reqs[reqs.length - 1].pragma, 'no-cache');
  await m.shutdown();
});
