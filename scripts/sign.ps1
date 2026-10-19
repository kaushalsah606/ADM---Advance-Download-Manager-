# Authenticode-signs a file.
#   Production:  set ADM_SIGN_PFX (path to a code-signing .pfx from a public CA) and ADM_SIGN_PASSWORD  -> trusted signature.
#   Otherwise:   a SELF-SIGNED certificate is created (CN=Advance Download Manager) and used. The signature is valid and the file
#                is tamper-evident, but Windows SmartScreen will NOT trust it until the certificate is installed or you use a CA cert.
param([Parameter(Mandatory = $true)][string]$File)
$ErrorActionPreference = 'Stop'
# When launched from PowerShell 7 (CI steps) PSModulePath points at pwsh's modules and Windows PowerShell cannot load the Cert: drive.
$machinePath = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')
if ($machinePath) { $env:PSModulePath = $machinePath }
Import-Module Microsoft.PowerShell.Security, PKI -ErrorAction SilentlyContinue
$tsList = if ($env:ADM_TIMESTAMP_URL) { @($env:ADM_TIMESTAMP_URL) } else { @('http://timestamp.sectigo.com', 'http://time.certum.pl', 'http://timestamp.digicert.com', 'http://timestamp.globalsign.com/tsa/r6advanced1') }
$root = Split-Path $PSScriptRoot
if ($env:ADM_SIGN_PFX) {
  $pw = ConvertTo-SecureString $env:ADM_SIGN_PASSWORD -AsPlainText -Force
  $cert = Get-PfxCertificate -FilePath $env:ADM_SIGN_PFX -Password $pw
  Write-Host "Signing with CA certificate: $($cert.Subject)"
} else {
  $dir = Join-Path $root 'build\cert'; New-Item -ItemType Directory -Force $dir | Out-Null
  $cer = Join-Path $dir 'adm-selfsigned.cer'
  $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq 'CN=@kaushalsah606, O=Advance Download Manager, C=NP' -and $_.NotAfter -gt (Get-Date).AddDays(30) } | Select-Object -First 1
  if (-not $cert) {
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=@kaushalsah606, O=Advance Download Manager, C=NP' -KeyAlgorithm RSA -KeyLength 3072 `
      -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddYears(3) -CertStoreLocation Cert:\CurrentUser\My
  }
  Export-Certificate -Cert $cert -FilePath $cer | Out-Null
  Write-Host "Signing with SELF-SIGNED certificate (public part: $cer)"
}
$r = $null
foreach ($ts in $tsList) {
  $r = Set-AuthenticodeSignature -FilePath $File -Certificate $cert -HashAlgorithm SHA256 -TimestampServer $ts -ErrorAction SilentlyContinue
  if ($r.TimeStamperCertificate) { Write-Host "Timestamped by $ts"; break }
  Write-Warning "Timestamp server $ts failed"
}
if (-not $r.SignerCertificate) { $r = Set-AuthenticodeSignature -FilePath $File -Certificate $cert -HashAlgorithm SHA256 }
if ($env:ADM_REQUIRE_TIMESTAMP -eq '1' -and -not $r.TimeStamperCertificate) { throw 'No timestamp could be obtained' }
$r | Format-List Status, StatusMessage, SignerCertificate
