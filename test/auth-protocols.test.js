'use strict';
// NTLM (NTLMv2) and multipart/byteranges - two response-parser features.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ntlm = require('../src/ntlm');
const multipart = require('../src/multipart');
const { Manager } = require('../src/manager');

const hex = b => Buffer.from(b).toString('hex');
const utf16 = s => Buffer.from(s, 'utf16le');

test('MD4 matches RFC 1320 and NTLM hashes match the MS-NLMP examples', () => {
  assert.strictEqual(hex(ntlm.md4(Buffer.from(''))), '31d6cfe0d16ae931b73c59d7e0c089c0');
  assert.strictEqual(hex(ntlm.md4(Buffer.from('abc'))), 'a448017aaf21d8525fc10ae87aa6729d');
  assert.strictEqual(hex(ntlm.md4(Buffer.from('message digest'))), 'd9130a8164549fe818874806e1c7014b');
  assert.strictEqual(hex(ntlm.md4(Buffer.from('12345678901234567890123456789012345678901234567890123456789012345678901234567890'))), 'e33b4ddc9c38f2199c3e7b164fcc0536');
  assert.strictEqual(hex(ntlm.md4(utf16('Password'))), 'a4f49c406510bdcab6824ee7c30fd852');
  assert.strictEqual(hex(ntlm.ntowfv2('User', 'Domain', 'Password')), '0c868a403bfd7a93a3001ef22ef02e3f');
});

test('NTLMv2 response matches the MS-NLMP 4.2.4 test vector (NTProofStr)', () => {
  const av = (id, s) => { const v = utf16(s); const h = Buffer.alloc(4); h.writeUInt16LE(id, 0); h.writeUInt16LE(v.length, 2); return Buffer.concat([h, v]); };
  const targetInfo = Buffer.concat([av(2, 'Domain'), av(1, 'Server'), Buffer.alloc(4)]);
  const r = ntlm.responseV2({ user: 'User', domain: 'Domain', password: 'Password' }, Buffer.from('0123456789abcdef', 'hex'), targetInfo, Buffer.from('aaaaaaaaaaaaaaaa', 'hex'), Buffer.alloc(8));
  assert.strictEqual(hex(r.ntProofStr), '68cd0ab851e51c96aabc927bebef6a1c');
  assert.strictEqual(hex(r.lmResponse), '86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa');
});

// ---------------- mock NTLM server ----------------
const DATA = crypto.randomBytes(512 * 1024);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const CHALLENGE = crypto.randomBytes(8);
const USERS = { bob: 's3cret', alice: 'wonderland' };
const state = new WeakMap(); // socket -> { stage }
const log = { handshakes: 0, sameSocketOk: 0, sameSocketBad: 0, rejected: 0 };

