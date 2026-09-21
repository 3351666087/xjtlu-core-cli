---
name: xjtlu-core
description: Operate XJTLU Learning Mall Core (core.xjtlu.edu.cn, a Moodle site) from the command line via the `lmc` CLI — courses, course structure, deadlines, calendar, grades, assignments, messages, notifications, files, and any Moodle AJAX web-service function. Log in once from your normal browser; commands are discovered live so they never go stale.
---

# XJTLU Learning Mall Core (`lmc`) — agent operating guide

A framework-neutral guide for any AI agent (or a human) to drive the `lmc`
command-line tool, which operates **XJTLU Learning Mall Core**
(`https://core.xjtlu.edu.cn`) — the university's **Moodle** learning platform.

The only capability assumed is that the agent can **run shell commands** (`lmc …`)
and read their stdout.

## Contract for the agent

- **`lmc` is the single tool.** Every action is a shell command starting with `lmc …`.
- **Ask for structured output.** Append `--json` to any command to get JSON on
  stdout (human tables and progress go to stderr).
- **The live catalogue is the source of truth.** Moodle changes and gets
  upgraded. Run `lmc sync`, then `lmc functions [keyword]` / `lmc describe <fn>`
  to know what is callable *right now* before assuming a function exists.
- **Never handle the user's password.** Login reads the session from the user's
  own browser (they log in there normally, solving any captcha/MFA themselves).
- **Prefer the curated commands** below; fall back to `lmc call <function>` /
  `lmc api <METHOD> <path>` for anything else.

## How auth works here (important context)

This Moodle site has its **web services / mobile app service disabled**, so there
is **no long-lived API token** and functions like `core_webservice_get_site_info`,
`core_course_get_contents`, grade and assignment web services are **not reachable**
(`servicenotavailable`). Also, the XJTLU identity provider (`uim.xjtlu.edu.cn`) is
a SPA protected by a **slider captcha + anti-bot fingerprinting**, so headless /
automated SSO does not work (and bypassing captcha/bot-detection is out of scope).

`lmc` therefore authenticates with the **logged-in session cookie**, obtained by
reading and decrypting it from the user's **own browser** cookie store:

- Transport: the logged-in **AJAX endpoint** `lib/ajax/service.php` (session
  cookie + `sesskey`) for functions the Moodle UI exposes, plus authenticated
  **page requests** for the rest (grades, files, downloads).
- The session lasts as long as the browser session does. When it expires, the
  user re-logs-in in their browser and re-runs `lmc login --from-browser …`.

## 1. Make sure the user is authenticated

```bash
lmc status --json
```

