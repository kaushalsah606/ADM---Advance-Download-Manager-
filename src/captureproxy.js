'use strict';
// A user-mode alternative to kernel-level capture drivers: applications whose proxy setting points at
// 127.0.0.1:<port> have their plain-HTTP downloads handed to Advance Download Manager when the capture rules match.
//   * HTTP:  forwarded normally; if the answer is a download (file type / MIME type / "attachment"), the upstream request is
//            dropped, the download is added to the manager and the client receives a small "taken over" page.
//   * HTTPS: CONNECT tunnels are passed through untouched. We never decrypt TLS (no man-in-the-middle certificate), so HTTPS
//            downloads are only captured by the browser extension.
// Safety: bound to loopback; only absolute-URI (proxy-style) requests are served, so a web page cannot talk to it as a plain
// server; requests to Advance Download Manager's own API port are refused.
const http = require('http');
const net = require('net');

const PAGE = '<!doctype html><meta charset="utf-8"><title>Advance Download Manager</title><body style="font:16px system-ui;margin:3em"><h2>Advance Download Manager took over this download</h2><p>Check the Advance Download Manager window. You can close this tab.</p>';
const HOP = ['proxy-connection', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization'];

function create(manager, { port = 6801, apiPort = 0 } = {}) {
  const blocked = (host, p) => apiPort && +p === +apiPort && /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(host);

  const server = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('Advance Download Manager capture proxy: this is a proxy, absolute URLs only'); }
    if (u.protocol !== 'http:') { res.writeHead(400); return res.end('Only http:// requests can be proxied here (HTTPS goes through CONNECT)'); }
    if (blocked(u.hostname, u.port || 80)) { res.writeHead(403); return res.end('Advance Download Manager does not proxy its own API'); }
    const headers = { ...req.headers };
    for (const h of HOP) delete headers[h];
    headers.host = u.host;
    const up = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers }, upRes => {
      let take = false;
      if (req.method === 'GET' && !req.headers.range && upRes.statusCode === 200) {
        const cd = upRes.headers['content-disposition'] || '';
        const verdict = manager.captureCheck({ url: u.href, mime: upRes.headers['content-type'] || '', size: +upRes.headers['content-length'] || 0 });
        take = verdict.capture || (/attachment/i.test(cd) && manager.captureCheck({ url: u.href }).reason !== 'address excluded' && manager.captureCheck({ url: u.href }).reason !== 'site excluded');
      }
      if (take) {
        upRes.destroy();
        try {
          manager.propose({ url: u.href, referer: req.headers.referer || '', cookie: req.headers.cookie || '', userAgent: req.headers['user-agent'] || '', startNow: true, queue: null, source: 'capture' });
        } catch { /* invalid or duplicate: still show the page */ }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(PAGE) });
        return res.end(PAGE);
      }
      const out = { ...upRes.headers };
      for (const h of HOP) delete out[h];
      res.writeHead(upRes.statusCode, out);
      upRes.pipe(res);
    });
    up.on('error', e => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Bad gateway: ' + e.message); } else res.destroy(); });
    res.on('close', () => up.destroy());
    req.pipe(up);
  });

  server.on('connect', (req, client, head) => {
    const m = /^(.+):(\d+)$/.exec(req.url);
    if (!m || blocked(m[1], m[2])) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = net.connect(+m[2], m[1], () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    const fail = () => { try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* closed */ } upstream.destroy(); };
    upstream.on('error', fail); client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });

  return {
    server,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address().port)); }),
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

module.exports = { create };
