# Getting a trusted code signature

Warnings ("Windows protected your PC", "Unknown publisher") appear because Windows only trusts signatures chained to a public CA.
A signature from a certificate you generate yourself is valid but **untrusted**, and nobody can "turn on" trust for it except by buying or being granted a CA-issued certificate.
Choose one (prices and eligibility change — check each provider's current terms):

| Option | Cost | Notes |
|---|---|---|
| **SignPath Foundation** (signpath.org/foundation) | free for qualifying open-source projects | Application required; builds must run in public CI (GitHub Actions). The project's certificate is issued to the SignPath Foundation. |
| **Azure Artifact Signing** (formerly Trusted Signing) | about 10 USD/month | Needs an Azure subscription and identity validation; available to organizations and individual developers in supported regions. Short-lived certificates, SmartScreen-friendly. |
| **OV code-signing certificate** (DigiCert, Sectigo, SSL.com …) | roughly 100–400 USD/year | Private key must be on a hardware token / HSM (CA/B Forum rule since 2023). SmartScreen reputation builds up over downloads. |
| **EV code-signing certificate** | roughly 250–600 USD/year | Immediate SmartScreen reputation; hardware token. |

## Using it with this repository

* **PFX available (some CAs, or an exported cloud certificate):** `set ADM_SIGN_PFX=C:pathcert.pfx`, `set ADM_SIGN_PASSWORD=…`, `npm run release`.
  In GitHub Actions store the file base64-encoded as the secrets `SIGN_PFX_BASE64` and `SIGN_PFX_PASSWORD` (already wired in `.github/workflows/release.yml`).
* **Hardware token / cloud HSM / Azure / SignPath:** these sign through their own tool (`signtool` with a KSP, `trusted-signing-cli`, or the SignPath GitHub Action).
  Replace the call in `scripts/sign.ps1` — the rest of the pipeline only needs three files signed: `AdvanceDownloadManager.exe` (native host) and `adm-engine.exe` inside the app folder, and the `-Setup.exe` installer — all *before* `SHA256SUMS.txt` is written (the portable zip contains the signed exes).
* Always keep the timestamp (`ADM_REQUIRE_TIMESTAMP=1` makes the build fail without one) so signatures stay valid after the certificate expires.

Nothing in this repository can issue a trusted certificate; that decision belongs to a CA.
