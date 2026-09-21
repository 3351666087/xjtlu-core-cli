import * as crypto from "crypto";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  SiteConfig,
  Session,
  saveSession,
  saveConfig,
  homeDir,
} from "./config";
import { note, debug } from "./output";
import type { BrowserName } from "./browserCookies";

/** Public, unauthenticated site config (endpoints, identity providers, name). */
export async function fetchPublicConfig(cfg: SiteConfig): Promise<any> {
  const res = await fetch(cfg.baseUrl + "/lib/ajax/service.php?info=tool_mobile_get_public_config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([
      { index: 0, methodname: "tool_mobile_get_public_config", args: {} },
    ]),
  });
  const json = await res.json();
  const item = Array.isArray(json) ? json[0] : json;
  if (item?.error) throw new Error(item.exception?.message || "public config failed");
  return item.data;
}

/** Decode a captured `<scheme>://token=<base64>` URL into {token, privatetoken}. */
export function decodeTokenUrl(
  urlOrB64: string,
  cfg: SiteConfig,
  passport?: number
): { token: string; privatetoken?: string; verified: boolean } {
  let b64 = urlOrB64.trim();
  const m = b64.match(/token=([^&\s]+)/);
  if (m) b64 = m[1];
  b64 = decodeURIComponent(b64);
  let decoded: string;
  try {
    decoded = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    throw new Error("Could not base64-decode the token payload");
  }
  const parts = decoded.split(":::");
  if (parts.length < 2) {
    // Some flows return the raw token directly.
    if (/^[A-Za-z0-9]{20,}$/.test(decoded)) {
      return { token: decoded, verified: false };
    }
    throw new Error("Unexpected token payload format");
  }
  const [signature, token, privatetoken] = parts;
  let verified = false;
  if (passport !== undefined) {
    for (const root of [cfg.wwwroot, cfg.baseUrl, cfg.wwwroot.replace(/\/$/, "")]) {
      const expect = crypto.createHash("md5").update(root + passport).digest("hex");
      if (expect === signature) {
        verified = true;
        break;
      }
    }
  }
  return { token, privatetoken: privatetoken || undefined, verified };
}

function loadPlaywright(): any {
  try {
    return require("playwright");
  } catch {
    return null;
  }
}

function ensureChromium(pw: any): void {
  // Trigger a lightweight check; if the browser isn't installed, install it.
  try {
    const exe = pw.chromium.executablePath();
    if (exe) {
      const fs = require("fs");
      if (fs.existsSync(exe)) return;
    }
  } catch {
    /* fall through to install */
  }
  note("Downloading the Chromium runtime for login (one-time)…");
  try {
    execFileSync("npx", ["playwright", "install", "chromium"], {
      stdio: "inherit",
      cwd: path.join(__dirname, ".."),
    });
  } catch (e) {
    throw new Error(
      "Could not install the Chromium runtime automatically. Run:\n" +
        "  npx playwright install chromium\n" +
        "or log in without a browser via:  lmc login --paste '<moodlemobile://token=…>'"
    );
  }
}

export interface LoginOptions {
  cookieMode?: boolean; // force cookie-only session
  timeoutMs?: number; // how long to wait for SSO to complete
  scheme?: string;
  /** which browser engine to drive: real chrome/msedge (best) or bundled chromium */
  browser?: "chrome" | "msedge" | "chromium";
}

const REAL_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Launch a persistent browser context that looks like a normal browser.
 * The XJTLU identity provider is a SPA that blanks out when it detects
 * automation, so we (a) prefer the user's REAL Chrome/Edge binary via
 * Playwright channels, and (b) strip the automation fingerprints.
 */
async function launchStealthContext(pw: any, profileDir: string, pref?: string): Promise<any> {
  const order = pref ? [pref] : ["chrome", "msedge", "chromium"];
  const baseOpts = {
    headless: false,
    viewport: { width: 1280, height: 900 },
    userAgent: REAL_UA,
    locale: "en-US",
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  };
  let lastErr: unknown;
  for (const ch of order) {
    try {
      const opts: any = { ...baseOpts };
      if (ch !== "chromium") opts.channel = ch;
      const context = await pw.chromium.launchPersistentContext(profileDir, opts);
      // Hide the last automation tell before any page script runs.
      await context.addInitScript(
        "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
      );
      debug("launched login browser via", ch);
      return context;
    } catch (e) {
      lastErr = e;
      debug("browser channel failed", ch, String(e).slice(0, 80));
    }
  }
  throw new Error(
    "Could not launch a login browser (tried chrome, msedge, chromium): " +
      String(lastErr)
  );
}

