#!/usr/bin/env node
import {
  loadConfig,
  saveConfig,
  loadSession,
  clearSession,
  loadManifest,
  manifestAgeMs,
  Session,
} from "./config";
import { MoodleClient, AuthError, WSError } from "./moodle";
import { sync, ensureManifest, componentOf } from "./discovery";
import {
  browserLogin,
  pasteLogin,
  tokenLogin,
  cookieHeaderLogin,
  fromBrowserLogin,
  authedBrowser,
  fetchPublicConfig,
} from "./login";
import * as cmd from "./commands";
import { setJsonMode, isJson, emit, note, table, human, debug } from "./output";

// ---- tiny argv parser -----------------------------------------------------

interface Parsed {
  positionals: string[];
  opts: Record<string, string | boolean | string[]>;
}

function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const opts: Record<string, string | boolean | string[]> = {};
  const repeatable = new Set(["a", "arg", "q", "query", "f", "field", "file"]);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    let key: string | null = null;
    if (tok.startsWith("--")) key = tok.slice(2);
    else if (tok.startsWith("-") && tok.length > 1) key = tok.slice(1);
    if (key) {
      const boolean = [
        "json", "cookie", "debug", "force", "verified", "help",
        "list", "dry-run", "links", "forms", "available",
      ].includes(key);
      let val: string | boolean = true;
      if (!boolean && i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        val = argv[++i];
      }
      if (repeatable.has(key)) {
        const arr = (opts[key] as string[]) || [];
        if (typeof val === "string") arr.push(val);
        opts[key] = arr;
      } else {
        opts[key] = val;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, opts };
}

function coerce(v: string): unknown {
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}

function kvToObject(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of pairs) {
    const idx = p.indexOf("=");
    if (idx === -1) continue;
    out[p.slice(0, idx)] = coerce(p.slice(idx + 1));
  }
  return out;
}

// ---- helpers --------------------------------------------------------------

function buildClient(requireAuth = true): MoodleClient {
  const cfg = loadConfig();
  const session = loadSession();
  if (requireAuth && !session) {
    throw new AuthError("Not logged in. Run: lmc login");
  }
  return new MoodleClient(cfg, session);
}

async function withManifest(client: MoodleClient): Promise<cmd.Ctx> {
  const manifest = await ensureManifest(client);
  return { client, manifest };
}

const USAGE = `lmc — XJTLU Learning Mall Core (Moodle) CLI

  Auth — log in once in your normal browser, then:
    lmc login --from-browser auto    read + decrypt the session from your browser
                                     (edge|chrome|brave|firefox|auto) [RECOMMENDED]
    lmc login --from-browser edge --profile "Profile 1"
    lmc login --cookie-header '...'  paste the Cookie header from DevTools (fallback)
    lmc login                        drive a browser through SSO (blocked by the
                                     IdP's anti-bot on this site — prefer the above)
    lmc logout                       forget the saved session
    lmc status [--json]              show login state, user, catalogue age

  Live catalogue (commands are never hard-coded — re-probe after site changes):
    lmc sync [--json]         re-probe which functions are callable right now
    lmc functions [kw] [-c comp] [--available] [--json]
    lmc describe <fn> [--json]

  Curated commands:
    lmc whoami | me
    lmc courses                        your enrolled courses
    lmc course <courseid>              section/activity structure
    lmc deadlines [-n N]               upcoming due dates / events
    lmc calendar --month YYYY-MM
    lmc grades [courseid]              grade overview / per-course (page-scraped)
    lmc assignments [courseid]         assignment activities
    lmc messages | notifications | recent
    lmc search <query>
    lmc download <fileurl> [-o path]
    lmc open [path]                    open a site page in your browser

  Generic access (anything the site exposes, now or in future):
    lmc call <function> [--args '<json>'] [-a key=value ...] [--json]   any AJAX fn
    lmc api <METHOD> <path> [-d '<json>'] [-q key=value ...] [--json]   raw request

  Full control — drive ANY button/form like the browser does:
    lmc page <url> [--forms] [--links]     map every form + link on a page
    lmc form <url> --list                  show a form's fields + submit buttons
    lmc form <url> -f name=value ... [--file field=path] [--submit btn] [--dry-run]
                                           replay/submit any form (auto sesskey)
    lmc form <url> --n <i> | --match <text>   pick which form on the page
    lmc upload <file> [--page <formurl>]   upload into a Moodle draft area →itemid
    lmc browser [path] [--browser chrome]  open a REAL browser already logged in
                                           (escape hatch for JS-only widgets)

  Globals: --json (machine output on stdout) · --debug · LMC_HOME, LMC_DEBUG`;

