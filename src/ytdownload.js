'use strict';
// YouTube download without yt-dlp (see src/youtube.js for how the streams are found): every chosen stream is fetched in ranged pieces, several at a
// time, and joined with FFmpeg. Used by VideoDownload when the request was read natively.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const video = require('./video');
const youtube = require('./youtube');

const CHUNK = 8 * 1024 * 1024; // YouTube slows down or refuses one big request
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
});
const sideOf = file => file.replace(/\.part$/, '') + '.ytdl';

/** One stream -> file. A small side file remembers the finished pieces, so a paused or interrupted download continues where it was. */
async function fetchStream({ url, file, size, parallel, signal, onBytes, limiter }) {
  const side = sideOf(file);
  const pieces = Math.ceil(size / CHUNK);
  let done = new Set();
  try {
    const j = JSON.parse(await fsp.readFile(side, 'utf8'));
    if (j.size === size && j.chunk === CHUNK && fs.existsSync(file)) done = new Set(j.done);
  } catch { /* fresh start */ }
  const fh = await fsp.open(file, done.size ? 'r+' : 'w+');
  try {
    if (!done.size) await fh.truncate(size);
    for (const i of done) onBytes(Math.min(CHUNK, size - i * CHUNK));
    const todo = [];
    for (let i = 0; i < pieces; i++) if (!done.has(i)) todo.push(i);
    let saving = Promise.resolve();
    const save = () => { saving = saving.then(() => fsp.writeFile(side, JSON.stringify({ size, chunk: CHUNK, done: [...done] }))).catch(() => {}); };
    const worker = async () => {
      for (let i; (i = todo.shift()) !== undefined;) {
        const from = i * CHUNK, to = Math.min(size, from + CHUNK) - 1;
        let lastErr = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const r = await fetch(url, { headers: { 'User-Agent': youtube.SAFARI_UA, Range: 'bytes=' + from + '-' + to }, signal });
            if (r.status === 403 || r.status === 410) { const e = new Error('The video address has expired'); e.expired = true; throw e; }
            if (r.status !== 206 && !(r.status === 200 && from === 0 && size <= CHUNK)) { const e = new Error('YouTube answered ' + r.status); e.status = r.status; throw e; }
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.length !== to - from + 1) throw new Error('A piece of the video was cut short');
            await fh.write(buf, 0, buf.length, from);
            done.add(i); save(); onBytes(buf.length);
            if (limiter) await limiter(buf.length);
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            if (signal.aborted || e.expired) throw e;
            await sleep(Math.min(20000, (e.status === 429 ? 4000 : 800) * 2 ** attempt), signal);
          }
        }
        if (lastErr) throw lastErr;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, todo.length)) }, worker));
    await saving;
  } finally { await fh.close(); }
}

