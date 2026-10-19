'use strict';
// "Download this video": quality choices, command line, tool installation, and the whole flow (request -> quality dialog -> download) with a fake yt-dlp.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-video-'));
process.env.ADM_TOOLS_DIR = path.join(tmp, 'tools');
process.env.ADM_FAKE_LOG = path.join(tmp, 'fake.log');
const video = require('../src/video');
const { Manager } = require('../src/manager');
const { createServer } = require('../src/server');

const FAKE = [process.execPath, path.join(__dirname, 'fixtures', 'fake-ytdlp.js')];
const mkManager = (name, extra = {}) => {
  const m = new Manager({ dataDir: path.join(tmp, name, 'data') }).load();
  m.setSettings({ video: { ytdlpPath: FAKE, ffmpegPath: FAKE, concurrentFragments: 4 }, ...extra });
  m.setCategories(m.categories.map(c => ({ ...c, dir: path.join(tmp, name, 'dl', c.id) })));
  return m;
};
const wait = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 30)); } };
const request = m => id => m.snapshot().videoRequests.find(r => r.id === id);
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

// ---------------------------------------------------------------- pure functions
const F = (id, h, o = {}) => ({ format_id: id, ext: 'mp4', height: h, fps: 30, vcodec: 'avc1', acodec: 'none', tbr: h * 3, filesize: h * 1000, ...o });
const AUD = { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', abr: 128, tbr: 128, filesize: 100000 };

test('quality choices: best first, one per resolution, sizes add video and audio, audio-only choices', () => {
  const { choices, moreWithFfmpeg } = video.buildChoices({ formats: [F('137', 1080), F('136', 720), F('18', 360, { acodec: 'mp4a', tbr: 500 }), AUD], duration: 20 }, true);
  assert.deepStrictEqual(choices.map(c => c.id), ['best-video', 'h1080', 'h720', 'h360', 'audio-m4a', 'audio-mp3']);
  assert.strictEqual(choices[0].label, 'Best quality (1080p)');
  const h1080 = choices.find(c => c.id === 'h1080');
  assert.strictEqual(h1080.needsFfmpeg, true);
  assert.strictEqual(h1080.size, 1080 * 1000 + 100000, 'video + audio');
  assert.strictEqual(h1080.selector, 'bv*[height<=1080]+ba/b[height<=1080]');
  const h360 = choices.find(c => c.id === 'h360');
  assert.strictEqual(h360.needsFfmpeg, false);
  assert.strictEqual(h360.selector, 'b[height<=360]');
  assert.strictEqual(moreWithFfmpeg, false);
  assert.strictEqual(choices.find(c => c.id === 'audio-mp3').audio, 'mp3');
});

test('without FFmpeg only choices that already contain sound are offered, and the user is told more are possible', () => {
  const { choices, moreWithFfmpeg } = video.buildChoices({ formats: [F('137', 1080), F('136', 720), F('18', 360, { acodec: 'mp4a' }), AUD], duration: 20 }, false);
  assert.deepStrictEqual(choices.map(c => c.id), ['best-video', 'h360', 'audio-m4a']);
  assert.strictEqual(moreWithFfmpeg, true);
  assert.ok(!choices.some(c => c.needsFfmpeg));
});

test('sites with a single progressive file (TikTok, Instagram ...) and pages without resolutions', () => {
  const one = video.buildChoices({ formats: [{ format_id: 'hd', ext: 'mp4', height: 720, vcodec: 'avc1', acodec: 'mp4a', tbr: 2000, filesize: 700000 }], duration: 10 }, false);
  assert.deepStrictEqual(one.choices.map(c => c.id), ['best-video', 'h720', 'audio-m4a']);
  const none = video.buildChoices({ formats: [{ format_id: 'x', ext: 'mp3', vcodec: 'none', acodec: 'mp3', abr: 128 }], duration: 10 }, false);
  assert.deepStrictEqual(none.choices.map(c => c.id), ['audio-m4a'], 'an audio-only page has no video choice');
  const direct = video.buildChoices({ formats: [{ format_id: 'x', ext: 'mp4', filesize: 5000 }], duration: 0 }, false); // a direct file: nothing is known about its codecs
  assert.deepStrictEqual(direct.choices.map(c => c.id), ['best-video', 'best']);
  assert.deepStrictEqual(video.buildChoices({ formats: [], duration: 0 }, true).choices, []);
});

test('error messages are understandable', () => {
  assert.strictEqual(video.classify('ERROR: Unsupported URL: https://x').code, 'unsupported');
  assert.strictEqual(video.classify("ERROR: [youtube] abc: Sign in to confirm you're not a bot").code, 'login');
  assert.strictEqual(video.classify('ERROR: [instagram] x: Instagram sent an empty media response. use --cookies').code, 'login');
  assert.strictEqual(video.classify('ERROR: Video unavailable. This video has been removed').code, 'unavailable');
  assert.strictEqual(video.classify('ERROR: HTTP Error 429: Too Many Requests').code, 'ratelimit');
  assert.strictEqual(video.classify('ERROR: This video is DRM protected').code, 'drm');
  assert.strictEqual(video.classify('ERROR: [x] weird thing happened').message, 'weird thing happened');
});

test('command line: the address is last after "--", the file name cannot be read as a template, user values are not options', () => {
  const dir = path.join(tmp, 'a b');
  const args = video.downloadArgs({ url: 'https://site.example/v?x=1&y=2', selector: 'bv*+ba/b', dir, base: '100% -f --exec calc', concurrent: 99, cookieFile: '/c.txt', userAgent: 'UA', referer: 'https://r/', ffmpegCmd: [path.join(tmp, 'ffmpeg.exe')], limitRate: 1234.7 });
  assert.strictEqual(args[args.length - 1], 'https://site.example/v?x=1&y=2');
  assert.strictEqual(args[args.length - 2], '--');
  const o = args[args.indexOf('-o') + 1];
  assert.strictEqual(o, path.join(dir, '100%% -f --exec calc.%(ext)s'));
  assert.strictEqual(args[args.indexOf('--concurrent-fragments') + 1], '32', 'capped');
  assert.deepStrictEqual([args[args.indexOf('--cookies') + 1], args[args.indexOf('--user-agent') + 1], args[args.indexOf('--referer') + 1], args[args.indexOf('--limit-rate') + 1]], ['/c.txt', 'UA', 'https://r/', '1234']);
  assert.ok(args.includes('--merge-output-format') && args.includes('mp4'));
  const audio = video.downloadArgs({ url: 'https://s/v', selector: 'ba/b', audio: 'mp3', dir, base: 'x' });
  assert.ok(audio.includes('-x') && audio.includes('mp3') && !audio.includes('--merge-output-format'));
  assert.ok(!args.includes('--exec') && !args.includes('--ffmpeg-location') === false, 'only the app-chosen location is passed');
});

test('progress lines and cookie files', () => {
  assert.deepStrictEqual(video.parseLine('ADM|137|1000|5000|NA|250.5|downloading'), { stream: '137', done: 1000, total: 5000, speed: 250.5, status: 'downloading' });
  assert.strictEqual(video.parseLine('ADM|140|10|NA|2000|None|downloading').total, 2000, 'estimated total when the exact one is unknown');
  assert.deepStrictEqual(video.parseLine('ADMFILE|C:\\x\\y.mp4'), { file: 'C:\\x\\y.mp4' });
  assert.strictEqual(video.parseLine('[download] 50%'), null);
  const f = path.join(tmp, 'c', 'cookies.txt');
  video.writeCookieFile(f, [{ name: 'sid', value: 'a\tb', domain: '.site.example', path: '/', secure: true, httpOnly: true, expirationDate: 2000000000.5 }, { name: 'x', value: '1', domain: 'site.example' }, { name: 'bad' }]);
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  assert.strictEqual(lines[0], '# Netscape HTTP Cookie File');
  assert.strictEqual(lines[1], '#HttpOnly_.site.example\tTRUE\t/\tTRUE\t2000000000\tsid\tab');
  assert.strictEqual(lines[2].split('\t')[1], 'FALSE');
  assert.strictEqual(lines.length, 3, 'cookies without a domain are skipped');
  assert.ok(video.validUrl('https://a.example/x') && !video.validUrl('javascript:alert(1)') && !video.validUrl('file:///c:/x') && !video.validUrl('http://a b/'));
});

test('tools: installed ones are found, nothing is started to look for them', () => {
  const saved = process.env.PATH; process.env.PATH = '';
  try {
    assert.strictEqual(video.resolveTool('yt-dlp'), null);
    fs.mkdirSync(process.env.ADM_TOOLS_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.ADM_TOOLS_DIR, video.exe('yt-dlp')), 'x');
    assert.deepStrictEqual(video.resolveTool('yt-dlp'), [path.join(process.env.ADM_TOOLS_DIR, video.exe('yt-dlp'))]);
    assert.deepStrictEqual(video.resolveTool('yt-dlp', ['node', 'script.js']), ['node', 'script.js'], 'a configured command wins');
    fs.rmSync(path.join(process.env.ADM_TOOLS_DIR, video.exe('yt-dlp')));
  } finally { process.env.PATH = saved; }
});

