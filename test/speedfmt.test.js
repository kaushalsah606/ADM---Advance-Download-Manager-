'use strict';
// The transfer rate shown in the list, the status line and the tray: B/s, KB/s below 1 MB, MB/s below 1 GB, then GB/s.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('transfer rate units step up at 1 KB, 1 MB and 1 GB', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const line = html.split('\n').find(l => l.startsWith('const fmtSpeed = '));
  assert.ok(line, 'fmtSpeed exists in the page');
  const fmtSpeed = new Function(line + '; return fmtSpeed;')();
  const cases = [[0, '0 B/s'], [512, '512 B/s'], [1024, '1 KB/s'], [350 * 1024, '350 KB/s'], [1048575, '1024 KB/s'], [1048576, '1.00 MB/s'], [5.5 * 1048576, '5.50 MB/s'], [1073741823, '1024.00 MB/s'], [1073741824, '1.00 GB/s'], [3 * 1073741824, '3.00 GB/s']];
  for (const [n, want] of cases) assert.equal(fmtSpeed(n), want, String(n));
  assert.equal(fmtSpeed(-5), '0 B/s');
  assert.equal(fmtSpeed(undefined), '0 B/s');
});
