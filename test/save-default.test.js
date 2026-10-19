'use strict';
// Default save folder: everything goes straight into Downloads; folders of the old defaults are moved, folders the user chose stay.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Manager, DL_ROOT } = require('../src/manager');

test('every default category saves directly into the download folder; old default sub-folders migrate, custom ones stay', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-save-'));
  const data = path.join(tmp, 'data');
  try {
    const a = new Manager({ dataDir: data }).load();
    assert.ok(a.categories.every(c => c.dir === DL_ROOT), 'all categories use ' + DL_ROOT);
    const oldRoot = path.join(os.homedir(), 'Downloads', 'Advance Download Manager');
    const custom = path.join(tmp, 'my-videos');
    a.setCategories(a.categories.map(c => (c.id === 'video' ? { ...c, dir: custom } : { ...c, dir: path.join(oldRoot, c.name) })));
    a.saveNow();
    await a.shutdown();
    const b = new Manager({ dataDir: data }).load();
    for (const c of b.categories) assert.equal(c.dir, c.id === 'video' ? custom : DL_ROOT, c.id);
    await b.shutdown();
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
