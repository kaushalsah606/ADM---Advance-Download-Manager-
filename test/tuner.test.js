'use strict';
// The connection tuner against simulated servers (no network, simulated clock).
const test = require('node:test');
const assert = require('node:assert');
const { Tuner } = require('../src/tuner');

/** Runs the tuner for `seconds` of simulated time against speed(n) (bytes/s with n connections). Real servers need about a second to
 *  ramp up after the count changes, which is simulated too. Returns { n, avg, trace }. */
function simulate(tuner, speedOf, seconds, { noise = 0, rampMs = 1000, seed = 1 } = {}) {
  let t = 0, bytes = 0, cur = 0, lastN = tuner.n, changeAt = 0, startSpeed = 0, total = 0, rnd = seed;
  const rand = () => { rnd = (rnd * 1664525 + 1013904223) >>> 0; return rnd / 4294967296; };
  const trace = [];
  for (; t < seconds * 1000; t += 50) {
    const n = tuner.update(t, bytes);
    if (n !== lastN) { trace.push([Math.round(t / 100) / 10, n]); startSpeed = cur; lastN = n; changeAt = t; }
    const target = speedOf(n, t);
    const k = Math.min(1, (t - changeAt) / rampMs);
    cur = startSpeed + (target - startSpeed) * k;
    const jitter = noise ? 1 + (rand() * 2 - 1) * noise : 1;
    bytes += cur * jitter * 0.05; total += cur * jitter * 0.05;
  }
  return { n: tuner.n, avg: total / seconds, trace };
}
const MB = 1048576;

test('a server that limits each connection: the count keeps doubling up to the maximum, quickly', () => {
  const t = new Tuner({ start: 4, max: 64 });
  const r = simulate(t, n => n * 0.25 * MB, 40);
  assert.strictEqual(r.n, 64);
  assert.ok(r.trace.some(([, n]) => n === 32), 'went through 32');
  const top = r.trace.find(([, n]) => n === 64);
  assert.ok(top && top[0] < 7, 'reached the top within 7 s: ' + JSON.stringify(r.trace));
  assert.ok(r.avg > 0.8 * 64 * 0.25 * MB * 0.6, 'average ' + (r.avg / MB).toFixed(1));
});

test('a line that is full at 8 MB/s: it stops growing once more connections add nothing, instead of running to the maximum', () => {
  const t = new Tuner({ start: 4, max: 64 });
  const r = simulate(t, n => Math.min(n * 1 * MB, 8 * MB), 60);
  assert.ok(r.n >= 8 && r.n <= 16, 'settled at ' + r.n + ' ' + JSON.stringify(r.trace));
  assert.ok(r.avg > 6.5 * MB, 'average ' + (r.avg / MB).toFixed(1));
});

test('a server like tele2 (best at 8, worse at 12+): it finds the sweet spot and does not go beyond', () => {
  const curve = { 1: 0.2, 2: 0.4, 3: 0.6, 4: 0.8, 6: 3.7, 8: 3.8, 12: 2.3, 16: 1.6, 24: 1.0, 32: 0.6, 64: 0.3 };
  const speedOf = n => { const ks = Object.keys(curve).map(Number).sort((a, b) => a - b); let lo = ks[0], hi = ks[ks.length - 1]; for (const k of ks) { if (k <= n) lo = k; if (k >= n) { hi = k; break; } } return (lo === hi ? curve[lo] : curve[lo] + (curve[hi] - curve[lo]) * (n - lo) / (hi - lo)) * MB; };
  const t = new Tuner({ start: 4, max: 64 });
  const r = simulate(t, speedOf, 90);
  assert.ok(r.n >= 6 && r.n <= 9, 'settled at ' + r.n + ' ' + JSON.stringify(r.trace.slice(0, 12)));
  assert.ok(r.avg > 2.9 * MB, 'average ' + (r.avg / MB).toFixed(2) + ' MB/s (a fixed 32 would give 0.6)');
});

