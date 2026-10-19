'use strict';
// A "video" download: yt-dlp does the extraction and the transfer, this class makes it behave like every other entry in the list
// (progress, speed, pause / resume, queue, completion). Pausing stops yt-dlp; resuming runs it again and it continues from its .part files.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { Download } = require('./download');
const video = require('./video');

const OUTPUT = /.(mp4|mkv|webm|m4a|mp3|opus|ogg|mov|flv|aac|wav)$/i;
/** yt-dlp prints the final path, but on Windows it mangles non-ASCII characters (emoji, curly quotes). Use it as a hint and fall back to looking for the file by folder and name. */
async function findOutput(dir, base, hint) {
  if (hint) { try { await fsp.access(hint); return hint; } catch { /* mangled or moved */ } }
  let best = null;
  try {
    for (const f of await fsp.readdir(dir)) {
      if (!f.startsWith(base + '.') || !OUTPUT.test(f) || /.f[w-]+.[a-z0-9]+$/i.test(f.slice(base.length))) continue; // not yt-dlp's per-stream leftovers ("name.f137.mp4")
      const m = (await fsp.stat(path.join(dir, f))).mtimeMs;
      if (!best || m > best.m) best = { f, m };
    }
  } catch { /* folder missing */ }
  return best ? path.join(dir, best.f) : null;
}

class VideoDownload extends Download {
  get partPath() { return this.destPath + '.part'; }

  async cleanup(opts = {}) {
    const v = this.rec.video || {};
    if (v.cookieFile && !opts.keepCookies) await fsp.rm(v.cookieFile, { force: true }).catch(() => {});
    // yt-dlp's temporary files next to the target: "<name>.f137.mp4.part", "<name>.mp4.part", "<name>.mp4.ytdl", ...
    const base = v.base;
    if (!base) return;
    try {
      for (const f of await fsp.readdir(this.rec.saveDir)) {
        if (f.startsWith(base + '.') && /\.(part|ytdl|temp\.[a-z0-9]+|part-Frag\d+)$/i.test(f)) await fsp.rm(path.join(this.rec.saveDir, f), { force: true }).catch(() => {});
      }
    } catch { /* folder does not exist */ }
  }

  async _runOnce() {
    if ((this.rec.video || {}).native) return require('./ytdownload').runNative(this); // YouTube through its player API, no yt-dlp
    const rec = this.rec, v = rec.video || {}, s = this.ctx.settings();
    const signal = this.abort.signal;
    const fail = (message, fatal) => { rec.status = 'error'; rec.error = message; rec.fatal = !!fatal; };
    try {
      const yt = video.resolveTool('yt-dlp', s.video && s.video.ytdlpPath);
      if (!yt) return fail('The video engine (yt-dlp) is not installed. Install it in Options → Video.', true);
      const ff = video.resolveTool('ffmpeg', s.video && s.video.ffmpegPath);
      if (v.needsFfmpeg && !ff) return fail('FFmpeg is needed to join this video and its sound. Install it in Options → Video.', true);
      await fsp.mkdir(rec.saveDir, { recursive: true });
      const limit = !s.turbo && s.limiterOn && s.speedLimit > 0 ? s.speedLimit : 0;
      const args = video.downloadArgs({
        url: v.pageUrl, selector: v.selector, audio: v.audio, dir: rec.saveDir, base: v.base, concurrent: s.turbo ? 16 : ((s.video && s.video.concurrentFragments) || 8), cookiesBrowser: s.video && s.video.cookiesBrowser, variant: v.variant, withCookies: v.withCookies !== false,
        cookieFile: v.cookieFile && fs.existsSync(v.cookieFile) ? v.cookieFile : undefined, userAgent: v.userAgent, referer: v.referer, ffmpegCmd: ff, limitRate: Math.max(limit, rec.speedLimit || 0),
      });
      const child = spawn(yt[0], [...yt.slice(1), ...args], { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
      this._child = child;
      this.conns = 1;
      const onAbort = () => video.killTree(child);
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });

      const streams = new Map(); // format id -> { done, total }
      let file = '', buf = '', errText = '';
      const handle = line => {
        const p = video.parseLine(line);
        if (!p) return;
        if (p.file) { file = p.file; return; }
        streams.set(p.stream, { done: p.done, total: p.total });
        let done = 0, total = 0;
        for (const x of streams.values()) { done += x.done; total += Math.max(x.total, x.done); }
        rec.bytesDone = done;
        rec.size = Math.max(total, streams.size < 2 ? v.sizeEstimate || 0 : 0) || null; // a second stream (audio) may still be to come: keep the estimate until both are known
        this._bytes = done;
      };
      child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); } });
      child.stderr.on('data', d => { errText += d; if (errText.length > 20000) errText = errText.slice(-10000); });
      const code = await new Promise(resolve => { child.on('error', e => { errText += String(e.message); resolve(-1); }); child.on('close', resolve); });

      if (signal.aborted && !this._fatal) { rec.resumable = true; this._markPaused(); return; }
      if (code !== 0) {
        const e = video.classify(errText);
        return fail(e.message, ['unavailable', 'drm', 'unsupported', 'login', 'geo', 'live'].includes(e.code)); // retrying these would not help
      }
      const found = await findOutput(rec.saveDir, v.base, file);
      let st;
      try { st = found && await fsp.stat(found); } catch { st = null; }
      if (!st) return fail('The video engine finished but the file was not found.');
      file = found;
      rec.fileName = path.basename(file);
      rec.saveDir = path.dirname(file);
      rec.size = st.size; rec.bytesDone = st.size;
      rec.status = 'complete'; rec.completed = Date.now(); rec.error = null; rec.warning = '';
      if (v.cookieFile) await fsp.rm(v.cookieFile, { force: true }).catch(() => {});
      delete v.cookieFile;
      if (rec.speedLimit && !rec.rememberLimit) { rec.speedLimit = 0; this.own.configure({ speedLimit: 0 }); }
    } catch (e) {
      if (signal.aborted) { rec.resumable = true; this._markPaused(); } else fail(e.message || String(e));
    }
  }
}

module.exports = { VideoDownload };
