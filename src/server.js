'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Manager, defaultSettings } = require('./manager');
const { TEMPLATES } = require('./grabber');
const { expandBatch } = require('./batch');
const { exportList, parseImport } = require('./exportio');
const { systemProxy } = require('./proxy');
const captureProxy = require('./captureproxy');
const syscapture = require('./syscapture');

// restore the Windows proxy setting whenever the process ends (every server registers its data folder here)
const captureFolders = new Set();
process.on('exit', () => { for (const d of captureFolders) { try { syscapture.disable(d); } catch { /* best effort */ } } });

const updater = require('./updater');
const { resource } = require('./paths');
const PUBLIC = resource('public');

function createServer(manager, { port = 6800, token = manager.token(), fallbackPorts = [] } = {}) {
  const clients = new Set();
  const send = (type, data) => { const s = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(s); };
  manager.on('update', v => send('update', v));
  manager.on('removed', id => send('removed', id));
  manager.on('settings', () => send('state', manager.snapshot()));
  manager.on('queues', () => send('state', manager.snapshot()));
  manager.on('complete', v => send('complete', v));
  manager.on('grabber', v => send('grabber', v));
  manager.on('collect', v => send('collect', v));
  manager.on('shutdown-pending', v => send('shutdown-pending', v));
  setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000).unref();

  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const body = req => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > 5e6) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(Object.assign(new Error('Bad JSON'), { status: 400 })); } });
  });

  const server = http.createServer(async (req, res) => {
    try {
      // Localhost-only API: block DNS-rebinding (Host check) and cross-site writes (token).
      const host = (req.headers.host || '').replace(/:\d+$/, '');
      if (host !== '127.0.0.1' && host !== 'localhost') return json(res, 403, { error: 'Forbidden host' });
      const url = new URL(req.url, 'http://x');
      // Only our browser extensions may call the API cross-origin (token still required).
      const origin = req.headers.origin || '';
      if (/^(chrome|moz|edge)-extension:\/\//.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Headers', 'X-Token, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
        res.setHeader('Vary', 'Origin');
        if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      }

      if (req.method === 'POST' && url.pathname === '/api/pair') { // extensions only: a web page cannot forge the Origin header
        if (!/^(chrome|moz|edge)-extension:\/\//.test(origin)) return json(res, 403, { error: 'Only browser extensions can pair' });
        const b = await body(req);
        const r = manager.pairRequest(origin, b.name, b.browser);
        if (r.approved) return json(res, 200, { approved: true, token, port: server.address().port });
        return json(res, 202, { pending: true, denied: !!r.denied });
      }
      if (req.method === 'GET' && url.pathname === '/capture.pac') {
        res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig', 'Cache-Control': 'no-store' });
        return res.end(syscapture.pacScript(manager.settings.captureProxy.port));
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace('__TOKEN__', token).replace('__VERSION__', updater.current);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
        return res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/favicon.png') { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' }); return res.end(fs.readFileSync(path.join(PUBLIC, 'favicon.png'))); }
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
      if (req.headers['x-token'] !== token && url.searchParams.get('t') !== token) return json(res, 401, { error: 'Bad token' });

      const m = (method, pattern) => {
        if (req.method !== method) return null;
        const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '([^/]+)') + '$');
        const r = re.exec(url.pathname);
        return r ? r.slice(1).map(decodeURIComponent) : null;
      };
      let p;

      if (m('GET', '/api/events')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`event: state\ndata: ${JSON.stringify(manager.snapshot())}\n\n`);
        clients.add(res); req.on('close', () => clients.delete(res));
        return;
      }
      if (m('GET', '/api/state')) return json(res, 200, manager.snapshot());
      if (m('GET', '/api/templates')) return json(res, 200, Object.keys(TEMPLATES));

      if (m('POST', '/api/preview-zip')) return json(res, 200, await manager.previewZip(await body(req)));
      if (m('POST', '/api/probe')) return json(res, 200, await manager.probe(await body(req)));
      if (m('POST', '/api/downloads')) {
        const b = await body(req);
        return json(res, 200, b.urls ? manager.addMany(b.urls, b) : manager.add(b));
      }
      if ((p = m('POST', '/api/downloads/:id/start'))) { manager.start(p[0]); return json(res, 200, { ok: true }); }
      if ((p = m('POST', '/api/downloads/:id/stop'))) { await manager.stop(p[0]); return json(res, 200, { ok: true }); }
      if ((p = m('POST', '/api/downloads/:id/redownload'))) { await manager.redownload(p[0]); return json(res, 200, { ok: true }); }
      if ((p = m('POST', '/api/downloads/:id/reorder'))) { manager.reorder(p[0], (await body(req)).direction); return json(res, 200, { ok: true }); }
      if ((p = m('POST', '/api/downloads/:id/open'))) {
        const d = manager.get(p[0]);
        const what = (await body(req)).what || 'folder';
        const file = d.rec.status === 'complete' ? d.destPath : d.partPath;
        if ((what === 'file' || what === 'with') && d.rec.status !== 'complete') return json(res, 409, { error: 'The download is not complete yet' });
        if (what === 'with' && process.platform === 'win32') { spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', file], { detached: true, stdio: 'ignore' }).unref(); return json(res, 200, { ok: true, path: file }); }
        if (process.platform === 'win32') spawn('explorer.exe', what === 'file' ? [file] : [`/select,${file}`], { detached: true, stdio: 'ignore' }).unref();
        else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [what === 'file' ? file : path.dirname(file)], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, path: file });
      }
      if ((p = m('PATCH', '/api/downloads/:id'))) return json(res, 200, manager.update(p[0], await body(req)));
      if ((p = m('DELETE', '/api/downloads/:id'))) { await manager.remove(p[0], url.searchParams.get('file') === '1'); return json(res, 200, { ok: true }); }
      if (m('POST', '/api/stop-all')) { await manager.stopAll(); return json(res, 200, { ok: true }); }
      if (m('POST', '/api/delete-completed')) { await manager.removeCompleted(!!(await body(req)).deleteFiles); return json(res, 200, { ok: true }); }

      if (m('PUT', '/api/settings')) return json(res, 200, manager.setSettings(await body(req)));
      if (m('PUT', '/api/categories')) { manager.setCategories(await body(req)); return json(res, 200, { ok: true }); }
      if (m('POST', '/api/queues')) { manager.saveQueue(await body(req)); return json(res, 200, { ok: true }); }
      if ((p = m('DELETE', '/api/queues/:id'))) { manager.deleteQueue(p[0]); return json(res, 200, { ok: true }); }
      if ((p = m('POST', '/api/queues/:id/start'))) { manager.startQueue(p[0]); return json(res, 200, { ok: true }); }
      if ((p = m('POST', '/api/queues/:id/stop'))) { manager.stopQueue(p[0]); return json(res, 200, { ok: true }); }

      if (m('POST', '/api/import-text')) return json(res, 200, { urls: Manager.extractUrls((await body(req)).text || '') });

      // ----- Site Grabber -----
      if (m('POST', '/api/grabber')) return json(res, 200, { id: manager.startGrab(await body(req)).id });
      if ((p = m('GET', '/api/grabber/:id'))) {
        const j = manager.grabJob(p[0]);
        return json(res, 200, { id: j.id, running: j.running, stats: j.stats, files: j.files, error: j.error });
      }
      if ((p = m('POST', '/api/grabber/:id/add'))) { const b = await body(req); return json(res, 200, manager.grabAdd(manager.grabJob(p[0]), b.indexes, b.queue === undefined ? 'main' : b.queue)); }
      if ((p = m('POST', '/api/grabber/:id/stop'))) { manager.grabJob(p[0]).ac.abort(); return json(res, 200, { ok: true }); }

      // ----- scheduled projects -----
      if (m('POST', '/api/projects')) return json(res, 200, manager.saveProject(await body(req)));
      if ((p = m('DELETE', '/api/projects/:id'))) { manager.deleteProject(p[0]); return json(res, 200, { ok: true }); }
      if ((p = m('POST', '/api/projects/:id/run'))) { manager.runProject(p[0]).catch(() => {}); return json(res, 200, { ok: true }); }

      // ----- browser capture rules, batch, export / import, collections -----
      if (m('POST', '/api/capture-check')) return json(res, 200, manager.captureCheck(await body(req)));
      if (m('POST', '/api/batch/preview')) {
        const urls = expandBatch(await body(req));
        return json(res, 200, { count: urls.length, first: urls[0], second: urls[1] || null, last: urls[urls.length - 1] });
      }
      if (m('POST', '/api/batch/add')) { const b = await body(req); return json(res, 200, manager.addMany(expandBatch(b), b)); }
      if (m('GET', '/api/export')) {
        const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
        const scope = url.searchParams.get('scope') || 'all';
        let list = [...manager.downloads.values()];
        if (scope === 'selected') list = list.filter(d => ids.includes(d.rec.id));
        else if (scope === 'queue') list = list.filter(d => d.rec.queue);
        const fmtParam = url.searchParams.get('format');
        const format = ['text', 'ief', 'ef2'].includes(fmtParam) ? fmtParam : 'json';
        res.writeHead(200, { 'Content-Type': format === 'json' ? 'application/json' : 'text/plain', 'Content-Disposition': `attachment; filename="advance-download-manager-export.${format === 'text' ? 'txt' : format === 'json' ? 'sgx' : format}"` });
        return res.end(exportList(list, { format, includeCookies: url.searchParams.get('cookies') === '1' }));
      }
      if (m('POST', '/api/import')) {
        const b = await body(req);
        const items = parseImport(b.text);
        return json(res, 200, { added: manager.addItems(items, { queue: b.queue === undefined ? 'main' : b.queue, duplicatePolicy: 'number' }).length });
      }
      if (m('POST', '/api/collect')) return json(res, 200, manager.collect(await body(req)));
      if ((p = m('GET', '/api/collect/:id'))) return json(res, 200, manager.collection(p[0]));
      if ((p = m('POST', '/api/collect/:id/add'))) {
        const b = await body(req), c = manager.collection(p[0]);
        const items = (b.items || []).filter(i => c.items.some(x => x.url === i.url)).map(i => ({ url: i.url, fileName: i.fileName, description: i.description, referer: c.referer }));
        return json(res, 200, { added: manager.addItems(items, { queue: b.queue === undefined ? 'main' : b.queue, saveDir: b.saveDir, category: b.category, startNow: !!b.startNow, duplicatePolicy: 'number' }).length });
      }

      // ----- misc -----
      if ((p = m('POST', '/api/downloads/:id/options'))) return json(res, 200, manager.setDownloadOptions(p[0], await body(req)));
      if (m('GET', '/api/update/check')) {
        const u = manager.settings.updates;
        try { return json(res, 200, await updater.check({ repo: u.repo, apiBase: u.apiBase || undefined })); }
        catch (e) { return json(res, 200, { current: updater.current, available: false, error: e.message }); }
      }
      if (m('POST', '/api/update/install')) {
        const u = manager.settings.updates;
        if (!require('./paths').isPackaged && !u.apiBase) return json(res, 400, { error: 'Updates are installed by the Windows installer build only' });
        const info = await updater.check({ repo: u.repo, apiBase: u.apiBase || undefined });
        const file = await updater.download(info, { repo: u.repo, allowedPrefixes: u.apiBase ? [u.apiBase] : undefined });
        json(res, 200, { ok: true, installing: info.latest });
        if (!u.apiBase) { updater.install(file); setTimeout(async () => { await manager.shutdown(); process.exit(0); }, 300); }
        return;
      }
      if (m('GET', '/api/autostart')) return json(res, 200, { enabled: manager.autostart() });
      if (m('POST', '/api/autostart')) return json(res, 200, { ok: manager.autostart(!!(await body(req)).enabled) });
      if (m('GET', '/api/defaults')) { const d = defaultSettings(); return json(res, 200, { fileTypes: d.fileTypes, mediaTypes: d.mediaTypes, excludeAddresses: d.excludeAddresses }); }
      if (m('POST', '/api/pac/test')) return json(res, 200, await manager.testPac(await body(req)));
      if (m('GET', '/api/dialup/entries')) return json(res, 200, { entries: manager.rasEntries() });
      if (m('POST', '/api/dialup/connect')) return json(res, 200, { ok: await manager.dialUp() });
      if (m('POST', '/api/shutdown-cancel')) { manager.cancelShutdown(); return json(res, 200, { ok: true }); }
      if (m('POST', '/api/shutdown-now')) { manager.shutdownNow(); return json(res, 200, { ok: true }); }
      if (m('POST', '/api/shutdown')) { json(res, 200, { ok: true }); setTimeout(async () => { await manager.shutdown(); process.exit(0); }, 100); return; }
      if (m('POST', '/api/capture-proxy')) {
        const b = await body(req);
        if (b.enabled) { manager.settings.captureProxy = { enabled: true, port: +b.port || manager.settings.captureProxy.port }; await stopCapture(); const p = await startCapture(); manager.saveNow(); return json(res, 200, { running: true, port: p }); }
        manager.settings.captureProxy = { ...manager.settings.captureProxy, enabled: false }; await stopCapture(); manager.saveNow();
        return json(res, 200, { running: false });
      }
      if (m('GET', '/api/capture-proxy')) return json(res, 200, { running: !!capture, port: capture ? capture.port : manager.settings.captureProxy.port });
      if (m('GET', '/api/system-proxy')) return json(res, 200, systemProxy() || {});
      if (m('POST', '/api/open-extension-folder')) {
        const here = path.dirname(process.execPath);
        const dir = [path.join(here, 'browser-extension'), path.join(__dirname, '..', 'dist'), path.join(__dirname, '..', 'extension')].find(d => fs.existsSync(d));
        if (!dir) return json(res, 404, { error: 'Extension folder not found' });
        require('child_process').spawn(process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', [dir], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
        return json(res, 200, { ok: true, dir });
      }
      if (m('POST', '/api/open-browser')) { // starts the chosen browser on its extensions page (Windows)
        if (process.platform !== 'win32') return json(res, 400, { error: 'Windows only' });
        const which = String((await body(req)).browser || '');
        const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
        const spec = { edge: ['Microsoft\\Edge\\Application\\msedge.exe', 'edge://extensions'], chrome: ['Google\\Chrome\\Application\\chrome.exe', 'chrome://extensions'], firefox: ['Mozilla Firefox\\firefox.exe', 'about:debugging#/runtime/this-firefox'] }[which];
        if (!spec) return json(res, 400, { error: 'Unknown browser' });
        const exe = pf.map(p => path.join(p, spec[0])).find(p => fs.existsSync(p));
        if (!exe) return json(res, 404, { error: 'That browser was not found' });
        require('child_process').spawn(exe, [spec[1]], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
        return json(res, 200, { ok: true });
      }
      if (m('GET', '/api/video/tools')) return json(res, 200, await manager.refreshVideoTools());
      if (m('POST', '/api/video/tools/install')) return json(res, 200, manager.installVideoTools((await body(req)).tools));
      if (m('POST', '/api/video/tools/update')) return json(res, 200, await manager.updateVideoEngine());
      if (m('POST', '/api/video/open')) return json(res, 200, manager.videoOpen(await body(req)));
      if ((p = m('POST', '/api/video/:id/accept'))) return json(res, 200, manager.videoAccept(p[0], await body(req)));
      if ((p = m('POST', '/api/video/:id/reject'))) return json(res, 200, { ok: manager.videoReject(p[0]) });
      if ((p = m('POST', '/api/video/:id/retry'))) return json(res, 200, { ok: manager.videoRetry(p[0]) });
      if (m('POST', '/api/propose')) return json(res, 200, manager.propose(await body(req)));
      if ((p = m('POST', '/api/proposals/:id/accept'))) return json(res, 200, manager.proposalAccept(p[0], await body(req)));
      if ((p = m('POST', '/api/proposals/:id/reject'))) return json(res, 200, { ok: manager.proposalReject(p[0]) });
      if ((p = m('POST', '/api/proposals/:id/preview'))) return json(res, 200, await manager.previewProposal(p[0]));
      if (m('POST', '/api/pick-folder')) { // native "choose a folder" window (Windows)
        if (process.platform !== 'win32') return json(res, 400, { error: 'Folder chooser is available on Windows only' });
        const start = String((await body(req)).start || '');
        const ps = "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $f.ShowInTaskbar = $false; $f.WindowState = 'Minimized'; $f.Show(); " +
          "$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose a folder'; $d.ShowNewFolderButton = $true; if ($env:ADM_START -and (Test-Path $env:ADM_START)) { $d.SelectedPath = $env:ADM_START }; " +
          "if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }; $f.Close()";
        const out = await new Promise(resolve => {
          const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', ps], { env: { ...process.env, ADM_START: start }, windowsHide: true });
          let t = ''; c.stdout.on('data', d => { t += d; }); c.on('error', () => resolve('')); c.on('exit', () => resolve(t.trim()));
          setTimeout(() => { try { c.kill(); } catch { /* done */ } resolve(''); }, 10 * 60 * 1000);
        });
        return json(res, 200, { path: out });
      }
      if (m('GET', '/api/pair')) return json(res, 200, { pending: manager.snapshot().pendingPairs, paired: manager.settings.pairedExtensions });
      if (m('POST', '/api/pair/decision')) { const b = await body(req); return json(res, 200, { ok: manager.pairDecision(String(b.origin || ''), !!b.allow) }); }
      if (m('POST', '/api/pair/revoke')) return json(res, 200, { ok: manager.pairRevoke(String((await body(req)).origin || '')) });
      if (m('GET', '/api/system-capture')) return json(res, 200, { supported: process.platform === 'win32', enabled: manager.settings.systemCapture, active: syscapture.active(), proxyPort: capture ? capture.port : 0 });
      if (m('POST', '/api/system-capture')) {
        if (process.platform !== 'win32') return json(res, 400, { error: 'System-wide capture is available on Windows only' });
        manager.setSettings({ systemCapture: !!(await body(req)).enabled });
        const r = await applySystemCapture();
        return json(res, 200, { enabled: manager.settings.systemCapture, active: r.active });
      }

      return json(res, 404, { error: 'Not found' });
    } catch (e) {
      json(res, e.status || (e.fatal ? 400 : 500), { error: e.message });
    }
  });

  let capture = null;
  const startCapture = async () => {
    if (capture) return capture.port;
    const cp = captureProxy.create(manager, { port: manager.settings.captureProxy.port, apiPort: server.address() && server.address().port });
    const p = await cp.listen();
    capture = { cp, port: p };
    return p;
  };
  const stopCapture = async () => { if (capture) { await capture.cp.close(); capture = null; } };
  // system-wide capture: capture proxy + Windows proxy-script setting (restored on exit, on switching off and after a crash)
  captureFolders.add(manager.dataDir);
  const applySystemCapture = async () => {
    if (!manager.settings.systemCapture) { syscapture.disable(manager.dataDir); return { active: false }; }
    await startCapture();
    const ok = syscapture.enable(manager.dataDir, `http://127.0.0.1:${server.address().port}/capture.pac`);
    return { active: ok };
  };
  const releaseSystemCapture = () => { try { syscapture.disable(manager.dataDir); } catch { /* best effort */ } };
  server.on('close', () => { stopCapture(); });

  return {
    server, token, startCapture, stopCapture, applySystemCapture, releaseSystemCapture, capturePort: () => (capture ? capture.port : 0),
    // listens on `port`; if it is taken, tries the fallback ports in turn
    listen: async () => {
      const tryPort = p => new Promise((resolve, reject) => {
        const onErr = e => reject(e);
        server.once('error', onErr);
        server.listen(p, '127.0.0.1', () => { server.off('error', onErr); resolve(server.address().port); });
      });
      let last;
      for (const p of [port, ...fallbackPorts]) {
        try { return await tryPort(p); } catch (e) { last = e; if (e.code !== 'EADDRINUSE') throw e; }
      }
      throw last;
    },
  };
}

module.exports = { createServer };
