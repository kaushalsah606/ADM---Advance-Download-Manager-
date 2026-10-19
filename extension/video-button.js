'use strict';
// "Download this video" button over playing videos. Runs in every page and frame; the button lives in a shadow root so the
// page's own styles cannot change it and its scripts cannot click it by accident.
(() => {
  if (window.__admVideoButton) return;
  window.__admVideoButton = true;
  const ext = typeof browser !== 'undefined' ? browser : chrome;
  let enabled = true, hiddenHere = false;
  const site = location.hostname.replace(/^www./, '').toLowerCase();
  const isHiddenHere = list => (list || []).some(h => site === h || site.endsWith('.' + h)); // the button can be switched off for one website
  try {
    ext.storage.local.get({ videoButton: true, hiddenSites: [] }).then(c => { enabled = c.videoButton !== false; hiddenHere = isHiddenHere(c.hiddenSites); });
    ext.storage.onChanged.addListener(ch => {
      if (ch.videoButton) enabled = ch.videoButton.newValue !== false;
      if (ch.hiddenSites) hiddenHere = isHiddenHere(ch.hiddenSites.newValue);
      if (ch.videoButton || ch.hiddenSites) update();
    });
  } catch { /* storage not available in this frame */ }

  // ---- finding the page address of the video (feeds show many videos on one page) ----
  const SITES = [
    { host: /(^|\.)facebook\.com$|(^|\.)fb\.watch$/, re: /\/(watch\/?\?v=\d+|reel\/\d+|videos\/\d+|[^/]+\/videos\/[^/?]+(\/\d+)?|share\/[rv]\/[\w-]+)/ },
    { host: /(^|\.)instagram\.com$/, re: /\/(reels?|p|tv)\/[\w-]+/ },
    { host: /(^|\.)tiktok\.com$/, re: /\/@[\w.-]+\/video\/\d+|\/v\/\d+/ },
    { host: /(^|\.)(twitter|x)\.com$/, re: /\/\w+\/status\/\d+/ },
    { host: /(^|\.)youtube\.com$/, re: /\/(watch\?v=|shorts\/|live\/)[\w-]+/ },
    { host: /(^|\.)(vimeo|dailymotion)\.com$/, re: /\/(video\/)?\d+|\/video\/[\w]+/ },
    { host: /(^|\.)reddit\.com$/, re: /\/r\/[\w]+\/comments\/[\w]+/ },
    { host: /(^|\.)twitch\.tv$/, re: /\/(videos|clip)\/[\w-]+|\/clip/ },
  ];
  const matches = u => { try { const x = new URL(u, location.href); return SITES.some(s => s.host.test(x.hostname) && s.re.test(x.pathname + x.search)); } catch { return false; } };
  const isPrimary = v => { const r = v.getBoundingClientRect(); return r.width * r.height > innerWidth * innerHeight * 0.35; };
  function permalinkFor(video) {
    if (matches(location.href) && isPrimary(video)) return location.href;
    let el = video;
    for (let depth = 0; el && depth < 12; depth++, el = el.parentElement) {
      for (const a of Array.from(el.querySelectorAll ? el.querySelectorAll('a[href]') : []).slice(0, 80)) {
        if (matches(a.href)) return a.href.split('#')[0];
      }
    }
    return location.href;
  }

  // ---- the button ----
  const host = document.createElement('adm-video-button');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;display:none;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    .b{display:flex;align-items:center;gap:6px;font:600 13px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#fff;background:linear-gradient(135deg,#1769e0,#0d47a1);
       border-radius:999px;padding:8px 12px 8px 10px;box-shadow:0 2px 10px rgba(0,0,0,.45);cursor:pointer;user-select:none;white-space:nowrap;border:1px solid rgba(255,255,255,.35)}
    .b:hover{background:linear-gradient(135deg,#2a7cf0,#1565c0)}
    .b.busy{opacity:.7;pointer-events:none}
    .x{margin-left:4px;padding:0 4px;border-radius:50%;opacity:.8;font-size:15px}.x:hover{background:rgba(255,255,255,.25);opacity:1}
    svg{width:16px;height:16px;fill:none;stroke:#fff;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}</style><div class="b" part="button" role="button" tabindex="0" title="Download this video with Advance Download Manager"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-5-5m5 5l5-5M4 20h16"/></svg><span class="t">Download this video</span><span class="x" title="Hide on this video">×</span></div>`;
  const btn = root.querySelector('.b'), label = root.querySelector('.t'), close = root.querySelector('.x');
  const attach = () => { if (!host.isConnected) (document.documentElement || document.body).appendChild(host); };

  let target = null, hovering = false, lastMove = 0, rafId = 0, hidden = new WeakSet();
  const visibleVideos = () => Array.from(document.getElementsByTagName('video')).filter(v => {
    if (hidden.has(v)) return false;
    const r = v.getBoundingClientRect();
    if (r.width < 240 || r.height < 135 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    const cs = getComputedStyle(v);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0;
  });
  const playing = v => !v.paused && !v.ended && v.readyState > 2;
  function pick() {
    const list = visibleVideos();
    if (!list.length) return null;
    const under = list.find(v => { const r = v.getBoundingClientRect(); return mouse.x >= r.left && mouse.x <= r.right && mouse.y >= r.top && mouse.y <= r.bottom; });
    if (under) return under;
    const p = list.filter(playing).sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    return p || null;
  }
  const mouse = { x: -1, y: -1 };
  function update() {
    clearTimeout(rafId);
    if (!enabled || hiddenHere) { host.style.display = 'none'; target = null; return; }
    const v = pick();
    const active = v && (hovering || Date.now() - lastMove < 4500 || (playing(v) && Date.now() - lastMove < 4500));
    if (!v || !active) { host.style.display = 'none'; target = v || null; if (v) rafId = setTimeout(update, 400); return; }
    target = v; attach();
    const r = v.getBoundingClientRect();
    host.style.display = 'block';
    const w = host.offsetWidth || 190;
    host.style.transform = `translate(${Math.max(4, Math.min(innerWidth - w - 4, r.right - w - 12))}px, ${Math.max(4, r.top + 12)}px)`;
    rafId = setTimeout(update, 120); // follows the video a few times a second (not every frame: pages like YouTube are busy enough)
  }
  const bump = () => { lastMove = Date.now(); update(); };
  document.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; bump(); }, { passive: true, capture: true });
  document.addEventListener('play', () => { lastMove = Date.now(); update(); }, { capture: true });
  document.addEventListener('pause', update, { capture: true });
  document.addEventListener('scroll', update, { passive: true, capture: true });
  addEventListener('resize', update);
  host.addEventListener('mouseenter', () => { hovering = true; });
  host.addEventListener('mouseleave', () => { hovering = false; lastMove = Date.now(); });
  let moTimer = 0; // busy pages (feeds) change the DOM constantly: look again at most twice a second
  new MutationObserver(() => { if (!moTimer) moTimer = setTimeout(() => { moTimer = 0; if (document.querySelector('video')) update(); }, 500); }).observe(document, { childList: true, subtree: true });

  function flash(text) { label.textContent = text; setTimeout(() => { label.textContent = 'Download this video'; btn.classList.remove('busy'); }, 2500); }
  close.addEventListener('click', e => { e.stopPropagation(); if (target) hidden.add(target); host.style.display = 'none'; });
  btn.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    if (!target || btn.classList.contains('busy')) return;
    btn.classList.add('busy'); label.textContent = 'Opening…';
    const urls = [permalinkFor(target), location.href].filter((u, i, a) => /^https?:/i.test(u) && a.indexOf(u) === i);
    try {
      ext.runtime.sendMessage({ type: 'video', urls, title: document.title }).then(r => flash(r && r.ok ? 'Sent to Download Manager' : (r && r.message) || 'Download Manager is not running'), () => flash('Download Manager is not running'));
    } catch { flash('Download Manager is not running'); }
  });
  btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') btn.click(); });
  update();
})();
