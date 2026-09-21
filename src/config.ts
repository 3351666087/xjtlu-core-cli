import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * All persisted state lives in one directory (default ~/.config/xjtlu-core,
 * overridable with LMC_HOME). Everything is written 0600 because session.json
 * holds a long-lived web-service token / session cookie.
 */

export interface SiteConfig {
  /** e.g. https://core.xjtlu.edu.cn (no trailing slash) */
  baseUrl: string;
  wwwroot: string;
  sitename?: string;
  /** custom url scheme used for the mobile-token SSO launch (default moodlemobile) */
  urlscheme: string;
  /** web service short name used for the token (default moodle_mobile_app) */
  service: string;
  savedAt: string;
}

export type AuthMode = "token" | "cookie";

export interface StoredCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

export interface Session {
  mode: AuthMode;
  /** mobile web-service token (mode=token) — only when the site enables web services */
  token?: string;
  privatetoken?: string;
  /**
   * Full cookie jar for the site (mode=cookie). We keep ALL cookies (not just
   * MoodleSession) because the site sits behind a load balancer whose SERVERID
   * sticky cookie must travel with the session cookie.
   */
  cookies?: StoredCookie[];
  /** legacy single-cookie fields (still honoured if present) */
  cookie?: string;
  cookieName?: string;
  sesskey?: string;
  /** identity, filled from core_webservice_get_site_info */
  userid?: number;
  username?: string;
  fullname?: string;
  capturedAt: string;
}

export interface CatalogEntry {
  name: string;
  component: string;
  read: boolean;
  desc?: string;
  /** live availability over the AJAX transport: yes | no | unknown | unprobed */
  available?: "yes" | "no" | "unknown" | "unprobed";
  code?: string;
}

export interface Manifest {
  fetchedAt: string;
  release?: string;
  sitename?: string;
  transport: AuthMode;
  functions: Record<string, CatalogEntry>;
  availableCount: number;
  probed: boolean;
}

const DEFAULT_BASE = "https://core.xjtlu.edu.cn";

export function homeDir(): string {
  const override = process.env.LMC_HOME;
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, "xjtlu-core");
  return path.join(os.homedir(), ".config", "xjtlu-core");
}

function ensureHome(): string {
  const dir = homeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  return dir;
}

function pathFor(name: string): string {
  return path.join(homeDir(), name);
}

function readJson<T>(name: string): T | null {
  try {
    const raw = fs.readFileSync(pathFor(name), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(name: string, value: unknown): void {
  ensureHome();
  const p = pathFor(name);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* best effort */
  }
}

// ---- config ---------------------------------------------------------------

export function loadConfig(): SiteConfig {
  const existing = readJson<SiteConfig>("config.json");
  if (existing && existing.baseUrl) return existing;
  const base = (process.env.LMC_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const fresh: SiteConfig = {
    baseUrl: base,
    wwwroot: base,
    urlscheme: process.env.LMC_URL_SCHEME || "moodlemobile",
    service: process.env.LMC_SERVICE || "moodle_mobile_app",
    savedAt: new Date().toISOString(),
  };
  return fresh;
}

export function saveConfig(cfg: SiteConfig): void {
  writeJson("config.json", { ...cfg, savedAt: new Date().toISOString() });
}

// ---- session --------------------------------------------------------------

export function loadSession(): Session | null {
  return readJson<Session>("session.json");
}

export function saveSession(s: Session): void {
  writeJson("session.json", s);
}

export function clearSession(): void {
  try {
    fs.rmSync(pathFor("session.json"));
  } catch {
    /* ignore */
  }
}

// ---- manifest (dynamic function catalogue) --------------------------------

export function loadManifest(): Manifest | null {
  return readJson<Manifest>("manifest.json");
}

export function saveManifest(m: Manifest): void {
  writeJson("manifest.json", m);
}

export function manifestAgeMs(m: Manifest | null): number {
  if (!m || !m.fetchedAt) return Number.POSITIVE_INFINITY;
  return Date.now() - new Date(m.fetchedAt).getTime();
}
