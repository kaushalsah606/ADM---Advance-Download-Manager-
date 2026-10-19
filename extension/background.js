'use strict';
// Talks only to the local Advance Download Manager server (127.0.0.1). It pairs itself: it asks the app, the user presses Allow once in the app,
// and the app hands the extension its API token. (A token can still be pasted by hand in Options.)
const DEFAULTS = {
  enabled: true, videoButton: true, port: 6800, token: '', pairState: 'offline', minSizeKB: 0,
  types: 'zip rar 7z exe msi iso pdf mp3 mp4 mkv avi mov apk dmg gz tar m4a flac wav webm'.split(' '),
};
const media = new Map(); // tabId -> Map(url -> item)

const cfg = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) });

// ---- pairing ----
const PORTS = [6800, 6810, 6811, 6812, 6813, 6814, 6815, 6816, 6817, 6818, 6819];
const browserName = () => (/Firefox\//.test(navigator.userAgent) ? 'Firefox' : /Edg\//.test(navigator.userAgent) ? 'Edge' : 'Chrome');
let pairing = null;
/** Ask the app for the token. Returns 'connected' | 'waiting' (the user has not pressed Allow yet) | 'denied' | 'offline'. */
function pairNow() {
  if (pairing) return pairing;
  pairing = (async () => {
    const c = await cfg();
    for (const port of [c.port, ...PORTS.filter(p => p !== c.port)]) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/pair`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Advance Download Manager Integration', browser: browserName() }),
        });
        if (r.status === 200) { const j = await r.json(); await chrome.storage.local.set({ port: j.port, token: j.token, pairState: 'connected' }); return 'connected'; }
        if (r.status === 202) { const j = await r.json(); const st = j.denied ? 'denied' : 'waiting'; await chrome.storage.local.set({ port, pairState: st }); return st; }
      } catch { /* nothing listening on this port */ }
    }
    await chrome.storage.local.set({ pairState: 'offline' });
    return 'offline';
  })().finally(() => { pairing = null; });
  return pairing;
}
// keep trying (once a minute) until connected; also at install and browser start
chrome.alarms.create('adm-pair', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async a => { if (a.name === 'adm-pair') { const c = await cfg(); if (!c.token) pairNow(); } });
chrome.runtime.onStartup.addListener(() => { pairNow(); });

async function send(url, referrer, extra = {}) {
  let c = await cfg();
  if (!c.token) {
    const st = await pairNow();
    if (st !== 'connected') { badge(st === 'waiting' ? 'ALLOW' : 'OFF', '#c62828'); return false; }
    c = await cfg();
  }
  let cookie = '';
  try { cookie = (await chrome.cookies.getAll({ url })).map(k => `${k.name}=${k.value}`).join('; '); } catch { /* optional */ }
  try {
    const r = await fetch(`http://127.0.0.1:${c.port}/api/propose`, { // the app shows "Download File Info" (or starts at once if the user turned that off)
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': c.token },
      body: JSON.stringify({ url, referer: referrer || '', cookie, startNow: true, queue: null, source: 'browser', ...extra }),
    });
    badge(r.ok ? 'OK' : 'ERR', r.ok ? '#16874a' : '#c62828');
    return r.ok;
  } catch { badge('OFF', '#c62828'); return false; }
}
function badge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
}

