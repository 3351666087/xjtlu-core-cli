import { parse, HTMLElement } from "node-html-parser";

/**
 * Lightweight HTML introspection so the CLI can drive ANY Moodle page the way a
 * browser does: enumerate every form + field + actionable link, then replay the
 * form as a POST. This is what turns "every button" into something programmable.
 */

export interface FormField {
  name: string;
  type: string; // input type, or "select" / "textarea"
  value: string;
  checked?: boolean; // for checkbox/radio
  options?: { value: string; label: string; selected: boolean }[];
}

export interface ParsedForm {
  index: number;
  id?: string;
  name?: string;
  action: string; // absolute URL
  method: string; // GET | POST
  enctype?: string;
  fields: FormField[];
  submits: { name: string; value: string }[];
}

export interface PageLink {
  text: string;
  href: string; // absolute URL
}

export function absolutize(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function attr(el: HTMLElement, name: string): string | undefined {
  const v = el.getAttribute(name);
  return v === undefined ? undefined : v;
}

export function parseForms(html: string, baseUrl: string): ParsedForm[] {
  const root = parse(html, { comment: false });
  const forms = root.querySelectorAll("form");
  return forms.map((f, index) => {
    const fields: FormField[] = [];
    const submits: { name: string; value: string }[] = [];
    for (const el of f.querySelectorAll("input")) {
      const type = (attr(el, "type") || "text").toLowerCase();
      const name = attr(el, "name");
      if (type === "submit" || type === "image" || type === "button") {
        if (name) submits.push({ name, value: attr(el, "value") || "" });
        continue;
      }
      if (!name) continue;
      const checked = el.hasAttribute("checked");
      fields.push({ name, type, value: attr(el, "value") || "", checked });
    }
    for (const el of f.querySelectorAll("textarea")) {
      const name = attr(el, "name");
      if (name) fields.push({ name, type: "textarea", value: el.text || "" });
    }
    for (const el of f.querySelectorAll("select")) {
      const name = attr(el, "name");
      if (!name) continue;
      const options = el.querySelectorAll("option").map((o) => ({
        value: o.getAttribute("value") ?? o.text.trim(),
        label: o.text.trim(),
        selected: o.hasAttribute("selected"),
      }));
      const sel = options.find((o) => o.selected) || options[0];
      fields.push({ name, type: "select", value: sel ? sel.value : "", options });
    }
    for (const el of f.querySelectorAll("button")) {
      const name = attr(el, "name");
      const type = (attr(el, "type") || "submit").toLowerCase();
      if (name && type === "submit") submits.push({ name, value: attr(el, "value") || "" });
    }
    return {
      index,
      id: attr(f, "id"),
      name: attr(f, "name"),
      action: absolutize(attr(f, "action") || baseUrl, baseUrl),
      method: (attr(f, "method") || "GET").toUpperCase(),
      enctype: attr(f, "enctype"),
      fields,
      submits,
    };
  });
}

export function parseLinks(html: string, baseUrl: string): PageLink[] {
  const root = parse(html, { comment: false });
  const seen = new Set<string>();
  const out: PageLink[] = [];
  for (const a of root.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
    const abs = absolutize(href, baseUrl);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const text = (a.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    out.push({ text: text.slice(0, 80), href: abs });
  }
  return out;
}

export interface FilepickerInfo {
  sesskey?: string;
  repoUpload?: number; // id of the "Upload a file" repository
  ctxId?: number; // context id for the draft area
  itemid?: number; // draft item id the form allocated
}

/**
 * Best-effort discovery of the parameters needed to upload into a Moodle draft
 * file area, scraped from a page that renders a filemanager/filepicker (e.g. an
 * assignment submission page, or /user/files.php).
 */
export function discoverFilepicker(html: string): FilepickerInfo {
  const info: FilepickerInfo = {};
  const sk = html.match(/"sesskey":"([^"]+)"/);
  if (sk) info.sesskey = sk[1];
  // The "Upload a file" repo appears like:
  //   "5":{"id":"5","name":"Upload a file","type":"upload",...}
  // (id may be quoted, and can come before or after "type").
  const repo =
    html.match(/"id":"?(\d+)"?,"name":"[^"]*","type":"upload"/) ||
    html.match(/"type":"upload"[^{}]*?"id":"?(\d+)"?/) ||
    html.match(/"id":"?(\d+)"?[^{}]*?"type":"upload"/) ||
    html.match(/"repo_id":"?(\d+)"?[^{}]*?"type":"upload"/);
  if (repo) info.repoUpload = parseInt(repo[1], 10);
  const ctx =
    html.match(/"contextid":(\d+)/) ||
    html.match(/"context":\{"id":(\d+)/) ||
    html.match(/"ctx_id":(\d+)/) ||
    html.match(/[?&]ctx_id=(\d+)/);
  if (ctx) info.ctxId = parseInt(ctx[1], 10);
  const item =
    html.match(/"itemid":(\d+)/) ||
    html.match(/name="[^"]*filemanager"[^>]*value="(\d+)"/) ||
    html.match(/"client_id":"[^"]+","itemid":(\d+)/);
  if (item) info.itemid = parseInt(item[1], 10);
  return info;
}

/** Resolve a form's fields into a name→value map, applying overrides. */
export function resolveFormValues(
  form: ParsedForm,
  overrides: Record<string, string>,
  submitName?: string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of form.fields) {
    if (f.type === "checkbox" || f.type === "radio") {
      // Only include when checked (or explicitly overridden).
      if (f.name in overrides) out[f.name] = overrides[f.name];
      else if (f.checked) out[f.name] = f.value || "1";
    } else {
      out[f.name] = f.name in overrides ? overrides[f.name] : f.value;
    }
  }
  // apply overrides for fields not present in the form too
  for (const [k, v] of Object.entries(overrides)) if (!(k in out)) out[k] = v;
  // include the chosen submit button
  const submit = submitName
    ? form.submits.find((s) => s.name === submitName)
    : form.submits[0];
  if (submit) out[submit.name] = submit.value || "1";
  return out;
}
