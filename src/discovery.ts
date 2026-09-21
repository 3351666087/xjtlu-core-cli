import { MoodleClient, WSError, AuthError } from "./moodle";
import {
  Manifest,
  CatalogEntry,
  loadManifest,
  saveManifest,
  manifestAgeMs,
} from "./config";
import { debug, note } from "./output";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const catalog = require("./catalog.json") as {
  functions: Omit<CatalogEntry, "available" | "code">[];
};

/** Manifest is considered stale after this long -> auto re-sync on next use. */
const STALE_MS = 12 * 60 * 60 * 1000; // 12h

// Moodle error codes that indicate the function IS available (it ran / it
// rejected our empty args), vs. codes that mean it is not on the AJAX transport.
const PARAM_LEVEL = new Set([
  "invalidparameter",
  "missingparam",
  "invalidrecord",
  "invalidrecordunknown",
  "invalidcoursemodule",
  "invalidcourse",
  "coursehidden",
  "requireloginerror", // needs login context but exists
  "nopermissions",
  "nopermission",
  "requiredcapability",
  "cannotviewprofile",
]);

async function probe(
  client: MoodleClient,
  fn: string
): Promise<{ available: CatalogEntry["available"]; code?: string }> {
  try {
    await client.call(fn, {});
    return { available: "yes" };
  } catch (e) {
    if (e instanceof AuthError) throw e;
    if (e instanceof WSError) {
      const code = e.errorcode || "";
      if (code === "servicenotavailable") return { available: "no", code };
      if (PARAM_LEVEL.has(code) || code === "") return { available: "yes", code };
      // Unknown function names surface as a coding/DB error.
      if (/invalidfunction|codingerror|dml|unknown/i.test(code))
        return { available: "unknown", code };
      return { available: "yes", code }; // it exists and executed to an error
    }
    return { available: "unknown", code: String(e).slice(0, 40) };
  }
}

async function runPool<T>(items: T[], size: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: size }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/**
 * Re-discover the live command surface. Because this Moodle has web services
 * disabled we cannot read core_webservice_get_site_info; instead we probe the
 * seed catalogue's read-only functions over the logged-in AJAX transport and
 * record which are actually callable right now. After a site upgrade/refactor,
 * re-running `lmc sync` refreshes availability with no code changes.
 */
export async function sync(
  client: MoodleClient,
  opts: { probe?: boolean } = {}
): Promise<Manifest> {
  // Refresh the sesskey (also validates the session) and grab the release.
  let release: string | undefined;
  if (client.getSession()?.mode === "cookie") {
    try {
      await client.refreshSesskey();
      const html = await client.htmlGet("/my/");
      const rel = html.match(/docs\.moodle\.org\/(\d{3})\//);
      if (rel) release = rel[1];
    } catch (e) {
      if (e instanceof AuthError) throw e;
      debug("release detection skipped", String(e));
    }
  }

  const functions: Record<string, CatalogEntry> = {};
  for (const f of catalog.functions) {
    functions[f.name] = { ...f, available: f.read ? "unprobed" : "unprobed" };
  }

  const doProbe = opts.probe !== false; // default: probe
  if (doProbe) {
    const toProbe = catalog.functions.filter((f) => f.read).map((f) => f.name);
    note(`Probing ${toProbe.length} read-only functions for live availability…`);
    await runPool(toProbe, 6, async (name) => {
      const r = await probe(client, name);
      functions[name].available = r.available;
      functions[name].code = r.code;
    });
  }

  const availableCount = Object.values(functions).filter(
    (f) => f.available === "yes"
  ).length;

  const manifest: Manifest = {
    fetchedAt: new Date().toISOString(),
    release,
    transport: client.getSession()?.mode || "cookie",
    functions,
    availableCount,
    probed: doProbe,
  };
  saveManifest(manifest);
  debug(`synced: ${availableCount} available of ${catalog.functions.length}`);
  return manifest;
}

export async function ensureManifest(
  client: MoodleClient,
  opts: { force?: boolean } = {}
): Promise<Manifest> {
  const existing = loadManifest();
  if (!opts.force && existing && manifestAgeMs(existing) < STALE_MS) {
    return existing;
  }
  // A light (no-probe) sync keeps startup fast; `lmc sync` does the full probe.
  return sync(client, { probe: !existing });
}

export function hasFunction(m: Manifest | null, name: string): boolean {
  const e = m?.functions[name];
  return !!e && e.available === "yes";
}

/** Pick the first function known-available (or unknown, as a hopeful default). */
export function pickFunction(m: Manifest | null, ...candidates: string[]): string | null {
  if (!m) return candidates[0] || null;
  for (const c of candidates) if (m.functions[c]?.available === "yes") return c;
  for (const c of candidates)
    if (!m.functions[c] || m.functions[c].available === "unprobed") return c;
  return candidates[0] || null;
}

export function componentOf(fnName: string): string {
  const parts = fnName.split("_");
  if (parts.length <= 2) return parts[0];
  return parts.slice(0, 2).join("_");
}
