'use strict';
// NTLMv2 HTTP authentication (MS-NLMP). Handles Proxy-Authenticate/WWW-Authenticate "NTLM".
// The three-message handshake authenticates a CONNECTION, so all messages travel over one kept-alive socket.
const crypto = require('crypto');

// ---------- MD4 (RFC 1320). Node's OpenSSL build no longer offers it, and NTLM needs it for the NT hash ----------
function md4(buf) {
  const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const len = buf.length;
  const padLen = ((len + 8) >> 6 << 6) + 64;
  const m = Buffer.alloc(padLen);
  buf.copy(m);
  m[len] = 0x80;
  m.writeUInt32LE((len * 8) >>> 0, padLen - 8);
  m.writeUInt32LE(Math.floor(len / 0x20000000) >>> 0, padLen - 4);
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const F = (x, y, z) => (x & y) | (~x & z), G = (x, y, z) => (x & y) | (x & z) | (y & z), H = (x, y, z) => x ^ y ^ z;
  for (let off = 0; off < padLen; off += 64) {
    const X = new Array(16);
    for (let i = 0; i < 16; i++) X[i] = m.readUInt32LE(off + i * 4);
    const aa = a, bb = b, cc = c, dd = d;
    const r1 = [3, 7, 11, 19];
    for (let i = 0; i < 16; i++) {
      const t = (a + F(b, c, d) + X[i]) >>> 0; const v = rotl(t, r1[i % 4]);
      a = d; d = c; c = b; b = v;
    }
    const r2 = [3, 5, 9, 13], o2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
    for (let i = 0; i < 16; i++) {
      const t = (a + G(b, c, d) + X[o2[i]] + 0x5a827999) >>> 0; const v = rotl(t, r2[i % 4]);
      a = d; d = c; c = b; b = v;
    }
    const r3 = [3, 9, 11, 15], o3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    for (let i = 0; i < 16; i++) {
      const t = (a + H(b, c, d) + X[o3[i]] + 0x6ed9eba1) >>> 0; const v = rotl(t, r3[i % 4]);
      a = d; d = c; c = b; b = v;
    }
    a = (a + aa) >>> 0; b = (b + bb) >>> 0; c = (c + cc) >>> 0; d = (d + dd) >>> 0;
  }
  const out = Buffer.alloc(16);
  out.writeUInt32LE(a, 0); out.writeUInt32LE(b, 4); out.writeUInt32LE(c, 8); out.writeUInt32LE(d, 12);
  return out;
}

const hmacMd5 = (key, data) => crypto.createHmac('md5', key).update(data).digest();
const utf16 = s => Buffer.from(s, 'utf16le');
const SIG = Buffer.from('NTLMSSP\0', 'latin1');

const F = { UNICODE: 0x1, REQUEST_TARGET: 0x4, NTLM: 0x200, ALWAYS_SIGN: 0x8000, TARGET_INFO: 0x800000, ESS: 0x80000, B128: 0x20000000 };

/** NT one-way function, version 2: HMAC_MD5(MD4(UTF16(password)), UTF16(UPPER(user) + domain)). */
function ntowfv2(user, domain, password) {
  return hmacMd5(md4(utf16(password)), utf16(user.toUpperCase() + domain));
}

function type1() {
  const b = Buffer.alloc(32);
  SIG.copy(b, 0); b.writeUInt32LE(1, 8);
  b.writeUInt32LE((F.UNICODE | F.REQUEST_TARGET | F.NTLM | F.ALWAYS_SIGN | F.ESS | F.B128) >>> 0, 12);
  // empty domain and workstation security buffers (len, maxlen, offset)
  b.writeUInt16LE(0, 16); b.writeUInt16LE(0, 18); b.writeUInt32LE(32, 20);
  b.writeUInt16LE(0, 24); b.writeUInt16LE(0, 26); b.writeUInt32LE(32, 28);
  return b;
}

function parseType2(buf) {
  if (buf.length < 32 || !buf.subarray(0, 8).equals(SIG) || buf.readUInt32LE(8) !== 2) throw new Error('Invalid NTLM challenge from server');
  const flags = buf.readUInt32LE(20);
  const challenge = Buffer.from(buf.subarray(24, 32));
  let targetInfo = Buffer.alloc(0);
  if (buf.length >= 48) {
    const len = buf.readUInt16LE(40), off = buf.readUInt32LE(44);
    if (len && off + len <= buf.length) targetInfo = Buffer.from(buf.subarray(off, off + len));
  }
  return { flags, challenge, targetInfo };
}

/** Value of an AV_PAIR (MS-NLMP 2.2.2.1) or null. */
function avPair(targetInfo, id) {
  for (let o = 0; o + 4 <= targetInfo.length;) {
    const t = targetInfo.readUInt16LE(o), l = targetInfo.readUInt16LE(o + 2);
    if (t === 0) return null;
    if (t === id) return targetInfo.subarray(o + 4, o + 4 + l);
    o += 4 + l;
  }
  return null;
}

