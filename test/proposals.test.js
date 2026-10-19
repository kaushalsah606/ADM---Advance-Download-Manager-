'use strict';
// "Download File Info": captured downloads wait for the user's confirmation (file name, size, type, category, save location) before they start.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Manager } = require('../src/manager');
const { createServer } = require('../src/server');
const { zipDirectory } = require('../scripts/zipwrite');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-prop-'));
const DATA = crypto.randomBytes(200000);
const PDF = Buffer.from('%PDF-1.4 ' + 'x'.repeat(5000));
// a real zip with two files, served for the Preview button
const zdir = path.join(tmp, 'zsrc'); fs.mkdirSync(zdir);
fs.writeFileSync(path.join(zdir, 'readme.txt'), 'hello'); fs.writeFileSync(path.join(zdir, 'data.bin'), Buffer.alloc(3000, 7));
zipDirectory(zdir, path.join(tmp, 'sample.zip'));
const ZIPFILE = fs.readFileSync(path.join(tmp, 'sample.zip'));

const origin = http.createServer((req, res) => {
  const send = (body, headers) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const s = m ? +m[1] : 0, e = m && m[2] ? Math.min(+m[2], body.length - 1) : body.length - 1;
    const h = { 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes', ...headers };
    if (m) h['Content-Range'] = `bytes ${s}-${e}/${body.length}`;
    res.writeHead(m ? 206 : 200, h);
    if (req.method === 'HEAD') return res.end();
    res.end(body.subarray(s, e + 1));
  };
  if (req.url === '/files/archive.zip') return send(DATA, { 'Content-Type': 'application/zip' });
  if (req.url === '/files/sample.zip') return send(ZIPFILE, { 'Content-Type': 'application/zip' });
  if (req.url === '/dl.php') return send(PDF, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="Report 2026.pdf"' });
  res.writeHead(404); res.end('nope');
});
let base, m, srv, port;
test.before(async () => {
  await new Promise(r => origin.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${origin.address().port}`;
  m = new Manager({ dataDir: path.join(tmp, 'data') }).load();
  m.setSettings({ rampMs: 30, minSplitBytes: 64 * 1024, confirmDownloads: true });
  // keep every category folder inside the temp directory
  m.setCategories(m.categories.map(c => ({ ...c, dir: path.join(tmp, 'dl', c.id) })));
  srv = createServer(m, { port: 0 }); port = await srv.listen();
});
test.after(async () => { await m.shutdown(); srv.server.close(); origin.closeAllConnections?.(); origin.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const wait = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 50)); } };
const find = url => m.snapshot().proposals.find(p => p.url === url);
const doneDl = id => wait(() => { const v = m.view(m.get(id)); return (v.status === 'complete' || v.status === 'error') && v; });

test('a captured download becomes a request with file name, size, type and category; nothing starts yet', async () => {
  const url = base + '/files/archive.zip';
  const r = m.propose({ url, referer: 'http://site.example/page', startNow: true, queue: null, source: 'browser' });
  assert.strictEqual(r.proposal, true);
  assert.strictEqual(m.downloads.size, 0, 'no download is started silently');
  const p = await wait(() => { const x = find(url); return x && x.status === 'ready' && x; });
  assert.strictEqual(p.fileName, 'archive.zip');
  assert.strictEqual(p.size, DATA.length);
  assert.strictEqual(p.contentType, 'application/zip');
  assert.strictEqual(p.category, 'compressed');
  assert.strictEqual(p.saveDir, path.join(tmp, 'dl', 'compressed'));
  assert.strictEqual(p.source, 'browser');
  assert.strictEqual(p.exists, false);
  assert.strictEqual(m.downloads.size, 0);
  assert.strictEqual(m.propose({ url }).id, r.id, 'the same link is not asked twice');
  assert.strictEqual(m.snapshot().proposals.length, 1);
});

test('Start Download: the chosen name, folder, category and description are used; "remember this path" updates the category', async () => {
  const url = base + '/files/archive.zip';
  const p = find(url);
  const dir = path.join(tmp, 'my-choice', 'zips');
  const res = m.proposalAccept(p.id, { fileName: 'renamed.zip', saveDir: dir, category: 'compressed', description: 'my note', rememberPath: true, action: 'start' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(m.snapshot().proposals.length, 0, 'the request is gone');
  const v = await doneDl(res.download.id);
  assert.strictEqual(v.status, 'complete', v.error);
  assert.strictEqual(v.fileName, 'renamed.zip');
  assert.strictEqual(v.saveDir, dir);
  assert.strictEqual(v.description, 'my note');
  assert.ok(fs.readFileSync(path.join(dir, 'renamed.zip')).equals(DATA));
  assert.strictEqual(m.categories.find(c => c.id === 'compressed').dir, dir, 'remembered for the category');
});

test('Content-Disposition names and the file type decide name and category in the request', async () => {
  const url = base + '/dl.php';
  m.propose({ url });
  const p = await wait(() => { const x = find(url); return x && x.status === 'ready' && x; });
  assert.strictEqual(p.fileName, 'Report 2026.pdf');
  assert.strictEqual(p.category, 'documents');
  assert.strictEqual(p.contentType, 'application/pdf');
  // Download Later: added to the main queue, not started
  const res = m.proposalAccept(p.id, { action: 'later' });
  const v = m.view(m.get(res.download.id));
  assert.strictEqual(v.queue, 'main');
  assert.strictEqual(v.status, 'queued');
  await new Promise(r => setTimeout(r, 400));
  assert.strictEqual(m.view(m.get(res.download.id)).status, 'queued', 'Download Later does not start it');
});

test('Cancel discards the request; unknown or expired requests are refused', async () => {
  const url = base + '/files/sample.zip';
  const before = m.downloads.size;
  m.propose({ url });
  const p = find(url);
  assert.strictEqual(m.proposalReject(p.id), true);
  assert.strictEqual(find(url), undefined);
  assert.strictEqual(m.downloads.size, before);
  assert.throws(() => m.proposalAccept(p.id, {}), /expired/);
  assert.strictEqual(m.proposalReject('nope'), false);
});

test('duplicate link: the dialog is asked first, then "download again" adds a numbered copy', async () => {
  const url = base + '/files/archive.zip';
  m.propose({ url });
  const p = await wait(() => { const x = find(url); return x && x.status === 'ready' && x; });
  assert.strictEqual(p.inList, true, 'the request shows that the link is already in the list');
  m.setSettings({ duplicatePolicy: 'ask' });
  const first = m.proposalAccept(p.id, { saveDir: path.join(tmp, 'dup') });
  assert.strictEqual(first.duplicate, true);
  assert.ok(find(url), 'still waiting');
  const second = m.proposalAccept(p.id, { saveDir: path.join(tmp, 'dup'), allowDuplicate: true });
  assert.strictEqual(second.ok, true);
  assert.ok(second.download.id);
  await doneDl(second.download.id);
});

test('Duplicate download link: the existing entry is described, and each choice does what it says', async () => {
  m.setSettings({ duplicatePolicy: 'ask' });
  const url = base + '/files/archive.zip';
  const existing = [...m.downloads.values()].find(d => d.rec.url === url && d.rec.status === 'complete');
  assert.ok(existing, 'a completed download of this link exists from the earlier tests');
  const count = () => m.downloads.size;

  // the details the dialog shows
  m.propose({ url });
  let pr = await wait(() => { const x = find(url); return x && x.status === 'ready' && x; });
  const asked = m.proposalAccept(pr.id, { saveDir: path.join(tmp, 'dup2') });
  assert.strictEqual(asked.duplicate, true);
  assert.strictEqual(asked.existing.fileName, existing.rec.fileName);
  assert.strictEqual(asked.existing.status, 'complete');
  assert.strictEqual(asked.existing.size, DATA.length);
  assert.ok(asked.existing.saveDir && asked.existing.added);

  // 1) add with a numbered file name
  let n = count();
  const numbered = m.proposalAccept(pr.id, { saveDir: path.join(tmp, 'dup2'), duplicatePolicy: 'number' });
  assert.strictEqual(numbered.ok, true);
  assert.strictEqual(count(), n + 1);
  const v1 = await doneDl(numbered.download.id);
  assert.strictEqual(v1.status, 'complete', v1.error);

  // 2) add and overwrite the existing file: one entry replaces the other
  m.propose({ url }); pr = await wait(() => { const x = find(url); return x && x.status === 'ready' && x; });
  n = count();
  const over = m.proposalAccept(pr.id, { saveDir: path.join(tmp, 'dup2'), duplicatePolicy: 'overwrite' });
  assert.strictEqual(over.ok, true);
  assert.strictEqual(count(), n, 'the old entry was replaced, not added to');
  const v2 = await doneDl(over.download.id);
  assert.strictEqual(v2.status, 'complete', v2.error);
  assert.ok(![...m.downloads.keys()].includes(numbered.download.id) || [...m.downloads.keys()].includes(over.download.id));

  // 3) keep / resume the existing download: nothing new is added and the request is closed
  m.propose({ url }); pr = await wait(() => { const x = find(url); return x && x.status === 'ready' && x; });
  n = count();
  const keep = m.proposalAccept(pr.id, { duplicatePolicy: 'resume' });
  assert.strictEqual(keep.ok, true);
  assert.strictEqual(keep.download.duplicate, true);
  assert.strictEqual(count(), n);
  assert.strictEqual(find(url), undefined, 'the request is closed');

  // "do not ask again": a stored policy answers without a dialog
  m.setSettings({ duplicatePolicy: 'number' });
  m.propose({ url }); pr = await wait(() => { const x = find(url); return x && x.status === 'ready' && x; });
  n = count();
  const auto = m.proposalAccept(pr.id, { saveDir: path.join(tmp, 'dup3') });
  assert.ok(auto.ok && !auto.duplicate);
  assert.strictEqual(count(), n + 1);
  await doneDl(auto.download.id);
  m.setSettings({ duplicatePolicy: 'ask' });
});

test('an unreachable link still opens the dialog (with the reason) and can be accepted', async () => {
  const url = 'http://127.0.0.1:1/never.zip';
  m.propose({ url });
  const p = await wait(() => { const x = find(url); return x && x.status === 'ready' && x; });
  assert.ok(p.error, 'the problem is shown: ' + p.error);
  assert.strictEqual(p.fileName, 'never.zip');
  m.proposalReject(p.id);
});

test('Preview reads the zip directory of the pending download', async () => {
  const url = base + '/files/sample.zip';
  m.propose({ url });
  const p = await wait(() => { const x = find(url); return x && x.status === 'ready' && x; });
  const z = await m.previewProposal(p.id);
  assert.deepStrictEqual(z.files.map(f => f.name).sort(), ['data.bin', 'readme.txt']);
  m.proposalReject(p.id);
});

test('switching the confirmation off starts captured downloads directly, as before', async () => {
  m.setSettings({ confirmDownloads: false });
  const r = m.propose({ url: base + '/files/archive.zip', saveDir: path.join(tmp, 'direct'), startNow: true, queue: null, allowDuplicate: true });
  assert.ok(r.id && !r.proposal, 'a real download, not a request');
  assert.strictEqual(m.snapshot().proposals.length, 0);
  const v = await doneDl(r.id);
  assert.strictEqual(v.status, 'complete', v.error);
  m.setSettings({ confirmDownloads: true });
});

test('API: propose / accept / reject need the token and work end to end', async () => {
  const call = (method, p, body, token = srv.token) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'X-Token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(c).toString() || '{}') }));
    });
    req.on('error', reject); req.end(data);
  });
  assert.strictEqual((await call('POST', '/api/propose', { url: base + '/dl.php' }, 'wrong')).status, 401);
  const r = await call('POST', '/api/propose', { url: base + '/files/sample.zip', source: 'clipboard' });
  assert.strictEqual(r.body.proposal, true);
  const st = await call('GET', '/api/state');
  assert.ok(st.body.proposals.some(p => p.id === r.body.id && p.source === 'clipboard'));
  const prev = await wait(() => find(base + '/files/sample.zip')?.status === 'ready');
  assert.ok(prev);
  assert.strictEqual((await call('POST', `/api/proposals/${r.body.id}/preview`, {})).body.files.length, 2);
  assert.strictEqual((await call('POST', `/api/proposals/${r.body.id}/reject`, {})).body.ok, true);
  assert.strictEqual((await call('POST', '/api/proposals/missing/accept', {})).status, 404);
});
