'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const U = require('./util');

const PAGE_EXT = new Set(['', 'html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'shtml', 'cfm']);
const TEMPLATES = {
  custom: { exts: [], levels: 2 },
  images: { exts: 'jpg jpeg png gif bmp webp svg'.split(' '), levels: 2 },
  video: { exts: 'mp4 mkv avi mov wmv flv webm mpg'.split(' '), levels: 2 },
  audio: { exts: 'mp3 wav flac aac ogg m4a wma'.split(' '), levels: 2 },
  documents: { exts: 'pdf doc docx xls xlsx ppt pptx txt epub'.split(' '), levels: 2 },
  archives: { exts: 'zip rar 7z gz tar iso'.split(' '), levels: 2 },
  website: { exts: 'css js jpg jpeg png gif svg webp ico woff woff2 ttf'.split(' '), levels: 3, mirror: true },
};

const ATTR = /\b(href|src|data-src|poster)(\s*=\s*)(["'])([^"']*)\3/gi;

function extractLinks(html, base, { scripts = true } = {}) {
  const out = new Set();
  const add = v => { try { const u = new URL(v.trim().replace(/&amp;/g, '&'), base); if (/^https?:$/.test(u.protocol)) { u.hash = ''; out.add(u.href); } } catch { /* skip */ } };
  for (const m of html.matchAll(/\b(?:href|src|data-src|poster)\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) for (const part of m[1].split(',')) add(part.trim().split(/\s+/)[0]);
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(m[1]);
  if (scripts) {
    // "Process Javascript" without executing anything: screen script text for URL-looking string literals
    for (const sm of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      for (const m of sm[1].matchAll(/["']((?:https?:)?\/\/[^"'\s<>\\]+|\.{0,2}\/[^"'\s<>\\]+\.[A-Za-z0-9]{2,5}(?:\?[^"'\s<>\\]*)?)["']/g)) add(m[1]);
    }
  }
  return [...out];
}

async function fetchPage(url, { proxy, signal, headers }) {
  const { res } = await U.open(url, { headers: { 'User-Agent': 'Mozilla/5.0 ADM-Grabber/1.0', Accept: 'text/html,*/*', 'Accept-Encoding': 'identity', ...headers }, proxy, signal, timeout: 20000 });
  const type = (res.headers['content-type'] || '').toLowerCase();
  if (res.statusCode >= 400 || !/html|xml/.test(type)) { res.destroy(); return { type, body: null, status: res.statusCode }; }
  const chunks = []; let n = 0;
  for await (const c of res) { n += c.length; chunks.push(c); if (n > 2e6) { res.destroy(); break; } }
  return { type, body: Buffer.concat(chunks).toString('utf8'), status: res.statusCode };
}

async function headSize(url, { proxy, signal, headers }) {
  try {
    const { res } = await U.open(url, { method: 'HEAD', headers: { 'Accept-Encoding': 'identity', ...headers }, proxy, signal, timeout: 10000 });
    res.resume();
    const n = res.headers['content-length'];
    return res.statusCode < 400 && n != null ? +n : null;
  } catch { return null; }
}

/** Deterministic on-disk location for a URL when mirroring (original relative sub-folders). */
function localPath(root, urlStr, isPage) {
  const u = new URL(urlStr);
  const segs = decodeURIComponent(u.pathname).split('/').filter(Boolean).map(s => U.sanitizeName(s));
  let name = segs.pop() || 'index.html';
  if (/\/$/.test(u.pathname)) { if (segs.length || name !== 'index.html') segs.push(name); name = 'index.html'; }
  if (isPage && !/\.[A-Za-z0-9]{1,5}$/.test(name)) name += '.html';
  if (isPage && /\.(php|asp|aspx|jsp|shtml|cfm)$/i.test(name)) name += '.html';
  if (u.search) { const h = crypto.createHash('md5').update(u.search).digest('hex').slice(0, 6); name = name.replace(/(\.[^.]*)?$/, m => `_${h}${m}`); }
  return path.join(root, U.sanitizeName(u.hostname + (u.port ? '_' + u.port : '')), ...segs, name);
}

/**
 * Site Grabber: breadth-first exploration up to N levels (this site / other sites), collecting files that
 * match filters. With opts.savePages the explored pages are stored for offline browsing.
 */
async function explore(opts, { onFile, onPage, signal, proxy }) {
  const tpl = TEMPLATES[opts.template] || TEMPLATES.custom;
  const start = new URL(opts.startUrl);
  const exts = new Set((opts.exts && opts.exts.length ? opts.exts : tpl.exts).map(e => e.toLowerCase().replace(/^\./, '')));
  const levelsThis = opts.levelsThis ?? tpl.levels, levelsOther = opts.levelsOther ?? 0;
  const maxPages = opts.maxPages || 300, maxFiles = opts.maxFiles || 5000;
  const include = opts.includePaths || [], exclude = opts.excludePaths || [];
  // Manual login: log in with your own browser, then paste its Cookie header (the grabber cannot open a login window)
  const headers = { ...(opts.username ? { Authorization: U.basicAuth(opts.username, opts.password) } : {}), ...(opts.cookie ? { Cookie: opts.cookie } : {}) };
  const baseDir = start.pathname.replace(/[^/]*$/, '');
  const sameSite = u => u.hostname === start.hostname || (opts.exploreSubdomains && u.hostname.endsWith('.' + start.hostname.replace(/^www\./, '')));
  const mirror = !!(opts.savePages && opts.saveRoot);
  const wantSize = opts.minSize > 0 || opts.maxSize > 0 || opts.hideDuplicates;
  const seenPages = new Set([start.href]), seenFiles = new Set(), seenNameSize = new Set();
  const queue = [{ url: start.href, level: 0, other: 0 }];
  let pages = 0, files = 0;
  const stats = { pages: 0, files: 0, errors: 0, filtered: 0 };

  const logout = opts.logoutPages || []; // pages the Grabber must never open (it would log the session out)
  const pathOk = u => {
    const s = u.hostname + u.pathname;
    if (logout.some(p => U.globMatch(p, s) || U.globMatch(p, u.href))) return false;
    if (exclude.some(p => U.globMatch(p, s) || U.globMatch(p, u.href))) return false;
    if (include.length && !include.some(p => U.globMatch(p, s) || U.globMatch(p, u.href))) return false;
    return true;
  };

  const handleFile = async (u, ext, from) => {
    let size = null;
    if (wantSize) {
      size = await headSize(u.href, { proxy, signal, headers });
      if (size != null && ((opts.minSize > 0 && size < opts.minSize) || (opts.maxSize > 0 && size > opts.maxSize))) { stats.filtered++; return; }
    }
    const name = decodeURIComponent(path.basename(u.pathname) || u.hostname);
    if (opts.hideDuplicates) { const k = name + '|' + size; if (seenNameSize.has(k)) { stats.filtered++; return; } seenNameSize.add(k); }
    files++; stats.files++;
    if (onFile) onFile({ url: u.href, name, ext, size, referer: from, local: mirror ? localPath(opts.saveRoot, u.href, false) : null });
  };

  while (queue.length && pages < maxPages && files < maxFiles && !signal.aborted) {
    const batch = queue.splice(0, Math.max(1, Math.min(10, opts.exploreConcurrent || 4)));
    await Promise.all(batch.map(async item => {
      try {
        const page = await fetchPage(item.url, { proxy, signal, headers });
        pages++; stats.pages++;
        let local = null;
        if (mirror && page.body != null) {
          local = localPath(opts.saveRoot, item.url, true);
          fs.mkdirSync(path.dirname(local), { recursive: true });
          fs.writeFileSync(local, page.body);
        }
        if (onPage) onPage(item.url, stats, local);
        if (page.body == null) return;
        for (const link of extractLinks(page.body, item.url, { scripts: opts.scanScripts !== false })) {
          if (signal.aborted) return;
          const u = new URL(link);
          const ext = path.extname(u.pathname).slice(1).toLowerCase();
          const same = sameSite(u);
          if (PAGE_EXT.has(ext)) {
            const lvl = item.level + 1, other = same ? item.other : item.other + 1;
            if (logout.some(p => U.globMatch(p, u.hostname + u.pathname) || U.globMatch(p, u.href))) continue;
            if (!pathOk(u) && !same) continue;
            if (opts.noParent && same && !u.pathname.startsWith(baseDir)) continue;
            if (!same && other > levelsOther) continue;
            if (same && lvl > levelsThis) continue;
            if (!seenPages.has(u.href) && seenPages.size < maxPages * 4) { seenPages.add(u.href); queue.push({ url: u.href, level: lvl, other }); }
          } else {
            if (exts.size && !exts.has(ext)) continue;
            if (opts.sameSiteOnly && !same) continue;
            if (!pathOk(u) || seenFiles.has(u.href)) continue;
            seenFiles.add(u.href);
            await handleFile(u, ext, item.url);
          }
        }
      } catch (e) { if (!signal.aborted) stats.errors++; }
    }));
  }
  return stats;
}

/**
 * Offline browsing: rewrite links in saved pages. Targets that were saved (pages or chosen files) become
 * relative paths; everything else becomes an absolute internet link.
 */
function convertLinks(pages, files) {
  const map = new Map();
  for (const p of pages) map.set(p.url.split('#')[0], p.local);
  for (const f of files) if (f.local) map.set(f.url, f.local);
  let converted = 0;
  for (const p of pages) {
    if (!p.local || !fs.existsSync(p.local)) continue;
    const dir = path.dirname(p.local);
    const fix = (v, hash) => {
      let u;
      try { u = new URL(v.replace(/&amp;/g, '&'), p.url); } catch { return null; }
      if (!/^https?:$/.test(u.protocol)) return null;
      const key = u.href.split('#')[0], target = map.get(key);
      if (target) return path.relative(dir, target).split(path.sep).map(encodeURIComponent).join('/') + (hash || u.hash || '');
      return u.href;
    };
    const html = fs.readFileSync(p.local, 'utf8')
      .replace(ATTR, (all, attr, eq, q, v) => { const r = fix(v); return r == null ? all : `${attr}${eq}${q}${r}${q}`; })
      .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (all, q, v) => { const r = fix(v); return r == null ? all : `url(${q}${r}${q})`; });
    fs.writeFileSync(p.local, html);
    converted++;
  }
  return converted;
}

module.exports = { explore, extractLinks, localPath, convertLinks, TEMPLATES };