function parseCookieHeader(header: string): { name: string; value: string }[] {
  return header
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf("=");
      return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim() };
    })
    .filter((c) => c.name);
}

/**
 * Given a set of cookies, save a cookie-mode session and enrich it with the
 * sesskey + identity read from an authenticated page. Shared by the
 * cookie-header, from-browser and (fallback) browser-automation login paths.
 */
export async function finishCookieSession(
  cfg: SiteConfig,
  cookies: { name: string; value: string }[]
): Promise<Session> {
  if (!cookies.some((c) => /^MoodleSession/i.test(c.name))) {
    throw new Error("No MoodleSession cookie present — are you logged in to the site?");
  }
  const session: Session = { mode: "cookie", cookies, capturedAt: new Date().toISOString() };
  saveSession(session);
  const { MoodleClient } = require("./moodle");
  const client = new MoodleClient(cfg, session);
  const html: string = await client.htmlGet("/my/");
  const sk = html.match(/"sesskey":"([^"]+)"/);
  if (sk) session.sesskey = sk[1];
  // Moodle's "logininfo" block: "You are logged in as <a href=...id=NNN>Name</a>".
  const li = html.match(
    /logged in as[\s\S]{0,160}?profile\.php\?id=(\d+)"[^>]*>\s*([^<]{1,60}?)\s*</i
  );
  if (li) {
    session.userid = parseInt(li[1], 10);
    session.fullname = li[2].trim();
  } else {
    const idm = html.match(/\/user\/profile\.php\?id=(\d+)/);
    if (idm) session.userid = parseInt(idm[1], 10);
    const fm =
      html.match(/profile\.php\?id=\d+"[^>]*>\s*([^<]{1,60}?)\s*</i) ||
      html.match(/"fullname"\s*:\s*"([^"]{1,60})"/);
    if (fm) session.fullname = fm[1].trim();
  }
  const um = html.match(/"username"\s*:\s*"([^"]+)"/) || html.match(/data-username="([^"]+)"/);
  if (um) session.username = um[1];
  saveSession(session);
  return session;
}

/**
 * No-automation login: the user logs in with their normal browser, copies the
 * `Cookie` request header for core.xjtlu.edu.cn from DevTools, and pastes it.
 */
export async function cookieHeaderLogin(cfg: SiteConfig, header: string): Promise<Session> {
  const cookies = parseCookieHeader(header);
  if (!cookies.some((c) => /^MoodleSession/i.test(c.name))) {
    throw new Error(
      "That header has no MoodleSession cookie. Copy the full Cookie header of a " +
        "request to core.xjtlu.edu.cn (DevTools → Network → any request → Request Headers → Cookie)."
    );
  }
  return finishCookieSession(cfg, cookies);
}

/**
 * Portable, recommended login: read the live session straight out of the user's
 * own browser cookie store and decrypt it locally. The user just needs to be
 * logged in to the site in that browser — the identity provider's captcha / MFA
 * were solved by them, in a real browser, so nothing here touches passwords or
 * bot-detection.
 */
export async function fromBrowserLogin(
  cfg: SiteConfig,
  browser: BrowserName,
  profile?: string
): Promise<Session> {
  const { readSessionCookies } = require("./browserCookies");
  note(`Reading your ${browser === "auto" ? "browser" : browser} session cookies…`);
  const host = cfg.baseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const domainSubstr = host.split(".").slice(-2).join("."); // xjtlu.edu.cn
  const { browser: used, cookies } = readSessionCookies(browser, domainSubstr, profile);
  const relevant = cookies.filter((c: any) =>
    c.host === host || c.host === "." + host || c.host.endsWith(host)
  );
  const use = relevant.length ? relevant : cookies;
  note(`Found ${use.length} cookie(s) for ${host} in ${used}.`);
  return finishCookieSession(cfg, use.map((c: any) => ({ name: c.name, value: c.value })));
}

