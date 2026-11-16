#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, type Config } from "./config.ts";
import { openDb, prune, kvGet, kvSet, type Db } from "./store/db.ts";
import { DozzleClient } from "./dozzle/client.ts";
import { Collector } from "./collector.ts";
import { Alerts, type DozzleNotification } from "./alerts.ts";
import { registerTools, type ToolContext, type ToolRegistry } from "./mcp/tools.ts";
import * as ui from "./web/ui.ts";
import type { PageCtx } from "./web/ui.ts";
import { pickLang } from "./web/i18n.ts";

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
  const clients = new Map(cfg.instances.map((i) => [i.id, new DozzleClient(i)]));
  const webhookUrl = (process.env["WEBHOOK_BASE_URL"] ?? `http://localhost:${cfg.port}`).replace(/\/$/, "");

  const alerts = new Alerts(db, {
    onSent: async (a) => {
      log(`alert #${a.id} sent: ${a.title}`);
      await notify(a.title ?? "alert", a.summary ?? a.sample ?? "");
    },
  });

  const ctx: ToolContext = {
    db,
    config: cfg,
    clients,
    alerts,
    dispatcherId: (id) => ensureDispatcher(db, cfg, clients.get(id)!, webhookUrl),
  };

  const collectors = [...clients.values()].map((c) => new Collector(db, c, { bucketSeconds: cfg.bucketSeconds, log }));
  for (const c of collectors) void c.run();
  setInterval(() => prune(db, cfg.retentionDays), 3_600_000).unref();

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    try {
      if (path === "/healthz") {
        const up = collectors.every((c) => c.connected);
        return send(res, up ? 200 : 503, JSON.stringify({ ok: up, collectors: collectors.length, version: VERSION }), "application/json");
      }

      if (path === "/mcp" || path === `${cfg.basePath}/mcp`) {
        if (cfg.mcpToken && !safeEq(bearer(req) ?? "", cfg.mcpToken)) return send(res, 401, "unauthorized");
        if (req.method !== "POST") return send(res, 405, "method not allowed");
        const body = JSON.parse(await readBody(req));
        // Stateless: a fresh server + transport per request.
        const { server } = buildToolServer(ctx);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
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

      if (req.method === "GET" && (path === cfg.basePath || path.startsWith(cfg.basePath + "/") || (cfg.basePath === "" && !path.startsWith("/hooks")))) {
        const sub = path.slice(cfg.basePath.length).replace(/\/$/, "");
        const userHeader = process.env["TRUST_USER_HEADER"];
        const user = userHeader ? (req.headers[userHeader.toLowerCase()] as string | undefined) : undefined;
        if (process.env["REQUIRE_USER_HEADER"] === "true" && !user) return send(res, 401, "unauthorized");
        const pc: PageCtx = {
          db,
          config: cfg,
          lang: pickLang(req.headers.cookie, req.headers["accept-language"]),
          user,
          now: Date.now(),
          query: url.searchParams,
        };
        let html: string | undefined;
        const m = sub.match(/^\/metrics\/([^/]+)\/([^/]+)\/([^/]+)$/);
        if (sub === "") html = ui.overview(pc);
        else if (sub === "/findings") html = ui.findings(pc);
        else if (sub === "/updates") html = ui.updates(pc);
        else if (sub === "/alerts") html = ui.alertsPage(pc, "alerts");
        else if (sub === "/alerts/events") html = ui.alertsPage(pc, "events");
        else if (sub === "/alerts/muted") html = ui.alertsPage(pc, "muted");
        else if (sub === "/metrics") html = ui.metricsPage(pc);
        else if (m) html = ui.metricDetail(pc, decodeURIComponent(m[1]!), decodeURIComponent(m[2]!), decodeURIComponent(m[3]!));
        else if (sub === "/logs") {
          let result: string | undefined;
          const q = url.searchParams;
          if (q.get("q") || q.get("container")) {
            const r = await callTool(ctx, "search_logs", {
              query: q.get("q") || undefined,
              container_name: q.get("container") || undefined,
              after: q.get("after") || "1h",
              limit: 300,
            });
            result = r;
          }
          html = ui.logsPage(pc, result);
        } else if (sub === "/instances") {
          const versions = new Map<string, string>();
          await Promise.all([...clients.values()].map(async (c) => versions.set(c.id, await c.version().catch(() => ""))));
          for (const [k, v] of versions) if (!v) versions.delete(k);
          html = ui.instancesPage(pc, versions);
        } else if (sub === "/integrations") html = ui.integrationsPage(pc);
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

/** Optional push: NOTIFY_URL receives a POST (ntfy-compatible: Title header, text body). */
async function notify(title: string, body: string): Promise<void> {
  const url = process.env["NOTIFY_URL"];
  if (!url) return;
  try {
    const headers: Record<string, string> = { Title: title.slice(0, 200).replace(/[^\x20-\x7e]/g, "?") };
    if (process.env["NOTIFY_TOKEN"]) headers["Authorization"] = `Bearer ${process.env["NOTIFY_TOKEN"]}`;
    await fetch(url, { method: "POST", body: body.slice(0, 4000), headers });
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
