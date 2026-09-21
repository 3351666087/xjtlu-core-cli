# lmc — XJTLU Learning Mall Core CLI

A small, dependency-light TypeScript CLI that puts **XJTLU Learning Mall Core**
(`https://core.xjtlu.edu.cn`, the university's **Moodle**) on your command line —
courses, course structure, deadlines, calendar, grades, assignments, messages,
notifications, file downloads, and **any** Moodle AJAX web-service function.

- **Log in once, from your normal browser.** No passwords stored, no captcha to
  fight. `lmc` reads and decrypts your existing session cookie from your browser.
- **Commands are never hard-coded.** The callable web-service functions are
  discovered live (`lmc sync`), so the tool tracks the server through upgrades and
  refactors instead of going stale.
- **Ships with a Claude Code / agent skill** (`skill/SKILL.md`) so an AI agent can
  drive the whole portal for you.

> Unofficial, community tool for **your own account**. Not affiliated with or
> endorsed by XJTLU. Use it within the university's acceptable-use policy.

## Why it works the way it does

XJTLU's Learning Mall is Moodle, but with the **web-service / mobile-app API
disabled** — so there's no long-lived API token, and the mobile-app functions
(`core_webservice_get_site_info`, `core_course_get_contents`, grade/assignment
web services, …) return `servicenotavailable`. On top of that, the identity
provider (`uim.xjtlu.edu.cn`) is a SPA behind a **slider captcha + anti-bot
fingerprinting**, so scripted/headless login is a dead end (and defeating
captcha/bot-detection isn't something this tool does).

So `lmc` takes the robust, portable route:

1. **You** log in normally in your own browser (captcha/MFA handled by you).
2. `lmc login --from-browser` reads Learning Mall's cookies from your browser's
   cookie store and **decrypts them locally** (macOS Keychain / Windows DPAPI /
   Linux keyring — the same mechanism `browser_cookie3` uses).
3. Requests use that session against Moodle's logged-in **AJAX endpoint**
   (`lib/ajax/service.php`) for everything the web UI exposes, and authenticated
   **page requests** for the rest (grades, files, downloads).

The session lasts as long as your browser session does; when it expires, log in
again in your browser and re-run `lmc login --from-browser`.

## Install

Requires Node ≥ 18 and `sqlite3` on PATH (preinstalled on macOS and most Linux).

```bash
git clone <this-repo> xjtlu-core-cli
cd xjtlu-core-cli
npm install
npm run build      # compiles to dist/ and copies the function catalogue
npm link           # exposes the global `lmc` command
npx playwright install chromium   # optional: only for the fallback SSO login
```

## Log in

Make sure you're logged in to <https://core.xjtlu.edu.cn/> in your normal
browser, then:

```bash
lmc login --from-browser auto              # tries edge, chrome, brave, firefox…
lmc login --from-browser edge              # or name it
lmc login --from-browser chrome --profile "Profile 1"
```

macOS will ask once for Keychain access to your browser's "Safe Storage" key —
click **Allow**.

**Fallbacks**

```bash
# Paste the Cookie request header from DevTools → Network → any
# core.xjtlu.edu.cn request → Request Headers → Cookie:
lmc login --cookie-header 'MoodleSession=…; SERVERID=…; …'

# Drive an SSO login in a real browser window (works only where the IdP's
# anti-bot allows it — usually prefer --from-browser):
lmc login --browser chrome
```

## Use

```bash
lmc status                     # login state, user, live function count
lmc whoami
lmc courses                    # your enrolled courses (+ ids)
lmc course 601                 # section/activity structure with URLs
lmc deadlines                  # upcoming due dates / events
lmc calendar --month 2026-10
lmc grades                     # overview; or `lmc grades 601`
lmc assignments 601
lmc messages
lmc notifications
lmc recent
lmc search "data structures"
lmc download "<fileurl>" -o file.pdf
lmc open /course/view.php?id=601

# Live catalogue — never hard-coded:
lmc sync                       # re-probe what's callable right now
lmc functions calendar         # search the catalogue (with availability)
lmc describe core_calendar_get_action_events_by_timesort

# Generic access to anything Moodle exposes, present or future:
lmc call core_courseformat_get_state -a courseid=601 --json
lmc call <function> --args '{"...":"..."}' --json
lmc api GET /grade/report/overview/index.php     # any page, cookie-authenticated
```

Add `--json` to any command for machine-readable output on stdout (human tables
go to stderr, so pipes stay clean).

## Full control (the design goal)

The aim is **functional parity with the web UI**, not a fixed menu of features.
Your session cookie carries the same authority as your logged-in browser, so
`lmc` exposes general primitives that can replay *any* action instead of
hard-coding one command per button:

```bash
lmc call <fn> [-a k=v ...]            # any Moodle AJAX function (incl. writes)
lmc page "<url>" [--forms] [--links]  # map every form + link on a page
lmc form "<url>" --list               # list a form's fields + submit buttons
lmc form "<url>" -f name=value ... [--file field=path] [--submit btn] [--dry-run]
lmc api <METHOD> <path> [-d '<json>'] # raw authenticated request
```

`lmc form` pulls in every hidden field and the `sesskey`, so it submits exactly
like the browser (assignment submissions, forum posts, settings changes,
self-enrolment, …). `--dry-run` shows the payload without sending it.

**Honest ceiling.** Everything the server accepts over HTTP is reachable this way
— the large majority of Moodle. The exceptions are purely client-side / real-time
widgets (live quiz timers, H5P interactions, BigBlueButton rooms, some JS
drag-and-drop question types); for those the *same session* can be driven in a
real browser. So "100% control" = full HTTP action parity plus a real-browser
escape hatch for the JS-only remainder.

> ⚠️ **Writes are real.** `lmc form` (without `--dry-run`), write-type `lmc call`,
> and `lmc api POST/DELETE` perform real actions on your account. Use `--dry-run`
> / `--list` first, and be deliberate with anything irreversible or public.

## Security & privacy

- Your session cookie is stored **only** in `~/.config/xjtlu-core/session.json`
  (mode `0600`) on your machine. Override the location with `LMC_HOME`.
- Nothing secret is committed to this repo. `~/.config/xjtlu-core/` is outside it.
- The tool talks only to `*.xjtlu.edu.cn`. Set `LMC_DEBUG=1` to see every request.
- Reading your own browser's cookies requires OS keychain access, which your OS
  gates with a permission prompt.

## How the code is organized

```
src/
  index.ts          # CLI dispatch + arg parsing
  config.ts         # config / session / manifest storage (0600)
  moodle.ts         # Moodle client: AJAX + REST transports, auth handling
  browserCookies.ts # read + decrypt cookies from Chrome/Edge/Brave/Firefox
  login.ts          # from-browser / cookie-header / SSO login flows
  discovery.ts      # live capability probing (the "never stale" catalogue)
  commands.ts       # curated commands (courses, grades, deadlines, …)
  catalog.json      # seed list of Moodle AJAX functions to probe
skill/SKILL.md      # Claude Code / agent operating guide for `lmc`
```

## Agent / Claude Code skill

Copy `skill/SKILL.md` (and `skill/references/`) to `~/.claude/skills/xjtlu-core/`,
or symlink it. Any tool-calling agent can also load `skill/SKILL.md` as context
and expose a shell tool; it then issues `lmc …` commands.

## License

MIT — see [LICENSE](LICENSE).
