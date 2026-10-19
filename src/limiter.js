'use strict';
const { sleep } = require('./util');

/** Global bandwidth limiter: speed cap (bytes/s) plus a quota ("40MB per hour"). */
class Limiter {
  constructor() {
    this.rate = 0;
    this.tokens = 0;
    this.last = Date.now();
    this.quota = null; // { bytes, windowMs }
    this.winStart = Date.now();
    this.used = 0;
    this.waitingUntil = 0;
  }

  configure({ speedLimit = 0, quota = null }) {
    this.rate = Math.max(0, speedLimit | 0);
    this.quota = quota && quota.enabled && quota.bytes > 0 ? { bytes: quota.bytes, windowMs: quota.windowMs } : null;
    this.tokens = 0;
    this.last = Date.now();
  }

  async take(n, signal) {
    if (this.quota) {
      const now = Date.now();
      if (now - this.winStart >= this.quota.windowMs) { this.winStart = now; this.used = 0; }
      if (this.used >= this.quota.bytes) {
        this.waitingUntil = this.winStart + this.quota.windowMs;
        await sleep(Math.max(0, this.waitingUntil - now), signal);
        this.winStart = Date.now(); this.used = 0; this.waitingUntil = 0;
      }
      this.used += n;
    }
    if (this.rate > 0) {
      const now = Date.now();
      this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
      this.last = now;
      this.tokens -= n;
      if (this.tokens < 0) await sleep((-this.tokens / this.rate) * 1000, signal);
    }
  }
}

module.exports = { Limiter };
