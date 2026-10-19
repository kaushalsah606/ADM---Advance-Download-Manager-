'use strict';
// "Capture all HTTP downloads on this PC" (Windows): points the per-user Windows proxy setting at a tiny proxy-auto-config script served by the engine
// (http://127.0.0.1:<port>/capture.pac). The script sends only plain http:// traffic to the local capture proxy and ends every answer with
// "; DIRECT", and when the engine is not running the script cannot be fetched at all - so if the app crashes or is killed, the internet keeps working.
// The previous setting is saved in <dataDir>/proxy-backup.json and restored on exit, on switching off and at the next start after a crash.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const VALUE = 'AutoConfigURL';

function reg(args) { return spawnSync('reg', args, { windowsHide: true, encoding: 'utf8' }); }

function readCurrent() {
  const r = reg(['query', KEY, '/v', VALUE]);
  if (r.status !== 0) return null; // value not set
  const m = /AutoConfigURL\s+REG_SZ\s+(.*)\r?$/m.exec(r.stdout || '');
  return m ? m[1].trim() : '';
}

/** Tell WinINET clients (browsers, most apps) that proxy settings changed. */
function refresh() {
  const ps = "Add-Type -MemberDefinition '[DllImport(\"wininet.dll\")] public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);' -Name W -Namespace ADMNet; " +
    '[ADMNet.W]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0) | Out-Null; [ADMNet.W]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0) | Out-Null';
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, timeout: 15000 });
}

const backupFile = dataDir => path.join(dataDir, 'proxy-backup.json');

function pacScript(proxyPort) {
  return 'function FindProxyForURL(url, host) {\n' +
    "  if (url.substring(0, 5) !== 'http:') return 'DIRECT';\n" +
    "  if (isPlainHostName(host) || host === '127.0.0.1' || host === 'localhost' || shExpMatch(host, '*.local')) return 'DIRECT';\n" +
    "  if (isInNet(host, '10.0.0.0', '255.0.0.0') || isInNet(host, '172.16.0.0', '255.240.0.0') || isInNet(host, '192.168.0.0', '255.255.0.0')) return 'DIRECT';\n" +
    `  return 'PROXY 127.0.0.1:${proxyPort}; DIRECT';\n}\n`;
}

/** Point Windows at our script. Returns true on success. */
function enable(dataDir, pacUrl) {
  if (process.platform !== 'win32') return false;
  const file = backupFile(dataDir);
  if (!fs.existsSync(file)) { // never overwrite an existing backup with our own value
    const prev = readCurrent();
    fs.writeFileSync(file, JSON.stringify({ had: prev !== null, value: prev || '', savedAt: new Date().toISOString() }));
  }
  const r = reg(['add', KEY, '/v', VALUE, '/t', 'REG_SZ', '/d', pacUrl, '/f']);
  if (r.status !== 0) return false;
  refresh();
  return true;
}

/** Restore the previous setting (if we changed it). Returns true if something was restored. */
function disable(dataDir) {
  if (process.platform !== 'win32') return false;
  const file = backupFile(dataDir);
  if (!fs.existsSync(file)) return false;
  let b;
  try { b = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { b = { had: false }; }
  const cur = readCurrent();
  // only undo our own change: if the user pointed the setting somewhere else meanwhile, leave it alone
  if (cur === null || /\/capture\.pac$/.test(cur)) {
    if (b.had && b.value) reg(['add', KEY, '/v', VALUE, '/t', 'REG_SZ', '/d', b.value, '/f']);
    else reg(['delete', KEY, '/v', VALUE, '/f']);
    refresh();
  }
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  return true;
}

function active() {
  if (process.platform !== 'win32') return false;
  const cur = readCurrent();
  return !!cur && /\/capture\.pac$/.test(cur);
}

module.exports = { enable, disable, active, pacScript, backupFile, KEY, VALUE, readCurrent };
