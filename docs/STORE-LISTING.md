# Publishing the browser extension

The packages are built by `npm run build:extensions` (also included in `release/`):

* `dist/store/advance-download-manager-chrome-edge-<v>.zip` — for the **Chrome Web Store** and **Microsoft Edge Add-ons** (same Manifest V3 package)
* `dist/store/advance-download-manager-firefox-<v>.zip` — for **Firefox Add-ons (AMO)**

Browsers only install extensions without manual steps when they come from their own store, so publishing is what makes "install once, it just works" possible. Once a listing is live, put its address in `STORE_LINKS` at the top of the Options tabs in `public/index.html`; the *Options → Browser* page then shows a one-click *Get it from the … store* button.

## Accounts and fees (check current terms)

| Store | Account | Notes |
|---|---|---|
| Chrome Web Store | Chrome developer account; one-time registration fee (about 5 USD) | review usually takes days; the broad permissions below need the justifications in this file |
| Microsoft Edge Add-ons | free Partner Center account | same package as Chrome |
| Firefox Add-ons (AMO) | free account; upload the Firefox zip | extension id `advance-download-manager@localhost` is set in `manifest.firefox.json`; change it to an id you own before the first upload (e.g. `adm@your-domain`) and keep it afterwards |

## Listing text

**Name:** Advance Download Manager Integration

**Short description (≤132 characters):** Send downloads, videos and links from your browser to the free, open-source Advance Download Manager app.

**Detailed description:**
> Advance Download Manager Integration connects your browser to the free, open-source Advance Download Manager desktop app (Windows).
>
> • Takes over browser downloads so the app can split them into many connections, resume them and queue them.
> • Detects videos, audio and HLS streams on the page and lets you send them to the app.
> • "Download this video" button on playing videos (YouTube, Facebook, Instagram, TikTok and many more) with a choice of quality — video and audio are handled by the app.
> • "Download all links" collects every link on a page into a selection dialog.
> • Right-click any link, image, video, audio or selected web address → "Download with Advance Download Manager".
> • A clean toolbar popup: connection status, switches to take over downloads and to show or hide the video button (also per website), and the media found on the page.
> • Connects by itself: install the app, install the extension, press Allow once in the app.
>
> Requires the Advance Download Manager app (https://github.com/kaushalsah606/ADM---Advance-Download-Manager-). The extension talks only to the app on your own computer (127.0.0.1) and sends nothing to the Internet. Open source (MIT). Privacy policy: https://github.com/kaushalsah606/ADM---Advance-Download-Manager-/blob/main/docs/PRIVACY.md

**Category:** Productivity (Chrome / Edge) · Download Management (Firefox)

**Single purpose statement (Chrome):** Hand downloads and detected media from the browser to the user's locally installed Advance Download Manager app.

## Permission justifications (paste into the store form)

* **downloads** — detect a download the browser starts and cancel it after handing it to the local app.
* **webRequest** — read response headers (content type and size) to recognise media streams and large files; it never blocks or modifies requests.
* **cookies** — attach the site's cookies to the download request sent to the local app so downloads that need a login work.
* **tabs / scripting** — read the links of the active tab for "Download all links" and associate detected media with its tab.
* **contextMenus** — the "Download with Advance Download Manager" menu entries.
* **Content script on all pages (`<all_urls>`)** — shows the "Download this video" button on video elements and finds the address of the video's post; it runs on every page because videos can be on any site, reads nothing else and sends data only to the app on 127.0.0.1 when the user clicks.
* **storage** — remember settings (including the websites on which the video button is hidden) and the pairing with the local app.
* **alarms** — retry connecting to the local app once a minute until the user has allowed it.
* **Host permission `<all_urls>`** — downloads and media can come from any website; the extension only forwards what the user downloads.

## Data-use disclosures (Chrome form)

Collects: none transmitted off the device. The extension passes URLs, referer and cookies of the user's own downloads to the app on `127.0.0.1` only. Not sold, not used for unrelated purposes, no remote code.

## Assets still needed

Screenshots (1280×800) of the button over a video, the app's *Download video* window, the popup and the app's *Options → Browser* page, a 440×280 promotional tile (Chrome), and the privacy-policy URL above.