test('installing: the download is verified against the published checksum, a mismatch installs nothing', async () => {
  const realFetch = global.fetch;
  const BIN = Buffer.from('pretend this is yt-dlp ' + crypto.randomBytes(16).toString('hex'));
  const good = crypto.createHash('sha256').update(BIN).digest('hex');
  let sums = `${good}  ${path.basename(new URL(video.SOURCES.ytdlp.url).pathname)}\n${'0'.repeat(64)}  other-file\n`;
  global.fetch = async url => {
    const body = String(url).includes('SHA2-256SUMS') ? Buffer.from(sums) : BIN;
    return { ok: true, status: 200, headers: { get: () => String(body.length) }, body: (async function* () { yield body; })() };
  };
  try {
    const seen = [];
    const done = await video.install(['ytdlp'], { onProgress: p => seen.push(p) });
    assert.deepStrictEqual(done, ['yt-dlp']);
    assert.ok(fs.readFileSync(path.join(process.env.ADM_TOOLS_DIR, video.SOURCES.ytdlp.file)).equals(BIN));
    assert.ok(seen.length && seen[seen.length - 1].received === BIN.length);
    fs.rmSync(path.join(process.env.ADM_TOOLS_DIR, video.SOURCES.ytdlp.file));
    sums = `${'1'.repeat(64)}  ${path.basename(new URL(video.SOURCES.ytdlp.url).pathname)}\n`;
    await assert.rejects(video.install(['ytdlp']), /does not match its published checksum/);
    assert.ok(!fs.existsSync(path.join(process.env.ADM_TOOLS_DIR, video.SOURCES.ytdlp.file)), 'nothing was installed');
  } finally { global.fetch = realFetch; }
});

