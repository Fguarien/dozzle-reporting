#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, type Config } from "./config.ts";
import { openDb, prune, kvGet, kvSet, seedSnapshots, type Db } from "./store/db.ts";
import { DozzleClient } from "./dozzle/client.ts";
import { Collector } from "./collector.ts";
import { Alerts, type DozzleNotification } from "./alerts.ts";
import { registerTools, type ToolContext, type ToolRegistry } from "./mcp/tools.ts";
import * as ui from "./web/ui.ts";
import type { PageCtx } from "./web/ui.ts";
import { pickLang } from "./web/i18n.ts";
import { configFromEnv, OidcGate } from "./auth/oidc-gate.ts";
import { reviewLogs, summarizeAlert, askAbout } from "./llm/review.ts";
import { fetchLogs } from "./web/logfetch.ts";
import { createToken, findToken, listTokens, recordCall, revokeToken, toolOf } from "./mcp/tokens.ts";
import { clearMute, isMuted, muteDeadline, muteUntil, setMuteUntil } from "./notify/mute.ts";
import { digestText } from "./notify/digest.ts";
import { sendMail } from "./notify/smtp.ts";

/** Run one MCP tool in-process (the UI reuses the tools so both answer the same way). */
async function callTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<string> {
  const { registry } = buildToolServer(ctx);
  const r = await registry.run(name, args);
  return r.content.map((c) => c.text).join("\n");
}

export const VERSION = "0.1.0";

function log(m: string): void {
  process.stdout.write(`${new Date().toISOString()} ${m}\n`);
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  return typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7) : undefined;
}

