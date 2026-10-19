const $ = s => document.querySelector(s);
const fmt = n => !n ? '' : n > 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
try { $('#ver').textContent = 'Version ' + chrome.runtime.getManifest().version; } catch { /* no manifest */ }

const STATUS = {
  connected: ['Connected', 'ok'],
  waiting: ['Press Allow in the app', 'warn'],
  denied: ['Refused in the app', 'bad'],
  offline: ['App not running', 'bad'],
};
function showStatus(state) {
  const [t, cls] = STATUS[state] || STATUS.offline;
  $('#st').textContent = t; $('#st').className = 'pill ' + cls;
  $('#st').title = { connected: 'Connected to Advance Download Manager', waiting: 'Waiting for you to press Allow in the Advance Download Manager window', denied: 'The connection was refused in the app (open Options to try again)', offline: 'Advance Download Manager is not running' }[state] || '';
}
chrome.storage.local.get({ pairState: 'offline', token: '' }).then(c => showStatus(c.token ? 'connected' : c.pairState));
chrome.runtime.sendMessage({ type: 'pair' }, st => { if (st) showStatus(st); });

chrome.storage.local.get({ enabled: true, videoButton: true, hiddenSites: [] }).then(c => { $('#on').checked = c.enabled; $('#vb').checked = c.videoButton !== false; });
$('#on').onchange = e => chrome.storage.local.set({ enabled: e.target.checked });
$('#vb').onchange = e => { chrome.storage.local.set({ videoButton: e.target.checked }); $('#site').disabled = !e.target.checked; };
$('#opts').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  let host = '';
  try { const u = new URL(tab.url); if (/^https?:$/.test(u.protocol)) host = u.hostname.replace(/^www\./, ''); } catch { /* not a web page */ }
  // per-site switch: the button can be hidden on one website only
  if (host) {
    $('#siteT').textContent = 'Show on ' + host;
    chrome.storage.local.get({ hiddenSites: [], videoButton: true }).then(c => { $('#site').checked = !c.hiddenSites.includes(host); $('#site').disabled = c.videoButton === false; });
    $('#site').onchange = async e => {
      const { hiddenSites } = await chrome.storage.local.get({ hiddenSites: [] });
      const set = new Set(hiddenSites);
      if (e.target.checked) set.delete(host); else set.add(host);
      chrome.storage.local.set({ hiddenSites: [...set].sort() });
    };
  } else $('#siteRow').style.display = 'none';

  $('#vid').onclick = () => chrome.runtime.sendMessage({ type: 'videoPage', tab: { id: tab.id, url: tab.url, title: tab.title } }, () => window.close());
  $('#all').onclick = () => chrome.runtime.sendMessage({ type: 'collect', tab: { id: tab.id, url: tab.url, title: tab.title } }, () => window.close());
  chrome.runtime.sendMessage({ type: 'media', tabId: tab.id }, items => {
    if (!items || !items.length) return;
    const list = $('#list'); list.textContent = '';
    $('#count').textContent = items.length + (items.length === 1 ? ' file' : ' files');
    for (const it of items) {
      const row = document.createElement('div'); row.className = 'it';
      const f = document.createElement('div'); f.className = 'f'; f.title = it.url;
      const name = document.createElement('b'); name.textContent = decodeURIComponent((it.url.split('/').pop() || '').split('?')[0] || it.url).slice(0, 120) || it.url;
      const meta = document.createElement('span'); meta.textContent = [it.type, fmt(it.size)].filter(Boolean).join(' · ');
      f.append(name, meta);
      const b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'Download';
      b.onclick = () => chrome.runtime.sendMessage({ type: 'send', url: it.url, referrer: tab.url }, ok => { b.textContent = ok ? 'Sent' : 'Failed'; b.disabled = !!ok; });
      row.append(f, b); list.append(row);
    }
  });
});
