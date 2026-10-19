'use strict';
// MPEG-DASH (.mpd) manifests: SegmentTemplate ($Number$/$Time$/$RepresentationID$/$Bandwidth$, SegmentTimeline), SegmentList,
// SegmentBase / plain BaseURL, multiple Periods. SegmentURL / init_segment lists are parsed as well.
// Not supported: live (dynamic) manifests and DRM-protected content - both are refused with a clear message.
const { fatal } = require('./util');

const isDashUrl = u => { try { return /\.mpd$/i.test(new URL(u).pathname); } catch { return false; } };

// ---------- tiny XML reader (well-formed manifests only; namespaces are dropped) ----------
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
  });
}

function parseXml(src) {
  const local = n => n.slice(n.indexOf(':') + 1);
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const attr = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const stack = [];
  let root = null, last = 0, m;
  const text = (to) => { if (stack.length && to > last) stack[stack.length - 1].text += decode(src.slice(last, to)); };
  while ((m = tag.exec(src))) {
    text(m.index);
    last = tag.lastIndex;
    if (m[1] !== undefined) { if (stack.length) stack[stack.length - 1].text += m[1]; continue; } // CDATA
    if (m[3] === undefined) continue; // comment / PI / doctype
    if (m[2] === '/') { stack.pop(); continue; }
    const el = { name: local(m[3]), attrs: {}, children: [], text: '' };
    for (const a of m[4].matchAll(attr)) el.attrs[local(a[1])] = decode(a[2] !== undefined ? a[2] : a[3]);
    if (stack.length) stack[stack.length - 1].children.push(el); else root = el;
    if (m[5] !== '/') stack.push(el);
  }
  if (!root) throw fatal('Not an XML document');
  return root;
}

const kids = (el, name) => el.children.filter(c => c.name === name);
const kid = (el, name) => el.children.find(c => c.name === name);

function isoDuration(s) {
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s || '');
  if (!m) return null;
  const n = i => (m[i] ? parseFloat(m[i]) : 0);
  return n(1) * 31536000 + n(2) * 2592000 + n(3) * 86400 + n(4) * 3600 + n(5) * 60 + n(6);
}

/** Replace $RepresentationID$, $Number%05d$, $Bandwidth$, $Time$, $$ */
function expand(tpl, vars) {
  return tpl.replace(/\$(\w*)(?:%0(\d+)d)?\$/g, (all, name, width) => {
    if (name === '') return '$';
    if (!(name in vars)) return all;
    const v = String(vars[name]);
    return width ? v.padStart(+width, '0') : v;
  });
}

const resolve = (rel, base) => new URL(rel, base).href;
const rangeOf = r => { const m = /^(\d+)-(\d+)$/.exec(r || ''); return m ? [+m[2] - +m[1] + 1, +m[1]] : null; }; // -> [length, offset] like hls.js

function segmentsFor(rep, adapt, period, base, periodSeconds) {
  const vars = { RepresentationID: rep.attrs.id || '', Bandwidth: rep.attrs.bandwidth || '' };
  const pick = name => kid(rep, name) || kid(adapt, name) || kid(period, name);
  const tpl = pick('SegmentTemplate'), list = pick('SegmentList');
  const out = { init: null, segments: [] };
  if (tpl) {
    // attributes may be split between AdaptationSet-level and Representation-level templates
    const t = { ...(kid(adapt, 'SegmentTemplate') || {}).attrs, ...(kid(rep, 'SegmentTemplate') || {}).attrs };
    const tl = kid(kid(rep, 'SegmentTemplate') || kid(adapt, 'SegmentTemplate') || tpl, 'SegmentTimeline');
    const timescale = +(t.timescale || 1), start = +(t.startNumber || 1);
    if (t.initialization) out.init = { url: resolve(expand(t.initialization, vars), base), range: null };
    if (!t.media) throw fatal('DASH SegmentTemplate without a media attribute');
    if (tl) {
      let time = 0, number = start;
      for (const s of kids(tl, 'S')) {
        if (s.attrs.t !== undefined) time = +s.attrs.t;
        const d = +s.attrs.d;
        let r = s.attrs.r !== undefined ? +s.attrs.r : 0;
        if (r < 0) r = Math.max(0, Math.ceil(((periodSeconds || 0) * timescale - time) / d) - 1);
        for (let i = 0; i <= r; i++) {
          out.segments.push({ u: resolve(expand(t.media, { ...vars, Number: number, Time: time }), base) });
          number++; time += d;
        }
      }
    } else {
      const d = +t.duration;
      if (!d) throw fatal('DASH SegmentTemplate needs a duration or a SegmentTimeline');
      if (!periodSeconds) throw fatal('Cannot tell how long this DASH period is');
      const count = Math.ceil((periodSeconds * timescale) / d);
      for (let i = 0; i < count; i++) out.segments.push({ u: resolve(expand(t.media, { ...vars, Number: start + i, Time: i * d }), base) });
    }
  } else if (list) {
    const ini = kid(list, 'Initialization');
    if (ini && ini.attrs.sourceURL) out.init = { url: resolve(ini.attrs.sourceURL, base), range: rangeOf(ini.attrs.range) };
    for (const s of kids(list, 'SegmentURL')) out.segments.push({ u: resolve(s.attrs.media || '', base), r: rangeOf(s.attrs.mediaRange) });
  } else {
    out.segments.push({ u: base }); // SegmentBase / plain BaseURL: the representation is one file
  }
  return out;
}