/**
 * Interactive login. Opens a real browser window, lets the user complete SSO
 * once, and captures a long-lived mobile web-service token (plus the session
 * cookie + sesskey as a fallback transport). Persistent profile means the
 * identity-provider session is remembered, so future re-logins are usually
 * one click.
 */
export async function browserLogin(
  cfg: SiteConfig,
  opts: LoginOptions
): Promise<Session> {
  const pw = loadPlaywright();
  if (!pw) {
    throw new Error(
      "Playwright is not installed. Install deps in the CLI dir (npm install),\n" +
        "or log in without a browser:  lmc login --paste '<moodlemobile://token=…>'"
    );
  }
  ensureChromium(pw);

  const scheme = opts.scheme || cfg.urlscheme || "moodlemobile";
  const passport = Math.random() * 1000;
  const profileDir = path.join(homeDir(), "browser-profile");

  note("A browser window is opening — please complete the XJTLU SSO login there.");
  note("(The window remembers your identity provider, so next time is usually one click.)");
  const context = await launchStealthContext(pw, profileDir, opts.browser);

  let capturedTokenUrl: string | null = null;
  const page = context.pages()[0] || (await context.newPage());

  // Watch every page for the custom-scheme token redirect via CDP (only fires
  // on Moodles that have the mobile web service enabled).
  const attach = async (pg: any) => {
    try {
      const cdp = await context.newCDPSession(pg);
      await cdp.send("Network.enable");
      cdp.on("Network.requestWillBeSent", (e: any) => {
        const u: string = e.request?.url || "";
        if (u.startsWith(scheme + "://") && u.includes("token=")) capturedTokenUrl = u;
      });
    } catch (err) {
      debug("CDP attach failed", String(err));
    }
  };
  await attach(page);
  context.on("page", (pg: any) => attach(pg));

  const isLoggedIn = async (): Promise<boolean> => {
    try {
      const cookies = await context.cookies(cfg.baseUrl);
      const ms = cookies.find((c: any) => /^MoodleSession/i.test(c.name));
      return !!ms && !/\/login\//.test(page.url());
    } catch {
      return false;
    }
  };

  // Step 1: get the user logged in (SSO).
  await page.goto(cfg.baseUrl + "/login/index.php", { waitUntil: "domcontentloaded" }).catch(() => {});
  const deadline = Date.now() + (opts.timeoutMs || 5 * 60 * 1000);
  while (Date.now() < deadline) {
    if (await isLoggedIn()) break;
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!(await isLoggedIn())) {
    await context.close();
    throw new Error("Login timed out. Re-run: lmc login");
  }

  // Step 2 (best effort): try to mint a mobile web-service token. On sites with
  // web services disabled this just shows an error page and we fall back to the
  // session cookie.
  if (!opts.cookieMode) {
    const launchUrl =
      cfg.baseUrl +
      "/admin/tool/mobile/launch.php?service=" +
      encodeURIComponent(cfg.service) +
      "&passport=" + passport +
      "&urlscheme=" + encodeURIComponent(scheme);
    await page.goto(launchUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    const tokenDeadline = Date.now() + 8000;
    while (Date.now() < tokenDeadline && !capturedTokenUrl) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  // Step 3: capture the full cookie jar, sesskey, identity, release.
  let cookies: { name: string; value: string; domain?: string; path?: string }[] = [];
  let sesskey: string | undefined;
  let userid: number | undefined;
  let username: string | undefined;
  let fullname: string | undefined;
  try {
    const jar = await context.cookies(cfg.baseUrl);
    cookies = jar.map((c: any) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
    await page.goto(cfg.baseUrl + "/my/", { waitUntil: "domcontentloaded" }).catch(() => {});
    // Evaluated in the browser (passed as a string to avoid DOM types in Node).
    const info: any = await page.evaluate(
      "(() => {" +
        "var M = window.M;" +
        "var sk = M && M.cfg && M.cfg.sesskey;" +
        "var a = document.querySelector('a[href*=\"/user/profile.php?id=\"]');" +
        "var idm = a ? (a.href.match(/id=(\\d+)/) || [])[1] : null;" +
        "var nameEl = document.querySelector('[data-region=\"user-menu-fullname\"], .usermenu .usertext, .userbutton .usertext');" +
        "return { sesskey: sk, userid: idm, fullname: nameEl ? (nameEl.textContent || '').trim() : null };" +
      "})()"
    );
    sesskey = info.sesskey || undefined;
    userid = info.userid ? parseInt(info.userid, 10) : undefined;
    fullname = info.fullname || undefined;
    const html = await page.content();
    const um = html.match(/"username"\s*:\s*"([^"]+)"/);
    if (um) username = um[1];
  } catch (e) {
    debug("capture failed", String(e));
  }

  await context.close();

  let session: Session;
  if (capturedTokenUrl && !opts.cookieMode) {
    const dec = decodeTokenUrl(capturedTokenUrl, cfg, passport);
    note("Captured a long-lived web-service token" + (dec.verified ? " (verified)." : "."));
    session = {
      mode: "token",
      token: dec.token,
      privatetoken: dec.privatetoken,
      cookies,
      sesskey,
      userid,
      username,
      fullname,
      capturedAt: new Date().toISOString(),
    };
  } else {
    if (!cookies.length || !sesskey) {
      throw new Error("Login did not complete cleanly (no session cookie captured). Re-run: lmc login");
    }
    note("Saved the session (cookie mode — this site has web services disabled).");
    session = {
      mode: "cookie",
      cookies,
      sesskey,
      userid,
      username,
      fullname,
      capturedAt: new Date().toISOString(),
    };
  }
  saveSession(session);
  saveConfig(cfg);
  return session;
}

/**
 * Open a real browser already authenticated as the saved session — the escape
 * hatch for JS-only / real-time widgets (live quizzes, H5P, BigBlueButton, JS
 * drag-drop questions) that HTTP primitives can't replay. Injects the stored
 * cookies into a fresh browser and navigates; keeps the window open until Ctrl-C.
 */
export async function authedBrowser(
  cfg: SiteConfig,
  session: Session,
  wantedUrl: string,
  opts: { browser?: BrowserName } = {}
): Promise<void> {
  const pw = loadPlaywright();
  if (!pw) throw new Error("Playwright is not installed (npm install in the CLI dir).");
  ensureChromium(pw);
  const order = opts.browser && opts.browser !== "auto" ? [opts.browser] : ["chrome", "msedge", "chromium"];
  let browser: any;
  let lastErr: unknown;
  for (const ch of order) {
    try {
      browser = await pw.chromium.launch({
        channel: ch === "chromium" ? undefined : ch,
        headless: false,
        args: ["--no-first-run", "--no-default-browser-check"],
      });
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!browser) throw new Error("Could not launch a browser: " + String(lastErr));
  const context = await browser.newContext({ userAgent: REAL_UA });
  const cookies = (session.cookies || []).map((c) => ({ name: c.name, value: c.value, url: cfg.baseUrl }));
  if (cookies.length) await context.addCookies(cookies as any);
  const page = await context.newPage();
  const url = wantedUrl.startsWith("http")
    ? wantedUrl
    : cfg.baseUrl + (wantedUrl.startsWith("/") ? "" : "/") + wantedUrl;
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  note("Authenticated browser open at: " + url);
  note("It shares your lmc session (no re-login). Press Ctrl-C here to close it.");
  await new Promise(() => {}); // keep the process (and window) alive until Ctrl-C
}

/** No-browser login: user pastes the captured `moodlemobile://token=…` URL. */
export function pasteLogin(cfg: SiteConfig, pasted: string): Session {
  const dec = decodeTokenUrl(pasted, cfg);
  const session: Session = {
    mode: "token",
    token: dec.token,
    privatetoken: dec.privatetoken,
    capturedAt: new Date().toISOString(),
  };
  saveSession(session);
  return session;
}

/** Directly set a token (e.g. one created in Moodle → Preferences → Security keys). */
export function tokenLogin(cfg: SiteConfig, token: string): Session {
  const session: Session = {
    mode: "token",
    token: token.trim(),
    capturedAt: new Date().toISOString(),
  };
  saveSession(session);
  return session;
}
