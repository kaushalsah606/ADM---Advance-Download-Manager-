'use strict';
// Builds the native Windows app and assembles release/:
//   AdvanceDownloadManager-<v>-win-x64-Setup.exe     installer (native window host + engine)
//   AdvanceDownloadManager-<v>-win-x64-portable.zip  same files, no installer
//   adm-selfsigned.cer (self-signed builds only), SHA256SUMS.txt
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const noSign = process.argv.includes('--no-sign');
const node = (script, ...a) => execFileSync(process.execPath, [path.join(__dirname, script), ...a], { stdio: 'inherit' });
const retry = (what, fn) => { // antivirus scanners briefly lock freshly written files
  for (let attempt = 1; ; attempt++) {
    try { return fn(); } catch (e) { if (attempt >= 5) throw e; console.log(`${what} failed, retrying in 5 s`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000); }
  }
};
const sign = file => { if (!noSign) retry('signing', () => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'sign.ps1'), '-File', file], { stdio: 'inherit' })); };

// 1) native window host (C#), 2) engine (Node single-executable), 3) stage the app folder
node('build-host.js');
node('build-exe.js', ...process.argv.slice(2));
node('build-extensions.js');
node('fetch-tools.js'); // yt-dlp + FFmpeg ship inside the app: no setup for video downloads
const app = path.join(root, 'build', 'app');
fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(app, { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'build', 'host'))) fs.copyFileSync(path.join(root, 'build', 'host', f), path.join(app, f));
fs.copyFileSync(path.join(root, 'build', 'adm-engine.exe'), path.join(app, 'adm-engine.exe'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(app, 'LICENSE'));
fs.cpSync(path.join(root, 'dist'), path.join(app, 'browser-extension'), { recursive: true });
fs.cpSync(path.join(root, 'build', 'tools'), path.join(app, 'tools'), { recursive: true });
sign(path.join(app, 'AdvanceDownloadManager.exe'));

const out = process.env.ADM_RELEASE_DIR ? path.resolve(process.env.ADM_RELEASE_DIR) : path.join(root, 'release');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);

// installer (Inno Setup; install with: winget install JRSoftware.InnoSetup)
const iscc = [process.env.ISCC, path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'), path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe')].find(p => p && fs.existsSync(p));
if (!iscc) throw new Error('Inno Setup not found (winget install JRSoftware.InnoSetup, or set ISCC)');
retry('installer build', () => execFileSync(iscc, ['/Q', '/DAppVersion=' + pkg.version, '/DAppDir=' + app, '/DOutDir=' + out, path.join(root, 'installer', 'adm.iss')], { stdio: 'inherit' }));
sign(path.join(out, `AdvanceDownloadManager-${pkg.version}-win-x64-Setup.exe`));

// portable zip
const zip = path.join(out, `AdvanceDownloadManager-${pkg.version}-win-x64-portable.zip`);
retry('zip', () => require('./zipwrite').zipDirectory(app, zip));

// browser-store packages (for publishing the extension)
const storeDir = path.join(root, 'dist', 'store');
if (fs.existsSync(storeDir)) for (const f of fs.readdirSync(storeDir)) fs.copyFileSync(path.join(storeDir, f), path.join(out, f));

const cer = path.join(root, 'build', 'cert', 'adm-selfsigned.cer');
if (fs.existsSync(cer)) fs.copyFileSync(cer, path.join(out, 'adm-selfsigned.cer'));
const sums = fs.readdirSync(out).map(f => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(out, f))).digest('hex')}  ${f}`);
fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log(sums.join('\n'));
