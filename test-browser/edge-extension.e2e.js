'use strict';
// Real-browser test of the Chrome/Edge extension: loads dist/chrome in a fresh profile, points it at a live
// Advance Download Manager server and checks (1) download takeover, (2) media sniffing, (3) "download all links".
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BROWSER = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-bt-'));
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
const EXT = prepareExtension(path.resolve(ROOT, 'dist/chrome'), path.join(tmp, 'ext'), 6810);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

const ZIP = Buffer.alloc(2 * 1024 * 1024, 7), MP4 = Buffer.alloc(1024 * 1024, 3);
const origin = http.createServer((req, res) => {
  if (req.url === '/file.zip') { res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="browser-test.zip"', 'Content-Length': ZIP.length, 'Accept-Ranges': 'bytes' }); return res.end(ZIP); }
  if (req.url === '/video.mp4') { console.log('  [origin] video request, range=' + req.headers.range + ' sec-fetch-dest=' + req.headers['sec-fetch-dest']); res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MP4.length }); return res.end(MP4); }
  if (req.url === '/doc1.pdf' || req.url === '/doc2.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline' }); return res.end('%PDF-1.4'); }
  if (req.url === '/video') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end("<html><body style=\"margin:0\"><article style=\"padding:20px\"><a href=\"https://www.instagram.com/reel/ABC123/\">post</a><br><video id=\"v\" width=\"640\" height=\"360\" src=\"/video.mp4\" muted></video></article></body></html>"); }
  if (req.url === '/page') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<html><body><a href="/doc1.pdf">one</a> <a href="/doc2.pdf">two</a> <a href="/file.zip" id="z">zip</a><video src="/video.mp4" autoplay muted></video></body></html>');
  }
  res.statusCode = 404; res.end();
});

async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pend = new Map();
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') console.log('  [sw exception]', JSON.stringify(m.params.exceptionDetails).slice(0, 400)); if (m.method === 'Runtime.consoleAPICalled') console.log('  [sw console]', JSON.stringify(m.params.args.map(a => a.value || a.description)).slice(0, 300)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return { send: (method, params = {}, sessionId) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); }), close: () => ws.close() };
}
const j = async url => (await fetch(url)).json();

