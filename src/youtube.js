'use strict';
// YouTube without yt-dlp: the same way YoutubeExplode (github.com/Tyrrrz/YoutubeExplode) does it. A request to YouTube's own player API
// (https://www.youtube.com/youtubei/v1/player) as the "VISIONOS" client returns the stream list with direct, ready-to-use addresses; no sign-in,
// no cipher, no PO token. The "visitorData" it needs comes from https://www.youtube.com/sw.js_data. The streams are then fetched in ranged
// pieces (YouTube slows down or refuses one big request) by src/videodownload.js and joined with FFmpeg.
const video = require('./video');

const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const ANDROID_UA = 'com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip';
const CLIENTS = {
  VISIONOS: { ua: SAFARI_UA, client: { clientName: 'VISIONOS', clientVersion: '1.02', deviceMake: 'Apple', deviceModel: 'RealityDevice17,1', osName: 'visionOS', osVersion: '26.5.23O471' } },
  ANDROID: { ua: ANDROID_UA, client: { clientName: 'ANDROID', clientVersion: '21.26.364', androidSdkVersion: 30, osName: 'Android', osVersion: '11' } },
};

/** The 11-character video id of a watch / youtu.be / shorts / embed / live address, or ''. */
function videoId(url) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  const host = u.hostname.replace(/^(www|m|music)\./i, '').toLowerCase();
  let id = '';
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else { const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname); if (m) id = m[1]; }
  }
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
}

let visitor = { value: '', at: 0 };
async function visitorData(signal) {
  if (visitor.value && Date.now() - visitor.at < 3600e3) return visitor.value;
  const r = await fetch('https://www.youtube.com/sw.js_data', { headers: { 'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; ANDROID 11) gzip', Accept: 'application/json' }, signal });
  if (!r.ok) throw new Error('YouTube answered ' + r.status);
  let t = await r.text();
  if (t.startsWith(")]}'")) t = t.slice(4);
  const v = JSON.parse(t)[0][2][0][0][13];
  if (!v || typeof v !== 'string') throw new Error('YouTube did not give a visitor id');
  visitor = { value: v, at: Date.now() };
  return v;
}

async function playerResponse(id, which, signal) {
  const c = CLIENTS[which];
  const r = await fetch('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST', headers: { 'User-Agent': c.ua, 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ videoId: id, contentCheckOk: true, racyCheckOk: true, context: { client: { ...c.client, visitorData: await visitorData(signal), hl: 'en', gl: 'US', utcOffsetMinutes: 0 } } }),
  });
  if (!r.ok) throw new Error('YouTube answered ' + r.status);
  return r.json();
}

const codecOf = mime => (/codecs="([^"]+)"/.exec(mime || '') || [])[1] || '';
/** YouTube's stream entry -> the field names the quality dialog (buildChoices) already understands. */
function toFormat(f) {
  const mime = String(f.mimeType || ''), codec = codecOf(mime).split(',')[0].trim();
  const mp4 = mime.startsWith('video/mp4') || mime.startsWith('audio/mp4');
  const isAudio = mime.startsWith('audio/'), progressive = !isAudio && /,/.test(codecOf(mime));
  const tbr = (f.averageBitrate || f.bitrate || 0) / 1000;
  return {
    format_id: String(f.itag), url: f.url, ext: isAudio ? (mp4 ? 'm4a' : 'webm') : (mp4 ? 'mp4' : 'webm'), height: +f.height || 0, width: +f.width || 0, fps: +f.fps || 0,
    vcodec: isAudio ? 'none' : codec, acodec: isAudio ? codec : (progressive ? 'mp4a' : 'none'), tbr, abr: isAudio ? tbr : 0, filesize: +f.contentLength || 0,
    default_audio: !(f.audioTrack && f.audioTrack.audioIsDefault === false), dynamic_range: /HDR/i.test(f.colorInfo && f.colorInfo.primaries || '') ? 'HDR' : '',
  };
}