// ---------------------------------------------------------------- the whole flow, with a fake yt-dlp
test('a video page becomes a request with title, uploader, duration and qualities; the browser cookies reach yt-dlp as a cookie file', async () => {
  const m = mkManager('flow');
  const cookies = [{ name: 'sid', value: 'secret', domain: '.site.example', path: '/', secure: true }];
  const { id } = m.videoOpen({ url: 'https://site.example/watch?v=1', title: 'tab title', referer: 'https://site.example/', userAgent: 'TestUA', cookies, media: [{ url: 'https://cdn.example/clip.mp4', type: 'video/mp4', size: 123 }, { url: 'javascript:1' }], source: 'browser' });
  assert.strictEqual(m.snapshot().videoRequests.length, 1);
  const r = await wait(() => { const x = request(m)(id); return x && x.status === 'ready' && x; });
  assert.strictEqual(r.info.title, 'My: Test/Video *1*');
  assert.strictEqual(r.info.extractor, 'FakeSite');
  assert.strictEqual(r.info.uploader, 'Some Channel');
  assert.strictEqual(r.info.duration, 20);
  assert.strictEqual(r.info.choices[0].id, 'best-video');
  assert.strictEqual(r.info.defaultChoice, 'best-video');
  assert.strictEqual(r.hasFfmpeg, true);
  assert.deepStrictEqual(r.media.map(x => x.url), ['https://cdn.example/clip.mp4'], 'only real web addresses are kept');
  assert.strictEqual(r.dirs.video, path.join(tmp, 'flow', 'dl', 'video'));
  assert.ok(!JSON.stringify(r).includes('secret'), 'cookies are never shown to the UI');
  const log = fs.readFileSync(process.env.ADM_FAKE_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const infoCall = log.reverse().find(a => a.includes('-J') && a.includes('https://site.example/watch?v=1'));
  assert.ok(infoCall, 'yt-dlp was asked for the page');
  const cf = infoCall[infoCall.indexOf('--cookies') + 1];
  assert.match(fs.readFileSync(cf, 'utf8'), /\.site\.example\tTRUE\t\/\tTRUE\t\d+\tsid\tsecret/);
  assert.strictEqual(infoCall[infoCall.indexOf('--user-agent') + 1], 'TestUA');
  assert.strictEqual(m.videoOpen({ url: 'https://site.example/watch?v=1' }).existing, true, 'the same page is not asked twice');
  assert.throws(() => m.videoOpen({ url: 'file:///etc/passwd' }), /no web address/);
  await m.shutdown();
});

test('Download: the chosen quality is downloaded and merged into the list entry, with progress, and the cookie file is removed at the end', async () => {
  process.env.ADM_FAKE_STEP_MS = '60'; // slow enough that progress is visible even when the machine is busy running other tests
  const m = mkManager('dl');
  const { id } = m.videoOpen({ url: 'https://site.example/watch?v=2', cookies: [{ name: 'a', value: 'b', domain: 'site.example' }] });
  await wait(() => request(m)(id)?.status === 'ready');
  const cookieFile = path.join(tmp, 'dl', 'data', 'cookies', id + '.txt');
  assert.ok(fs.existsSync(cookieFile));
  const res = m.videoAccept(id, { choiceId: 'h1080', description: 'my note' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(m.snapshot().videoRequests.length, 0, 'the request is closed');
  const dlId = res.download.id;
  assert.strictEqual(res.download.kind, 'video');
  assert.strictEqual(res.download.fileName, 'My Test Video 1.mp4', 'characters Windows does not allow are removed');
  assert.strictEqual(res.download.saveDir, path.join(tmp, 'dl', 'dl', 'video'));
  const seen = new Set();
  const v = await wait(() => { const x = m.view(m.get(dlId)); if (x.done) seen.add(x.done); return (x.status === 'complete' || x.status === 'error') && x; });
  assert.strictEqual(v.status, 'complete', v.error);
  assert.ok(seen.size >= 2, 'progress was reported while downloading');
  assert.strictEqual(v.size, 700000);
  assert.strictEqual(v.fileName, 'My Test Video 1.mp4');
  assert.strictEqual(v.description, 'my note');
  assert.strictEqual(fs.statSync(path.join(v.saveDir, v.fileName)).size, 700000);
  assert.ok(!fs.existsSync(cookieFile), 'the cookies are deleted when the download is finished');
  const args = fs.readFileSync(process.env.ADM_FAKE_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l)).reverse().find(a => a.includes('-f') && a.includes('--print'));
  assert.strictEqual(args[args.indexOf('-f') + 1], 'bv*[height<=1080]+ba/b[height<=1080]');
  assert.strictEqual(args[args.indexOf('--concurrent-fragments') + 1], '4');
  // the same video again gets its own free name
  const { id: id2 } = m.videoOpen({ url: 'https://site.example/watch?v=2' });
  await wait(() => request(m)(id2)?.status === 'ready');
  assert.strictEqual(m.videoAccept(id2, { choiceId: 'h720', action: 'later' }).download.fileName, 'My Test Video 1 (2).mp4');
  delete process.env.ADM_FAKE_STEP_MS;
  await m.shutdown();
});

test('Download Later queues it without starting; audio-only gives an .mp3; a typed name and folder are used', async () => {
  const m = mkManager('later');
  const { id } = m.videoOpen({ url: 'https://site.example/watch?v=3' });
  await wait(() => request(m)(id)?.status === 'ready');
  const later = m.videoAccept(id, { choiceId: 'h360', action: 'later', fileName: 'My name.mp4', saveDir: path.join(tmp, 'elsewhere') });
  const v = m.view(m.get(later.download.id));
  assert.deepStrictEqual([v.queue, v.status, v.fileName, v.saveDir], ['main', 'queued', 'My name.mp4', path.join(tmp, 'elsewhere')]);
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(m.view(m.get(later.download.id)).status, 'queued');
  const { id: id2 } = m.videoOpen({ url: 'https://site.example/watch?v=4' });
  await wait(() => request(m)(id2)?.status === 'ready');
  const audio = m.videoAccept(id2, { choiceId: 'audio-mp3' });
  assert.strictEqual(audio.download.fileName.endsWith('.mp3'), true);
  assert.strictEqual(audio.download.saveDir, path.join(tmp, 'later', 'dl', 'music'));
  const done = await wait(() => { const x = m.view(m.get(audio.download.id)); return (x.status === 'complete' || x.status === 'error') && x; });
  assert.strictEqual(done.status, 'complete', done.error);
  assert.ok(fs.existsSync(path.join(done.saveDir, done.fileName)));
  await m.shutdown();
});

test('pause and resume: stopping keeps the partial file, starting again continues and finishes', async () => {
  process.env.ADM_FAKE_STEP_MS = '120';
  const m = mkManager('resume');
  try {
    const { id } = m.videoOpen({ url: 'https://site.example/watch?v=5' });
    await wait(() => request(m)(id)?.status === 'ready');
    const res = m.videoAccept(id, { choiceId: 'h1080' });
    const dlId = res.download.id;
    await wait(() => m.view(m.get(dlId)).done > 100000);
    await m.stop(dlId);
    const paused = m.view(m.get(dlId));
    assert.strictEqual(paused.status, 'paused');
    assert.ok(paused.done > 0 && paused.done < 700000, 'partial: ' + paused.done);
    const part = path.join(paused.saveDir, paused.fileName + '.part');
    assert.ok(fs.existsSync(part), 'the .part file is kept');
    m.start(dlId);
    const v = await wait(() => { const x = m.view(m.get(dlId)); return (x.status === 'complete' || x.status === 'error') && x; }, 30000);
    assert.strictEqual(v.status, 'complete', v.error);
    assert.strictEqual(fs.statSync(path.join(v.saveDir, v.fileName)).size, 700000);
    assert.ok(!fs.existsSync(part));
  } finally { delete process.env.ADM_FAKE_STEP_MS; await m.shutdown(); }
});

test('names with emoji and curly quotes: the file is found even though yt-dlp prints a mangled path (a real Windows problem)', async () => {
  process.env.ADM_FAKE_MANGLE = '1';
  const m = mkManager('emoji');
  try {
    const { id } = m.videoOpen({ url: 'https://site.example/watch?v=emoji' });
    await wait(() => request(m)(id)?.status === 'ready');
    const res = m.videoAccept(id, { choiceId: 'h360', fileName: 'Scramble up ur name & I’ll try it😍❤️ #fyp' });
    const v = await wait(() => { const x = m.view(m.get(res.download.id)); return (x.status === 'complete' || x.status === 'error') && x; });
    assert.strictEqual(v.status, 'complete', v.error);
    assert.strictEqual(v.fileName, 'Scramble up ur name & I’ll try it😍❤️ #fyp.mp4');
    assert.ok(fs.existsSync(path.join(v.saveDir, v.fileName)));
  } finally { delete process.env.ADM_FAKE_MANGLE; await m.shutdown(); }
});

test('removing a video download deletes its temporary files and cookies', async () => {
  process.env.ADM_FAKE_STEP_MS = '150';
  const m = mkManager('remove');
  try {
    const { id } = m.videoOpen({ url: 'https://site.example/watch?v=6', cookies: [{ name: 'a', value: 'b', domain: 'site.example' }] });
    await wait(() => request(m)(id)?.status === 'ready');
    const res = m.videoAccept(id, { choiceId: 'h1080' });
    const dlId = res.download.id;
    await wait(() => m.view(m.get(dlId)).done > 50000);
    const v = m.view(m.get(dlId));
    await m.remove(dlId);
    assert.ok(!fs.existsSync(path.join(v.saveDir, v.fileName + '.part')));
    assert.ok(!fs.existsSync(path.join(tmp, 'remove', 'data', 'cookies', id + '.txt')));
    assert.strictEqual(m.downloads.size, 0);
  } finally { delete process.env.ADM_FAKE_STEP_MS; await m.shutdown(); }
});

test('problems are explained: unsupported page, sign-in needed, live stream, failed download', async () => {
  const m = mkManager('errors');
  const open = async (url, o = {}) => { const { id } = m.videoOpen({ url, ...o }); return wait(() => { const x = request(m)(id); return x && x.status !== 'probing' && x; }); };
  const a = await open('https://site.example/unsupported');
  assert.deepStrictEqual([a.status, a.error.code], ['error', 'unsupported']);
  const b = await open('https://site.example/login/1');
  assert.deepStrictEqual([b.status, b.error.code, b.error.hadCookies], ['error', 'login', false]);
  const c = await open('https://site.example/login/2', { cookies: [{ name: 'a', value: 'b', domain: 'site.example' }] });
  assert.strictEqual(c.error.hadCookies, true);
  const d = await open('https://site.example/live/1');
  assert.strictEqual(d.error.code, 'live');
  assert.throws(() => m.videoAccept(a.id, {}), /expired/);
  await m.shutdown();
});

test('playlist pages give the first video; a failing download is reported with its reason and not retried forever', async () => {
  const m = mkManager('fail');
  const { id } = m.videoOpen({ url: 'https://site.example/playlist/1' });
  const r = await wait(() => request(m)(id)?.status === 'ready' && request(m)(id));
  assert.strictEqual(r.info.title, 'My: Test/Video *1*');
  // a download whose yt-dlp run fails: use a page that reads fine but is configured to fail on download
  const m2 = mkManager('fail2');
  const rec = m2.add({ url: 'https://site.example/fail/download', kind: 'video', fileName: 'x.mp4', saveDir: path.join(tmp, 'fail2', 'dl'), startNow: true, queue: null,
    video: { pageUrl: 'https://site.example/fail/download', selector: 'b', base: 'x', needsFfmpeg: false } });
  const v = await wait(() => { const x = m2.view(m2.get(rec.id)); return (x.status === 'complete' || x.status === 'error') && x; });
  assert.strictEqual(v.status, 'error');
  assert.match(v.error, /no longer available|Not Found|404/i);
  await m.shutdown(); await m2.shutdown();
});

test('without the video engine the request says so, and installing it re-reads the waiting requests', async () => {
  const saved = process.env.PATH; process.env.PATH = '';
  const m = new Manager({ dataDir: path.join(tmp, 'notools', 'data') }).load();
  try {
    const { id } = m.videoOpen({ url: 'https://site.example/watch?v=7' });
    await wait(() => request(m)(id)?.status === 'needs-tools');
    assert.strictEqual(m.videoToolsInfo().ytdlp.installed, false);
    const rec = m.add({ url: 'https://site.example/watch?v=7', kind: 'video', fileName: 'x.mp4', saveDir: path.join(tmp, 'notools', 'dl'), startNow: true, queue: null, video: { pageUrl: 'https://site.example/watch?v=7', selector: 'b', base: 'x' } });
    const v = await wait(() => { const x = m.view(m.get(rec.id)); return x.status === 'error' && x; });
    assert.match(v.error, /not installed/);
    assert.throws(() => m.installVideoTools([]), /Nothing to install/);
    // now "install" by pointing the app at a tool
    m.setSettings({ video: { ytdlpPath: FAKE, ffmpegPath: FAKE } });
    m._reprobeVideoRequests();
    await wait(() => request(m)(id)?.status === 'ready');
  } finally { process.env.PATH = saved; await m.shutdown(); }
});

test('API: tools, open, accept, reject need the token', async () => {
  const m = mkManager('api');
  const srv = createServer(m, { port: 0 });
  const port = await srv.listen();
  const call = (method, p, body, token = srv.token) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'X-Token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(c).toString() || '{}') }));
    });
    req.on('error', reject); req.end(data);
  });
  try {
    assert.strictEqual((await call('POST', '/api/video/open', { url: 'https://s.example/v' }, 'wrong')).status, 401);
    const tools = await call('GET', '/api/video/tools');
    assert.strictEqual(tools.status, 200);
    assert.strictEqual(tools.body.ytdlp.installed, true);
    const open = await call('POST', '/api/video/open', { url: 'https://s.example/v/1', title: 'T' });
    assert.ok(open.body.id);
    await wait(() => request(m)(open.body.id)?.status === 'ready');
    const st = await call('GET', '/api/state');
    assert.ok(st.body.videoRequests.some(r => r.id === open.body.id && r.info.choices.length >= 4));
    assert.strictEqual((await call('POST', `/api/video/${open.body.id}/reject`, {})).body.ok, true);
    assert.strictEqual((await call('POST', '/api/video/missing/accept', {})).status, 404);
    assert.strictEqual((await call('POST', '/api/video/open', { url: 'ftp://x/y' })).status, 400);
    const open2 = await call('POST', '/api/video/open', { url: 'https://s.example/v/2' });
    await wait(() => request(m)(open2.body.id)?.status === 'ready');
    const acc = await call('POST', `/api/video/${open2.body.id}/accept`, { choiceId: 'h360', action: 'later' });
    assert.strictEqual(acc.body.ok, true);
    assert.strictEqual(acc.body.download.kind, 'video');
  } finally { srv.server.close(); await m.shutdown(); }
});

