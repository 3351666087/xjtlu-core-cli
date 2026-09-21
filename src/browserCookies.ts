import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { debug } from "./output";

/**
 * Read a logged-in session straight out of the user's own browser cookie store
 * and decrypt it locally. This is the portable, public-repo-friendly way to
 * authenticate against a site whose identity provider blocks automation (slider
 * captcha + anti-bot fingerprinting): the human logs in normally in their real
 * browser, and we simply reuse the resulting cookies. No passwords, no captcha,
 * nothing to reverse-engineer.
 *
 * Supported: Chromium-family (Chrome/Edge/Brave/Chromium/Vivaldi) on macOS,
 * Windows and Linux, plus Firefox (cookies stored unencrypted) everywhere.
 */

export interface RawCookie {
  name: string;
  value: string;
  host: string;
}

export type BrowserName =
  | "edge"
  | "chrome"
  | "brave"
  | "chromium"
  | "vivaldi"
  | "firefox"
  | "auto";

interface ChromiumProfile {
  name: string; // display name
  userDataDir: string;
  keychainService: string; // macOS Keychain service
  keychainAccount: string;
  localStateApp: string; // for readable errors
}

function home(): string {
  return os.homedir();
}

/** Per-platform Chromium "User Data" roots + Keychain service names. */
function chromiumProfiles(): Record<Exclude<BrowserName, "firefox" | "auto">, ChromiumProfile | null> {
  const p = process.platform;
  const mk = (macDir: string, winDir: string, linDir: string, svc: string, acct: string): ChromiumProfile | null => {
    let userDataDir: string;
    if (p === "darwin") userDataDir = path.join(home(), "Library", "Application Support", macDir);
    else if (p === "win32") userDataDir = path.join(process.env.LOCALAPPDATA || path.join(home(), "AppData", "Local"), winDir, "User Data");
    else userDataDir = path.join(process.env.XDG_CONFIG_HOME || path.join(home(), ".config"), linDir);
    return { name: acct, userDataDir, keychainService: svc, keychainAccount: acct, localStateApp: acct };
  };
  return {
    edge: mk("Microsoft Edge", "Microsoft/Edge", "microsoft-edge", "Microsoft Edge Safe Storage", "Microsoft Edge"),
    chrome: mk("Google/Chrome", "Google/Chrome", "google-chrome", "Chrome Safe Storage", "Chrome"),
    brave: mk("BraveSoftware/Brave-Browser", "BraveSoftware/Brave-Browser", "BraveSoftware/Brave-Browser", "Brave Safe Storage", "Brave"),
    chromium: mk("Chromium", "Chromium", "chromium", "Chromium Safe Storage", "Chromium"),
    vivaldi: mk("Vivaldi", "Vivaldi", "vivaldi", "Vivaldi Safe Storage", "Vivaldi"),
  };
}

