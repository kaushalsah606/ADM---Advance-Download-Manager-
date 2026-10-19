# Architecture

Two processes on Windows, one when run from source:

```
AdvanceDownloadManager.exe  (native host, C#)             adm-engine.exe  (Node.js single-executable)
  window + WebView2  ──── http://127.0.0.1:<port>/ ────▶  UI + REST/SSE API + download engine
  tray icon + menu   ──── REST calls with the token ───▶  queues, scheduler, grabber, proxy, updater
  starts / supervises the engine  ◀── session.json ────  writes {port, token, pid} in ~/.advance-download-manager
```

From source (`npm start`) the launcher starts the engine directly and opens the UI in a browser (Windows additionally shows a PowerShell tray icon).

## Layout

```
host/Program.cs                   native Windows host: window (WebView2), tray icon, single instance, engine supervision (scripts/build-host.js)
host/app.manifest                 per-monitor DPI awareness, asInvoker
bin/advance-download-manager.js   engine launcher + CLI switches (/d /p /f /q /n /a /s), hand-off to a running instance
src/manager.js                    Manager (EventEmitter): settings, categories, queues/scheduler, grabber, dial-up, completion actions, persistence
src/download.js                   download engine: probe, segmentation, workers, resume, HTTP/FTP/HLS/DASH/RTMP back-ends
src/policy.js                     engine constants (connection counts and ceilings for normal and Turbo mode, ramp-up timings, retry delay, overlap size)
src/tuner.js                      auto-tune: picks the number of connections from the measured speed (see "Speed model")
src/util.js, httpauth.js, ntlm.js HTTP client with redirects, cookies, Basic/Digest/NTLMv2
src/proxy.js, pac.js              proxy selection (system / PAC in a vm sandbox / manual / SOCKS 4-5)
src/hls.js dash.js rtmp.js        streaming protocols; ftp.js, multipart.js, zip.js, batch.js, grabber.js, exportio.js
src/captureproxy.js               optional local proxy that captures plain-HTTP downloads
src/server.js                     REST + Server-Sent-Events API on 127.0.0.1 (token, Host check, CORS only for extension origins)
src/updater.js, version.js        GitHub-release update check; checksum-verified installer download
src/video.js                      "Download this video": finding / installing yt-dlp and FFmpeg, reading a video page, quality choices, yt-dlp command line
src/youtube.js                    YouTube through its player API (the YoutubeExplode method): visitor id, VISIONOS / ANDROID clients, stream list -> quality choices
src/ytdownload.js                 YouTube streams: ranged pieces, resume side file, FFmpeg join
src/videodownload.js              VideoDownload: runs yt-dlp as a normal list entry (progress, pause / resume, cleanup)
src/syscapture.js                 PC-wide capture: Windows proxy-script (AutoConfigURL) setting with backup / restore
src/tray.js, tray.ps1             notification-area icon for source runs (the native host has its own)
src/paths.js                      resource lookup (repository folder, or files unpacked from the single-file engine)
public/index.html                 the whole UI (no framework, no build step)
extension/                        Chrome/Edge (MV3) and Firefox extensions: background.js (pairing, takeover, media sniffing, right-click menu), video-button.js (the content script),
                                  popup.* and options.* with the shared ui.css; scripts/build-extensions.js assembles dist/
installer/adm.iss                 Inno Setup script
scripts/                          build-host.js, build-exe.js, build-extensions.js, fetch-tools.js (yt-dlp + FFmpeg for the package), release.js, sign.ps1, make-icon.ps1, run-tests.js
docs/images/                      screenshots used by the README
test/                             node:test integration tests with local mock servers
test-ui/                          jsdom checks of the real page
test-browser/                     real Edge / Firefox, native window, tray and OS-command end-to-end tests (Windows)
```

## Native host behaviour

