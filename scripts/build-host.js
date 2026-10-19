'use strict';
// Builds the native Windows host (host/Program.cs) with the C# compiler that ships with Windows (.NET Framework 4.x, no SDK needed)
// and copies the pinned Microsoft WebView2 libraries next to it:  build/host/
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const WV2 = { version: '1.0.2739.15', sha256: 'f13e5564de93c0d35064a6e3a65eb4fd501256cb394d00a52229eb4d446722db' };
const cache = path.join(root, '.cache');
const pkg = path.join(cache, `webview2-${WV2.version}.nupkg`);
const lib = path.join(cache, 'wv2-' + WV2.version);
const out = path.join(root, 'build', 'host');
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

async function main() {
  if (process.platform !== 'win32') throw new Error('The native host is Windows-only');
  fs.mkdirSync(cache, { recursive: true });
  if (!fs.existsSync(pkg) || sha(pkg) !== WV2.sha256) {
    const r = await fetch(`https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${WV2.version}/microsoft.web.webview2.${WV2.version}.nupkg`);
    if (!r.ok) throw new Error('Could not download the WebView2 package: HTTP ' + r.status);
    fs.writeFileSync(pkg, Buffer.from(await r.arrayBuffer()));
    if (sha(pkg) !== WV2.sha256) { fs.rmSync(pkg); throw new Error('WebView2 package checksum mismatch'); }
  }
  if (!fs.existsSync(path.join(lib, 'lib', 'net462', 'Microsoft.Web.WebView2.Core.dll'))) {
    fs.rmSync(lib, { recursive: true, force: true });
    fs.copyFileSync(pkg, pkg + '.zip');
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${pkg}.zip' -DestinationPath '${lib}' -Force`], { stdio: 'inherit' });
    fs.rmSync(pkg + '.zip');
  }
  const csc = [path.join(process.env.windir || 'C:\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')].find(p => fs.existsSync(p));
  if (!csc) throw new Error('csc.exe (.NET Framework 4) not found');

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const net = path.join(lib, 'lib', 'net462');
  execFileSync(csc, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/debug-', '/warn:4',
    '/out:' + path.join(out, 'AdvanceDownloadManager.exe'),
    '/win32icon:' + path.join(root, 'assets', 'icon.ico'), '/win32manifest:' + path.join(root, 'host', 'app.manifest'),
    '/r:System.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll',
    '/r:' + path.join(net, 'Microsoft.Web.WebView2.Core.dll'), '/r:' + path.join(net, 'Microsoft.Web.WebView2.WinForms.dll'),
    path.join(root, 'host', 'Program.cs')], { stdio: 'inherit' });
  for (const f of ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll']) fs.copyFileSync(path.join(net, f), path.join(out, f));
  fs.copyFileSync(path.join(lib, 'runtimes', 'win-x64', 'native', 'WebView2Loader.dll'), path.join(out, 'WebView2Loader.dll'));
  console.log('built native host ->', out);
}
main().catch(e => { console.error(e.message); process.exit(1); });
