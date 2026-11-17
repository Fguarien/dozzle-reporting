import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../store/db.ts";

/** sha256 hex of a bearer. Stored form only — the raw token is shown once. */
export function tokenHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface TokenRow {
  id: number;
  name: string;
  prefix: string;
  created: number;
  last_used: number | null;
  calls: number;
  revoked: number;
}

/** Mint a bearer (`dz_` + 32 url-safe bytes). Returns the secret once; only the hash is stored. */
export function createToken(db: Db, name: string, now = Date.now()): { id: number; secret: string } {
  const clean = name.trim().slice(0, 40);
  if (!/^[\w .@+-]{1,40}$/.test(clean)) throw new Error("invalid token name");
  const secret = `dz_${randomBytes(32).toString("base64url")}`;
  const prefix = secret.slice(0, 11);
  const r = db
    .prepare("INSERT INTO api_tokens(name,prefix,hash,created,calls,revoked) VALUES(?,?,?,?,0,0)")
    .run(clean, prefix, tokenHash(secret), now);
  return { id: Number(r.lastInsertRowid), secret };
}

export function revokeToken(db: Db, id: number): void {
  db.prepare("UPDATE api_tokens SET revoked=1 WHERE id=?").run(id);
}

export function listTokens(db: Db): TokenRow[] {
  return db.prepare("SELECT id,name,prefix,created,last_used,calls,revoked FROM api_tokens ORDER BY created DESC").all() as unknown as TokenRow[];
}

/** Match a presented bearer against a live token. Hash compare, then a constant-time check on the stored hex. */
export function findToken(db: Db, bearer: string): { id: number; name: string } | undefined {
  const hash = tokenHash(bearer);
  const row = db.prepare("SELECT id, name, hash FROM api_tokens WHERE hash=? AND revoked=0").get(hash) as { id: number; name: string; hash: string } | undefined;
  if (!row) return undefined;
  const a = Buffer.from(hash);
  const b = Buffer.from(row.hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return { id: row.id, name: row.name };
}

export function recordCall(db: Db, token: { id: number | null; name: string }, tool: string, ms: number, now = Date.now()): void {
  db.prepare("INSERT INTO mcp_calls(ts,token_name,tool,ms) VALUES(?,?,?,?)").run(now, token.name, tool.slice(0, 80), Math.max(0, Math.round(ms)));
  if (token.id != null) {
    db.prepare("UPDATE api_tokens SET last_used=?, calls=calls+1 WHERE id=?").run(now, token.id);
  }
}

/** Tool name from a JSON-RPC body, without arguments. */
export function toolOf(body: unknown): string {
  const one = (m: unknown): string => {
    if (!m || typeof m !== "object") return "";
    const msg = m as { method?: unknown; params?: { name?: unknown } };
    if (msg.method === "tools/call") return String(msg.params?.name ?? "tools/call");
    return typeof msg.method === "string" ? msg.method : "";
  };
  if (Array.isArray(body)) {
    const names = body.map(one).filter(Boolean);
    return names.join(",") || "batch";
  }
  return one(body) || "request";
}