* **Start:** `Engine.Ensure` reads `session.json`; if no engine answers, it starts `adm-engine.exe --no-open --no-tray` (plus any command-line arguments) and waits until the API
  responds. The engine is told where the host lives (`ADM_HOST_EXE`) so *start with Windows* registers the host, not the engine.
* **Window:** a WinForms form with a WebView2 control. Navigation is restricted to `http://127.0.0.1`; other links and new windows open in the default browser; developer
  tools, autofill and pinch-zoom are off. Size, position and maximized state are saved in `%LOCALAPPDATA%\Advance Download Manager\window.json`.
* **Feels like an application:** the browser's script dialogs, accelerator keys (F5, Ctrl+P …), zoom and permission prompts are off, and the page's context menu keeps only Cut / Copy / Paste / Select all / Undo / Redo.
  The page uses in-app dialogs (`uiConfirm`, `uiPrompt`) instead of `confirm()` / `prompt()`.
* **Window ↔ page bridge:** the page can post one question to the host (`chrome.webview.postMessage`, only from `http://127.0.0.1:<port>`): `clipboard`. The host answers with the clipboard text **only if it is a web address**
  (`http`, `https`, `ftp`, ≤ 2000 characters). *Add URL* uses it to open with the link you copied last already pasted. (A `log` message exists for the self-test only.)
* **Notifications:** the *Download complete* balloon remembers the finished file; clicking it opens Explorer with the file selected (the folder if the file was moved). The clipboard-offer balloon (*Download this link?*) is separate.
* **Extension requests:** a new pairing request in `pendingPairs` makes the host show the window and a balloon (the Allow / Deny prompt itself is part of the page).
* **Tray:** `NotifyIcon` with Open / Start main queue / Stop all downloads / Turbo mode (checked while on; `PUT /api/settings {"turbo":…}`) / Exit; polls `/api/state` every 1.5 s for the tooltip and completion balloons.
  If the *tray icon* setting is off, closing the window exits the app.
* **Close vs. exit:** closing the window hides it (downloads continue); *Exit*, `--quit` or an engine that stops answering (3 failed polls) ends the host; *Exit* and `--quit` also shut the engine down.
* **Single instance:** a named mutex plus named events (`Show`, `Quit`); a second launch forwards its arguments to the engine and signals the first window.

## Download flow

1. `Manager.add()` creates a record (category, directory, duplicate policy) and persists it to `~/.advance-download-manager/state.json`. All default categories save directly into `~/Downloads`
   (`DL_ROOT`; the tests set `ADM_DOWNLOAD_ROOT`); categories saved by older versions with the old `Downloads\Advance Download Manager\<Category>` folders are moved to `Downloads` when the state is loaded, folders chosen by the user stay.
2. `Download._runOnce()` probes the URL (GET `Range: 0-0`), learns size/range support/name, then runs the segmented engine:
   dynamic half-division of the largest remaining segment, up to `min(remaining/10 KB, maxConnections, 32)` workers, started progressively.
3. Each segment request overlaps the already-written data by 64 bytes; a mismatch restarts the file on one connection.
4. Progress and state changes are pushed to the UI over SSE; completion actions (exit, shutdown, hang up, run program) run when a queue finishes.

## Browser integration, pairing and capture

* **Pairing (no token copying):** the extension `POST`s `/api/pair` (no token) from its own origin (`chrome-extension://…`, `moz-extension://…`; a web page cannot forge that header, and other origins get 403).
  The engine records a pending request (`pendingPairs` in the state) and answers 202; the UI shows *Allow this browser extension to connect?* and the native host brings the window forward with a notification.
  After *Allow* the origin is stored in `settings.pairedExtensions` and the next request is answered 200 with the token and port. A refusal is remembered for 10 minutes. The extension tries its stored port, then 6800 and 6810–6819, at install, at browser start and once a minute until connected, and pairs again if the token is ever rejected.
