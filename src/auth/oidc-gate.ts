/**
 * OIDC gate for the web UI (Authorization Code + PKCE, openid-client), plus an optional
 * break-glass password login for when the identity provider itself is the outage.
 * Works with any OIDC provider; tested against Authentik.
 *
 * Session: a signed (HMAC-SHA256) cookie holding only the identity, never a token.
 *
 * Break-glass rules, all cumulative (same contract as the homelab's Python oidc_gate):
 *  1. disabled while OIDC_BREAKGLASS_HASH is empty (format scrypt:n:r:p:salt_b64url:key_b64url);
 *  2. only while the provider's discovery does not answer within 3 s (OIDC_BREAKGLASS_MODE=idp-down),
 *     or always (OIDC_BREAKGLASS_MODE=always, to set by hand during an incident);
 *  3. only from OIDC_BREAKGLASS_CIDRS (default 100.64.0.0/10, a tailnet), with the client IP read
 *     from X-Forwarded-For ONLY when the direct peer is in OIDC_TRUSTED_PROXIES; refuses to start
 *     if a CIDR covers an address listed in OIDC_BREAKGLASS_FORBIDDEN_IPS (e.g. your WAN edge);
 *  4. 5 failures per IP per 15 min, 20 in total, then 429;
 *  5. every success and failure is logged and POSTed to OIDC_BREAKGLASS_ALERT_URL.
 * A break-glass session lasts OIDC_BREAKGLASS_MAX_AGE seconds (default 3600) and is flagged.
 */
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as oidc from "openid-client";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

export interface User {
  sub: string;
  name: string;
  email?: string;
  groups: string[];
  breakglass?: boolean;
  exp: number;
}

export interface GateConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  publicUrl: string; // e.g. https://dozzle.example.com
  basePath: string; // e.g. /reporting
  requireGroup?: string;
  sessionMaxAge: number;
  breakglass: {
    hash?: string;
    user: string;
    mode: "idp-down" | "always";
    cidrs: Cidr[];
    trustedProxies: Cidr[];
    maxAge: number;
    alertUrl?: string;
  };
}

// ───────────── CIDR helpers (IPv4 + IPv6) ─────────────

export interface Cidr {
  v6: boolean;
  net: bigint;
  bits: number;
}

function ipToBig(ip: string): { v6: boolean; n: bigint } | undefined {
  ip = ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const p = ip.split(".").map(Number);
    if (p.some((x) => x > 255)) return undefined;
    return { v6: false, n: BigInt(((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!) };
  }
  if (!ip.includes(":")) return undefined;
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = ip.includes("::") ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(fill).fill("0"), ...t];
  if (parts.length !== 8) return undefined;
  return { v6: true, n: parts.reduce((a, x) => (a << 16n) + BigInt(parseInt(x || "0", 16)), 0n) };
}

export function parseCidrs(s: string): Cidr[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((c) => {
      const [ip, b] = c.split("/");
      const a = ipToBig(ip!);
      if (!a) throw new Error(`invalid CIDR ${c}`);
      const bits = b === undefined ? (a.v6 ? 128 : 32) : Number(b);
      const width = a.v6 ? 128 : 32;
      const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(width - bits);
      return { v6: a.v6, net: a.n & mask, bits };
    });
}

export function inCidrs(ip: string, cidrs: Cidr[]): boolean {
  const a = ipToBig(ip);
  if (!a) return false;
  return cidrs.some((c) => {
    if (c.v6 !== a.v6) return false;
    const width = c.v6 ? 128 : 32;
    const mask = c.bits === 0 ? 0n : ((1n << BigInt(c.bits)) - 1n) << BigInt(width - c.bits);
    return (a.n & mask) === c.net;
  });
}

/** Client IP: X-Forwarded-For is believed only from a trusted proxy, walking right to left. */
export function clientIp(req: IncomingMessage, trusted: Cidr[]): string {
  let ip = req.socket.remoteAddress ?? "";
  const xff = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  while (inCidrs(ip, trusted) && xff.length) ip = xff.pop()!;
  return ip.replace(/^::ffff:/, "");
}

// ───────────── signed cookies ─────────────

