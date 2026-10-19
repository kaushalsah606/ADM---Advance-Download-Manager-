'use strict';
// RTMP client against a hand-written mock server + byte-level vectors from the Adobe RTMP / AMF0 specifications.
// NOTE: no real RTMP server (FMS, nginx-rtmp, Wowza) was available, so interoperability with real servers is untested.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const rtmp = require('../src/rtmp');
const { Manager } = require('../src/manager');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advance-download-manager-rtmp-'));

test('AMF0 encoding matches the specification bytes', () => {
  const b = rtmp.amf('connect', 1, { app: 'live' });
  assert.strictEqual(b.toString('hex'), '02' + '0007' + Buffer.from('connect').toString('hex') + '00' + '3ff0000000000000' + '03' + '0003' + Buffer.from('app').toString('hex') + '02' + '0004' + Buffer.from('live').toString('hex') + '000009');
  assert.strictEqual(rtmp.amf(true, null, false).toString('hex'), '0101' + '05' + '0100');
  const vals = rtmp.amfDecodeAll(Buffer.concat([rtmp.amf('x', 2.5, null, { a: 1, b: 'two', c: { d: true } }), Buffer.from('08000000020003616161' + '00' + '3ff0000000000000' + '0003626262' + '05' + '000009', 'hex')]));
  assert.deepStrictEqual(vals[0], 'x'); assert.strictEqual(vals[1], 2.5); assert.strictEqual(vals[2], null);
  assert.deepStrictEqual(vals[3], { a: 1, b: 'two', c: { d: true } });
  assert.deepStrictEqual(vals[4], { aaa: 1, bbb: null }, 'ECMA array');
});

test('chunk reader: fmt 0/1/2/3 headers, timestamp deltas, extended timestamp, chunk-size change, interleaving', () => {
  const r = new rtmp.ChunkReader();
  const hdr = (fmt, csid) => Buffer.from([(fmt << 6) | csid]);
  const u24 = n => { const b = Buffer.alloc(3); b.writeUIntBE(n, 0, 3); return b; };
  const A = Buffer.from('AAAAA'), B = Buffer.from('BBBBB'), C = Buffer.from('CCCCC'), D = Buffer.from('DDDDD');
  const sid = Buffer.from([1, 0, 0, 0]);
  const stream = Buffer.concat([
    hdr(0, 4), u24(1000), u24(5), Buffer.from([9]), sid, A,          // fmt0: absolute ts 1000
    hdr(1, 4), u24(40), u24(5), Buffer.from([9]), B,                  // fmt1: delta 40 -> 1040
    hdr(2, 4), u24(40), C,                                            // fmt2: delta 40 -> 1080, same length/type
    hdr(3, 4), D,                                                     // fmt3 new message: repeats delta -> 1120
  ]);
  const m = r.push(stream);
  assert.deepStrictEqual(m.map(x => [x.ts, x.payload.toString(), x.type, x.sid]), [[1000, 'AAAAA', 9, 1], [1040, 'BBBBB', 9, 1], [1080, 'CCCCC', 9, 1], [1120, 'DDDDD', 9, 1]]);
  // extended timestamp + a message split across 3 chunks of 4 bytes (chunk size change first), fed one byte at a time
  const r2 = new rtmp.ChunkReader();
  const cs = Buffer.alloc(4); cs.writeUInt32BE(4);
  const ext = Buffer.alloc(4); ext.writeUInt32BE(0x01000000);
  const big = Buffer.concat([
    hdr(0, 2), u24(0), u24(4), Buffer.from([1]), Buffer.alloc(4), cs,                                         // Set Chunk Size 4
    hdr(0, 5), u24(0xffffff), u24(10), Buffer.from([8]), sid, ext, Buffer.from('0123'),                       // fmt0 + extended ts
    hdr(3, 5), ext, Buffer.from('4567'),                                                                       // continuation repeats the extended ts
    hdr(3, 5), ext, Buffer.from('89'),
  ]);
  const got = [];
  for (const byte of big) got.push(...r2.push(Buffer.from([byte])));
  assert.strictEqual(r2.chunkSize, 4);
  assert.deepStrictEqual(got.map(x => [x.type, x.ts, x.payload.toString()]), [[1, 0, '\0\0\0\u0004'], [8, 0x01000000, '0123456789']]);
});

