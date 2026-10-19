'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const U = require('./util');
const ftp = require('./ftp');
const hls = require('./hls');
const { Limiter } = require('./limiter');
const { Tuner } = require('./tuner');
const policy = require('./policy');
const multipart = require('./multipart');
const dash = require('./dash');
const rtmp = require('./rtmp');
const { Jar } = require('./httpauth');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Advance Download Manager/1.0';

/**
 * One download. Segmented, resumable download engine:
 *  - dynamic segmentation with the "in-half division rule" (a free connection takes the
 *    largest remaining segment and splits it in half),
 *  - connection reuse (a worker that finishes a segment immediately claims another),
 *  - positions persisted so pause / crash / power loss resumes correctly,
 *  - resume validated against ETag / Last-Modified (optionally ignoring mtime changes).
 *
 * rec.segments = [{ s, p, e }]  start, next-byte-to-write, exclusive end
 */
class Download extends EventEmitter {
  constructor(rec, ctx) {
    super();
    this.rec = rec;
    this.ctx = ctx; // { settings(), limiter, uniqueName(dir,name,id) }
    this.running = false;
    this.speed = 0;
    this.conns = 0;
    this._bytes = 0;
    this._lastSample = { t: Date.now(), b: 0 };
    this._done = Promise.resolve();
    this.own = new Limiter(); // per-file Speed Limiter tab
  }

  get destPath() { return path.join(this.rec.saveDir, this.rec.fileName); }
  // file parts are stored in a temporary directory; default is next to the destination
  get partPath() {
    const t = this.ctx.settings().tempDir;
    return t ? path.join(t, this.rec.id + '.sgpart') : this.destPath + '.sgpart';
  }

  setSpeedLimit(bps) {
    this.rec.speedLimit = Math.max(0, bps | 0);
    this.own.configure({ speedLimit: this.rec.speedLimit });
  }

  _turbo() { return this.ctx.settings().turbo === true; }

  async _take(n, signal) {
    if (this._turbo()) return; // Turbo mode: no global / per-file speed limit
    await this.ctx.limiter.take(n, signal);
    if (this.own.rate) await this.own.take(n, signal);
  }

  downloaded() {
    const r = this.rec;
    if (r.status === 'complete') return r.size || r.bytesDone || 0;
    if (r.hls) return r.hls.bytes;
    if (r.dash) return r.dash.tracks.reduce((a, t) => a + t.bytes, 0);
    if (r.segments && r.segments.length) return r.segments.reduce((a, g) => a + Math.max(0, Math.min(g.p, g.e) - g.s), 0);
    return r.bytesDone || 0;
  }

  /** Playlist/manifest downloads have no length up front: estimate it from the bytes per segment so far. */
  progress() {
    const r = this.rec;
    const tracks = r.hls ? [r.hls] : r.dash ? r.dash.tracks : null;
    if (!tracks) return null;
    let size = 0;
    for (const t of tracks) {
      if (t.next) size += (t.bytes / t.next) * t.segments.length;
      else if (t.estBytes) size += t.estBytes; // not started yet: bandwidth x duration from the manifest
      else return { size: null };
    }
    return { size: Math.round(size) };
  }

  /** Remove every temporary file of this download. */
  async cleanup() {
    for (const p of [this.partPath, this.partPath + '.mux', this.partPath + '.t0', this.partPath + '.t1', this.partPath + '.t2']) await fsp.rm(p, { force: true }).catch(() => {});
  }

  sample() {
    const now = Date.now();
    const dt = (now - this._lastSample.t) / 1000;
    if (dt <= 0) return;
    const inst = (this._bytes - this._lastSample.b) / dt;
    this.speed = this.running ? (this.speed ? this.speed * 0.6 + inst * 0.4 : inst) : 0;
    this._lastSample = { t: now, b: this._bytes };
  }

  _login() {
    const r = this.rec, s = this.ctx.settings();
    if (r.username) return { user: r.username, pass: r.password };
    try {
      const host = new URL(r.url).hostname;
      const login = (s.siteLogins || []).find(l => U.globMatch(l.pattern, host));
      if (login) return { user: login.user, pass: login.pass };
    } catch { /* ignore */ }
    return {};
  }

  _headers() {
    const r = this.rec, s = this.ctx.settings();
    const h = { 'User-Agent': r.userAgent || s.userAgent || UA, Accept: '*/*', 'Accept-Encoding': 'identity' };
    if (r.referer) h.Referer = r.referer;
    if (r.cookie) h.Cookie = r.cookie;
    if (s.browserHeaders !== false) { // browser-like request headers
      h['Accept-Language'] = this._lang();
      h['Accept-Charset'] = '*';
      if (r.referer) { try { h.Origin = new URL(r.referer).origin; } catch { /* no origin */ } }
      if (r.probed && r.resumable === false) { h['Cache-Control'] = 'no-cache'; h.Pragma = 'no-cache'; } // known non-resumable server
    }
    return h;
  }

