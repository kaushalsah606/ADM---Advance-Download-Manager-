'use strict';
// HLS (m3u8) support: master/media playlists, EXT-X-KEY AES-128, EXT-X-MAP, EXT-X-BYTERANGE.
// The same tag set is understood (EXT-X-STREAM-INF, -KEY, -MAP, -BYTERANGE, -MEDIA-SEQUENCE, -ENDLIST…).
const crypto = require('crypto');
const U = require('./util');

const isHlsUrl = u => { try { return /\.m3u8$/i.test(new URL(u).pathname); } catch { return false; } };

async function fetchBuf(url, { headers, signal, range, ...net }) {
  const h = { ...headers };
  if (range) h.Range = `bytes=${range[1]}-${range[1] + range[0] - 1}`;
  const { res } = await U.open(url, { headers: h, signal, ...net });
  if (res.statusCode >= 400 || (range && res.statusCode !== 206 && res.statusCode !== 200)) {
    res.resume();
    const e = new Error('HTTP ' + res.statusCode);
    e.fatal = res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 408 && res.statusCode !== 429;
    throw e;
  }
  const parts = [];
  for await (const c of res) parts.push(c);
  return Buffer.concat(parts);
}

function attrs(s) {
  const out = {};
  for (const m of s.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

function parse(text, base) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw Object.assign(new Error('Not an HLS playlist'), { fatal: true });
  const variants = [];
  const segs = [], keys = [];
  let key = -1, seq = 0, map = null, endlist = false, pendingRange = null, lastEnd = 0, pendingVar = null;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-STREAM-INF:')) pendingVar = attrs(l.slice(18));
    else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = +l.slice(22);
    else if (l.startsWith('#EXT-X-ENDLIST')) endlist = true;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = attrs(l.slice(11));
      if (a.METHOD === 'NONE') key = -1;
      else if (a.METHOD === 'AES-128') { keys.push({ uri: new URL(a.URI, base).href, iv: a.IV || null }); key = keys.length - 1; }
      else throw Object.assign(new Error('Unsupported HLS encryption: ' + a.METHOD), { fatal: true });
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = attrs(l.slice(11));
      map = { url: new URL(a.URI, base).href, range: a.BYTERANGE ? a.BYTERANGE.split('@').map(Number) : null };
      if (map.range && map.range.length === 1) map.range.push(0);
    } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      const [n, o] = l.slice(17).split('@').map(Number);
      pendingRange = [n, o === undefined ? lastEnd : o]; lastEnd = pendingRange[1] + n;
    } else if (!l.startsWith('#')) {
      const url = new URL(l, base).href;
      if (pendingVar) { variants.push({ url, bandwidth: +pendingVar.BANDWIDTH || 0 }); pendingVar = null; continue; }
      segs.push({ u: url, r: pendingRange, k: key, seq: seq++ });
      pendingRange = null;
    }
  }
  return variants.length ? { master: variants } : { segments: segs, keys, map, endlist };
}

/** Resolve to a media-playlist plan (choosing the highest bandwidth variant of a master playlist). */
async function loadPlan(url, ctx) {
  let text = (await fetchBuf(url, ctx)).toString('utf8');
  let p = parse(text, url), at = url;
  if (p.master) {
    at = p.master.sort((a, b) => b.bandwidth - a.bandwidth)[0].url;
    text = (await fetchBuf(at, ctx)).toString('utf8');
    p = parse(text, at);
  }
  if (!p.endlist) throw Object.assign(new Error('Live HLS streams are not supported'), { fatal: true });
  if (!p.segments.length) throw Object.assign(new Error('Empty HLS playlist'), { fatal: true });
  return { segments: p.segments, keys: p.keys, map: p.map };
}

function decrypt(buf, key, seq, ivHex) {
  const iv = ivHex ? Buffer.from(ivHex.replace(/^0x/i, '').padStart(32, '0'), 'hex') : Buffer.alloc(16);
  if (!ivHex) iv.writeUInt32BE(seq >>> 0, 12);
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([d.update(buf), d.final()]);
}

module.exports = { isHlsUrl, loadPlan, fetchBuf, decrypt, parse };
