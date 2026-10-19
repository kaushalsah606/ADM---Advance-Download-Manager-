'use strict';
// RTMP play client (Adobe RTMP specification, plain rtmp:// and rtmps://), output: FLV.
// URL splitting rules are implemented in parseUrl(). Not supported: rtmpe/rtmpte (proprietary encryption) and rtmpt (HTTP tunnelling).
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { fatal, abortError } = require('./util');

// ---------------- AMF0 ----------------
function amfEncode(v, out = []) {
  if (v === null) out.push(Buffer.from([0x05]));
  else if (v === undefined) out.push(Buffer.from([0x06]));
  else if (typeof v === 'number') { const b = Buffer.alloc(9); b[0] = 0x00; b.writeDoubleBE(v, 1); out.push(b); }
  else if (typeof v === 'boolean') out.push(Buffer.from([0x01, v ? 1 : 0]));
  else if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); const h = Buffer.alloc(3); h[0] = 0x02; h.writeUInt16BE(s.length, 1); out.push(h, s); }
  else {
    out.push(Buffer.from([0x03]));
    for (const [k, val] of Object.entries(v)) { const key = Buffer.from(k, 'utf8'); const h = Buffer.alloc(2); h.writeUInt16BE(key.length); out.push(h, key); amfEncode(val, out); }
    out.push(Buffer.from([0x00, 0x00, 0x09]));
  }
  return out;
}
const amf = (...values) => Buffer.concat(values.flatMap(v => amfEncode(v)));

function amfDecode(buf, o = 0) {
  const t = buf[o++];
  const str = (len, p) => [buf.toString('utf8', p, p + len), p + len];
  const props = p => {
    const obj = {};
    for (;;) {
      const klen = buf.readUInt16BE(p); p += 2;
      if (klen === 0 && buf[p] === 0x09) return [obj, p + 1];
      const key = buf.toString('utf8', p, p + klen); p += klen;
      const [val, np] = amfDecode(buf, p); obj[key] = val; p = np;
    }
  };
  switch (t) {
    case 0x00: return [buf.readDoubleBE(o), o + 8];
    case 0x01: return [buf[o] !== 0, o + 1];
    case 0x02: { const l = buf.readUInt16BE(o); return str(l, o + 2); }
    case 0x03: return props(o);
    case 0x05: case 0x06: return [null, o];
    case 0x08: return props(o + 4); // ECMA array: 4-byte count, then properties
    case 0x0a: { const n = buf.readUInt32BE(o); let p = o + 4; const arr = []; for (let i = 0; i < n; i++) { const [v, np] = amfDecode(buf, p); arr.push(v); p = np; } return [arr, p]; }
    case 0x0b: return [new Date(buf.readDoubleBE(o)), o + 10];
    case 0x0c: { const l = buf.readUInt32BE(o); return str(l, o + 4); }
    default: throw new Error('Unsupported AMF0 type 0x' + (t || 0).toString(16));
  }
}
function amfDecodeAll(buf) {
  const out = []; let o = 0;
  while (o < buf.length) { const [v, n] = amfDecode(buf, o); out.push(v); o = n; }
  return out;
}

// ---------------- chunk stream ----------------
function chunkOut(csid, ts, type, sid, payload, chunkSize = 128) {
  const parts = [];
  const h = Buffer.alloc(12);
  h[0] = csid & 0x3f; // fmt 0
  h.writeUIntBE(Math.min(ts, 0xffffff), 1, 3);
  h.writeUIntBE(payload.length, 4, 3);
  h[7] = type;
  h.writeUInt32LE(sid, 8);
  parts.push(h);
  for (let off = 0; off < payload.length || off === 0; off += chunkSize) {
    if (off > 0) parts.push(Buffer.from([0xc0 | (csid & 0x3f)])); // fmt 3 continuation
    parts.push(payload.subarray(off, off + chunkSize));
    if (payload.length === 0) break;
  }
  return Buffer.concat(parts);
}

class ChunkReader {
  constructor() { this.buf = Buffer.alloc(0); this.chunkSize = 128; this.streams = new Map(); }