test('noisy speeds (+-6 %) do not make it run away or collapse', () => {
  const t = new Tuner({ start: 4, max: 32 });
  const r = simulate(t, n => Math.min(n * 0.5 * MB, 6 * MB), 80, { noise: 0.06, seed: 7 });
  assert.ok(r.n >= 8 && r.n <= 24, 'settled at ' + r.n + ' ' + JSON.stringify(r.trace));
  assert.ok(r.avg > 4.5 * MB, 'average ' + (r.avg / MB).toFixed(1));
});

test('conditions change while downloading: it notices when more connections start to help again', () => {
  const t = new Tuner({ start: 4, max: 32, holdMs: 8000 });
  const r = simulate(t, (n, time) => Math.min(n * 0.5 * MB, time < 30000 ? 3 * MB : 12 * MB), 90); // the line gets faster after 30 s
  const at30 = r.trace.filter(([sec]) => sec <= 30).pop();
  assert.ok(at30 && at30[1] <= 8, 'settled low first: ' + JSON.stringify(r.trace));
  assert.ok(r.n >= 16, 'later grew to ' + r.n + ' ' + JSON.stringify(r.trace));
});

const TELE2 = { 1: 0.2, 2: 0.4, 3: 0.6, 4: 0.8, 6: 3.7, 8: 3.8, 12: 2.3, 16: 1.6, 24: 1.0, 32: 0.6, 64: 0.3 };
const curve = c => n => { const ks = Object.keys(c).map(Number).sort((a, b) => a - b); let lo = ks[0], hi = ks[ks.length - 1]; for (const k of ks) { if (k <= n) lo = k; if (k >= n) { hi = k; break; } } return (lo === hi ? c[lo] : c[lo] + (c[hi] - c[lo]) * (n - lo) / (hi - lo)) * MB; };

test('a start count that is too HIGH is corrected downwards (Turbo starts at 16, this server is best at 8)', () => {
  const t = new Tuner({ start: 16, max: 64 });
  const r = simulate(t, curve(TELE2), 60);
  assert.ok(r.n >= 6 && r.n <= 10, 'settled at ' + r.n + ' ' + JSON.stringify(r.trace));
  assert.ok(r.avg > 2.6 * MB, 'average ' + (r.avg / MB).toFixed(2) + ' MB/s (staying at 16 would give 1.6)');
});

test('on a full line it settles at the knee (the fewest connections that still give the full speed), not at the maximum', () => {
  const t = new Tuner({ start: 16, max: 32 });
  const r = simulate(t, n => Math.min(n * 1 * MB, 8 * MB), 60);
  assert.ok(r.n >= 8 && r.n <= 11, 'settled at ' + r.n + ' ' + JSON.stringify(r.trace));
  assert.ok(r.avg > 7 * MB, 'average ' + (r.avg / MB).toFixed(1));
});

test('when the speed collapses during the download (the server starts throttling) it tries fewer connections', () => {
  const t = new Tuner({ start: 8, max: 32 });
  // up to 25 s: 8 connections give 8 MB/s; afterwards the server punishes more than 5 connections
  const r = simulate(t, (n, time) => time < 25000 ? Math.min(n * 1 * MB, 8 * MB) : n <= 5 ? n * 0.8 * MB : 1.2 * MB, 80);
  assert.ok(r.n <= 6, 'ended at ' + r.n + ' ' + JSON.stringify(r.trace));
});

test('limits: the start count is capped by the maximum, setMax lowers the count at once, one connection stays one', () => {
  assert.strictEqual(new Tuner({ start: 8, max: 3 }).n, 3);
  const one = new Tuner({ start: 1, max: 1 });
  simulate(one, n => n * MB, 30);
  assert.strictEqual(one.n, 1);
  const t = new Tuner({ start: 4, max: 32 });
  simulate(t, n => n * 0.3 * MB, 20);
  assert.ok(t.n > 8);
  t.setMax(6);
  assert.ok(t.n <= 6 && t.max === 6);
});

test('a stalled server (no data at all) does not make it open more and more connections', () => {
  const t = new Tuner({ start: 4, max: 64 });
  const r = simulate(t, () => 0, 60);
  assert.ok(r.n <= 8, 'ended at ' + r.n);
});
