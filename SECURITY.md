# Security policy

Please report vulnerabilities privately via GitHub **Security → Report a vulnerability** on https://github.com/kaushalsah606/ADM---Advance-Download-Manager- (or contact
[@kaushalsah606](https://github.com/kaushalsah606)). Do not open public issues for security problems. Expect an initial reply within a week.

Scope: the local API (127.0.0.1, token, Host check), the native window host (navigation restrictions, single-instance and engine hand-off), PAC sandbox, credential handling, the updater, the browser extensions, the installer and the build/signing scripts.
Only the latest release is supported.

## Notes on the trust model

* The local API needs a token. A browser extension that does not have the token can only ask to pair (`POST /api/pair`, extension origins only); it receives the token only after the user presses *Allow* in the app. Allow only extensions you installed yourself; *Options → Browser* lists and removes them.
* Any program running as you can read `%USERPROFILE%\.advance-download-manager\token`; the app does not defend against malware running under your own account.
* The video engine runs **yt-dlp** and **FFmpeg**, shipped inside the installer and the portable zip (fetched from their official GitHub releases and checked against the SHA-256 published with the release when the package is built; an update or an on-demand install is accepted only if it matches the published SHA-256 too). The app starts yt-dlp with a fixed option set; the only values that come from outside are the page address (always after `--`), a quality *id* (the selector is chosen by the app) and the user's file name / folder (the name is escaped for yt-dlp's template). Browser cookies are written to a 0600 file, passed with `--cookies`, never shown to the UI and deleted afterwards.
* The web page of the native window can ask the host for one thing, the clipboard text, and gets it only if it is a web address; the message is accepted only from `http://127.0.0.1:<port>`. Browser dialogs, accelerator keys and permission prompts are off.
* PC-wide capture changes the per-user proxy-script setting only while it is switched on, serves the script from the local engine, and ends the script's answers in `DIRECT`.
