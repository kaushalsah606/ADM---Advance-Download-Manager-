'use strict';
// Real-Firefox test of dist/firefox via WebDriver BiDi.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FF = 'C:/Program Files/Mozilla Firefox/firefox.exe';
const SRC_EXT = path.resolve(ROOT, 'dist/firefox');
const UUID = '11111111-2222-4333-8444-555555555555';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-ff-'));
process.env.ADM_DOWNLOAD_ROOT = path.join(tmp, 'downloads'); // tests must never write into the user's real Downloads folder
process.env.ADM_FAKE_LOG = path.join(tmp, 'fake.log'); // the fake yt-dlp writes the command lines it receives here
const FAKE = [process.execPath, path.join(ROOT, 'test', 'fixtures', 'fake-ytdlp.js')];
// private copy of the extension that only talks to the test port: a real running copy of the app (port 6800) must never see a test pairing request
function prepareExtension(src, dst, port) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  const f = path.join(dst, 'background.js');
  let s = fs.readFileSync(f, 'utf8');
  s = s.replace(/enabled: true, port: 6800,/, 'enabled: true, port: ' + port + ',').replace(/const PORTS = \[[^\]]*\];/, 'const PORTS = [' + port + '];');
  if (!s.includes('const PORTS = [' + port + ']')) throw new Error('could not patch the extension ports');
  fs.writeFileSync(f, s);
  return dst;
}
const EXT = prepareExtension(SRC_EXT, path.join(tmp, 'ext'), 6811);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

const ZIP = Buffer.alloc(2 * 1024 * 1024, 7), MP4 = Buffer.alloc(1024 * 1024, 3);
const origin = http.createServer((req, res) => {
  if (req.url === '/file.zip') { res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="ff-test.zip"', 'Content-Length': ZIP.length, 'Accept-Ranges': 'bytes' }); return res.end(ZIP); }
  if (req.url === '/video.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MP4.length }); return res.end(MP4); }
  if (req.url === '/video') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end("<html><body style=\"margin:0\"><article style=\"padding:20px\"><a href=\"https://www.instagram.com/reel/ABC123/\">post</a><br><video id=\"v\" width=\"640\" height=\"360\" src=\"/video.mp4\" muted></video></article></body></html>"); }
  if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html><body><a href="/doc1.pdf">one</a> <a href="/doc2.pdf">two</a> <a href="/file.zip" id="z">zip</a></body></html>'); }
  res.statusCode = 404; res.end();
});

function bidi(url) {
  const ws = new WebSocket(url); let id = 0; const pend = new Map();
  const ready = new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return ready.then(() => ({
    send: (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); r({ error: 'timeout', method }); } }, 20000); }),
    close: () => ws.close(),
  }));
}

