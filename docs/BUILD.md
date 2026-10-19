# Building, signing and releasing

Requirements: Windows 10/11 x64, Node.js ≥ 24 (single-executable support), PowerShell 5.1, the C# compiler that ships with Windows
(.NET Framework 4.x `csc.exe` — no SDK needed), Inno Setup 6 (`winget install JRSoftware.InnoSetup`) and internet access for the first WebView2 download.
Run `npm ci` once.

## The native app

```powershell
npm run build:host           # build/host/        native window host (C#) + pinned WebView2 libraries
npm run build:exe:unsigned   # build/adm-engine.exe   the download engine (Node single-executable application)
npm run release              # everything above, signed, + installer, portable zip and SHA256SUMS.txt in release/
```

The app is one folder with these parts:

| File | What it is |
|---|---|
| `AdvanceDownloadManager.exe` | **Native host** (`host/Program.cs`, ~60 KB, C# 5, x64). A real top-level window with taskbar button and icon, a WebView2 control showing the UI, the tray icon and its menu, single-instance handling, window position memory. Starts and supervises the engine. |
| `adm-engine.exe` | **Engine** (~90 MB because it contains the Node runtime): the download engine plus the local API and UI server on 127.0.0.1. |
| `Microsoft.Web.WebView2.Core.dll`, `…WinForms.dll`, `WebView2Loader.dll` | Pinned WebView2 SDK libraries: `scripts/build-host.js` downloads the NuGet package `Microsoft.Web.WebView2` 1.0.2739.15 and verifies its SHA-256 before use (cached in `.cache/`). |
| `browser-extension\chrome`, `…\firefox`, `LICENSE` | Extensions and licence. |
| `tools\yt-dlp.exe`, `tools\ffmpeg.exe` | The video engine (about 17 MB + 132 MB), fetched and checksum-verified by `scripts/fetch-tools.js`; it makes the installer about 85 MB and the portable zip about 110 MB. |

Requirement to run: the **Microsoft Edge WebView2 Runtime** (preinstalled on Windows 11 and current Windows 10). Without it the host asks whether to open the UI
in the default browser or to download the runtime.

Host command line: `--minimized` (start in the tray), `--quit` (ask the running instance to exit), `--setup-browsers` (show *Options → Browser*; the installer's last-page option); every other argument (`/d URL /p dir /f name /q /a /s`) goes to
the engine. Environment: `ADM_DATA_DIR` (engine data folder), `ADM_HOST_DEVTOOLS=1` (WebView2 developer tools), `ADM_HOST_LOG`, `ADM_HOST_SELFTEST=1` (test hooks), `ADM_INSTANCE` (suffix for the single-instance names) and `ADM_HOST_DATA` (window/WebView2 profile folder) — the last two let tests run next to a real running copy without touching it.

**Engine packaging** (`scripts/build-exe.js`): bundles `bin/` and `src/` into one file; packs `public/`, `extension/`, `assets/icon.ico` and `tray.ps1` as assets;
copies `node.exe`, sets icon and version info (rcedit), injects the bundle as a Node single-executable application (postject) and switches the PE subsystem to
*Windows GUI*. On start the assets are unpacked to `%LOCALAPPDATA%\Advance Download Manager\runtime\<version>-<content hash>\` (older copies are removed).

**Staging** (`scripts/release.js`): host + engine + libraries + extensions + `tools` (yt-dlp, FFmpeg) + licence are collected in `build/app/`; the host is signed (the engine is signed by `build-exe.js`).

## Installer and portable zip

`installer/adm.iss` is compiled from `build/app/` with Inno Setup and signed; `release/` then contains:

* `AdvanceDownloadManager-<v>-win-x64-Setup.exe` — per-user install by default (admin optional), Start-menu shortcuts, optional desktop icon and
  start-with-Windows task (`AdvanceDownloadManager.exe --minimized`), upgrades over a running copy (the installer asks the engine to shut down through its
  local API first, force-closing only as a fallback), uninstall removes the program, shortcuts, the startup value and `%LOCALAPPDATA%\Advance Download Manager`.
* `AdvanceDownloadManager-<v>-win-x64-portable.zip` — the same folder without an installer.
* `adm-selfsigned.cer` (self-signed builds only) and `SHA256SUMS.txt`.

User data in `%USERPROFILE%\.advance-download-manager` is kept on uninstall.

## Auto-update

`src/updater.js` reads the latest GitHub release of `updates.repo` (default `kaushalsah606/ADM---Advance-Download-Manager-`, changeable in the settings),
needs the assets `*-Setup.exe` and `SHA256SUMS.txt`, verifies the SHA-256, restricts downloads to `https://github.com/<repo>/releases/download/`,
and runs the installer with `/SILENT /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS` only after the user clicks *Install now*. The daily check can be disabled in *Options → General* (setting `updates.check`).

## Code signing

`scripts/sign.ps1` signs with SHA-256 and requests an RFC 3161 timestamp (tries `timestamp.sectigo.com`, `time.certum.pl`, DigiCert and GlobalSign; override with
`ADM_TIMESTAMP_URL`; `ADM_REQUIRE_TIMESTAMP=1` fails the build if none answers). It signs the host, the engine and the installer.

| Mode | How | Result |
|---|---|---|
| **Trusted (production)** | Get a code-signing certificate from a public CA (OV, or EV for instant SmartScreen reputation) or use a cloud signing service. `set ADM_SIGN_PFX=C:\path\cert.pfx` and `set ADM_SIGN_PASSWORD=...`, then `npm run release`. | Publisher shown, SmartScreen trusts it (EV immediately; OV after reputation builds). |
| **Self-signed (default)** | Nothing to set; a certificate `CN=@kaushalsah606, O=Advance Download Manager, C=NP` is created in the current user's certificate store and its public part is exported to `build/cert/`. | Valid signature, tamper-evident, but **not trusted by Windows**. |

Details and free options for open-source projects: [SIGNING.md](SIGNING.md). Never commit `.pfx` files or passwords. For CI, store the certificate as the secrets
`SIGN_PFX_BASE64` / `SIGN_PFX_PASSWORD` (see `.github/workflows/release.yml`). Verify: `Get-AuthenticodeSignature release\*.exe`.

## Releasing

1. Bump the version in `package.json`, `package-lock.json`, `src/version.js` and `host/Program.cs` (assembly attributes); add a `CHANGELOG.md` entry.
   `test/updater.test.js` checks that `src/version.js` matches `package.json`.
2. Run `npm test`, `npm run test:ui` and (on Windows) `npm run test:e2e`.
3. `git tag vX.Y.Z && git push --tags` — the *Release* workflow builds the host and engine, signs, builds the installer and portable zip and attaches them with the checksums.
4. Optionally publish `dist/chrome` / `dist/firefox` to the browser stores.

## Browser-extension packages

`npm run build:extensions` writes `dist/chrome`, `dist/firefox` and store-ready zips in `dist/store/` (`scripts/zipwrite.js` — forward-slash paths, reproducible; PowerShell's own zip tool writes backslashes that the stores reject). `npm run release` copies the zips into `release/`.
Publishing steps, listing text and permission justifications: [STORE-LISTING.md](STORE-LISTING.md). The extension's version follows the app's.

## Video engine (yt-dlp + FFmpeg)

`scripts/fetch-tools.js` downloads both once into `build/tools` (checksum-verified; `--refresh` fetches again) and `scripts/release.js` copies them to `<app>\tools`, so the installer and the portable zip contain them. If they are missing the app can still download them on demand into `%LOCALAPPDATA%\Advance Download Manager\tools\` (`ADM_TOOLS_DIR` overrides it) after the user agrees, verifying the SHA-256 published next to each file
(yt-dlp: `github.com/yt-dlp/yt-dlp` releases; FFmpeg: `github.com/BtbN/FFmpeg-Builds` LGPL win64 build). The tests never need them: `test/video.test.js` uses `test/fixtures/fake-ytdlp.js`, a stand-in that answers `-J`, writes
`.part` files, prints progress and can mangle the printed path. To try the real thing by hand, install both from *Options → Video* (or `video.install(['ytdlp', 'ffmpeg'])`) and open a video page.

## Tests that need Windows

`npm run test:e2e` runs `test-browser/` (close the app first: a running ADM on port 6800 makes the extension tests pair with it instead of the test app): Edge and Firefox extension tests (real browsers driven over DevTools / WebDriver BiDi), the native-window test
(set `ADM_APP_DIR` to test an installed or unzipped copy instead of `build/app/`; it also checks the video dialog), the PC-wide capture test (changes the per-user Windows proxy-script setting for a few seconds and always restores it), the PowerShell tray test (source mode) and the OS-command test (a real `shutdown /s /t 60`
is started and cancelled immediately).

## Not covered

No MSI package, no store listing for the extensions, no ARM64 build. macOS/Linux run from source.
