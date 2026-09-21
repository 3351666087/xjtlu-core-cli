import * as fs from "fs";
import { MoodleClient, WSError, AuthError } from "./moodle";
import { Manifest, saveSession } from "./config";
import { pickFunction } from "./discovery";
import { emit, table, note, human } from "./output";
import { parseForms, parseLinks, resolveFormValues, ParsedForm } from "./web";

export interface Ctx {
  client: MoodleClient;
  manifest: Manifest | null;
}

/** Logged-in user id — captured at login, with a light scrape fallback. */
async function userId(ctx: Ctx): Promise<number> {
  const s = ctx.client.getSession();
  if (s?.userid) return s.userid;
  const html = await ctx.client.htmlGet("/my/");
  const m = html.match(/\/user\/profile\.php\?id=(\d+)/);
  if (!m) throw new WSError("Could not determine your user id — try 'lmc login' again.");
  const id = parseInt(m[1], 10);
  if (s) {
    s.userid = id;
    saveSession(s);
  }
  return id;
}

function stripTags(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- whoami ---------------------------------------------------------------

export async function whoami(ctx: Ctx): Promise<void> {
  const s = ctx.client.getSession();
  const uid = await userId(ctx);
  const out = {
    userid: uid,
    username: s?.username,
    fullname: s?.fullname,
    mode: s?.mode,
    site: ctx.client.config().sitename || ctx.client.baseUrl(),
    release: ctx.manifest?.release ? "Moodle (docs " + ctx.manifest.release + ")" : undefined,
    availableFunctions: ctx.manifest?.availableCount,
  };
  emit(out);
  human(
    `${out.fullname || "(name unknown)"} (${out.username || "?"}, id ${uid})\n` +
      `${out.site} — mode: ${out.mode} — ${out.availableFunctions ?? "?"} functions available`
  );
}

// ---- courses --------------------------------------------------------------

export async function courses(ctx: Ctx, classification = "all"): Promise<void> {
  const fn = pickFunction(
    ctx.manifest,
    "core_course_get_enrolled_courses_by_timeline_classification"
  )!;
  const r = await ctx.client.call(fn, {
    classification,
    limit: 0,
    offset: 0,
    sort: "fullname",
  });
  const list = r.courses || [];
  const rows = list.map((c: any) => ({
    id: c.id,
    short: c.shortname,
    fullname: c.fullname || c.displayname,
    progress: c.progress ?? "",
    url: c.viewurl || "",
  }));
  emit(list);
  table(rows, ["id", "short", "fullname", "progress"]);
  human(`${rows.length} course(s).`);
}

// ---- course contents (via course format state) ----------------------------

function parseCourseState(raw: any): { sections: any[]; cms: Record<string, any> } {
  let state: any = raw;
  if (typeof raw === "string") {
    try {
      state = JSON.parse(raw);
    } catch {
      state = {};
    }
  }
  const cms: Record<string, any> = {};
  for (const cm of state.cm || []) cms[String(cm.id)] = cm;
  return { sections: state.section || [], cms };
}

export async function courseContents(ctx: Ctx, courseid: number): Promise<void> {
  const fn = pickFunction(ctx.manifest, "core_courseformat_get_state")!;
  const raw = await ctx.client.call(fn, { courseid });
  const { sections, cms } = parseCourseState(raw);
  emit(typeof raw === "string" ? JSON.parse(raw) : raw);
  const rows: Record<string, unknown>[] = [];
  for (const sec of sections) {
    const title = sec.title || sec.name || `Section ${sec.number ?? sec.num ?? ""}`;
    rows.push({ kind: "SECTION", name: title, module: "", id: sec.id, url: "" });
    for (const cmid of sec.cmlist || []) {
      const cm = cms[String(cmid)];
      if (!cm) continue;
      rows.push({
        kind: cm.visible === false ? "hidden" : "activity",
        name: "  " + (cm.name || ""),
        module: cm.module || cm.modname || "",
        id: cm.id,
        url: cm.url || "",
      });
    }
  }
  table(rows, ["kind", "name", "module", "id"]);
}

// ---- deadlines / calendar -------------------------------------------------

export async function deadlines(ctx: Ctx, limit = 20): Promise<void> {
  const fn = pickFunction(
    ctx.manifest,
    "core_calendar_get_action_events_by_timesort",
    "core_calendar_get_calendar_upcoming_view"
  )!;
  let events: any[];
  if (fn === "core_calendar_get_action_events_by_timesort") {
    const r = await ctx.client.call(fn, {
      timesortfrom: Math.floor(Date.now() / 1000),
      limitnum: limit,
    });
    events = r.events || [];
  } else {
    const r = await ctx.client.call(fn, { courseid: 1, categoryid: 0 });
    events = r.events || [];
  }
  const rows = events.map((e) => ({
    when: e.timesort
      ? new Date(e.timesort * 1000).toISOString().replace("T", " ").slice(0, 16)
      : "",
    course: e.course?.shortname || e.course?.fullname || "",
    activity: e.activityname || e.modulename || e.icon?.component || "",
    name: e.name,
    url: e.url || e.viewurl || "",
  }));
  emit(events);
  table(rows, ["when", "course", "activity", "name"]);
  human(`${rows.length} upcoming item(s).`);
}

export async function calendarMonth(ctx: Ctx, year: number, month: number): Promise<void> {
  const fn = pickFunction(ctx.manifest, "core_calendar_get_calendar_monthly_view")!;
  const r = await ctx.client.call(fn, {
    year,
    month,
    courseid: 1,
    categoryid: 0,
    includenavigation: false,
    mini: false,
    day: 1,
  });
  emit(r);
  const days = (r.weeks || []).flatMap((w: any) => w.days || []);
  const rows = days
    .filter((d: any) => (d.events || []).length)
    .flatMap((d: any) =>
      (d.events || []).map((e: any) => ({
        date: `${year}-${String(month).padStart(2, "0")}-${String(d.mday).padStart(2, "0")}`,
        course: e.course?.shortname || "",
        name: e.name,
      }))
    );
  table(rows, ["date", "course", "name"]);
}

// ---- grades (HTML — the grade web services are disabled on this site) ------

export async function grades(ctx: Ctx, courseid?: number): Promise<void> {
  const path = courseid
    ? `/grade/report/user/index.php`
    : `/grade/report/overview/index.php`;
  const html = await ctx.client.htmlGet(path, courseid ? { id: courseid } : undefined);
  // Best-effort table extraction: pull the grade report table rows.
  const rows: Record<string, unknown>[] = [];
  const tableMatch = html.match(/<table[^>]*(?:overview|user-grade|generaltable)[^>]*>[\s\S]*?<\/table>/i);
  const region = tableMatch ? tableMatch[0] : html;
  const trRe = /<tr[\s\S]*?<\/tr>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(region))) {
    if (!/<td/i.test(tr[0])) continue; // skip header-only (<th>) rows
    const cells = [...tr[0].matchAll(/<t[hd][\s\S]*?<\/t[hd]>/gi)].map((m) => stripTags(m[0]));
    const nonEmpty = cells.filter((c) => c);
    if (nonEmpty.length >= 2) {
      rows.push({ item: nonEmpty[0], grade: nonEmpty[nonEmpty.length - 1] });
    }
  }
  emit({ path, url: ctx.client.baseUrl() + path, rows });
  if (rows.length) table(rows, ["item", "grade"]);
  else
    note(
      "Could not parse the grade table. Open it directly:\n  " +
        ctx.client.baseUrl() + path + (courseid ? `?id=${courseid}` : "")
    );
}

