# Advance Download Manager notification-area icon (Windows PowerShell 5.1 + WinForms).
# Started by the launcher; it only talks to the local API on 127.0.0.1 and exits when the server goes away.
param([Parameter(Mandatory = $true)][int]$Port)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$token = $env:ADM_TOKEN
function Log([string]$m) { if ($env:ADM_TRAY_LOG) { Add-Content -Path $env:ADM_TRAY_LOG -Value ('{0:HH:mm:ss.fff} {1}' -f (Get-Date), $m) } }
Log 'tray starting'
$base = "http://127.0.0.1:$Port"
function Call([string]$method, [string]$path) {
  Invoke-RestMethod -Method $method -Uri "$base$path" -Headers @{ 'X-Token' = $token } -TimeoutSec 4
}

# small blue disc with a white down-arrow, drawn at run time (no icon file needed)
$bmp = New-Object System.Drawing.Bitmap 32, 32
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(23, 105, 224))), 1, 1, 30, 30)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 4
$g.DrawLine($pen, 16, 7, 16, 21)
$g.DrawLine($pen, 9, 15, 16, 22)
$g.DrawLine($pen, 23, 15, 16, 22)
$g.Dispose()
$icon = New-Object System.Windows.Forms.NotifyIcon
$icoFile = Join-Path $PSScriptRoot '..\assets\icon.ico'
$icon.Icon = if (Test-Path $icoFile) { New-Object System.Drawing.Icon $icoFile, 32, 32 } else { [System.Drawing.Icon]::FromHandle($bmp.GetHicon()) }
$icon.Text = 'Advance Download Manager'
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open Advance Download Manager')
$startQ = $menu.Items.Add('Start main queue')
$stopQ = $menu.Items.Add('Stop all downloads')
$null = $menu.Items.Add('-')
$exit = $menu.Items.Add('Exit Advance Download Manager')
$icon.ContextMenuStrip = $menu
$openUi = { Log 'open clicked'; if (-not $env:ADM_TRAY_SELFTEST) { Start-Process "$base/" } }
$open.add_Click($openUi)
$icon.add_DoubleClick($openUi)
$startQ.add_Click({ try { $null = Call 'POST' '/api/queues/main/start' } catch {} })
$stopQ.add_Click({ try { $null = Call 'POST' '/api/stop-all' } catch {} })
$exit.add_Click({ try { $null = Call 'POST' '/api/shutdown' } catch {}; $icon.Visible = $false; $icon.Dispose(); [Environment]::Exit(0) })

# a hashtable is shared by reference; $script: variables do not persist across WinForms event-handler calls
$st = @{ failures = 0; seen = @{}; first = $true }
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  Log 'tick'
  try {
    $s = Call 'GET' '/api/state'
    $st.failures = 0
    $active = @($s.downloads | Where-Object { $_.status -eq 'downloading' })
    $speed = ($active | Measure-Object -Property speed -Sum).Sum
    $text = if ($active.Count) { 'Advance Download Manager - {0} active, {1:N0} KB/s' -f $active.Count, ($speed / 1024) } else { 'Advance Download Manager - idle' }
    $icon.Text = $text.Substring(0, [Math]::Min(63, $text.Length))
    foreach ($d in ($s.downloads | Where-Object { $_.status -eq 'complete' })) {
      if (-not $st.seen.ContainsKey($d.id)) {
        $st.seen[$d.id] = $true
        if (-not $st.first) { $icon.ShowBalloonTip(4000, 'Download complete', $d.fileName, 'Info') }
      }
    }
    $st.first = $false
  } catch {
    Log ('poll failed: ' + $_.Exception.Message)
    $st.failures++
    Log ('failures=' + $st.failures)
    if ($st.failures -ge 3) { Log 'server gone, exiting'; $icon.Visible = $false; $icon.Dispose(); [Environment]::Exit(0) }
  }
})
$timer.Start()

# Test hook (ADM_TRAY_SELFTEST=1): clicks the real menu items on a schedule and logs the result - used by test-browser/tray.e2e.js
if ($env:ADM_TRAY_SELFTEST) {
  $t = @{ n = 0 }
  $drive = New-Object System.Windows.Forms.Timer
  $drive.Interval = 1000
  $drive.add_Tick({
    $t.n++
    Log ('selftest step ' + $t.n + ' visible=' + $icon.Visible + ' tooltip=' + $icon.Text)
    if ($t.n -eq 3) { Log 'click: open'; $open.PerformClick() }
    if ($t.n -eq 4) { Log 'click: start queue'; $startQ.PerformClick() }
    if ($t.n -eq 12) { Log 'click: stop all'; $stopQ.PerformClick() }
    if ($t.n -eq 16) { Log 'click: exit'; $exit.PerformClick() }
  })
  $drive.Start()
}
[System.Windows.Forms.Application]::Run()
$icon.Dispose()