  /** @returns {Array<{type:number, sid:number, ts:number, payload:Buffer}>} completed messages */
  push(data) {
    this.buf = Buffer.concat([this.buf, data]);
    const out = [];
    for (;;) {
      let o = 0;
      if (this.buf.length < 1) break;
      const fmt = this.buf[0] >> 6;
      let csid = this.buf[0] & 0x3f; o = 1;
      if (csid === 0) { if (this.buf.length < 2) break; csid = this.buf[1] + 64; o = 2; }
      else if (csid === 1) { if (this.buf.length < 3) break; csid = this.buf.readUInt16LE(1) + 64; o = 3; }
      const st = this.streams.get(csid) || { ts: 0, delta: 0, len: 0, type: 0, sid: 0, parts: [], got: 0 };
      const hdr = [11, 7, 3, 0][fmt];
      if (this.buf.length < o + hdr) break;
      let ts = st.ts, delta = st.delta, len = st.len, type = st.type, sid = st.sid, ext = false;
      if (fmt <= 2) {
        const t = this.buf.readUIntBE(o, 3);
        if (fmt === 0) ts = t; else delta = t;
        ext = t === 0xffffff;
        if (fmt <= 1) { len = this.buf.readUIntBE(o + 3, 3); type = this.buf[o + 6]; }
        if (fmt === 0) sid = this.buf.readUInt32LE(o + 7);
      }
      let p = o + hdr;
      if (fmt === 3 && st.ext) ext = true;
      if (ext) { if (this.buf.length < p + 4) break; const e = this.buf.readUInt32BE(p); p += 4; if (fmt === 0) ts = e; else if (fmt !== 3) delta = e; }
      const remaining = len - st.got;
      const take = Math.min(remaining, this.chunkSize);
      if (this.buf.length < p + take) break;
      if (fmt === 0) { st.ts = ts; st.delta = 0; } else if (fmt === 1 || fmt === 2) { st.delta = delta; if (st.got === 0) st.ts = (st.ts + delta) >>> 0; } else if (st.got === 0 && st.parts.length === 0) st.ts = (st.ts + st.delta) >>> 0;
      st.len = len; st.type = type; st.sid = sid; st.ext = ext;
      st.parts.push(this.buf.subarray(p, p + take)); st.got += take;
      this.buf = this.buf.subarray(p + take);
      this.streams.set(csid, st);
      if (st.got >= st.len) {
        const msg = { type: st.type, sid: st.sid, ts: st.ts, payload: Buffer.concat(st.parts) };
        st.parts = []; st.got = 0;
        if (msg.type === 1 && msg.payload.length >= 4) this.chunkSize = msg.payload.readUInt32BE(0) & 0x7fffffff;
        out.push(msg);
      }
    }
    return out;
  }
}

// ---------------- URL rules ----------------
function parseUrl(urlStr) {
  const u = new URL(urlStr);
  const secure = u.protocol === 'rtmps:';
  if (!/^rtmps?:$/.test(u.protocol)) throw fatal(u.protocol === 'rtmpe:' || u.protocol === 'rtmpte:' ? 'Encrypted RTMP (' + u.protocol.slice(0, -1) + ') is not supported' : 'Unsupported RTMP variant: ' + u.protocol);
  const port = +u.port || (secure ? 443 : 1935);
  const segs = decodeURIComponent(u.pathname).split('/').filter(Boolean);
  const slist = u.searchParams.get('slist');
  let app, stream;
  if (slist) { app = segs.join('/'); stream = slist; }                       // ?slist=<stream>
  else if (segs[0] === 'ondemand') { app = 'ondemand'; stream = segs.slice(1).join('/'); } // Akamai "ondemand/"
  else if (segs.length >= 3) { app = segs.slice(0, 2).join('/'); stream = segs.slice(2).join('/'); }
  else { app = segs[0] || ''; stream = segs.slice(1).join('/'); }
  if (!stream) throw fatal('The RTMP address has no stream name');
  if (!slist && u.search) stream += u.search;
  if (/\.flv$/i.test(stream)) stream = stream.slice(0, -4);                  // strip ".flv" ...
  else if (/\.(mp4|f4v)(\?|$)/i.test(stream) && !/^mp4:/i.test(stream)) stream = 'mp4:' + stream; // ... and prefixes "mp4:"
  const tcUrl = `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}/${app}`;
  return { secure, host: u.hostname, port, app, stream, tcUrl, fileBase: stream.replace(/^mp4:/, '').split('?')[0].split('/').pop().replace(/\.[^.]+$/, '') || 'stream' };
}

