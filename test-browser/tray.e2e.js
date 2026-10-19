'use strict';
// Windows-only: starts the real app with its tray icon in self-test mode. tray.ps1 then clicks its own context-menu items
// (Open / Start main queue / Stop all downloads / Exit) and the test checks the effect on the running app.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

if (process.platform !== 'win32') { console.log('skipped (Windows only)'); process.exit(0); }
const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-tray-'));
process.env.ADM_DOWNLOAD_ROOT = path.join(tmp, 'downloads'); // tests must never write into the user's real Downloads folder
const log = path.join(tmp, 'tray.log');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

// slow origin: 30 MB at ~1 MB/s so a download stays active while the menu items are clicked
const origin = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 30 * 1048576 });
  let sent = 0;
  const t = setInterval(() => { if (sent >= 30 * 1048576 || res.destroyed) { clearInterval(t); return res.end(); } res.write(Buffer.alloc(262144)); sent += 262144; }, 250);
  res.on('close', () => clearInterval(t));
});

(async () => {
  await new Promise(r => origin.listen(6841, '127.0.0.1', r));
  const app = spawn(process.execPath, [path.join(ROOT, 'bin', 'advance-download-manager.js'), '--no-open', '--port', '6840', '--data', path.join(tmp, 'adm')], {
    stdio: 'ignore', env: { ...process.env, ADM_TRAY_SELFTEST: '1', ADM_TRAY_LOG: log },
  });
  let exited = false; app.on('exit', () => { exited = true; });
  try {
    let session;
    for (let i = 0; i < 20 && !session; i++) { await sleep(500); try { session = JSON.parse(fs.readFileSync(path.join(tmp, 'adm', 'session.json'), 'utf8')); } catch { /* starting */ } }
    const api = (m, p, b) => fetch('http://127.0.0.1:6840' + p, { method: m, headers: { 'X-Token': session.token, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());
    // a queued (not started) download: only the tray's "Start main queue" can start it
    const added = await api('POST', '/api/downloads', { url: 'http://127.0.0.1:6841/big.bin', queue: 'main', startNow: false, saveDir: path.join(tmp, 'dl') });
    const status = async () => ((await api('GET', '/api/state')).downloads.find(d => d.id === added.id) || {}).status;
    const before = await status();
    check('download is waiting in the queue before any tray click', before !== 'downloading', before);

    let s = before;
    for (let i = 0; i < 20 && s !== 'downloading'; i++) { await sleep(500); s = await status(); }
    check('tray "Start main queue" started the download', s === 'downloading', s);

    for (let i = 0; i < 40 && s === 'downloading'; i++) { await sleep(500); s = await status(); }
    check('tray "Stop all downloads" stopped it', s !== 'downloading' && s !== undefined, s);

    for (let i = 0; i < 20 && !exited; i++) await sleep(500);
    check('tray "Exit" shut the whole app down', exited);

    const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    check('tray icon was visible', /visible=True/.test(text));
    check('"Open" menu item handler ran', /open clicked/.test(text));
    check('tooltip showed live activity while downloading', /tooltip=Advance Download Manager - 1 active/.test(text), (text.match(/tooltip=[^\r\n]*active[^\r\n]*/) || [''])[0]);
  } catch (e) {
    check('test run', false, e.message);
  } finally {
    try { app.kill(); } catch { /* gone */ }
    origin.close();
    await sleep(500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
  }
})();
