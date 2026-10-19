'use strict';
// Where the app's bundled resources (public/, tray.ps1, extension/) live.
// From source: the repository. As a single-file executable (Node SEA): assets are unpacked once per version.
const fs = require('fs');
const os = require('os');
const path = require('path');

let sea = null;
try { sea = require('node:sea'); if (!sea.isSea()) sea = null; } catch { sea = null; }

const isPackaged = !!sea;

function resourceDir() {
  if (!sea) return path.join(__dirname, '..');
  const manifest = JSON.parse(sea.getAsset('manifest.json', 'utf8'));
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache');
  const runtime = path.join(base, 'Advance Download Manager', 'runtime');
  const dir = path.join(runtime, manifest.version + '-' + manifest.build);
  if (!fs.existsSync(path.join(dir, '.complete'))) {
    fs.rmSync(dir, { recursive: true, force: true }); // half-written earlier attempt
    // drop unpacked copies of other builds (best effort: another instance may still be using one)
    try { for (const d of fs.readdirSync(runtime)) if (d !== path.basename(dir)) { try { fs.rmSync(path.join(runtime, d), { recursive: true, force: true }); } catch { /* in use */ } } } catch { /* first run */ }
    for (const rel of manifest.files) {
      const dest = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(sea.getAsset(rel)));
    }
    fs.writeFileSync(path.join(dir, '.complete'), '');
  }
  return dir;
}

let cached;
const resource = (...p) => path.join(cached || (cached = resourceDir()), ...p);

module.exports = { isPackaged, resource };
