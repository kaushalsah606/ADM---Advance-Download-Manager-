'use strict';
// "Download this video": video pages (YouTube, Facebook, Instagram, TikTok, ... every site yt-dlp supports) through yt-dlp, with FFmpeg to merge
// separate video and audio streams. This module finds / installs the tools, reads a page's video information, builds the list of quality
// choices and the yt-dlp command line. The download itself runs in src/videodownload.js.
//
// Not supported: DRM-protected streams (Netflix, Disney+ ...), live streams. Only download what you have the right to download; the terms of
// some sites forbid downloading.
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const isWin = process.platform === 'win32';
const exe = n => (isWin ? n + '.exe' : n);
const toolsDir = () => process.env.ADM_TOOLS_DIR
  || path.join(isWin ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')) : path.join(os.homedir(), '.local', 'share'), 'Advance Download Manager', 'tools');

/** The copies that ship inside the installed app (<app folder>\tools): yt-dlp and FFmpeg work from the first start, with nothing to install. */
const bundledDir = () => process.env.ADM_BUNDLED_TOOLS || path.join(path.dirname(process.execPath), 'tools');

const SOURCES = {
  ytdlp: { name: 'yt-dlp', url: isWin ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
    sums: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS', file: isWin ? 'yt-dlp.exe' : 'yt-dlp', approxMB: 18 },
  // BtbN's automated FFmpeg builds (LGPL, no GPL-only libraries needed to join streams and make MP3); GitHub's servers are fast and the checksums sit next to the file
  ffmpeg: { name: 'FFmpeg', url: 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-lgpl.zip', sums: 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/checksums.sha256',
    file: 'ffmpeg-master-latest-win64-lgpl.zip', approxMB: 170 },
};

// ---------------------------------------------------------------- finding the tools (no process is started here)
function onPath(name) {
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').concat(['']) : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const e of exts) { const p = path.join(dir, name + e.toLowerCase()); try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
  }
  return null;
}
/** Command (array: executable + fixed leading args) for a tool: the configured one, the one this app installed, or one on PATH. */
function resolveTool(name, configured) {
  if (configured && (Array.isArray(configured) ? configured.length : String(configured).trim())) return [].concat(configured);
  const own = path.join(toolsDir(), exe(name));
  if (fs.existsSync(own)) return [own]; // a copy that was updated or installed from the app's options wins over the shipped one
  const shipped = path.join(bundledDir(), exe(name));
  if (fs.existsSync(shipped)) return [shipped];
  const sys = onPath(name);
  return sys ? [sys] : null;
}
const versions = new Map();
/** Version string of a tool (async, cached). */
function toolVersion(cmd) {
  if (!cmd) return Promise.resolve('');
  const key = cmd.join('\0');
  if (versions.has(key)) return versions.get(key);
  const p = new Promise(resolve => {
    try {
      const c = spawn(cmd[0], [...cmd.slice(1), cmd[0].toLowerCase().includes('ffmpeg') ? '-version' : '--version'], { windowsHide: true });
      let out = ''; c.stdout.on('data', d => { out += d; });
      const t = setTimeout(() => { try { c.kill(); } catch { /* done */ } resolve(''); }, 20000);
      c.on('error', () => { clearTimeout(t); resolve(''); });
      c.on('close', () => { clearTimeout(t); resolve(out.split(/\r?\n/)[0].replace(/^ffmpeg version\s+/, '').trim().slice(0, 60)); });
    } catch { resolve(''); }
  });
  versions.set(key, p);
  return p;
}
function forgetVersions() { versions.clear(); }

// ---------------------------------------------------------------- errors
class VideoError extends Error { constructor(code, message) { super(message); this.code = code; } }
function classify(stderr) {
  const t = String(stderr || '');
  const last = (t.split(/\r?\n/).reverse().find(l => /^ERROR:/i.test(l)) || t.trim().split(/\r?\n/).pop() || 'Unknown error').replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/i, '').slice(0, 300);
  if (/Unsupported URL/i.test(t)) return new VideoError('unsupported', 'No downloadable video was found on this page.');
  if (/DRM|Widevine|protected by/i.test(t)) return new VideoError('drm', 'This video is protected by DRM and cannot be downloaded.');
  if (/page needs to be reloaded/i.test(t)) return new VideoError('login', 'YouTube rejected the saved login (it changed while the page was open). Reload the YouTube page and try again.');
  if (/Failed to decrypt|DPAPI|Could not copy .*cookie|cookies? database/i.test(t)) return new VideoError('cookies', 'Windows would not let the app read the login of that browser (Chrome and Edge lock it). Choose Firefox in Options → Video, or start the download from the video page with the browser extension, which passes the login itself.');
  if (/Sign in to confirm|not a bot|log ?in|sign in|authentication|private video|members.only|requires? (a )?login|cookies/i.test(t)) return new VideoError('login', 'The site wants you to be signed in. Sign in in your browser and try again from the video page (the extension passes your login to the app). ' + last);
  if (/not available in your country|geo.?restrict|blocked it in your country/i.test(t)) return new VideoError('geo', 'This video is not available in your country.');
  if (/HTTP Error 429|Too Many Requests/i.test(t)) return new VideoError('ratelimit', 'YouTube (or the site) is limiting requests from this connection right now (HTTP 429). The app already retries slowly; if it keeps happening, pick your browser under Options → Video → "Use the login of this browser", update the video engine, or wait a few minutes.');
  if (/live event|is live|live stream|This live/i.test(t)) return new VideoError('live', 'Live streams are not supported.');
  if (/Video unavailable|has been removed|does not exist|no longer available|HTTP Error 404/i.test(t)) return new VideoError('unavailable', 'The video is no longer available.');
  return new VideoError('failed', last);
}

