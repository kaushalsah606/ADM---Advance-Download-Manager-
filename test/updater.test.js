'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const updater = require('../src/updater');
const pkg = require('../package.json');

const FILE = crypto.randomBytes(50000);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
let badSums = false, base;
const srv = http.createServer((req, res) => {
  if (req.url === '/repos/o/r/releases/latest') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ tag_name: 'v9.0.0', body: 'notes', html_url: 'x', assets: [
      { name: 'AdvanceDownloadManager-9.0.0-Setup.exe', browser_download_url: base + '/dl/AdvanceDownloadManager-9.0.0-Setup.exe', size: FILE.length },
      { name: 'SHA256SUMS.txt', browser_download_url: base + '/dl/SHA256SUMS.txt' }] }));
  }
  if (req.url === '/dl/SHA256SUMS.txt') return res.end(`${badSums ? '0'.repeat(64) : sha(FILE)}  AdvanceDownloadManager-9.0.0-Setup.exe\n`);
  if (req.url === '/dl/AdvanceDownloadManager-9.0.0-Setup.exe') return res.end(FILE);
  res.statusCode = 404; res.end();
});
test.before(() => new Promise(r => srv.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + srv.address().port; r(); })));
test.after(() => srv.close());

test('src/version.js matches package.json', () => assert.strictEqual(updater.current, pkg.version));
test('version comparison', () => {
  assert.strictEqual(updater.cmp('1.0.1', '1.0.0'), 1);
  assert.strictEqual(updater.cmp('v1.10.0', '1.9.9'), 1);
  assert.strictEqual(updater.cmp('1.0.0', '1.0.0'), 0);
  assert.strictEqual(updater.cmp('0.9.9', '1.0.0'), -1);
});
test('finds a newer release, downloads and verifies the installer', async () => {
  const info = await updater.check({ repo: 'o/r', apiBase: base });
  assert.ok(info.available); assert.strictEqual(info.latest, '9.0.0');
  const file = await updater.download(info, { allowedPrefixes: [base] });
  assert.ok(fs.readFileSync(file).equals(FILE));
  assert.deepStrictEqual(updater.install(file, { dryRun: true }), ['/SILENT', '/CLOSEAPPLICATIONS', '/RESTARTAPPLICATIONS']);
});
test('a checksum mismatch is refused', async () => {
  badSums = true;
  const info = await updater.check({ repo: 'o/r', apiBase: base });
  await assert.rejects(updater.download(info, { allowedPrefixes: [base] }), /Checksum mismatch/);
  badSums = false;
});
test('downloads from unexpected hosts are refused', async () => {
  const info = await updater.check({ repo: 'o/r', apiBase: base });
  await assert.rejects(updater.download(info, { repo: 'o/r' }), /Refusing to download/);
});
test('no newer release / no release at all means no update', async () => {
  const info = await updater.check({ repo: 'o/none', apiBase: base });
  assert.strictEqual(info.available, false);
});
