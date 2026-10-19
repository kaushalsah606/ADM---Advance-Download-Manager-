'use strict';
// Export / import of the download list.
//
//  * "ief"  - text export format (read and write); the same layout is used for both file extensions.
//             One record per download, CRLF line endings:
//                 <
//                 http://host/file.zip
//                 referer: http://host/page
//                 cookie: a=b
//                 pd: post-data
//                 User-Agent: Mozilla/5.0 ...
//                 >
//             The dialog filter is "*.ef2; *.ief" and ONE reader and ONE
//             record writer serve both extensions, so .ef2 and .ief are the same text format.
//  * "json" - Advance Download Manager's own export file (.sgx)
//  * "text" - one link per line
// Credentials, cookies and POST data are never written by Advance Download Manager's exporter.
const { Manager } = require('./manager');

const FORMAT = 'advance-download-manager-export';
const CRLF = String.fromCharCode(13, 10);

function toIef(downloads, { includeCookies = false } = {}) {
  return downloads.map(d => {
    const r = d.rec;
    const lines = ['<', r.url];
    if (r.referer) lines.push('referer: ' + r.referer);
    if (includeCookies && r.cookie) lines.push('cookie: ' + r.cookie); // cookies can be exported; opt-in here because they are session secrets
    if (r.userAgent) lines.push('User-Agent: ' + r.userAgent);
    lines.push('>');
    return lines.join(CRLF) + CRLF;
  }).join('');
}

/** Parse IEF text. Tolerates LF line endings; ignores unknown keys. */
function parseIef(text) {
  const items = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!cur) { if (line === '<') cur = { url: null }; continue; }
    if (line === '>') { if (cur.url && /^(https?|ftp):\/\//i.test(cur.url)) items.push(cur); cur = null; continue; }
    if (cur.url === null) { cur.url = line.trim(); continue; }
    const m = /^(referer|cookie|pd|user-agent):\s?(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'referer') cur.referer = m[2];
    else if (key === 'cookie') cur.cookie = m[2];
    else if (key === 'user-agent') cur.userAgent = m[2];
    // 'pd' (POST data) is parsed away but not supported by this downloader
  }
  return items;
}

function exportList(downloads, { format = 'json', includeCookies = false } = {}) {
  if (format === 'ief' || format === 'ef2') return toIef(downloads, { includeCookies }); // .ef2 and .ief are the same format
  if (format === 'text') return downloads.map(d => d.rec.url).join(CRLF) + CRLF;
  return JSON.stringify({
    format: FORMAT, version: 1, exported: new Date().toISOString(),
    items: downloads.map(d => ({
      url: d.rec.url, fileName: d.rec.fileName, saveDir: d.rec.saveDir, category: d.rec.category,
      description: d.rec.description || '', referer: d.rec.referer || '',
    })),
  }, null, 2);
}

function parseImport(text) {
  const t = String(text).replace(/^﻿/, '').trim();
  if (t.startsWith('{')) {
    let j;
    try { j = JSON.parse(t); } catch { throw Object.assign(new Error('Not a valid export file'), { status: 400 }); }
    if (j.format !== FORMAT || !Array.isArray(j.items)) throw Object.assign(new Error('Not a Advance Download Manager export file'), { status: 400 });
    return j.items.filter(i => i && typeof i.url === 'string');
  }
  if (/^<\s*\r?\n/.test(t)) {
    const items = parseIef(t);
    if (!items.length) throw Object.assign(new Error('The file is not a valid export file or the file is corrupted'), { status: 400 });
    return items;
  }
  return Manager.extractUrls(t).map(url => ({ url }));
}

module.exports = { exportList, parseImport, parseIef, toIef };