/** Everything about a video: details + the usable streams (one H.264 stream per height where there is one, one default-language audio stream per codec). */
async function resolve(id, { signal } = {}) {
  let lastReason = '';
  for (const which of ['VISIONOS', 'ANDROID']) {
    let j;
    try { j = await playerResponse(id, which, signal); } catch (e) { if (signal && signal.aborted) throw e; lastReason = e.message; continue; }
    const ps = j.playabilityStatus || {};
    if (ps.status !== 'OK') { lastReason = ps.reason || ps.status || ''; if (/private|unavailable|removed|terminated|not exist/i.test(lastReason)) break; continue; }
    const sd = j.streamingData || {};
    const all = [...(sd.formats || []), ...(sd.adaptiveFormats || [])].filter(f => f.url && f.mimeType).map(toFormat);
    if (!all.length) { lastReason = 'no streams'; continue; }
    const d = j.videoDetails || {};
    if (d.isLive) throw new video.VideoError('live', 'Live streams are not supported.');
    const audio = all.filter(f => f.vcodec === 'none' && f.default_audio);
    const vids = all.filter(f => f.vcodec !== 'none');
    const heights = [...new Set(vids.map(f => f.height))];
    const keep = [];
    for (const h of heights) {
      const at = vids.filter(f => f.height === h);
      const avc = at.filter(f => /^avc1/.test(f.vcodec));
      const vp9 = at.filter(f => /^vp0?9/.test(f.vcodec));
      keep.push(...(avc.length ? avc : vp9.length ? vp9 : at));
    }
    return {
      id, title: String(d.title || id), author: String(d.author || ''), seconds: +d.lengthSeconds || 0,
      thumbnail: ((d.thumbnail && d.thumbnail.thumbnails) || []).slice(-1)[0] ? ((d.thumbnail.thumbnails.slice(-1)[0] || {}).url || '') : '',
      client: which, formats: [...keep, ...audio],
    };
  }
  throw lastReason ? video.classify('ERROR: ' + lastReason) : new video.VideoError('failed', 'YouTube did not return this video.');
}

/** Same shape as video.info() (title, thumbnail, quality choices), plus `native` stream numbers on each choice. */
async function info(url, { ffmpeg = false, signal } = {}) {
  const id = videoId(url);
  if (!id) throw new video.VideoError('unsupported', 'This is not a YouTube video address.');
  const res = await resolve(id, { signal });
  const { choices, moreWithFfmpeg } = video.buildChoices({ formats: res.formats, duration: res.seconds }, ffmpeg);
  if (!choices.length) throw new video.VideoError('unsupported', 'No downloadable video was found on this page.');
  const bestAudio = res.formats.filter(f => f.vcodec === 'none').sort((a, b) => (/mp4a/.test(b.acodec) - /mp4a/.test(a.acodec)) || b.abr - a.abr)[0];
  for (const c of choices) {
    if (c.kind === 'audio') { c.native = { a: bestAudio ? bestAudio.format_id : '' }; continue; }
    const at = res.formats.filter(f => f.height === c.height && f.vcodec !== 'none');
    const vo = at.filter(f => f.acodec === 'none').sort((a, b) => b.tbr - a.tbr)[0];
    const prog = at.filter(f => f.acodec !== 'none').sort((a, b) => b.tbr - a.tbr)[0];
    c.native = c.needsFfmpeg ? { v: vo && vo.format_id, a: bestAudio && bestAudio.format_id, height: c.height } : { v: prog && prog.format_id, a: '', height: c.height };
  }
  return { moreWithFfmpeg, id, title: res.title.slice(0, 300), extractor: 'Youtube', uploader: res.author, duration: res.seconds, thumbnail: /^https?:\/\//.test(res.thumbnail) ? res.thumbnail : '', webpageUrl: 'https://www.youtube.com/watch?v=' + id, choices, variant: 'native', withCookies: false, native: true };
}

module.exports = { videoId, resolve, info, SAFARI_UA, CLIENTS };
