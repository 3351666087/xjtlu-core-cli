import { SiteConfig, Session, saveSession } from "./config";
import { debug } from "./output";

/** Thrown when the token/cookie is no longer valid — the caller should re-login. */
export class AuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AuthError";
  }
}

/** A Moodle web-service error (function-level, not an auth problem). */
export class WSError extends Error {
  errorcode?: string;
  debuginfo?: string;
  constructor(msg: string, errorcode?: string, debuginfo?: string) {
    super(msg);
    this.name = "WSError";
    this.errorcode = errorcode;
    this.debuginfo = debuginfo;
  }
}

// Error codes that mean "your login is dead, re-authenticate".
// NOTE: `servicenotavailable` is deliberately NOT here — on this site (web
// services disabled) it simply means the function is not reachable over the
// AJAX transport, not that the session expired.
const AUTH_DEAD_CODES = new Set([
  "invalidtoken",
  "invalidlogin",
  "requireloginerror",
  "servicerequireslogin",
  "sessionerroruser",
  "sessiontimedout",
  "loggedinnot",
  "notloggedin",
]);

// Functions that exist but are not exposed over the logged-in AJAX transport.
const NOT_AJAX_CODES = new Set(["servicenotavailable"]);

let proxyInstalled = false;
function maybeInstallProxy(): void {
  if (proxyInstalled) return;
  proxyInstalled = true;
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!proxy) return;
  try {
    // undici ships with Node but is not a resolvable module unless installed;
    // this is a best-effort enhancement.
    const undici = require("undici");
    undici.setGlobalDispatcher(new undici.ProxyAgent(proxy));
    debug("using proxy", proxy);
  } catch {
    debug("HTTPS_PROXY set but 'undici' module not available; ignoring");
  }
}

/** PHP-style nested-param serialisation used by Moodle's REST endpoint. */
export function flattenParams(
  obj: unknown,
  prefix = "",
  out: Record<string, string> = {}
): Record<string, string> {
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => {
      flattenParams(v, prefix ? `${prefix}[${i}]` : String(i), out);
    });
  } else if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      flattenParams(v, prefix ? `${prefix}[${k}]` : k, out);
    }
  } else {
    // scalar
    let val: string;
    if (typeof obj === "boolean") val = obj ? "1" : "0";
    else val = String(obj);
    out[prefix] = val;
  }
  return out;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
}

export class MoodleClient {
  constructor(
    private cfg: SiteConfig,
    private session: Session | null
  ) {}

  hasSession(): boolean {
    return !!this.session;
  }

  getSession(): Session | null {
    return this.session;
  }

  baseUrl(): string {
    return this.cfg.baseUrl;
  }

  config(): SiteConfig {
    return this.cfg;
  }

  /** GET a page/endpoint with the session cookie and return its text. */
  async htmlGet(pathOrUrl: string, query?: Record<string, string | number>): Promise<string> {
    const res = await this.raw("GET", pathOrUrl, { query, redirect: "follow" });
    const t = res.text.trimStart();
    if (/\/login\/index\.php/.test(res.headers.get("x-final-url") || "") ||
        (/loginform|id="login"/i.test(res.text) && !/M\.cfg/.test(res.text))) {
      throw new AuthError("Session expired (redirected to login). Run: lmc login");
    }
    void t;
    return res.text;
  }

  private cookieHeader(): string | undefined {
    const s = this.session;
    if (s?.cookies && s.cookies.length) {
      return s.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    }
    if (s?.cookie) {
      const name = s.cookieName || "MoodleSession";
      return `${name}=${s.cookie}`;
    }
    return undefined;
  }

