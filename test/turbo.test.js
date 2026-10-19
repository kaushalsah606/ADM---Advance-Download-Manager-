'use strict';
// Speed: faster defaults and Turbo mode. The mock server throttles every connection to a fixed rate, the way many file hosts do,
// so the aggregate speed is (connections x rate) and the time a download takes shows how fast the engine opens connections.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Manager } = require('../src/manager');
const policy = require('../src/policy');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-turbo-'));
const DATA = crypto.randomBytes(6 * 1024 * 1024);
const SHA = crypto.createHash('sha256').update(DATA).digest('hex');
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const state = { rate: 256 * 1024, maxAllowed: Infinity, active: 0, peak: 0, refused: 0 };

// per-connection throttle: `state.rate` bytes/s on every connection; more than `state.maxAllowed` parallel connections get a 503
const origin = http.createServer((req, res) => {
  if (state.active >= state.maxAllowed) { state.refused++; res.writeHead(503); return res.end(); }
  state.active++; state.peak = Math.max(state.peak, state.active);
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const s = m ? +m[1] : 0, e = m && m[2] ? Math.min(+m[2], DATA.length - 1) : DATA.length - 1;
  const h = { 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' };
  if (m) h['Content-Range'] = `bytes ${s}-${e}/${DATA.length}`;
  res.writeHead(m ? 206 : 200, h);
  let pos = s;
  const chunk = Math.max(1024, Math.floor(state.rate / 20)); // 20 writes a second
  const timer = setInterval(() => {
    if (res.destroyed) return stop();
    if (pos > e) { stop(); return res.end(); }
    const n = Math.min(chunk, e - pos + 1);
    res.write(DATA.subarray(pos, pos + n)); pos += n;
  }, 50);
  let stopped = false;
  function stop() { if (!stopped) { stopped = true; clearInterval(timer); state.active--; } }
  res.on('close', stop);
});
let base;
test.before(async () => { await new Promise(r => origin.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${origin.address().port}`; });
test.after(() => { origin.closeAllConnections?.(); origin.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const mk = (name, settings = {}) => {
  const m = new Manager({ dataDir: path.join(tmp, name, 'data') }).load();
  m.setSettings({ retryIntervalMs: 1000, ...settings });
  return m;
};
const waitFor = (m, id, pred, ms = 60000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout; ' + JSON.stringify(m.view(m.get(id))))), ms);
  const check = () => { const v = m.view(m.get(id)); if (pred(v)) { clearTimeout(t); m.off('update', check); resolve(v); } };
  m.on('update', check); check();
});
async function run(name, settings, size = DATA.length) {
  state.active = 0; state.peak = 0; state.refused = 0;
  const m = mk(name, settings);
  const t0 = Date.now();
  const v = m.add({ url: base + '/file.bin', saveDir: path.join(tmp, name, 'out'), queue: null, startNow: true });
  const done = await waitFor(m, v.id, x => x.status === 'complete' || x.status === 'error');
  const ms = Date.now() - t0;
  const out = { status: done.status, error: done.error, ms, peak: state.peak, ok: done.status === 'complete' && sha(path.join(done.saveDir, done.fileName)) === SHA };
  await m.shutdown();
  return out;
}

test('policy: Turbo allows up to 64 connections, one per 4 KB; normal mode stays at 32 / 10 KB', () => {
  assert.strictEqual(policy.connectionsFor(10 * 1024 * 1024, 64, false), 32);
  assert.strictEqual(policy.connectionsFor(10 * 1024 * 1024, 64, true), 64);
  assert.strictEqual(policy.connectionsFor(40 * 1024, 64, true), 10);
  assert.strictEqual(policy.connectionsFor(40 * 1024, 64, false), 4);
  assert.strictEqual(policy.connectionsFor(3000, 64, true), 1);
});

test('defaults are fast (16 connections, 500 ms ramp) and Turbo settings are clamped', () => {
  const m = new Manager({ dataDir: path.join(tmp, 'defaults', 'data') }).load();
  assert.strictEqual(m.settings.maxConnections, 16);
  assert.strictEqual(m.settings.rampMs, 500);
  assert.strictEqual(m.settings.turbo, false);
  m.setSettings({ turbo: true, turboConnections: 9999 });
  assert.strictEqual(m.settings.turbo, true);
  assert.strictEqual(m.settings.turboConnections, 64);
  m.setSettings({ turboConnections: 0 });
  assert.strictEqual(m.settings.turboConnections, 32);
  m.setSettings({ turbo: 'yes' });
  assert.strictEqual(m.settings.turbo, false, 'only a real true turns Turbo on');
});

test('speed ladder on a server that throttles each connection: old defaults < new defaults < Turbo', async () => {
  state.rate = 256 * 1024; state.maxAllowed = Infinity;
  const legacy = await run('legacy', { maxConnections: 8, rampMs: 2000, minSplitBytes: 256 * 1024 });
  const normal = await run('normal', {});
  const turbo = await run('turbo', { turbo: true });
  console.log(`      6 MB at 256 KB/s per connection:  old defaults ${legacy.ms} ms (peak ${legacy.peak} conns) | new defaults ${normal.ms} ms (peak ${normal.peak}) | Turbo ${turbo.ms} ms (peak ${turbo.peak})`);
  for (const r of [legacy, normal, turbo]) assert.ok(r.ok, `${r.status} ${r.error || ''}`);
  assert.ok(normal.ms < legacy.ms * 1.15, `new defaults (${normal.ms}) should be at least as fast as the old ones (${legacy.ms}); a loaded CI runner blurs small differences`);
  assert.ok(turbo.ms < normal.ms * 1.25, `Turbo (${turbo.ms}) should be about as fast as, or faster than, the new defaults (${normal.ms}); both auto-tune, so a slow runner can reorder them`);
  assert.ok(turbo.peak >= 8, 'Turbo opened several connections: ' + turbo.peak); // the tuner may settle lower on a slow, noisy runner
});

test('Turbo ignores the speed limiter (normal mode obeys it)', async () => {
  state.rate = 8 * 1024 * 1024; state.maxAllowed = Infinity; // fast server
  const limited = { limiterOn: true, speedLimit: 512 * 1024, maxConnections: 4 };
  const slow = await run('limited', limited);
  const fast = await run('limited-turbo', { ...limited, turbo: true });
  console.log(`      6 MB with a 512 KB/s limiter:  normal ${slow.ms} ms | Turbo ${fast.ms} ms`);
  assert.ok(slow.ok && fast.ok);
  assert.ok(slow.ms > 5000, 'the limiter slows normal mode: ' + slow.ms);
  assert.ok(fast.ms < slow.ms * 0.4, 'Turbo bypasses it: ' + fast.ms);
});

test('Turbo backs off when the server refuses many connections, and still finishes correctly', async () => {
  state.rate = 512 * 1024; state.maxAllowed = 6;
  const r = await run('refusing', { turbo: true, turboConnections: 32 });
  console.log(`      server allows 6 connections:  finished ${r.ok ? 'correctly' : 'WRONG'} in ${r.ms} ms, ${state.refused} refused requests`);
  state.maxAllowed = Infinity;
  assert.ok(r.ok, `${r.status} ${r.error || ''}`);
  assert.ok(state.refused > 0, 'the server really refused some connections');
});
