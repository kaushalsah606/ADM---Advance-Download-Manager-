#!/usr/bin/env node
'use strict';
// Advance Download Manager launcher. command-line switches:
//   advance-download-manager /d URL [/p dir] [/f name] [/q] [/n] [/a]     advance-download-manager /s
// (also accepts --d / -d forms, plus --port N, --data DIR, --no-open)
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Manager } = require('../src/manager');
const { createServer } = require('../src/server');
const { startTray } = require('../src/tray');

function parse(argv) {
  const o = { flags: new Set(), port: 6800 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i].replace(/^(\/|--?)/, '').toLowerCase();
    if (['d', 'p', 'f', 'port', 'data'].includes(a)) { o[a] = argv[++i]; continue; }
    o.flags.add(a);
  }
  if (o.port) o.port = +o.port;
  return o;
}

// Opens the UI in a chromeless Edge/Chrome app window when one is installed, else in the default browser.
function openUi(url) {
  if (process.platform !== 'win32') return;
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const rel = ['Microsoft\Edge\Application\msedge.exe', 'Google\Chrome\Application\chrome.exe'];
  for (const r of roots) for (const x of rel) {
    const exe = path.join(r, x);
    if (fs.existsSync(exe)) return void spawn(exe, ['--app=' + url, '--window-size=1200,760'], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  }
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function call(info, method, route, data) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: info.port, path: route, method, headers: { 'X-Token': info.token, 'Content-Type': 'application/json' }, timeout: 2000 }, res => {
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString() || '{}')));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(data ? JSON.stringify(data) : undefined);
  });
}

(async () => {
  const a = parse(process.argv.slice(2));
  const dataDir = a.data || path.join(os.homedir(), '.advance-download-manager');
  const sessionFile = path.join(dataDir, 'session.json');
  const job = a.d ? { url: a.d, saveDir: a.p, fileName: a.f, queue: a.flags.has('a') || a.flags.has('s') ? 'main' : null, startNow: !a.flags.has('a') } : null;

  // 1) already running? hand the job to the first instance
  try {
    const info = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    await call(info, 'GET', '/api/state');
    if (job) console.log(JSON.stringify(await call(info, 'POST', '/api/downloads', job)));
    if (a.flags.has('s')) await call(info, 'POST', '/api/queues/main/start');
    console.log(`Running instance on http://127.0.0.1:${info.port}/`);
    if (!job && !a.flags.has('s') && !a.flags.has('no-open')) openUi(`http://127.0.0.1:${info.port}/`);
    return;
  } catch { /* none running */ }

  // 2) start a new instance
  const manager = new Manager({ dataDir }).load();
  // if the default port 6800 is taken by another program, use 6810-6819 (the browser extensions look there too)
  const srv = createServer(manager, { port: a.port, fallbackPorts: a.port === 6800 ? [6810, 6811, 6812, 6813, 6814, 6815, 6816, 6817, 6818, 6819] : [] });
  const port = await srv.listen();
  fs.writeFileSync(sessionFile, JSON.stringify({ port, token: srv.token, pid: process.pid }), { mode: 0o600 });
  if (manager.settings.captureProxy && manager.settings.captureProxy.enabled) {
    try { console.log('Capture proxy listening on 127.0.0.1:' + await srv.startCapture()); } catch (e) { console.error('Capture proxy could not start:', e.message); }
  }
  // PC-wide capture: apply it when it is switched on; otherwise undo any leftover change from a crashed earlier run
  try { if (manager.settings.systemCapture) await srv.applySystemCapture(); else srv.releaseSystemCapture(); } catch (e) { console.error('System capture:', e.message); }
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Advance Download Manager running at ${url}  (Ctrl+C to quit)`);

  const tray = !a.flags.has('no-tray') && manager.settings.trayIcon ? startTray({ port, token: srv.token }) : null;
  const quit = async () => { if (tray) tray.kill(); srv.releaseSystemCapture(); await manager.shutdown(); try { fs.rmSync(sessionFile); } catch { /* ignore */ } process.exit(0); };
  process.on('SIGINT', quit); process.on('SIGTERM', quit);

  if (job) {
    const v = manager.add({ ...job, queue: job.queue });
    if (v.duplicate) console.log('Already in the list:', v.fileName);
    if (job.startNow) manager.start(v.id);
    if (a.flags.has('q')) {
      manager.on('update', x => {
        if (x.id !== v.id || x.status !== 'complete') return;
        if (a.flags.has('h') && process.platform === 'win32') spawn('rasdial', ['/disconnect'], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
        quit();
      });
      manager.on('update', x => { if (x.id === v.id && x.status === 'error' && !x.retryAt) console.error('Failed:', x.error); });
    }
  }
  if (a.flags.has('s')) manager.startQueue('main');
  if (!a.flags.has('no-open') && !a.flags.has('n') && process.platform === 'win32') openUi(url);
})().catch(e => { console.error(e.message); process.exit(1); });
