'use strict';
// HTTP authentication and cookies for the request builder / response parser:
// Basic and Digest (qop=auth, MD5/MD5-sess/SHA-256) challenges, and a per-download cookie jar fed by Set-Cookie.
const crypto = require('crypto');

const hash = (algo, s) => crypto.createHash(algo).update(s).digest('hex');

function parseChallenges(header) {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  const out = [];
  for (const h of list) {
    for (const part of String(h).split(/,\s*(?=(?:Basic|Digest|Negotiate|NTLM)\b)/i)) {
      const m = /^\s*(Basic|Digest|Negotiate|NTLM)\s*(.*)$/i.exec(part);
      if (!m) continue;
      const params = {};
      for (const p of m[2].matchAll(/([\w-]+)=("([^"]*)"|[^,\s]*)/g)) params[p[1].toLowerCase()] = p[3] !== undefined ? p[3] : p[2];
      out.push({ scheme: m[1].toLowerCase(), params });
    }
  }
  return out;
}

/** Build an Authorization header value for a Digest challenge. */
function digest(challenge, { user, pass }, method, uri, state = {}) {
  const p = challenge.params;
  const alg = (p.algorithm || 'MD5').toUpperCase();
  const h = alg.startsWith('SHA-256') ? 'sha256' : 'md5';
  const qops = (p.qop || '').split(/\s*,\s*/).filter(Boolean);
  const useQop = qops.includes('auth') ? 'auth' : null;
  state.nc = (state.nc || 0) + 1;
  const nc = state.nc.toString(16).padStart(8, '0');
  const cnonce = crypto.randomBytes(8).toString('hex');
  let ha1 = hash(h, `${user}:${p.realm}:${pass}`);
  if (alg.endsWith('-SESS')) ha1 = hash(h, `${ha1}:${p.nonce}:${cnonce}`);
  const ha2 = hash(h, `${method}:${uri}`);
  const response = useQop ? hash(h, `${ha1}:${p.nonce}:${nc}:${cnonce}:${useQop}:${ha2}`) : hash(h, `${ha1}:${p.nonce}:${ha2}`);
  const q = v => `"${String(v).replace(/(["\\])/g, '\\$1')}"`;
  const parts = [`username=${q(user)}`, `realm=${q(p.realm)}`, `nonce=${q(p.nonce)}`, `uri=${q(uri)}`, `algorithm=${p.algorithm || 'MD5'}`, `response=${q(response)}`];
  if (p.opaque) parts.push(`opaque=${q(p.opaque)}`);
  if (useQop) parts.push(`qop=${useQop}`, `nc=${nc}`, `cnonce=${q(cnonce)}`);
  return 'Digest ' + parts.join(', ');
}

/**
 * Pick the strongest offered scheme and build the header.
 * @returns {{header:string, state:object}|null}  null: no supported scheme (e.g. NTLM only)
 */
function respond(challenges, creds, method, uri, prior) {
  const dg = challenges.find(c => c.scheme === 'digest');
  if (dg) { const state = prior && prior.scheme === 'digest' && prior.params.nonce === dg.params.nonce ? prior.state : {}; return { header: digest(dg, creds, method, uri, state), state, scheme: 'digest', params: dg.params }; }
  if (challenges.find(c => c.scheme === 'basic')) {
    return { header: 'Basic ' + Buffer.from(`${creds.user}:${creds.pass || ''}`).toString('base64'), state: {}, scheme: 'basic', params: {} };
  }
  return null;
}

// ---------- cookies ----------
class Jar {
  constructor() { this.byHost = new Map(); }

  /** Remember name=value pairs from Set-Cookie headers (expired / Max-Age=0 cookies delete). */
  store(host, setCookie) {
    const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    if (!list.length) return;
    const jar = this.byHost.get(host) || new Map();
    for (const c of list) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      if (i < 1) continue;
      const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
      const maxAge = attrs.map(a => /^\s*max-age\s*=\s*(-?\d+)/i.exec(a)).find(Boolean);
      const exp = attrs.map(a => /^\s*expires\s*=\s*(.+)$/i.exec(a)).find(Boolean);
      const dead = (maxAge && +maxAge[1] <= 0) || (exp && new Date(exp[1]).getTime() < Date.now());
      dead ? jar.delete(name) : jar.set(name, value);
    }
    this.byHost.set(host, jar);
  }

  header(host, existing) {
    const jar = this.byHost.get(host);
    const mine = jar ? [...jar].map(([k, v]) => `${k}=${v}`) : [];
    const have = new Set(String(existing || '').split(';').map(s => s.split('=')[0].trim()).filter(Boolean));
    const extra = mine.filter(p => !have.has(p.split('=')[0]));
    return [existing, ...extra].filter(Boolean).join('; ');
  }
}

module.exports = { parseChallenges, digest, respond, Jar };
