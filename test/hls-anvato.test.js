'use strict';
// The playlist line handler recognises "#ANVATO-SEGMENT-INFO:" and ignores it: it is a vendor tag
// inside ordinary HLS playlists, not a separate protocol. Same for PLAYLIST-TYPE / PROGRAM-DATE-TIME / DISCONTINUITY.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Manager } = require('../src/manager');

const SEGS = Array.from({ length: 4 }, () => crypto.randomBytes(20000));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advance-download-manager-anv-'));
const PLAYLIST = [
  '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0',
  '#ANVATO-SEGMENT-INFO: type=content', '#EXT-X-PROGRAM-DATE-TIME:2024-01-01T00:00:00Z', '#EXTINF:4,', 's0.ts',
  '#ANVATO-SEGMENT-INFO: type=ad; duration=30', '#EXTINF:4,', 's1.ts',
  '#EXT-X-DISCONTINUITY', '#EXTINF:4,', 's2.ts', '#EXTINF:4,', 's3.ts', '#EXT-X-ENDLIST', '',
].join('\r\n');
const origin = http.createServer((req, res) => {
  if (req.url === '/a.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end(PLAYLIST); }
  const m = /^\/s(\d)\.ts$/.exec(req.url);
  if (m) { res.writeHead(200, { 'Content-Length': SEGS[+m[1]].length }); return res.end(SEGS[+m[1]]); }
  res.writeHead(404); res.end();
});
let base;
test.before(async () => { await new Promise(r => origin.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${origin.address().port}`; });
test.after(() => { origin.closeAllConnections?.(); origin.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('#ANVATO-SEGMENT-INFO, PLAYLIST-TYPE, PROGRAM-DATE-TIME and DISCONTINUITY lines are ignored; all segments are fetched in order', async () => {
  const m = new Manager({ dataDir: path.join(tmp, 'data') }).load();
  const v = m.add({ url: base + '/a.m3u8', saveDir: path.join(tmp, 'o'), queue: null, startNow: true });
  const d = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 15000);
    const check = () => { const x = m.view(m.get(v.id)); if (x.status === 'complete' || x.status === 'error') { clearTimeout(t); resolve(x); } };
    m.on('update', check); check();
  });
  assert.strictEqual(d.status, 'complete', d.error);
  assert.ok(fs.readFileSync(path.join(d.saveDir, d.fileName)).equals(Buffer.concat(SEGS)));
  await m.shutdown();
});
