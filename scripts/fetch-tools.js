'use strict';
// Downloads yt-dlp and FFmpeg once (checksum-verified, the same code the app uses) into build/tools so that release.js can ship them inside the installer.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'build', 'tools');
process.env.ADM_TOOLS_DIR = dir;
const video = require('../src/video');
(async () => {
  const missing = ['ytdlp', 'ffmpeg'].filter(k => !fs.existsSync(path.join(dir, video.exe(k === 'ytdlp' ? 'yt-dlp' : 'ffmpeg'))) || process.argv.includes('--refresh'));
  if (missing.length) {
    console.log('fetching ' + missing.join(' + ') + ' ...');
    await video.install(missing, { onProgress: () => {} });
  }
  for (const f of fs.readdirSync(dir)) console.log('  ' + f + '  ' + (fs.statSync(path.join(dir, f)).size / 1048576).toFixed(1) + ' MB');
})().catch(e => { console.error(e); process.exit(1); });
