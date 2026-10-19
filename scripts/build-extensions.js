'use strict';
// Assembles ready-to-load extension folders:  dist/chrome  (Chrome, Edge, Brave, Opera)  and  dist/firefox
//   Chrome:  chrome://extensions -> Developer mode -> Load unpacked -> dist/chrome
//   Firefox: about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> dist/firefox/manifest.json
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'extension');
const files = ['background.js', 'video-button.js', 'popup.html', 'popup.js', 'options.html', 'options.js', 'ui.css'];

for (const [target, manifest] of [['chrome', 'manifest.json'], ['firefox', 'manifest.firefox.json']]) {
  const out = path.join(__dirname, '..', 'dist', target);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(src, f), path.join(out, f));
  fs.cpSync(path.join(src, 'icons'), path.join(out, 'icons'), { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(src, manifest), 'utf8'));
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  console.log(`built dist/${target}  (${m.name} ${m.version})`);
}

// ready-to-upload packages for the browser stores (manifest.json at the root of the zip, forward-slash paths)
{
  const { zipDirectory } = require('./zipwrite');
  const store = path.join(__dirname, '..', 'dist', 'store');
  fs.rmSync(store, { recursive: true, force: true });
  fs.mkdirSync(store, { recursive: true });
  for (const [target, name] of [['chrome', 'chrome-edge'], ['firefox', 'firefox']]) {
    const v = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dist', target, 'manifest.json'), 'utf8')).version;
    const zip = path.join(store, `advance-download-manager-${name}-${v}.zip`);
    const n = zipDirectory(path.join(__dirname, '..', 'dist', target), zip);
    console.log('store package', path.relative(path.join(__dirname, '..'), zip), `(${n} files)`);
  }
}
