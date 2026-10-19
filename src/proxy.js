'use strict';
// Proxy layer: none / system / manual, per-protocol HTTP, HTTPS, FTP
// proxies, SOCKS 4/5 (used only for protocols without their own proxy), bypass list with wildcards.
const http = require('http');
const net = require('net');
const tls = require('tls');
const { execFileSync } = require('child_process');

const glob = (pattern, str) =>
  new RegExp('^' + String(pattern).trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(str);

let sysCache = { at: 0, val: null };

/** Read the OS proxy settings ("Use system settings" / "Get System"). */
function systemProxy() {
  if (Date.now() - sysCache.at < 30000) return sysCache.val;
  let val = null;
  try {
    if (process.platform === 'win32') {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      const q = n => { try { return execFileSync('reg', ['query', key, '/v', n], { encoding: 'utf8', windowsHide: true }); } catch { return ''; } };
      if (/0x1\s*$/m.test(q('ProxyEnable'))) {
        const server = (/ProxyServer\s+REG_SZ\s+(.+)/.exec(q('ProxyServer')) || [])[1];
        if (server) {
          const parse = v => { const [h, p] = v.trim().replace(/^\w+:\/\//, '').split(':'); return { host: h, port: +p || 80 }; };
          if (server.includes('=')) {
            val = {};
            for (const part of server.split(';')) { const [k, v] = part.split('='); if (v) val[k.trim().toLowerCase()] = parse(v); }
            if (val.socks) val.socks.version = 5;
          } else val = { http: parse(server), https: parse(server), ftp: parse(server) };
        }
      }
    } else {
      const e = process.env, parse = v => { const u = new URL(v); return { host: u.hostname, port: +u.port || 80 }; };
      val = {};
      if (e.http_proxy || e.HTTP_PROXY) val.http = parse(e.http_proxy || e.HTTP_PROXY);
      if (e.https_proxy || e.HTTPS_PROXY) val.https = parse(e.https_proxy || e.HTTPS_PROXY);
      if (!Object.keys(val).length) val = null;
    }
  } catch { val = null; }
  sysCache = { at: Date.now(), val };
  return val;
}

/**
 * cfg: { mode: 'none'|'system'|'manual', http, https, ftp, socks, bypass[] }
 * (legacy {enabled, host, port, user, pass} still works as an HTTP/HTTPS proxy)
 * Returns { type: 'http'|'socks', host, port, user, pass, version } or null.
 */
function pickProxy(cfg, scheme, hostname, fullUrl) {
  if (!cfg) return null;
  if ((cfg.bypass || []).some(p => glob(p, hostname))) return null;
  let c = cfg;
  if (cfg.mode === 'none') return null;
  if (cfg.mode === 'pac') { // automatic configuration script (loaded by the manager)
    const pac = require('./pac').active();
    // like browsers, hide the path of https URLs from the script; http URLs are passed in full
    const r = pac && pac.find(scheme === 'http' && fullUrl ? fullUrl : `${scheme}://${hostname}/`, hostname);
    return r ? { ...r } : null;
  }
  if (cfg.mode === 'system') c = systemProxy();
  else if (!cfg.mode) {
    if (!(cfg.enabled && cfg.host)) return null;
    const one = { host: cfg.host, port: cfg.port, user: cfg.user, pass: cfg.pass };
    c = { http: one, https: one };
  }
  if (!c) return null;
  const p = c[scheme];
  if (p && p.host) return { type: 'http', ...p };
  if (c.socks && c.socks.host) return { type: 'socks', ...c.socks };
  return null;
}

/** SOCKS4a / SOCKS5 CONNECT. Resolves to a connected socket (remote DNS: the proxy resolves the host). */
function socksConnect(proxy, host, port, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    sock.setTimeout(timeout, () => sock.destroy(new Error('SOCKS proxy timed out')));
    const fail = e => { sock.destroy(); reject(e); };
    sock.once('error', fail);
    const v5 = (proxy.version || 5) !== 4;
    let step = 'greet', buf = Buffer.alloc(0);
    const take = n => { const r = buf.subarray(0, n); buf = buf.subarray(n); return r; };
    const done = () => {
      sock.removeAllListeners('data'); sock.removeListener('error', fail); sock.setTimeout(0);
      if (buf.length) sock.unshift(buf);
      resolve(sock);
    };
    const request = () => {
      const h = Buffer.from(host);
      const addr = net.isIP(host) === 4 ? Buffer.concat([Buffer.from([1]), Buffer.from(host.split('.').map(Number))]) : Buffer.concat([Buffer.from([3, h.length]), h]);
      const pt = Buffer.alloc(2); pt.writeUInt16BE(port);
      sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, pt]));
      step = 'reply';
    };
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (!v5) {
          if (buf.length < 8) return;
          const r = take(8);
          return r[1] === 90 ? done() : fail(new Error('SOCKS4 connect refused (' + r[1] + ')'));
        }
        if (step === 'greet') {
          if (buf.length < 2) return;
          const r = take(2);
          if (r[1] === 0) request();
          else if (r[1] === 2 && proxy.user) {
            const u = Buffer.from(proxy.user), p = Buffer.from(proxy.pass || '');
            sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p])); step = 'auth';
          } else return fail(new Error('SOCKS5: no acceptable authentication method'));
        } else if (step === 'auth') {
          if (buf.length < 2) return;
          if (take(2)[1] !== 0) return fail(Object.assign(new Error('SOCKS5 authentication failed'), { fatal: true }));
          request();
        } else if (step === 'reply') {
          if (buf.length < 5) return;
          const atyp = buf[3], len = atyp === 1 ? 10 : atyp === 4 ? 22 : 7 + buf[4];
          if (buf.length < len) return;
          const r = take(len);
          return r[1] === 0 ? done() : fail(new Error('SOCKS5 connect failed (code ' + r[1] + ')'));
        } else return;
      }
    });
    sock.once('connect', () => {
      if (v5) sock.write(Buffer.from(proxy.user ? [5, 2, 0, 2] : [5, 1, 0]));
      else {
        const pt = Buffer.alloc(2); pt.writeUInt16BE(port);
        sock.write(Buffer.concat([Buffer.from([4, 1]), pt, Buffer.from([0, 0, 0, 1]), Buffer.from((proxy.user || '') + '\0'), Buffer.from(host + '\0')]));
      }
    });
  });
}

class SocksAgent extends http.Agent {
  constructor(proxy, secure) { super({ keepAlive: false }); this.proxy = proxy; this.secure = secure; }
  createConnection(options, cb) {
    socksConnect(this.proxy, options.host || options.hostname, +options.port).then(sock => {
      cb(null, this.secure ? tls.connect({ socket: sock, servername: options.servername || options.host }) : sock);
    }, cb);
  }
}
const agents = new Map();
function socksAgentFor(proxy, secure) {
  const k = `${proxy.host}:${proxy.port}:${proxy.user || ''}:${proxy.pass || ''}:${proxy.version || 5}:${secure}`;
  if (!agents.has(k)) agents.set(k, new SocksAgent(proxy, secure));
  return agents.get(k);
}

module.exports = { pickProxy, systemProxy, socksConnect, socksAgentFor };