  /** Low-level authenticated HTTP request against the site. */
  async raw(
    method: string,
    pathOrUrl: string,
    opts: {
      query?: Record<string, string | number | undefined>;
      body?: string | URLSearchParams;
      headers?: Record<string, string>;
      redirect?: "follow" | "manual";
      useCookie?: boolean;
    } = {}
  ): Promise<RawResponse> {
    maybeInstallProxy();
    let url = /^https?:\/\//.test(pathOrUrl)
      ? pathOrUrl
      : this.cfg.baseUrl + (pathOrUrl.startsWith("/") ? "" : "/") + pathOrUrl;
    if (opts.query) {
      const u = new URL(url);
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) u.searchParams.set(k, String(v));
      }
      url = u.toString();
    }
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    if (opts.useCookie !== false) {
      const ch = this.cookieHeader();
      if (ch) headers["Cookie"] = ch;
    }
    debug("HTTP", method, url);
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body,
      redirect: opts.redirect || "follow",
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  }

  /** Fetch raw bytes (for file downloads) with the session cookie. */
  async bytes(pathOrUrl: string): Promise<{ status: number; buf: Buffer; contentType: string | null }> {
    maybeInstallProxy();
    const url = /^https?:\/\//.test(pathOrUrl)
      ? pathOrUrl
      : this.cfg.baseUrl + (pathOrUrl.startsWith("/") ? "" : "/") + pathOrUrl;
    const headers: Record<string, string> = {};
    const ch = this.cookieHeader();
    if (ch) headers["Cookie"] = ch;
    const res = await fetch(url, { headers, redirect: "follow" });
    const ab = await res.arrayBuffer();
    return { status: res.status, buf: Buffer.from(ab), contentType: res.headers.get("content-type") };
  }

  /**
   * Call a Moodle external (web-service) function by name.
   * Uses the REST token transport when we have a token, otherwise the
   * logged-in AJAX transport (lib/ajax/service.php) with the session cookie.
   */
  async call<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.session) throw new AuthError("Not logged in. Run: lmc login");
    if (this.session.mode === "token" && this.session.token) {
      return this.callRest<T>(fn, args);
    }
    return this.callAjax<T>(fn, args);
  }

  private async callRest<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const params = flattenParams(args);
    const body = new URLSearchParams({
      wstoken: this.session!.token!,
      wsfunction: fn,
      moodlewsrestformat: "json",
      ...params,
    });
    const res = await this.raw("POST", "/webservice/rest/server.php", {
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      useCookie: false,
    });
    let json: any;
    try {
      json = res.text ? JSON.parse(res.text) : null;
    } catch {
      throw new WSError(
        `Unexpected non-JSON response (HTTP ${res.status})`,
        undefined,
        res.text.slice(0, 300)
      );
    }
    if (json && typeof json === "object" && json.exception) {
      this.throwForMoodleError(json.errorcode, json.message, json.debuginfo);
    }
    return json as T;
  }

  private async callAjax<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    if (!this.session?.sesskey) {
      await this.refreshSesskey();
    }
    const attempt = async (): Promise<T> => {
      const res = await this.raw("POST", "/lib/ajax/service.php", {
        query: { sesskey: this.session!.sesskey, info: fn },
        body: JSON.stringify([{ index: 0, methodname: fn, args }]),
        headers: { "Content-Type": "application/json" },
      });
      // A login redirect returns HTML, not JSON.
      const trimmed = res.text.trimStart();
      if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
        throw new AuthError(
          "Session appears to have expired (got a login page). Run: lmc login"
        );
      }
      const json = JSON.parse(res.text);
      const item = Array.isArray(json) ? json[0] : json;
      if (item && item.error) {
        const ex = item.exception || {};
        this.throwForMoodleError(ex.errorcode, ex.message || item.error, ex.debuginfo);
      }
      return (item ? item.data : null) as T;
    };
    try {
      return await attempt();
    } catch (e) {
      if (e instanceof WSError && e.errorcode === "invalidsesskey") {
        debug("invalidsesskey — refreshing sesskey and retrying");
        await this.refreshSesskey();
        return attempt();
      }
      throw e;
    }
  }

  private throwForMoodleError(
    errorcode: string | undefined,
    message: string | undefined,
    debuginfo?: string
  ): never {
    const code = errorcode || "";
    if (AUTH_DEAD_CODES.has(code)) {
      throw new AuthError(
        `${message || "Authentication failed"} [${code}]. Run: lmc login`
      );
    }
    if (NOT_AJAX_CODES.has(code)) {
      throw new WSError(
        "This function is not reachable over the site's logged-in AJAX transport " +
          "(web services are disabled on this Moodle). Use a page-based command or " +
          "'lmc api GET <path>' instead.",
        code,
        debuginfo
      );
    }
    throw new WSError(message || "Web service error", code, debuginfo);
  }

  /** Re-scrape the sesskey from a logged-in page (cookie mode only). */
  async refreshSesskey(): Promise<void> {
    if (!this.session) throw new AuthError("Not logged in. Run: lmc login");
    const res = await this.raw("GET", "/my/", { redirect: "follow" });
    // Landed on the login page? cookie is dead.
    if (/\/login\/index\.php/.test(res.headers.get("x-final-url") || "") ||
        /id="login"|loginform|Log in to/i.test(res.text) && !/M\.cfg/.test(res.text)) {
      throw new AuthError("Session cookie expired. Run: lmc login");
    }
    const m =
      res.text.match(/"sesskey":"([^"]+)"/) ||
      res.text.match(/name="sesskey"\s+value="([^"]+)"/) ||
      res.text.match(/sesskey=([A-Za-z0-9]+)/);
    if (!m) {
      throw new AuthError(
        "Could not read a sesskey (session may be dead). Run: lmc login"
      );
    }
    this.session.sesskey = m[1];
    saveSession(this.session);
    debug("refreshed sesskey");
  }

  /** Convenience: pull core_webservice_get_site_info. */
  async siteInfo(): Promise<any> {
    return this.call("core_webservice_get_site_info", {});
  }
}
