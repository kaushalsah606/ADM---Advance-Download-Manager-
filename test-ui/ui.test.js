'use strict';
// Drives the real web UI (public/index.html) in jsdom against a live Advance Download Manager server + local origin.
// Optional dev test:  npm i --no-save jsdom@24  &&  node test-ui/ui.test.js
const { JSDOM } = require('jsdom');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const { Manager } = require(path.join(ROOT, 'src/manager'));
const { createServer } = require(path.join(ROOT, 'src/server'));

const DATA = crypto.randomBytes(800 * 1024);
const origin = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const s = m ? +m[1] : 0, e = m && m[2] ? +m[2] : DATA.length - 1;
  const h = { 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes' };
  if (m) h['Content-Range'] = `bytes ${s}-${e}/${DATA.length}`;
  res.writeHead(m ? 206 : 200, h); res.end(DATA.subarray(s, e + 1));
});

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = (cond, ms = 8000) => new Promise((res, rej) => { const t0 = Date.now(); (function poll() { let v; try { v = cond(); } catch { /* retry */ } if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error('wait timeout: ' + cond)); setTimeout(poll, 50); })(); });

(async () => {
  await new Promise(r => origin.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${origin.address().port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-ui-'));
  const mgr = new Manager({ dataDir: path.join(tmp, 'data') }).load();
  mgr.categories.forEach(c => { c.dir = path.join(tmp, 'dl', c.id); });
  const srv = createServer(mgr, { port: 0 });
  const port = await srv.listen();
  const pageUrl = `http://127.0.0.1:${port}/`;

  const html = await (await fetch(pageUrl)).text();
  const errors = [];
  const dom = new JSDOM(html, {
    url: pageUrl, runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (u, o) => fetch(new URL(u, pageUrl), o);
      w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
      w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new w.Event('close')); };
      w.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, set fillStyle(v) {} });
      w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
      w.prompt = () => null; w.confirm = () => true;
      // tiny EventSource over fetch streaming
      w.EventSource = class {
        constructor(u) { this.l = {}; this.ac = new AbortController(); this.run(new URL(u, pageUrl)); }
        addEventListener(t, f) { (this.l[t] = this.l[t] || []).push(f); }
        async run(u) {
          const r = await fetch(u, { signal: this.ac.signal }); const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
          for (;;) {
            const { value, done } = await rd.read().catch(() => ({ done: true })); if (done) return; buf += dec.decode(value);
            let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); const t = /event: (.*)/.exec(ev), d = /data: (.*)/.exec(ev); if (t && d) (this.l[t[1]] || []).forEach(f => f({ data: d[1] })); }
          }
        }
        close() { this.ac.abort(); }
      };
      w.addEventListener('error', e => errors.push(String(e.error || e.message)));
    },
  });
  const w = dom.window, d = w.document, $ = s => d.querySelector(s), $$ = s => [...d.querySelectorAll(s)];
  const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const fire = (el, t = 'input') => el.dispatchEvent(new w.Event(t, { bubbles: true }));
  await wait(() => w.eval('S').categories.length);

  check('page loads, menu bar + columns render', $$('#menubar button').length > 10 && $$('#head th').length === 8);

  // ---- Add URL end to end ----
  click($('#bAdd')); await wait(() => $('#dAdd').hasAttribute('open'));
  $('#fAdd').elements.url.value = base + '/files/movie.bin';
  const sd = path.join(tmp, 'out1'); $('#fAdd').elements.saveDir.value = sd;
  click($('#aProbe')); await wait(() => /movie\.bin/.test($('#probeInfo').textContent));
  check('Check file shows name, size and resume support', /resume supported/.test($('#probeInfo').textContent), $('#probeInfo').textContent);
  $('#fAdd').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await wait(() => $$('#rows tr[data-id]').length === 1 && /complete/.test($('#rows').textContent));
  check('download runs to completion and row shows it', fs.existsSync(path.join(sd, 'movie.bin')) && fs.statSync(path.join(sd, 'movie.bin')).size === DATA.length);

  // ---- duplicate dialog ----
  $('#fAdd').elements.url.value = base + '/files/movie.bin'; click($('#bAdd')); await wait(() => $('#dAdd').hasAttribute('open'));
  $('#fAdd').elements.url.value = base + '/files/movie.bin';
  $('#fAdd').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await wait(() => $$('#dyn dialog[open]').some(x => /Duplicate download link/.test(x.textContent)));
  check('duplicate link policy dialog is offered', true);
  click($$('#dyn dialog[open] button').find(b => b.textContent === 'Cancel'));

  // ---- detail panel: per-file speed limiter + options ----
  click($('#rows tr[data-id]')); await wait(() => $('#dLim'));
  $('#dLim').value = '300'; click($('#dApply'));
  await wait(() => w.eval('[...dl.values()]')[0].speedLimit === 300 * 1024).catch(() => {});
  check('per-file Speed Limiter value is stored', w.eval('[...dl.values()]')[0].speedLimit === 300 * 1024);

  // ---- sorting + column chooser + find ----
  click($('#head th[data-c="name"]')); check('header click sorts (arrow shown)', /[▲▼]/.test($('#head').textContent));
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })); d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
  check('Ctrl-F opens the find bar', $('#findbar').classList.contains('on'));
  $('#fText').value = 'zzz-nothing'; fire($('#fText')); check('find filters the list', $$('#rows tr[data-id]').length === 0);
  $('#fText').value = 'MOVIE'; fire($('#fText')); check('find is case-insensitive by default', $$('#rows tr[data-id]').length === 1);
  $('#fCase').checked = true; fire($('#fCase')); check('Match case option works', $$('#rows tr[data-id]').length === 0);
  click($('#fClose'));

  // ---- batch dialog ----
  w.eval('batchDialog("http://h/img*.jpg")'); await wait(() => $$('#dyn dialog[open]').length);
  let dlg = $$('#dyn dialog[open]').pop();
  dlg.querySelector('#bFrom').value = '8'; dlg.querySelector('#bTo').value = '11'; dlg.querySelector('#bWidth').value = '3';
  click([...dlg.querySelectorAll('button')].find(b => b.textContent === 'Preview'));
  await wait(() => /4 files/.test(dlg.querySelector('#bInfo').textContent));
  check('batch preview lists count/first/last', /img008\.jpg/.test(dlg.querySelector('#bInfo').textContent) && /img011\.jpg/.test(dlg.querySelector('#bInfo').textContent), dlg.querySelector('#bInfo').textContent);
  click([...dlg.querySelectorAll('button')].find(b => b.textContent === 'Cancel'));

  // ---- options: every tab renders and saves ----
  click($('#bOpts')); await wait(() => $('#dOpts').hasAttribute('open'));
  for (const t of ['Connection', 'Save To', 'Proxy', 'File Types', 'Site Logins', 'Dial Up / VPN', 'Downloads', 'General', 'Video', 'Browser']) {
    click($(`#optTabs button[data-t="${t}"]`)); await wait(() => $(`#optTabs button.on`).dataset.t === t);
  }
  check('all 10 Options tabs render (incl. Dial Up / VPN, Video and Browser)', $$('#optTabs button').length === 10);
  click($('#optTabs button[data-t="Proxy"]'));
  $('[name=pm][value=manual]').checked = true; $('#x_socks_h').value = '127.0.0.1'; $('#x_socks_p').value = '1080'; $('#x_ver').value = '4';
  click($('#optTabs button[data-t="Connection"]')); $('#o_maxConnections').value = '6'; $('#o_speedKB').value = '500';
  click($('#optTabs button[data-t="File Types"]')); $('#o_ns').value = 'noisy.example';
  click($('#optTabs button[data-t="Downloads"]')); $('#o_dup').value = 'number'; $('#o_addonly').checked = true;
  click($('#oSave'));
  await wait(() => mgr.settings.maxConnections === 6);
  check('Options save persists to the server (connections, limiter, SOCKS4, sites, duplicate policy)',
    mgr.settings.speedLimit === 500 * 1024 && mgr.settings.proxy.mode === 'manual' && mgr.settings.proxy.socks.version === 4 && mgr.settings.proxy.socks.host === '127.0.0.1'
    && mgr.settings.noTakeoverSites[0] === 'noisy.example' && mgr.settings.duplicatePolicy === 'number' && mgr.settings.addOnly === true, JSON.stringify(mgr.settings.proxy));
  mgr.setSettings({ proxy: { mode: 'none' }, addOnly: false });

  // ---- scheduler ----
  click($('#bSched')); await wait(() => $('#dSched').hasAttribute('open'));
  $('#q_start').value = '03:30'; $('#q_hang').checked = true; $('#q_force').checked = true; click($('#qSave'));
  await wait(() => mgr.queues[0].startAt === '03:30');
  check('Scheduler saves start time, hang-up and force options', mgr.queues[0].onDone.hangup === true && mgr.queues[0].onDone.force === true);
  click($('#qClose'));

  // ---- export / import through the real endpoints ----
  const exp = await (await fetch(pageUrl + `api/export?scope=all&format=json`, { headers: { 'X-Token': srv.token } })).text();
  check('export endpoint returns an export file', JSON.parse(exp).items.length >= 1);
  $('#iText').value = exp.replace(/movie\.bin/g, 'imported.bin'); click($('#bAdd')); click($('#iOk'));
  await wait(() => [...mgr.downloads.values()].some(x => x.rec.url.endsWith('imported.bin')));
  check('import adds the links to the queue', true);

  // ---- Download All Links dialog ----
  const col = mgr.collect({ referer: 'http://page/', title: 'Demo page', links: [{ url: 'http://h/a.zip', text: 'Archive A' }, { url: 'http://h/page.html', text: 'a page' }, { url: 'http://h/pic.png', text: 'img' }, { url: 'http://h/b.mp3', text: 'Song' }] });
  await wait(() => $$('#dyn dialog[open]').some(x => /Download all links/.test(x.textContent)));
  dlg = $$('#dyn dialog[open]').find(x => /Download all links/.test(x.textContent));
  check('collection dialog opened via the SSE event; HTML files hidden by default', dlg.querySelectorAll('#cList tr').length === 3, String(dlg.querySelectorAll('#cList tr').length));
  dlg.querySelector('#cImg').checked = true; fire(dlg.querySelector('#cImg'), 'change');
  dlg.querySelector('#cPat').value = 'trip_*'; fire(dlg.querySelector('#cPat'));
  check('hide-images + rename pattern re-render the list', dlg.querySelectorAll('#cList tr').length === 2 && /trip_a\.zip/.test(dlg.querySelector('#cList').textContent), dlg.querySelector('#cList').textContent);
  dlg.querySelector('#cDesc').checked = true; click(dlg.querySelector('#cOk'));
  await wait(() => [...mgr.downloads.values()].some(x => x.rec.fileName === 'trip_a.zip'));
  check('selected links added with new names and link-text descriptions', [...mgr.downloads.values()].find(x => x.rec.fileName === 'trip_a.zip').rec.description === 'Archive A');

  // ---- grabber dialog fills + template/filter helpers ----
  click($('#bGrab')); await wait(() => $('#dGrab').hasAttribute('open'));
  $('#gUrl').value = base + '/'; $('#gTpl').value = 'images'; fire($('#gTpl'), 'change');
  check('grabber template fills file types', /jpg/.test($('#gExt').value));
  $('#gFilter').value = '1'; fire($('#gFilter'), 'change'); check('grabber filter list appends its mask', /mp4/.test($('#gExt').value));
  const go = w.grabOpts();
  check('grabber options reflect the wizard (levels, whole-site, concurrency)', go.levelsThis === 2 && go.exploreConcurrent === 4 && go.startUrl === base + '/');
  click($('#gClose'));

  // ---- toolbar customization + skins ----
  w.eval('toolbarDialog()'); await wait(() => $$('#dyn dialog[open]').some(x => /Customize toolbar/.test(x.textContent)));
  dlg = $$('#dyn dialog[open]').find(x => /Customize toolbar/.test(x.textContent));
  dlg.querySelector('[data-id="bGrab"]').checked = false; dlg.querySelector('#tbMode').value = 'small'; dlg.querySelector('#tbSkin').value = 'neon';
  click([...dlg.querySelectorAll('button')].find(b => b.textContent === 'OK'));
  await wait(() => $('#bGrab').style.display === 'none');
  check('toolbar: button hidden, small buttons and Neon skin applied', d.body.classList.contains('tb-small') && d.body.classList.contains('neon') && $('#bAdd').style.display !== 'none');
  w.eval("setTb({ hidden: [], mode: 'large', skin: 'default' })");

  // ---- columns dialog: reorder ----
  w.eval('columnsDialog()'); await wait(() => $$('#dyn dialog[open]').some(x => /Columns/.test(x.textContent)));
  dlg = $$('#dyn dialog[open]').find(x => /Columns/.test(x.textContent));
  click(dlg.querySelector('[data-mv="0"][data-dir="1"]'));
  click(dlg.querySelector('#colOk'));
  check('columns can be reordered (File name moved down one place)', w.eval('cols')[0] === 'q' && w.eval('cols')[1] === 'name', JSON.stringify(w.eval('cols')));
  w.eval("cols = ['name','q','size','progress','status','speed','eta','added']; renderAll()");

  // ---- PAC mode through Options ----
  click($('#bOpts')); await wait(() => $('#dOpts').hasAttribute('open'));
  click($('#optTabs button[data-t="Proxy"]'));
  $('[name=pm][value=pac]').checked = true; $('#x_pac').value = 'C:/does/not/exist.pac'; click($('#oSave'));
  await wait(() => mgr.settings.proxy.mode === 'pac');
  check('PAC mode + script address are saved', mgr.settings.proxy.pacUrl === 'C:/does/not/exist.pac');
  mgr.setSettings({ proxy: { mode: 'none' } });

  // ---- update-check switch (Options > General) ----
  click($('#bOpts')); await wait(() => $('#dOpts').hasAttribute('open'));
  click($('#optTabs button[data-t="General"]'));
  check('update check is on by default and keeps the repository setting', $('#o_upd').checked === true && !!mgr.settings.updates.repo);
  $('#o_upd').checked = false; click($('#oSave'));
  await wait(() => mgr.settings.updates.check === false);
  check('update check can be switched off without losing the repository', mgr.settings.updates.check === false && !!mgr.settings.updates.repo);
  mgr.setSettings({ updates: { check: true } });

  // ---- Turbo button and Turbo options ----
  check('Turbo button is on the toolbar and off by default', !!$('#bTurbo') && !$('#bTurbo').classList.contains('on') && mgr.settings.turbo === false);
  click($('#bTurbo'));
  await wait(() => mgr.settings.turbo === true && $('#bTurbo').classList.contains('on'));
  check('Turbo button turns Turbo mode on and lights up', /Turbo ON/.test($('#bTurbo').textContent));
  click($('#bTurbo'));
  await wait(() => mgr.settings.turbo === false && !$('#bTurbo').classList.contains('on'));
  check('Turbo button turns it off again', /^\s*\S*\s*Turbo\s*$/.test($('#bTurbo').textContent));
  click($('#bOpts')); await wait(() => $('#dOpts').hasAttribute('open'));
  click($('#optTabs button[data-t="Connection"]'));
  $('#o_turbo').checked = true; $('#o_turboConns').value = '48'; click($('#oSave'));
  await wait(() => mgr.settings.turbo === true);
  check('Options > Connection saves Turbo mode and its connection count', mgr.settings.turboConnections === 48);
  mgr.setSettings({ turbo: false, turboConnections: 32 });
  click($('#bOpts')); await wait(() => $('#dOpts').hasAttribute('open'));
  click($('#optTabs button[data-t="Connection"]'));
  check('Options > Connection has the Auto-tune switch (on by default) that is saved', $('#o_autotune').checked === true && mgr.settings.autoTune === true);
  $('#o_autotune').checked = false; click($('#oSave'));
  await wait(() => mgr.settings.autoTune === false);
  check('switching Auto-tune off is saved (fixed ramp-up)', mgr.settings.autoTune === false);
  mgr.setSettings({ autoTune: true });

  // ---- browser extension pairing prompt + Options > Browser ----
  const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  mgr.pairRequest(ORIGIN, 'Advance Download Manager Integration', 'Edge');
  await wait(() => $$('#dyn dialog[open]').some(x => /Allow this browser extension to connect/.test(x.querySelector('h3').textContent)));
  const pairDlg = $$('#dyn dialog[open]').find(x => /Allow this browser extension to connect/.test(x.querySelector('h3').textContent));
  check('an extension asking to pair opens an Allow / Deny prompt naming the browser', /Edge/.test(pairDlg.textContent) && [...pairDlg.querySelectorAll('button')].map(b => b.textContent).join() === 'Deny,Allow');
  click([...pairDlg.querySelectorAll('button')].find(b => b.textContent === 'Allow'));
  await wait(() => mgr.settings.pairedExtensions.some(p => p.origin === ORIGIN));
  check('pressing Allow pairs the extension (no token was pasted)', mgr.pairRequest(ORIGIN, '', '').approved === true);
  click($('#bOpts')); await wait(() => $('#dOpts').hasAttribute('open'));
  click($('#optTabs button[data-t="Browser"]'));
  await wait(() => !!$('#pairList'));
  check('Options > Browser lists the connected browser and offers setup buttons', /Edge/.test($('#pairList').textContent) && !!$('[data-open="folder"]') && !!$('[data-open="chrome"]') && !!$('[data-open="edge"]') && !!$('[data-open="firefox"]') && !!$('#o_syscap') && !!$('#o_clipoffer'));
  click($('[data-revoke]'));
  await wait(() => mgr.settings.pairedExtensions.length === 0);
  check('Remove revokes the pairing', /None yet/.test($('#pairList').textContent));
  click($('#oCancel'));

  // ---- Download File Info dialog (confirmation for captured downloads) ----
  const realProbe = mgr.probe;
  mgr.probe = async o => ({ fileName: 'sample_al.zip', size: 38656, resumable: true, category: 'compressed', saveDir: path.join(tmp, 'dl', 'compressed'), finalUrl: o.url, contentType: 'application/zip' });
  const dlCount = () => mgr.downloads.size;
  const before = dlCount();
  mgr.propose({ url: base + '/languages/sample_al.zip', source: 'browser', startNow: true, queue: null });
  await wait(() => $('#dInfo').hasAttribute('open') && /KB/.test($('#iSize').textContent));
  check('a captured download opens "Download File Info" instead of starting silently', dlCount() === before && /Download File Info/.test($('#dInfo h3').textContent));
  check('the dialog shows URL, category, Save As path, remember-path box, size, file icon and type', $('#iUrl').value.endsWith('/languages/sample_al.zip') && $('#iCat').value === 'compressed' && /sample_al\.zip$/.test($('#iSave').value) && /compressed/.test($('#iSave').value) && $('#iRemCat').textContent === 'Compressed' && $('#iSize').textContent === '37.8 KB' && $('#iIcon').textContent.length > 0 && $('#iType').textContent === 'application/zip');
  check('it has Download Later, Start Download, Cancel, Preview (enabled for zip), browse and + buttons', [$('#iLater'), $('#iStart'), $('#fiCancel'), $('#iBrowse'), $('#iCatAdd')].every(Boolean) && $('#iPreview').disabled === false);
  $('#iCat').value = 'documents'; $('#iCat').dispatchEvent(new w.Event('change'));
  check('changing the category moves the Save As folder to that category', /documents/.test($('#iSave').value) && /sample_al\.zip$/.test($('#iSave').value) && $('#iRemCat').textContent === 'Documents');
  $('#iCat').value = 'compressed'; $('#iCat').dispatchEvent(new w.Event('change'));
  $('#iDesc').value = 'language pack'; $('#iRem').checked = true;
  click($('#iLater'));
  await wait(() => !$('#dInfo').hasAttribute('open') && dlCount() === before + 1);
  const later = [...mgr.downloads.values()].pop();
  check('Download Later adds it to the main queue without starting, with the description', later.rec.queue === 'main' && later.rec.status === 'queued' && later.rec.description === 'language pack' && mgr.snapshot().proposals.length === 0);

  mgr.propose({ url: base + '/cancel-me.zip', source: 'clipboard' });
  await wait(() => $('#dInfo').hasAttribute('open') && $('#iUrl').value.endsWith('cancel-me.zip'));
  click($('#fiCancel'));
  await wait(() => !$('#dInfo').hasAttribute('open') && mgr.snapshot().proposals.length === 0);
  check('Cancel discards the request: nothing is downloaded', dlCount() === before + 1);

  mgr.propose({ url: base + '/esc-me.zip' });
  await wait(() => $('#dInfo').hasAttribute('open') && $('#iUrl').value.endsWith('esc-me.zip'));
  $('#dInfo').close(); // Esc
  await wait(() => mgr.snapshot().proposals.length === 0);
  check('closing the dialog with Esc counts as Cancel', dlCount() === before + 1);

  mgr.propose({ url: base + '/first.zip' }); mgr.propose({ url: base + '/second.zip' });
  await wait(() => $('#dInfo').hasAttribute('open') && $('#iUrl').value.endsWith('first.zip'));
  click($('#iStart'));
  await wait(() => $('#dInfo').hasAttribute('open') && $('#iUrl').value.endsWith('second.zip'));
  check('Start Download starts it and the next waiting request is shown', [...mgr.downloads.values()].some(d => d.rec.url.endsWith('/first.zip') && d.rec.status !== 'queued'));
  click($('#fiCancel')); await wait(() => !$('#dInfo').hasAttribute('open'));

  // ---- "Duplicate download link" dialog ----
  mgr.setSettings({ duplicatePolicy: 'ask' });
  const dupUrl = base + '/files/movie.bin'; // downloaded completely earlier in this test
  const openDup = () => $$('#dyn dialog[open]').find(x => /Duplicate download link/.test(x.textContent));
  const dupBefore = dlCount();
  mgr.propose({ url: dupUrl });
  await wait(() => $('#dInfo').hasAttribute('open') && $('#iUrl').value === dupUrl && /already in your download list/.test($('#iWarn').textContent));
  check('the Download File Info window warns that the link is already in the list', true);
  click($('#iStart'));
  await wait(() => openDup());
  const dd = openDup();
  check('a duplicate link opens "Duplicate download link" describing the existing file (name, folder, status, size)', /movie\.bin/.test(dd.textContent) && /Complete/.test(dd.textContent) && /already in your download list/.test(dd.textContent) && /800\.0 KB/.test(dd.textContent));
  const radios = [...dd.querySelectorAll('[name=dupc]')].map(r => r.value);
  check('it offers: numbered file name, overwrite, keep existing, and "do not ask again"', radios.join() === 'number,overwrite,resume' && /numbered file name/.test(dd.textContent) && /movie_2\.bin/.test(dd.textContent) && /Keep the existing file/.test(dd.textContent) && !!dd.querySelector('#dupRem'));
  click([...dd.querySelectorAll('button')].find(b => b.textContent === 'Cancel'));
  await wait(() => !openDup());
  check('Cancel returns to the Download File Info window (nothing added)', $('#dInfo').hasAttribute('open') && dlCount() === dupBefore);
  click($('#iStart')); await wait(() => openDup());
  const dd2 = openDup(); dd2.querySelector('[value=resume]').checked = true;
  click([...dd2.querySelectorAll('button')].find(b => b.textContent === 'OK'));
  await wait(() => !$('#dInfo').hasAttribute('open') && !openDup());
  check('"Keep the existing file" closes the request without adding a second download', dlCount() === dupBefore && mgr.snapshot().proposals.length === 0);

  mgr.propose({ url: dupUrl });
  await wait(() => $('#dInfo').hasAttribute('open') && $('#iUrl').value === dupUrl);
  click($('#iStart')); await wait(() => openDup());
  const dd3 = openDup(); dd3.querySelector('#dupRem').checked = true; // numbered (default) + do not ask again
  click([...dd3.querySelectorAll('button')].find(b => b.textContent === 'OK'));
  await wait(() => !$('#dInfo').hasAttribute('open') && dlCount() === dupBefore + 1 && mgr.settings.duplicatePolicy === 'number');
  check('a numbered duplicate is added, and "do not ask again" stores the choice in Options', [...mgr.downloads.values()].some(d => d.rec.url === dupUrl && /movie.*\.bin$/.test(d.rec.fileName)) && mgr.settings.duplicatePolicy === 'number');
  mgr.setSettings({ duplicatePolicy: 'ask' });

  click($('#bOpts')); await wait(() => $('#dOpts').hasAttribute('open'));
  click($('#optTabs button[data-t="Downloads"]'));
  check('Options > Downloads has the switch for the Download File Info dialog (on by default)', $('#o_confirm') && $('#o_confirm').checked === true);
  $('#o_confirm').checked = false; click($('#oSave'));
  await wait(() => mgr.settings.confirmDownloads === false);
  const n = dlCount();
  const direct = mgr.propose({ url: base + '/silent.zip', startNow: true, queue: null });
  check('with the switch off, captured downloads start directly again', !direct.proposal && dlCount() === n + 1 && !$('#dInfo').hasAttribute('open'));
  mgr.setSettings({ confirmDownloads: true });
  mgr.probe = realProbe;

  // ---- "Download this video": quality dialog, tools, options ----
  const FAKE = [process.execPath, path.join(ROOT, 'test', 'fixtures', 'fake-ytdlp.js')];
  process.env.ADM_TOOLS_DIR = path.join(tmp, 'tools'); process.env.ADM_FAKE_LOG = path.join(tmp, 'fake.log');
  mgr.setSettings({ video: { ytdlpPath: FAKE, ffmpegPath: FAKE } });
  const openV = () => $('#dVideo').hasAttribute('open');
  const vText = () => $('#vBody').textContent.replace(/\s+/g, ' ');
  const vidsBefore = [...mgr.downloads.values()].filter(d => d.rec.kind === 'video').length;
  const { id: vid1 } = mgr.videoOpen({ url: 'https://site.example/watch?v=ui1', title: 'tab', cookies: [{ name: 'a', value: 'b', domain: 'site.example' }] });
  await wait(() => openV() && $('#vBody [name=vq]'));
  check('a video request opens the video dialog with title, thumbnail, source and the quality list (best first, with sizes)', $('#vName').value === 'My: Test/Video *1*' && !!$('#vBody img') && /FakeSite/.test(vText()) && /Some Channel/.test(vText()) && /0:20/.test(vText())
    && $$('#vBody [name=vq]').length >= 5 && $('#vBody [name=vq]:checked').value === 'best-video' && /≈/.test($('#vChoices').textContent) && /Best quality \(1080p\)/.test($('#vChoices').textContent));
  check('the video dialog has Download Later / Download / Cancel and a folder box (video folder by default)', !$('#vStart').hidden && !$('#vLater').hidden && !!$('#vCancel') && $('#vDir').value === path.join(tmp, 'dl', 'video') && !!$('#vBrowse'));
  const audioRadio = $('#vBody [name=vq][value=audio-mp3]'); audioRadio.checked = true; audioRadio.dispatchEvent(new w.Event('change'));
  check('choosing audio only moves the folder to the music folder', $('#vDir').value === path.join(tmp, 'dl', 'music'));
  $('#vBody [name=vq][value=h720]').checked = true; $('#vBody [name=vq][value=h720]').dispatchEvent(new w.Event('change'));
  click($('#vLater'));
  await wait(() => !openV() && [...mgr.downloads.values()].filter(d => d.rec.kind === 'video').length === vidsBefore + 1);
  const vLater = [...mgr.downloads.values()].filter(d => d.rec.kind === 'video').pop();
  check('Download Later queues the chosen quality without starting', vLater.rec.queue === 'main' && vLater.rec.status === 'queued' && vLater.rec.video.selector === 'bv*[height<=720]+ba/b[height<=720]' && mgr.snapshot().videoRequests.length === 0);

  mgr.videoOpen({ url: 'https://site.example/watch?v=ui2' });
  await wait(() => openV() && $('#vBody [name=vq]'));
  click($('#vCancel'));
  await wait(() => !openV() && mgr.snapshot().videoRequests.length === 0);
  check('Cancel discards the video request', [...mgr.downloads.values()].filter(d => d.rec.kind === 'video').length === vidsBefore + 1);

  mgr.videoOpen({ url: 'https://site.example/watch?v=ui3' });
  await wait(() => openV() && $('#vBody [name=vq]'));
  $('#vName').value = 'My clip'; click($('#vStart'));
  await wait(() => !openV());
  const vStart = await wait(() => { const d = [...mgr.downloads.values()].find(x => x.rec.kind === 'video' && x.rec.fileName === 'My clip.mp4'); return d && (d.rec.status === 'complete' || d.rec.status === 'error') && d; });
  check('Download starts the video download with the typed name, and it completes in the list', vStart.rec.status === 'complete' && fs.existsSync(path.join(vStart.rec.saveDir, 'My clip.mp4')), vStart.rec.error);

  mgr.videoOpen({ url: 'https://site.example/unsupported/page', media: [{ url: base + '/files/clip-found.mp4', type: 'video/mp4', size: 5000 }] });
  await wait(() => openV() && /could not be read/.test(vText()));
  check('an unsupported page explains why, offers Try again / Update, and lists media files found on the page', /No downloadable video/.test(vText()) && !!$('#vRetry') && !!$('#vUpdate') && /clip-found\.mp4/.test(vText()) && $('#vStart').hidden);
  click($('[data-vmedia]'));
  await wait(() => !openV() && mgr.snapshot().proposals.some(p => /clip-found\.mp4/.test(p.url)));
  check('a found media file goes to the Download File Info window instead', true);
  for (const p of mgr.snapshot().proposals) mgr.proposalReject(p.id);
  await wait(() => !$('#dInfo').hasAttribute('open'));

  // no tools installed: the one-time setup text
  const savedPath = process.env.PATH; process.env.PATH = '';
  mgr.setSettings({ video: { ytdlpPath: '', ffmpegPath: '' } });
  mgr.videoOpen({ url: 'https://site.example/watch?v=ui4' });
  await wait(() => openV() && /One-time setup/.test(vText()));
  check('without the video engine the dialog offers a one-time install (sizes, official sources, checksums)', !!$('#vInstallAll') && !!$('#vInstallYt') && /yt-dlp/.test(vText()) && /FFmpeg/.test(vText()) && /checksums/.test(vText()) && /right to download/.test(vText()));
  process.env.PATH = savedPath;
  mgr.setSettings({ video: { ytdlpPath: FAKE, ffmpegPath: FAKE } });
  mgr._reprobeVideoRequests();
  await wait(() => $('#vBody [name=vq]'));
  check('once the engine is available the waiting request continues by itself', true);
  click($('#vCancel')); await wait(() => !openV() && mgr.snapshot().videoRequests.length === 0);

  // Options > Video
  click($('#bOpts')); await wait(() => $('#dOpts').hasAttribute('open'));
  click($('#optTabs button[data-t="Video"]'));
  await wait(() => $('#vToolsInfo') && /yt-dlp/.test($('#vToolsInfo').textContent) && !/Checking/.test($('#vToolsInfo').textContent));
  check('Options > Video shows the tools, install / update buttons and quality, parts, auto-update settings', !!$('#vtInstall') && !!$('#vtUpdate') && !!$('#vtAdd') && !!$('#o_vq') && !!$('#o_vfrag') && !!$('#o_vupd'));
  $('#o_vq').value = '720'; $('#o_vfrag').value = '12'; click($('#oSave'));
  await wait(() => mgr.settings.video.maxHeight === 720);
  check('the video settings are saved (and the tool paths kept)', mgr.settings.video.concurrentFragments === 12 && Array.isArray(mgr.settings.video.ytdlpPath));
  mgr.setSettings({ video: { ...mgr.settings.video, maxHeight: 0 } });

  // Tasks menu: a page address typed by hand
  click($$('#menubar [data-m^="Tasks:"]').find(b => /Download video from a page address/.test(b.textContent)));
  await wait(() => $$('#dyn dialog[open]').some(x => /Download video from a page address/.test(x.textContent)));
  $('#vpUrl').value = 'https://site.example/watch?v=typed';
  click($$('#dyn dialog[open] button').find(b => b.textContent === 'Continue'));
  await wait(() => openV() && $('#vBody [name=vq]'));
  check('Tasks > Download video from a page address opens the same quality dialog', $('#vName').value === 'My: Test/Video *1*');
  click($('#vCancel')); await wait(() => !openV());

  // ---- Dial Up / VPN options save ----
  click($('#bOpts')); await wait(() => $('#dOpts').hasAttribute('open'));
  click($('#optTabs button[data-t="Dial Up / VPN"]'));
  $('#d_on').checked = true; $('#d_att').value = '5'; $('#d_sec').value = '2'; click($('#oSave'));
  await wait(() => mgr.settings.dialup.enabled === true);
  check('Dial Up / VPN settings are saved', mgr.settings.dialup.redialAttempts === 5 && mgr.settings.dialup.redialSeconds === 2);
  mgr.setSettings({ dialup: { enabled: false, entry: '', user: '', pass: '', redialAttempts: 3, redialSeconds: 10 } });

  // ---- 401 login prompt ----
  w.eval('maybeAskAuth({ id: "zz", url: "http://files.example/f.zip", status: "error", error: "Authorization required (401)", authRealm: "Members" })');
  await wait(() => $$('#dyn dialog[open]').some(x => /Connecting to the site/.test(x.textContent)));
  check('401 error opens the login prompt with the realm', $$('#dyn dialog[open]').some(x => /Members/.test(x.textContent)));
  click($$('#dyn dialog[open]').find(x => /Connecting to the site/.test(x.textContent)).querySelector('button'));

  // ---- Help menu ----
  click($$('#menubar [data-m^="Help:"]')[0]);
  await wait(() => $$('#dyn dialog[open]').some(x => /Check for updates/.test(x.querySelector('h3').textContent)), 20000);
  check('Help > Check for updates reports a result', /latest version|Could not check|Version/.test($$('#dyn dialog[open]').find(x => /Check for updates|Update available/.test(x.querySelector('h3').textContent)).textContent));
  click($$('#dyn dialog[open]').find(x => /Check for updates/.test(x.querySelector('h3').textContent)).querySelector('button'));
  click($$('#menubar [data-m^="Help:"]')[1]);
  await wait(() => $$('#dyn dialog[open]').some(x => /About Advance Download Manager/.test(x.querySelector('h3').textContent)));
  check('Help > About opens and shows the version', /\d+\.\d+\.\d+/.test($$('#dyn dialog[open]').find(x => /About Advance Download Manager/.test(x.querySelector('h3').textContent)).textContent));
  click($$('#dyn dialog[open]').find(x => /About Advance Download Manager/.test(x.querySelector('h3').textContent)).querySelector('button'));

  // ---- menu bar action ----
  click($$('#menubar [data-m="Downloads:0"]')[0]); // Pause / stop all
  check('menu items trigger actions without script errors', true);

  check('no uncaught script errors during the session', errors.length === 0, errors.join(' | '));
  const failed = results.filter(x => !x).length;
  console.log(`\n${results.length - failed}/${results.length} UI checks passed`);
  await new Promise(r => setTimeout(r, 500)); // let the last click's request finish before the server goes away
  process.on('unhandledRejection', () => {}); // anything the page still had in flight during teardown is not a test failure
  dom.window.close(); srv.server.close(); origin.close(); await mgr.shutdown(); fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('UI TEST CRASH', e); process.exit(2); });