/** YouTube checks that the client that asked for the video is the one that downloads it, and answers 429 / 403 to a browser's User-Agent on yt-dlp's own requests. */
const isYouTube = u => { try { return /(^|.)(youtube.com|youtu.be|youtube-nocookie.com|googlevideo.com)$/i.test(new URL(u).hostname); } catch { return false; } };
/** Arguments that keep a site from rate-limiting us: no borrowed User-Agent on YouTube, patient retries, and (optionally) the login of a browser installed here. */
function politeArgs(url, { cookiesBrowser } = {}) {
  const a = ['--extractor-retries', '5', '--retry-sleep', 'http:exp=1:30', '--retry-sleep', 'fragment:exp=1:30', '--retry-sleep', 'extractor:exp=2:30'];
  if (isYouTube(url)) a.push('--sleep-requests', '0.75');
  if (/^(edge|chrome|firefox|brave|opera|vivaldi|chromium)$/.test(cookiesBrowser || '')) a.push('--cookies-from-browser', cookiesBrowser);
  return a;
}

/** Ways to ask yt-dlp for the same video. The first is the plain one; when a site rejects it (a rotated YouTube login: "The page needs to be reloaded", a bot check, TikTok wanting a real browser fingerprint) the next ones are tried. */
const VARIANT_ARGS = {
  default: [],
  safari: ['--extractor-args', 'youtube:player_client=web_safari,mweb'],
  vr: ['--extractor-args', 'youtube:player_client=android_vr,web_safari'],
  impersonate: ['--impersonate', 'chrome'],
};
function plan(url, hasCookies) {
  const yt = isYouTube(url);
  const list = yt ? [['default', true], ['safari', true], ['default', false], ['safari', false], ['vr', false]]
    : [['default', true], ['impersonate', true], ['default', false], ['impersonate', false]];
  return list.filter(([, c]) => hasCookies || !c).map(([id, cookies]) => ({ id, cookies }));
}
const variantArgs = id => VARIANT_ARGS[id] || [];

// ---------------------------------------------------------------- cookies (Netscape format, for --cookies)
function writeCookieFile(file, cookies) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies || []) {
    if (!c || !c.name || !c.domain) continue;
    const exp = c.expirationDate ? Math.floor(c.expirationDate) : Math.floor(Date.now() / 1000) + 86400; // session cookies: valid for a day
    lines.push([(c.httpOnly ? '#HttpOnly_' : '') + c.domain, c.domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', exp, String(c.name).replace(/[\t\r\n]/g, ''), String(c.value).replace(/[\t\r\n]/g, '')].join('\t'));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
}

// ---------------------------------------------------------------- reading a video page
const validUrl = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && String(u).length < 2048 && !/\s/.test(u); } catch { return false; } };

