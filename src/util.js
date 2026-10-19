'use strict';
const http = require('http');
const https = require('https');
const tls = require('tls');
const { pickProxy, socksAgentFor } = require('./proxy');
const httpauth = require('./httpauth');

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) return reject(abortError());
  const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(abortError()); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
});

function abortError() { const e = new Error('Aborted'); e.name = 'AbortError'; e.aborted = true; return e; }

// "*.example.com" style wildcard (exception / proxy-bypass lists)
function globMatch(pattern, str) {
  const re = new RegExp('^' + String(pattern).trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  return re.test(str);
}

function parseDisposition(h) {
  if (!h) return null;
  let m = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(h);
  if (m) { try { return decodeURIComponent(m[2].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ } }
  m = /filename\s*=\s*"([^"]+)"/i.exec(h) || /filename\s*=\s*([^;]+)/i.exec(h);
  return m ? m[1].trim() : null;
}

function sanitizeName(n) {
  n = String(n || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + n;
  return n.slice(0, 200) || 'download';
}

const MIME_EXT = {
  'application/zip': '.zip', 'application/pdf': '.pdf', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3',
  'application/x-rar-compressed': '.rar', 'application/x-7z-compressed': '.7z', 'image/jpeg': '.jpg',
  'image/png': '.png', 'application/x-msdownload': '.exe', 'application/octet-stream': '',
};

function nameFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return last || u.hostname;
  } catch { return 'download'; }
}

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass || ''}`).toString('base64');
}

// HTTPS through an HTTP proxy using CONNECT
class TunnelAgent extends https.Agent {
  constructor(proxy) { super({ keepAlive: true }); this.proxy = proxy; }
  createConnection(options, cb) {
    const headers = {};
    if (this.proxy.user) headers['Proxy-Authorization'] = basicAuth(this.proxy.user, this.proxy.pass);
    const req = http.request({ host: this.proxy.host, port: this.proxy.port, method: 'CONNECT', path: `${options.host}:${options.port}`, headers });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return cb(new Error('Proxy CONNECT failed: ' + res.statusCode)); }
      cb(null, tls.connect({ socket, servername: options.servername || options.host }));
    });
    req.once('error', cb);
    req.end();
  }
}
const tunnelAgents = new Map();
function tunnelFor(proxy) {
  const k = `${proxy.host}:${proxy.port}:${proxy.user || ''}:${proxy.pass || ''}`;
  if (!tunnelAgents.has(k)) tunnelAgents.set(k, new TunnelAgent(proxy));
  return tunnelAgents.get(k);
}
const plainAgent = new http.Agent({ keepAlive: true });
const secureAgent = new https.Agent({ keepAlive: true });

/**
 * Issue a request and follow redirects. Resolves with {res, url} once headers arrive;
 * the caller owns the response stream.
 */
function open(urlStr, opts = {}, redirects = 0) {
  if (opts.proxy && opts.proxy.mode === 'pac') { // PAC's dnsResolve() is synchronous: resolve the host first
    let host = null;
    try { host = new URL(urlStr).hostname; } catch { /* reported below */ }
    if (host && opts._prepared !== host) return require('./pac').prepare(host).then(() => open(urlStr, { ...opts, _prepared: host }, redirects));
  }
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(fatal('Invalid URL')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(fatal('Unsupported protocol: ' + u.protocol));
    const secure = u.protocol === 'https:';
    const proxy = pickProxy(opts.proxy, secure ? 'https' : 'http', u.hostname, u.href);
    const o = { method: opts.method || 'GET', headers: { ...(opts.headers || {}) }, signal: opts.signal };
    // cookies learnt from earlier Set-Cookie headers (redirect chains, probe -> segment requests)
    if (opts.jar) { const c = opts.jar.header(u.hostname, o.headers.Cookie); if (c) o.headers.Cookie = c; }
    // credentials are only sent after the server asks (401), then cached for the following requests of this download
    const cached = opts.auth && opts.authCache && opts.authCache[u.host];
    if (cached && !o.headers.Authorization) {
      const r = httpauth.respond([{ scheme: cached.scheme, params: cached.params }], opts.auth, o.method, u.pathname + u.search, cached);
      if (r) { o.headers.Authorization = r.header; cached.state = r.state; }
    }
    if (proxy && proxy.type === 'socks') {
      o.hostname = u.hostname; o.port = u.port || (secure ? 443 : 80); o.path = u.pathname + u.search;
      o.agent = socksAgentFor(proxy, secure);
    } else if (proxy && !secure) {
      o.host = proxy.host; o.port = proxy.port; o.path = u.href; o.headers.Host = u.host;
      o.agent = plainAgent;
      if (proxy.user) o.headers['Proxy-Authorization'] = basicAuth(proxy.user, proxy.pass);
    } else {
      o.hostname = u.hostname; o.port = u.port || (secure ? 443 : 80); o.path = u.pathname + u.search;
      o.agent = proxy ? tunnelFor(proxy) : secure ? secureAgent : plainAgent;
    }
    const req = (secure ? https : http).request(o, res => {
      const sc = res.statusCode;
      if (opts.jar) opts.jar.store(u.hostname, res.headers['set-cookie']);
      if (sc === 401 && opts.auth && opts.auth.user && !opts._authTried) { // answer the challenge once (Digest preferred over Basic)
        const challenges = httpauth.parseChallenges(res.headers['www-authenticate']);
        const r = httpauth.respond(challenges, opts.auth, o.method, u.pathname + u.search);
        if (!r && !proxy && challenges.some(c => c.scheme === 'ntlm')) { // NTLM authenticates the connection: 3 messages on one socket
          res.resume();
          const base = { ...o }; delete base.agent;
          return resolve(require('./ntlm').authenticate({ lib: secure ? https : http, options: base, creds: opts.auth, timeout: opts.timeout || 30000 }).then(r2 => ({ res: r2, url: u.href })));
        }
        if (r) {
          res.resume();
          if (opts.authCache) opts.authCache[u.host] = { scheme: r.scheme, params: r.params, state: r.state };
          return resolve(open(urlStr, { ...opts, _authTried: true, headers: { ...(opts.headers || {}), Authorization: r.header } }, redirects));
        }
      }
      if ([301, 302, 303, 307, 308].includes(sc) && res.headers.location) {
        res.resume();
        if (redirects >= 10) return reject(fatal('Too many redirects'));
        const next = new URL(res.headers.location, u).href;
        const h = { ...(opts.headers || {}) };
        const sameHost = new URL(next).host === u.host;
        if (!sameHost) delete h.Authorization;
        return resolve(open(next, { ...opts, headers: h, _authTried: sameHost ? opts._authTried : false }, redirects + 1));
      }
      resolve({ res, url: u.href });
    });
    req.setTimeout(opts.timeout || 30000, () => req.destroy(new Error('Connection timed out')));
    req.on('error', e => {
      // a pooled keep-alive socket the server already closed: transparently retry once on a fresh connection
      if (req.reusedSocket && !opts._retried && ['ECONNRESET', 'EPIPE'].includes(e.code)) return resolve(open(urlStr, { ...opts, _retried: true }, redirects));
      reject(e);
    });
    req.end();
  });
}

function fatal(msg) { const e = new Error(msg); e.fatal = true; return e; }

module.exports = { sleep, abortError, globMatch, parseDisposition, sanitizeName, nameFromUrl, MIME_EXT, open, fatal, basicAuth };
