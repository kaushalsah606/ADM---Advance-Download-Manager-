'use strict';
// Auto-tuned connection count against servers that behave like real ones.
//   congested: a fixed bandwidth shared by all connections that gets WORSE as the number of connections grows (like tele2: best around 6-8)
//   perconn:   every connection is limited to a fixed rate, so more connections = more speed
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Manager } = require('../src/manager');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-autotune-'));
const SIZE = (+process.env.AUTOTUNE_MB || 18) * 1024 * 1024;
const state = { model: 'congested', active: 0, peak: 0 };
const MB = 1048576;
// bytes per second the whole server delivers with n connections
const congested = n => 6 * MB * (n <= 6 ? n / 6 * 0.9 + 0.1 : Math.max(0.2, 1 - 0.04 * (n - 6)));

const origin = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const s = m ? +m[1] : 0, e = m && m[2] ? Math.min(+m[2], SIZE - 1) : SIZE - 1;
  res.writeHead(m ? 206 : 200, { 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream', ...(m ? { 'Content-Range': `bytes ${s}-${e}/${SIZE}` } : {}) });
  state.active++; state.peak = Math.max(state.peak, state.active);
  let pos = s, stopped = false;
  const stop = () => { if (!stopped) { stopped = true; clearInterval(timer); state.active--; } };
  const timer = setInterval(() => {
    if (res.destroyed) return stop();
    if (pos > e) { stop(); return res.end(); }
    const perConn = state.model === 'perconn' ? 0.25 * MB : congested(state.active) / state.active;
    const n = Math.min(e - pos + 1, Math.max(1024, Math.floor(perConn * 0.05)));
    res.write(Buffer.alloc(n)); // the same bytes for every position: the engine's overlap check compares data from different connections
    pos += n;
  }, 50);
  res.on('close', stop);
});
let base;
test.before(async () => { await new Promise(r => origin.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${origin.address().port}`; });
test.after(() => { origin.closeAllConnections?.(); origin.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function run(name, settings) {
  for (let i = 0; i < 100 && state.active > 0; i++) await new Promise(r => setTimeout(r, 50)); // the previous run's connections must be gone: the mock counts them
  state.peak = 0;
  const m = new Manager({ dataDir: path.join(tmp, name, 'data') }).load();
  m.setSettings({ retryIntervalMs: 1000, minSplitBytes: 64 * 1024, ...settings });
  const t0 = Date.now();
  const v = m.add({ url: base + '/big.bin', saveDir: path.join(tmp, name, 'out'), queue: null, startNow: true });
  let x, last = 0, counts = [];
  for (;;) {
    await new Promise(r => setTimeout(r, 200));
    x = m.view(m.get(v.id));
    if (Date.now() - last > 1000) { last = Date.now(); counts.push(state.active); }
    if (x.status === 'complete' || x.status === 'error') break;
    if (Date.now() - t0 > 120000) throw new Error('timeout');
  }
  const ms = Date.now() - t0;
  const ok = x.status === 'complete' && fs.statSync(path.join(x.saveDir, x.fileName)).size === SIZE;
  await m.shutdown();
  return { ms, ok, peak: state.peak, counts, err: x.error };
}

test('server that gets worse with many connections: auto-tune settles near the sweet spot and beats a fixed 32 by a wide margin', async () => {
  state.model = 'congested';
  const auto = await run('auto', { turbo: true, turboConnections: 32 });
  const fixed = await run('fixed', { turbo: true, turboConnections: 32, autoTune: false });
  console.log(`      18 MB, congested server (best at 6-8 connections):  auto-tune ${auto.ms} ms (server saw ${auto.counts.join(',')} connections each second) | fixed 32 ${fixed.ms} ms`);
  assert.ok(auto.ok && fixed.ok, JSON.stringify([auto.err, fixed.err]));
  assert.ok(auto.ms < fixed.ms * 0.65, `auto-tune (${auto.ms}) must be much faster than fixed 32 (${fixed.ms})`);
});

test('server that limits every connection: auto-tune keeps adding connections and is far faster than a modest fixed count', async () => {
  state.model = 'perconn';
  const auto = await run('auto2', { turbo: true, turboConnections: 64 });
  const four = await run('fixed4', { autoTune: false, maxConnections: 4, rampMs: 300 });
  console.log(`      18 MB, 256 KB/s per connection:  auto-tune ${auto.ms} ms (peak ${auto.peak} connections) | fixed 4 ${four.ms} ms`);
  assert.ok(auto.ok && four.ok);
  assert.ok(auto.peak >= 24, 'it climbed: ' + auto.peak);
  assert.ok(auto.ms < four.ms * 0.4, `auto-tune ${auto.ms} vs fixed 4: ${four.ms}`);
});
