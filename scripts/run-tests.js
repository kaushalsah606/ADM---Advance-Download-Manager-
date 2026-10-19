'use strict';
// Runs test/*.test.js with the Node test runner (explicit file list: Node 20 does not expand glob patterns itself).
// Downloads made by the tests go to a throw-away folder, never into the user's real Downloads folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const dir = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(dir, f));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-unit-dl-'));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, ADM_DOWNLOAD_ROOT: root } });
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(r.status ?? 1);
