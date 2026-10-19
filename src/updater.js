'use strict';
// Update check + install for the Windows installer build.
//   * asks GitHub Releases for the latest version of the configured repository
//   * downloads the "...-Setup.exe" asset and verifies it against the release's SHA256SUMS.txt
//   * starts the installer silently (it closes the running app, upgrades in place and restarts it)
// Nothing is installed without the user pressing "Install" in the UI.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const current = require('./version');

const DEFAULT_REPO = 'kaushalsah606/ADM---Advance-Download-Manager-';
const INSTALL_ARGS = ['/SILENT', '/CLOSEAPPLICATIONS', '/RESTARTAPPLICATIONS'];

function cmp(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  return 0;
}

const headers = { 'User-Agent': 'AdvanceDownloadManager/' + current, Accept: 'application/vnd.github+json' };

/** @returns {{current, latest, available, notes, url, asset, sums}} */
async function check({ repo = DEFAULT_REPO, apiBase = 'https://api.github.com' } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository name');
  const r = await fetch(`${apiBase}/repos/${repo}/releases/latest`, { headers, signal: AbortSignal.timeout(15000) });
  if (r.status === 404) return { current, latest: current, available: false, notes: '' };
  if (!r.ok) throw new Error('Update server answered HTTP ' + r.status);
  const rel = await r.json();
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  const asset = (rel.assets || []).find(a => /-Setup\.exe$/i.test(a.name));
  const sums = (rel.assets || []).find(a => a.name === 'SHA256SUMS.txt');
  return {
    current, latest, available: !!latest && cmp(latest, current) > 0 && !!asset && !!sums,
    notes: String(rel.body || '').slice(0, 4000), url: rel.html_url,
    asset: asset && { name: asset.name, url: asset.browser_download_url, size: asset.size },
    sums: sums && { url: sums.browser_download_url },
  };
}

async function get(url, allowedPrefixes) {
  if (!allowedPrefixes.some(p => url.startsWith(p))) throw new Error('Refusing to download from ' + url);
  const r = await fetch(url, { headers: { 'User-Agent': headers['User-Agent'] }, redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!r.ok) throw new Error(`Download failed (HTTP ${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

/** Download + verify. Returns the path of the verified installer. */
async function download(info, { repo = DEFAULT_REPO, allowedPrefixes } = {}) {
  if (!info || !info.available) throw new Error('No update available');
  const prefixes = allowedPrefixes || [`https://github.com/${repo}/releases/download/`];
  const sums = (await get(info.sums.url, prefixes)).toString('utf8');
  const line = sums.split(/\r?\n/).map(l => l.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i)).find(m => m && m[2] === info.asset.name);
  if (!line) throw new Error('The release has no checksum for ' + info.asset.name);
  const data = await get(info.asset.url, prefixes);
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  if (sha !== line[1].toLowerCase()) throw new Error('Checksum mismatch - the download was not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-update-'));
  const file = path.join(dir, path.basename(info.asset.name));
  fs.writeFileSync(file, data);
  return file;
}

/** Runs the downloaded installer silently; the caller should exit afterwards. */
function install(file, { dryRun = false } = {}) {
  if (dryRun) return INSTALL_ARGS;
  const child = spawn(file, INSTALL_ARGS, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

module.exports = { check, download, install, cmp, current, DEFAULT_REPO };
