'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { Download } = require('./download');
const { VideoDownload } = require('./videodownload');
const video = require('./video');
const youtube = require('./youtube');
const { Limiter } = require('./limiter');
const U = require('./util');
const hls = require('./hls');
const dash = require('./dash');
const rtmpLib = require('./rtmp');

const DL_ROOT = process.env.ADM_DOWNLOAD_ROOT || path.join(os.homedir(), 'Downloads'); // every file goes straight into the Downloads folder // the environment variable is for tests

const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const defaultCategories = () => [
  { id: 'general', name: 'General', exts: [], dir: DL_ROOT },
  { id: 'compressed', name: 'Compressed', exts: 'zip rar 7z gz tar bz2 xz iso cab arj'.split(' '), dir: DL_ROOT },
  { id: 'documents', name: 'Documents', exts: 'doc docx pdf xls xlsx ppt pptx txt epub csv rtf'.split(' '), dir: DL_ROOT },
  { id: 'music', name: 'Music', exts: 'mp3 wav flac aac ogg m4a wma'.split(' '), dir: DL_ROOT },
  { id: 'programs', name: 'Programs', exts: 'exe msi dmg apk deb rpm appx msix'.split(' '), dir: DL_ROOT },
  { id: 'video', name: 'Video', exts: 'mp4 mkv avi mov wmv flv webm mpg mpeg m4v'.split(' '), dir: DL_ROOT },
];

const defaultQueues = () => [
  { id: 'main', name: 'Main download queue', type: 'download', parallel: 2, startAt: '', stopAt: '', days: [0, 1, 2, 3, 4, 5, 6],
    periodMinutes: 0, maxRetries: 0, onDone: { exit: false, shutdown: false, force: false, hangup: false, command: '' }, scheduled: false },
  { id: 'sync', name: 'Main synchronization queue', type: 'sync', parallel: 2, startAt: '', stopAt: '', days: [0, 1, 2, 3, 4, 5, 6],
    periodMinutes: 60, maxRetries: 0, onDone: { exit: false, shutdown: false, command: '' }, scheduled: false },
];

const defaultSettings = () => ({
  updates: { check: true, repo: 'kaushalsah606/ADM---Advance-Download-Manager-', apiBase: '' }, // apiBase: test hook, empty = GitHub
  maxConnections: 16,         // parallel connections per download (1-32); 16 saturates most links
  autoTune: true,             // find the best number of connections by measuring the speed (see src/tuner.js); false = the fixed ramp-up
  turbo: false,               // Turbo mode: no speed limits, up to turboConnections connections opened at once
  turboConnections: 32,       // connections used in Turbo mode (2-64)
  minSplitBytes: 64 * 1024,   // do not split segments smaller than 2x this
  maxSegmentErrors: 12,
  rampMs: 500,                // min. time between opening more connections (normal mode)
  ffmpeg: 'ffmpeg',           // used to merge DASH video + audio (string, or [exe, ...args-prefix])
  gentleRamp: false,          // slower 2->3, 4->6, 6->8 ramp instead of doubling
  rejectHtmlForFiles: true,   // a text/html answer for a .zip/.exe/... link is an error page, not the file 
  browserHeaders: true,       // Accept-Language, Accept-Charset: *, Origin (derived from the referer) like a browser
  verifyOverlap: true,        // compare 64 overlapping bytes at resume points and segment boundaries (corruption guard)
  timeoutMs: 30000,
  retryIntervalMs: 30000,     // retry a lone failed file every 30 s
  ignoreModTime: false,
  speedLimit: 0,              // bytes / s for the global Speed Limiter
  limiterOn: true,            // Downloads > Speed Limiter > Turn on/off
  limiterOnStartup: true,     // "Always turn on the speed limiter at startup"
  quota: { enabled: false, bytes: 0, windowMs: 3600000 },
  // none | system | manual; per-protocol proxies; SOCKS used only for protocols without their own proxy
  proxy: { mode: 'none', pacUrl: '', http: { host: '', port: 8080, user: '', pass: '' }, https: { host: '', port: 8080, user: '', pass: '' },
    ftp: { host: '', port: 8080, user: '', pass: '' }, socks: { host: '', port: 1080, user: '', pass: '', version: 5 }, bypass: [] },
  siteLogins: [],             // [{pattern, user, pass}]
  exceptions: [],             // [{pattern, connections}]  per-server connection caps
  noTakeoverSites: [],        // "Don't start downloading automatically from the following sites"
  excludeAddresses: [         // ... and addresses (wildcards). Starter set; extend as needed
    '*/sounds/*.mp3', '*://*.gstatic.com/*/sounds/*', '*://*.download.windowsupdate.com/*', '*/audio/*.ogg',
  ],
  // default "automatically start downloading" extensions
  fileTypes: '3gp 7z aac ace aif apk arj asf avi bin bz2 doc docx exe flv gz gzip img iso lzh m4a m4v mkv mov mp3 mp4 mpa mpe mpeg mpg msi msu ogg ogv pdf plj pps ppt qt ra rar rm rmvb sea sit sitx tar tif tiff wav wma wmv z zip'.split(' '),
  // MIME types recognised as media/downloads
  mediaTypes: ['video/mp4', 'video/webm', 'video/x-flv', 'video/flv', 'video/mpeg', 'video/quicktime', 'video/x-msvideo', 'video/x-ms-wmv',
    'video/x-ms-asf', 'video/x-m4v', 'video/MP2T', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/x-wav', 'audio/wav',
    'audio/x-ms-wma', 'application/vnd.apple.mpegurl', 'application/x-mpegURL', 'application/dash+xml', 'application/zip', 'application/x-rar-compressed',
    'application/x-msdownload', 'application/x-msi', 'application/pdf', 'application/x-gzip', 'application/x-tar'],
  // Dial Up / VPN (Windows RAS phone-book entry); connected on demand with redial
  dialup: { enabled: false, entry: '', user: '', pass: '', redialAttempts: 3, redialSeconds: 10 },
  captureProxy: { enabled: false, port: 6801 }, // user-mode capture proxy (plain HTTP), see src/captureproxy.js
  trayIcon: true,             // Windows notification-area icon (started by the launcher)
  userAgent: '',
  onCompleteCommand: '',      // virus scanner: file path is appended unless args contain {file}
  onCompleteArgs: '',
  tempDir: '',                // "Temporary directory" for file parts
  setFileDate: true,          // "Set file creation date as provided by the server"
  duplicatePolicy: 'ask',     // ask | number | overwrite | resume   ("Duplicate download link")
  addOnly: false,             // "Do not start downloading, only add files to the queue"
  clipboardMonitor: false,    // browser page only: automatically start downloading URLs placed on the clipboard
  video: { cookiesBrowser: '', ytdlpPath: '', ffmpegPath: '', concurrentFragments: 8, maxHeight: 0, autoUpdate: true, lastUpdateCheck: 0 }, // "Download this video" (yt-dlp + FFmpeg); maxHeight 0 = best
  confirmDownloads: true,     // captured downloads (browser, clipboard, capture proxy) open the "Download File Info" dialog first instead of starting silently
  clipboardOffer: true,       // native app: offer (never auto-start) to download links copied to the clipboard
  systemCapture: false,       // Windows: route plain-HTTP downloads of every app through the capture proxy (see src/syscapture.js)
  pairedExtensions: [],       // browser extensions the user has allowed to connect: [{ origin, name, browser, since }]
  sounds: { complete: true, error: true },
  grabberFilters: [
    { name: 'Pictures', mask: 'jpg,jpeg,png,gif,bmp,webp' }, { name: 'Video', mask: 'mp4,mkv,avi,mov,wmv,flv,webm,mpg' },
    { name: 'Audio', mask: 'mp3,wav,flac,aac,ogg,m4a,wma' }, { name: 'Documents', mask: 'pdf,doc,docx,xls,xlsx,ppt,pptx,txt' },
    { name: 'Archives', mask: 'zip,rar,7z,gz,tar,iso' }, { name: 'Programs', mask: 'exe,msi,apk,dmg' },
  ],
  grabberTemplates: [],       // user templates saved from the wizard
});