/**
 * @returns {Array<{kind:'video'|'audio', mime:string, codecs:string, bandwidth:number, ext:string, init:?{url,range}, segments:Array<{u,r?}>, seconds:number}>}
 */
function parseMpd(xml, manifestUrl) {
  const root = parseXml(xml);
  if (root.name !== 'MPD') throw fatal('Not a DASH manifest (no MPD element)');
  if (root.attrs.type === 'dynamic') throw fatal('Live DASH streams are not supported');
  const total = isoDuration(root.attrs.mediaPresentationDuration);
  const baseOf = (el, base) => { const b = kid(el, 'BaseURL'); return b && b.text.trim() ? resolve(b.text.trim(), base) : base; };
  const mpdBase = baseOf(root, manifestUrl);
  const periods = kids(root, 'Period');
  if (!periods.length) throw fatal('The manifest has no Period');
  const tracks = new Map();
  periods.forEach((period, pi) => {
    const pBase = baseOf(period, mpdBase);
    let seconds = isoDuration(period.attrs.duration);
    if (seconds == null) seconds = periods.length === 1 ? total : null;
    for (const adapt of kids(period, 'AdaptationSet')) {
      if (kids(adapt, 'ContentProtection').length || kids(adapt, 'Representation').some(r => kids(r, 'ContentProtection').length)) {
        throw fatal('This DASH stream is DRM-protected and cannot be downloaded');
      }
      const aBase = baseOf(adapt, pBase);
      const reps = kids(adapt, 'Representation');
      if (!reps.length) continue;
      const mimeOf = r => r.attrs.mimeType || adapt.attrs.mimeType || '';
      const kind = (adapt.attrs.contentType || mimeOf(reps[0]).split('/')[0] || '').toLowerCase();
      if (kind !== 'video' && kind !== 'audio') continue; // subtitles, thumbnails...
      const rep = reps.slice().sort((a, b) => (+b.attrs.bandwidth || 0) - (+a.attrs.bandwidth || 0))[0];
      const seg = segmentsFor(rep, adapt, period, baseOf(rep, aBase), seconds);
      const key = kind;
      if (!tracks.has(key)) {
        const mime = mimeOf(rep);
        tracks.set(key, {
          kind, mime, codecs: rep.attrs.codecs || adapt.attrs.codecs || '', bandwidth: +rep.attrs.bandwidth || 0,
          ext: kind === 'audio' ? (/mp4|m4a/.test(mime) ? '.m4a' : '.mka') : (/mp4/.test(mime) ? '.mp4' : '.mkv'),
          init: seg.init, segments: [], seconds: 0,
        });
      }
      const t = tracks.get(key);
      t.segments.push(...seg.segments);
      t.seconds += seconds || total || 0;
      void pi;
    }
  });
  const out = [...tracks.values()].sort((a, b) => (a.kind === 'video' ? -1 : 1) - (b.kind === 'video' ? -1 : 1));
  if (!out.length) throw fatal('No audio or video representation found in the manifest');
  return out;
}

module.exports = { isDashUrl, parseMpd, parseXml, expand, isoDuration };
