'use strict';
// Windows-only, touches the real per-user Windows proxy-script setting for a few seconds and ALWAYS puts the original value back.
//   * switching "capture all downloads on this PC" on sets AutoConfigURL to the engine's capture.pac and saves a backup
//   * a download requested by an ordinary Windows program (a .NET WebRequest, which follows the system proxy settings) is captured by the app
//   * ordinary web pages still load through it
//   * if the engine is killed hard, traffic still flows (the script ends in DIRECT / the script cannot be fetched)
//   * a crash leftover is repaired at the next start, and switching off restores the user's own previous value
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns').promises;
const { spawn, spawnSync } = require('child_process');

if (process.platform !== 'win32') { console.log('skipped (Windows only)'); process.exit(0); }
const ROOT = path.resolve(__dirname, '..');
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-syscap-'));
process.env.ADM_DOWNLOAD_ROOT = path.join(tmp, 'downloads'); // tests must never write into the user's real Downloads folder
const data = path.join(tmp, 'data');
const API_PORT = 6812, PROXY_PORT = 6805, ORIGIN_PORT = 6852;
const HOSTNAME = 'adm-test.localtest.me'; // public DNS name that resolves to 127.0.0.1 (a "remote" host from the PAC script's point of view)
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

function readValue() { // null = not set
  const r = spawnSync('reg', ['query', KEY, '/v', 'AutoConfigURL'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = /AutoConfigURL\s+REG_SZ\s+(.*)\r?$/m.exec(r.stdout); return m ? m[1].trim() : '';
}
function restoreOriginal(v) {
  if (v === null) spawnSync('reg', ['delete', KEY, '/v', 'AutoConfigURL', '/f'], { stdio: 'ignore' });
  else spawnSync('reg', ['add', KEY, '/v', 'AutoConfigURL', '/t', 'REG_SZ', '/d', v, '/f'], { stdio: 'ignore' });
}
// an ordinary Windows program: .NET WebRequest uses the system (WinINET) proxy settings, including the proxy script
function winRequest(url, timeoutSec = 30) {
  const ps = `[Net.ServicePointManager]::Expect100Continue=$false; try { $r=[Net.WebRequest]::Create('${url}'); $r.Timeout=${timeoutSec * 1000}; $x=$r.GetResponse(); $s=New-Object IO.StreamReader($x.GetResponseStream()); $t=$s.ReadToEnd(); "OK " + $x.StatusCode + " " + $t.Length + " " + $t.Substring(0,[Math]::Min(60,$t.Length)).Replace("\`n"," ") } catch { "ERR " + $_.Exception.Message }`;
  // asynchronous on purpose: the mock origin lives in this process and must keep answering while the request runs
  return new Promise(resolve => {
    const p = spawn('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true });
    let out = ''; p.stdout.on('data', d => { out += d; });
    const t = setTimeout(() => { p.kill(); resolve('ERR timeout'); }, (timeoutSec + 15) * 1000);
    p.on('exit', () => { clearTimeout(t); resolve(out.trim()); });
  });
}

const origin = http.createServer((req, res) => {
  if (req.url.endsWith('.zip')) { res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': 300000, 'Accept-Ranges': 'bytes' }); return res.end(Buffer.alloc(300000, 1)); }
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>plain page served by the test origin</body></html>');
});

let engine;
function startEngine() {
  engine = spawn(process.execPath, [path.join(ROOT, 'bin', 'advance-download-manager.js'), '--no-open', '--no-tray', '--port', String(API_PORT), '--data', data], { stdio: 'ignore' });
  return engine;
}
async function session() { for (let i = 0; i < 40; i++) { await sleep(300); try { const s = JSON.parse(fs.readFileSync(path.join(data, 'session.json'), 'utf8')); const r = await fetch(`http://127.0.0.1:${s.port}/api/state`, { headers: { 'X-Token': s.token } }); if (r.ok) return s; } catch { /* starting */ } } throw new Error('engine did not start'); }
const apiFor = s => (m, p, b) => fetch(`http://127.0.0.1:${s.port}${p}`, { method: m, headers: { 'X-Token': s.token, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());

(async () => {
  const original = readValue();
  console.log('  original AutoConfigURL: ' + (original === null ? '(not set)' : JSON.stringify(original)));
  let canResolve = true;
  try { const a = await dns.lookup(HOSTNAME); canResolve = a.address === '127.0.0.1'; } catch { canResolve = false; }
  await new Promise(r => origin.listen(ORIGIN_PORT, '127.0.0.1', r));
  try {
    fs.mkdirSync(data, { recursive: true });
    startEngine();
    let s = await session(); let api = apiFor(s);
    await api('PUT', '/api/settings', { captureProxy: { enabled: false, port: PROXY_PORT } });

    // 1) on
    const on = await api('POST', '/api/system-capture', { enabled: true });
    const pacUrl = `http://127.0.0.1:${API_PORT}/capture.pac`;
    check('switching it on sets the Windows proxy-script setting to the app\'s capture.pac', on.active === true && readValue() === pacUrl, String(readValue()));
    check('the previous value was saved for restoring', fs.existsSync(path.join(data, 'proxy-backup.json')));
    const pac = await (await fetch(pacUrl)).text();
    check('the script is served by the app, sends only http:// to the capture proxy and ends in DIRECT', pac.includes(`PROXY 127.0.0.1:${PROXY_PORT}; DIRECT`) && /substring\(0, 5\) !== 'http:'/.test(pac));
    check('the capture proxy is listening', (await api('GET', '/api/capture-proxy')).running === true);

    if (!canResolve) {
      console.log('  (skipping traffic checks: ' + HOSTNAME + ' does not resolve to 127.0.0.1 here - no internet / DNS)');
    } else {
      // 2) a normal Windows program downloads a file over plain HTTP -> the app takes it
      const before = (await api('GET', '/api/state')).downloads.length;
      const r1 = await winRequest(`http://${HOSTNAME}:${ORIGIN_PORT}/captured-by-system.zip`);
      let taken = false;
      for (let i = 0; i < 20 && !taken; i++) { await sleep(300); const st = await api('GET', '/api/state'); taken = st.downloads.some(d => /captured-by-system\.zip/.test(d.url)) || st.proposals.some(p => /captured-by-system\.zip/.test(p.url)); }
      check('a download requested by another Windows program was taken over by the app (held for the Download File Info dialog)', taken, r1.slice(0, 90));
      // 3) ordinary pages pass through untouched
      const r2 = await winRequest(`http://${HOSTNAME}:${ORIGIN_PORT}/page.html`);
      check('ordinary web pages still load through the capture proxy', /^OK (200|OK) .*plain page served/.test(r2), r2.slice(0, 90));
    }

    // 4) the app is killed hard: the setting is left behind, but traffic must still work
    spawnSync('taskkill', ['/F', '/PID', String(engine.pid)], { stdio: 'ignore' });
    await sleep(1000);
    check('after a hard kill the setting is still there (nothing could clean it up)', readValue() === pacUrl);
    if (canResolve) {
      const t0 = Date.now();
      const r3 = await winRequest(`http://${HOSTNAME}:${ORIGIN_PORT}/page.html`, 45);
      check('...and the internet still works: requests fall back to a direct connection', /^OK (200|OK) .*plain page served/.test(r3), `${r3.slice(0, 70)} (${Date.now() - t0} ms)`);
    }

    // 5) crash recovery: with capture switched off in the saved settings, the next start removes the leftover
    const stateFile = path.join(data, 'state.json');
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); st.settings.systemCapture = false; fs.writeFileSync(stateFile, JSON.stringify(st));
    startEngine(); s = await session(); api = apiFor(s);
    await sleep(2500);
    check('the next start repairs the leftover and restores the original setting', readValue() === original && !fs.existsSync(path.join(data, 'proxy-backup.json')), String(readValue()));

    // 6) on again, then a normal switch-off restores the user's own value
    await api('POST', '/api/system-capture', { enabled: true });
    check('switched on again', readValue() === `http://127.0.0.1:${s.port}/capture.pac`);
    await api('POST', '/api/system-capture', { enabled: false });
    check('switching off restores exactly the previous setting', readValue() === original, String(readValue()));

    // 7) quitting the app restores it too
    await api('POST', '/api/system-capture', { enabled: true });
    await api('POST', '/api/shutdown');
    for (let i = 0; i < 20 && readValue() !== original; i++) await sleep(300);
    check('quitting the app restores the setting', readValue() === original, String(readValue()));
  } catch (e) {
    check('test run', false, e.message);
  } finally {
    try { if (engine) spawnSync('taskkill', ['/F', '/PID', String(engine.pid)], { stdio: 'ignore' }); } catch { /* gone */ }
    restoreOriginal(original); // whatever happened: leave the machine exactly as it was
    spawnSync('powershell', ['-NoProfile', '-Command', "Add-Type -MemberDefinition '[DllImport(\"wininet.dll\")] public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);' -Name W -Namespace T; [T.W]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0)|Out-Null; [T.W]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)|Out-Null"], { stdio: 'ignore' });
    origin.close();
    console.log('  final AutoConfigURL: ' + (readValue() === null ? '(not set)' : JSON.stringify(readValue())) + (readValue() === original ? '  (same as before)' : '  (DIFFERENT!)'));
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
    process.exit(results.every(Boolean) && readValue() === original ? 0 : 1);
  }
})();