// ---- assignments (from course structure) ----------------------------------

export async function assignments(ctx: Ctx, courseid?: number): Promise<void> {
  const stateFn = pickFunction(ctx.manifest, "core_courseformat_get_state")!;
  let courseIds: number[] = [];
  if (courseid) courseIds = [courseid];
  else {
    const cfn = pickFunction(
      ctx.manifest,
      "core_course_get_enrolled_courses_by_timeline_classification"
    )!;
    const r = await ctx.client.call(cfn, { classification: "inprogress", limit: 0, offset: 0, sort: "fullname" });
    courseIds = (r.courses || []).slice(0, 15).map((c: any) => c.id);
  }
  const rows: Record<string, unknown>[] = [];
  for (const cid of courseIds) {
    try {
      const raw = await ctx.client.call(stateFn, { courseid: cid });
      const { cms } = parseCourseState(raw);
      for (const cm of Object.values(cms)) {
        if ((cm.module || cm.modname) === "assign") {
          rows.push({ courseid: cid, cmid: cm.id, name: cm.name, url: cm.url });
        }
      }
    } catch (e) {
      if (e instanceof AuthError) throw e;
    }
  }
  emit(rows);
  table(rows, ["courseid", "cmid", "name"]);
  human(`${rows.length} assignment activity(ies).`);
}

// ---- messages & notifications --------------------------------------------