  _lang() {
    try { return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'; } catch { return 'en-US'; }
  }

  /** Options shared by every request of this download: credentials (sent only when challenged), cookie jar, auth cache. */
  _net(extra = {}) {
    const s = this.ctx.settings();
    const { user, pass } = this._login();
    this._jar = this._jar || new Jar();
    this._authCache = this._authCache || {};
    return { proxy: s.proxy, timeout: s.timeoutMs, jar: this._jar, authCache: this._authCache, ...(user ? { auth: { user, pass } } : {}), ...extra };
  }

  get isFtp() { return /^ftp:/i.test(this.rec.url); }

  _maxConns() {
    const s = this.ctx.settings();
    let n = this.rec.maxConnections || s.maxConnections || 16;
    if (s.turbo === true) n = Math.max(n, s.turboConnections || 32);
    try {
      const host = new URL(this.rec.url).hostname;
      const ex = (s.exceptions || []).find(x => U.globMatch(x.pattern, host));
      if (ex) n = Math.min(n, ex.connections);
    } catch { /* ignore */ }
    return Math.max(1, n);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._userStop = false;
    this._fatal = null;
    this.abort = new AbortController();
    this.rec.status = 'downloading';
    this.rec.error = null;
    this.rec.lastTry = Date.now();
    this.own.configure({ speedLimit: this.rec.speedLimit || 0 });
    this.emit('state');
    this._done = this._run();
  }

  stop() {
    if (!this.running) return Promise.resolve();
    this._userStop = true;
    this.abort.abort();
    return this._done;
  }

  async _run() {
    await this._runOnce();
    if (this._retryCorrupt) {
      // "started to download the file using one connection because of data corruption when newly received
      // data in several connections did not match the same data downloaded earlier"
      this._retryCorrupt = false;
      this._fatal = null;
      this.abort = new AbortController();
      this.rec.status = 'downloading';
      this.rec.error = null;
      this.emit('state');
      await this._runOnce();
    }
    this.running = false;
    this.speed = 0;
    this.conns = 0;
    this.emit('end');
  }

  async _runOnce() {
    const rec = this.rec;
    const signal = this.abort.signal;
    let fh = null;
    try {
      const tmpDir = this.ctx.settings().tempDir;
      if (tmpDir) await fsp.mkdir(tmpDir, { recursive: true });
      if (rec.kind === 'rtmp') {
        fh = await this._rtmpOpen();
        await this._rtmpLoop(fh, signal);
      } else if (rec.kind === 'dash') {
        await this._dashRun(signal);
        if (this._fatal) throw this._fatal;
        if (signal.aborted) { this._markPaused(); return; }
        await this._dashFinish();
        return;
      } else if (rec.kind === 'hls') {
        fh = await this._hlsOpen(signal);
        await this._hlsLoop(fh, signal);
      } else {
        const probe = await this._probe(signal);
        this._applyProbe(probe);
        await fsp.mkdir(rec.saveDir, { recursive: true });
        const fresh = !rec.segments.length && !rec.bytesDone;
        if (fresh) {
          if (!rec.overwrite) rec.fileName = this.ctx.uniqueName(rec.saveDir, rec.fileName, rec.id);
          await fsp.rm(this.partPath, { force: true });
        }
        const exists = fs.existsSync(this.partPath);
        fh = await fsp.open(this.partPath, exists ? 'r+' : 'w+');
        rec.resumable ? await this._segmented(fh, signal) : await this._stream(fh, probe, signal);
      }
      if (this._fatal) throw this._fatal;
      if (signal.aborted) { this._markPaused(); return; }
      await fh.sync(); await fh.close(); fh = null;
      await this._finish();
    } catch (e) {
      if (this._fatal) e = this._fatal;
      if (e.corrupt && !rec.singleConn) {
        rec.singleConn = true;
        rec.warning = 'Data corruption detected: downloading again with one connection';
        rec.segments = []; rec.bytesDone = 0;
        if (fh) { await fh.close().catch(() => {}); fh = null; }
        await fsp.rm(this.partPath, { force: true }).catch(() => {});
        this._retryCorrupt = true;
        return;
      }
      if (signal.aborted && !this._fatal) {
        this._markPaused();
      } else {
        rec.status = 'error';
        rec.authRealm = e.realm !== undefined ? e.realm : null; // lets the UI ask for a user name and password
        rec.error = e.message || String(e);
        rec.fatal = !!e.fatal;
      }
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  _markPaused() {
    const rec = this.rec;
    rec.status = 'paused';
    if (rec.speedLimit && !rec.rememberLimit) { rec.speedLimit = 0; this.own.configure({ speedLimit: 0 }); }
    if (!rec.resumable) { rec.bytesDone = 0; rec.segments = []; } // cannot resume without Range support
  }

  async _probe(signal) {
    const rec = this.rec, s = this.ctx.settings();
    if (this.isFtp) {
      const p = await ftp.probe(rec.url, this._login(), s.timeoutMs, signal, s.proxy);
      return { url: rec.url, res: null, size: p.size, resumable: p.resumable, etag: null, lastModified: p.lastModified, ctype: '', name: p.name };
    }
    const { res, url } = await U.open(rec.url, {
      headers: { ...this._headers(), Range: 'bytes=0-0' }, signal, ...this._net(),
    });
    const sc = res.statusCode;
    if (sc === 401 || sc === 407) {
      res.resume();
      const realm = /realm="?([^",]+)/i.exec(res.headers['www-authenticate'] || '');
      throw Object.assign(U.fatal(sc === 401 ? 'Authorization required (401)' : 'Proxy authorization required (407)'), { realm: realm ? realm[1] : '' });
    }
    if (sc >= 400 && sc !== 416) { res.resume(); throw httpError(sc); }
    // text/html answers are discarded answers for non-HTML files: expired links and login walls come back as a web page
    if (s.rejectHtmlForFiles !== false && (sc === 200 || sc === 206) && !res.headers['content-disposition'] &&
        /^text\/html/i.test(res.headers['content-type'] || '')) {
      let ext = '';
      try { ext = path.extname(new URL(url).pathname).slice(1).toLowerCase(); } catch { /* none */ }
      if (ext && ext !== 'htm' && ext !== 'html' && (s.fileTypes || []).includes(ext)) {
        res.destroy();
        throw U.fatal('The server returned a web page instead of the file (the link may have expired or may need a login)');
      }
    }
    const out = {
      url, res: null, size: null, resumable: false,
      etag: res.headers.etag || null, lastModified: res.headers['last-modified'] || null,
      ctype: (res.headers['content-type'] || '').split(';')[0].trim(),
      name: U.parseDisposition(res.headers['content-disposition']),
    };
    if (sc === 206) {
      let cr = res.headers['content-range'] || '';
      const ct = res.headers['content-type'] || '';
      if (!cr && multipart.isByteranges(ct) && multipart.boundaryOf(ct)) { // the total size is inside the first part
        const head = await multipart.firstPartHeaders(res, multipart.boundaryOf(ct));
        cr = (/content-range:\s*([^\r\n]+)/i.exec(head) || [])[1] || '';
      }
      const m = /\/(\d+)\s*$/.exec(cr);
      if (m) { out.size = +m[1]; out.resumable = out.size > 0; }
      res.destroy();
    } else if (sc === 416) {
      res.resume(); out.size = 0;
    } else {
      const cl = res.headers['content-length'];
      out.size = cl != null && cl !== '' ? +cl : null;
      out.res = res;
    }
    return out;
  }

  _applyProbe(p) {
    const rec = this.rec, s = this.ctx.settings();
    const had = rec.segments.length || rec.bytesDone;
    const changed = had && (
      (rec.size != null && p.size != null && rec.size !== p.size) ||
      (rec.etag && p.etag && rec.etag !== p.etag) ||
      (!s.ignoreModTime && rec.lastModified && p.lastModified && rec.lastModified !== p.lastModified));
    if (changed) {
      fs.rmSync(this.partPath, { force: true });
      rec.segments = []; rec.bytesDone = 0;
    }
    rec.size = p.size; rec.resumable = p.resumable; rec.probed = true;
    rec.etag = p.etag; rec.lastModified = p.lastModified; rec.finalUrl = p.url; rec.contentType = p.ctype;
    if (!rec.nameFixed && !(rec.segments.length || rec.bytesDone)) {
      let n = p.name || U.nameFromUrl(p.url);
      if (!path.extname(n) && U.MIME_EXT[p.ctype]) n += U.MIME_EXT[p.ctype];
      rec.fileName = U.sanitizeName(n);
      this.ctx.categorize && this.ctx.categorize(rec);
    }
  }

  // ---- segmented, resumable download (see src/policy.js) ----
  async _segmented(fh, signal) {
    const rec = this.rec, s = this.ctx.settings();
    if (rec.size === 0) return;
    if (!rec.segments.length) {
      await fh.truncate(rec.size);
      rec.segments = [{ s: 0, p: 0, e: rec.size }];
    }
    this._active = new Set();
    this._recv = new WeakSet(); // segments whose connection has already received data
    this._errs = 0;
    this._cap = 0;
    this._capAt = 0;
    this._live = 0;
    // one connection per 10 KB still to download, never more than the configured maximum (and 32)
    const target = () => (rec.singleConn ? 1 : Math.min(policy.connectionsFor(rec.size - this.downloaded(), this._maxConns(), this._turbo()), this._cap || Infinity));
    const workers = [];
    const spawn = k => { for (let i = 0; i < k; i++) workers.push(this._worker(fh, signal)); this._lastStart = Date.now(); };
    // Auto-tune: the number of connections follows the measured speed (more only while it helps, back when it does not, re-tested from time to time)
    const auto = s.autoTune !== false && !rec.singleConn;
    this._wset = new Set();
    const tuner = auto ? new Tuner({ start: this._tuneStart(), max: this._tuneMax() }) : null;
    this._tuner = tuner;
    spawn(auto ? Math.max(1, Math.min(tuner.n, target())) : 1); // legacy: one connection, more are added progressively
    while (!signal.aborted && !this._fatal && rec.segments.some(g => g.p < g.e)) {
      const turbo = this._turbo(), rampMs = this.ctx.settings().rampMs;
      await U.sleep(auto ? 40 : turbo ? 20 : Math.max(10, Math.min(200, rampMs / 2)), signal).catch(() => {});
      const live = this._live, want = target();
      if (auto) {
        tuner.setMax(this._tuneMax()); // the settings (Turbo, connection limits) can change while downloading
        const goal = tuner.update(Date.now(), this._bytes);
        const running = this._running();
        if (running < Math.min(want, goal) && Date.now() - this._lastStart >= 150 && this._hasWork()) spawn(Math.min(want, goal) - running);
        else if (running > goal) this._retire(running - goal); // the tuner went back: stop the newest connections, their segments are taken over
        continue;
      }
      if (turbo) {
        // Turbo: open every wanted connection at once; no ramp-up, no link-speed check
        if (live < want && Date.now() - this._lastStart >= policy.TURBO_RAMP_MS && this._hasWork()) spawn(want - live);
        continue;
      }
      // TryStartNewOptionalConnections: >= 2 s since the last start, every connection already receiving data,
      // and the speed still below 85% of the link/limit speed; then the number of connections doubles.
      if (live < want && Date.now() - this._lastStart >= rampMs && this._hasWork() && this._allReceiving() && !this._atLinkCap()) {
        spawn(Math.min(want, policy.nextConnections(Math.max(1, live), s.gentleRamp)) - live);
      }
    }
    await Promise.all(workers);
    if (!signal.aborted && !this._fatal && rec.segments.some(g => g.p < g.e)) throw new Error('Download incomplete');
  }

  /** Upper bound for the tuner: the user's limit for the current mode. */
  _tuneMax() { return Math.max(1, Math.min(this._maxConns(), this._turbo() ? policy.TURBO_MAX_CONNECTIONS : policy.HARD_MAX_CONNECTIONS)); }
  _tuneStart() { return Math.min(this._tuneMax(), this._turbo() ? 16 : 8); } // most servers allow 8 at once; Turbo starts higher
  /** Connections that are (still) meant to run: not already told to stop. */
  _running() { let n = 0; for (const w of this._wset) if (!w.ctl.signal.aborted) n++; return n; }
  /** Stop the k newest connections; the part of the file each was fetching goes back to the others. */
  _retire(k) {
    const list = [...this._wset].filter(w => !w.ctl.signal.aborted).sort((a, b) => b.born - a.born).slice(0, k);
    for (const w of list) w.ctl.abort();
  }

  _hasWork() {
    const minSplit = this.ctx.settings().minSplitBytes;
    if (this.rec.segments.some(g => !this._active.has(g) && g.p < g.e)) return true;
    for (const g of this._active) if (g.e - g.p >= minSplit * 2) return true;
    return false;
  }

  _allReceiving() { for (const g of this._active) if (!this._recv.has(g)) return false; return true; }

  _atLinkCap() {
    const caps = [this.ctx.limiter.rate, this.own.rate].filter(x => x > 0);
    return caps.length > 0 && this.speed >= policy.LINK_SPEED_FRACTION * Math.min(...caps);
  }

  _claim() {
    const segs = this.rec.segments;
    const free = segs.find(g => !this._active.has(g) && g.p < g.e);
    if (free) { this._active.add(free); return free; }
    // in-half division of the largest remaining active segment
    const minSplit = this.ctx.settings().minSplitBytes;
    let big = null;
    for (const g of this._active) if (g.e - g.p >= minSplit * 2 && (!big || g.e - g.p > big.e - big.p)) big = g;
    if (!big) return null;
    const mid = big.p + Math.floor((big.e - big.p) / 2);
    const ng = { s: mid, p: mid, e: big.e };
    big.e = mid;
    segs.push(ng);
    segs.sort((a, b) => a.s - b.s);
    this._active.add(ng);
    return ng;
  }

  async _worker(fh, signal) {
    const w = { ctl: new AbortController(), born: Date.now() };
    (this._wset || (this._wset = new Set())).add(w);
    const sig = AbortSignal.any([signal, w.ctl.signal]); // the download as a whole, or this one connection being retired by the tuner
    this._live++;
    try {
      while (!signal.aborted && !w.ctl.signal.aborted) {
        if (this._cap && this._live > this._cap) return; // over the connection count the server tolerates: retire this worker
        const seg = this._claim();
        if (!seg) return;
        this._recv.delete(seg);
        this.conns++;
        try {
          const before = seg.p;
          await this._fetchSegment(fh, seg, sig);
          if (seg.p > before) this._errs = 0;
        } catch (e) {
          if (signal.aborted || w.ctl.signal.aborted) return; // stopped on purpose (download paused / connection retired)
          if (e.fatal) { this._fatal = e; this.abort.abort(); return; }
          // many parallel connections failing: the server is pushing back. Shrink the connection count (at most -25% per second, never below 2)
          // instead of failing the download; in Turbo mode these errors are not counted towards the failure limit.
          if (this._live > 2 && Date.now() - (this._capAt || 0) > 1000) { this._cap = Math.max(2, Math.floor(Math.min(this._cap || Infinity, this._live) * 0.75)); this._capAt = Date.now(); }
          if (this._turbo() && this._live > 2) { await U.sleep(400, signal).catch(() => {}); continue; }
          const max = this.ctx.settings().maxSegmentErrors;
          if (++this._errs > max) { this._fatal = e; this.abort.abort(); return; }
          await U.sleep(Math.min(250 * 2 ** this._errs, 8000), signal).catch(() => {});
        } finally {
          this.conns--;
          this._active.delete(seg);
        }
      }
    } finally { this._live--; this._wset.delete(w); }
  }

  /** Chunk source for [seg.p, seg.e) over HTTP(S) or FTP. */
  async *_source(seg, signal) {
    const s = this.ctx.settings();
    if (this.isFtp) { yield* ftp.chunks(this.rec.url, this._login(), seg.p, s.timeoutMs, signal, s.proxy); return; }
    const { res } = await U.open(this.rec.finalUrl || this.rec.url, {
      headers: { ...this._headers(), Range: `bytes=${seg.p}-${seg.e - 1}` }, signal, ...this._net(),
    });
    const sc = res.statusCode;
    if (sc === 416) { res.resume(); if (seg.p >= this.rec.size) { seg.p = seg.e; return; } throw U.fatal('Server rejected range (416)'); }
    if (sc !== 206) {
      res.resume();
      if (sc === 200) throw U.fatal('Server stopped honouring Range requests');
      throw httpError(sc);
    }
    const ct = res.headers['content-type'] || '';
    if (multipart.isByteranges(ct)) { // some servers wrap even a single range in multipart/byteranges
      const boundary = multipart.boundaryOf(ct);
      if (!boundary) { res.resume(); throw U.fatal('multipart/byteranges answer without a boundary'); }
      yield* multipart.parts(res, boundary);
      return;
    }
    yield* res;
  }

  /**
   * Download [seg.p, seg.e).  The request starts 64 bytes
   * BEFORE the saved position and ends 64 bytes AFTER the segment: the leading bytes must equal what is already on disk
   * and the trailing bytes must equal what the neighbouring connection has written, otherwise the server is returning
   * inconsistent data and the download falls back to one connection.
   */
  async _fetchSegment(fh, seg, signal) {
    if (seg.p >= seg.e) return;
    const O = this.ctx.settings().verifyOverlap === false ? 0 : policy.OVERLAP;
    const from = seg.p - Math.min(O, seg.p);
    const reqEnd = Math.min(this.rec.size, seg.e + O);
    let pos = from, tailStart = -1, tailLen = 0;
    const tail = [];
    for await (const chunk of this._source({ p: from, e: reqEnd }, signal)) {
      this._recv.add(seg);
      let buf = chunk;
      if (pos < seg.p) { // leading overlap: compare with the bytes stored earlier
        const n = Math.min(buf.length, seg.p - pos);
        await this._verify(fh, pos, buf.subarray(0, n));
        pos += n; buf = buf.subarray(n);
      }
      if (buf.length && pos < seg.e) { // normal write, bounded by the (possibly shrunk) segment end
        const n = Math.min(buf.length, seg.e - pos);
        await this._take(n, signal);
        await fh.write(buf, 0, n, pos);
        seg.p = pos + n; pos += n; this._bytes += n;
        buf = buf.subarray(n);
      }
      if (buf.length && pos >= seg.e && O) { // trailing overlap: keep it for comparison with the neighbour
        if (tailStart < 0) tailStart = pos;
        const n = Math.min(buf.length, O - tailLen);
        if (n > 0) { tail.push(buf.subarray(0, n)); tailLen += n; }
        pos += buf.length;
      }
      if (pos >= reqEnd || tailLen >= O && O > 0) break; // segment done (or taken over by a split); reuse this worker
      if (!O && pos >= seg.e) break;
    }
    if (tailLen) await this._verify(fh, tailStart, Buffer.concat(tail));
  }

  /** Compare received bytes with the bytes already stored - but only where some connection has really written them
   *  (everything below a segment's p). Regions not written yet (e.g. a neighbour that has not got there) are skipped. */
  async _verify(fh, pos, buf) {
    for (const g of this.rec.segments) {
      const lo = Math.max(pos, g.s), hi = Math.min(pos + buf.length, g.p);
      if (hi <= lo) continue;
      const cur = Buffer.alloc(hi - lo);
      const { bytesRead } = await fh.read(cur, 0, hi - lo, lo);
      if (bytesRead === hi - lo && !cur.equals(buf.subarray(lo - pos, hi - pos))) throw this._corruption(lo);
    }
  }

  _corruption(pos) {
    return Object.assign(new Error(`Data corruption detected near byte ${pos}: connections returned different data`), { fatal: true, corrupt: true });
  }

  // ---- single stream (server without range support / unknown length) ----
  async _stream(fh, probe, signal) {
    const rec = this.rec, s = this.ctx.settings();
    let res = probe.res;
    if (!res && this.isFtp) res = ftp.chunks(rec.url, this._login(), 0, s.timeoutMs, signal, s.proxy);
    else if (!res) {
      ({ res } = await U.open(rec.finalUrl || rec.url, { headers: this._headers(), signal, ...this._net() }));
      if (res.statusCode >= 400) { res.resume(); throw httpError(res.statusCode); }
    }
    rec.segments = [];
    rec.bytesDone = 0;
    this.conns = 1;
    let pos = 0;
    for await (const buf of res) {
      await this._take(buf.length, signal);
      await fh.write(buf, 0, buf.length, pos);
      pos += buf.length; rec.bytesDone = pos; this._bytes += buf.length;
    }
    if (signal.aborted) return;
    if (rec.size != null && pos !== rec.size) throw new Error(`Connection closed early (${pos}/${rec.size})`);
    rec.size = pos;
  }

  // ---- HLS (m3u8): fetch segments concurrently, append in order; resumable at segment granularity ----
  _hlsCtx(signal) {
    return { headers: this._headers(), signal, ...this._net() };
  }

  async _hlsOpen(signal) {
    const rec = this.rec;
    if (!rec.hls) {
      const plan = await hls.loadPlan(rec.url, this._hlsCtx(signal));
      rec.hls = { ...plan, next: 0, bytes: 0 };
      if (!rec.nameFixed) {
        const base = U.nameFromUrl(rec.url).replace(/\.m3u8$/i, '') || 'stream';
        rec.fileName = U.sanitizeName(base + (plan.map ? '.mp4' : '.ts'));
        this.ctx.categorize && this.ctx.categorize(rec);
      }
    }
    rec.resumable = true;
    await fsp.mkdir(rec.saveDir, { recursive: true });
    if (rec.hls.next === 0) {
      rec.fileName = this.ctx.uniqueName(rec.saveDir, rec.fileName, rec.id);
      await fsp.rm(this.partPath, { force: true });
    }
    const fh = await fsp.open(this.partPath, fs.existsSync(this.partPath) ? 'r+' : 'w+');
    await fh.truncate(rec.hls.bytes); // drop any half-written tail from a previous run
    return fh;
  }

  async _hlsLoop(fh, signal) { return this._segmentLoop(this.rec.hls, fh, signal); }

  /** Fetch the segments of one plan (HLS playlist or one DASH track) concurrently and append them in order. */
  async _segmentLoop(h, fh, signal) {
    const ctx = this._hlsCtx(signal);
    const conc = Math.min(this._maxConns(), 8);
    const keyCache = new Map();
    const getKey = async idx => {
      if (!keyCache.has(idx)) keyCache.set(idx, hls.fetchBuf(h.keys[idx].uri, ctx));
      return keyCache.get(idx);
    };
    const grab = async seg => {
      for (let attempt = 0; ; attempt++) {
        try {
          let buf = await hls.fetchBuf(seg.u, { ...ctx, range: seg.r });
          if (seg.k >= 0) buf = hls.decrypt(buf, await getKey(seg.k), seg.seq, h.keys[seg.k].iv);
          return buf;
        } catch (e) {
          if (signal.aborted || e.fatal || attempt >= 4) throw e;
          await U.sleep(500 * 2 ** attempt, signal);
        }
      }
    };
    if (h.next === 0 && h.bytes === 0 && h.map) {
      const init = await hls.fetchBuf(h.map.url, { ...ctx, range: h.map.range });
      await fh.write(init, 0, init.length, 0);
      h.bytes = init.length;
    }
    this.conns = conc;
    while (h.next < h.segments.length && !signal.aborted) {
      const batch = h.segments.slice(h.next, h.next + conc);
      const bufs = await Promise.all(batch.map(grab));
      for (const b of bufs) {
        await this._take(b.length, signal);
        await fh.write(b, 0, b.length, h.bytes);
        h.bytes += b.length; h.next++; this._bytes += b.length;
      }
    }
  }

  // ---- RTMP: not resumable (a broken transfer restarts), written as FLV ----
  async _rtmpOpen() {
    const rec = this.rec;
    const info = rtmp.parseUrl(rec.url);
    if (!rec.nameFixed && !rec.segments.length) {
      rec.fileName = U.sanitizeName(info.fileBase + '.flv');
      this.ctx.categorize && this.ctx.categorize(rec);
    }
    rec.resumable = false; rec.size = null; rec.segments = []; rec.bytesDone = 0;
    await fsp.mkdir(rec.saveDir, { recursive: true });
    rec.fileName = this.ctx.uniqueName(rec.saveDir, rec.fileName, rec.id);
    await fsp.rm(this.partPath, { force: true });
    return fsp.open(this.partPath, 'w+');
  }

  async _rtmpLoop(fh, signal) {
    const rec = this.rec, s = this.ctx.settings();
    this.conns = 1;
    let pos = 0;
    for await (const buf of rtmp.play(rec.url, { signal, timeout: s.timeoutMs, onMeta: m => { if (m && typeof m.duration === 'number') rec.duration = m.duration; } })) {
      await this._take(buf.length, signal);
      await fh.write(buf, 0, buf.length, pos);
      pos += buf.length; rec.bytesDone = pos; this._bytes += buf.length;
    }
    if (!signal.aborted) rec.size = pos;
  }

  // ---- DASH (.mpd): each track (video, audio) is downloaded like an HLS playlist, then merged ----
  async _dashRun(signal) {
    const rec = this.rec;
    if (!rec.dash) {
      const xml = (await hls.fetchBuf(rec.url, this._hlsCtx(signal))).toString('utf8');
      const tracks = dash.parseMpd(xml, rec.url);
      rec.dash = {
        done: 0,
        tracks: tracks.map(t => ({
          kind: t.kind, ext: t.ext, bandwidth: t.bandwidth, estBytes: Math.round((t.bandwidth * t.seconds) / 8), map: t.init,
          segments: t.segments.map(s => ({ u: s.u, r: s.r || null, k: -1, seq: 0 })), keys: [], next: 0, bytes: 0,
        })),
      };
      if (!rec.nameFixed) {
        const base = U.nameFromUrl(rec.url).replace(/\.mpd$/i, '') || 'stream';
        rec.fileName = U.sanitizeName(base + (tracks.some(t => t.kind === 'video') ? '.mp4' : tracks[0].ext));
        this.ctx.categorize && this.ctx.categorize(rec);
      }
    }
    rec.resumable = true;
    await fsp.mkdir(rec.saveDir, { recursive: true });
    if (rec.dash.tracks.every(t => t.next === 0 && t.bytes === 0)) {
      rec.fileName = this.ctx.uniqueName(rec.saveDir, rec.fileName, rec.id);
      await this.cleanup();
    }
    for (let i = rec.dash.done; i < rec.dash.tracks.length && !signal.aborted && !this._fatal; i++) {
      const t = rec.dash.tracks[i], p = this.partPath + '.t' + i;
      const fh = await fsp.open(p, fs.existsSync(p) ? 'r+' : 'w+');
      try { await fh.truncate(t.bytes); await this._segmentLoop(t, fh, signal); await fh.sync(); } finally { await fh.close(); }
      if (!signal.aborted && !this._fatal) rec.dash.done = i + 1;
    }
  }

  _mux(video, audio, out) {
    const cmd = [].concat(this.ctx.settings().ffmpeg || 'ffmpeg');
    return new Promise(resolve => {
      require('child_process').execFile(cmd[0], [...cmd.slice(1), '-y', '-i', video, '-i', audio, '-c', 'copy', '-f', 'mp4', out], { windowsHide: true, timeout: 600000 }, err => {
        if (!err) return resolve({ ok: true });
        resolve({ ok: false, reason: err.code === 'ENOENT'
          ? 'ffmpeg was not found: video and audio were saved as separate files (install ffmpeg, or set "ffmpeg" in the settings, to merge them)'
          : 'ffmpeg failed (' + String(err.message).split('\n')[0].slice(0, 160) + '): video and audio were saved as separate files' });
      });
    });
  }

  async _dashFinish() {
    const rec = this.rec, tr = rec.dash.tracks, part = i => this.partPath + '.t' + i;
    if (tr.length === 1) { await fsp.rename(part(0), this.partPath); return this._finish(); }
    const vi = tr.findIndex(t => t.kind === 'video'), ai = tr.findIndex(t => t.kind === 'audio');
    const muxed = this.partPath + '.mux';
    const r = await this._mux(part(vi), part(ai), muxed);
    if (r.ok) {
      await fsp.rename(muxed, this.partPath);
      await fsp.rm(part(vi), { force: true }); await fsp.rm(part(ai), { force: true });
      return this._finish();
    }
    // keep both tracks as separate files next to each other
    const base = rec.fileName.replace(/\.[^.]+$/, '');
    const vName = this.ctx.uniqueName(rec.saveDir, base + '.video' + tr[vi].ext, rec.id);
    const aName = this.ctx.uniqueName(rec.saveDir, base + '.audio' + tr[ai].ext, rec.id);
    await fsp.rename(part(vi), path.join(rec.saveDir, vName));
    await fsp.rename(part(ai), path.join(rec.saveDir, aName));
    await fsp.rm(muxed, { force: true });
    rec.fileName = vName;
    rec.size = (await fsp.stat(path.join(rec.saveDir, vName))).size;
    rec.extraFiles = [aName];
    rec.warning = r.reason;
    rec.dash = undefined; rec.segments = []; rec.bytesDone = rec.size;
    rec.status = 'complete'; rec.completed = Date.now(); rec.error = null;
  }

  /** "Set file creation date as provided by the server" (Last-Modified / FTP MDTM). */
  async _applyServerDate(dest) {
    const lm = this.rec.lastModified;
    if (!lm) return;
    let d = new Date(lm);
    const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/.exec(lm); // FTP MDTM: YYYYMMDDHHMMSS
    if (m) d = new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    if (!isNaN(d)) await fsp.utimes(dest, new Date(), d).catch(() => {});
  }

  async _finish() {
    const rec = this.rec;
    const real = (await fsp.stat(this.partPath)).size;
    if (rec.size != null && real !== rec.size) throw new Error(`Size mismatch (${real}/${rec.size})`);
    let dest = this.destPath;
    if (rec.overwrite) await fsp.rm(dest, { force: true });
    if (fs.existsSync(dest)) { rec.fileName = this.ctx.uniqueName(rec.saveDir, rec.fileName, rec.id); dest = this.destPath; }
    try { await fsp.rename(this.partPath, dest); } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      await fsp.copyFile(this.partPath, dest); await fsp.rm(this.partPath, { force: true }); // temp dir on another drive
    }
    if (this.ctx.settings().setFileDate) await this._applyServerDate(dest);
    rec.size = real;
    rec.segments = [];
    rec.hls = undefined;
    rec.dash = undefined;
    if (rec.speedLimit && !rec.rememberLimit) { rec.speedLimit = 0; this.own.configure({ speedLimit: 0 }); }
    rec.bytesDone = real;
    rec.status = 'complete';
    rec.completed = Date.now();
    rec.error = null;
  }
}

function httpError(sc) {
  const e = new Error(`HTTP ${sc}`);
  e.fatal = sc >= 400 && sc < 500 && sc !== 408 && sc !== 429;
  return e;
}

module.exports = { Download };
