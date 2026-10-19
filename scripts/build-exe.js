'use strict';
// Builds build/AdvanceDownloadManager.exe  (Windows, Node >= 20 single-executable application).
//   1. bundle bin/ + src/ into one CommonJS file (no dependencies to bundle)
//   2. pack public/, tray.ps1 and extension/ as SEA assets
//   3. inject into a copy of node.exe (postject), set icon + version info (rcedit), switch to the GUI subsystem
//   4. Authenticode-sign (scripts/sign.ps1)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.join(root, 'build');
const pkg = require('../package.json');
const exe = path.join(out, 'adm-engine.exe');
const rel = p => p.split(path.sep).join('/');

for (const f of ['adm-engine.exe', 'bundle.js', 'manifest.json', 'sea-config.json', 'sea-prep.blob']) fs.rmSync(path.join(out, f), { force: true });
fs.mkdirSync(out, { recursive: true });

// ---- 1. bundle ----
const mods = new Map();
function add(file) {
  file = path.resolve(file);
  if (mods.has(file)) return file;
  mods.set(file, null);
  let src = fs.readFileSync(file, 'utf8').replace(/^#!.*\n/, '');
  const deps = {};
  for (const m of src.matchAll(/require\(\s*'(\.{1,2}\/[^']+)'\s*\)/g)) {
    let t = path.resolve(path.dirname(file), m[1]);
    if (!fs.existsSync(t)) t += '.js';
    deps[m[1]] = rel(path.relative(root, add(t)));
  }
  mods.set(file, { id: rel(path.relative(root, file)), src, deps });
  return file;
}
add(path.join(root, 'bin', 'advance-download-manager.js'));
let bundle = "'use strict';\nconst __defs = {};\nconst __cache = {};\nfunction __req(id) {\n  if (__cache[id]) return __cache[id].exports;\n  const d = __defs[id], m = (__cache[id] = { exports: {} });\n  d.fn(m, m.exports, spec => (d.deps[spec] ? __req(d.deps[spec]) : require(spec)));\n  return m.exports;\n}\n";
for (const m of mods.values()) {
  bundle += `__defs[${JSON.stringify(m.id)}] = { deps: ${JSON.stringify(m.deps)}, fn: function (module, exports, require) {\n${m.src}\n} };\n`;
}
bundle += "__req('bin/advance-download-manager.js');\n";
fs.writeFileSync(path.join(out, 'bundle.js'), bundle);
console.log(`bundled ${mods.size} modules`);

// ---- 2. assets ----
const files = [];
const assets = {};
function pack(dir, only) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const r = rel(path.join(dir, e.name));
    if (e.isDirectory()) pack(r, only);
    else if (!only || only(r)) { assets[r] = path.join(root, r); files.push(r); }
  }
}
pack('public');
pack('extension');
assets['assets/icon.ico'] = path.join(root, 'assets', 'icon.ico'); files.push('assets/icon.ico');
assets['src/tray.ps1'] = path.join(root, 'src', 'tray.ps1'); files.push('src/tray.ps1');
// the unpack folder is named after a hash of everything inside, so a rebuild can never reuse stale files
const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, 'bundle.js')));
for (const f of files) hash.update(f).update(fs.readFileSync(assets[f]));
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ version: pkg.version, build: hash.digest('hex').slice(0, 12), files }));
assets['manifest.json'] = path.join(out, 'manifest.json');
fs.writeFileSync(path.join(out, 'sea-config.json'), JSON.stringify({
  main: path.join(out, 'bundle.js'), output: path.join(out, 'sea-prep.blob'), disableExperimentalSEAWarning: true, assets,
}));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(out, 'sea-config.json')], { stdio: 'inherit' });

// ---- 3. inject ----
fs.copyFileSync(process.execPath, exe);
// drop node.exe's own Authenticode signature (injection invalidates it): clear the certificate-table directory entry and truncate
{
  const b = fs.readFileSync(exe), pe = b.readUInt32LE(0x3c), dir = pe + 24 + 112 + 4 * 8; // optional header (PE32+), data dir #4
  const off = b.readUInt32LE(dir), size = b.readUInt32LE(dir + 4);
  if (off && size && off + size === b.length) { b.writeUInt32LE(0, dir); b.writeUInt32LE(0, dir + 4); fs.writeFileSync(exe, b.subarray(0, off)); }
}
(async () => {
  const rcedit = require('rcedit');
  const v = pkg.version;
  await (rcedit.rcedit || rcedit)(exe, {
    icon: path.join(root, 'assets', 'icon.ico'),
    'version-string': {
      ProductName: 'Advance Download Manager', FileDescription: 'Advance Download Manager engine', CompanyName: '@kaushalsah606',
      LegalCopyright: 'MIT License - Copyright (c) 2026 @kaushalsah606', OriginalFilename: 'adm-engine.exe', InternalName: 'adm-engine',
    },
    'file-version': v, 'product-version': v,
  });
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'), exe, 'NODE_SEA_BLOB', path.join(out, 'sea-prep.blob'),
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'inherit' });
  // GUI subsystem (2): no console window flashes up when the tray app starts.
  const buf = fs.readFileSync(exe);
  const pe = buf.readUInt32LE(0x3c);
  buf.writeUInt16LE(2, pe + 24 + 68);
  fs.writeFileSync(exe, buf);
  console.log('built', exe, (buf.length / 1048576).toFixed(1) + ' MB');

  // ---- 4. sign ----
  if (!process.argv.includes('--no-sign')) {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'sign.ps1'), '-File', exe], { stdio: 'inherit' });
  }
})().catch(e => { console.error(e); process.exit(1); });