(async () => {
  await new Promise(r => origin.listen(6821, '127.0.0.1', r));
  const adm = spawn(process.execPath, [path.join(ROOT, 'bin/advance-download-manager.js'), '--no-open', '--no-tray', '--port', '6810', '--data', path.join(tmp, 'adm')], { stdio: 'ignore' });
  await sleep(1500);
  const session = JSON.parse(fs.readFileSync(path.join(tmp, 'adm', 'session.json'), 'utf8'));
  const api = (m, p, b) => fetch('http://127.0.0.1:6810' + p, { method: m, headers: { 'X-Token': session.token, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());
  const state = () => api('GET', '/api/state');

  const br = spawn(BROWSER, ['--headless=new', '--remote-debugging-port=9333', '--user-data-dir=' + path.join(tmp, 'profile'), '--load-extension=' + EXT,
    '--disable-features=DisableLoadExtensionCommandLineSwitch', '--no-first-run', '--no-default-browser-check', '--enable-unsafe-extension-debugging', 'about:blank'], { stdio: 'ignore' });
  let sw;
  try {
    for (let i = 0; i < 40 && !sw; i++) { await sleep(500); try { sw = (await j('http://127.0.0.1:9333/json/list')).find(t => t.type === 'service_worker' && t.url.includes('background.js')); } catch { /* starting */ } }
    check('extension service worker is running in the browser', !!sw, sw && sw.url);
    if (!sw) throw new Error('extension did not load');

    const ext = await cdpConnect(sw.webSocketDebuggerUrl);
    await ext.send('Runtime.enable');
    const ev = async expr => (await ext.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
    // NO token is pasted: the extension must find the app and ask to pair by itself (it does so when it is installed)
    let pending = [];
    for (let i = 0; i < 20 && !pending.length; i++) { await sleep(500); pending = (await api('GET', '/api/pair')).pending; }
    check('the extension asked to pair on its own (appears as a request in the app)', pending.length === 1 && /^chrome-extension:\/\//.test(pending[0].origin), JSON.stringify(pending.map(p => p.browser)));
    check('while waiting, the extension has no token yet', !(await ev(`chrome.storage.local.get('token').then(x => x.token)`)));

    const ver = await j('http://127.0.0.1:9333/json/version');
    const browser = await cdpConnect(ver.webSocketDebuggerUrl);
    const { result: { targetId } } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { result: { sessionId } } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const page = (m, p) => browser.send(m, p, sessionId);

    const extId = new URL(sw.url).host;
    const { result: { targetId: popupId } } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    const { result: { sessionId: popupSess } } = await browser.send('Target.attachToTarget', { targetId: popupId, flatten: true });
    // the user presses Allow in the app
    await api('POST', '/api/pair/decision', { origin: pending[0].origin, allow: true });
    const pev = async expr => (await browser.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, popupSess)).result.result.value;
    const st = await pev(`new Promise(r => chrome.runtime.sendMessage({ type: 'pair' }, r))`);
    const stored = await ev(`chrome.storage.local.get(['token','port']).then(x => x.token + '|' + x.port)`);
    check('after Allow the extension is connected and has the token (nothing pasted)', st === 'connected' && stored === session.token + '|' + session.port, st);
    // (2) media sniffing: open the page that plays a video
    await page('Page.enable'); await page('Page.navigate', { url: 'http://127.0.0.1:6821/page' }); await sleep(2500);
    await page('Runtime.evaluate', { expression: "fetch('/video.mp4').then(r => r.arrayBuffer()).then(b => b.byteLength)", awaitPromise: true }); // headless tabs may not autoplay: request the media explicitly

    const tabs = await ev(`chrome.tabs.query({}).then(t => t.map(x => ({ id: x.id, url: x.url })))`);
    const pageTabs = tabs.filter(t => t.url.endsWith('/page'));
    console.log('  page tabs:', pageTabs.length);
    let media = [];
    for (let i = 0; i < 12; i++) { for (const tb of pageTabs) { const m = await pev(`new Promise(r => chrome.runtime.sendMessage({ type: 'media', tabId: ${tb.id} }, r))`); if (m && m.length) media = m; } if (media && media.length) break; await sleep(500); }
    check('media sniffer detected the video', Array.isArray(media) && media.some(m => m.url.endsWith('/video.mp4')), String(JSON.stringify(media)).slice(0, 120));

    // (3) download all links
    await pev(`chrome.tabs.query({}).then(ts => { const t = ts.find(x => x.url.endsWith('/page')); return new Promise(r => chrome.runtime.sendMessage({ type: 'collect', tab: { id: t.id, url: t.url, title: t.title } }, r)); })`);
    await sleep(1500);
    console.log('  tabs:', JSON.stringify(await ev(`chrome.tabs.query({}).then(t => t.map(x => x.url))`)));
    console.log('  manual collect call:', JSON.stringify(await ev(`(async()=>{ const c = await chrome.storage.local.get(null); try { const r = await fetch('http://127.0.0.1:6810/api/collect', {method:'POST', headers:{'Content-Type':'application/json','X-Token':c.token}, body: JSON.stringify({links:[{url:'http://a/b.zip',text:'x'}], referer:'http://a', title:'t'})}); return r.status + ' ' + await r.text(); } catch(e) { return 'ERR ' + e.message; } })()`)));
    const tabsAfter = await j('http://127.0.0.1:9333/json/list');
    const collectTab = tabsAfter.find(t => t.url === 'http://127.0.0.1:6810/' && t.type === 'page');
    check('"download all links" opened the collection dialog page', !!collectTab, collectTab && collectTab.url);
    if (collectTab) {
      const t = await cdpConnect(collectTab.webSocketDebuggerUrl);
      let open = false;
      for (let i = 0; i < 10 && !open; i++) { await sleep(500); open = (await t.send('Runtime.evaluate', { expression: "!!document.querySelector('dialog[open]') && document.querySelector('dialog[open]').innerText.includes('doc1.pdf')", returnByValue: true })).result.result.value; }
      check('selection dialog lists the page links (doc1.pdf ...)', open); t.close();
    }

    // (1) download takeover: click a link that triggers a browser download
    const before = (await state()).downloads.length;
    console.log('  click:', JSON.stringify((await page('Runtime.evaluate', { expression: "location.href + ' | ' + !!document.getElementById('z') + ' | ' + (document.getElementById('z').click(), 'clicked')", returnByValue: true, userGesture: true })).result));
    let got;
    await sleep(2500);
    if (!(await state()).downloads.length && !(await state()).proposals.length) { console.log('  (page click produced no browser download in headless mode; using chrome.downloads.download)'); await ev(`chrome.downloads.download({ url: 'http://127.0.0.1:6821/file.zip' }).then(id => id)`); }
    await ev(`chrome.downloads.onCreated.addListener(i => console.log('onCreated', i.url, i.state)); chrome.downloads.onErased.addListener(i => console.log('erased', i))`);
    console.log('  capture-check:', JSON.stringify(await ev(`(async()=>{ const c = await chrome.storage.local.get(null); const r = await fetch('http://127.0.0.1:6810/api/capture-check', {method:'POST', headers:{'Content-Type':'application/json','X-Token':c.token}, body: JSON.stringify({url:'http://127.0.0.1:6821/file.zip', mime:'application/zip', size:0, extraTypes:[]})}); return r.status + ' ' + await r.text(); })()`)));
    let prop;
    for (let i = 0; i < 24 && !(prop && prop.status === 'ready'); i++) { await sleep(500); prop = (await state()).proposals.find(p => /file\.zip/.test(p.url)); }
    check('the app holds the browser download and asks first ("Download File Info": name, size, type, nothing started)', !!prop && prop.fileName === 'browser-test.zip' && prop.size === ZIP.length && prop.contentType === 'application/zip' && (await state()).downloads.length === before, prop && JSON.stringify([prop.fileName, prop.size, prop.contentType]));
    if (prop) await api('POST', '/api/proposals/' + prop.id + '/accept', { action: 'start' });
    for (let i = 0; i < 24 && !got; i++) { await sleep(500); got = (await state()).downloads.find(d => /file\.zip/.test(d.url)); }
    console.log('  browser downloads:', JSON.stringify(await ev(`chrome.downloads.search({}).then(l => l.map(d => [d.url, d.state, d.error]))`)));
    console.log('  adm state:', JSON.stringify((await state()).downloads.map(d => [d.url, d.status, d.error])));
    check('browser download was taken over by Advance Download Manager', !!got && (await state()).downloads.length > before, got && got.status);
    if (got) {
      for (let i = 0; i < 20 && got.status !== 'complete'; i++) { await sleep(500); got = (await state()).downloads.find(d => d.id === got.id); }
      check('taken-over download completed with the right size', got.status === 'complete' && got.size === ZIP.length, `${got.status} ${got.size}`);
    }
    // browser must not have kept its own copy
    const bd = await ev(`chrome.downloads.search({}).then(l => l.length)`);
    check('browser removed its own copy of the download', bd === 0, 'browser downloads: ' + bd);


    // ---- "Download this video": the button over a video (content script), permalink, cookies, popup button, on/off switch ----
    await api('PUT', '/api/settings', { video: { ytdlpPath: FAKE, ffmpegPath: FAKE } });
    await page('Page.navigate', { url: "http://127.0.0.1:6821/video" });
    await sleep(2500);
    await page('Runtime.evaluate', { expression: "document.cookie = 'sid=abc123; path=/'" });
    await page('Runtime.evaluate', { expression: "fetch('/video.mp4').then(r => r.arrayBuffer()).then(b => b.byteLength)", awaitPromise: true }); // headless Edge does not load the <video> by itself: request the file so the media sniffer sees it
    await page('Runtime.evaluate', { expression: "document.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 150, bubbles: true }))" });
    await sleep(900);
    const btnState = (await page('Runtime.evaluate', { expression: "(() => { const h = document.querySelector('adm-video-button'); if (!h) return 'no-host'; const b = h.shadowRoot.querySelector('.b'); return h.style.display + '|' + b.textContent.trim().slice(0, 30); })()", returnByValue: true })).result.result.value;
    check('the "Download this video" button appears over the video', /^block\|.*Download this video/.test(btnState), String(btnState));
    await page('Runtime.evaluate', { expression: "document.querySelector('adm-video-button').shadowRoot.querySelector('.b').click()" });
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
    await pev(`chrome.tabs.query({}).then(ts => { const t = ts.find(x => x.url.endsWith('/video')); return new Promise(r => chrome.runtime.sendMessage({ type: 'videoPage', tab: { id: t.id, url: t.url, title: t.title } }, r)); })`);
    let vr2;
    for (let i = 0; i < 20 && !(vr2 && vr2.status === 'ready'); i++) { await sleep(500); vr2 = (await state()).videoRequests[0]; }
    check('the popup button "Download video from this page" sends the current page too', !!vr2 && vr2.urls[0].endsWith('/video'), vr2 && JSON.stringify(vr2.urls));
    if (vr2) await api('POST', '/api/video/' + vr2.id + '/reject', {});
    // switch the button off in the extension settings
    await ev(`chrome.storage.local.set({ videoButton: false })`);
    await sleep(400);
    await page('Runtime.evaluate', { expression: "document.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 150, bubbles: true }))" });
    await sleep(900);
    const off = (await page('Runtime.evaluate', { expression: "document.querySelector('adm-video-button') ? document.querySelector('adm-video-button').style.display : 'none'", returnByValue: true })).result.result.value;
    check('with the "Show the Download this video button" option off, no button is shown', off === 'none', String(off));
    await ev(`chrome.storage.local.set({ videoButton: true })`);
    // disabled switch
    await ev(`chrome.storage.local.set({ enabled: false })`);
    const n2 = (await state()).downloads.length;
    await page('Runtime.evaluate', { expression: "document.getElementById('z').click()", userGesture: true }); await sleep(2500);
    check('with "Take over downloads" off, nothing is sent', (await state()).downloads.length === n2 && (await state()).proposals.length === 0);
  } catch (e) {
    check('test run', false, e.message);
  } finally {
    br.kill(); adm.kill(); origin.close();
    require('child_process').spawnSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*' + [IO.Path]::GetFileName('" + tmp.replace(/\\/g, '/') + "') + '*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { stdio: 'ignore' });
    await sleep(500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
  }
})();