async function call(path, body) {
  const c = await cfg();
  const r = await fetch(`http://127.0.0.1:${c.port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': c.token }, body: JSON.stringify(body) });
  if (r.status === 401) { await chrome.storage.local.set({ token: '', pairState: 'offline' }); pairNow(); } // token changed: pair again
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// 1) take over downloads. Advance Download Manager decides (File Types tab: extensions, MIME types, excluded sites and addresses);
//    if it is not running the browser keeps the download.
chrome.downloads.onCreated.addListener(async item => {
  const c = await cfg();
  const url = item.finalUrl || item.url;
  if (!c.enabled || !/^(https?|ftp):/i.test(url)) return;
  if (!c.token) { pairNow(); return; } // not connected yet: the browser keeps this download
  if (c.minSizeKB && item.fileSize > 0 && item.fileSize < c.minSizeKB * 1024) return;
  let verdict;
  try { verdict = await call('/api/capture-check', { url, mime: item.mime || '', size: item.fileSize || 0, extraTypes: c.types }); } catch { return; }
  if (!verdict.capture) return;
  const ok = await send(url, item.referrer);
  if (ok) { try { await chrome.downloads.cancel(item.id); await chrome.downloads.erase({ id: item.id }); } catch { /* ignore */ } }
});

// "Download all links": collect every link on the page and let Advance Download Manager show its selection dialog
async function collectLinks(tab) {
  const c = await cfg();
  if (!c.token) { await pairNow(); return badge('ALLOW', '#c62828'); }
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => [...document.querySelectorAll('a[href]')].map(a => ({ url: a.href, text: (a.textContent || a.title || '').trim() })),
  });
  try {
    const r = await call('/api/collect', { links: result, referer: tab.url, title: tab.title });
    chrome.tabs.create({ url: `http://127.0.0.1:${c.port}/#collect=${r.id}` });
  } catch { badge('OFF', '#c62828'); }
}

// "Download this video": hand the page of a video to the app. yt-dlp (inside the app) reads it and offers the qualities; the browser's cookies for the site
// are sent along so videos that need a login (private, age-restricted, Instagram ...) work.
async function cookiesFor(urls) {
  const seen = new Map();
  for (const u of urls.slice(0, 3)) {
    try { for (const k of await chrome.cookies.getAll({ url: u })) seen.set(k.domain + '|' + k.path + '|' + k.name, { name: k.name, value: k.value, domain: k.domain, path: k.path, secure: k.secure, httpOnly: k.httpOnly, expirationDate: k.expirationDate }); } catch { /* optional */ }
  }
  return [...seen.values()].slice(0, 400);
}
async function sendVideo({ urls, title, tabId, tabUrl }) {
  let c = await cfg();
  if (!c.token) { const st = await pairNow(); if (st !== 'connected') { badge(st === 'waiting' ? 'ALLOW' : 'OFF', '#c62828'); return { ok: false, message: st === 'waiting' ? 'Press Allow in Advance Download Manager' : 'Advance Download Manager is not running' }; } c = await cfg(); }
  const list = [...new Set([...(urls || []), tabUrl].filter(u => /^https?:/i.test(u || '')))].slice(0, 4);
  if (!list.length) return { ok: false, message: 'No page address' };
  try {
    const r = await call('/api/video/open', {
      urls: list, title: title || '', referer: tabUrl || list[0], userAgent: navigator.userAgent, source: 'browser',
      cookies: await cookiesFor(list), media: [...((media.get(tabId) || new Map()).values())].slice(0, 12),
    });
    badge('OK', '#16874a');
    return { ok: true, id: r.id };
  } catch { badge('OFF', '#c62828'); return { ok: false, message: 'Advance Download Manager is not running' }; }
}

// 2) sniff media (video / audio / HLS) per tab, like a media panel on web players
chrome.webRequest.onHeadersReceived.addListener(d => {
  if (d.tabId < 0 || d.statusCode >= 400) return;
  const h = n => (d.responseHeaders.find(x => x.name.toLowerCase() === n) || {}).value || '';
  const type = h('content-type').toLowerCase(), len = +h('content-length') || 0;
  const path = (() => { try { return new URL(d.url).pathname.toLowerCase(); } catch { return ''; } })();
  const isHls = /mpegurl/.test(type) || path.endsWith('.m3u8');
  const big = len === 0 || len > 300 * 1024;
  const isMedia = isHls || ((type.startsWith('video/') || type.startsWith('audio/')) && big) || (/\.(mp4|webm|mkv|mp3|m4a|flv)$/.test(path) && len > 300 * 1024);
  if (!isMedia) return;
  if (!media.has(d.tabId)) media.set(d.tabId, new Map());
  const m = media.get(d.tabId);
  if (!m.has(d.url)) m.set(d.url, { url: d.url, type: isHls ? 'HLS stream' : type, size: len, at: Date.now() });
  chrome.action.setBadgeBackgroundColor({ tabId: d.tabId, color: '#1769e0' });
  chrome.action.setBadgeText({ tabId: d.tabId, text: String(m.size) });
}, { urls: ['<all_urls>'] }, ['responseHeaders']);
chrome.tabs.onRemoved.addListener(id => media.delete(id));
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === 'loading' && info.url) { media.delete(id); chrome.action.setBadgeText({ tabId: id, text: '' }); }
});