const FILETIME_EPOCH = 11644473600000n;
const filetime = () => Buffer.from(((BigInt(Date.now()) + FILETIME_EPOCH) * 10000n).toString(16).padStart(16, '0').match(/../g).reverse().join(''), 'hex');

/**
 * Compute the NTLMv2 responses (exported separately so it can be tested against the MS-NLMP vectors).
 * @returns {{ntProofStr:Buffer, ntResponse:Buffer, lmResponse:Buffer}}
 */
function responseV2({ user, domain, password }, serverChallenge, targetInfo, clientChallenge = crypto.randomBytes(8), time = null) {
  const key = ntowfv2(user, domain, password);
  const ts = avPair(targetInfo, 7); // MsvAvTimestamp supplied by the server wins
  const blob = Buffer.concat([
    Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]), ts ? Buffer.from(ts) : (time || filetime()), clientChallenge, Buffer.alloc(4), targetInfo, Buffer.alloc(4),
  ]);
  const ntProofStr = hmacMd5(key, Buffer.concat([serverChallenge, blob]));
  const lmResponse = ts ? Buffer.alloc(24) : Buffer.concat([hmacMd5(key, Buffer.concat([serverChallenge, clientChallenge])), clientChallenge]);
  return { ntProofStr, ntResponse: Buffer.concat([ntProofStr, blob]), lmResponse };
}

function splitUser(u) {
  const m = /^(.*?)[\\/](.+)$/.exec(u);
  if (m) return { domain: m[1], user: m[2] };
  const at = /^(.+)@(.+)$/.exec(u);
  return at ? { domain: '', user: u } : { domain: '', user: u };
}

function type3(type2, creds, workstation = '') {
  const { domain, user } = splitUser(creds.user);
  const info = parseType2(type2);
  const r = responseV2({ user, domain, password: creds.pass || '' }, info.challenge, info.targetInfo);
  const uni = (info.flags & F.UNICODE) !== 0;
  const enc = s => (uni ? utf16(s) : Buffer.from(s, 'latin1'));
  const parts = [enc(domain), enc(user), enc(workstation), r.lmResponse, r.ntResponse, Buffer.alloc(0)];
  const head = Buffer.alloc(64);
  SIG.copy(head, 0); head.writeUInt32LE(3, 8);
  // payload order: domain, user, workstation, lm, nt, session key; security-buffer slots in the header: lm, nt, domain, user, ws, key
  const slot = { lm: 12, nt: 20, domain: 28, user: 36, ws: 44, key: 52 };
  let off = 64;
  const place = (name, buf) => { head.writeUInt16LE(buf.length, slot[name]); head.writeUInt16LE(buf.length, slot[name] + 2); head.writeUInt32LE(off, slot[name] + 4); off += buf.length; };
  place('domain', parts[0]); place('user', parts[1]); place('ws', parts[2]); place('lm', parts[3]); place('nt', parts[4]); place('key', parts[5]);
  const flags = (info.flags & (F.UNICODE | F.NTLM | F.ALWAYS_SIGN | F.ESS | F.B128 | F.TARGET_INFO | F.REQUEST_TARGET)) >>> 0;
  head.writeUInt32LE(flags, 60);
  return Buffer.concat([head, ...parts]);
}

/**
 * Perform the handshake on one dedicated keep-alive connection and resolve with the final response.
 * @param {typeof import('http')} lib  http or https
 * @param {object} options             request options (host, path, method, headers, ...) WITHOUT agent
 */
async function authenticate({ lib, options, creds, timeout = 30000 }) {
  const agent = new lib.Agent({ keepAlive: true, maxSockets: 1 });
  const send = auth => new Promise((resolve, reject) => {
    const req = lib.request({ ...options, agent, headers: { ...options.headers, Authorization: auth, Connection: 'keep-alive' } }, resolve);
    req.setTimeout(timeout, () => req.destroy(new Error('NTLM request timed out')));
    req.on('error', reject);
    req.end();
  });
  try {
    const r1 = await send('NTLM ' + type1().toString('base64'));
    if (r1.statusCode !== 401) { r1.on('close', () => agent.destroy()); return r1; } // server did not need it
    const m = /NTLM\s+([A-Za-z0-9+/=]{16,})/i.exec([].concat(r1.headers['www-authenticate'] || []).join(', '));
    await new Promise(res => { r1.on('end', res); r1.on('close', res); r1.resume(); });
    if (!m) throw Object.assign(new Error('NTLM: the server sent no challenge (credentials rejected?)'), { fatal: true });
    const r2 = await send('NTLM ' + type3(Buffer.from(m[1], 'base64'), creds).toString('base64'));
    r2.on('close', () => agent.destroy());
    return r2;
  } catch (e) { agent.destroy(); throw e; }
}

module.exports = { md4, ntowfv2, type1, type2: parseType2, type3, responseV2, avPair, authenticate, F };
