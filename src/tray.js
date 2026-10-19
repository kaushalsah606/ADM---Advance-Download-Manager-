'use strict';
// Starts the Windows notification-area icon (tray.ps1). No-op on other platforms.
const { resource } = require('./paths');
const { spawn } = require('child_process');

function startTray({ port, token }) {
  if (process.platform !== 'win32') return null;
  const child = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', resource('src', 'tray.ps1'), '-Port', String(port)],
    { env: { ...process.env, ADM_TOKEN: token }, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  return child;
}

module.exports = { startTray };