// ---------------- FLV ----------------
const FLV_HEADER = Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0, 0, 0, 9, 0, 0, 0, 0]); // 'FLV', v1, audio+video, header size 9, PreviousTagSize0
function flvTag(type, ts, payload) {
  const h = Buffer.alloc(11);
  h[0] = type; h.writeUIntBE(payload.length, 1, 3);
  h.writeUIntBE(ts & 0xffffff, 4, 3); h[7] = (ts >>> 24) & 0xff; // timestamp + extended byte
  const tail = Buffer.alloc(4); tail.writeUInt32BE(11 + payload.length);
  return Buffer.concat([h, payload, tail]);
}

// ---------------- client ----------------
/**
 * Play a stream and yield FLV bytes (header first, then one buffer per tag).
 * @param {{signal?:AbortSignal, timeout?:number, onMeta?:Function}} opts
 */
async function* play(urlStr, { signal, timeout = 30000, onMeta } = {}) {
  const info = parseUrl(urlStr);
  const sock = await new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const s = info.secure ? tls.connect({ host: info.host, port: info.port, servername: info.host }) : net.connect({ host: info.host, port: info.port });
    s.setTimeout(timeout, () => s.destroy(new Error('RTMP connection timed out')));
    s.once('error', reject);
    s.once(info.secure ? 'secureConnect' : 'connect', () => { s.removeListener('error', reject); resolve(s); });
  });
  const onAbort = () => sock.destroy(abortError());
  signal && signal.addEventListener('abort', onAbort, { once: true });

  // incoming data -> async queue
  const queue = []; let wake = null, ended = false, failure = null;
  sock.on('data', d => { queue.push(d); if (wake) { const w = wake; wake = null; w(); } });
  sock.on('end', () => { ended = true; if (wake) { const w = wake; wake = null; w(); } });
  sock.on('error', e => { failure = e; ended = true; if (wake) { const w = wake; wake = null; w(); } });
  sock.on('close', () => { ended = true; if (wake) { const w = wake; wake = null; w(); } });
  const next = async () => {
    while (!queue.length) {
      if (failure) throw failure;
      if (ended) return null;
      await new Promise(r => { wake = r; });
    }
    return queue.shift();
  };
  let pending = Buffer.alloc(0);
  const need = async n => { while (pending.length < n) { const d = await next(); if (!d) throw new Error('RTMP connection closed during handshake'); pending = Buffer.concat([pending, d]); } const out = pending.subarray(0, n); pending = pending.subarray(n); return out; };

  try {
    // handshake: C0 C1 -> S0 S1 S2 -> C2
    const c1 = Buffer.concat([Buffer.alloc(8), crypto.randomBytes(1528)]);
    sock.write(Buffer.concat([Buffer.from([0x03]), c1]));
    const s0 = await need(1);
    if (s0[0] !== 3) throw fatal(s0[0] === 6 ? 'The server wants encrypted RTMP (rtmpe), which is not supported' : 'Unexpected RTMP version ' + s0[0]);
    const s1 = await need(1536);
    await need(1536); // S2 (echo of C1)
    sock.write(s1);   // C2 = echo of S1

    const reader = new ChunkReader();
    let rx = 0, lastAck = 0, windowSize = 2500000;
    const send = (csid, type, sid, payload, ts = 0) => sock.write(chunkOut(csid, ts, type, sid, payload, 128));
    const ctl = (type, payload) => send(2, type, 0, payload);
    let tcId = 0;
    const cmd = (csid, sid, ...values) => send(csid, 20, sid, amf(...values));

    const messages = async function* () {
      if (pending.length) { const m = reader.push(pending); pending = Buffer.alloc(0); for (const x of m) yield x; }
      for (;;) {
        const d = await next();
        if (!d) return;
        rx += d.length;
        if (rx - lastAck >= windowSize) { const b = Buffer.alloc(4); b.writeUInt32BE(rx >>> 0); ctl(3, b); lastAck = rx; }
        for (const m of reader.push(d)) yield m;
      }
    };

    let state = 'connect', streamId = 0, started = false, firstMedia = false, bytesOut = 0, media = 0;
    cmd(3, 0, 'connect', ++tcId, {
      app: info.app, flashVer: 'WIN 11,0,0,0', tcUrl: info.tcUrl, fpad: false, capabilities: 15, audioCodecs: 4071, videoCodecs: 252, videoFunction: 1, objectEncoding: 0,
    });

    for await (const m of messages()) {
      if (m.type === 5 && m.payload.length >= 4) windowSize = m.payload.readUInt32BE(0) || windowSize;
      else if (m.type === 6) { const b = Buffer.alloc(4); b.writeUInt32BE(windowSize); ctl(5, b); }
      else if (m.type === 4 && m.payload.length >= 2) {
        if (m.payload.readUInt16BE(0) === 6) { const b = Buffer.alloc(6); b.writeUInt16BE(7, 0); m.payload.copy(b, 2, 2, 6); ctl(4, b); } // ping request -> response
      } else if (m.type === 20 || m.type === 17) {
        const body = m.type === 17 ? m.payload.subarray(1) : m.payload;
        let vals; try { vals = amfDecodeAll(body); } catch { continue; }
        const [name, txn, , ...rest] = vals;
        if (name === '_error') throw fatal('The RTMP server refused the request: ' + JSON.stringify(vals.slice(3)));
        if (name === '_result' && state === 'connect') {
          const code = vals[3] && vals[3].code;
          if (code && code !== 'NetConnection.Connect.Success') throw fatal('RTMP connect failed: ' + code);
          state = 'create';
          cmd(3, 0, 'createStream', ++tcId, null);
        } else if (name === '_result' && state === 'create') {
          streamId = Math.round(vals[3]);
          state = 'play';
          cmd(8, streamId, 'play', 0, null, info.stream, -2, -1, true);
          const b = Buffer.alloc(10); b.writeUInt16BE(3, 0); b.writeUInt32BE(streamId, 2); b.writeUInt32BE(3000, 6); ctl(4, b); // SetBufferLength
        } else if (name === 'onStatus') {
          const code = (rest[0] || vals[3] || {}).code || '';
          if (/StreamNotFound|Play\.Failed/.test(code)) throw fatal('RTMP: ' + code);
          if (/Play\.Start$/.test(code)) started = true;
          if (/Play\.(Stop|Complete)$|UnpublishNotify$/.test(code)) { if (!firstMedia) throw fatal('RTMP: stream ended before any data (' + code + ')'); break; }
          void txn;
        }
      } else if ((m.type === 8 || m.type === 9 || m.type === 18 || m.type === 15) && m.payload.length) {
        if (m.type === 15) continue; // AMF3 data: not produced by common servers
        if (m.type === 18) {
          try { const [n, v] = amfDecodeAll(m.payload); if (n === 'onMetaData' || n === '@setDataFrame') { if (onMeta) onMeta(v); } else if (n !== 'onMetaData') continue; } catch { continue; }
        }
        if (!firstMedia) { firstMedia = true; yield FLV_HEADER; bytesOut += FLV_HEADER.length; }
        const tag = flvTag(m.type, m.ts, m.payload);
        bytesOut += tag.length; media++;
        yield tag;
      }
    }
    if (!firstMedia) throw new Error('RTMP: the server sent no media' + (started ? '' : ' (stream did not start)'));
    void media; void bytesOut;
  } finally {
    signal && signal.removeEventListener('abort', onAbort);
    sock.destroy();
  }
}

module.exports = { play, parseUrl, amf, amfDecodeAll, amfDecode, chunkOut, ChunkReader, flvTag, FLV_HEADER };
