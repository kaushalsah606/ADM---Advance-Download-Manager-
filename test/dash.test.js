'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dash = require('../src/dash');
const { Manager } = require('../src/manager');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advance-download-manager-dash-'));
const seg = key => Buffer.concat(Array(640).fill(crypto.createHash('sha256').update(key).digest())); // 20 KB, deterministic
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const cat = (...keys) => Buffer.concat(keys.map(seg));

// ---- manifests ----
const MPD_HEAD = '<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S" minBufferTime="PT2S">';
const MAIN = `${MPD_HEAD}
<Period>
  <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">
    <SegmentTemplate timescale="1" duration="2" startNumber="1" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number%03d$.m4s"/>
    <Representation id="v-low" bandwidth="500000" codecs="avc1.4d401e" width="640" height="360"/>
    <Representation id="v-high" bandwidth="2000000" codecs="avc1.640028" width="1280" height="720"/>
  </AdaptationSet>
  <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
    <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2">
      <SegmentTemplate timescale="1000" initialization="a/init.m4a" media="a/$Time$.m4s"><SegmentTimeline><S t="0" d="2000" r="3"/></SegmentTimeline></SegmentTemplate>
    </Representation>
  </AdaptationSet>
  <AdaptationSet contentType="text" mimeType="application/ttml+xml"><Representation id="sub" bandwidth="1000"><BaseURL>subs.xml</BaseURL></Representation></AdaptationSet>
</Period></MPD>`;
const LIST = `${MPD_HEAD}
<Period><AdaptationSet mimeType="video/mp4"><Representation id="r" bandwidth="800000">
  <BaseURL>single/</BaseURL>
  <SegmentList><Initialization sourceURL="init.bin"/><SegmentURL media="s1.bin"/><SegmentURL media="s2.bin" mediaRange="0-99"/></SegmentList>
</Representation></AdaptationSet></Period></MPD>`;
const TWO_PERIODS = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT8S">
<Period id="p1" duration="PT4S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="2" startNumber="1" initialization="i.mp4" media="p1-$Number$.m4s"/><Representation id="x" bandwidth="1000"/></AdaptationSet></Period>
<Period id="p2" duration="PT4S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="2" startNumber="1" initialization="i.mp4" media="p2-$Number$.m4s"/><Representation id="x" bandwidth="1000"/></AdaptationSet></Period></MPD>`;
const LIVE = '<MPD type="dynamic"><Period><AdaptationSet mimeType="video/mp4"><Representation id="x" bandwidth="1"><BaseURL>x.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>';
const DRM = `${MPD_HEAD}<Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation id="x" bandwidth="1"><BaseURL>x.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>`;

