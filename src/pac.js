'use strict';
// Proxy auto-configuration (PAC) scripts: "Use automatic configuration script" in the Proxy dialog.
// The script runs in a fresh node:vm context with only the standard PAC helper functions, no require/process/fs,
// and a hard execution timeout. (vm is not a hardened security boundary - only load PAC files you trust.)
const vm = require('vm');
const dns = require('dns').promises;
const os = require('os');
const net = require('net');
const U = require('./util');

const dnsCache = new Map(); // host -> ip (filled before FindProxyForURL runs, because PAC's dnsResolve() is synchronous)

function ipToInt(ip) { return ip.split('.').reduce((a, b) => (a << 8) + (+b), 0) >>> 0; }

function myIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list) if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}

function helpers() {
  const wd = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const dnsResolve = host => net.isIP(host) === 4 ? host : (dnsCache.get(String(host).toLowerCase()) || null);
  return {
    isPlainHostName: h => !String(h).includes('.'),
    dnsDomainIs: (h, d) => String(h).toLowerCase().endsWith(String(d).toLowerCase()),
    localHostOrDomainIs: (h, hd) => h === hd || hd.split('.')[0] === h,
    isResolvable: h => !!dnsResolve(h),
    isInNet: (h, pattern, mask) => { const ip = dnsResolve(h); return !!ip && ((ipToInt(ip) & ipToInt(mask)) >>> 0) === ((ipToInt(pattern) & ipToInt(mask)) >>> 0); },
    dnsResolve,
    myIpAddress: myIp,
    dnsDomainLevels: h => String(h).split('.').length - 1,
    shExpMatch: (s, pat) => new RegExp('^' + String(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(String(s)),
    weekdayRange: (a, b, g) => { const d = (g === 'GMT' ? new Date().getUTCDay() : new Date().getDay()), x = wd.indexOf(a), y = b && wd.indexOf(b) >= 0 ? wd.indexOf(b) : x; return x <= y ? d >= x && d <= y : d >= x || d <= y; },
    dateRange: (...a) => { const d = new Date(); const m = a.find(v => mon.includes(v)); return m ? d.getMonth() === mon.indexOf(m) : true; },
    timeRange: (...a) => { const h = new Date().getHours(); const n = a.filter(v => typeof v === 'number'); if (n.length === 1) return h === n[0]; if (n.length >= 2) return n[0] <= n[1] ? h >= n[0] && h < n[1] : h >= n[0] || h < n[1]; return true; },
  };
}

class Pac {
  constructor(script) {
    this.ctx = vm.createContext({ ...helpers() }, { codeGeneration: { strings: false, wasm: false } });
    vm.runInContext(script, this.ctx, { timeout: 2000, filename: 'proxy.pac' });
    if (typeof this.ctx.FindProxyForURL !== 'function') throw new Error('The script does not define FindProxyForURL(url, host)');
  }

  /** @returns {{type:'http'|'socks', host, port, version?}|null}   null means DIRECT */
  find(url, host) {
    let res;
    try { res = vm.runInContext(`FindProxyForURL(${JSON.stringify(url)}, ${JSON.stringify(host)})`, this.ctx, { timeout: 1000 }); } catch { return undefined; } // undefined: script failed -> caller goes direct
    return Pac.parse(String(res));
  }

  static parse(res) {
    for (const part of res.split(';').map(s => s.trim()).filter(Boolean)) {
      const [kind, addr] = part.split(/\s+/);
      const k = kind.toUpperCase();
      if (k === 'DIRECT') return null;
      const [h, p] = (addr || '').split(':');
      if (!h) continue;
      if (k === 'PROXY' || k === 'HTTP' || k === 'HTTPS') return { type: 'http', host: h, port: +p || 8080 };
      if (k === 'SOCKS' || k === 'SOCKS5') return { type: 'socks', host: h, port: +p || 1080, version: 5 };
      if (k === 'SOCKS4') return { type: 'socks', host: h, port: +p || 1080, version: 4 };
    }
    return null;
  }
}

let current = { key: '', pac: null };

/** Load (or reload) the script for a proxy config. Called by the manager when settings change. */
async function loadPac(cfg, signal) {
  if (!cfg || cfg.mode !== 'pac' || !cfg.pacUrl) { current = { key: '', pac: null }; return null; }
  let script;
  if (/^https?:\/\//i.test(cfg.pacUrl)) {
    const { res } = await U.open(cfg.pacUrl, { signal, timeout: 15000 });
    if (res.statusCode >= 400) { res.resume(); throw new Error('Could not download the PAC script (HTTP ' + res.statusCode + ')'); }
    const chunks = []; let n = 0;
    for await (const c of res) { n += c.length; if (n > 1e6) { res.destroy(); throw new Error('PAC script too large'); } chunks.push(c); }
    script = Buffer.concat(chunks).toString('utf8');
  } else script = require('fs').readFileSync(cfg.pacUrl.replace(/^file:\/\//, ''), 'utf8');
  current = { key: cfg.pacUrl, pac: new Pac(script) };
  return current.pac;
}

/** Resolve the host up front so synchronous dnsResolve()/isInNet() in the script work. */
async function prepare(hostname) {
  if (!current.pac || net.isIP(hostname) || dnsCache.has(hostname.toLowerCase())) return;
  try { dnsCache.set(hostname.toLowerCase(), (await dns.lookup(hostname, { family: 4 })).address); } catch { /* unresolvable */ }
  if (dnsCache.size > 500) dnsCache.delete(dnsCache.keys().next().value);
}

const active = () => current.pac;

module.exports = { Pac, loadPac, prepare, active };
