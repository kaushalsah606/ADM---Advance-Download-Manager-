# Privacy policy — Advance Download Manager and its browser extension

*Last updated: 2026-10-20. Applies to the desktop app and to the "Advance Download Manager Integration" browser extension (Chrome, Edge, Firefox).*

Advance Download Manager (ADM) is free, open-source software by [@kaushalsah606](https://github.com/kaushalsah606). **It has no servers, no accounts, no analytics and no advertising.** Nothing you do in ADM or in the extension is sent to the author or to any third party.

## What the extension does and what it reads

The extension connects only to **your own computer** (`http://127.0.0.1`, the ADM app running on the same machine). It uses its permissions as follows:

| Permission | Why it is needed |
|---|---|
| `downloads` | to notice a download the browser is about to save and hand it to ADM (and cancel the browser's own copy) |
| `webRequest` (read-only, `<all_urls>`) | to recognise video/audio/HLS streams and large files on the page you are viewing, so ADM can offer to download them |
| `cookies` | to send the cookies of a site to ADM together with a download you chose, so protected downloads (logins) work; cookies go only to the local app |
| `tabs`, `scripting` | to find the links on the current page for *Download all links*, and to show detected media in the extension popup |
| content script on all pages | to show the "Download this video" button over video elements and to read the address of the video's post; it reads no page content beyond that and sends nothing anywhere except (when you click the button) the page address and title to the app on your own computer |
| `contextMenus` | the right-click entries *Download with Advance Download Manager* |
| `storage` | to remember the extension's settings (port, file types, on/off, the websites on which the video button is hidden) and the connection to the app |
| `alarms` | to retry connecting to the app once a minute until you have allowed it |
| host access `<all_urls>` | downloads and media can come from any site |

The extension does not read page content except the list of links when you ask for *Download all links*, does not log or store your browsing history, and sends nothing over the Internet. The data it passes to the app (URL of the file, page address used as referer, cookies for that site) stays on your computer.

## What the app stores

On your computer only: the download list and settings in `%USERPROFILE%\.advance-download-manager\`, a random API token used to protect the local interface, and window position and the WebView2 profile in `%LOCALAPPDATA%\Advance Download Manager\`. Passwords you enter for downloads are stored in that folder; exports never contain passwords or cookies. Uninstalling removes the program; delete the folders above to remove all data.

## Network access of the app

* Downloads connect to the addresses you give it (or that your browser hands over).
* **Update check:** once a day (and when you choose *Help → Check for updates*) the app asks GitHub (`api.github.com`) for the latest release of this project. Nothing about you or your downloads is sent beyond the normal request that any client makes (IP address, a generic user-agent). You can turn the check off in *Options → General*. Updates are never installed without your click and are verified against a published checksum.
* **Optional PC-wide capture** (off by default): points the Windows proxy-script setting at the app so plain-HTTP downloads of other programs can be taken over. HTTPS traffic is never decrypted. It is undone when you switch it off or quit the app.
* **Download confirmation:** the "Download File Info" window asks the download server for the file name and size (a normal request to the address being downloaded); nothing is sent elsewhere.
* **YouTube videos:** the app asks YouTube's own servers (`www.youtube.com`, then the video servers `*.googlevideo.com`) for the video's details and streams directly from your computer, without an account or sign-in and without any third-party service, and downloads the streams itself.
* **Other video sites:** when you click *Download this video* the app (yt-dlp) contacts the site that hosts the video, with the cookies your browser has for that site if you are signed in, exactly like your browser would. The video's thumbnail is loaded from the site's own server to show it in the window. The first time, the app downloads the tools yt-dlp and FFmpeg from GitHub (`github.com/yt-dlp`, `github.com/BtbN`) and verifies their checksums; yt-dlp checks for updates every few days (you can turn this off in *Options → Video*). The cookies are stored in a private file only for the time of that download and deleted afterwards.
* **Clipboard links:** when enabled (default), the native app looks at text you copy; only text that looks like a download link is checked, locally, and you are asked before anything starts. When you open *Add URL*, the window reads the clipboard once and pastes it into the dialog only if it is a web address. The text is not stored or sent anywhere.

## Sharing, selling, children

Nothing is shared or sold, because nothing is collected. The software is not directed at children.

## Contact

Questions or concerns: open an issue at <https://github.com/kaushalsah606/ADM---Advance-Download-Manager-/issues> or see [SECURITY.md](../SECURITY.md) for security reports.