export async function messages(ctx: Ctx, limit = 20): Promise<void> {
  const uid = await userId(ctx);
  const fn = pickFunction(ctx.manifest, "core_message_get_conversations")!;
  const r = await ctx.client.call(fn, { userid: uid, limitfrom: 0, limitnum: limit });
  emit(r);
  const rows = (r.conversations || []).map((c: any) => ({
    name: c.name || (c.members || []).map((m: any) => m.fullname).join(", "),
    unread: c.unreadcount || 0,
    last: c.messages?.[0]?.text ? stripTags(c.messages[0].text).slice(0, 60) : "",
  }));
  table(rows, ["name", "unread", "last"]);
  human(`${rows.length} conversation(s).`);
}

export async function notifications(ctx: Ctx, limit = 20): Promise<void> {
  const uid = await userId(ctx);
  const fn = pickFunction(ctx.manifest, "message_popup_get_popup_notifications")!;
  const r = await ctx.client.call(fn, { useridto: uid, newestfirst: 1, limit, offset: 0 });
  const items = r.notifications || [];
  emit(items);
  const rows = items.map((n: any) => ({
    when: n.timecreated
      ? new Date(n.timecreated * 1000).toISOString().replace("T", " ").slice(0, 16)
      : "",
    read: n.read ? "read" : "UNREAD",
    subject: stripTags(n.subject || n.smallmessage || "").slice(0, 70),
  }));
  table(rows, ["when", "read", "subject"]);
  human(`${rows.length} notification(s), ${r.unreadcount ?? "?"} unread.`);
}

// ---- recently accessed items ----------------------------------------------

export async function recent(ctx: Ctx): Promise<void> {
  const fn = pickFunction(ctx.manifest, "block_recentlyaccesseditems_get_recent_items")!;
  const items = await ctx.client.call<any[]>(fn, {});
  emit(items);
  const rows = (items || []).map((i: any) => ({
    course: i.coursename || "",
    name: i.name,
    module: i.modname || "",
    url: i.viewurl || "",
  }));
  table(rows, ["course", "module", "name"]);
}

// ---- course search --------------------------------------------------------

export async function searchCourses(ctx: Ctx, query: string): Promise<void> {
  const fn = pickFunction(ctx.manifest, "core_course_search_courses")!;
  const r = await ctx.client.call(fn, {
    criterianame: "search",
    criteriavalue: query,
    page: 0,
    perpage: 20,
  });
  emit(r);
  const rows = (r.courses || []).map((c: any) => ({
    id: c.id,
    short: c.shortname,
    fullname: c.fullname,
  }));
  table(rows, ["id", "short", "fullname"]);
  human(`${r.total ?? rows.length} result(s).`);
}

// ---- download a file (cookie-authenticated) -------------------------------

export async function download(ctx: Ctx, fileUrl: string, out?: string): Promise<void> {
  const s = ctx.client.getSession();
  let url = fileUrl;
  if (s?.mode === "token" && s.token && /pluginfile\.php/.test(url)) {
    url += (url.includes("?") ? "&" : "?") + "token=" + s.token;
  }
  const res = await ctx.client.bytes(url);
  const target = out || fileUrl.split("/").pop()?.split("?")[0] || "download.bin";
  fs.writeFileSync(target, res.buf);
  note(`Saved ${target} (${res.buf.length} bytes, HTTP ${res.status})`);
  emit({ saved: target, status: res.status, bytes: res.buf.length, contentType: res.contentType });
}

// ---- page introspection: map every form + link on any page ----------------

function abs(ctx: Ctx, url: string): string {
  return url.startsWith("http")
    ? url
    : ctx.client.baseUrl() + (url.startsWith("/") ? "" : "/") + url;
}
function trunc(s: string, n = 60): string {
  s = (s || "").replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function extractErrors(html: string): string[] {
  const out: string[] = [];
  const re =
    /class="[^"]*(?:alert-danger|invalid-feedback|felement[^"]*error|errormessage)[^"]*"[^>]*>([\s\S]*?)</gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 6) {
    const t = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (t) out.push(t.slice(0, 120));
  }
  return out;
}

