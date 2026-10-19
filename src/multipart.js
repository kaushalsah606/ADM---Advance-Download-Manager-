'use strict';
// multipart/byteranges (and multipart/x-byteranges) bodies: the boundary is taken from the
// Content-Type header. A server may answer even a single-range request this way.

function boundaryOf(contentType) {
  const m = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  return m ? (m[1] || m[2]) : null;
}

const isByteranges = ct => /^multipart\/(x-)?byteranges/i.test(ct || '');

/**
 * Stream the payload of every part, in order, without buffering the whole body.
 * States: seek (find the delimiter) -> afterdelim ("--" ends, CRLF starts headers) -> headers -> body -> seek ...
 */
async function* parts(stream, boundary) {
  const delim = Buffer.from('\r\n--' + boundary);
  const CRLF2 = Buffer.from('\r\n\r\n');
  let buf = Buffer.from('\r\n'); // lets the very first delimiter match like the others
  let state = 'seek';
  for await (const chunk of stream) {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (state === 'seek' || state === 'body') {
        const i = buf.indexOf(delim);
        if (i < 0) {
          const keep = Math.min(buf.length, delim.length - 1);
          if (state === 'body' && buf.length > keep) yield buf.subarray(0, buf.length - keep);
          buf = buf.subarray(buf.length - keep);
          break;
        }
        if (state === 'body' && i > 0) yield buf.subarray(0, i);
        buf = buf.subarray(i + delim.length);
        state = 'afterdelim';
      } else if (state === 'afterdelim') {
        if (buf.length < 2) break;
        if (buf[0] === 0x2d && buf[1] === 0x2d) return; // closing delimiter
        const nl = buf.indexOf(0x0a);
        if (nl < 0) break;
        buf = buf.subarray(nl + 1); // rest of the boundary line (transport padding)
        state = 'headers';
      } else if (state === 'headers') {
        if (buf.length >= 2 && buf[0] === 0x0d && buf[1] === 0x0a) { buf = buf.subarray(2); state = 'body'; continue; } // no headers at all
        const i = buf.indexOf(CRLF2);
        if (i < 0) break;
        buf = buf.subarray(i + 4);
        state = 'body';
      }
    }
  }
}

/** Read just the header block of the first part (the probe needs its Content-Range to learn the total size). */
async function firstPartHeaders(stream, boundary) {
  let buf = Buffer.alloc(0);
  const marker = Buffer.from('--' + boundary);
  for await (const chunk of stream) {
    buf = Buffer.concat([buf, chunk]);
    const start = buf.indexOf(marker);
    const end = start < 0 ? -1 : buf.indexOf(Buffer.from('\r\n\r\n'), start);
    if (end >= 0) return buf.subarray(start, end).toString('latin1');
    if (buf.length > 8192) break;
  }
  return '';
}

module.exports = { boundaryOf, isByteranges, parts, firstPartHeaders };
