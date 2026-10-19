'use strict';
// A stand-in for yt-dlp used by the tests: answers `-J` with a made-up video and "downloads" with progress lines, a .part file and a final file.
// URL keywords pick the behaviour: unsupported | login | playlist | live | fail | single (one progressive file) ; ADM_FAKE_STEP_MS = pause between progress lines.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (process.env.ADM_FAKE_LOG) fs.appendFileSync(process.env.ADM_FAKE_LOG, JSON.stringify(args) + '\n');
if (args.includes('--version') || args.includes('-version')) { console.log('2026.01.01-fake'); process.exit(0); }
if (args[0] === '-U') { console.log('Updated yt-dlp to fake-2'); process.exit(0); }

const url = args[args.length - 1];
const sep = args.lastIndexOf('--');
const arg = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const FMT = (id, h, o = {}) => ({ format_id: id, ext: 'mp4', height: h, width: Math.round(h * 16 / 9), fps: 30, vcodec: 'avc1', acodec: 'none', tbr: h * 3, filesize: h * 1000, ...o });
const AUD = { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', abr: 128, tbr: 128, filesize: 100000 };

if (args.includes('-J')) {
  if (/unsupported/.test(url)) { console.error('ERROR: Unsupported URL: ' + url); process.exit(1); }
  if (/login/.test(url)) { console.error("ERROR: [instagram] x: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication."); process.exit(1); }
  if (/fail/.test(url)) { console.error('ERROR: [generic] HTTP Error 404: Not Found'); process.exit(1); }
  let info;
  if (/single/.test(url)) info = { formats: [{ format_id: 'hd', ext: 'mp4', height: 720, vcodec: 'avc1', acodec: 'mp4a', tbr: 2000, filesize: 700000 }] };
  else info = { formats: [FMT('137', 1080), FMT('136', 720), FMT('22', 720, { acodec: 'mp4a', tbr: 1500, filesize: 650000 }), FMT('18', 360, { acodec: 'mp4a', tbr: 500 }), AUD, { format_id: 'sb0', ext: 'mhtml', format_note: 'storyboard', vcodec: 'none', acodec: 'none' }] };
  Object.assign(info, { id: 'abc123', title: 'My: Test/Video *1*', extractor_key: 'FakeSite', uploader: 'Some Channel', duration: 20, thumbnail: 'http://127.0.0.1:1/thumb.jpg', webpage_url: url.replace(/#.*/, ''), is_live: /live/.test(url) });
  if (/playlist/.test(url)) info = { _type: 'playlist', entries: [Object.assign({}, info, { _type: 'video' })] };
  console.log(JSON.stringify(info));
  process.exit(0);
}

// ---- download ----
const out = arg('-o');
const audioOnly = args.includes('-x');
const dir = path.dirname(out);
const base = path.basename(out).replace(/\.%\(ext\)s$/, '').replace(/%%/g, '%');
const final = path.join(dir, base + (audioOnly ? '.mp3' : '.mp4'));
const part = final + '.part';
if (/fail/.test(url)) { console.error('ERROR: [generic] HTTP Error 404: Not Found'); process.exit(1); }
fs.mkdirSync(dir, { recursive: true });
const merged = /137|136|bv\*/.test(arg('-f') || '') && !/single/.test(url);
const streams = audioOnly ? [['140', 100000]] : merged ? [['137', 600000], ['140', 100000]] : [['22', 650000]];
const total = streams.reduce((a, s) => a + s[1], 0);
let done = fs.existsSync(part) ? fs.statSync(part).size : 0;   // resume from the .part file
const stepMs = +process.env.ADM_FAKE_STEP_MS || 20;
const chunk = Math.ceil(total / 12);
const tick = () => {
  const next = Math.min(total, done + chunk);
  fs.writeFileSync(part, Buffer.alloc(next, 1));
  done = next;
  let left = done;
  for (const [id, size] of streams) {
    const d = Math.min(size, left); left -= d;
    console.log(`ADM|${id}|${d}|${size}|NA|${200000 + done % 1000}|${d >= size ? 'finished' : 'downloading'}`);
    if (left <= 0) break;
  }
  // ADM_FAKE_MANGLE=1: like yt-dlp on Windows, print the path with every non-ASCII character destroyed
  if (done >= total) { fs.renameSync(part, final); console.log('ADMFILE|' + (process.env.ADM_FAKE_MANGLE ? final.replace(/[^\x00-\x7f]+/g, '\ufffd') : final)); process.exit(0); }
  setTimeout(tick, stepMs);
};
tick();
