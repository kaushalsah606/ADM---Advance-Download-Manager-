'use strict';
// Windows-only. Runs the app's real OS command paths:
//   * "shut down when done"  -> starts a real `shutdown /s /t 60`, checks Windows reports it as pending, cancels it at once
//   * Cancel (shutdown /a)   -> checks Windows reports nothing pending afterwards
//   * "hang up when done"    -> `rasdial /disconnect` runs
//   * Dial Up / VPN          -> rasdial with a missing entry gives a clear error after the configured redial attempts
// A safety `shutdown /a` runs before and after everything, so the machine is never left with a pending shutdown.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Manager } = require('../src/manager');

if (process.platform !== 'win32') { console.log('skipped (Windows only)'); process.exit(0); }
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
const abort = () => spawnSync('shutdown', ['/a'], { windowsHide: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-os-'));

(async () => {
  abort();
  try {
    const m = new Manager({ dataDir: tmp }).load();
    let pending;
    m.on('shutdown-pending', p => { pending = p; });
    m._queueDone({ name: 'test queue', onDone: { shutdown: true } });
    await sleep(1500);
    check('app announced the 60 s shutdown countdown', pending && pending.seconds === 60);
    const r1 = abort();   // exit code 0 => Windows had a pending shutdown, and it is now cancelled
    check('Windows really had a shutdown pending (started by the app)', r1.status === 0, 'shutdown /a exit ' + r1.status);

    m._queueDone({ name: 'test queue', onDone: { shutdown: true } });
    await sleep(1500);
    m.cancelShutdown();                     // the app's own Cancel button path
    await sleep(1500);
    const r2 = abort();                     // 1116 => nothing pending => the app's cancel worked
    check('app\'s Cancel (shutdown /a) removed the pending shutdown', r2.status !== 0, 'shutdown /a exit ' + r2.status + ' (1116 = none pending)');

    const rd = spawnSync('rasdial', ['/disconnect'], { windowsHide: true, encoding: 'utf8' });
    check('hang-up command (rasdial /disconnect) is present and runs', rd.error === undefined, (rd.stdout || '').trim().split(/\r?\n/).pop());
    m._queueDone({ name: 'hangup test', onDone: { hangup: true } });

    m.setSettings({ dialup: { entry: 'ADM-NoSuchConnection', user: '', pass: '', redialAttempts: 2, redialSeconds: 1 } });
    const attempts = [];
    m.on('dial', a => attempts.push(a.attempt));
    let err;
    try { await m.dialUp(); } catch (e) { err = e; }
    check('dial-up with a missing entry redials and reports a clear error', !!err && attempts.length === 2 && /ADM-NoSuchConnection/.test(err.message), err && err.message);
    await m.shutdown();
  } catch (e) {
    check('test run', false, e.message);
  } finally {
    abort();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
  }
})();