* **Download File Info (confirmation):** captured downloads (`source` = `browser`, `clipboard` or `capture`) enter through `Manager.propose()`, not `add()`. With `confirmDownloads` on (default) a *proposal* is stored (`snapshot().proposals`), probed in the background for file name, size, content type and category, and shown by the UI as the Download File Info dialog; the native host brings the window forward. `POST /api/proposals/:id/accept` (`action`: `start` | `later`, plus `fileName`, `saveDir`, `category`, `description`, `rememberPath`, `allowDuplicate`) turns it into a download via `add()`; `reject` discards it; `preview` lists a ZIP's contents; `POST /api/pick-folder` opens the Windows folder chooser. A link that is already in the list makes `proposalAccept` answer `{duplicate: true, existing}` (the existing entry's view) when the policy is *ask*; the UI's "Duplicate download link" dialog then calls it again with `duplicatePolicy` = `number` | `overwrite` | `resume` (and may store the choice in `settings.duplicatePolicy`). The same link is never proposed twice; unreadable links still open the dialog with the reason. With `confirmDownloads` off `propose()` is just `add()` + start. Typed-in downloads (Add URL, `/d`) are never held back.
* **Port fallback:** if 6800 is taken the engine listens on 6810–6819.
* **PC-wide capture:** `syscapture.js` points the per-user `AutoConfigURL` at `http://127.0.0.1:<port>/capture.pac`, served by the engine. The script sends only `http://` requests to non-local, non-private hosts to the capture proxy (`PROXY 127.0.0.1:6801; DIRECT`). The previous value is kept in `<data>/proxy-backup.json`; it is restored on switching off, on every exit path (`process.on('exit')`) and at the next start after a crash. If the engine is killed the script can no longer be fetched and the `; DIRECT` fallback keeps the internet working.
* **Clipboard offers (native host):** a 1 s timer reads the clipboard text, asks `/api/capture-check` whether it is a download link, and shows a balloon; only clicking it calls `/api/downloads`.

## Video downloads

* **Two ways to read a video:** for YouTube addresses (`youtube.videoId`) the request is first read **natively** (`src/youtube.js`): `GET https://www.youtube.com/sw.js_data` gives a visitor id, then `POST /youtubei/v1/player` as the
  `VISIONOS` client (fallback `ANDROID`) returns the stream list with direct addresses (no sign-in, cipher or PO token — the approach of the open-source YoutubeExplode library). Streams are turned into the same format records the
  quality dialog already understands; the chosen streams are stored in the entry (`video.native`). Every other site, and YouTube when the native read fails, goes through yt-dlp.
* **Native YouTube download** (`src/ytdownload.js`): the video and the audio stream are fetched in 8 MB ranged pieces (4 at a time, 6 in Turbo, across both streams), with a `.ytdl` side file that remembers finished pieces so pausing or a restart resumes;
  an address that expires (403 / 410) is asked for again (up to 3 rounds); FFmpeg joins the streams (`-c copy`, MP4 for H.264/VP9 with AAC, otherwise MKV; MP3 is converted). Speed limit and Turbo are honoured. Few connections on purpose: with more, the browser tab
  still loading the same video stalled.
* **yt-dlp fallbacks** (`video.plan`): the plain request, then for YouTube another client (`web_safari,mweb`), without the saved login and the Android VR client; for other sites a browser fingerprint (`--impersonate chrome`), with and without the login.
  The variant that worked is stored (`video.variant`, `video.withCookies`) and used for the download. Retry pauses and request spacing are applied to YouTube only; a browser User-Agent is never passed to YouTube.