// 3) context menu + popup messaging
// links to video pages (YouTube, TikTok, Facebook, Instagram, ...) are sent as videos: the app then offers the qualities
const VIDEO_PAGE = /^https?:\/\/([\w-]+\.)*(youtube\.com\/(watch\?|shorts\/|live\/)|youtu\.be\/|tiktok\.com\/(@[\w.-]+\/video\/|v\/)|facebook\.com\/(watch|reel|[^/]+\/videos)|fb\.watch\/|instagram\.com\/(reels?|p|tv)\/|(twitter|x)\.com\/\w+\/status\/|vimeo\.com\/\d+|dailymotion\.com\/video\/|reddit\.com\/r\/\w+\/comments\/|twitch\.tv\/(videos|clip))/i;
const looksLikeUrl = t => /^https?:\/\/\S+$/i.test(String(t || '').trim());
function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({ id: 'sg-sel', title: 'Download selected link with Advance Download Manager', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'sg-link', title: 'Download with Advance Download Manager', contexts: ['link', 'video', 'audio', 'image'] });
  chrome.contextMenus.create({ id: 'sg-all', title: 'Download all links with Advance Download Manager', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'sg-video', title: 'Download video from this page with Advance Download Manager', contexts: ['page', 'video'] });
  });
}
chrome.runtime.onInstalled.addListener(() => { pairNow(); buildMenus(); });
chrome.runtime.onStartup.addListener(buildMenus);
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'sg-all') return collectLinks(tab);
  if (info.menuItemId === 'sg-video') return sendVideo({ urls: [info.frameUrl, info.pageUrl], title: tab && tab.title, tabId: tab && tab.id, tabUrl: tab && tab.url });
  if (info.menuItemId === 'sg-sel') { const t = String(info.selectionText || '').trim(); if (looksLikeUrl(t)) return VIDEO_PAGE.test(t) ? sendVideo({ urls: [t], title: tab && tab.title, tabId: tab && tab.id, tabUrl: tab && tab.url }) : send(t, info.pageUrl || (tab && tab.url)); return; }
  const url = info.linkUrl || info.srcUrl;
  if (!url) return;
  if (info.linkUrl && VIDEO_PAGE.test(info.linkUrl)) return sendVideo({ urls: [info.linkUrl, info.pageUrl], title: tab && tab.title, tabId: tab && tab.id, tabUrl: tab && tab.url });
  send(url, info.pageUrl || (tab && tab.url));
});
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'media') { reply([...(media.get(msg.tabId) || new Map()).values()]); return; }
  if (msg.type === 'collect') { collectLinks(msg.tab).then(() => reply(true)); return true; }
  if (msg.type === 'video') { sendVideo({ urls: msg.urls, title: msg.title, tabId: sender.tab && sender.tab.id, tabUrl: sender.tab && sender.tab.url }).then(reply); return true; }
  if (msg.type === 'videoPage') { sendVideo({ urls: [msg.tab.url], title: msg.tab.title, tabId: msg.tab.id, tabUrl: msg.tab.url }).then(reply); return true; }
  if (msg.type === 'pair') { pairNow().then(reply); return true; }
  if (msg.type === 'send') { send(msg.url, msg.referrer).then(reply); return true; }
});