If `loggedIn` is false or `valid` is false, log in (the user must already be
logged in to https://core.xjtlu.edu.cn/ in their normal browser):

```bash
lmc login --from-browser auto     # tries edge, chrome, brave, firefox…
# or name the browser / profile explicitly:
lmc login --from-browser edge --profile "Default"
```

Fallbacks if the browser read fails (e.g. Linux keyring, or a locked profile):

```bash
# Paste the Cookie request header from DevTools → Network → a core.xjtlu.edu.cn
# request → Request Headers → Cookie:
lmc login --cookie-header 'MoodleSession=…; SERVERID=…; …'
```

On macOS the first `--from-browser` may raise a Keychain prompt — the user clicks
**Allow** once. Config + session live in `~/.config/xjtlu-core/` (mode 0600);
override the directory with `LMC_HOME`.

## 2. Keep the command set current (self-updating)

```bash
lmc sync                       # re-probe which functions are callable right now
lmc status --json              # login state, user, available-function count, age
lmc functions --json           # the catalogue with live availability (yes/no)
lmc functions calendar --json  # filter by keyword
lmc functions -c core_message  # filter by component
lmc functions --available      # only functions callable now
lmc describe core_calendar_get_action_events_by_timesort --json
```

The catalogue is re-probed on login and by `lmc sync`; after a Moodle upgrade or
config change, re-running `lmc sync` reflects the new availability with no code
changes.

## 3. Curated student commands (use these first)

| Task | Command |
|------|---------|
| Who am I | `lmc whoami --json` |
| My courses | `lmc courses --json` |
| Course structure (sections + activities, with URLs) | `lmc course <courseid> --json` |
| Upcoming deadlines / events | `lmc deadlines -n 20 --json` |
| Month calendar | `lmc calendar --month 2026-10 --json` |
| Grades (overview, or one course) | `lmc grades --json` · `lmc grades <courseid> --json` |
| Assignments (all in-progress, or one course) | `lmc assignments --json` · `lmc assignments <courseid> --json` |
| Messages | `lmc messages --json` |
| Notifications | `lmc notifications --json` |
| Recently accessed items | `lmc recent --json` |
| Search the course catalogue | `lmc search "data structures" --json` |
| Download a file (cookie-authenticated) | `lmc download "<fileurl>" -o out.pdf` |
| Open a page in the browser | `lmc open /course/view.php?id=601` |

Course/activity ids come from `lmc courses` and `lmc course <id>` (each activity
row has an `id` and a `url`). Because course structure is fetched live via
`core_courseformat_get_state`, it always reflects the current site — this is how
you "traverse every button" in a course.

## 4. Generic access (anything the site exposes, now or in future)

Call any Moodle AJAX web-service function by name — not limited to the catalogue:

```bash
lmc call core_calendar_get_calendar_upcoming_view --json
lmc call core_message_get_conversations -a userid=<your-userid> -a limitnum=5 --json
lmc call core_courseformat_get_state -a courseid=601 --json
lmc call <function> --args '{"nested":{"json":"args"}}' --json
```

Args: `-a key=value` (repeatable; numbers/booleans auto-detected) or
`--args '<json>'` for nested structures. Moodle does not expose per-function
argument schemas over the API; build args from the Moodle developer docs or by
mirroring what the web UI sends.

If a function returns `servicenotavailable`, it exists in Moodle but is **not**
reachable over this site's AJAX transport (web services are off) — use a curated
page-based command, or a raw request:

```bash
# Any page/endpoint with the session cookie (great for the ~half of Moodle that
# isn't exposed as an AJAX function): grades pages, mod/*/view.php, reports, etc.
lmc api GET /grade/report/overview/index.php
lmc api GET /mod/assign/view.php -q id=<cmid>
lmc api GET /calendar/export.php -q ...
```

## 5. Full control — drive ANY action (the path to 100%)

The session cookie carries the **same authority as the logged-in browser**, so any
action is reachable. Rather than hard-coding a command per feature, use these
general primitives — they replay anything the UI does and stay current:

- **AJAX actions (incl. writes):** `lmc call <fn> …` reaches every AJAX external
  function — completion toggles, favourites, calendar events, messages, prefs, …
- **Any form (the master key):** map a page, then replay its form:

  ```bash
  lmc page "/course/view.php?id=601" --links   # every actionable link on a page
  lmc page "/mod/assign/view.php?id=<cmid>"    # every form + field
  lmc form "/user/edit.php" --list             # show a form's fields + buttons
  lmc form "/user/edit.php" -f department="CS" --submit submitbutton --dry-run
  lmc form "<url>" -f field=value ... --file attachment=./f.pdf --submit save
  ```

  `lmc form` auto-includes every hidden field and the `sesskey`, so it submits
  Moodle forms the same way the browser does (assignment text, forum posts,
  settings, self-enrolment, quiz answers, …). `--dry-run` shows exactly what
  would be POSTed without sending; `--n <i>` / `--match <text>` pick the form.
- **File submissions:** upload into a Moodle draft area, then submit the form:

  ```bash
  lmc upload ./cw1.pdf --page "/mod/assign/view.php?id=<cmid>&action=editsubmission"
  # → prints the draft itemid; then submit the same page's form (its filemanager
  #   hidden field already carries that itemid):
  lmc form "/mod/assign/view.php?id=<cmid>&action=editsubmission" --submit submitbutton
  ```

  With no `--page`, `lmc upload` targets your private files' draft area (harmless
  test target — nothing persists unless a form is submitted).
- **Raw escape hatch:** `lmc api <METHOD> <path> -d '<json>' -q k=v` for anything
  else.
- **Browser escape hatch:** for the rare JS-only / real-time widgets (live quiz
  timers, H5P, BigBlueButton, JS drag-drop questions) that HTTP can't replay,
  `lmc browser <path>` opens a REAL browser with your saved session injected —
  already logged in, no SSO — so you (or the user) can interact directly.

> **Safety — writes are real.** `lmc form … ` (without `--dry-run`), `lmc call`
> on a write function, and `lmc api POST/DELETE` perform real actions on the
> user's account (submitting work, posting publicly, changing settings, deleting).
> An agent MUST confirm the specific action with the user first, and prefer
> `--dry-run` / `--list` to show what will happen. Irreversible or outward-facing
> actions (submit, post, delete, pay) always need explicit consent.

## 6. Debugging

- `lmc status --json` → `valid:false` means the session expired → re-login.
- `LMC_DEBUG=1 lmc <cmd>` prints the underlying HTTP requests.
- `servicenotavailable` = function not on the AJAX transport (not an auth error).
- A command that suddenly returns a login page → session expired → `lmc login`.

## Install / update

The CLI is a small TypeScript project. To (re)install:

```bash
cd <repo>            # e.g. ~/xjtlu-core-cli
npm install
npm run build        # compiles to dist/ and copies the function catalogue
npm link             # exposes the global `lmc` command
```

`npm link` creates the global `lmc`; the skill just invokes it. Nothing secret is
stored in the repo — the session lives only in `~/.config/xjtlu-core/`.