/** Deep-merge saved/posted settings over the defaults so partial or legacy objects never break the UI. */
function normalizeSettings(raw) {
  const d = defaultSettings();
  const s = { ...d, ...(raw || {}) };
  const obj = (def, v) => ({ ...def, ...(v && typeof v === 'object' && !Array.isArray(v) ? v : {}) });
  s.pairedExtensions = (Array.isArray(s.pairedExtensions) ? s.pairedExtensions : []).filter(p => p && typeof p.origin === 'string' && /^(chrome|moz|edge)-extension:\/\//.test(p.origin))
    .map(p => ({ origin: p.origin, name: String(p.name || 'Browser extension').slice(0, 60), browser: String(p.browser || '').slice(0, 20), since: +p.since || Date.now() }));
  s.systemCapture = s.systemCapture === true;
  s.confirmDownloads = s.confirmDownloads !== false;
  s.video = obj(d.video, s.video);
  s.video.cookiesBrowser = /^(edge|chrome|firefox|brave|opera|vivaldi|chromium)$/.test(s.video.cookiesBrowser) ? s.video.cookiesBrowser : '';
  s.video.concurrentFragments = Math.max(1, Math.min(32, Math.round(+s.video.concurrentFragments) || 8));
  s.video.maxHeight = Math.max(0, Math.round(+s.video.maxHeight) || 0);
  s.video.autoUpdate = s.video.autoUpdate !== false;
  s.clipboardOffer = s.clipboardOffer !== false;
  s.autoTune = s.autoTune !== false;
  s.turbo = s.turbo === true;
  s.turboConnections = Math.max(2, Math.min(64, Math.round(+s.turboConnections) || d.turboConnections));
  s.quota = obj(d.quota, s.quota);
  s.dialup = obj(d.dialup, s.dialup);
  s.sounds = obj(d.sounds, s.sounds);
  const p = s.proxy && typeof s.proxy === 'object' ? s.proxy : {};
  const proxy = { ...d.proxy, ...p };
  for (const k of ['http', 'https', 'ftp', 'socks']) proxy[k] = obj(d.proxy[k], p[k]);
  if (!p.mode) { // legacy single-proxy format {enabled, host, port, user, pass}
    if (p.enabled && p.host) { proxy.mode = 'manual'; const one = { host: p.host, port: p.port || 8080, user: p.user || '', pass: p.pass || '' }; proxy.http = obj(d.proxy.http, one); proxy.https = obj(d.proxy.https, one); } else proxy.mode = 'none';
  }
  proxy.bypass = Array.isArray(proxy.bypass) ? proxy.bypass : [];
  s.proxy = proxy;
  return s;
}

class Manager extends EventEmitter {
  constructor({ dataDir } = {}) {
    super();
    this.dataDir = dataDir || path.join(os.homedir(), '.advance-download-manager');
    this.file = path.join(this.dataDir, 'state.json');
    this.settings = defaultSettings();
    this.categories = defaultCategories();
    this.queues = defaultQueues();
    this.projects = [];
    this.downloads = new Map(); // id -> Download
    this.limiter = new Limiter();
    this.runners = new Map();   // queue id -> {stop:false}
    this._saveTimer = null;
    this._lastScheduleKey = new Map();
  }

  /** Stable API token (so a browser extension can be configured once). */
  token() {
    const f = path.join(this.dataDir, 'token');
    try { return fs.readFileSync(f, 'utf8').trim(); } catch { /* create */ }
    const t = crypto.randomBytes(18).toString('hex');
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(f, t, { mode: 0o600 });
    return t;
  }

  // ---------- lifecycle / persistence ----------
  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.settings = normalizeSettings(s.settings);
        if (s.categories) this.categories = s.categories.map(c => (c && c.dir && sameDir(c.dir, path.join(os.homedir(), 'Downloads', 'Advance Download Manager', c.name)) ? { ...c, dir: DL_ROOT } : c)); // folders of the old defaults move to the plain Downloads folder; folders you chose stay
        if (s.queues) this.queues = s.queues;
        this.projects = s.projects || [];
        for (const rec of s.downloads || []) {
          if (rec.status === 'downloading') rec.status = 'paused'; // crashed mid-download; positions are saved
          this._register(rec);
        }
      } catch (e) { console.error('Could not read state, starting fresh:', e.message); }
    }
    if (this.settings.limiterOnStartup) this.settings.limiterOn = true; // "Always turn on Speed Limiter on startup"
    this.limiter.configure({ speedLimit: this.settings.limiterOn ? this.settings.speedLimit : 0, quota: this.settings.quota });
    this._refreshPac();
    this.refreshVideoTools().catch(() => {});
    setTimeout(() => this._autoUpdateVideoEngine().catch(() => {}), 45000).unref();
    this._timers = [
      setInterval(() => this._refreshPac(), 15 * 60 * 1000),
      setInterval(() => this._tick(), 1000),
      setInterval(() => this._scheduleTick(), 15000),
    ];
    for (const t of this._timers) t.unref();
    return this;
  }

  async shutdown() {
    for (const t of this._timers || []) clearInterval(t);
    await this.stopAll();
    this.saveNow();
  }

  save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.saveNow(); }, 1500);
    this._saveTimer.unref();
  }

  saveNow() {
    clearTimeout(this._saveTimer); this._saveTimer = null;
    const data = {
      settings: this.settings, categories: this.categories, queues: this.queues,
      projects: this.projects.map(({ running, job, _key, ...p }) => p),
      downloads: [...this.downloads.values()].map(d => d.rec),
    };
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.file);
  }

  _tick() {
    let active = false;
    for (const d of this.downloads.values()) {
      if (d.running) { d.sample(); active = true; this.emit('update', this.view(d)); }
    }
    if (active) this.save();
  }

  // ---------- views ----------
  view(d) {
    const r = d.rec;
    const done = d.downloaded();
    // HLS has no known length up front: estimate it from bytes per segment so far
    const pg = d.progress();
    const size = pg ? pg.size : r.size;
    const left = size != null ? Math.max(0, size - done) : null;
    return {
      id: r.id, url: r.url, fileName: r.fileName, saveDir: r.saveDir, category: r.category, queue: r.queue,
      description: r.description || '', status: r.status, error: r.error, size, sizeEstimated: !!(r.hls || r.dash), kind: r.kind || 'file', resumable: r.resumable,
      done, speed: Math.round(d.speed), conns: d.conns,
      eta: d.running && d.speed > 1 && left != null ? Math.round(left / d.speed) : null,
      added: r.added, completed: r.completed || null, retryAt: r.retryAt || 0,
      warning: r.warning || '', referer: r.referer || '', authRealm: r.status === 'error' ? r.authRealm : null, lastTry: r.lastTry || 0, speedLimit: r.speedLimit || 0, afterDone: r.afterDone || null,
      segments: r.size && r.segments && !r.hls && !r.dash ? r.segments.map(g => [g.s, g.p, g.e]) : [],
    };
  }

  snapshot() {
    return {
      downloads: [...this.downloads.values()].map(d => this.view(d)),
      categories: this.categories, queues: this.queues.map(q => ({ ...q, running: this.runners.has(q.id) })),
      settings: this.settings, projects: this.projects,
      quotaWaitUntil: this.limiter.waitingUntil,
      pendingPairs: [...(this.pendingPairs ? this.pendingPairs.values() : [])],
      proposals: [...(this.proposals ? this.proposals.values() : [])].map(p => this.proposalView(p)),
      videoRequests: [...(this.videoRequests ? this.videoRequests.values() : [])].map(r => this.videoView(r)),
      videoTools: this.videoToolsInfo(),
    };
  }

  // ---------- "Download this video": yt-dlp reads the video page, the user picks a quality, yt-dlp downloads ----------
  videoToolsInfo() {
    return this._videoTools || { ytdlp: { installed: false, version: '' }, ffmpeg: { installed: false, version: '' }, dir: video.toolsDir(), installing: null, error: '', sizes: { ytdlp: video.SOURCES.ytdlp.approxMB, ffmpeg: video.SOURCES.ffmpeg.approxMB } };
  }

  async refreshVideoTools() {
    const s = this.settings.video || {};
    const yt = video.resolveTool('yt-dlp', s.ytdlpPath), ff = video.resolveTool('ffmpeg', s.ffmpegPath);
    const [yv, fv] = await Promise.all([video.toolVersion(yt), video.toolVersion(ff)]);
    const prev = this.videoToolsInfo();
    const next = { ytdlp: { installed: !!yt && !!yv, version: yv, path: yt ? yt[0] : '' }, ffmpeg: { installed: !!ff && !!fv, version: fv, path: ff ? ff[0] : '' }, dir: video.toolsDir(), installing: prev.installing, error: prev.error, sizes: prev.sizes };
    if (JSON.stringify(next) !== JSON.stringify(prev)) { this._videoTools = next; this.emit('settings'); } else this._videoTools = next;
    return next;
  }

  /** Download and verify yt-dlp and / or FFmpeg. Returns at once; progress is in videoToolsInfo().installing. */
  installVideoTools(which) {
    const list = [].concat(which || []).filter(x => x === 'ytdlp' || x === 'ffmpeg');
    if (!list.length) throw Object.assign(new Error('Nothing to install'), { status: 400 });
    if (this._vtInstalling) return { started: false, busy: true };
    this._vtInstalling = true;
    this._videoTools = { ...this.videoToolsInfo(), installing: { tool: '', received: 0, total: 0 }, error: '' };
    let lastEmit = 0;
    this.emit('settings');
    video.install(list, { onProgress: p => { this._videoTools.installing = p; if (Date.now() - lastEmit > 400) { lastEmit = Date.now(); this.emit('settings'); } } })
      .then(async () => { this._vtInstalling = false; this._videoTools = { ...this._videoTools, installing: null, error: '' }; await this.refreshVideoTools(); this.emit('settings'); this._reprobeVideoRequests(); })
      .catch(e => { this._vtInstalling = false; this._videoTools = { ...this._videoTools, installing: null, error: e.message }; this.emit('settings'); });
    return { started: true };
  }

  async updateVideoEngine() {
    const own = path.join(video.toolsDir(), video.exe('yt-dlp'));
    const shipped = path.join(video.bundledDir(), video.exe('yt-dlp'));
    if (!fs.existsSync(own) && fs.existsSync(shipped)) { fs.mkdirSync(path.dirname(own), { recursive: true }); fs.copyFileSync(shipped, own); } // the installed app folder is read-only: update a copy in the user's folder
    if (!fs.existsSync(own)) throw Object.assign(new Error('The video engine was not installed by this app; update it with its own installer (for example: pip install -U yt-dlp)'), { status: 409 });
    if ([...this.downloads.values()].some(d => d.rec.kind === 'video' && d.running)) throw Object.assign(new Error('Wait until the running video downloads are finished'), { status: 409 });
    const output = await video.updateYtDlp([own]);
    this.setSettings({ video: { ...this.settings.video, lastUpdateCheck: Date.now() } });
    await this.refreshVideoTools();
    return { output };
  }

  async _autoUpdateVideoEngine() {
    const s = this.settings.video;
    if (!s.autoUpdate || Date.now() - s.lastUpdateCheck < 3 * 86400000) return;
    try { await this.updateVideoEngine(); } catch { this.setSettings({ video: { ...this.settings.video, lastUpdateCheck: Date.now() } }); }
  }

  /** From the browser extension (the "Download this video" button) or the UI: addresses of a page with a video, plus the browser's cookies for it. */
  videoOpen(o) {
    const urls = [...new Set([].concat(o.urls || [], o.url || []).map(u => String(u).trim()).filter(video.validUrl))].slice(0, 4);
    if (!urls.length) throw Object.assign(new Error('There is no web address to read a video from'), { status: 400 });
    this.videoRequests = this.videoRequests || new Map();
    const same = [...this.videoRequests.values()].find(r => r.urls[0] === urls[0]);
    if (same) return { id: same.id, existing: true };
    const id = crypto.randomUUID();
    const r = {
      id, urls, title: String(o.title || '').slice(0, 200), status: 'probing', error: null, info: null, source: String(o.source || ''), at: Date.now(),
      referer: String(o.referer || urls[0]).slice(0, 2000), userAgent: String(o.userAgent || '').slice(0, 400),
      media: (Array.isArray(o.media) ? o.media : []).filter(m => m && video.validUrl(m.url)).slice(0, 12).map(m => ({ url: m.url, type: String(m.type || '').slice(0, 60), size: +m.size || 0 })),
    };
    const cookies = (Array.isArray(o.cookies) ? o.cookies : []).slice(0, 500);
    if (cookies.length) { r.cookieFile = path.join(this.dataDir, 'cookies', id + '.txt'); video.writeCookieFile(r.cookieFile, cookies); }
    this.videoRequests.set(id, r);
    if (this.videoRequests.size > 20) { const old = this.videoRequests.keys().next().value; this.videoReject(old); }
    this.emit('video-request', id);
    this.emit('settings');
    this._probeVideo(r);
    return { id };
  }

  async _probeVideo(r) {
    const s = this.settings.video;
    const yt = video.resolveTool('yt-dlp', s.ytdlpPath);
    const ff = !!video.resolveTool('ffmpeg', s.ffmpegPath);
    const nativeOk = ff && s.nativeYoutube !== false && r.urls.some(u => youtube.videoId(u)); // YouTube is read through its player API first (no yt-dlp, no login)
    if (!yt && !nativeOk) { r.status = 'needs-tools'; this.emit('settings'); return; }
    r.status = 'probing'; r.error = null; this.emit('settings');
    let err = null;
    for (const u of r.urls) {
      if (nativeOk && youtube.videoId(u)) {
        try { r.info = await youtube.info(u, { ffmpeg: ff }); err = null; break; } catch (e) { err = e; if (['unavailable', 'live', 'geo'].includes(e.code)) break; }
      }
      if (!yt) continue;
      try { r.info = await video.info(u, { cmd: yt, ffmpeg: ff, cookieFile: r.cookieFile, userAgent: r.userAgent, referer: r.referer, cookiesBrowser: (this.settings.video || {}).cookiesBrowser }); err = null; break; } catch (e) { err = e; }
    }
    if (!this.videoRequests || !this.videoRequests.has(r.id)) return;
    if (err) { r.status = 'error'; r.error = { code: err.code || 'failed', message: err.message, hadCookies: !!r.cookieFile }; r.info = null; } else r.status = 'ready';
    this.emit('settings');
  }

  _reprobeVideoRequests() { for (const r of (this.videoRequests ? this.videoRequests.values() : [])) if (r.status === 'needs-tools' || r.status === 'error') this._probeVideo(r); }

  videoView(r) {
    const i = r.info;
    const dir = id => (this.categories.find(c => c.id === id) || this.categories[0]).dir;
    let defaultChoice = '';
    if (i) {
      const cap = this.settings.video.maxHeight;
      const pick = cap ? i.choices.filter(c => c.kind === 'video' && !c.best && c.height <= cap)[0] : null;
      defaultChoice = (pick || i.choices[0]).id;
    }
    return {
      id: r.id, urls: r.urls, title: i ? i.title : r.title, status: r.status, error: r.error, source: r.source, at: r.at, media: r.media,
      hasFfmpeg: !!video.resolveTool('ffmpeg', this.settings.video.ffmpegPath),
      dirs: { video: dir('video'), audio: dir('music') },
      info: i ? { title: i.title, extractor: i.extractor, uploader: i.uploader, duration: i.duration, thumbnail: i.thumbnail, moreWithFfmpeg: i.moreWithFfmpeg, defaultChoice,
        choices: i.choices.map(c => ({ id: c.id, label: c.label, detail: c.detail, size: c.size, kind: c.kind, needsFfmpeg: c.needsFfmpeg, best: !!c.best })) } : null,
    };
  }

  videoAccept(id, f = {}) {
    const r = this.videoRequests && this.videoRequests.get(id);
    if (!r || !r.info) throw Object.assign(new Error('This video request has expired'), { status: 404 });
    const view = this.videoView(r);
    const c = r.info.choices.find(x => x.id === (f.choiceId || view.info.defaultChoice));
    if (!c) throw Object.assign(new Error('Choose a quality'), { status: 400 });
    if (c.needsFfmpeg && !video.resolveTool('ffmpeg', this.settings.video.ffmpegPath)) throw Object.assign(new Error('FFmpeg is needed for this choice. Install it in Options → Video.'), { status: 409 });
    const later = f.action === 'later';
    const saveDir = String(f.saveDir || (c.kind === 'audio' ? view.dirs.audio : view.dirs.video)).trim();
    const clean = s => String(s || '').replace(/\.(mp4|mkv|webm|m4a|mp3|opus|ogg|mov)$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
    let base = clean(f.fileName) || clean(r.info.title) || 'video';
    const exts = ['mp4', 'mkv', 'webm', 'm4a', 'mp3', 'opus', 'ogg', 'mov'];
    const taken = b => exts.some(e => fs.existsSync(path.join(saveDir, b + '.' + e)));
    const root = base; // yt-dlp skips a file that already exists: pick a free name instead
    for (let n = 2; taken(base) && n < 500; n++) base = root + ' (' + n + ')';
    const ext = c.kind === 'audio' ? (c.audio === 'mp3' ? '.mp3' : '.m4a') : '.mp4';
    const cat = this.categories.find(x => x.id === (c.kind === 'audio' ? 'music' : 'video')) || this.categories[0];
    const out = this.add({
      url: r.info.webpageUrl, kind: 'video', fileName: base + ext, saveDir, category: cat.id, description: String(f.description || [c.label, r.info.uploader].filter(Boolean).join(' - ')).slice(0, 300),
      startNow: !later, queue: later ? 'main' : null, rememberPath: !!f.rememberPath, referer: r.referer,
      video: { pageUrl: r.info.webpageUrl, selector: c.selector, audio: c.audio || '', base, needsFfmpeg: c.needsFfmpeg, sizeEstimate: c.size || 0, label: c.label, title: r.info.title, cookieFile: r.cookieFile, userAgent: r.userAgent, referer: r.referer, variant: r.info.variant, withCookies: r.info.withCookies, native: r.info.native ? { id: r.info.id, ...c.native } : undefined },
    });
    this.videoRequests.delete(id);
    this.emit('settings');
    return { ok: true, download: out };
  }

  videoReject(id) {
    const r = this.videoRequests && this.videoRequests.get(id);
    if (!r) return false;
    this.videoRequests.delete(id);
    if (r.cookieFile) fs.rm(r.cookieFile, { force: true }, () => {});
    this.emit('settings');
    return true;
  }

  videoRetry(id) {
    const r = this.videoRequests && this.videoRequests.get(id);
    if (!r) throw Object.assign(new Error('This video request has expired'), { status: 404 });
    this._probeVideo(r);
    return true;
  }

  // ---------- "Download File Info": a captured download waits for the user's confirmation ----------
  /** Entry point for downloads the user did not type in (browser takeover, clipboard link, capture proxy). */
  propose(o) {
    if (!this.settings.confirmDownloads || o.confirm === false) return this.add({ ...o, startNow: o.startNow !== false });
    const url = String(o.url || '').trim();
    this.proposals = this.proposals || new Map();
    const same = [...this.proposals.values()].find(p => p.url === url);
    if (same) return { proposal: true, id: same.id };
    const rec = this._newRec({ ...o, queue: null }); // validates the address and derives name, category and folder
    const p = { id: crypto.randomUUID(), url, o: { ...o }, fileName: rec.fileName, category: rec.category, saveDir: rec.saveDir, size: null, contentType: '', status: 'probing', error: '', source: String(o.source || ''), at: Date.now() };
    this.proposals.set(p.id, p);
    if (this.proposals.size > 50) this.proposals.delete(this.proposals.keys().next().value);
    this.emit('proposal', p.id);
    this.emit('settings');
    this._probeProposal(p);
    return { proposal: true, id: p.id };
  }

  async _probeProposal(p) {
    try {
      const r = await Promise.race([this.probe({ ...p.o, url: p.url }), new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out reading the file information')), 20000))]);
      if (!this.proposals.has(p.id)) return;
      if (!p.o.fileName) p.fileName = r.fileName || p.fileName;
      if (!p.o.category) p.category = r.category || p.category;
      if (!p.o.saveDir) p.saveDir = r.saveDir || p.saveDir;
      p.size = r.size; p.contentType = r.contentType || '';
    } catch (e) { p.error = e.message; }
    p.status = 'ready';
    this.emit('settings');
  }

  proposalView(p) {
    let exists = false;
    try { exists = fs.existsSync(path.join(p.saveDir, p.fileName)); } catch { /* ignore */ }
    return {
      id: p.id, url: p.url, fileName: p.fileName, category: p.category, saveDir: p.saveDir, size: p.size, contentType: p.contentType, status: p.status, error: p.error,
      source: p.source, at: p.at, exists, inList: [...this.downloads.values()].some(d => d.rec.url === p.url),
    };
  }

  proposalAccept(id, f = {}) {
    const p = this.proposals && this.proposals.get(id);
    if (!p) throw Object.assign(new Error('This download request has expired'), { status: 404 });
    const later = f.action === 'later';
    const o = { ...p.o, url: p.url, fileName: f.fileName || p.fileName, category: f.category || p.category, saveDir: f.saveDir || p.saveDir };
    if (f.description !== undefined) o.description = String(f.description);
    if (f.duplicatePolicy && ['number', 'overwrite', 'resume'].includes(f.duplicatePolicy)) o.duplicatePolicy = f.duplicatePolicy; // chosen in the "Duplicate download link" dialog
    const r = this.add({ ...o, startNow: !later, queue: later ? 'main' : null, allowDuplicate: !!f.allowDuplicate, rememberPath: !!f.rememberPath });
    if (r.duplicate && !r.existing && !f.allowDuplicate) return { duplicate: true, existing: r }; // policy "ask": the dialog asks the user
    this.proposals.delete(id);
    this.emit('settings');
    return { ok: true, download: r };
  }

  proposalReject(id) {
    const had = !!(this.proposals && this.proposals.delete(id));
    if (had) this.emit('settings');
    return had;
  }

  previewProposal(id) {
    const p = this.proposals && this.proposals.get(id);
    if (!p) throw Object.assign(new Error('This download request has expired'), { status: 404 });
    return this.previewZip({ ...p.o, url: p.url });
  }

  // ---------- browser-extension pairing: the extension asks, the user allows once, then it receives the API token ----------
  pairRequest(origin, name, browser) {
    if ((this.settings.pairedExtensions || []).some(p => p.origin === origin)) return { approved: true };
    this.pendingPairs = this.pendingPairs || new Map();
    this.deniedPairs = this.deniedPairs || new Map();
    const deniedAt = this.deniedPairs.get(origin);
    if (deniedAt && Date.now() - deniedAt < 10 * 60 * 1000) return { approved: false, denied: true };
    if (!this.pendingPairs.has(origin)) {
      this.pendingPairs.set(origin, { origin, name: String(name || 'Browser extension').slice(0, 60), browser: String(browser || '').slice(0, 20), at: Date.now() });
      this.emit('pair-request', origin);
      this.emit('settings');
    }
    return { approved: false };
  }

  pairDecision(origin, allow) {
    const p = this.pendingPairs && this.pendingPairs.get(origin);
    if (!p) return false;
    this.pendingPairs.delete(origin);
    if (allow) this.setSettings({ pairedExtensions: [...this.settings.pairedExtensions.filter(x => x.origin !== origin), { origin, name: p.name, browser: p.browser, since: Date.now() }] });
    else { (this.deniedPairs = this.deniedPairs || new Map()).set(origin, Date.now()); this.emit('settings'); }
    return true;
  }

  pairRevoke(origin) {
    this.setSettings({ pairedExtensions: this.settings.pairedExtensions.filter(x => x.origin !== origin) });
    return true;
  }

  // ---------- helpers ----------
  categorize(rec) {
    const ext = path.extname(rec.fileName || '').slice(1).toLowerCase();
    let host = '';
    try { host = new URL(rec.url).hostname; } catch { /* ignore */ }
    const byId = this.categories.find(c => c.id === rec.category);
    // categories: file types, optionally restricted to the listed sites only
    const match = this.categories.find(c => c.exts.includes(ext) && (!(c.sites && c.sites.length) || c.sites.some(p => U.globMatch(p, host))));
    const cat = (rec.categoryFixed ? byId : match) || byId || this.categories[0];
    if (!rec.categoryFixed) { rec.category = cat.id; if (!rec.dirFixed) rec.saveDir = cat.dir; }
  }

  /** Should the browser extension hand this download to us? (File Types tab: types, excluded sites, addresses) */
  captureCheck({ url, mime = '', size = 0, extraTypes = [] }) {
    let u;
    try { u = new URL(url); } catch { return { capture: false, reason: 'bad url' }; }
    if (!/^(https?|ftp|rtmps?):$/.test(u.protocol)) return { capture: false, reason: 'protocol' };
    const s = this.settings;
    if ((s.noTakeoverSites || []).some(p => U.globMatch(p, u.hostname))) return { capture: false, reason: 'site excluded' };
    if ((s.excludeAddresses || []).some(p => U.globMatch(p, u.href) || U.globMatch(p, u.href.replace(/^https?:/, '*:')))) return { capture: false, reason: 'address excluded' };
    const ext = path.extname(u.pathname).slice(1).toLowerCase();
    if (ext && [...s.fileTypes, ...extraTypes].includes(ext)) return { capture: true, reason: 'file type' };
    const m = mime.split(';')[0].trim().toLowerCase();
    if (m && s.mediaTypes.some(t => t.toLowerCase() === m) && (!size || size > 0)) return { capture: true, reason: 'media type' };
    return { capture: false, reason: 'type not listed' };
  }

  uniqueName(dir, name, selfId) {
    const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
    const taken = n => {
      const p = path.join(dir, n);
      if (fs.existsSync(p) || fs.existsSync(p + '.sgpart')) return true;
      for (const d of this.downloads.values()) {
        if (d.rec.id !== selfId && d.rec.saveDir === dir && d.rec.fileName === n && d.rec.status !== 'complete') return true;
      }
      return false;
    };
    let n = name, i = 1;
    while (taken(n)) n = `${base}_${++i}${ext}`;
    return n;
  }

  _register(rec) {
    const Cls = rec.kind === 'video' ? VideoDownload : Download;
    const d = new Cls(rec, {
      settings: () => this.settings, limiter: this.limiter,
      uniqueName: (dir, name, id) => this.uniqueName(dir, name, id),
      categorize: r => this.categorize(r),
    });
    d.on('state', () => { this.emit('update', this.view(d)); this.save(); });
    d.on('end', () => this._onEnd(d));
    this.downloads.set(rec.id, d);
    return d;
  }

  _onEnd(d) {
    const r = d.rec;
    if (r.status === 'complete') {
      const q = this.queues.find(x => x.id === r.queue);
      if (q && q.type === 'download') r.queue = null; // finished files are removed from download queues
      r.syncedAt = Date.now();
      this._runCompleteHook(d);
      this.emit('complete', this.view(d));
      this._afterDone(d);
    } else if (r.status === 'error') {
      if (r.queue) {
        r.attempts = (r.attempts || 0) + 1;
        r.retryAt = Date.now() + this.settings.retryIntervalMs;
        r.order = this._maxOrder() + 1; // failed file goes to the end of the queue
      }
    }
    this.emit('update', this.view(d));
    this.saveNow();
  }

  _maxOrder() { let m = 0; for (const d of this.downloads.values()) m = Math.max(m, d.rec.order || 0); return m; }

  _runCompleteHook(d) {
    const cmd = (this.settings.onCompleteCommand || '').trim();
    if (!cmd) return;
    // "Command line parameters" of the virus-check dialog; {file} is replaced, otherwise the path is appended
    const tpl = (this.settings.onCompleteArgs || '').trim();
    const args = tpl ? tpl.split(/\s+/).map(a => a.replace('{file}', d.destPath)) : [];
    if (!tpl || !tpl.includes('{file}')) args.push(d.destPath);
    try { spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false }).on('error', () => {}).unref(); } catch { /* ignore */ }
  }

  /** Per-download "Options on completion" tab (exit / shut down / hang up after this file). */
  _afterDone(d) {
    const a = d.rec.afterDone;
    if (a && (a.exit || a.shutdown || a.hangup)) { this._queueDone({ name: d.rec.fileName, onDone: a }); d.rec.afterDone = null; }
  }

  // ---------- probing / adding ----------
  async probe(opts) {
    const rec = this._newRec({ ...opts });
    if (rec.kind === 'rtmp') {
      const info = rtmpLib.parseUrl(rec.url);
      return { fileName: info.fileBase + '.flv', size: null, resumable: false, category: rec.category, saveDir: rec.saveDir, finalUrl: rec.url, contentType: 'video/x-flv' };
    }
    if (rec.kind === 'dash') {
      return { fileName: rec.fileName.replace(/\.mpd$/i, '') + '.mp4', size: null, resumable: true, category: rec.category, saveDir: rec.saveDir, finalUrl: rec.url, contentType: 'application/dash+xml' };
    }
    if (rec.kind === 'hls') {
      return { fileName: rec.fileName.replace(/\.m3u8$/i, '') + '.ts', size: null, resumable: true, category: rec.category, saveDir: rec.saveDir, finalUrl: rec.url, contentType: 'application/x-mpegURL' };
    }
    const d = new Download(rec, { settings: () => this.settings, limiter: this.limiter, uniqueName: (a, b) => b, categorize: r => this.categorize(r) });
    const p = await d._probe(new AbortController().signal);
    if (p.res) p.res.destroy();
    d._applyProbe(p);
    return { fileName: rec.fileName, size: p.size, resumable: p.resumable, category: rec.category, saveDir: rec.saveDir, finalUrl: p.url, contentType: p.ctype };
  }

  async previewZip(o) {
    const rec = this._newRec(o);
    const d = new Download(rec, { settings: () => this.settings, limiter: this.limiter, uniqueName: (a, b) => b, categorize: () => {} });
    if (d.isFtp) throw Object.assign(new Error('Preview is available for http(s) links only'), { status: 400 });
    return require('./zip').previewZip(rec.url, { headers: d._headers(), ...d._net() });
  }

  _newRec(o) {
    if (!o.url || !/^(https?|ftp|rtmp[a-z]*):\/\//i.test(o.url.trim())) throw Object.assign(new Error('Enter a valid http://, https://, ftp:// or rtmp:// address'), { status: 400 });
    const url = o.url.trim();
    const rec = {
      id: crypto.randomUUID(), url, referer: o.referer || '', cookie: o.cookie || '', userAgent: o.userAgent || '',
      username: o.username || '', password: o.password || '',
      fileName: U.sanitizeName(o.fileName || U.nameFromUrl(url)), nameFixed: !!o.fileName,
      category: o.category || '', categoryFixed: !!o.category, saveDir: o.saveDir || '', dirFixed: !!o.saveDir,
      description: o.description || '', maxConnections: o.maxConnections || 0, overwrite: !!o.overwrite,
      status: 'queued', error: null, size: null, resumable: false, segments: [], bytesDone: 0,
      kind: /^rtmp/i.test(url) ? 'rtmp' : o.kind === 'dash' || dash.isDashUrl(url) ? 'dash' : o.kind === 'hls' || hls.isHlsUrl(url) ? 'hls' : undefined,
      etag: null, lastModified: null, queue: o.queue === undefined ? 'main' : o.queue, added: Date.now(), order: 0,
    };
    if (o.kind === 'video' && o.video) { rec.kind = 'video'; rec.video = o.video; rec.resumable = true; rec.nameFixed = true; }
    this.categorize(rec);
    if (!rec.saveDir) rec.saveDir = this.categories[0].dir;
    return rec;
  }

  add(o) {
    // "Duplicate download link": ask | number (numbered name) | overwrite | resume (open/complete existing)
    const dup = o.kind === 'video' ? null : [...this.downloads.values()].find(d => d.rec.url === (o.url || '').trim()); // the same video in another quality is not a duplicate
    const policy = o.allowDuplicate ? 'number' : (o.duplicatePolicy || this.settings.duplicatePolicy);
    if (dup) {
      if (policy === 'ask') return { ...this.view(dup), duplicate: true };
      if (policy === 'resume') {
        if (dup.rec.status !== 'complete' && o.startNow !== false) this.start(dup.rec.id);
        return { ...this.view(dup), duplicate: true, existing: true };
      }
      if (policy === 'overwrite') {
        const old = dup; // remove record + files synchronously enough for a fresh start
        old.stop();
        try { fs.rmSync(old.partPath, { force: true }); if (old.rec.status === 'complete') fs.rmSync(old.destPath, { force: true }); } catch { /* locked: new download will pick a numbered name */ }
        this.downloads.delete(old.rec.id); this.emit('removed', old.rec.id);
      }
    }
    const rec = this._newRec(o);
    if (o.rememberPath && o.saveDir) { const c = this.categories.find(x => x.id === rec.category); if (c) { c.dir = o.saveDir; this.emit('settings', this.settings); } }
    if (o.afterDone) rec.afterDone = o.afterDone;
    rec.order = this._maxOrder() + 1;
    const d = this._register(rec);
    this.emit('update', this.view(d));
    this.saveNow();
    if (o.startNow && !this.settings.addOnly) this.start(rec.id);
    return this.view(d);
  }

  /** Download-details panel: per-file Speed Limiter and Options on completion. */
  setDownloadOptions(id, { speedLimit, rememberLimit, afterDone }) {
    const d = this.get(id);
    if (speedLimit !== undefined) d.setSpeedLimit(speedLimit);
    if (rememberLimit !== undefined) d.rec.rememberLimit = !!rememberLimit;
    if (afterDone !== undefined) d.rec.afterDone = afterDone;
    this.emit('update', this.view(d)); this.save();
    return this.view(d);
  }

  /** Batch download / Download All Links: items may carry their own file name and description. */
  addItems(items, o = {}) { return items.map(i => this.add({ ...o, ...i })); }

  addMany(urls, o = {}) { return urls.map(url => this.add({ ...o, url })); }

  get(id) { const d = this.downloads.get(id); if (!d) throw Object.assign(new Error('Unknown download'), { status: 404 }); return d; }

  // ---------- control ----------
  start(id) {
    const d = this.get(id);
    if (d.running) return;
    if (d.rec.status === 'complete') return;
    d.rec.retryAt = 0;
    const go = () => { if (!d.running && d.rec.status !== 'complete') d.start(); };
    if (this.settings.dialup && this.settings.dialup.enabled) {
      let host = '';
      try { host = new URL(d.rec.url).hostname; } catch { /* handled by the engine */ }
      this._online = this._online || this.ensureOnline(host).finally(() => { this._online = null; });
      this._online.then(go, e => { d.rec.status = 'error'; d.rec.error = e.message; this.emit('update', this.view(d)); });
    } else go();
  }

  async stop(id) { const d = this.get(id); await d.stop(); this.emit('update', this.view(d)); this.saveNow(); }

  async stopAll() { await Promise.all([...this.downloads.values()].map(d => d.stop())); for (const q of [...this.runners.keys()]) this.stopQueue(q); }

  async remove(id, deleteFile = false) {
    const d = this.get(id);
    await d.stop();
    await d.cleanup();
    if (deleteFile && d.rec.status === 'complete') await fsp.rm(d.destPath, { force: true });
    this.downloads.delete(id);
    this.emit('removed', id);
    this.saveNow();
  }

  async removeCompleted(deleteFiles = false) {
    for (const d of [...this.downloads.values()]) if (d.rec.status === 'complete') await this.remove(d.rec.id, deleteFiles);
  }

  update(id, patch) {
    const d = this.get(id), r = d.rec;
    if (d.running) throw Object.assign(new Error('Stop the download before editing it'), { status: 409 });
    for (const k of ['url', 'referer', 'cookie', 'username', 'password', 'description']) if (patch[k] !== undefined) r[k] = patch[k];
    if (patch.saveDir && patch.saveDir !== r.saveDir) this._moveFiles(d, patch.saveDir, r.fileName);
    if (patch.fileName && patch.fileName !== r.fileName) this._moveFiles(d, r.saveDir, U.sanitizeName(patch.fileName));
    if (patch.category) { r.category = patch.category; r.categoryFixed = true; }
    if (patch.queue !== undefined) r.queue = patch.queue || null;
    this.emit('update', this.view(d)); this.saveNow();
    return this.view(d);
  }

  _moveFiles(d, dir, name) {
    const r = d.rec;
    const from = r.status === 'complete' ? d.destPath : d.partPath;
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, name);
    if (fs.existsSync(from)) fs.renameSync(from, r.status === 'complete' ? dest : dest + '.sgpart');
    r.saveDir = dir; r.fileName = name; r.nameFixed = true; r.dirFixed = true;
  }

  /** Re-download a finished/broken file from scratch. */
  async redownload(id) {
    const d = this.get(id);
    await d.stop();
    await d.cleanup({ keepCookies: true });
    Object.assign(d.rec, { segments: [], hls: undefined, dash: undefined, bytesDone: 0, status: 'queued', error: null, completed: null, etag: null, lastModified: null });
    this.start(id);
  }

  reorder(id, direction) {
    const list = this._queueItems(this.get(id).rec.queue);
    const i = list.findIndex(x => x.rec.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i].rec.order, list[j].rec.order] = [list[j].rec.order, list[i].rec.order];
    this.emit('update', this.view(list[i])); this.emit('update', this.view(list[j]));
    this.save();
  }

  // ---------- settings / categories / queues ----------
  setSettings(patch) {
    const num = (v, lo, hi, d) => Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d;
    const s = normalizeSettings({ ...this.settings, ...patch });
    s.maxConnections = num(s.maxConnections, 1, 32, 8);
    s.speedLimit = num(s.speedLimit, 0, 1e12, 0);
    s.retryIntervalMs = num(s.retryIntervalMs, 1000, 3600000, 30000);
    this.settings = s;
    this.limiter.configure({ speedLimit: s.limiterOn ? s.speedLimit : 0, quota: s.quota });
    this._refreshPac();
    this.emit('settings', s); this.saveNow();
    return s;
  }

  setCategories(list) { this.categories = list; this.emit('settings', this.settings); this.saveNow(); }

  saveQueue(q) {
    const i = this.queues.findIndex(x => x.id === q.id);
    if (i >= 0) {
      const old = this.queues[i];
      if (old.id === 'main' || old.id === 'sync') q = { ...q, type: old.type };
      this.queues[i] = { ...old, ...q };
    } else this.queues.push({ ...defaultQueues()[0], ...q, id: q.id || crypto.randomUUID() });
    this.emit('settings', this.settings); this.saveNow();
  }

  deleteQueue(id) {
    if (id === 'main' || id === 'sync') throw Object.assign(new Error('Built-in queues cannot be deleted'), { status: 400 });
    this.stopQueue(id);
    this.queues = this.queues.filter(q => q.id !== id);
    for (const d of this.downloads.values()) if (d.rec.queue === id) d.rec.queue = null;
    this.emit('settings', this.settings); this.saveNow();
  }

  _queueItems(qid) {
    return [...this.downloads.values()].filter(d => d.rec.queue === qid).sort((a, b) => (a.rec.order || 0) - (b.rec.order || 0));
  }

  // ---------- queue runner (scheduler semantics) ----------
  startQueue(qid, { scheduled = false } = {}) {
    const q = this.queues.find(x => x.id === qid);
    if (!q) throw Object.assign(new Error('Unknown queue'), { status: 404 });
    if (this.runners.has(qid)) return;
    const run = { stop: false };
    this.runners.set(qid, run);
    this.emit('queues');
    this._runQueue(q, run).catch(e => console.error('queue error', e)).finally(() => {
      this.runners.delete(qid);
      this.emit('queues');
    });
  }

  stopQueue(qid) {
    const run = this.runners.get(qid);
    if (!run) return;
    run.stop = true;
    for (const d of this._queueItems(qid)) if (d.running) d.stop();
  }

  async _runQueue(q, run) {
    const syncQ = q.type === 'sync';
    const checked = new Set();
    const given = new Set(); // gave up (max retries)
    for (;;) {
      if (run.stop) return;
      const live = this.queues.find(x => x.id === q.id) || q;
      const items = this._queueItems(q.id);
      const now = Date.now();
      const running = items.filter(d => d.running).length;
      let slots = Math.max(1, live.parallel) - running;
      let pending = 0;
      for (const d of items) {
        const r = d.rec;
        if (d.running || given.has(r.id)) { if (d.running) pending++; continue; }
        if (syncQ ? checked.has(r.id) && r.status === 'complete' : r.status === 'complete') continue;
        if (live.maxRetries > 0 && (r.attempts || 0) > live.maxRetries) { given.add(r.id); continue; }
        if (r.fatal && !r.retryAt) { given.add(r.id); continue; }
        pending++;
        if (r.retryAt && r.retryAt > now) continue;
        if (slots <= 0) continue;
        if (syncQ && !checked.has(r.id)) {
          checked.add(r.id);
          if (r.status === 'complete' && !(await this._changedOnServer(d))) continue;
          if (r.status === 'complete') await this._resetForSync(d);
        }
        slots--;
        r.fatal = false;
        d.start();
      }
      if (!pending) break;
      await U.sleep(400).catch(() => {});
    }
    if (run.stop) return;
    q.lastRun = Date.now();
    this._queueDone(q);
  }

  async _changedOnServer(d) {
    if (d.isFtp || ['hls', 'dash', 'rtmp'].includes(d.rec.kind)) return false;
    try {
      const { res } = await U.open(d.rec.url, { headers: { ...d._headers(), Range: 'bytes=0-0' }, ...d._net({ timeout: 15000 }) });
      res.destroy();
      const size = /\/(\d+)\s*$/.exec(res.headers['content-range'] || '')?.[1] ?? res.headers['content-length'];
      const r = d.rec;
      return (r.etag && res.headers.etag && r.etag !== res.headers.etag) ||
        (r.lastModified && res.headers['last-modified'] && r.lastModified !== res.headers['last-modified']) ||
        (size != null && r.size != null && +size !== r.size);
    } catch { return false; }
  }

  async _resetForSync(d) {
    Object.assign(d.rec, { segments: [], bytesDone: 0, status: 'queued', etag: null, lastModified: null, nameFixed: true });
    await fsp.rm(d.destPath, { force: true });
  }

  _queueDone(q) {
    const a = q.onDone || {};
    this.emit('queue-done', q);
    if (a.command) { try { spawn(a.command, [], { detached: true, stdio: 'ignore', shell: true }).on('error', () => {}).unref(); } catch { /* ignore */ } }
    if (a.hangup && os.platform() === 'win32') { try { spawn('rasdial', ['/disconnect'], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* ignore */ } }
    if (a.shutdown) {
      this.emit('shutdown-pending', { seconds: 60, name: q.name });
      const args = os.platform() === 'win32' ? ['/s', '/t', '60', ...(a.force ? ['/f'] : [])] : ['-h', '+1'];
      try { spawn('shutdown', args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* ignore */ }
    }
    if (a.exit) setTimeout(async () => { await this.shutdown(); process.exit(0); }, 10000); // wait 10 s before actions
  }

  _scheduleTick() {
    const now = new Date();
    const hhmm = n => String(n).padStart(2, '0');
    const cur = `${hhmm(now.getHours())}:${hhmm(now.getMinutes())}`;
    for (const q of this.queues) {
      if (!q.scheduled) continue;
      if (q.stopAt && q.stopAt === cur && this.runners.has(q.id)) { this.stopQueue(q.id); continue; }
      if (!q.days.includes(now.getDay())) continue;
      const key = `${now.toDateString()} ${cur}`;
      if (q.startAt && q.startAt === cur && this._lastScheduleKey.get(q.id) !== key) {
        this._lastScheduleKey.set(q.id, key);
        this.startQueue(q.id, { scheduled: true });
        continue;
      }
      // periodic synchronization: re-run every N minutes until the stop time (or end of day)
      if (q.type === 'sync' && q.periodMinutes > 0 && !this.runners.has(q.id) && q.startAt) {
        const [h, m] = q.startAt.split(':').map(Number);
        const startedToday = now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
        const beforeStop = !q.stopAt || cur < q.stopAt;
        if (startedToday && beforeStop && Date.now() - (q.lastRun || 0) >= q.periodMinutes * 60000) this.startQueue(q.id, { scheduled: true });
      }
    }
    // scheduled Site Grabber projects (one-time or periodic synchronization)
    for (const p of this.projects) {
      const sc = p.schedule;
      if (!sc || !sc.enabled) continue;
      if (sc.stopAt && sc.stopAt === cur && p.running && p.job) { const j = this.grabJobs && this.grabJobs.get(p.job); if (j) j.ac.abort(); continue; }
      if (p.running || (sc.days && !sc.days.includes(now.getDay()))) continue;
      const key = `${now.toDateString()} ${cur}`;
      if (sc.startAt === cur && p._key !== key) { p._key = key; this.runProject(p.id).catch(() => {}); continue; }
      if (sc.type === 'periodic' && sc.everyMinutes > 0 && sc.startAt) {
        const [h, m] = sc.startAt.split(':').map(Number);
        const started = now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
        if (started && (!sc.stopAt || cur < sc.stopAt) && Date.now() - (p.lastRun || 0) >= sc.everyMinutes * 60000) this.runProject(p.id).catch(() => {});
      }
    }
  }

  /** "Shut down" dialog: the countdown can be cancelled or skipped. */
  cancelShutdown() { try { require('child_process').spawn('shutdown', process.platform === 'win32' ? ['/a'] : ['-c'], { stdio: 'ignore' }).on('error', () => {}); } catch { /* ignore */ } }
  shutdownNow() { try { require('child_process').spawn('shutdown', process.platform === 'win32' ? ['/s', '/t', '0', '/f'] : ['-h', 'now'], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* ignore */ } }

  // ---------- proxy auto-configuration (PAC) ----------
  _refreshPac() {
    const pac = require('./pac');
    pac.loadPac(this.settings.proxy).then(() => { this.pacError = null; }, e => { this.pacError = e.message; this.emit('pac-error', e.message); });
  }

  /** "Test" button of the Proxy dialog: what would this script return for a URL? */
  async testPac({ pacUrl, url }) {
    const { Pac, loadPac } = require('./pac');
    await loadPac({ mode: 'pac', pacUrl });
    const u = new URL(url);
    await require('./pac').prepare(u.hostname);
    const r = require('./pac').active().find(url, u.hostname);
    return { result: r === undefined ? 'script error (connections go direct)' : r === null ? 'DIRECT' : `${r.type === 'socks' ? 'SOCKS' + r.version : 'PROXY'} ${r.host}:${r.port}`, class: Pac.name };
  }

  // ---------- Dial Up / VPN (Windows RAS) ----------
  rasEntries() {
    if (process.platform !== 'win32') return [];
    const names = new Set();
    for (const f of [path.join(process.env.APPDATA || '', 'Microsoft/Network/Connections/Pbk/rasphone.pbk'), path.join(process.env.ProgramData || 'C:/ProgramData', 'Microsoft/Network/Connections/Pbk/rasphone.pbk')]) {
      try { for (const m of fs.readFileSync(f, 'latin1').matchAll(/^\[(.+)\]\s*$/gm)) names.add(m[1]); } catch { /* no phone book */ }
    }
    return [...names];
  }

  _rasdial(args) {
    return new Promise((resolve, reject) => require('child_process').execFile('rasdial', args, { windowsHide: true, timeout: 120000 }, (e, out) => (e ? reject(Object.assign(e, { out })) : resolve(out))));
  }

  /** Connect the configured entry, redialling (attempts, seconds between). */
  async dialUp() {
    const d = this.settings.dialup;
    if (!d || !d.entry) throw new Error('No Dial Up / VPN connection selected in Options');
    const attempts = Math.max(1, Math.min(20, d.redialAttempts || 3));
    let last;
    for (let i = 1; i <= attempts; i++) {
      this.emit('dial', { attempt: i, of: attempts });
      try { await this._rasdial([d.entry, ...(d.user ? [d.user, d.pass || ''] : [])]); return true; } catch (e) { last = e; }
      if (i < attempts) await U.sleep(Math.max(1, d.redialSeconds || 10) * 1000);
    }
    const raw = String(last && (last.out || last.message));
    const why = /623/.test(raw) ? 'no Dial Up / VPN connection with this name exists in Windows' : raw.trim().split(String.fromCharCode(10)).pop().trim();
    throw new Error('Could not connect ' + d.entry + ': ' + why);
  }

  async ensureOnline(host) {
    if (host) { try { await require('dns').promises.lookup(host); return true; } catch { /* offline: dial */ } }
    return this.dialUp();
  }

  // ---------- Site Grabber jobs and scheduled projects ----------
  startGrab(opts) {
    const { explore } = require('./grabber');
    if (!/^https?:\/\//i.test(opts.startUrl || '')) throw Object.assign(new Error('Enter a valid start URL'), { status: 400 });
    if (opts.savePages) opts.saveRoot = opts.saveDir || path.join(DL_ROOT, 'Sites');
    const job = { id: crypto.randomUUID(), files: [], pages: [], stats: { pages: 0, files: 0, errors: 0, filtered: 0 }, running: true, ac: new AbortController(), opts };
    this.grabJobs = this.grabJobs || new Map();
    this.grabJobs.set(job.id, job);
    job.done = explore(opts, {
      signal: job.ac.signal, proxy: this.settings.proxy,
      onFile: f => job.files.push(f),
      onPage: (u, s, local) => {
        if (local) job.pages.push({ url: u, local });
        job.stats = { ...s };
        this.emit('grabber', { id: job.id, running: true, stats: job.stats, count: job.files.length });
      },
    }).then(s => { job.stats = { ...s }; }, e => { job.error = e.message; }).finally(() => {
      job.running = false;
      this.emit('grabber', { id: job.id, running: false, stats: job.stats, count: job.files.length, error: job.error });
    });
    return job;
  }

  grabJob(id) {
    const j = this.grabJobs && this.grabJobs.get(id);
    if (!j) throw Object.assign(new Error('Unknown grabber job'), { status: 404 });
    return j;
  }

  grabAdd(job, indexes, queue = 'main') {
    const { convertLinks } = require('./grabber');
    const chosen = (indexes || job.files.map((_, i) => i)).map(i => job.files[i]).filter(Boolean);
    const added = chosen.map(f => this.add({
      url: f.url, referer: f.referer, queue, allowDuplicate: true, overwrite: !!job.opts.overwrite,
      ...(f.local ? { saveDir: path.dirname(f.local), fileName: path.basename(f.local) } : {}),
    }));
    const converted = job.opts.savePages ? convertLinks(job.pages, chosen) : 0;
    return { added: added.length, pagesConverted: converted };
  }

  saveProject(p) {
    const i = this.projects.findIndex(x => x.id === p.id);
    const proj = { id: p.id || crypto.randomUUID(), name: p.name || p.opts.startUrl, opts: p.opts, checked: p.checked || [],
      schedule: p.schedule || { enabled: false }, lastRun: 0 };
    if (i >= 0) this.projects[i] = { ...this.projects[i], ...proj, lastRun: this.projects[i].lastRun }; else this.projects.push(proj);
    this.saveNow(); this.emit('settings', this.settings);
    return proj;
  }

  deleteProject(id) { this.projects = this.projects.filter(p => p.id !== id); this.saveNow(); this.emit('settings', this.settings); }

  /** Run a saved grabber project the way the scheduler does: explore only / explore + download / download checked. */
  async runProject(id) {
    const p = this.projects.find(x => x.id === id);
    if (!p || p.running) return;
    p.running = true; p.lastRun = Date.now();
    try {
      const action = (p.schedule && p.schedule.action) || 'explore-download';
      if (action === 'download-checked') {
        this.addItems((p.checked || []).map(url => ({ url })), { queue: 'main', allowDuplicate: p.schedule.type === 'periodic' ? false : true, duplicatePolicy: 'resume' });
      } else {
        const job = this.startGrab({ ...p.opts });
        p.job = job.id;
        await job.done;
        p.lastCount = job.files.length;
        if (action === 'explore-download') this.grabAdd(job, null, 'main');
      }
      if (p.schedule && p.schedule.onDone) this._queueDone({ name: p.name, onDone: p.schedule.onDone });
    } finally { p.running = false; delete p.job; this.saveNow(); this.emit('settings', this.settings); }
  }

  // ---------- "Download All Links" collections (sent by the browser extension) ----------
  collect({ links, referer = '', title = '' }) {
    const seen = new Set(), items = [];
    for (const l of links || []) {
      try {
        const u = new URL(l.url);
        if (!/^(https?|ftp):$/.test(u.protocol) || seen.has(u.href)) continue;
        seen.add(u.href);
        items.push({ url: u.href, text: String(l.text || '').trim().slice(0, 200), name: decodeURIComponent(path.basename(u.pathname) || u.hostname) });
      } catch { /* skip */ }
    }
    this.collections = this.collections || new Map();
    const id = crypto.randomUUID();
    this.collections.set(id, { id, referer, title, items, at: Date.now() });
    for (const [k, v] of this.collections) if (Date.now() - v.at > 3600000) this.collections.delete(k);
    this.emit('collect', { id, count: items.length });
    return { id, count: items.length };
  }

  collection(id) {
    const c = this.collections && this.collections.get(id);
    if (!c) throw Object.assign(new Error('Unknown collection'), { status: 404 });
    return c;
  }

  // ---------- Windows startup registration ("Start with Windows") ----------
  autostart(enable) {
    if (process.platform !== 'win32') return false;
    const { spawnSync } = require('child_process');
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
    if (enable === undefined) return spawnSync('reg', ['query', key, '/v', 'Advance Download Manager'], { windowsHide: true }).status === 0;
    const { isPackaged } = require('./paths');
    const script = path.join(__dirname, '..', 'bin', 'advance-download-manager.js');
    const host = process.env.ADM_HOST_EXE; // set by the native window host: start that on login, not the bare engine
    const cmd = host ? `"${host}" --minimized` : isPackaged ? `"${process.execPath}" --no-open` : `"${process.execPath}" "${script}" --no-open`;
    const r = enable
      ? spawnSync('reg', ['add', key, '/v', 'Advance Download Manager', '/t', 'REG_SZ', '/d', cmd, '/f'], { windowsHide: true })
      : spawnSync('reg', ['delete', key, '/v', 'Advance Download Manager', '/f'], { windowsHide: true });
    return enable ? r.status === 0 : true;
  }

  // ---------- import ----------
  static extractUrls(text) {
    const set = new Set();
    for (const m of String(text).matchAll(/\bhttps?:\/\/[^\s"'<>]+/gi)) set.add(m[0].replace(/[),.;]+$/, ''));
    return [...set];
  }
}

module.exports = { Manager, DL_ROOT, defaultSettings, normalizeSettings };