(async () => {
  await new Promise(r => origin.listen(6831, '127.0.0.1', r));
  const adm = spawn(process.execPath, [path.join(ROOT, 'bin/advance-download-manager.js'), '--no-open', '--no-tray', '--port', '6811', '--data', path.join(tmp, 'adm')], { stdio: 'ignore' });
  await sleep(1500);
  const session = JSON.parse(fs.readFileSync(path.join(tmp, 'adm', 'session.json'), 'utf8'));
  const api = (m, p, b) => fetch('http://127.0.0.1:6811' + p, { method: m, headers: { 'X-Token': session.token, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());
  const state = () => api('GET', '/api/state');

  const prof = path.join(tmp, 'profile'); fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, 'user.js'), [
    `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ 'advance-download-manager@localhost': UUID }))});`,
    'user_pref("xpinstall.signatures.required", false);', 'user_pref("extensions.autoDisableScopes", 0);',
    'user_pref("browser.download.folderList", 2);', `user_pref("browser.download.dir", ${JSON.stringify(path.join(tmp, 'ff-dl'))});`,
    'user_pref("browser.shell.checkDefaultBrowser", false);', 'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  ].join('\n'));
  const ff = spawn(FF, ['-headless', '-no-remote', '-profile', prof, '--remote-debugging-port', '9444'], { stdio: 'ignore' });
  let b;
  try {
    for (let i = 0; i < 40 && !b; i++) { await sleep(500); try { b = await bidi('ws://127.0.0.1:9444/session'); } catch { /* starting */ } }
    if (!b) throw new Error('Firefox BiDi did not start');
    const s = await b.send('session.new', { capabilities: {} });
    if (s.error) throw new Error('session.new: ' + JSON.stringify(s));
    const inst = await b.send('webExtension.install', { extensionData: { type: 'path', path: EXT } });
    check('Firefox installed the extension', !!(inst.result && inst.result.extension), JSON.stringify(inst.result || inst).slice(0, 120));
    if (!inst.result) throw new Error('install failed');

    const tree = await b.send('browsingContext.getTree', {});
    const ctx0 = tree.result.contexts[0].context;
    const ev = async (ctx, expression) => {
      const r = await b.send('script.evaluate', { expression, target: { context: ctx }, awaitPromise: true, resultOwnership: 'none' });
      if (r.result && r.result.type === 'success') return r.result.result.value;
      throw new Error('eval: ' + JSON.stringify(r).slice(0, 300));
    };
    const nav = async (ctx, url) => b.send('browsingContext.navigate', { context: ctx, url, wait: 'complete' });

    // configure through the extension's own options page (a real extension context)
    await nav(ctx0, `moz-extension://${UUID}/options.html`);
    check('extension options page loads', /Advance Download Manager/.test(await ev(ctx0, 'document.title')));
    // NO token is pasted: the extension asks the app to pair by itself
    let pending = [];
    for (let i = 0; i < 20 && !pending.length; i++) { await sleep(500); pending = (await api('GET', '/api/pair')).pending; }
    check('the extension asked to pair on its own (appears as a request in the app)', pending.length === 1 && /^moz-extension:\/\//.test(pending[0].origin), JSON.stringify(pending.map(p => p.browser)));
    await api('POST', '/api/pair/decision', { origin: pending[0].origin, allow: true });
    const st = await ev(ctx0, `new Promise(r => browser.runtime.sendMessage({ type: 'pair' }, r))`);
    const stored = await ev(ctx0, `browser.storage.local.get(['token','port']).then(x => x.token + '|' + x.port)`);
    check('after Allow the extension is connected and has the token (nothing pasted)', st === 'connected' && stored === session.token + '|' + session.port, st);

    // (2) media sniffer + (3) collect, from a normal tab
    const tab = await b.send('browsingContext.create', { type: 'tab' });
    const ctx = tab.result.context;
    await nav(ctx, 'http://127.0.0.1:6831/page');
    await ev(ctx, `fetch('/video.mp4').then(r => r.arrayBuffer()).then(x => x.byteLength)`);
    await sleep(1000);
    const pop = await b.send('browsingContext.create', { type: 'tab' });
    const pctx = pop.result.context;
    await nav(pctx, `moz-extension://${UUID}/popup.html`);
    const pageTabId = await ev(pctx, `browser.tabs.query({}).then(ts => (ts.find(t => t.url.endsWith('/page')) || {}).id)`);
    const media = JSON.parse(await ev(pctx, `new Promise(r => browser.runtime.sendMessage({ type: 'media', tabId: ${pageTabId} }, m => r(JSON.stringify(m))))`));
    check('media sniffer detected the video', Array.isArray(media) && media.some(m => m.url.endsWith('/video.mp4')), JSON.stringify(media).slice(0, 100));

    await ev(pctx, `browser.tabs.query({}).then(ts => { const t = ts.find(x => x.url.endsWith('/page')); return browser.runtime.sendMessage({ type: 'collect', tab: { id: t.id, url: t.url, title: t.title } }); }).then(() => 'sent')`);
    await sleep(2000);
    const tr = await b.send('browsingContext.getTree', {});
    const urls = tr.result.contexts.map(c => c.url);
    check('"download all links" opened the selection page', urls.some(u => u.startsWith('http://127.0.0.1:6811/')), urls.join(' '));

    // (1) takeover: navigate the tab to the attachment URL (a real Firefox download)
    await b.send('browsingContext.navigate', { context: ctx, url: 'http://127.0.0.1:6831/file.zip', wait: 'none' });
    let got;
    await sleep(3000);
    if (!(await state()).downloads.length && !(await state()).proposals.length) { console.log('  (navigation produced no downloads event in headless Firefox; using browser.downloads.download)'); await ev(pctx, `browser.downloads.download({ url: 'http://127.0.0.1:6831/file.zip' }).then(() => 'started')`); }
    let prop;
    for (let i = 0; i < 24 && !(prop && prop.status === 'ready'); i++) { await sleep(500); prop = (await state()).proposals.find(p => /file\.zip/.test(p.url)); }
    check('the app holds the Firefox download and asks first ("Download File Info": name, size, type, nothing started)', !!prop && prop.fileName === 'ff-test.zip' && prop.size === ZIP.length && prop.contentType === 'application/zip' && (await state()).downloads.length === 0, prop && JSON.stringify([prop.fileName, prop.size, prop.contentType]));
    if (prop) await api('POST', '/api/proposals/' + prop.id + '/accept', { action: 'start' });
    for (let i = 0; i < 30 && !got; i++) { await sleep(500); got = (await state()).downloads.find(d => /file\.zip/.test(d.url)); }
    check('Firefox download was taken over by Advance Download Manager', !!got);
    if (got) {
      for (let i = 0; i < 30 && got.status !== 'complete'; i++) { await sleep(500); got = (await state()).downloads.find(d => d.id === got.id); }
      check('taken-over download completed with the right size', got.status === 'complete' && got.size === ZIP.length, `${got.status} ${got.size}`);
    }

    // ---- "Download this video": the button over a video (content script), permalink, cookies, popup button, on/off switch ----
    await api('PUT', '/api/settings', { video: { ytdlpPath: FAKE, ffmpegPath: FAKE } });
    await nav(ctx, "http://127.0.0.1:6831/video");
    await sleep(2500);
    await ev(ctx, "document.cookie = 'sid=abc123; path=/'");
    await ev(ctx, "document.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 150, bubbles: true })); 'ok'");
    await sleep(900);
    const btnState = await ev(ctx, "(() => { const h = document.querySelector('adm-video-button'); if (!h) return 'no-host'; const b = h.shadowRoot.querySelector('.b'); return h.style.display + '|' + b.textContent.trim().slice(0, 30); })()");
    check('the "Download this video" button appears over the video', /^block\|.*Download this video/.test(btnState), String(btnState));
    await ev(ctx, "document.querySelector('adm-video-button').shadowRoot.querySelector('.b').click()");
    let vr;
    for (let i = 0; i < 30 && !(vr && vr.status === 'ready'); i++) { await sleep(500); vr = (await state()).videoRequests[0]; }
    check('clicking it sends the page to the app, which reads the video and lists the qualities', !!vr && vr.status === 'ready' && vr.info.choices.length >= 4 && vr.info.title === 'My: Test/Video *1*', vr && vr.status);
    check('the video\'s own post link is used, not the feed page (permalink detection)', !!vr && vr.urls[0] === 'https://www.instagram.com/reel/ABC123/', vr && JSON.stringify(vr.urls));
    check('the media file seen on the page is offered as a fallback', !!vr && vr.media.some(m => /video\.mp4/.test(m.url)), vr && JSON.stringify(vr.media.map(m => m.url)));
    const callLog = fs.readFileSync(process.env.ADM_FAKE_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l)).reverse().find(a => a.includes('-J') && a.some(x => /instagram\.com\/reel\/ABC123/.test(x)));
    const cfile = callLog && callLog[callLog.indexOf('--cookies') + 1];
    check('the browser\'s cookies were passed to yt-dlp as a cookie file, and are not shown in the state', !!cfile && /sid\tabc123/.test(fs.readFileSync(cfile, 'utf8')) && !JSON.stringify(vr).includes('abc123'));
    if (vr) await api('POST', '/api/video/' + vr.id + '/reject', {});
    // the extension popup's "Download video from this page"
    await ev(pctx, `browser.tabs.query({}).then(ts => { const t = ts.find(x => x.url.endsWith('/video')); return browser.runtime.sendMessage({ type: 'videoPage', tab: { id: t.id, url: t.url, title: t.title } }); }).then(() => 'sent')`);
    let vr2;
    for (let i = 0; i < 20 && !(vr2 && vr2.status === 'ready'); i++) { await sleep(500); vr2 = (await state()).videoRequests[0]; }
    check('the popup button "Download video from this page" sends the current page too', !!vr2 && vr2.urls[0].endsWith('/video'), vr2 && JSON.stringify(vr2.urls));
    if (vr2) await api('POST', '/api/video/' + vr2.id + '/reject', {});
    // switch the button off in the extension settings
    await ev(pctx, `browser.storage.local.set({ videoButton: false }).then(() => 'ok')`);
    await sleep(400);
    await ev(ctx, "document.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 150, bubbles: true })); 'ok'");
    await sleep(900);
    const off = await ev(ctx, "document.querySelector('adm-video-button') ? document.querySelector('adm-video-button').style.display : 'none'");
    check('with the "Show the Download this video button" option off, no button is shown', off === 'none', String(off));
    await ev(pctx, `browser.storage.local.set({ videoButton: true }).then(() => 'ok')`);
    const left = await ev(pctx, `browser.downloads.search({}).then(l => l.length)`);
    check('Firefox removed its own copy of the download', left === 0, 'browser downloads: ' + left);
  } catch (e) {
    check('test run', false, e.message);
  } finally {
    ff.kill(); adm.kill(); origin.close();
    require('child_process').spawnSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*' + [IO.Path]::GetFileName('" + tmp.replace(/\\/g, '/') + "') + '*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { stdio: 'ignore' });
    await sleep(800);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
  }
})();