export async function pageIntrospect(
  ctx: Ctx,
  url: string,
  opts: { links?: boolean; forms?: boolean } = {}
): Promise<void> {
  const target = abs(ctx, url);
  const html = await ctx.client.htmlGet(target);
  const forms = parseForms(html, target);
  const links = parseLinks(html, target);
  const showForms = opts.forms || !opts.links;
  const showLinks = opts.links || !opts.forms;
  const out: any = { url: target };
  if (showForms)
    out.forms = forms.map((f) => ({
      index: f.index,
      id: f.id,
      method: f.method,
      action: f.action,
      fields: f.fields.map((x) => ({ name: x.name, type: x.type, value: trunc(x.value, 40) })),
      submits: f.submits,
    }));
  if (showLinks) out.links = links;
  emit(out);
  if (showForms) {
    note(`FORMS (${forms.length}):`);
    for (const f of forms) {
      note(`  [#${f.index}] ${f.method} ${f.action}${f.id ? " (id=" + f.id + ")" : ""}`);
      note(`      fields: ${f.fields.map((x) => x.name + ":" + x.type).join(", ") || "(none)"}`);
      if (f.submits.length)
        note(`      submit: ${f.submits.map((s) => s.name + "=" + s.value).join("  |  ")}`);
    }
  }
  if (showLinks) {
    table(links.slice(0, 60).map((l) => ({ text: l.text, href: l.href })), ["text", "href"]);
    human(`${links.length} link(s).`);
  }
}

// ---- generic form replay: drive ANY Moodle form (the master key) -----------

export async function formCmd(
  ctx: Ctx,
  url: string,
  opts: {
    n?: number;
    match?: string;
    list?: boolean;
    dryRun?: boolean;
    fields: Record<string, string>;
    files: { field: string; path: string }[];
    submit?: string;
  }
): Promise<void> {
  const target = abs(ctx, url);
  const html = await ctx.client.htmlGet(target);
  const forms = parseForms(html, target);
  if (!forms.length) throw new WSError(`No <form> found on ${target}`);
  let form: ParsedForm | undefined;
  if (opts.n != null) form = forms[opts.n];
  else if (opts.match)
    form = forms.find(
      (f) =>
        (f.id || "").includes(opts.match!) ||
        f.action.includes(opts.match!) ||
        (f.name || "").includes(opts.match!)
    );
  else form = forms.length === 1 ? forms[0] : forms.find((f) => f.method === "POST") || forms[0];
  if (!form)
    throw new WSError(
      `No matching form (page has ${forms.length}). Use --n <i> or --match <text>, ` +
        `or inspect with: lmc page ${target}`
    );

  if (opts.list) {
    emit(form);
    note(`Form #${form.index}: ${form.method} ${form.action}`);
    table(
      form.fields.map((f) => ({
        name: f.name,
        type: f.type,
        value: trunc(f.value, 40),
        options: (f.options || []).map((o) => o.value).slice(0, 6).join("|"),
      })),
      ["name", "type", "value", "options"]
    );
    note("submit buttons: " + (form.submits.map((s) => s.name + "=" + s.value).join("  |  ") || "(none)"));
    return;
  }

  const sess = ctx.client.getSession();
  const values = resolveFormValues(form, opts.fields, opts.submit);
  if (!("sesskey" in values) && sess?.sesskey) values.sesskey = sess.sesskey;

  if (opts.dryRun) {
    emit({ action: form.action, method: form.method, values, files: opts.files });
    note(
      `DRY RUN — would ${form.method} to ${form.action} with ${Object.keys(values).length} field(s)` +
        (opts.files.length ? ` + ${opts.files.length} file(s)` : "")
    );
    table(
      Object.entries(values).map(([k, v]) => ({ field: k, value: trunc(String(v), 50) })),
      ["field", "value"]
    );
    return;
  }

  let res;
  if (form.method === "GET") {
    res = await ctx.client.raw("GET", form.action, { query: values });
  } else if (opts.files.length) {
    res = await ctx.client.postMultipart(form.action, values, opts.files);
  } else {
    res = await ctx.client.raw("POST", form.action, {
      body: new URLSearchParams(values),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  }
  const errs = extractErrors(res.text);
  const ok = res.status < 400 && !errs.length;
  emit({ status: res.status, ok, location: res.headers.get("location") || undefined, errors: errs });
  note(
    ok
      ? `Submitted — HTTP ${res.status}${res.headers.get("location") ? " → " + res.headers.get("location") : ""}`
      : `HTTP ${res.status}${errs.length ? " — errors: " + errs.join("; ") : ""}`
  );
}

// ---- open a site page in a real browser -----------------------------------

export async function open(ctx: Ctx, wantedPath = "/my/"): Promise<void> {
  const target = wantedPath.startsWith("http")
    ? wantedPath
    : ctx.client.baseUrl() + (wantedPath.startsWith("/") ? "" : "/") + wantedPath;
  emit({ url: target });
  human("Opening in your browser:\n" + target);
  try {
    const { execFile } = require("child_process");
    const cmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    execFile(cmd, [target]);
  } catch {
    /* just printed it */
  }
}
