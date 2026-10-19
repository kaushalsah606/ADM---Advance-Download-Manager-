'use strict';
// YouTube through its player API (src/youtube.js, src/ytdownload.js): address parsing, quality mapping, ranged download with resume.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const youtube = require('../src/youtube');
const { fetchStream } = require('../src/ytdownload');

test('video ids from every kind of YouTube address, and nothing else', () => {
  const id = 'dQw4w9WgXcQ';
  for (const u of [`https://www.youtube.com/watch?v=${id}`, `https://youtu.be/${id}?t=5`, `https://m.youtube.com/watch?v=${id}&list=x`, `https://www.youtube.com/shorts/${id}`, `https://www.youtube.com/embed/${id}`, `https://music.youtube.com/watch?v=${id}`, `https://www.youtube.com/live/${id}`]) assert.equal(youtube.videoId(u), id, u);
  for (const u of ['https://www.youtube.com/', 'https://www.youtube.com/watch?v=short', 'https://example.com/watch?v=' + id, 'https://evil-youtube.com/watch?v=' + id, 'nonsense']) assert.equal(youtube.videoId(u), '', u);
});

test('a stream is fetched in ranged pieces and a second run continues from the finished pieces', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-ytfetch-'));
  const size = 20 * 1024 * 1024 + 123; // 3 pieces of 8 MB
  const data = crypto.randomBytes(size);
  const asked = [];
  let failFrom = Infinity;
  const srv = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (!m) { res.statusCode = 400; return res.end(); }
    const from = +m[1], to = Math.min(+m[2], size - 1);
    asked.push(from);
    if (from >= failFrom) { res.statusCode = 403; return res.end(); }
    res.writeHead(206, { 'Content-Range': `bytes ${from}-${to}/${size}`, 'Content-Length': to - from + 1 });
    res.end(data.subarray(from, to + 1));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/v`;
  const file = path.join(tmp, 'v.part');
  try {
    let got = 0;
    failFrom = 16 * 1024 * 1024; // the third piece is refused: "address expired"
    await assert.rejects(fetchStream({ url, file, size, parallel: 1, signal: new AbortController().signal, onBytes: n => { got += n; } }), e => e.expired === true);
    assert.equal(got, 16 * 1024 * 1024);
    failFrom = Infinity; asked.length = 0; got = 0;
    await fetchStream({ url, file, size, parallel: 2, signal: new AbortController().signal, onBytes: n => { got += n; } });
    assert.deepEqual(asked, [16 * 1024 * 1024], 'only the missing piece is asked for again');
    assert.equal(got, size);
    assert.ok(fs.readFileSync(file).equals(data), 'the file is exactly the stream');
  } finally { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