function b64u(b: Buffer): string {
  return b.toString("base64url");
}

export function sign(secret: string, payload: object): string {
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  const mac = b64u(createHmac("sha256", secret).update(body).digest());
  return `${body}.${mac}`;
}

export function unsign<T>(secret: string, v: string | undefined): T | undefined {
  if (!v) return undefined;
  const [body, mac] = v.split(".");
  if (!body || !mac) return undefined;
  const want = createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString()) as T;
  } catch {
    return undefined;
  }
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  const m = String(req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]!) : undefined;
}

// ───────────── break-glass hash + limiter ─────────────

export async function hashBreakglass(password: string, n = 2 ** 15, r = 8, p = 1): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, { N: n, r, p, maxmem: 2 ** 26 });
  return `scrypt:${n}:${r}:${p}:${b64u(salt)}:${b64u(key)}`;
}

export async function verifyBreakglass(password: string, h: string): Promise<boolean> {
  const parts = h.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") throw new Error("OIDC_BREAKGLASS_HASH unreadable (expected scrypt:n:r:p:salt:key)");
  const [, n, r, p, s, k] = parts;
  const key = Buffer.from(k!, "base64url");
  const got = await scrypt(password, Buffer.from(s!, "base64url"), key.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 2 ** 26 });
  return got.length === key.length && timingSafeEqual(got, key);
}

export class Limiter {
  private fails: { t: number; ip: string }[] = [];
  private readonly perIp: number;
  private readonly total: number;
  private readonly windowMs: number;
  constructor(perIp = 5, total = 20, windowMs = 900_000) {
    this.perIp = perIp;
    this.total = total;
    this.windowMs = windowMs;
  }
  blocked(ip: string, now = Date.now()): boolean {
    this.fails = this.fails.filter((f) => now - f.t < this.windowMs);
    return this.fails.length >= this.total || this.fails.filter((f) => f.ip === ip).length >= this.perIp;
  }
  fail(ip: string, now = Date.now()): void {
    this.fails.push({ t: now, ip });
  }
}

// ───────────── the gate ─────────────

const COOKIE = "dzr_session";
const FLOW = "dzr_flow";

