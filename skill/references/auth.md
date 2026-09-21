# Authentication internals

## The site

- `https://core.xjtlu.edu.cn` is **Moodle** (Boost theme), branded "Learning Mall Core".
- SSO is **SAML2**: Moodle `/auth/saml2/login.php` → IdP
  `uim.xjtlu.edu.cn/esc-sso/…` (Shibboleth-style) → SAML assertion back to Moodle
  → `MoodleSession` cookie.

## What is and isn't available

- **Web services / mobile app service: DISABLED.** `webservice/rest/server.php`
  exists but no student token can be minted (`admin/tool/mobile/launch.php` →
  "Web service is not available"), and mobile-only functions return
  `servicenotavailable` even over the logged-in AJAX endpoint.
- **AJAX endpoint works:** `POST /lib/ajax/service.php?sesskey=<sesskey>&info=<fn>`
  with body `[{index:0, methodname:<fn>, args:{…}}]` and the session cookie, for
  every function the Boost UI uses (calendar, messages, notifications, course
  timeline, `core_courseformat_get_state`, course search, recent items, …).
- **Everything else** (grades, assignment/quiz/forum data, files, reports) is
  reached with authenticated **page requests** (`lmc api GET <path>`).

## Why login is browser-based

The IdP login page (`/esc-sso/login/page`) is a Vue SPA with a **slider
captcha**, **RSA-encrypted password**, and an **anti-bot fingerprint script**
(the obfuscated `$_ss` blob). Automated browsers get a blank page; headless
credential replay would mean defeating captcha + bot-detection, which this tool
does not do. So the human logs in in their real browser and `lmc` reuses the
resulting session cookie.

## Cookie extraction & decryption

`lmc login --from-browser <b>` reads the browser's cookie SQLite DB and decrypts
the values:

- **macOS** (Chrome/Edge/Brave/Chromium/Vivaldi): the "Safe Storage" key comes
  from the login Keychain (`security find-generic-password -s "<Browser> Safe
  Storage"`); `AES-128-CBC` with `PBKDF2(key, "saltysalt", 1003, 16, sha1)`,
  IV = 16 spaces, `v10` prefix. Newer Chromium prepends a 32-byte SHA-256(host)
  which is stripped.
- **Windows**: the AES-256-GCM key is in `Local State` → `os_crypt.encrypted_key`,
  DPAPI-unprotected (via PowerShell `ProtectedData.Unprotect`); values are
  `v10`/`v11` GCM (`[3 prefix][12 nonce][ct][16 tag]`).
- **Linux**: `v11` AES-128-CBC with the keyring password (falls back to the
  well-known `"peanuts"` key when no keyring password is set).
- **Firefox** (all OSes): `cookies.sqlite` stores values unencrypted.

The full cookie jar is kept (not just `MoodleSession`) because the site sits
behind a load balancer / WAF whose `SERVERID` / `acw_tc` cookies must travel with
the session. The `sesskey` and identity are then scraped from an authenticated
`/my/` fetch.

## Storage

`~/.config/xjtlu-core/` (override: `LMC_HOME`), all files `0600`:

- `config.json` — base URL, site name.
- `session.json` — mode (`cookie`), the cookie jar, `sesskey`, userid, fullname.
- `manifest.json` — the live function-availability catalogue.
