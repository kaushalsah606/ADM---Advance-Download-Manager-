'use strict';
// Download-engine policy numbers: how many connections a download uses and how fast they are opened.

module.exports = {
  /** Bytes compared on a resume and at segment boundaries to detect corrupted data: a request starts this many bytes
   *  early and the overlapping bytes must match what is already on disk. */
  OVERLAP: 64,

  /** Normal mode: one connection per this many *remaining* bytes. */
  BYTES_PER_CONNECTION: 10240,

  /** Turbo mode: one connection per this many remaining bytes. */
  TURBO_BYTES_PER_CONNECTION: 4096,

  /** Absolute connection ceiling in normal mode. */
  HARD_MAX_CONNECTIONS: 32,

  /** Absolute connection ceiling in Turbo mode. */
  TURBO_MAX_CONNECTIONS: 64,

  /** Normal mode: more connections are opened at most this often (the user setting `rampMs` overrides it). */
  RAMP_MS: 2000,

  /** Turbo mode: minimum time between connection bursts. */
  TURBO_RAMP_MS: 100,

  /** Normal mode: more connections are opened only while the current speed is below this fraction of the limiter speed. */
  LINK_SPEED_FRACTION: 0.85,

  /** Minimum scheduler retry delay. */
  MIN_RETRY_MS: 30000,

  /** Number of connections for a download. */
  connectionsFor(remaining, configuredMax, turbo = false) {
    const ceiling = turbo ? this.TURBO_MAX_CONNECTIONS : this.HARD_MAX_CONNECTIONS;
    const per = turbo ? this.TURBO_BYTES_PER_CONNECTION : this.BYTES_PER_CONNECTION;
    const max = Math.max(1, Math.min(configuredMax | 0 || 1, ceiling));
    if (remaining <= (turbo ? per : 0x2800)) return 1;
    return Math.max(1, Math.min(Math.floor(remaining / per), max));
  },

  /** Next connection count when ramping up: doubles; the "gentle" mode uses 2->3, 4->6, 6->8. */
  nextConnections(n, gentle = false) {
    if (gentle) { if (n === 2) return 3; if (n === 4) return 6; if (n === 6) return 8; }
    return Math.max(1, n * 2);
  },
};
