const $ = s => document.querySelector(s);
const D = { port: 6800, token: '', minSizeKB: 0, types: 'zip rar 7z exe msi iso pdf mp3 mp4 mkv avi mov apk dmg gz tar m4a flac wav webm'.split(' ') };
const TXT = {
  connected: ['Connected', 'ok', 'Connected to Advance Download Manager'],
  waiting: ['Press Allow in the app', 'warn', 'Waiting for you to press Allow in the app window...'],
  denied: ['Refused in the app', 'bad', 'Refused in the app - press Connect now to ask again later'],
  offline: ['App not running', 'bad', 'Advance Download Manager is not running'],
};
function show(st) { const [t, cls, title] = TXT[st] || TXT.offline; $('#state').textContent = t; $('#state').className = 'pill ' + cls; $('#state').title = title; }
const hostList = s => [...new Set(String(s).split(/[\s,;]+/).map(x => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '')).filter(Boolean))];
chrome.storage.local.get({ ...D, pairState: 'offline', videoButton: true, hiddenSites: [] }).then(c => {
  $('#vbtn').checked = c.videoButton !== false; $('#hidden').value = c.hiddenSites.join('\n');
  $('#port').value = c.port; $('#token').value = c.token; $('#types').value = c.types.join(' '); $('#min').value = c.minSizeKB;
  show(c.token ? 'connected' : c.pairState);
});
$('#pair').onclick = () => { $('#state').textContent = '…'; chrome.runtime.sendMessage({ type: 'pair' }, st => show(st)); };
$('#save').onclick = async () => {
  const port = +$('#port').value || 6800, token = $('#token').value.trim();
  await chrome.storage.local.set({
    videoButton: $('#vbtn').checked, hiddenSites: hostList($('#hidden').value), port, token, minSizeKB: +$('#min').value || 0,
    types: $('#types').value.split(/[\s,]+/).filter(Boolean).map(x => x.replace(/^\./, '').toLowerCase()),
  });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'X-Token': token } });
    $('#msg').textContent = r.ok ? 'Saved - connected to Advance Download Manager.' : 'Saved, but the token was rejected.';
  } catch { $('#msg').textContent = 'Saved, but Advance Download Manager is not reachable.'; }
};