async function readBody(req: IncomingMessage, max = 2_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    n += c.length;
    if (n > max) throw new Error("body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

/** Make sure each Dozzle instance has a webhook dispatcher pointing at us; cache its id. */
async function ensureDispatcher(db: Db, cfg: Config, client: DozzleClient, webhookUrl: string): Promise<number> {
  const key = `dispatcher:${client.id}`;
  const cached = kvGet(db, key);
  const list = await client.listDispatchers();
  if (cached && list.some((d) => String(d.id) === cached)) return Number(cached);
  const found = list.find((d) => d.type === "webhook" && d.name === "dozzle-reporting");
  if (found) {
    kvSet(db, key, String(found.id));
    return found.id;
  }
  const created = await client.createDispatcher({
    name: "dozzle-reporting",
    type: "webhook",
    url: `${webhookUrl}/hooks/dozzle/${encodeURIComponent(client.id)}`,
    headers: cfg.webhookSecret ? { Authorization: `Bearer ${cfg.webhookSecret}` } : undefined,
  });
  kvSet(db, key, String(created.id));
  log(`created webhook dispatcher #${created.id} in ${client.id}`);
  return created.id;
}

export function buildToolServer(ctx: ToolContext): { server: McpServer; registry: ToolRegistry } {
  const server = new McpServer({ name: "dozzle-reporting", version: VERSION }, { capabilities: { tools: {} } });
  const registry = registerTools(server, ctx);
  return { server, registry };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const seedT = Date.now();
  const seeded = seedSnapshots(db);
  log(`snapshots live=${seeded.live} roll=${seeded.roll} in ${Date.now() - seedT}ms`);
  const clients = new Map(cfg.instances.map((i) => [i.id, new DozzleClient(i)]));
  const webhookUrl = (process.env["WEBHOOK_BASE_URL"] ?? `http://localhost:${cfg.port}`).replace(/\/$/, "");

  const alerts: Alerts = new Alerts(db, {
    onSent: async (a) => {
      let title = a.title ?? "alert";
      let body = a.sample ?? "";
      if (cfg.llm) {
        try {
          const s = await summarizeAlert(cfg.llm, a);
          alerts.setSummary(a.id, s.title || null, s.summary);
          title = s.title || title;
          body = s.summary || body;
        } catch (e) {
          log(`summary of alert #${a.id} failed: ${(e as Error).message}`);
        }
      }
      log(`alert #${a.id} sent: ${title}`);
      await notify(db, cfg, title, `${body}\n\n${cfg.publicUrl}${cfg.basePath}/alerts`);
    },
  });

  // Review and the daily report share REVIEW_HOUR. Each runs once per local day.
  setInterval(() => {
    const h = Number(new Date().toLocaleString("en-GB", { timeZone: cfg.timezone, hour: "2-digit", hour12: false }));
    if (h !== cfg.reviewHour) return;
    const day = new Date().toLocaleDateString("sv-SE", { timeZone: cfg.timezone });
    if (cfg.llm && kvGet(db, "review:last") !== day) {
      kvSet(db, "review:last", day);
      reviewLogs(db, cfg, clients, log).catch((e) => log(`review failed: ${(e as Error).message}`));
    }
    if (kvGet(db, "digest:last") !== day) {
      kvSet(db, "digest:last", day);
      const lang = process.env["LLM_LANGUAGE"] === "fr" ? "fr" : "en";
      const digest = digestText(db, lang);
      if (digest) void notify(db, cfg, digest.subject, digest.text);
    }
  }, 60_000).unref();

  const ctx: ToolContext = {
    db,
    config: cfg,
    clients,
    alerts,
    dispatcherId: (id) => ensureDispatcher(db, cfg, clients.get(id)!, webhookUrl),
  };

  const bootTools = buildToolServer(ctx);
  const toolCount = bootTools.registry.names.length;
  void bootTools.server.close();
  let versionAt = 0;
  let versionMap = new Map<string, string>();
  const instanceVersions = async (): Promise<Map<string, string>> => {
    if (versionMap.size && Date.now() - versionAt < 600_000) return versionMap;
    const versions = new Map<string, string>();
    await Promise.all([...clients.values()].map(async (c) => {
      const v = await c.version().catch(() => "");
      if (v) versions.set(c.id, v);
    }));
    versionAt = Date.now();
    versionMap = versions;
    return versions;
  };

  const collectors = [...clients.values()].map((c) => new Collector(db, c, { bucketSeconds: cfg.bucketSeconds, log }));
  for (const c of collectors) void c.run();
  setInterval(() => prune(db, cfg.retentionDays), 3_600_000).unref();

  const gate = (() => {
    const g = configFromEnv(cfg.publicUrl, cfg.basePath);
    return g ? new OidcGate(g, log) : undefined;
  })();
  log(`UI auth: ${gate ? "OIDC " + gate.cfg.issuer + (gate.cfg.breakglass.hash ? " + break-glass" : "") : process.env["TRUST_USER_HEADER"] ? "proxy header " + process.env["TRUST_USER_HEADER"] : process.env["UI_AUTH"] === "none" ? "NONE (UI_AUTH=none)" : "disabled"}`);

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    try {
      if (path === "/healthz") {
        const up = collectors.every((c) => c.connected);
        return send(res, up ? 200 : 503, JSON.stringify({ ok: up, collectors: collectors.length, version: VERSION }), "application/json");
      }

      if (path === "/mcp" || path === `${cfg.basePath}/mcp`) {
        const presented = bearer(req) ?? "";
        let who: { id: number | null; name: string } | undefined;
        if (presented && cfg.mcpToken && safeEq(presented, cfg.mcpToken)) who = { id: null, name: "litellm" };
        else if (presented) who = findToken(db, presented);
        const minted = (db.prepare("SELECT count(*) n FROM api_tokens WHERE revoked=0").get() as { n: number }).n;
        if ((cfg.mcpToken || minted > 0) && !who) return send(res, 401, "unauthorized");
        if (req.method !== "POST") return send(res, 405, "method not allowed");
        const body = JSON.parse(await readBody(req));
        const t0 = Date.now();
        const { server } = buildToolServer(ctx);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
        } finally {
          if (who) recordCall(db, who, toolOf(body), Date.now() - t0);
        }
        return;
      }

      const hook = path.match(/^(?:\/reporting)?\/hooks\/dozzle\/([^/]+)$/);
      if (hook && req.method === "POST") {
        if (cfg.webhookSecret && !safeEq(bearer(req) ?? "", cfg.webhookSecret)) return send(res, 401, "unauthorized");
        const instanceId = decodeURIComponent(hook[1]!);
        if (!clients.has(instanceId)) return send(res, 404, "unknown instance");
        const n = JSON.parse(await readBody(req)) as DozzleNotification;
        const row = alerts.ingest(instanceId, n);
        return send(res, 202, JSON.stringify({ alert: row.id, status: row.status }), "application/json");
      }

      const inUi = path === cfg.basePath || path.startsWith(cfg.basePath + "/") || (cfg.basePath === "" && !path.startsWith("/hooks"));
      if (inUi) {
        const sub = path.slice(cfg.basePath.length).replace(/\/$/, "");
        // Authentication of the UI: OIDC (preferred), a trusted proxy header, or explicitly none.
        let user: string | undefined;
        let breakglass = false;
        if (gate) {
          if (sub.startsWith("/auth/")) {
            if (await gate.handle(req, res, sub, url)) return;
            return send(res, 404, "not found");
          }
          const u = gate.user(req);
          if (!u) {
            res.writeHead(302, { Location: `${cfg.basePath}/auth/login?next=${encodeURIComponent(path + url.search)}`, "Cache-Control": "no-store" });
            return res.end();
          }
          user = u.name;
          breakglass = !!u.breakglass;
        } else if (process.env["TRUST_USER_HEADER"]) {
          user = req.headers[process.env["TRUST_USER_HEADER"].toLowerCase()] as string | undefined;
          if (!user) return send(res, 401, "unauthorized");
        } else if (process.env["UI_AUTH"] !== "none") {
          return send(res, 403, "UI disabled: set OIDC_ISSUER (recommended), TRUST_USER_HEADER, or UI_AUTH=none.");
        }
        const pc: PageCtx = {
          db,
          config: cfg,
          lang: pickLang(req.headers.cookie, req.headers["accept-language"]),
          user,
          breakglass,
          now: Date.now(),
          query: url.searchParams,
        };
        const htmlOk = (html: string) => {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" });
          return res.end(html);
        };
        const seeOther = (to: string) => {
          res.writeHead(303, { Location: to, "Cache-Control": "no-store" });
          return res.end();
        };
        if (req.method === "POST") {
          const form = new URLSearchParams(await readBody(req, 32_000));
          const action = form.get("action") ?? "";
          if (sub === "/integrations") {
            if (action === "create_token") {
              try {
                kvSet(db, "token:flash", createToken(db, form.get("name") ?? "").secret);
              } catch (e) {
                kvSet(db, "token:err", (e as Error).message.slice(0, 120));
              }
              return seeOther(`${cfg.basePath}/integrations?tab=mcp`);
            }
            if (action === "revoke_token") {
              const id = Number(form.get("id"));
              if (Number.isInteger(id) && id > 0) revokeToken(db, id);
              return seeOther(`${cfg.basePath}/integrations?tab=mcp`);
            }
            if (action === "mute_for") {
              try {
                setMuteUntil(db, muteDeadline(form.get("for") ?? "", Date.now(), cfg.timezone));
              } catch {
                /* unknown span */
              }
              return seeOther(`${cfg.basePath}/integrations`);
            }
            if (action === "unmute") {
              clearMute(db);
              return seeOther(`${cfg.basePath}/integrations`);
            }
          }
          const question = form.get("q") ?? "";
          const runAsk = async (topic: string, evidence: string): Promise<{ ask?: string; notice?: string }> => {
            if (!cfg.llm) return { notice: pc.lang === "fr" ? "Demander exige LLM_BASE_URL." : "Ask needs LLM_BASE_URL." };
            try {
              return { ask: await askAbout(cfg.llm, topic, evidence, question) };
            } catch (e) {
              return { notice: (e as Error).message.slice(0, 240) };
            }
          };
          const aid = sub.match(/^\/alerts\/(\d+)$/);
          if (aid) {
            const id = Number(aid[1]);
            if (action === "fix") {
              alerts.resolve(id);
              return seeOther(`${cfg.basePath}/alerts/${id}`);
            }
            if (action === "mute") {
              alerts.mute(id);
              return seeOther(`${cfg.basePath}/alerts/${id}`);
            }
            if (action === "ask") {
              const a = alerts.get(id);
              const extra = a
                ? await runAsk(
                    `Alert #${id} ${a.title}\nContainer: ${a.container_name}\nKind: ${a.kind} · ${a.source} · ${a.status}`,
                    `${a.summary ?? ""}\n${a.sample ?? ""}`,
                  )
                : {};
              return htmlOk(ui.alertDetail(pc, id, extra));
            }
            if (action === "investigate") {
              const a = alerts.get(id);
              const key = `alert:invest:${id}`;
              if (!a) return seeOther(`${cfg.basePath}/alerts/${id}`);
              if (!cfg.llm) {
                kvSet(db, key, JSON.stringify({ error: "no-llm", at: Date.now(), checked: [] }));
                return seeOther(`${cfg.basePath}/alerts/${id}`);
              }
              let logs = "";
              if (a.container_name) {
                try {
                  const hit = await fetchLogs(db, ctx.clients, { container: a.container_name, after: "2h", levels: ["error", "warn", "fatal"], limit: 80, now: Date.now() });
                  logs = hit.rows.map((r) => `${new Date(r.ts).toISOString()} ${r.level} ${r.message}`).join("\n").slice(0, 8000);
                } catch (e) {
                  logs = (e as Error).message.slice(0, 200);
                }
              }
              const ev = (db.prepare("SELECT ts,name,detail FROM events WHERE container_name=? AND ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 15").all(a.container_name ?? "", a.ts - 15 * 60_000, (a.last_ts || a.ts) + 10 * 60_000) as { ts: number; name: string; detail: string | null }[])
                .map((e) => `${new Date(e.ts).toISOString()} ${e.name} ${(e.detail ?? "").slice(0, 180)}`)
                .join("\n");
              try {
                const text = await askAbout(
                  cfg.llm,
                  `Root cause of alert #${id} ${a.title ?? ""}\nContainer: ${a.container_name}`,
                  `Sample:\n${a.sample ?? ""}\n\nSummary:\n${a.summary ?? ""}\n\nLogs (2h):\n${logs || "(none)"}\n\nEvents:\n${ev || "(none)"}`,
                  "What is the root cause, and what should change? If the evidence is not enough, say the root cause is still unclear and name the missing piece.",
                );
                kvSet(db, key, JSON.stringify({ text, at: Date.now(), checked: ["logs", "events"] }));
              } catch (e) {
                kvSet(db, key, JSON.stringify({ error: (e as Error).message.slice(0, 240), at: Date.now(), checked: ["logs", "events"] }));
              }
              return seeOther(`${cfg.basePath}/alerts/${id}`);
            }
          }
          const fidPost = sub.match(/^\/findings\/(\d+)$/);
          if (fidPost) {
            const id = Number(fidPost[1]);
            if (action === "fix") {
              db.prepare("UPDATE findings SET status='resolved', resolved_at=? WHERE id=?").run(Date.now(), id);
              return seeOther(`${cfg.basePath}/findings/${id}`);
            }
            if (action === "ignore") {
              db.prepare("UPDATE findings SET ignored=1 WHERE id=?").run(id);
              return seeOther(`${cfg.basePath}/findings/${id}`);
            }
            if (action === "ask") {
              const f = db.prepare("SELECT * FROM findings WHERE id=?").get(id) as Record<string, string> | undefined;
              const extra = f
                ? await runAsk(`Finding #${id} ${f.headline}\nSeverity: ${f.severity}\n${f.why ?? ""}\nFix: ${f.fix ?? ""}`, String(f.containers))
                : {};
              return htmlOk(ui.findingDetail(pc, id, undefined, extra));
            }
          }
          const mid = sub.match(/^\/metrics\/([^/]+)\/([^/]+)\/([^/]+)$/);
          if (mid && action === "ask") {
            const instance = decodeURIComponent(mid[1]!), host = decodeURIComponent(mid[2]!), name = decodeURIComponent(mid[3]!);
            const extra = await runAsk(
              `Container ${name} on ${host}`,
              JSON.stringify(
                db.prepare("SELECT avg(cpu_avg) cpu, max(cpu_max) cpuPk, avg(mem_avg) mem FROM metrics WHERE instance_id=? AND host=? AND container_name=? AND ts>=?").get(instance, host, name, Date.now() - 3_600_000),
              ),
            );
            return htmlOk(ui.metricDetail(pc, instance, host, name, extra));
          }
          if (sub === "/ask" && action === "ask") {
            const alertsTxt = (db.prepare("SELECT title, container_name, status FROM alerts WHERE ts>=? AND status='sent' ORDER BY ts DESC LIMIT 12").all(Date.now() - 24 * 3_600_000) as { title: string; container_name: string; status: string }[])
              .map((a) => `- ${a.container_name}: ${a.title}`)
              .join("\n");
            const findsTxt = (db.prepare("SELECT headline, severity FROM findings WHERE status IN ('open','ongoing') AND ignored=0 ORDER BY updated DESC LIMIT 8").all() as { headline: string; severity: string }[])
              .map((f) => `- ${f.severity} ${f.headline}`)
              .join("\n");
            const extra = await runAsk("Fleet overview (last 24h alerts + open findings)", `Alerts:\n${alertsTxt}\n\nFindings:\n${findsTxt}`);
            return htmlOk(ui.askPage(pc, extra));
          }
          return send(res, 405, "method not allowed");
        }
        if (req.method !== "GET") return send(res, 405, "method not allowed");
        let html: string | undefined;
        const m = sub.match(/^\/metrics\/([^/]+)\/([^/]+)\/([^/]+)$/);
        const fid = sub.match(/^\/findings\/(\d+)$/);
        if (sub === "") html = ui.overview(pc);
        else if (sub === "/findings") html = ui.findings(pc);
        else if (fid) {
          const id = Number(fid[1]);
          const row = db.prepare("SELECT containers FROM findings WHERE id=?").get(id) as { containers: string } | undefined;
          let logs = "";
          if (row) {
            let names: string[] = [];
            try {
              names = JSON.parse(row.containers) as string[];
            } catch {
              names = [];
            }
            const chunks: string[] = [];
            for (const name of names.slice(0, 4)) {
              try {
                chunks.push(
                  await callTool(ctx, "search_logs", { container_name: name, after: "24h", limit: 40, level: ["error", "warn", "fatal"] }),
                );
              } catch {
                /* live logs optional */
              }
            }
            logs = chunks.join("\n");
          }
          html = ui.findingDetail(pc, id, logs);
        }
        else if (sub === "/updates") html = ui.updates(pc);
        else if (sub === "/alerts") html = ui.alertsPage(pc, "alerts");
        else if (sub === "/alerts/events") html = ui.alertsPage(pc, "events");
        else if (sub === "/alerts/muted") html = ui.alertsPage(pc, "muted");
        else if (/^\/alerts\/\d+$/.test(sub)) html = ui.alertDetail(pc, Number(sub.slice("/alerts/".length)));
        else if (sub === "/metrics") html = ui.metricsPage(pc);
        else if (m) html = ui.metricDetail(pc, decodeURIComponent(m[1]!), decodeURIComponent(m[2]!), decodeURIComponent(m[3]!));
        else if (sub === "/logs") {
          const q = url.searchParams;
          const parsed = ui.parseLogsql(q.get("q") ?? "");
          const container = q.get("container") || parsed.container;
          if (q.get("live") === "1") pc.refreshSec = 12;
          const t0 = Date.now();
          const after = q.get("after") || "15m";
          const fetched = await fetchLogs(db, ctx.clients, {
            query: parsed.query,
            container,
            levels: parsed.levels,
            after,
            limit: 200,
            now: Date.now(),
          });
          html = ui.logsPage(pc, { ...fetched, ms: Date.now() - t0 });
        } else if (sub === "/instances") {
          html = ui.instancesPage(pc, await instanceVersions());
        } else if (sub === "/integrations") {
          const flash = kvGet(db, "token:flash");
          const tokenError = kvGet(db, "token:err");
          if (flash) db.prepare("DELETE FROM kv WHERE k='token:flash'").run();
          if (tokenError) db.prepare("DELETE FROM kv WHERE k='token:err'").run();
          const calls = db.prepare("SELECT ts, token_name, tool, ms FROM mcp_calls ORDER BY ts DESC LIMIT 15").all() as { ts: number; token_name: string; tool: string; ms: number }[];
          html = ui.integrationsPage(pc, { freshToken: flash, tokenError, tokens: listTokens(db), calls, muteUntil: muteUntil(db), toolCount });
        }
        else if (sub === "/ask") html = ui.askPage(pc);
        if (html) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" });
          return res.end(html);
        }
      }

      return send(res, 404, "not found");
    } catch (e) {
      log(`error ${req.method} ${path}: ${(e as Error).message}`);
      if (!res.headersSent) send(res, 500, "internal error");
    }
  });

  http.listen(cfg.port, () => log(`dozzle-reporting ${VERSION} listening on :${cfg.port} (${clients.size} instance(s))`));

  const stop = () => {
    for (const c of collectors) c.stop();
    http.close();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

/** Hub POST plus optional SMTP. A global mute skips both. The URL is read here and never rendered. */
async function notify(db: Db, cfg: Config, title: string, body: string): Promise<void> {
  if (isMuted(db)) return;
  if (cfg.smtp && cfg.notifyEmail) {
    try {
      await sendMail({ host: cfg.smtp.host, port: cfg.smtp.port, from: cfg.smtp.from, to: cfg.notifyEmail, subject: title.slice(0, 200), text: body.slice(0, 4000) });
    } catch (e) {
      log(`mail failed: ${(e as Error).message}`);
    }
  }
  const url = process.env["NOTIFY_URL"];
  if (!url) return;
  try {
    const headers: Record<string, string> = {};
    if (process.env["NOTIFY_TOKEN"]) headers["Authorization"] = `Bearer ${process.env["NOTIFY_TOKEN"]}`;
    let payload: string;
    if (process.env["NOTIFY_FORMAT"] === "json") {
      // Generic JSON hook: {"channel", "title", "message"} (Discord/Slack relays, alert hubs).
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify({ channel: process.env["NOTIFY_CHANNEL"] ?? "general", title: title.slice(0, 200), message: body.slice(0, 4000) });
    } else {
      // ntfy-compatible: Title header, plain-text body.
      headers["Title"] = title.slice(0, 200).replace(/[^\x20-\x7e]/g, "?");
      payload = body.slice(0, 4000);
    }
    const r = await fetch(url, { method: "POST", body: payload, headers, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) log(`notify answered ${r.status}`);
  } catch (e) {
    log(`notify failed: ${(e as Error).message}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("dozzle-reporting")) {
  main().catch((e) => {
    log(`fatal: ${(e as Error).stack ?? e}`);
    process.exit(1);
  });
}
