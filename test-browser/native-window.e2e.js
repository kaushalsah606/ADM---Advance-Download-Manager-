'use strict';
// Windows-only: runs the real native host (AdvanceDownloadManager.exe) from build/app (or ADM_APP_DIR) in self-test mode and checks
//   - the engine starts and a real top-level window with the right title appears
//   - the window shows the app UI (inspected through WebView2's debugging port)
//   - closing the window hides it to the tray while downloads keep running
//   - tray "Open" / "Start main queue" / "Stop all downloads" / "Exit" work, and Exit stops the engine too
//   - a second launch is handed to the first instance (single instance) and a /d link reaches the engine
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

if (process.platform !== 'win32') { console.log('skipped (Windows only)'); process.exit(0); }
const APP = process.env.ADM_APP_DIR || path.join(__dirname, '..', 'build', 'app');
const HOST = path.join(APP, 'AdvanceDownloadManager.exe');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-native-'));
process.env.ADM_DOWNLOAD_ROOT = path.join(tmp, 'downloads'); // tests must never write into the user's real Downloads folder
const data = path.join(tmp, 'data'), log = path.join(tmp, 'host.log');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
const readLog = () => { try { return fs.readFileSync(log, 'utf8'); } catch { return ''; } };

const origin = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 30 * 1048576 });
  let sent = 0;
  const t = setInterval(() => { if (sent >= 30 * 1048576 || res.destroyed) { clearInterval(t); return res.end(); } res.write(Buffer.alloc(262144)); sent += 262144; }, 250);
  res.on('close', () => clearInterval(t));
});

// real window state via Win32 (is there a visible top-level window for this process, and what is its title?)
function windowInfo(pid) {
  const ps = `Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public class W{public delegate bool EP(IntPtr h,IntPtr l);[DllImport("user32.dll")]public static extern bool EnumWindows(EP p,IntPtr l);[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);[DllImport("user32.dll")]public static extern int GetWindowLong(IntPtr h,int i);public static string Find(uint pid){string r="none";EnumWindows((h,l)=>{uint p;GetWindowThreadProcessId(h,out p);if(p==pid&&IsWindowVisible(h)){var sb=new StringBuilder(256);GetWindowText(h,sb,256);if(sb.Length>0){r=sb.ToString();return false;}}return true;},IntPtr.Zero);return r;}}'; [W]::Find(${pid})`;
  return spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).stdout.trim();
}
async function cdpTargets() { try { return await (await fetch('http://127.0.0.1:9555/json/list')).json(); } catch { return []; } }
async function cdpEval(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const out = await new Promise(r => { ws.onmessage = e => r(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); });
  ws.close();
  return out.result && out.result.result && out.result.result.value;
}