* **Request:** the extension's content script (`video-button.js`, shadow-DOM button over playing or hovered videos ≥ 240×135) works out the page address of the video — the post's own permalink in feeds, otherwise the page — and sends it with the page title; the background script adds the tab URL, the sniffed media URLs and the browser's cookies for those addresses and calls `POST /api/video/open`. Pairing and token rules are the same as for downloads.
* **Reading the page:** `Manager.videoOpen` stores a request (cookies go to `<data>/cookies/<id>.txt`, Netscape format, mode 0600; they are never part of the state sent to the UI) and runs `yt-dlp -J --no-playlist` for each candidate address until one works. `video.buildChoices` turns the format list into choices: best first, one per resolution (a file that already has sound, or video + audio joined by FFmpeg when that is better), *Audio only*, *MP3*. Selectors are decided by the app; the browser only sends a choice id.
* **Download:** `videoAccept` creates a normal list entry of `kind: 'video'` handled by `VideoDownload`, which spawns yt-dlp with fixed options (`-f <selector>`, `--no-playlist`, `--concurrent-fragments`, `--http-chunk-size 10M`, cookies, referer, user agent, `--limit-rate` from the limiter, `--ffmpeg-location`, the address after `--`), reads `ADM|…` progress lines for size / progress / speed, and finds the result by folder and name (yt-dlp mangles non-ASCII characters in the path it prints on Windows). Stop kills the process tree; starting again resumes from yt-dlp's `.part` files. Cookie file and temporary files are removed on completion / removal.
* **Tools:** `video.resolveTool` takes the configured command, then `%LOCALAPPDATA%\Advance Download Manager\tools` (installed / updated copy), then the copies shipped in `<app folder>\tools` (`ADM_BUNDLED_TOOLS` overrides), then PATH (nothing is started to look). `video.install` downloads yt-dlp (`yt-dlp.exe` + `SHA2-256SUMS`) and FFmpeg (BtbN LGPL build + `checksums.sha256`) from GitHub and refuses anything that does not match its published SHA-256. The state carries `videoTools` (versions, install progress) and `videoRequests`; the native host brings the window forward for a new request. yt-dlp updates itself (`yt-dlp -U`) at most every three days when it was installed by the app.

## Speed model

* **Auto-tune** (`autoTune`, default on; `src/tuner.js`): the number of connections follows the measured speed instead of a fixed ramp. It starts with 8 connections (Turbo: 16), measures, then tries twice as many and keeps them only if the speed improved by at least 15 % (an improvement of 40 % or more is accepted after 0.45 s, so a per-connection-limited server ramps in a few seconds). If more did not help it tries fewer (×0.67) and keeps the smaller count while the speed stays within 8 % — so a start count that was too high is corrected and the smallest count that gives the full speed is used. It then holds, re-tests one step up (after 15 s, 30 s, then every minute while nothing changes), reacts at once when the speed rises 30 % (a faster line) or falls 40 % (try fewer). Upper bounds: `maxConnections` (≤ 32) in normal mode, `turboConnections` (≤ 64) in Turbo. Connections that are no longer wanted are stopped individually (each worker has its own abort controller) and the part of the file they were fetching goes back to the others. A server that refuses connections lowers the allowed count further (back-off below).
* **Fixed mode** (`autoTune: false`): the older behaviour — `maxConnections` (default 16, ≤ 32), growth by doubling at most once per `rampMs`, only while every connection is receiving and the speed is below 85 % of a configured limit.
* **Turbo mode** (`turbo: true`, `turboConnections` 2–64, default 32): the limiter and quota are skipped and the tuner may use up to `turboConnections` (one per 4 KB remaining, at most). With auto-tune off every wanted connection is opened at once.
* **Back-off (both modes):** when connections fail while more than two are open, the allowed count shrinks by 25 % (at most once a second, never below 2) and surplus workers retire; in Turbo mode these errors do not count towards the failure limit.
* Settings are read live, so toggling Turbo affects downloads that are already running.

## Security notes

Local API only, token on every call, no credentials in exports, PAC scripts sandboxed with a time limit, update downloads restricted to the
configured repository's release assets and verified by SHA-256, the window never leaves `127.0.0.1`. See [SECURITY.md](../SECURITY.md).