/** Runs a tool and collects stdout / stderr. */
function run(cmd, args, { timeoutMs = 120000, signal, maxBytes = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd[0], [...cmd.slice(1), ...args], { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    let out = '', err = '', size = 0;
    const kill = () => { try { c.kill(); } catch { /* done */ } };
    const t = setTimeout(() => { kill(); reject(new VideoError('timeout', 'Reading the video information took too long.')); }, timeoutMs);
    if (signal) signal.addEventListener('abort', () => { kill(); clearTimeout(t); reject(new VideoError('aborted', 'Cancelled')); }, { once: true });
    c.stdout.on('data', d => { size += d.length; if (size > maxBytes) { kill(); } else out += d; });
    c.stderr.on('data', d => { err += d; if (err.length > 200000) err = err.slice(-100000); });
    c.on('error', e => { clearTimeout(t); reject(new VideoError('missing', 'The video engine could not be started: ' + e.message)); });
    c.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

/** Information about the video on a page: title, thumbnail, duration and the quality choices. */
async function info(url, { cmd, ffmpeg = false, cookieFile, userAgent, referer, cookiesBrowser, signal } = {}) {
  if (!validUrl(url)) throw new VideoError('badurl', 'This is not a web address.');
  if (!cmd) throw new VideoError('notools', 'The video engine (yt-dlp) is not installed.');
  const hopeless = ['unsupported', 'drm', 'unavailable', 'geo', 'live', 'badurl', 'notools']; // another way of asking would not help
  let first = null, r = null, used = null;
  for (const v of plan(url, !!(cookieFile || cookiesBrowser))) {
    const args = ['-J', '--no-playlist', '--no-warnings', '--socket-timeout', '30', ...politeArgs(url, { cookiesBrowser: v.cookies ? cookiesBrowser : '' }), ...variantArgs(v.id)];
    if (cookieFile && v.cookies) args.push('--cookies', cookieFile);
    if (userAgent && !isYouTube(url) && v.id !== 'impersonate') args.push('--user-agent', userAgent);
    if (referer && !isYouTube(url)) args.push('--referer', referer);
    args.push('--', url);
    const res = await run(cmd, args, { signal });
    if (res.code === 0 && res.out.trim()) { r = res; used = v; break; }
    const e = classify(res.err);
    if (!first) first = e;
    if (hopeless.includes(e.code) || (signal && signal.aborted)) throw first;
  }
  if (!r) throw first || new VideoError('failed', 'The video could not be read.');
  let j;
  try { j = JSON.parse(r.out); } catch { throw new VideoError('failed', 'The video engine returned an unreadable answer.'); }
  if (j._type === 'playlist') j = (j.entries || []).find(Boolean) || j;
  if (j.is_live) throw new VideoError('live', 'Live streams are not supported.');
  const formats = Array.isArray(j.formats) ? j.formats : [];
  const { choices, moreWithFfmpeg } = buildChoices({ formats, duration: j.duration }, ffmpeg);
  if (!choices.length) throw new VideoError('unsupported', 'No downloadable video was found on this page.');
  return {
    moreWithFfmpeg,
    id: String(j.id || ''), title: String(j.title || j.fulltitle || 'video').slice(0, 300), extractor: String(j.extractor_key || j.extractor || ''), uploader: String(j.uploader || j.channel || ''),
    variant: used.id, withCookies: used.cookies, duration: +j.duration || 0, thumbnail: /^https?:\/\//.test(j.thumbnail || '') ? j.thumbnail : '', webpageUrl: validUrl(j.webpage_url) ? j.webpage_url : url, choices,
  };
}

const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);
const sizeOf = (f, duration) => num(f.filesize) || num(f.filesize_approx) || (num(f.tbr) && duration ? Math.round(num(f.tbr) * 1000 / 8 * duration) : 0);
const hasVideo = f => f.vcodec && f.vcodec !== 'none';
const hasAudio = f => f.acodec && f.acodec !== 'none';

/** Quality list shown in the dialog. Selectors are chosen here, never taken from the browser. */
function buildChoices({ formats, duration }, ffmpeg) {
  const vids = formats.filter(hasVideo).filter(f => !/storyboard|mhtml/i.test(f.format_note || f.ext || ''));
  const auds = formats.filter(f => !hasVideo(f) && hasAudio(f));
  const bestBy = (list, key) => list.slice().sort((a, b) => num(b[key]) - num(a[key]))[0];
  const bestAudio = bestBy(auds, 'abr') || bestBy(auds, 'tbr');
  const audioSize = bestAudio ? sizeOf(bestAudio, duration) : 0;
  const choices = [];
  let moreWithFfmpeg = false;
  const heights = [...new Set(vids.map(f => num(f.height)).filter(h => h > 0))].sort((a, b) => b - a);
  for (const h of heights) {
    const atH = vids.filter(f => num(f.height) === h);
    const bestVideoOnly = bestBy(atH.filter(f => !hasAudio(f)), 'tbr');
    const bestProg = bestBy(atH.filter(hasAudio), 'tbr'); // one file that already has sound: needs no FFmpeg
    const canMerge = !!(auds.length && bestVideoOnly);
    const useMerge = canMerge && ffmpeg && (!bestProg || num(bestVideoOnly.tbr) > num(bestProg.tbr) * 1.15);
    if (canMerge && !ffmpeg) moreWithFfmpeg = true;
    if (!useMerge && !bestProg) continue; // sound would have to be joined with FFmpeg
    const pick = useMerge ? bestVideoOnly : bestProg;
    choices.push({
      id: 'h' + h, label: h + 'p', detail: [pick.ext, num(pick.fps) > 32 ? Math.round(pick.fps) + ' fps' : '', /hdr/i.test(pick.dynamic_range || '') ? 'HDR' : ''].filter(Boolean).join(' · '),
      size: useMerge ? sizeOf(pick, duration) + audioSize : sizeOf(pick, duration), kind: 'video', needsFfmpeg: useMerge, height: h,
      selector: useMerge ? `bv*[height<=${h}]+ba/b[height<=${h}]` : `b[height<=${h}]`,
    });
  }
  const maybeVideo = formats.filter(f => f.vcodec !== 'none' && !/storyboard|mhtml/i.test(f.format_note || f.ext || ''));
  if (!heights.length && maybeVideo.length) { // no resolution information (direct files, some sites): one "original" choice; audio-only pages are excluded
    const best = bestBy(maybeVideo, 'tbr') || maybeVideo[maybeVideo.length - 1];
    choices.push({ id: 'best', label: 'Original quality', detail: best.ext || '', size: sizeOf(best, duration), kind: 'video', needsFfmpeg: false, selector: 'b/bv*+ba', height: 0 });
  }
  if (auds.length || vids.some(hasAudio)) {
    choices.push({ id: 'audio-m4a', label: 'Audio only', detail: (bestAudio && bestAudio.ext) || 'original', size: audioSize, kind: 'audio', needsFfmpeg: false, selector: 'ba/b', audio: 'native' });
    if (ffmpeg) choices.push({ id: 'audio-mp3', label: 'Audio only — MP3', detail: 'converted', size: audioSize, kind: 'audio', needsFfmpeg: true, selector: 'ba/b', audio: 'mp3' });
  }
  if (choices.length && choices[0].kind === 'video') choices.unshift({ ...choices[0], id: 'best-video', label: 'Best quality (' + choices[0].label + ')', best: true });
  return { choices, moreWithFfmpeg };
}

/** The yt-dlp command line for a chosen quality. All values come from the app (selector from buildChoices, folder / name from the user). */
function downloadArgs({ url, selector, audio, dir, base, concurrent = isYouTube(url) ? 4 : 8, cookieFile, userAgent, referer, ffmpegCmd, limitRate = 0, cookiesBrowser, variant = 'default', withCookies = true }) {
  const args = ['-f', selector, '--no-playlist', '--newline', '--no-colors', '--no-warnings', '--windows-filenames', '--progress', '--no-simulate',
    '--progress-template', 'download:ADM|%(info.format_id)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.status)s',
    '--print', 'after_move:ADMFILE|%(filepath)s', '--retries', '10', '--fragment-retries', '10', '--concurrent-fragments', String(Math.max(1, Math.min(32, concurrent | 0 || 8))),
    '--socket-timeout', '30', ...politeArgs(url, { cookiesBrowser: withCookies ? cookiesBrowser : '' }), ...variantArgs(variant), '-o', path.join(dir, base.replace(/%/g, '%%') + '.%(ext)s')];
  if (audio === 'mp3') args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  else if (!audio) args.push('-S', 'res,ext:mp4:m4a', '--merge-output-format', 'mp4');
  if (ffmpegCmd && path.isAbsolute(ffmpegCmd[0])) args.push('--ffmpeg-location', ffmpegCmd[0]);
  if (cookieFile && withCookies) args.push('--cookies', cookieFile);
  if (userAgent && !isYouTube(url) && variant !== 'impersonate') args.push('--user-agent', userAgent);
  if (referer && !isYouTube(url)) args.push('--referer', referer);
  if (limitRate > 0) args.push('--limit-rate', String(Math.floor(limitRate)));
  args.push('--', url);
  return args;
}

/** One output line of yt-dlp -> { stream, done, total, speed } | { file } | null */
function parseLine(line) {
  if (line.startsWith('ADMFILE|')) return { file: line.slice(8).trim() };
  if (!line.startsWith('ADM|')) return null;
  const p = line.split('|');
  const n = s => { const v = parseFloat(s); return isFinite(v) ? v : 0; };
  return { stream: p[1] || '0', done: n(p[2]), total: n(p[3]) || n(p[4]), speed: n(p[5]), status: (p[6] || '').trim() };
}

/** Stops a spawned tool and everything it started. */
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (isWin) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
    else child.kill('SIGTERM');
  } catch { try { child.kill(); } catch { /* done */ } }
}