export function configFromEnv(publicUrl: string, basePath: string): GateConfig | undefined {
  const issuer = process.env["OIDC_ISSUER"];
  if (!issuer) return undefined;
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is required when OIDC_ISSUER is set`);
    return v;
  };
  const cfg: GateConfig = {
    issuer,
    clientId: need("OIDC_CLIENT_ID"),
    clientSecret: need("OIDC_CLIENT_SECRET"),
    sessionSecret: need("SESSION_SECRET"),
    publicUrl,
    basePath,
    requireGroup: process.env["OIDC_REQUIRE_GROUP"] || undefined,
    sessionMaxAge: Number(process.env["SESSION_MAX_AGE"] ?? 8 * 3600),
    breakglass: {
      hash: process.env["OIDC_BREAKGLASS_HASH"]?.trim() || undefined,
      user: process.env["OIDC_BREAKGLASS_USER"] ?? "secours",
      mode: (process.env["OIDC_BREAKGLASS_MODE"] ?? "idp-down") as "idp-down" | "always",
      cidrs: parseCidrs(process.env["OIDC_BREAKGLASS_CIDRS"] ?? "100.64.0.0/10"),
      trustedProxies: parseCidrs(process.env["OIDC_TRUSTED_PROXIES"] ?? "127.0.0.1/32,::1/128"),
      maxAge: Number(process.env["OIDC_BREAKGLASS_MAX_AGE"] ?? 3600),
      alertUrl: process.env["OIDC_BREAKGLASS_ALERT_URL"] || undefined,
    },
  };
  if (!["idp-down", "always"].includes(cfg.breakglass.mode)) throw new Error(`invalid OIDC_BREAKGLASS_MODE ${cfg.breakglass.mode}`);
  for (const ip of (process.env["OIDC_BREAKGLASS_FORBIDDEN_IPS"] ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    if (inCidrs(ip, cfg.breakglass.cidrs)) throw new Error(`OIDC_BREAKGLASS_CIDRS covers ${ip} (forbidden: it would open break-glass to the Internet)`);
  }
  if (cfg.sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return cfg;
}

export class OidcGate {
  private conf?: oidc.Configuration;
  private confAt = 0;
  private readonly limiter = new Limiter();
  readonly cfg: GateConfig;
  private readonly log: (m: string) => void;

  constructor(cfg: GateConfig, log: (m: string) => void) {
    this.cfg = cfg;
    this.log = log;
  }

  private get callbackUrl(): string {
    return `${this.cfg.publicUrl}${this.cfg.basePath}/auth/callback`;
  }

  /** Provider configuration, cached 10 min; undefined when discovery fails within the timeout. */
  private async provider(timeoutMs = 3000): Promise<oidc.Configuration | undefined> {
    if (this.conf && Date.now() - this.confAt < 600_000) return this.conf;
    try {
      this.conf = await oidc.discovery(new URL(this.cfg.issuer), this.cfg.clientId, this.cfg.clientSecret, undefined, { timeout: timeoutMs / 1000 });
      this.confAt = Date.now();
      return this.conf;
    } catch (e) {
      this.log(`oidc discovery failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** Identity of the request, or undefined. */
  user(req: IncomingMessage): User | undefined {
    const u = unsign<User>(this.cfg.sessionSecret, cookie(req, COOKIE));
    return u && u.exp > Date.now() / 1000 ? u : undefined;
  }

  private setCookie(res: ServerResponse, name: string, value: string, maxAge: number): void {
    const prev = res.getHeader("Set-Cookie");
    const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
    list.push(`${name}=${encodeURIComponent(value)}; Path=${this.cfg.basePath || "/"}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
    res.setHeader("Set-Cookie", list);
  }

  private redirect(res: ServerResponse, to: string): void {
    res.writeHead(302, { Location: to, "Cache-Control": "no-store" });
    res.end();
  }

  /**
   * Handle /auth/* routes. Returns true when the request was answered.
   * `sub` is the path below basePath.
   */
  async handle(req: IncomingMessage, res: ServerResponse, sub: string, url: URL): Promise<boolean> {
    const b = this.cfg.basePath;
    if (sub === "/auth/login") {
      const next = safeNext(url.searchParams.get("next"), b);
      const conf = await this.provider();
      if (!conf) {
        if (this.breakglassAllowed(req)) return this.redirect(res, `${b}/auth/breakglass?next=${encodeURIComponent(next)}`), true;
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Identity provider unreachable.");
        return true;
      }
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      this.setCookie(res, FLOW, sign(this.cfg.sessionSecret, { verifier, state, nonce, next, exp: Date.now() / 1000 + 600 }), 600);
      const to = oidc.buildAuthorizationUrl(conf, {
        redirect_uri: this.callbackUrl,
        scope: "openid profile email groups",
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
        nonce,
      });
      this.redirect(res, to.href);
      return true;
    }
    if (sub === "/auth/callback") {
      const flow = unsign<{ verifier: string; state: string; nonce: string; next: string; exp: number }>(this.cfg.sessionSecret, cookie(req, FLOW));
      const conf = await this.provider();
      if (!flow || flow.exp < Date.now() / 1000 || !conf) return this.redirect(res, `${b}/auth/login`), true;
      try {
        const cur = new URL(`${this.callbackUrl}${url.search}`);
        const tokens = await oidc.authorizationCodeGrant(conf, cur, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce });
        const c = tokens.claims() ?? ({} as Record<string, unknown>);
        const groups = Array.isArray(c["groups"]) ? (c["groups"] as string[]) : [];
        if (this.cfg.requireGroup && !groups.includes(this.cfg.requireGroup)) {
          this.log(`oidc: ${String(c["preferred_username"] ?? c["sub"])} refused (not in ${this.cfg.requireGroup})`);
          res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Forbidden: your account is not allowed to use this application.");
          return true;
        }
        const user: User = {
          sub: String(c["sub"]),
          name: String(c["preferred_username"] ?? c["name"] ?? c["email"] ?? c["sub"]),
          email: c["email"] ? String(c["email"]) : undefined,
          groups,
          exp: Math.floor(Date.now() / 1000) + this.cfg.sessionMaxAge,
        };
        this.setCookie(res, FLOW, "", 0);
        this.setCookie(res, COOKIE, sign(this.cfg.sessionSecret, user), this.cfg.sessionMaxAge);
        this.redirect(res, flow.next);
      } catch (e) {
        this.log(`oidc callback failed: ${(e as Error).message}`);
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Login failed. Retry from the start.");
      }
      return true;
    }
    if (sub === "/auth/logout") {
      this.setCookie(res, COOKIE, "", 0);
      const conf = this.conf;
      const end = conf?.serverMetadata().end_session_endpoint;
      this.redirect(res, end ? oidc.buildEndSessionUrl(conf!, { post_logout_redirect_uri: `${this.cfg.publicUrl}${b}/` }).href : `${b}/`);
      return true;
    }
    if (sub === "/auth/breakglass") {
      if (!this.breakglassAllowed(req) || !(this.cfg.breakglass.mode === "always" || !(await this.provider()))) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return true;
      }
      const ip = clientIp(req, this.cfg.breakglass.trustedProxies);
      const next = safeNext(url.searchParams.get("next"), b);
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(breakglassForm("", next));
        return true;
      }
      if (this.limiter.blocked(ip)) {
        res.writeHead(429, { "Content-Type": "text/plain" });
        res.end("too many attempts");
        return true;
      }
      const form = new URLSearchParams(await readBody(req));
      const okUser = form.get("username") === this.cfg.breakglass.user;
      const okPass = okUser && (await verifyBreakglass(form.get("password") ?? "", this.cfg.breakglass.hash!));
      if (!okPass) {
        this.limiter.fail(ip);
        void this.alert("Break-glass login FAILED", `dozzle-reporting: failed break-glass login from ${ip}`);
        res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
        res.end(breakglassForm("Refusé · Denied", next));
        return true;
      }
      void this.alert("Break-glass login used", `dozzle-reporting: break-glass session opened from ${ip}`);
      const user: User = { sub: "breakglass", name: this.cfg.breakglass.user, groups: [], breakglass: true, exp: Math.floor(Date.now() / 1000) + this.cfg.breakglass.maxAge };
      this.setCookie(res, COOKIE, sign(this.cfg.sessionSecret, user), this.cfg.breakglass.maxAge);
      this.redirect(res, next);
      return true;
    }
    return false;
  }

  private breakglassAllowed(req: IncomingMessage): boolean {
    if (!this.cfg.breakglass.hash) return false;
    return inCidrs(clientIp(req, this.cfg.breakglass.trustedProxies), this.cfg.breakglass.cidrs);
  }

  private async alert(title: string, message: string): Promise<void> {
    this.log(`${title}: ${message}`);
    if (!this.cfg.breakglass.alertUrl) return;
    try {
      await fetch(this.cfg.breakglass.alertUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: "security", title, message }), signal: AbortSignal.timeout(5000) });
    } catch (e) {
      this.log(`break-glass alert not delivered: ${(e as Error).message}`);
    }
  }
}

function safeNext(n: string | null, base: string): string {
  // Only same-site relative paths under the app: no open redirect.
  if (n && n.startsWith(base || "/") && !n.startsWith("//") && !n.includes("\\")) return n;
  return `${base}/`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    n += c.length;
    if (n > 10_000) break;
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString();
}

function breakglassForm(err: string, next: string): string {
  const e = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Porte de secours · Break-glass</title>
<style>body{font:15px system-ui;max-width:360px;margin:12vh auto;padding:0 16px}input,button{display:block;width:100%;margin:8px 0;padding:8px;font:inherit}.b{background:#b91c1c;color:#fff;padding:8px;border-radius:6px}</style></head>
<body><p class="b">Porte de secours — le fournisseur d'identité est injoignable. Chaque tentative est signalée.<br>Break-glass — the identity provider is down. Every attempt is reported.</p>
${err ? `<p style="color:#b91c1c">${e(err)}</p>` : ""}<form method="post"><input type="hidden" name="next" value="${e(next)}">
<input name="username" autocomplete="username" placeholder="user" required><input name="password" type="password" autocomplete="current-password" placeholder="password" required><button>OK</button></form></body></html>`;
}