// ---- origin ----
const hits = [];
let pumpDelay = 15; // ms per 4 KB piece; raised by tests that need a download in flight
const origin = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); hits.push(u.pathname);
  const send = (body, type = 'application/octet-stream', slow = false) => {
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    let out = body, code = 200;
    if (m) { out = body.subarray(+m[1], +m[2] + 1); code = 206; }
    res.writeHead(code, { 'Content-Type': type, 'Content-Length': out.length });
    if (!slow) return res.end(out);
    let off = 0; const pump = () => { if (res.destroyed) return; res.write(out.subarray(off, off + 4096)); off += 4096; off >= out.length ? res.end() : setTimeout(pump, pumpDelay); }; pump();
  };
  const p = u.pathname;
  const manifests = { '/m/main.mpd': MAIN, '/m/list.mpd': LIST, '/m/two.mpd': TWO_PERIODS, '/m/live.mpd': LIVE, '/m/drm.mpd': DRM };
  if (manifests[p]) return send(Buffer.from(manifests[p]), 'application/dash+xml');
  let m;
  if ((m = /^\/m\/(v-high|v-low)\/(init\.mp4|seg-(\d{3})\.m4s)$/.exec(p))) return send(seg(m[1] + m[2]), 'video/mp4', true);
  if ((m = /^\/m\/a\/(init\.m4a|(\d+)\.m4s)$/.exec(p))) return send(seg('a' + m[1]), 'audio/mp4', true);
  if ((m = /^\/m\/single\/(init|s1|s2)\.bin$/.exec(p))) return send(m[1] === 's2' ? Buffer.concat([seg('s2'), seg('s2-extra')]) : seg(m[1]));
  if ((m = /^\/m\/(i\.mp4|p[12]-\d\.m4s)$/.exec(p))) return send(seg(m[1]));
  res.writeHead(404); res.end();
});
let base;
test.before(async () => { await new Promise(r => origin.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${origin.address().port}`; });
test.after(() => { origin.closeAllConnections?.(); origin.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const mk = (name, s = {}) => { const m = new Manager({ dataDir: path.join(tmp, name, 'data') }).load(); m.setSettings({ minSplitBytes: 64 * 1024, rampMs: 30, ...s }); return m; };
const waitFor = (m, id, pred, ms = 30000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout; ' + JSON.stringify(m.view(m.get(id))))), ms);
  const check = () => { const v = m.view(m.get(id)); if (pred(v)) { clearTimeout(t); m.off('update', check); resolve(v); } };
  m.on('update', check); check();
});
const done = (m, id, ms) => waitFor(m, id, x => x.status === 'complete' || x.status === 'error', ms);

// fake ffmpeg: `-y -i VIDEO -i AUDIO -c copy -f mp4 OUT` -> OUT = VIDEO + AUDIO (so the test can verify the arguments)
const fakeFfmpeg = path.join(tmp, 'fake-ffmpeg.js');
fs.writeFileSync(fakeFfmpeg, `const fs=require('fs');const a=process.argv.slice(2);const v=a[a.indexOf('-i')+1];const au=a[a.lastIndexOf('-i')+1];const out=a[a.length-1];
if(!(a[0]==='-y'&&a.includes('-c')&&a.includes('copy'))) process.exit(3);
fs.writeFileSync(out, Buffer.concat([fs.readFileSync(v), fs.readFileSync(au)]));`);

test('unit: template expansion, ISO durations, timeline repeat, XML entities', () => {
  assert.strictEqual(dash.expand('$RepresentationID$/s-$Number%05d$-$Time$-$$.m4s', { RepresentationID: 'v1', Number: 7, Time: 90 }), 'v1/s-00007-90-$.m4s');
  assert.strictEqual(dash.isoDuration('PT1H2M3.5S'), 3723.5);
  assert.strictEqual(dash.isoDuration('P1DT12H'), 129600);
  const x = dash.parseXml('<a x="1 &amp; 2"><!-- c --><b>t&lt;ext</b><c/><![CDATA[raw <>]]></a>');
  assert.deepStrictEqual([x.attrs.x, x.children[0].text, x.children.length], ['1 & 2', 't<ext', 2]);
  const tl = dash.parseMpd('<MPD type="static" mediaPresentationDuration="PT10S"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" media="t$Time$.m4s"><SegmentTimeline><S t="0" d="2" r="-1"/></SegmentTimeline></SegmentTemplate><Representation id="r" bandwidth="1"/></AdaptationSet></Period></MPD>', 'http://h/a.mpd');
  // r="-1" repeats until the end of the 10 s period: 5 segments of 2 s
  assert.deepStrictEqual(tl[0].segments.map(s => s.u), ['t0', 't2', 't4', 't6', 't8'].map(t => `http://h/${t}.m4s`));
});

test('plan: highest bandwidth video + audio, subtitles ignored, init segments, URLs resolved', () => {
  const t = dash.parseMpd(MAIN, 'http://h/m/main.mpd');
  assert.deepStrictEqual(t.map(x => x.kind), ['video', 'audio']);
  assert.strictEqual(t[0].bandwidth, 2000000);
  assert.strictEqual(t[0].init.url, 'http://h/m/v-high/init.mp4');
  assert.deepStrictEqual(t[0].segments.map(s => s.u), [1, 2, 3, 4].map(n => `http://h/m/v-high/seg-00${n}.m4s`));
  assert.deepStrictEqual(t[1].segments.map(s => s.u), [0, 2000, 4000, 6000].map(n => `http://h/m/a/${n}.m4s`));
  assert.strictEqual(t[0].ext, '.mp4'); assert.strictEqual(t[1].ext, '.m4a');
});

test('video + audio are downloaded and merged with ffmpeg (invoked with -y -i video -i audio -c copy)', async () => {
  const m = mk('merge', { ffmpeg: [process.execPath, fakeFfmpeg], maxConnections: 4 });
  const v = m.add({ url: base + '/m/main.mpd', saveDir: path.join(tmp, 'merge', 'o'), queue: null, startNow: true });
  const d = await done(m, v.id);
  assert.strictEqual(d.status, 'complete', d.error);
  assert.strictEqual(d.fileName, 'main.mp4');
  const expect = cat('v-highinit.mp4', 'v-highseg-001.m4s', 'v-highseg-002.m4s', 'v-highseg-003.m4s', 'v-highseg-004.m4s',
    'ainit.m4a', 'a0.m4s', 'a2000.m4s', 'a4000.m4s', 'a6000.m4s');
  assert.strictEqual(sha(fs.readFileSync(path.join(d.saveDir, d.fileName))), sha(expect));
  assert.ok(!d.warning);
  assert.deepStrictEqual(fs.readdirSync(d.saveDir), ['main.mp4'], 'no temporary files left');
  assert.ok(!hits.some(h => h.includes('v-low')), 'the low-bandwidth representation was never requested');
  await m.shutdown();
});

test('without ffmpeg: video and audio are kept as two files and the user is told', async () => {
  const m = mk('nofm', { ffmpeg: 'surely-no-such-ffmpeg-binary' });
  const v = m.add({ url: base + '/m/main.mpd', saveDir: path.join(tmp, 'nofm', 'o'), queue: null, startNow: true });
  const d = await done(m, v.id);
  assert.strictEqual(d.status, 'complete', d.error);
  assert.deepStrictEqual(fs.readdirSync(d.saveDir).sort(), ['main.audio.m4a', 'main.video.mp4']);
  assert.match(d.warning, /ffmpeg was not found/);
  assert.strictEqual(d.fileName, 'main.video.mp4');
  assert.strictEqual(sha(fs.readFileSync(path.join(d.saveDir, 'main.audio.m4a'))), sha(cat('ainit.m4a', 'a0.m4s', 'a2000.m4s', 'a4000.m4s', 'a6000.m4s')));
  await m.shutdown();
});

test('SegmentList with init, byte ranges and BaseURL; two Periods are concatenated', async () => {
  const m = mk('list');
  const a = m.add({ url: base + '/m/list.mpd', saveDir: path.join(tmp, 'list', 'o'), queue: null, startNow: true });
  const ad = await done(m, a.id);
  assert.strictEqual(ad.status, 'complete', ad.error);
  assert.strictEqual(sha(fs.readFileSync(path.join(ad.saveDir, ad.fileName))), sha(Buffer.concat([seg('init'), seg('s1'), seg('s2').subarray(0, 100)])), 'mediaRange 0-99 honoured');
  const b = m.add({ url: base + '/m/two.mpd', saveDir: path.join(tmp, 'list', 'o2'), queue: null, startNow: true });
  const bd = await done(m, b.id);
  assert.strictEqual(bd.status, 'complete', bd.error);
  assert.strictEqual(sha(fs.readFileSync(path.join(bd.saveDir, bd.fileName))), sha(cat('i.mp4', 'p1-1.m4s', 'p1-2.m4s', 'p2-1.m4s', 'p2-2.m4s')));
  await m.shutdown();
});

test('live and DRM-protected manifests are refused with a clear message', async () => {
  const m = mk('refuse');
  const live = m.add({ url: base + '/m/live.mpd', saveDir: path.join(tmp, 'refuse', 'o'), queue: null, startNow: true });
  assert.match((await waitFor(m, live.id, x => x.status === 'error')).error, /Live DASH/);
  const drm = m.add({ url: base + '/m/drm.mpd', saveDir: path.join(tmp, 'refuse', 'o2'), queue: null, startNow: true });
  assert.match((await waitFor(m, drm.id, x => x.status === 'error')).error, /DRM-protected/);
  await m.shutdown();
});

test('pause in the middle of the second track and resume: result is identical', async () => {
  const dir = path.join(tmp, 'resume', 'o');
  pumpDelay = 60;
  let m = mk('resume', { ffmpeg: [process.execPath, fakeFfmpeg], maxConnections: 1 });
  const v = m.add({ url: base + '/m/main.mpd', saveDir: dir, queue: null, startNow: true });
  await waitFor(m, v.id, x => x.status === 'downloading' && m.get(v.id).rec.dash && m.get(v.id).rec.dash.done === 1 && m.get(v.id).rec.dash.tracks[1].bytes > 20000);
  await m.stop(v.id);
  const rec = m.get(v.id).rec;
  assert.strictEqual(rec.dash.done, 1, 'video track finished, audio in progress');
  await m.shutdown();
  m = new Manager({ dataDir: path.join(tmp, 'resume', 'data') }).load();
  pumpDelay = 15;
  m.setSettings({ ffmpeg: [process.execPath, fakeFfmpeg], rampMs: 30 });
  m.start(v.id);
  const d = await done(m, v.id);
  assert.strictEqual(d.status, 'complete', d.error);
  const expect = cat('v-highinit.mp4', 'v-highseg-001.m4s', 'v-highseg-002.m4s', 'v-highseg-003.m4s', 'v-highseg-004.m4s', 'ainit.m4a', 'a0.m4s', 'a2000.m4s', 'a4000.m4s', 'a6000.m4s');
  assert.strictEqual(sha(fs.readFileSync(path.join(dir, d.fileName))), sha(expect));
  await m.shutdown();
});

test('removing a DASH download deletes its temporary track files', async () => {
  pumpDelay = 60;
  const m = mk('rm', { ffmpeg: [process.execPath, fakeFfmpeg], maxConnections: 1 });
  const v = m.add({ url: base + '/m/main.mpd', saveDir: path.join(tmp, 'rm', 'o'), queue: null, startNow: true });
  await waitFor(m, v.id, x => x.status === 'downloading' && x.done > 30000);
  const dir = path.join(tmp, 'rm', 'o');
  assert.ok(fs.readdirSync(dir).some(f => /\.t\d$/.test(f)), 'track part files exist while downloading');
  await m.remove(v.id);
  pumpDelay = 15;
  assert.deepStrictEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
  await m.shutdown();
});