// ---- main -----------------------------------------------------------------

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { positionals, opts } = parseArgs(argv);
  if (opts.json) setJsonMode(true);
  if (opts.debug) process.env.LMC_DEBUG = "1";

  const command = positionals[0];
  if (!command || command === "help" || opts.help) {
    note(USAGE);
    return 0;
  }

  switch (command) {
    // ---- auth ----
    case "login": {
      const cfg = loadConfig();
      // Refresh public config (endpoints/site name) — harmless and keeps us current.
      try {
        const pub = await fetchPublicConfig(cfg);
        if (pub?.wwwroot) cfg.wwwroot = pub.wwwroot;
        if (pub?.sitename) cfg.sitename = pub.sitename;
        saveConfig(cfg);
      } catch (e) {
        debug("public config fetch failed", String(e));
      }
      let session: Session;
      const cookieHeader = opts["cookie-header"];
      const fromBrowser = opts["from-browser"];
      if (typeof fromBrowser === "string" || fromBrowser === true) {
        const b = (typeof fromBrowser === "string" ? fromBrowser : "auto") as any;
        const profile = typeof opts.profile === "string" ? opts.profile : undefined;
        session = await fromBrowserLogin(cfg, b, profile);
      } else if (typeof cookieHeader === "string") {
        session = await cookieHeaderLogin(cfg, cookieHeader);
      } else if (typeof opts.paste === "string") {
        session = pasteLogin(cfg, opts.paste);
      } else if (typeof opts.token === "string") {
        session = tokenLogin(cfg, opts.token);
      } else {
        const br = typeof opts.browser === "string" ? (opts.browser as any) : undefined;
        session = await browserLogin(cfg, {
          cookieMode: !!opts.cookie,
          scheme: typeof opts.scheme === "string" ? opts.scheme : undefined,
          timeoutMs: opts.timeout ? Number(opts.timeout) * 1000 : undefined,
          browser: br,
        });
      }
      // Build the live command catalogue (probes available functions).
      const client = new MoodleClient(cfg, session);
      const m = await sync(client, { probe: true });
      emit({
        loggedIn: true,
        mode: session.mode,
        user: {
          userid: session.userid,
          username: session.username,
          fullname: session.fullname,
        },
        sitename: cfg.sitename,
        release: m.release,
        availableFunctions: m.availableCount,
      });
      human(
        `Logged in as ${session.fullname || session.username || "user " + session.userid}. ` +
          `${m.availableCount} functions available now. Mode: ${session.mode}.`
      );
      return 0;
    }

    case "logout": {
      clearSession();
      emit({ loggedIn: false });
      human("Session cleared.");
      return 0;
    }

    case "status": {
      const cfg = loadConfig();
      const session = loadSession();
      const manifest = loadManifest();
      const base: any = {
        loggedIn: !!session,
        mode: session?.mode,
        site: cfg.sitename || cfg.baseUrl,
        baseUrl: cfg.baseUrl,
        user: session
          ? { userid: session.userid, username: session.username, fullname: session.fullname }
          : null,
        availableFunctions: manifest ? manifest.availableCount : 0,
        catalogueAgeHours: manifest
          ? +(manifestAgeMs(manifest) / 3600000).toFixed(1)
          : null,
        release: manifest?.release,
      };
      if (session) {
        // live validity check (mode-appropriate, no web services required)
        try {
          const client = new MoodleClient(cfg, session);
          if (session.mode === "cookie") {
            await client.refreshSesskey();
          } else {
            await client.siteInfo();
          }
          base.valid = true;
        } catch (e) {
          base.valid = false;
          base.reason = e instanceof Error ? e.message : String(e);
        }
      }
      emit(base);
      if (!isJson()) {
        human(
          `${base.loggedIn ? (base.valid ? "Logged in" : "Session INVALID — run: lmc login") : "Not logged in"}` +
            (base.user ? ` as ${base.user.fullname} (${base.user.username})` : "") +
            `\nSite: ${base.site} | functions: ${base.functioncount} | catalogue age: ${base.catalogueAgeHours ?? "?"}h`
        );
      }
      return base.loggedIn && base.valid === false ? 3 : 0;
    }

    // ---- catalogue ----
    case "sync": {
      const client = buildClient();
      const m = await sync(client, { probe: opts.probe !== false });
      emit({
        availableFunctions: m.availableCount,
        totalCatalogue: Object.keys(m.functions).length,
        release: m.release,
        transport: m.transport,
        fetchedAt: m.fetchedAt,
      });
      human(
        `Synced: ${m.availableCount} of ${Object.keys(m.functions).length} catalogue ` +
          `functions callable now (transport: ${m.transport}${m.release ? ", docs " + m.release : ""}).`
      );
      return 0;
    }

    case "functions": {
      const client = buildClient();
      const m = await ensureManifest(client);
      const kw = (positionals[1] || "").toLowerCase();
      const comp = typeof opts.c === "string" ? opts.c : (opts.component as string) || "";
      const onlyAvail = !!opts.available;
      let entries = Object.values(m.functions);
      if (kw) entries = entries.filter((e) => e.name.toLowerCase().includes(kw) || (e.desc || "").toLowerCase().includes(kw));
      if (comp) entries = entries.filter((e) => e.component === comp || e.name.startsWith(comp));
      if (onlyAvail) entries = entries.filter((e) => e.available === "yes");
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const rows = entries.map((e) => ({
        function: e.name,
        available: e.available,
        component: e.component,
        desc: e.desc || "",
      }));
      emit(rows);
      table(rows, ["available", "function", "desc"]);
      human(`${rows.length} function(s); ${entries.filter((e) => e.available === "yes").length} available.`);
      return 0;
    }

    case "describe": {
      const name = positionals[1];
      if (!name) throw new Error("Usage: lmc describe <function>");
      const client = buildClient();
      const m = await ensureManifest(client);
      const f = m.functions[name];
      const out = {
        name,
        component: componentOf(name),
        inCatalogue: !!f,
        available: f?.available ?? "unknown",
        code: f?.code,
        desc: f?.desc,
        note:
          "Moodle does not expose per-function argument schemas. Pass args with " +
          "--args '<json>' or -a key=value. Any function name works with 'lmc call' " +
          "even if it is not in the catalogue.",
      };
      emit(out);
      human(
        `${name}\n  component: ${out.component}\n  availability: ${out.available}` +
          (out.desc ? `\n  ${out.desc}` : "") +
          `\n  ${out.note}`
      );
      return 0;
    }

    // ---- generic ----
    case "call": {
      const fn = positionals[1];
      if (!fn) throw new Error("Usage: lmc call <function> [--args '<json>'] [-a k=v ...]");
      let args: Record<string, unknown> = {};
      if (typeof opts.args === "string") args = JSON.parse(opts.args);
      const aPairs = ([] as string[]).concat((opts.a as string[]) || [], (opts.arg as string[]) || []);
      Object.assign(args, kvToObject(aPairs));
      const client = buildClient();
      const data = await client.call(fn, args);
      emit(data);
      if (!isJson()) note(JSON.stringify(data, null, 2));
      return 0;
    }

    case "api": {
      const method = (positionals[1] || "GET").toUpperCase();
      const p = positionals[2];
      if (!p) throw new Error("Usage: lmc api <METHOD> <path> [-d '<json>'] [-q k=v ...]");
      const client = buildClient();
      const query = kvToObject(([] as string[]).concat((opts.q as string[]) || [], (opts.query as string[]) || [])) as Record<string, string | number>;
      const body = typeof opts.d === "string" ? opts.d : typeof opts.data === "string" ? (opts.data as string) : undefined;
      const res = await client.raw(method, p, {
        query,
        body,
        headers: body ? { "Content-Type": "application/json" } : undefined,
      });
      let parsed: unknown = res.text;
      try {
        parsed = JSON.parse(res.text);
      } catch {
        /* keep text */
      }
      emit({ status: res.status, body: parsed });
      if (!isJson()) note(typeof parsed === "string" ? (parsed as string).slice(0, 2000) : JSON.stringify(parsed, null, 2));
      return 0;
    }

    // ---- curated ----
    case "whoami":
    case "me": {
      const ctx = await withManifest(buildClient());
      await cmd.whoami(ctx);
      return 0;
    }
    case "courses": {
      const ctx = await withManifest(buildClient());
      await cmd.courses(ctx);
      return 0;
    }
    case "course": {
      const id = Number(positionals[1]);
      if (!id) throw new Error("Usage: lmc course <courseid>");
      const ctx = await withManifest(buildClient());
      await cmd.courseContents(ctx, id);
      return 0;
    }
    case "deadlines": {
      const n = opts.n ? Number(opts.n) : 20;
      const ctx = await withManifest(buildClient());
      await cmd.deadlines(ctx, n);
      return 0;
    }
    case "calendar": {
      const ctx = await withManifest(buildClient());
      const month = typeof opts.month === "string" ? opts.month : "";
      if (month) {
        const [y, mo] = month.split("-").map((x) => parseInt(x, 10));
        await cmd.calendarMonth(ctx, y, mo);
      } else {
        await cmd.deadlines(ctx, opts.n ? Number(opts.n) : 20);
      }
      return 0;
    }
    case "grades": {
      const id = positionals[1] ? Number(positionals[1]) : undefined;
      const ctx = await withManifest(buildClient());
      await cmd.grades(ctx, id);
      return 0;
    }
    case "assignments": {
      const id = positionals[1] ? Number(positionals[1]) : undefined;
      const ctx = await withManifest(buildClient());
      await cmd.assignments(ctx, id);
      return 0;
    }
    case "messages": {
      const ctx = await withManifest(buildClient());
      await cmd.messages(ctx, opts.n ? Number(opts.n) : 20);
      return 0;
    }
    case "notifications": {
      const ctx = await withManifest(buildClient());
      await cmd.notifications(ctx, opts.n ? Number(opts.n) : 20);
      return 0;
    }
    case "recent": {
      const ctx = await withManifest(buildClient());
      await cmd.recent(ctx);
      return 0;
    }
    case "search": {
      const q = positionals.slice(1).join(" ");
      if (!q) throw new Error("Usage: lmc search <query>");
      const ctx = await withManifest(buildClient());
      await cmd.searchCourses(ctx, q);
      return 0;
    }
    case "download": {
      const url = positionals[1];
      if (!url) throw new Error("Usage: lmc download <fileurl> [-o path]");
      const ctx = await withManifest(buildClient());
      await cmd.download(ctx, url, typeof opts.o === "string" ? opts.o : undefined);
      return 0;
    }
    case "open": {
      const p = positionals[1] || "/my/";
      const ctx = await withManifest(buildClient());
      await cmd.open(ctx, p);
      return 0;
    }

    case "page": {
      const url = positionals[1];
      if (!url) throw new Error("Usage: lmc page <url> [--forms] [--links]");
      const ctx = await withManifest(buildClient());
      await cmd.pageIntrospect(ctx, url, { links: !!opts.links, forms: !!opts.forms });
      return 0;
    }

    case "upload": {
      const file = positionals[1];
      if (!file) throw new Error("Usage: lmc upload <file> [--page <formurl>] [--repo <id>] [--context <ctxid>] [--itemid <n>]");
      const ctx = await withManifest(buildClient());
      await cmd.uploadFile(ctx, file, {
        page: typeof opts.page === "string" ? opts.page : undefined,
        repo: opts.repo != null && opts.repo !== true ? Number(opts.repo) : undefined,
        context: opts.context != null && opts.context !== true ? Number(opts.context) : undefined,
        itemid: opts.itemid != null && opts.itemid !== true ? Number(opts.itemid) : undefined,
      });
      return 0;
    }

    case "browser": {
      const url = positionals[1] || "/my/";
      const cfg = loadConfig();
      const session = loadSession();
      if (!session) throw new AuthError("Not logged in. Run: lmc login --from-browser");
      const br = typeof opts.browser === "string" ? (opts.browser as any) : undefined;
      await authedBrowser(cfg, session, url, { browser: br });
      return 0;
    }

    case "form": {
      const url = positionals[1];
      if (!url)
        throw new Error(
          "Usage: lmc form <url> [--list] [-f key=value ...] [--file field=path ...] " +
            "[--submit name] [--dry-run] [--n <i> | --match <text>]"
        );
      const fPairs = ([] as string[]).concat((opts.f as string[]) || [], (opts.field as string[]) || []);
      const fields: Record<string, string> = {};
      for (const p of fPairs) {
        const i = p.indexOf("=");
        if (i >= 0) fields[p.slice(0, i)] = p.slice(i + 1);
      }
      const files = (((opts.file as string[]) || []) as string[]).map((p) => {
        const i = p.indexOf("=");
        return { field: p.slice(0, i), path: p.slice(i + 1) };
      });
      const ctx = await withManifest(buildClient());
      await cmd.formCmd(ctx, url, {
        n: opts.n != null && opts.n !== true ? Number(opts.n) : undefined,
        match: typeof opts.match === "string" ? opts.match : undefined,
        list: !!opts.list,
        dryRun: !!opts["dry-run"],
        fields,
        files,
        submit: typeof opts.submit === "string" ? opts.submit : undefined,
      });
      return 0;
    }

    default:
      note(`Unknown command: ${command}\n\n` + USAGE);
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof AuthError) {
      note("Auth error: " + err.message);
      if (isJson()) emit({ error: "auth", message: err.message });
      process.exit(3);
    }
    if (err instanceof WSError) {
      note("Web service error: " + err.message + (err.errorcode ? ` [${err.errorcode}]` : ""));
      if (err.debuginfo) debug(err.debuginfo);
      if (isJson()) emit({ error: "ws", errorcode: err.errorcode, message: err.message });
      process.exit(2);
    }
    note("Error: " + (err instanceof Error ? err.message : String(err)));
    if (isJson()) emit({ error: "general", message: String(err) });
    process.exit(1);
  });