function type2() {
  const av = (id, s) => { const v = typeof s === 'string' ? utf16(s) : s; const h = Buffer.alloc(4); h.writeUInt16LE(id, 0); h.writeUInt16LE(v.length, 2); return Buffer.concat([h, v]); };
  const ts = Buffer.alloc(8); ts.writeBigUInt64LE((BigInt(Date.now()) + 11644473600000n) * 10000n);
  const info = Buffer.concat([av(2, 'CORP'), av(1, 'SRV'), av(7, ts), Buffer.alloc(4)]);
  const target = utf16('CORP');
  const head = Buffer.alloc(48);
  Buffer.from('NTLMSSP\0', 'latin1').copy(head, 0); head.writeUInt32LE(2, 8);
  head.writeUInt16LE(target.length, 12); head.writeUInt16LE(target.length, 14); head.writeUInt32LE(48, 16);
  head.writeUInt32LE((0x1 | 0x4 | 0x200 | 0x800000 | 0x80000 | 0x20000000) >>> 0, 20);
  CHALLENGE.copy(head, 24);
  head.writeUInt16LE(info.length, 40); head.writeUInt16LE(info.length, 42); head.writeUInt32LE(48 + target.length, 44);
  return { msg: Buffer.concat([head, target, info]), info };
}
function checkType3(buf, info) {
  const sec = o => ({ len: buf.readUInt16LE(o), off: buf.readUInt32LE(o + 4) });
  const nt = sec(20), dom = sec(28), usr = sec(36);
  const ntResp = buf.subarray(nt.off, nt.off + nt.len);
  const domain = buf.subarray(dom.off, dom.off + dom.len).toString('utf16le');
  const user = buf.subarray(usr.off, usr.off + usr.len).toString('utf16le');
  const password = USERS[user.toLowerCase()];
  if (!password) return false;
  const key = ntlm.ntowfv2(user, domain, password);
  const blob = ntResp.subarray(16);
  const want = crypto.createHmac('md5', key).update(Buffer.concat([CHALLENGE, blob])).digest();
  // the client must have echoed the server's timestamp and target info (MsvAvTimestamp present => LM response is zero)
  return want.equals(ntResp.subarray(0, 16)) && blob.subarray(28).includes(info);
}
const ntlmInfo = type2().info; // timestamps differ per call, so compare the AV pairs that matter only
const origin = http.createServer((req, res) => {
  if (req.url.startsWith('/mp')) return servMultipart(req, res);
  const st = state.get(req.socket) || {};
  const auth = req.headers.authorization || '';
  if (!/^NTLM /.test(auth)) { res.writeHead(401, { 'WWW-Authenticate': 'NTLM', 'Content-Length': 0 }); return res.end(); }
  const msg = Buffer.from(auth.slice(5), 'base64');
  const type = msg.readUInt32LE(8);
  if (type === 1) {
    log.handshakes++;
    const t2 = type2(); st.info = t2.info; state.set(req.socket, st);
    res.writeHead(401, { 'WWW-Authenticate': 'NTLM ' + t2.msg.toString('base64'), 'Content-Length': 0 });
    return res.end();
  }
  if (type === 3) {
    st.info ? log.sameSocketOk++ : log.sameSocketBad++; // type 3 must arrive on the socket that got the challenge
    const info = st.info ? st.info.subarray(0, 4 + 12 + 4 + 6) : Buffer.alloc(0); // the CORP/SRV name pairs
    let ok = false;
    try { ok = !!st.info && checkType3(msg, info.subarray(0, 4 + utf16('CORP').length)); } catch { ok = false; }
    if (!ok) { log.rejected++; res.writeHead(401, { 'Content-Length': 0 }); return res.end(); }
  }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const s = m ? +m[1] : 0, e = m && m[2] ? Math.min(+m[2], DATA.length - 1) : DATA.length - 1;
  const h = { 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes' };
  if (m) h['Content-Range'] = `bytes ${s}-${e}/${DATA.length}`;
  res.writeHead(m ? 206 : 200, h);
  res.end(DATA.subarray(s, e + 1));
});

// ---------------- mock multipart server ----------------
function servMultipart(req, res) {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const s = m ? +m[1] : 0, e = m && m[2] ? Math.min(+m[2], DATA.length - 1) : DATA.length - 1;
  const quoted = req.url.includes('quoted');
  const b = 'THIS_STRING_SEPARATES_' + crypto.randomBytes(4).toString('hex');
  const pre = Buffer.from('this is the preamble and must be ignored\r\n');
  const head = Buffer.from(`--${b}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${s}-${e}/${DATA.length}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${b}--\r\n`);
  const body = Buffer.concat([pre, head, DATA.subarray(s, e + 1), tail]);
  res.writeHead(206, { 'Content-Type': `multipart/byteranges; boundary=${quoted ? `"${b}"` : b}`, 'Content-Length': body.length, 'Accept-Ranges': 'bytes' });
  let off = 0; // dribble in odd-sized pieces so delimiters straddle chunks
  const pump = () => { if (res.destroyed) return; res.write(body.subarray(off, off + 7777)); off += 7777; off >= body.length ? res.end() : setImmediate(pump); };
  pump();
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advance-download-manager-auth-'));
const mk = (name, s = {}) => { const m = new Manager({ dataDir: path.join(tmp, name, 'data') }).load(); m.setSettings({ minSplitBytes: 64 * 1024, rampMs: 30, ...s }); return m; };
const waitFor = (m, id, pred, ms = 30000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout; ' + JSON.stringify(m.view(m.get(id))))), ms);
  const check = () => { const v = m.view(m.get(id)); if (pred(v)) { clearTimeout(t); m.off('update', check); resolve(v); } };
  m.on('update', check); check();
});
const done = (m, id, ms) => waitFor(m, id, x => x.status === 'complete' || x.status === 'error', ms);
let base;
test.before(async () => { await new Promise(r => origin.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${origin.address().port}`; });
test.after(() => { origin.closeAllConnections?.(); origin.close(); fs.rmSync(tmp, { recursive: true, force: true }); void ntlmInfo; });

test('NTLM: three-message handshake on ONE connection, domain\\user form, parallel segments each authenticate', async () => {
  Object.assign(log, { handshakes: 0, sameSocketOk: 0, sameSocketBad: 0, rejected: 0 });
  const m = mk('ntlm', { maxConnections: 4 });
  const v = m.add({ url: base + '/file.bin', username: 'CORP\\bob', password: 's3cret', saveDir: path.join(tmp, 'ntlm', 'o'), queue: null, startNow: true });
  const d = await done(m, v.id);
  assert.strictEqual(d.status, 'complete', d.error);
  assert.strictEqual(sha(fs.readFileSync(path.join(d.saveDir, d.fileName))), sha(DATA));
  assert.ok(log.handshakes >= 2, 'each connection is authenticated separately: ' + log.handshakes);
  assert.strictEqual(log.sameSocketBad, 0, 'type 3 always arrived on the socket that received the challenge');
  assert.strictEqual(log.rejected, 0);
  await m.shutdown();
});

test('NTLM: a wrong password is rejected with a clear error (no endless loop)', async () => {
  const m = mk('ntlm2');
  const v = m.add({ url: base + '/file.bin', username: 'CORP\\bob', password: 'WRONG', saveDir: path.join(tmp, 'ntlm2', 'o'), queue: null, startNow: true });
  const d = await waitFor(m, v.id, x => x.status === 'error', 20000);
  assert.match(d.error, /401|credentials/i);
  await m.shutdown();
});

test('multipart parser: any chunking of the body yields exactly the part payload', async () => {
  const payload = crypto.randomBytes(5000);
  const body = Buffer.concat([Buffer.from('preamble\r\n--BND\r\nContent-Range: bytes 0-4999/9999\r\n\r\n'), payload, Buffer.from('\r\n--BND--\r\nepilogue')]);
  for (const size of [1, 2, 3, 7, 64, 4096, body.length]) {
    const chunks = []; for (let i = 0; i < body.length; i += size) chunks.push(body.subarray(i, i + size));
    const got = [];
    for await (const c of multipart.parts((async function* () { yield* chunks; })(), 'BND')) got.push(Buffer.from(c));
    assert.strictEqual(sha(Buffer.concat(got)), sha(payload), 'chunk size ' + size);
  }
  assert.strictEqual(multipart.boundaryOf('multipart/byteranges; boundary="a b-c"'), 'a b-c');
  assert.strictEqual(multipart.boundaryOf('multipart/x-byteranges;boundary=XYZ;charset=x'), 'XYZ');
  assert.ok(multipart.isByteranges('multipart/x-byteranges; boundary=1') && !multipart.isByteranges('text/html'));
});

for (const variant of ['plain', 'quoted']) {
  test(`multipart/byteranges answers (${variant} boundary) are unwrapped for probe and every segment`, async () => {
    const m = mk('mp' + variant, { maxConnections: 4 });
    const v = m.add({ url: base + '/mp-' + variant + '.bin', saveDir: path.join(tmp, 'mp' + variant, 'o'), queue: null, startNow: true });
    const d = await done(m, v.id);
    assert.strictEqual(d.status, 'complete', d.error);
    assert.strictEqual(d.size, DATA.length, 'size taken from the first part Content-Range');
    assert.strictEqual(sha(fs.readFileSync(path.join(d.saveDir, d.fileName))), sha(DATA));
    await m.shutdown();
  });
}