(async () => {
  await new Promise(r => origin.listen(6851, '127.0.0.1', r));
  check('yt-dlp and FFmpeg ship inside the app (no setup for video downloads)', ['yt-dlp.exe', 'ffmpeg.exe'].every(f => fs.existsSync(path.join(APP, 'tools', f)) && fs.statSync(path.join(APP, 'tools', f)).size > 5e6));
  check('host exe, engine exe and WebView2 libraries are present', ['AdvanceDownloadManager.exe', 'adm-engine.exe', 'Microsoft.Web.WebView2.Core.dll', 'WebView2Loader.dll'].every(f => fs.existsSync(path.join(APP, f))));
  const env = { ...process.env, ADM_INSTANCE: '.test' + process.pid, ADM_HOST_DATA: path.join(tmp, 'host'), ADM_DATA_DIR: data, ADM_HOST_LOG: log, ADM_HOST_SELFTEST: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9555' };
  const host = spawn(HOST, [], { env, stdio: 'ignore' });
  let hostExited = false; host.on('exit', () => { hostExited = true; });
  try {
    let session;
    for (let i = 0; i < 40 && !session; i++) { await sleep(500); try { session = JSON.parse(fs.readFileSync(path.join(data, 'session.json'), 'utf8')); } catch { /* starting */ } }
    for (let i = 0; i < 20 && !/engine ready/.test(readLog()); i++) await sleep(250);
    check('host started the engine', !!session && /engine ready/.test(readLog()), readLog().split(/\r?\n/)[0]);
    const api = (m, p, b) => fetch('http://127.0.0.1:' + session.port + p, { method: m, headers: { 'X-Token': session.token, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());

    let title = 'none';
    for (let i = 0; i < 20 && title === 'none'; i++) { await sleep(500); title = windowInfo(host.pid); }
    check('a real visible top-level window exists with the app title', title === 'Advance Download Manager', title);

    let page;
    for (let i = 0; i < 20 && !page; i++) { await sleep(500); page = (await cdpTargets()).find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1:' + session.port)); }
    check('the window shows the app UI (WebView2)', !!page, page && page.url);
    if (page) {
      const ui = await cdpEval(page.webSocketDebuggerUrl, "document.title + ' | menubar=' + !!document.querySelector('#menubar') + ' | toolbar=' + !!document.querySelector('#toolbar, .toolbar')");
      check('UI is rendered inside the window', /Advance Download Manager \| menubar=true/.test(ui), ui);
    }

    // queue a download that only the tray's "Start main queue" can start
    const added = await api('POST', '/api/downloads', { url: 'http://127.0.0.1:6851/big.bin', queue: 'main', startNow: false, saveDir: path.join(tmp, 'dl') });
    const status = async () => ((await api('GET', '/api/state')).downloads.find(d => d.id === added.id) || {}).status;

    // single instance: a second launch with a link must not open a second window, and the link must reach the engine
    const second = spawnSync(HOST, ['/d', 'http://127.0.0.1:6851/second.bin', '/a'], { env, timeout: 30000 });
    await sleep(1500);
    const st = await api('GET', '/api/state');
    check('second launch was handed to the running instance (link added, no 2nd window)', st.downloads.some(d => /second\.bin/.test(d.url)) && second.status === 0);

    // browser-extension pairing: a request from an extension makes the app show the Allow prompt (window + notification)
    const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const pairReq = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ name: 'Advance Download Manager Integration', browser: 'Edge' });
      const r = http.request({ host: '127.0.0.1', port: session.port, path: '/api/pair', method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      r.on('error', reject); r.end(data);
    });
    for (let i = 0; i < 20 && !/pair request/.test(readLog()); i++) await sleep(300);
    check('an extension asking to pair is noticed by the native app (pending request)', pairReq === 202 && /pair request: chrome-extension/.test(readLog()));
    let promptText = '';
    for (let i = 0; i < 20 && !/Allow this browser extension/.test(promptText); i++) { await sleep(300); const pg = (await cdpTargets()).find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1:' + session.port)); if (pg) promptText = String(await cdpEval(pg.webSocketDebuggerUrl, "(document.querySelector('dialog[open] h3') || {}).textContent || ''")); }
    check('the window shows the "Allow this browser extension to connect?" prompt', /Allow this browser extension/.test(promptText), promptText);
    await api('POST', '/api/pair/decision', { origin: ORIGIN, allow: true });

    // installer option "Set up the browser extension": a second launch with --setup-browsers opens Options > Browser in the window
    spawnSync(HOST, ['--setup-browsers'], { env, timeout: 20000 });
    let tabName = '';
    for (let i = 0; i < 20 && tabName !== 'Browser'; i++) { await sleep(300); const pg = (await cdpTargets()).find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1:' + session.port)); if (pg) tabName = String(await cdpEval(pg.webSocketDebuggerUrl, "(document.querySelector('#optTabs button.on') || {dataset: {}}).dataset.t || ''")); }
    check('--setup-browsers opens Options > Browser in the window', tabName === 'Browser' && /open browser setup/.test(readLog()), tabName);
    { const pg = (await cdpTargets()).find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1:' + session.port)); if (pg) await cdpEval(pg.webSocketDebuggerUrl, "document.querySelector('#oCancel') && document.querySelector('#oCancel').click()"); }

    // clipboard: copying a download link makes the app offer it (the self-test then accepts the offer)
    spawnSync('powershell', ['-NoProfile', '-Command', "Set-Clipboard -Value 'http://127.0.0.1:6851/from-clipboard.bin'"], { timeout: 20000 });
    for (let i = 0; i < 20 && !/clipboard: download started/.test(readLog()); i++) await sleep(300);
    const stNow = await api('GET', '/api/state');
    const clipAdded = stNow.downloads.some(d => /from-clipboard\.bin/.test(d.url)) || stNow.proposals.some(p => /from-clipboard\.bin/.test(p.url) && p.source === 'clipboard');
    for (let i = 0; i < 20 && !/download request: /.test(readLog()); i++) await sleep(300); // the host polls the engine every 1.5 s
    check('the new download request brought the window forward (Download File Info)', /download request: http:\/\/127\.0\.0\.1:6851\/from-clipboard\.bin/.test(readLog()));
    check('copying a download link: the app offers it and adds it when accepted', /clipboard: offered http:\/\/127\.0\.0\.1:6851\/from-clipboard\.bin/.test(readLog()) && clipAdded);

    // "Download this video": a video page sent by the browser extension is read by yt-dlp and the window shows the quality dialog
    const FAKE = [process.execPath, path.join(__dirname, '..', 'test', 'fixtures', 'fake-ytdlp.js')];
    await api('PUT', '/api/settings', { video: { ytdlpPath: FAKE, ffmpegPath: FAKE } });
    await api('POST', '/api/video/open', { url: 'https://site.example/watch?v=native', title: 'tab', source: 'browser' });
    for (let i = 0; i < 20 && !/video request: /.test(readLog()); i++) await sleep(300);
    check('a video request brought the window forward', /video request: /.test(readLog()));
    let vdlg = '';
    for (let i = 0; i < 25 && !/My: Test\/Video/.test(vdlg); i++) {
      await sleep(400);
      const pg = (await cdpTargets()).find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1:' + session.port));
      if (pg) vdlg = String(await cdpEval(pg.webSocketDebuggerUrl, "(document.querySelector('#dVideo').open ? (document.querySelector('#vName') || {}).value + ' | ' + document.querySelectorAll('#vBody [name=vq]').length + ' qualities' : '')"));
    }
    check('the window shows the video dialog with the title and the quality list', /My: Test\/Video \*1\* \| [4-9] qualities/.test(vdlg), vdlg);
    { const pg = (await cdpTargets()).find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1:' + session.port)); if (pg) await cdpEval(pg.webSocketDebuggerUrl, "document.querySelector('#vCancel').click()"); }

    // wait for the scripted sequence: close window -> tray open -> start queue -> stop all -> tray exit
    for (let i = 0; i < 120 && !/window hidden to tray/.test(readLog()); i++) await sleep(500);
    check('closing the window hides it to the tray (app keeps running)', /window hidden to tray/.test(readLog()) && !hostExited);
    check('no visible window while hidden', windowInfo(host.pid) === 'none' || /tray: open/.test(readLog()), windowInfo(host.pid));

    for (let i = 0; i < 60 && !/tray: open/.test(readLog()); i++) await sleep(500);
    await sleep(800);
    check('tray "Open" brought the window back', /tray: open[\s\S]*window shown/.test(readLog()) && windowInfo(host.pid) === 'Advance Download Manager', windowInfo(host.pid));

    let s = await status();
    for (let i = 0; i < 24 && s !== 'downloading'; i++) { await sleep(500); s = await status(); }
    check('tray "Start main queue" started the download', s === 'downloading', s);
    let turbo = false;
    for (let i = 0; i < 40 && !(turbo && /tray: turbo on/.test(readLog())); i++) { await sleep(500); turbo = (await api('GET', '/api/state')).settings.turbo === true; } // the click is made by the self-test a few seconds after the queue starts
    check('tray "Turbo mode" switched Turbo on in the engine', turbo && /tray: turbo on/.test(readLog()), 'turbo=' + turbo + ' log: ' + readLog().split('\n').filter(l => /turbo|selftest: tray/.test(l)).join(' / '));
    for (let i = 0; i < 40 && s === 'downloading'; i++) { await sleep(500); s = await status(); }
    check('tray "Stop all downloads" stopped it', s !== 'downloading', s);

    for (let i = 0; i < 80 && !hostExited; i++) await sleep(500);
    check('tray "Exit" closed the host', hostExited);
    check('clicking the "Download complete" balloon opens the folder with the finished file', /balloon: would open folder with the file selected: /.test(readLog()), readLog().split('\n').filter(l => /balloon/.test(l)).join(' / '));
    await sleep(1500);
    let engineUp = true; try { await api('GET', '/api/state'); } catch { engineUp = false; }
    check('tray "Exit" also stopped the engine', !engineUp);
    check('Add URL opens with the link you copied last already pasted (read by the native window, no browser permission popup)', /page: add dialog url=http:\/\/127\.0\.0\.1:6851\/from-clipboard\.bin/.test(readLog()), readLog().split('\n').filter(l => /page:|add url/.test(l)).join(' / '));
    const text = readLog();
    // phase 2: the start-with-Windows path (--minimized): engine runs, no window; a second launch shows it; --quit ends everything
    fs.writeFileSync(log, '');
    const env2 = { ...env, ADM_HOST_SELFTEST: '0' };
    const host2 = spawn(HOST, ['--minimized'], { env: env2, stdio: 'ignore' });
    let exited2 = false; host2.on('exit', () => { exited2 = true; });
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(500);
      try { const sj = JSON.parse(fs.readFileSync(path.join(data, 'session.json'), 'utf8')); up = !!(await fetch('http://127.0.0.1:' + sj.port + '/api/state', { headers: { 'X-Token': sj.token } })).ok; } catch { up = false; }
    }
    check('--minimized: engine started, and no window is shown', up && windowInfo(host2.pid) === 'none', 'engine up=' + up + ', window=' + windowInfo(host2.pid));
    spawnSync(HOST, [], { env: env2, timeout: 20000 });
    await sleep(1500);
    check('a second launch shows the hidden window', windowInfo(host2.pid) === 'Advance Download Manager', windowInfo(host2.pid));
    spawnSync(HOST, ['--quit'], { env: env2, timeout: 20000 });
    for (let i = 0; i < 30 && !exited2; i++) await sleep(500);
    await sleep(1500);
    let engine2 = true; try { await fetch('http://127.0.0.1:' + session.port + '/api/state', { headers: { 'X-Token': session.token } }); } catch { engine2 = false; }
    check('--quit closed the host and stopped the engine', exited2 && !engine2, 'host exited=' + exited2 + ', engine up=' + engine2);
    check('tray tooltip showed live activity', /tooltip=Advance Download Manager - \d+ active/.test(text), (text.match(/tooltip=[^\r\n]*active[^\r\n]*/) || [''])[0]);
  } catch (e) {
    check('test run', false, e.message);
  } finally {
    try { host.kill(); } catch { /* gone */ }
    try { const sp = JSON.parse(fs.readFileSync(path.join(data, 'session.json'), 'utf8')).pid; if (sp) spawnSync('taskkill', ['/F', '/PID', String(sp)], { stdio: 'ignore' }); } catch { /* engine already gone */ }
    origin.close();
    await sleep(500);
    if (results.some(r => !r)) console.log('\nhost log:\n' + readLog());
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
  }
})();