// ---------------------------------------------------------------- installing / updating the tools
async function download(url, onProgress, signal) {
  const r = await fetch(url, { redirect: 'follow', signal, headers: { 'User-Agent': 'AdvanceDownloadManager' } });
  if (!r.ok) throw new Error(`Download failed (HTTP ${r.status})`);
  const total = +r.headers.get('content-length') || 0;
  const chunks = []; let got = 0;
  for await (const ch of r.body) { chunks.push(ch); got += ch.length; if (onProgress) onProgress(got, total); }
  return Buffer.concat(chunks);
}
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
async function expectedSum(sumsUrl, fileName, signal) {
  const text = (await download(sumsUrl, null, signal)).toString('utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim()); // "<hash>  <name>"
    if (m && path.basename(m[2]) === fileName) return m[1].toLowerCase();
  }
  const only = /^([0-9a-f]{64})\s*$/i.exec(text.trim().split(/\r?\n/)[0]); // gyan.dev: the file holds only the hash
  if (only) return only[1].toLowerCase();
  throw new Error('No checksum published for ' + fileName);
}

/** Download and verify yt-dlp and / or FFmpeg into the tools folder. onProgress({ tool, received, total }) */
async function install(which, { onProgress, signal } = {}) {
  const dir = toolsDir();
  await fsp.mkdir(dir, { recursive: true });
  const done = [];
  for (const key of ['ytdlp', 'ffmpeg']) {
    if (!which.includes(key)) continue;
    const src = SOURCES[key];
    const expected = await expectedSum(src.sums, key === 'ytdlp' ? path.basename(new URL(src.url).pathname) : src.file, signal);
    const data = await download(src.url, (received, total) => onProgress && onProgress({ tool: src.name, received, total }), signal);
    if (sha256(data) !== expected) throw new Error(`${src.name}: the download does not match its published checksum - it was not installed`);
    if (key === 'ytdlp') {
      const tmp = path.join(dir, src.file + '.new');
      await fsp.writeFile(tmp, data, { mode: 0o755 });
      await fsp.rename(tmp, path.join(dir, src.file));
    } else {
      if (!isWin) throw new Error('Install FFmpeg with your package manager (it must be on PATH)');
      const zip = path.join(dir, src.file);
      await fsp.writeFile(zip, data);
      const out = path.join(dir, '_ffmpeg_extract');
      await fsp.rm(out, { recursive: true, force: true });
      const r = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${out}' -Force`], { windowsHide: true, timeout: 300000 });
      if (r.status !== 0) throw new Error('Could not unpack FFmpeg');
      const bin = (function find(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { const f = find(p); if (f) return f; } else if (e.name.toLowerCase() === 'ffmpeg.exe') return p; } return null; })(out);
      if (!bin) throw new Error('ffmpeg.exe was not found in the download');
      await fsp.copyFile(bin, path.join(dir, 'ffmpeg.exe'));
      await fsp.rm(out, { recursive: true, force: true });
      await fsp.rm(zip, { force: true });
    }
    done.push(src.name);
    forgetVersions();
  }
  return done;
}

/** yt-dlp updates itself (the sites change often). Only for the copy this app installed. */
async function updateYtDlp(cmd) {
  if (!cmd) throw new Error('yt-dlp is not installed');
  const r = await run(cmd, ['-U'], { timeoutMs: 180000 });
  forgetVersions();
  return (r.out + r.err).trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
}

module.exports = { plan, bundledDir, isYouTube, politeArgs, toolsDir, resolveTool, toolVersion, forgetVersions, SOURCES, VideoError, classify, writeCookieFile, validUrl, info, buildChoices, downloadArgs, parseLine, killTree, install, updateYtDlp, run, exe };