test('URL splitting follows the usual convention: app / stream, mp4: prefix, .flv stripped, ondemand/, slist, rtmpe refused', () => {
  const p = rtmp.parseUrl;
  assert.deepStrictEqual([p('rtmp://h/live/cam1').app, p('rtmp://h/live/cam1').stream, p('rtmp://h/live/cam1').tcUrl, p('rtmp://h/live/cam1').port], ['live', 'cam1', 'rtmp://h/live', 1935]);
  assert.strictEqual(p('rtmp://h/vod/movie.flv').stream, 'movie');
  assert.strictEqual(p('rtmp://h/vod/dir/clip.mp4').app, 'vod/dir');
  assert.strictEqual(p('rtmp://h/vod/dir/clip.mp4').stream, 'mp4:clip.mp4');
  assert.strictEqual(p('rtmp://h/vod/mp4:already.mp4').stream, 'mp4:already.mp4');
  assert.deepStrictEqual([p('rtmp://h/ondemand/a/b.f4v').app, p('rtmp://h/ondemand/a/b.f4v').stream], ['ondemand', 'mp4:a/b.f4v']);
  assert.deepStrictEqual([p('rtmp://h:8080/app?slist=foo/bar').app, p('rtmp://h:8080/app?slist=foo/bar').stream, p('rtmp://h:8080/app?slist=foo/bar').port], ['app', 'foo/bar', 8080]);
  assert.strictEqual(p('rtmps://h/a/b').secure, true);
  assert.throws(() => p('rtmpe://h/a/b'), /Encrypted RTMP/);
  assert.throws(() => p('rtmp://h/onlyapp'), /no stream name/);
});

// ---------------- mock server ----------------
const rec = { plays: [], acks: [], pongs: 0, connects: [] };
function startServer({ chunk = 4096, mode = 'ok', window = 2500000 } = {}) {
  const media = [];
  const video = n => crypto.randomBytes(10000).fill(n, 0, 1);
  const msgs = [
    { t: 18, ts: 0, p: rtmp.amf('onMetaData', { duration: 2.5, width: 320 }) },
    { t: 8, ts: 0, p: crypto.randomBytes(200) }, { t: 9, ts: 0, p: video(0x17) },
    { t: 8, ts: 20, p: crypto.randomBytes(200) }, { t: 9, ts: 40, p: video(0x27) },
    { t: 8, ts: 40, p: crypto.randomBytes(200) }, { t: 9, ts: 80, p: video(0x27) },
  ];
  const server = net.createServer(sock => {
    let buf = Buffer.alloc(0), stage = 'c0c1', cs = 128, rx = 0;
    const reader = new rtmp.ChunkReader();
    const send = (csid, type, sid, payload, ts = 0) => sock.write(rtmp.chunkOut(csid, ts, type, sid, payload, cs));
    const onMsg = m => {
      if (m.type === 3) rec.acks.push(m.payload.readUInt32BE(0));
      if (m.type === 4 && m.payload.readUInt16BE(0) === 7) rec.pongs++;
      if (m.type !== 20) return;
      const [name, txn, , ...args] = rtmp.amfDecodeAll(m.payload);
      if (name === 'connect') {
        rec.connects.push(rtmp.amfDecodeAll(m.payload)[2]);
        const w = Buffer.alloc(4); w.writeUInt32BE(window); send(2, 5, 0, w);
        const pb = Buffer.alloc(5); pb.writeUInt32BE(window); pb[4] = 2; send(2, 6, 0, pb);
        const c = Buffer.alloc(4); c.writeUInt32BE(chunk); send(2, 1, 0, c); cs = chunk;
        send(3, 20, 0, rtmp.amf('_result', txn, { fmsVer: 'FMS/3,5,1,525', capabilities: 31 }, { level: 'status', code: 'NetConnection.Connect.Success', objectEncoding: 0 }));
      } else if (name === 'createStream') {
        send(3, 20, 0, rtmp.amf('_result', txn, null, 1));
      } else if (name === 'play') {
        rec.plays.push(args[0]);
        const begin = Buffer.alloc(6); begin.writeUInt16BE(0, 0); begin.writeUInt32BE(1, 2); send(2, 4, 0, begin);
        if (mode === 'notfound') {
          send(5, 20, 1, rtmp.amf('onStatus', 0, null, { level: 'error', code: 'NetStream.Play.StreamNotFound', description: 'no such stream' }));
          return;
        }
        send(5, 20, 1, rtmp.amf('onStatus', 0, null, { level: 'status', code: 'NetStream.Play.Start' }));
        msgs.forEach((x, i) => {
          send(x.t === 9 ? 6 : x.t === 8 ? 4 : 5, x.t, 1, x.p, x.ts);
          if (i === 3) { const ping = Buffer.alloc(6); ping.writeUInt16BE(6, 0); ping.writeUInt32BE(777, 2); send(2, 4, 0, ping); }
        });
        media.push(...msgs);
        send(5, 20, 1, rtmp.amf('onStatus', 0, null, { level: 'status', code: 'NetStream.Play.Stop' }));
        setTimeout(() => sock.end(), 50);
      }
    };
    sock.on('error', () => {});
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (stage === 'c0c1') {
        if (buf.length < 1537) return;
        const c1 = buf.subarray(1, 1537); buf = buf.subarray(1537);
        sock.write(Buffer.concat([Buffer.from([3]), Buffer.alloc(8), crypto.randomBytes(1528), c1])); // S0 S1 S2(echo of C1)
        stage = 'c2';
      }
      if (stage === 'c2') { if (buf.length < 1536) return; buf = buf.subarray(1536); stage = 'msg'; }
      if (stage === 'msg' && buf.length) { const data = buf; buf = Buffer.alloc(0); rx += data.length; for (const m of reader.push(data)) onMsg(m); }
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, msgs })));
}