/** Runs one attempt of a YouTube download for the VideoDownload `dl` (sets rec.status to 'complete' / 'error', or pauses it when aborted). */
async function runNative(dl) {
  const rec = dl.rec, v = rec.video, s = dl.ctx.settings(), signal = dl.abort.signal, nat = v.native;
  const fail = (message, fatal) => { rec.status = 'error'; rec.error = message; rec.fatal = !!fatal; };
  const ff = video.resolveTool('ffmpeg', s.video && s.video.ffmpegPath);
  try {
    await fsp.mkdir(rec.saveDir, { recursive: true });
    let streams = null;
    for (let round = 0; round < 3; round++) { // the addresses expire after a few hours: ask again when one is refused
      const res = await youtube.resolve(nat.id, { signal });
      const byId = id => res.formats.find(f => f.format_id === String(id));
      const near = () => res.formats.filter(f => f.vcodec !== 'none' && f.acodec === 'none').sort((a, b) => Math.abs(a.height - nat.height) - Math.abs(b.height - nat.height) || b.tbr - a.tbr)[0];
      const vf = nat.v ? (byId(nat.v) || near()) : null;
      const af = nat.a ? (byId(nat.a) || res.formats.find(f => f.vcodec === 'none')) : null;
      if (!vf && !af) return fail('YouTube no longer offers this quality. Open the video again.');
      streams = [vf && { f: vf, file: path.join(rec.saveDir, v.base + '.v.part') }, af && { f: af, file: path.join(rec.saveDir, v.base + '.a.part') }].filter(Boolean);
      if (streams.some(x => !x.f.filesize)) return fail('YouTube did not tell the size of this video. Try another quality.');
      rec.size = streams.reduce((n, x) => n + x.f.filesize, 0);
      const got = new Map();
      const report = (k, n) => { got.set(k, (got.get(k) || 0) + n); let sum = 0; for (const x of got.values()) sum += x; rec.bytesDone = sum; dl._bytes = sum; };
      const limit = !s.turbo && s.limiterOn && s.speedLimit > 0 ? s.speedLimit : 0;
      const lim = Math.max(limit, rec.speedLimit || 0), t0 = Date.now();
      let sent = 0;
      const limiter = lim > 0 ? async n => { sent += n; const wait = sent / lim * 1000 - (Date.now() - t0); if (wait > 0) await sleep(wait, signal); } : null;
      const per = Math.max(1, Math.round((s.turbo ? 6 : 4) / streams.length)); // a few pieces at a time: enough for full speed, and the browser tab that is still loading the same video keeps its share of the line
      dl.conns = per * streams.length;
      try {
        await Promise.all(streams.map((x, k) => fetchStream({ url: x.f.url, file: x.file, size: x.f.filesize, parallel: per, signal, onBytes: n => report(k, n), limiter })));
        break;
      } catch (e) { if (!e.expired || round === 2) throw e; }
    }
    dl.conns = 1;

    // join / convert
    const vs = streams.find(x => x.f.vcodec !== 'none'), as = streams.find(x => x.f.vcodec === 'none');
    const ext = vs ? (vs.f.ext === 'mp4' || (as && as.f.ext === 'm4a') ? 'mp4' : 'mkv') : (v.audio === 'mp3' ? 'mp3' : as.f.ext);
    const out = path.join(rec.saveDir, v.base + '.' + ext);
    if ((vs && as) || v.audio === 'mp3') {
      if (!ff) return fail('FFmpeg is needed to join this video and its sound.', true);
      const args = ['-y', '-hide_banner', '-loglevel', 'error', ...streams.flatMap(x => ['-i', x.file])];
      if (v.audio === 'mp3') args.push('-vn', '-c:a', 'libmp3lame', '-q:a', '0');
      else args.push('-c', 'copy', ...(ext === 'mp4' ? ['-movflags', '+faststart'] : []));
      args.push('-f', ext === 'mkv' ? 'matroska' : ext === 'mp4' ? 'mp4' : 'mp3', out);
      const child = spawn(ff[0], [...ff.slice(1), ...args], { windowsHide: true });
      let err = '';
      child.stderr.on('data', c => { err += c; });
      const onAbort = () => video.killTree(child);
      signal.addEventListener('abort', onAbort, { once: true });
      const code = await new Promise(r => { child.on('error', e => { err += e.message; r(-1); }); child.on('close', r); });
      if (signal.aborted) { rec.resumable = true; dl._markPaused(); return; }
      if (code !== 0) return fail('FFmpeg could not join the video: ' + err.trim().split(/\r?\n/).pop().slice(0, 200));
    } else await fsp.rename(streams[0].file, out);
    for (const x of streams) { await fsp.rm(x.file, { force: true }).catch(() => {}); await fsp.rm(sideOf(x.file), { force: true }).catch(() => {}); }
    const st = await fsp.stat(out);
    rec.fileName = path.basename(out);
    rec.size = st.size; rec.bytesDone = st.size;
    rec.status = 'complete'; rec.completed = Date.now(); rec.error = null; rec.warning = '';
    if (rec.speedLimit && !rec.rememberLimit) { rec.speedLimit = 0; dl.own.configure({ speedLimit: 0 }); }
  } catch (e) {
    if (signal.aborted) { rec.resumable = true; dl._markPaused(); return; }
    const known = e && e.code && ['unavailable', 'drm', 'unsupported', 'login', 'geo', 'live'].includes(e.code);
    fail((e && e.message) || String(e), known);
  }
}

module.exports = { runNative, fetchStream };
