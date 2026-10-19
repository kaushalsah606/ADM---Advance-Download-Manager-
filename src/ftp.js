'use strict';
// Minimal FTP client: passive mode (EPSV/PASV), SIZE, MDTM, REST resume, RETR. Binary transfers only.
const net = require('net');
const U = require('./util');
const { pickProxy, socksConnect } = require('./proxy');

// FTP can go through SOCKS (SOCKS applies to protocols that have no proxy of their own)
const socksFor = (cfg, host) => { const p = pickProxy(cfg, 'ftp', host); return p && p.type === 'socks' ? p : null; };

async function dial(host, port, timeout, signal, proxyCfg) {
  if (proxyCfg && proxyCfg.mode === 'pac') await require('./pac').prepare(host);
  const sp = socksFor(proxyCfg, host);
  if (sp) return socksConnect(sp, host, port, timeout);
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(U.abortError());
    const s = net.connect({ host, port });
    s.setTimeout(timeout || 30000, () => s.destroy(new Error('FTP connection timed out')));
    const onAbort = () => s.destroy(U.abortError());
    signal && signal.addEventListener('abort', onAbort, { once: true });
    s.once('error', reject);
    s.once('connect', () => { s.removeListener('error', reject); resolve(s); });
  });
}

class FtpConn {
  constructor(sock, proxyCfg) {
    this.sock = sock;
    this.proxyCfg = proxyCfg;
    this.buf = '';
    this.cur = null;
    this.replies = [];
    this.waiters = [];
    this.err = null;
    sock.setEncoding('utf8');
    sock.on('data', d => { this.buf += d; this._parse(); });
    sock.on('error', e => this._fail(e));
    sock.on('close', () => this._fail(new Error('FTP connection closed')));
  }

  static async connect(host, port, timeout, signal, proxyCfg) {
    const sock = await dial(host, port, timeout, signal, proxyCfg);
    sock.setTimeout(timeout || 30000, () => sock.destroy(new Error('FTP connection timed out')));
    const onAbort = () => sock.destroy(U.abortError());
    signal && signal.addEventListener('abort', onAbort, { once: true });
    return new FtpConn(sock, proxyCfg);
  }

  _parse() {
    const lines = this.buf.split(/\r?\n/);
    this.buf = lines.pop();
    for (const line of lines) {
      if (!this.cur) {
        const m = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!m) continue;
        this.cur = { code: +m[1], lines: [m[3]] };
        if (m[2] === ' ') this._done();
      } else {
        this.cur.lines.push(line);
        if (line.startsWith(this.cur.code + ' ')) this._done();
      }
    }
  }

  _done() {
    const r = { code: this.cur.code, text: this.cur.lines.join('\n') };
    this.cur = null;
    const w = this.waiters.shift();
    w ? w.resolve(r) : this.replies.push(r);
  }

  _fail(e) {
    this.err = this.err || e;
    for (const w of this.waiters.splice(0)) w.reject(this.err);
  }

  reply() {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async cmd(line, ok) {
    this.sock.write(line + '\r\n');
    const r = await this.reply();
    if (ok && !ok.includes(r.code)) {
      const e = new Error(`FTP ${line.split(' ')[0]} failed: ${r.code} ${r.text}`);
      e.fatal = r.code >= 500 && r.code < 600;
      e.ftpCode = r.code;
      throw e;
    }
    return r;
  }

  async login(user, pass) {
    const hello = await this.reply();
    if (hello.code !== 220) throw Object.assign(new Error('FTP server refused connection: ' + hello.text), { fatal: hello.code >= 500 });
    let r = await this.cmd('USER ' + user);
    if (r.code === 331) r = await this.cmd('PASS ' + pass);
    if (r.code !== 230 && r.code !== 202) throw Object.assign(new Error(`FTP login failed (${r.code})`), { fatal: true });
    await this.cmd('TYPE I', [200]);
  }

  /** Open a passive data connection. */
  async dataSocket(host, signal) {
    let port;
    const e = await this.cmd('EPSV');
    if (e.code === 229) port = +/\(\|\|\|(\d+)\|\)/.exec(e.text)[1];
    else {
      const p = await this.cmd('PASV', [227]);
      const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(p.text);
      if (!m) throw new Error('Bad PASV reply');
      port = +m[5] * 256 + +m[6];
    }
    return dial(host, port, 30000, signal, this.proxyCfg);
  }

  close() { try { this.sock.write('QUIT\r\n'); } catch { /* ignore */ } this.sock.destroy(); }
}

function target(urlStr, creds) {
  const u = new URL(urlStr);
  return {
    host: u.hostname, port: +u.port || 21,
    user: decodeURIComponent(u.username) || creds.user || 'anonymous',
    pass: decodeURIComponent(u.password) || creds.pass || 'anonymous@advance-download-manager',
    path: decodeURIComponent(u.pathname).replace(/^\//, ''),
  };
}

async function session(urlStr, creds, timeout, signal, proxyCfg) {
  const t = target(urlStr, creds);
  const c = await FtpConn.connect(t.host, t.port, timeout, signal, proxyCfg);
  try { await c.login(t.user, t.pass); } catch (e) { c.close(); throw e; }
  return { c, t };
}

async function probe(urlStr, creds, timeout, signal, proxyCfg) {
  const { c, t } = await session(urlStr, creds, timeout, signal, proxyCfg);
  try {
    const sz = await c.cmd('SIZE ' + t.path);
    if (sz.code !== 213) throw Object.assign(new Error(`FTP: file not available (${sz.code})`), { fatal: sz.code >= 500 });
    const size = +sz.text.trim();
    let lastModified = null;
    const md = await c.cmd('MDTM ' + t.path).catch(() => null);
    if (md && md.code === 213) lastModified = md.text.trim();
    const rest = await c.cmd('REST 0').catch(() => null);
    return { size, lastModified, resumable: !!(rest && rest.code === 350) && size > 0, name: t.path.split('/').pop() };
  } finally { c.close(); }
}

/** Async generator of data chunks starting at byte `start`. */
async function* chunks(urlStr, creds, start, timeout, signal, proxyCfg) {
  const { c, t } = await session(urlStr, creds, timeout, signal, proxyCfg);
  let data;
  try {
    data = await c.dataSocket(t.host, signal);
    if (start > 0) await c.cmd('REST ' + start, [350]);
    const r = await c.cmd('RETR ' + t.path);
    if (r.code !== 150 && r.code !== 125) throw Object.assign(new Error(`FTP RETR failed: ${r.code} ${r.text}`), { fatal: r.code >= 500 });
    yield* data;
  } finally {
    if (data) data.destroy();
    c.close();
  }
}

module.exports = { probe, chunks };