function parseFlv(buf) {
  assert.strictEqual(buf.subarray(0, 3).toString(), 'FLV');
  assert.strictEqual(buf[4], 5, 'audio + video flags');
  assert.strictEqual(buf.readUInt32BE(5), 9);
  assert.strictEqual(buf.readUInt32BE(9), 0, 'PreviousTagSize0');
  const tags = []; let o = 13;
  while (o < buf.length) {
    const type = buf[o], size = buf.readUIntBE(o + 1, 3), ts = buf.readUIntBE(o + 4, 3) | (buf[o + 7] << 24);
    const payload = buf.subarray(o + 11, o + 11 + size);
    assert.strictEqual(buf.readUInt32BE(o + 11 + size), 11 + size, 'PreviousTagSize');
    tags.push({ type, ts, payload }); o += 11 + size + 4;
  }
  return tags;
}

const mk = name => { const m = new Manager({ dataDir: path.join(tmp, name, 'data') }).load(); return m; };
const done = (m, id, ms = 20000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout ' + JSON.stringify(m.view(m.get(id))))), ms);
  const check = () => { const v = m.view(m.get(id)); if (v.status === 'complete' || v.status === 'error') { clearTimeout(t); m.off('update', check); resolve(v); } };
  m.on('update', check); check();
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

for (const chunk of [128, 4096]) {
  test(`play over RTMP with server chunk size ${chunk}: FLV tags, metadata, ping reply, app/tcUrl/stream names`, async () => {
    Object.assign(rec, { plays: [], acks: [], pongs: 0, connects: [] });
    const { server, port, msgs } = await startServer({ chunk });
    const m = mk('play' + chunk);
    const v = m.add({ url: `rtmp://127.0.0.1:${port}/vod/dir/clip.mp4`, saveDir: path.join(tmp, 'play' + chunk, 'o'), queue: null, startNow: true });
    const d = await done(m, v.id);
    assert.strictEqual(d.status, 'complete', d.error);
    assert.strictEqual(d.fileName, 'clip.flv');
    const tags = parseFlv(fs.readFileSync(path.join(d.saveDir, d.fileName)));
    assert.deepStrictEqual(tags.map(t => [t.type, t.ts]), msgs.map(x => [x.t, x.ts]));
    tags.forEach((t, i) => assert.ok(t.payload.equals(msgs[i].p), 'payload of tag ' + i));
    assert.deepStrictEqual(rec.plays, ['mp4:clip.mp4']);
    assert.strictEqual(rec.connects[0].app, 'vod/dir');
    assert.strictEqual(rec.connects[0].tcUrl, `rtmp://127.0.0.1:${port}/vod/dir`);
    assert.strictEqual(rec.pongs, 1, 'ping request answered');
    assert.strictEqual(m.get(v.id).rec.duration, 2.5, 'duration from onMetaData');
    await m.shutdown(); server.close();
  });
}

test('window acknowledgements are sent once enough bytes have been received', async () => {
  Object.assign(rec, { plays: [], acks: [], pongs: 0, connects: [] });
  const { server, port } = await startServer({ window: 5000 });
  const out = []; for await (const b of rtmp.play(`rtmp://127.0.0.1:${port}/live/s`)) out.push(b);
  await new Promise(r => setTimeout(r, 150)); // let the server process the ack
  assert.ok(rec.acks.length >= 1 && rec.acks[0] >= 5000, 'ack after the window size: ' + rec.acks);
  server.close();
});

test('StreamNotFound is a clear fatal error; rtmpe is refused before connecting', async () => {
  const { server, port } = await startServer({ mode: 'notfound' });
  const m = mk('nf');
  const v = m.add({ url: `rtmp://127.0.0.1:${port}/live/missing`, saveDir: path.join(tmp, 'nf', 'o'), queue: null, startNow: true });
  const d = await done(m, v.id);
  assert.strictEqual(d.status, 'error');
  assert.match(d.error, /StreamNotFound/);
  const e = m.add({ url: 'rtmpe://127.0.0.1:1/live/x', saveDir: path.join(tmp, 'nf', 'o2'), queue: null, startNow: true });
  const ed = await done(m, e.id);
  assert.match(ed.error, /Encrypted RTMP/);
  await m.shutdown(); server.close();
});
