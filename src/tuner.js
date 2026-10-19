'use strict';
// Closed-loop tuning of the number of parallel connections.
//
// More connections only help while the server (or the line) hands out more data for each one. Beyond that point they add nothing, and
// on many servers they make things slower or get the client blocked. Instead of a fixed number the tuner climbs by measurement:
//   1. it starts with a sensible count and measures the speed,
//   2. it tries MORE connections (x2): kept only if the speed really improved (minGain), otherwise it goes back,
//   3. it then tries FEWER (x0.67): kept if the speed stays about the same (it prefers the smallest count that gives the full speed),
//      and keeps going down while that holds, so a start count that was too high is corrected as well,
//   4. it holds the best count and tests one step MORE from time to time (less and less often when nothing changes), and right away when the speed
//      jumps up (a faster line) - or one step FEWER when the speed collapses (the server started throttling).
// update(now, bytes) is fed the cumulative bytes received and returns the connection count to use. It has no timers: the caller calls it every
// few tens of milliseconds, which also makes it easy to test with a simulated clock.
class Tuner {
  constructor({ start = 8, max = 16, min = 1, minGain = 0.15, keepDown = 0.92, settleMs = 600, measureMs = 900, firstMeasureMs = 450, holdMs = 15000, growth = 2, earlyMs = 450, earlyGain = 1.4 } = {}) {
    Object.assign(this, { minGain, keepDown, settleMs, measureMs, firstMeasureMs, holdMs, growth, earlyMs, earlyGain });
    this.max = Math.max(1, max | 0); this.min = Math.max(1, Math.min(min | 0 || 1, this.max));
    this.n = Math.max(this.min, Math.min(start | 0 || 1, this.max));
    this.best = this.n;
    this.prev = null;      // best speed seen (bytes/s) at the best count
    this.phase = 'settle'; // settle -> measure -> probe(settle -> measure)* -> hold -> probe ...
    this.since = null;
    this.mStart = null;
    this.probing = false;
    this.dir = 'up';
    this.triedDown = false;
    this.holdCur = this.holdMs; // time until the next test: doubles (up to a minute) every time a test finds nothing better
    this.samples = [];
    this.history = [];     // [{ at, n, dir, speed, kept }] for diagnostics
  }

  setMax(max) {
    this.max = Math.max(1, max | 0);
    if (this.min > this.max) this.min = this.max;
    if (this.n > this.max) { this.n = this.best = this.max; this.probing = false; this.phase = 'settle'; this.since = null; this.prev = null; }
    if (this.best > this.max) this.best = this.max;
  }

  /** Speed over the last `ms` milliseconds (bytes per second). */
  _recent(now, ms) {
    const s = this.samples; if (s.length < 2) return 0;
    let i = s.length - 1;
    while (i > 0 && now - s[i - 1].t <= ms) i--;
    const a = s[i], b = s[s.length - 1];
    return b.t > a.t ? (b.b - a.b) / ((b.t - a.t) / 1000) : 0;
  }

  update(now, bytes) {
    this.samples.push({ t: now, b: bytes });
    while (this.samples.length > 2 && now - this.samples[0].t > 12000) this.samples.shift();
    if (this.since === null) this.since = now;
    const el = now - this.since;
    if (this.phase === 'settle') {
      if (el >= this.settleMs) { this.phase = 'measure'; this.since = now; this.mStart = { t: now, b: bytes }; }
    } else if (this.phase === 'measure') {
      const secs = (now - this.mStart.t) / 1000;
      const speed = secs > 0 ? (bytes - this.mStart.b) / secs : 0;
      // an obvious improvement does not need the full measuring time (keeps the ramp-up fast on servers that limit every connection)
      const early = this.probing && this.dir === 'up' && this.prev && el >= this.earlyMs && speed >= this.prev * this.earlyGain;
      if (el >= (this.probing ? this.measureMs : this.firstMeasureMs) || early) this._decide(now, speed);
    } else if (this.phase === 'hold') {
      const recent = this._recent(now, 1000);
      if (el >= 3000 && this.prev && recent > this.prev * 1.3 && this.n < this.max) { this.prev = recent; this.holdCur = this.holdMs; this._probe(now, 'up', true); } // faster than before: more connections may use it
      else if (el >= 3000 && this.prev && recent > 0 && recent < this.prev * 0.6 && this.n > this.min) { this.prev = recent; this._probe(now, 'down', true); } // much slower: would fewer be better?
      else if (el >= this.holdCur) { this.prev = this._recent(now, this.measureMs) || this.prev; this._probe(now, 'up', true); }
    }
    return this.n;
  }

  _decide(now, speed) {
    if (!this.probing) { // first measurement at the starting count
      this.prev = speed; this.best = this.n;
      return this._probe(now, 'up', false);
    }
    const up = this.dir === 'up';
    const kept = up ? speed > 0 && speed >= (this.prev || 0) * (1 + this.minGain) // more connections must really pay off
      : speed > 0 && speed >= (this.prev || 0) * this.keepDown;                    // fewer: fine as long as the speed stays about the same
    this.history.push({ at: now, n: this.n, dir: this.dir, speed, kept });
    if (kept) { this.prev = Math.max(this.prev || 0, speed); this.best = this.n; this.probing = false; this.holdCur = this.holdMs; return this._probe(now, this.dir, false); }
    if (up && !this.triedDown && this.best > this.min) { this.triedDown = true; this.n = this.best; return this._probe(now, 'down', false); } // more did not help: is fewer as good?
    this.holdCur = Math.min(this.holdCur * 2, 60000);
    this._hold(now); // back to the best count
  }

  _probe(now, dir, periodic) {
    const base = this.best;
    let next;
    if (dir === 'up') next = Math.min(this.max, periodic ? Math.max(base + 1, Math.ceil(base * 1.5)) : Math.max(base + 1, Math.round(base * this.growth)));
    else next = Math.max(this.min, Math.min(base - 1, Math.floor(base * 0.67)));
    if (dir === 'up' && next <= base && !periodic && !this.triedDown && base > this.min) { // the climb ended at the maximum: the first readings were taken during slow start, so check that fewer is not just as fast
      this.triedDown = true;
      return this._probe(now, 'down', false);
    }
    if (next === base || (dir === 'up' && next <= base) || (dir === 'down' && next >= base)) return this._hold(now);
    this.n = next; this.dir = dir; this.probing = true; this.phase = 'settle'; this.since = now;
  }

  _hold(now) { this.n = this.best; this.probing = false; this.phase = 'hold'; this.since = now; }
}

module.exports = { Tuner };