/** sqlite3 is preinstalled on macOS/most Linux; we shell out to avoid a native dep. */
function sqliteQuery(dbFile: string, sql: string): string[] {
  // copy first (browsers hold a lock / WAL)
  const tmp = path.join(os.tmpdir(), `lmc-ck-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  fs.copyFileSync(dbFile, tmp);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(dbFile + suffix)) {
      try { fs.copyFileSync(dbFile + suffix, tmp + suffix); } catch { /* ignore */ }
    }
  }
  try {
    const out = execFileSync("sqlite3", ["-readonly", tmp, sql], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return out.split("\n").filter(Boolean);
  } finally {
    for (const s of ["", "-wal", "-shm"]) {
      try { fs.rmSync(tmp + s); } catch { /* ignore */ }
    }
  }
}

// ---- key retrieval per platform -------------------------------------------

function macKey(prof: ChromiumProfile): Buffer {
  const pw = execFileSync("security", [
    "find-generic-password", "-w", "-s", prof.keychainService, "-a", prof.keychainAccount,
  ], { encoding: "utf8" }).trim();
  return crypto.pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
}

function linuxKey(): Buffer {
  // Fallback key used when no keyring password is set (very common for CLI use).
  return crypto.pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
}

function winMasterKey(prof: ChromiumProfile): Buffer {
  const localState = path.join(prof.userDataDir, "Local State");
  const json = JSON.parse(fs.readFileSync(localState, "utf8"));
  const b64 = json.os_crypt?.encrypted_key;
  if (!b64) throw new Error("No os_crypt.encrypted_key in Local State");
  const encrypted = Buffer.from(b64, "base64").subarray(5); // strip 'DPAPI'
  // Unprotect with DPAPI via PowerShell (avoids a native dependency).
  const ps =
    "$b=[Convert]::FromBase64String('" + encrypted.toString("base64") + "');" +
    "Add-Type -AssemblyName System.Security;" +
    "$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
    "[Convert]::ToBase64String($k)";
  const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim();
  return Buffer.from(out, "base64");
}

// ---- value decryption -----------------------------------------------------

function decryptChromiumValue(enc: Buffer, aesKey: Buffer, plat: NodeJS.Platform): string {
  if (enc.length === 0) return "";
  const prefix = enc.subarray(0, 3).toString("latin1");
  if (prefix === "v10" || prefix === "v11") {
    if (plat === "win32") {
      // AES-256-GCM: [3 prefix][12 nonce][ciphertext][16 tag]
      const nonce = enc.subarray(3, 15);
      const tag = enc.subarray(enc.length - 16);
      const ct = enc.subarray(15, enc.length - 16);
      const d = crypto.createDecipheriv("aes-256-gcm", aesKey, nonce);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
    }
    // macOS / Linux: AES-128-CBC, iv = 16 spaces
    const iv = Buffer.alloc(16, " ");
    const d = crypto.createDecipheriv("aes-128-cbc", aesKey, iv);
    d.setAutoPadding(false);
    let out = Buffer.concat([d.update(enc.subarray(3)), d.final()]);
    const pad = out[out.length - 1];
    if (pad > 0 && pad <= 16) out = out.subarray(0, out.length - pad);
    // Newer Chromium prepends a 32-byte SHA256(host) hash — strip if present.
    if (/[\x00-\x08\x0e-\x1f]/.test(out.subarray(0, 32).toString("latin1"))) {
      out = out.subarray(32);
    }
    return out.toString("utf8");
  }
  if (plat === "win32") {
    // Legacy DPAPI-encrypted value.
    const ps =
      "$b=[Convert]::FromBase64String('" + enc.toString("base64") + "');" +
      "Add-Type -AssemblyName System.Security;" +
      "[Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";
    return execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).replace(/\r?\n$/, "");
  }
  return enc.toString("utf8"); // already plaintext
}

// ---- profile discovery ----------------------------------------------------

function chromiumProfileDirs(userDataDir: string, profile?: string): string[] {
  if (profile) return [path.join(userDataDir, profile)];
  const candidates = ["Default"];
  try {
    for (const e of fs.readdirSync(userDataDir)) {
      if (/^Profile \d+$/.test(e)) candidates.push(e);
    }
  } catch { /* ignore */ }
  return candidates.map((c) => path.join(userDataDir, c));
}

// ---- public API -----------------------------------------------------------

export function readChromiumCookies(
  browser: Exclude<BrowserName, "firefox" | "auto">,
  domainSubstr: string,
  profile?: string
): RawCookie[] {
  const prof = chromiumProfiles()[browser];
  if (!prof) throw new Error(`Unknown browser: ${browser}`);
  if (!fs.existsSync(prof.userDataDir)) throw new Error(`${prof.name} not found at ${prof.userDataDir}`);

  const plat = process.platform;
  let aesKey: Buffer;
  if (plat === "darwin") aesKey = macKey(prof);
  else if (plat === "win32") aesKey = winMasterKey(prof);
  else aesKey = linuxKey();

  const cookies: RawCookie[] = [];
  for (const dir of chromiumProfileDirs(prof.userDataDir, profile)) {
    const db = path.join(dir, "Network", "Cookies");
    const legacyDb = path.join(dir, "Cookies");
    const dbFile = fs.existsSync(db) ? db : fs.existsSync(legacyDb) ? legacyDb : null;
    if (!dbFile) continue;
    try {
      const rows = sqliteQuery(
        dbFile,
        `select host_key || '\t' || name || '\t' || hex(encrypted_value) from cookies where host_key like '%${domainSubstr}%';`
      );
      for (const row of rows) {
        const [host, name, hex] = row.split("\t");
        if (!name) continue;
        try {
          const value = decryptChromiumValue(Buffer.from(hex, "hex"), aesKey, plat);
          if (value) cookies.push({ host, name, value });
        } catch (e) {
          debug("decrypt failed for", name, String(e).slice(0, 60));
        }
      }
    } catch (e) {
      debug("cookie db read failed", dbFile, String(e).slice(0, 80));
    }
  }
  return dedupe(cookies);
}

export function readFirefoxCookies(domainSubstr: string): RawCookie[] {
  const roots =
    process.platform === "darwin"
      ? [path.join(home(), "Library", "Application Support", "Firefox", "Profiles")]
      : process.platform === "win32"
      ? [path.join(process.env.APPDATA || "", "Mozilla", "Firefox", "Profiles")]
      : [path.join(home(), ".mozilla", "firefox")];
  const cookies: RawCookie[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const prof of fs.readdirSync(root)) {
      const db = path.join(root, prof, "cookies.sqlite");
      if (!fs.existsSync(db)) continue;
      try {
        const rows = sqliteQuery(db, `select host || '\t' || name || '\t' || value from moz_cookies where host like '%${domainSubstr}%';`);
        for (const row of rows) {
          const [host, name, value] = row.split("\t");
          if (name) cookies.push({ host, name, value: value || "" });
        }
      } catch (e) {
        debug("firefox read failed", String(e).slice(0, 60));
      }
    }
  }
  return dedupe(cookies);
}

function dedupe(cookies: RawCookie[]): RawCookie[] {
  const seen = new Set<string>();
  const out: RawCookie[] = [];
  for (const c of cookies) {
    if (seen.has(c.name)) continue; // last profile wins is fine; keep first
    seen.add(c.name);
    out.push(c);
  }
  return out;
}

/** Try a browser (or all) and return the cookies for the domain. */
export function readSessionCookies(
  browser: BrowserName,
  domainSubstr: string,
  profile?: string
): { browser: string; cookies: RawCookie[] } {
  const order: BrowserName[] =
    browser === "auto" ? ["edge", "chrome", "brave", "vivaldi", "chromium", "firefox"] : [browser];
  let lastErr: unknown;
  for (const b of order) {
    try {
      const cookies =
        b === "firefox"
          ? readFirefoxCookies(domainSubstr)
          : readChromiumCookies(b as Exclude<BrowserName, "firefox" | "auto">, domainSubstr, profile);
      if (cookies.some((c) => /MoodleSession/i.test(c.name))) return { browser: b, cookies };
      if (browser !== "auto" && cookies.length) return { browser: b, cookies };
    } catch (e) {
      lastErr = e;
      debug("browser", b, "failed", String(e).slice(0, 80));
      if (browser !== "auto") throw e;
    }
  }
  if (lastErr && browser !== "auto") throw lastErr;
  throw new Error(
    `No MoodleSession cookie found in ${browser === "auto" ? "any browser" : browser}. ` +
      "Log in to https://core.xjtlu.edu.cn/ in that browser first (and keep it open)."
  );
}