test('YouTube: no borrowed User-Agent, slow retries, optional browser login; other sites keep the headers', () => {
  const yt = video.downloadArgs({ url: 'https://www.youtube.com/watch?v=abc', selector: 'b', dir: 'x', base: 'n', userAgent: 'UA', referer: 'R', cookiesBrowser: 'firefox' });
  assert.ok(!yt.includes('--user-agent') && !yt.includes('--referer') && yt.includes('--sleep-requests') && yt.includes('--retry-sleep'));
  assert.equal(yt[yt.indexOf('--cookies-from-browser') + 1], 'firefox');
  assert.equal(yt[yt.indexOf('--concurrent-fragments') + 1], '4');
  const other = video.downloadArgs({ url: 'https://example.com/v', selector: 'b', dir: 'x', base: 'n', userAgent: 'UA', referer: 'R', cookiesBrowser: 'bad;rm' });
  assert.ok(other.includes('--user-agent') && other.includes('--referer') && !other.includes('--cookies-from-browser'));
  assert.equal(video.classify('ERROR: [youtube] x: HTTP Error 429: Too Many Requests').code, 'ratelimit');
  assert.equal(video.classify('ERROR: Failed to decrypt with DPAPI').code, 'cookies');
});

test('tools shipped inside the app are found without any install; an installed / updated copy wins; PATH comes last', () => {
  const keepT = process.env.ADM_TOOLS_DIR, keepB = process.env.ADM_BUNDLED_TOOLS;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-bundled-'));
  const own = path.join(base, 'own'), shipped = path.join(base, 'shipped');
  fs.mkdirSync(own); fs.mkdirSync(shipped);
  try {
    process.env.ADM_TOOLS_DIR = own; process.env.ADM_BUNDLED_TOOLS = shipped;
    assert.equal(video.resolveTool('yt-dlp-test-none'), null);
    fs.writeFileSync(path.join(shipped, video.exe('yt-dlp')), 'x');
    assert.deepEqual(video.resolveTool('yt-dlp'), [path.join(shipped, video.exe('yt-dlp'))]);
    fs.writeFileSync(path.join(own, video.exe('yt-dlp')), 'x');
    assert.deepEqual(video.resolveTool('yt-dlp'), [path.join(own, video.exe('yt-dlp'))]);
    assert.deepEqual(video.resolveTool('yt-dlp', 'C:\custom\yt-dlp.exe'), ['C:\custom\yt-dlp.exe']);
  } finally {
    if (keepT === undefined) delete process.env.ADM_TOOLS_DIR; else process.env.ADM_TOOLS_DIR = keepT;
    if (keepB === undefined) delete process.env.ADM_BUNDLED_TOOLS; else process.env.ADM_BUNDLED_TOOLS = keepB;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('when a site rejects the first way of asking, other ways follow (login rotated, bot check, TikTok fingerprint)', () => {
  const yt = video.plan('https://www.youtube.com/watch?v=abc', true).map(v => v.id + (v.cookies ? '+login' : ''));
  assert.deepEqual(yt, ['default+login', 'safari+login', 'default', 'safari', 'vr']);
  assert.deepEqual(video.plan('https://www.youtube.com/watch?v=abc', false).map(v => v.id), ['default', 'safari', 'vr']);
  assert.deepEqual(video.plan('https://www.tiktok.com/@a/video/1', true).map(v => v.id + (v.cookies ? '+login' : '')), ['default+login', 'impersonate+login', 'default', 'impersonate']);
  const a = video.downloadArgs({ url: 'https://www.tiktok.com/@a/video/1', selector: 'b', dir: 'x', base: 'n', variant: 'impersonate', userAgent: 'UA', cookieFile: 'c.txt', withCookies: false });
  assert.equal(a[a.indexOf('--impersonate') + 1], 'chrome');
  assert.ok(!a.includes('--cookies') && !a.includes('--user-agent'));
  assert.equal(video.classify('ERROR: [youtube] x: The page needs to be reloaded.').code, 'login');
});
