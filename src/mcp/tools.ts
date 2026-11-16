import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "../store/db.ts";
import type { DozzleClient } from "../dozzle/client.ts";
import type { Config } from "../config.ts";
import type { Alerts } from "../alerts.ts";

export interface ToolContext {
  db: Db;
  config: Config;
  clients: Map<string, DozzleClient>;
  alerts: Alerts;
  /** Dispatcher id of our own webhook in each Dozzle instance (created at startup). */
  dispatcherId: (instanceId: string) => Promise<number>;
  now?: () => number;
}

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): Text => ({ content: [{ type: "text", text }] });
const fail = (text: string): Text => ({ content: [{ type: "text", text }], isError: true });

const H = 3_600_000;

/** Parse an ISO date or relative "2h"/"30m"/"3d" into epoch ms. */
export function parseTime(v: string | undefined, now: number): number | undefined {
  if (!v) return undefined;
  const m = v.match(/^(\d+(?:\.\d+)?)\s*([smhd])$/);
  if (m) return now - Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as "s"]!;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

function fmtTime(ms: number, tz: string): string {
  return new Date(ms).toLocaleString("sv-SE", { timeZone: tz, hour12: false }).replace(" ", " ");
}

function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? "-" : `${n.toFixed(n >= 10 ? 0 : 1)}%`;
}

interface ContainerRow {
  instance_id: string;
  id: string;
  host: string;
  name: string;
  image: string;
  state: string;
  health: string | null;
  last_seen: number;
}

/** Resolve a container by name (exact, then prefix, then substring), newest first. */
export function resolveContainer(db: Db, name: string, opts: { instanceId?: string; hostName?: string } = {}): ContainerRow[] {
  const hostIds = opts.hostName ? hostIdsByName(db, opts.hostName) : undefined;
  const filt = (rows: ContainerRow[]) =>
    rows.filter((r) => (!opts.instanceId || r.instance_id === opts.instanceId) && (!hostIds || hostIds.includes(r.host)));
  const q = (where: string, arg: string) =>
    filt(db.prepare(`SELECT instance_id,id,host,name,image,state,health,last_seen FROM containers WHERE ${where} ORDER BY (state='running') DESC, last_seen DESC`).all(arg) as unknown as ContainerRow[]);
  let rows = q("name = ?", name);
  if (!rows.length) rows = q("id LIKE ?", `${name}%`);
  if (!rows.length) rows = q("name LIKE ?", `${name}%`);
  if (!rows.length) rows = q("name LIKE ?", `%${name}%`);
  // One row per (host, name): the newest id wins (a recreated container keeps its name).
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.instance_id}/${r.host}/${r.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function hostIdsByName(db: Db, name: string): string[] {
  const rows = db.prepare("SELECT id FROM hosts WHERE name = ? OR id = ? OR name LIKE ?").all(name, name, `%${name}%`) as { id: string }[];
  return rows.map((r) => r.id);
}

function hostName(db: Db, instanceId: string, id: string | null): string {
  if (!id) return "-";
  const r = db.prepare("SELECT name FROM hosts WHERE instance_id=? AND id=?").get(instanceId, id) as { name: string } | undefined;
  return r?.name ?? id.slice(0, 8);
}

function one(db: Db, name: string, ctx: ToolContext, opts: { instanceId?: string; hostName?: string } = {}): ContainerRow | string {
  const rows = resolveContainer(db, name, opts);
  if (!rows.length) return `No container matches "${name}". Use rpc_find_containers to list them.`;
  const exact = rows.filter((r) => r.name === name);
  const pool = exact.length ? exact : rows;
  if (pool.length > 1) {
    return `"${name}" is ambiguous (${pool.length} containers):\n${pool
      .slice(0, 10)
      .map((r) => `- ${r.name} on ${hostName(db, r.instance_id, r.host)} (${r.state}, id ${r.id.slice(0, 12)})`)
      .join("\n")}\nPass host_name to pick one.`;
  }
  if (!ctx.clients.get(pool[0]!.instance_id)) return `Instance ${pool[0]!.instance_id} is not configured.`;
  return pool[0]!;
}

const containerArg = z.string().describe("Container name (exact, prefix or substring) or id prefix.");
const hostArg = z.string().optional().describe("Host name (as shown by rpc_list_hosts) to disambiguate.");
const instanceArg = z.string().optional().describe("instance_id from list_dozzle_instances; defaults to all / the first.");

export interface ToolRegistry {
  names: string[];
  /** Run a tool in-process with the same argument validation (and defaults) as over MCP. */
  run: (name: string, args: Record<string, unknown>) => Promise<Text>;
}

export function registerTools(server: McpServer, ctx: ToolContext): ToolRegistry {
  const { db, config } = ctx;
  const tz = config.timezone;
  const now = () => (ctx.now ? ctx.now() : Date.now());
  const names: string[] = [];
  const local = new Map<string, (args: Record<string, unknown>) => Promise<Text>>();
  const reg = <S extends z.ZodRawShape>(name: string, description: string, shape: S, handler: (a: z.infer<z.ZodObject<S>>) => Promise<Text> | Text, destructive = false) => {
    names.push(name);
    const schema = z.object(shape);
    local.set(name, async (args) => {
      try {
        return await handler(schema.parse(args) as z.infer<z.ZodObject<S>>);
      } catch (e) {
        return fail(`${name} failed: ${(e as Error).message}`);
      }
    });
    server.registerTool(
      name,
      { description, inputSchema: shape, annotations: { readOnlyHint: !destructive, destructiveHint: destructive } },
      (async (args: z.infer<z.ZodObject<S>>) => {
        try {
          return await handler(args);
        } catch (e) {
          return fail(`${name} failed: ${(e as Error).message}`);
        }
      }) as never,
    );
  };
  const firstClient = (instanceId?: string) => {
    const c = instanceId ? ctx.clients.get(instanceId) : [...ctx.clients.values()][0];
    if (!c) throw new Error(`unknown instance_id ${instanceId}`);
    return c;
  };
  const actionGuard = () => (config.allowActions ? undefined : fail("Actions are disabled on this server (ALLOW_ACTIONS=false)."));

  // ───────────────────────── History ─────────────────────────

  reg(
    "history_get_events",
    "Get stored container lifecycle events (start, die, destroy, rename, pause, unpause, health_status). Unlike Dozzle Cloud, every container is recorded, no subscription needed. This is the tool for \"when did X go offline / stop / die / restart\": the answer is an event row with a timestamp. Call it with just container_name and let the default window (7 days) work. Optional filters: after/before (ISO or relative like 6h, 2d), host_name, level (info|warning|error), event_name.",
    {
      container_name: z.string().optional(),
      host_name: hostArg,
      level: z.enum(["info", "warning", "error"]).optional(),
      event_name: z.string().optional(),
      after: z.string().optional(),
      before: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
    (a) => {
      const t = now();
      const from = parseTime(a.after, t) ?? t - 168 * H;
      const to = parseTime(a.before, t) ?? t + 60_000;
      const where = ["ts >= ?", "ts <= ?"];
      const args: (string | number)[] = [from, to];
      if (a.container_name) {
        const ids = resolveContainer(db, a.container_name, { hostName: a.host_name }).map((r) => r.name);
        where.push(`(container_name IN (${ids.map(() => "?").join(",") || "''"}) OR container_name LIKE ?)`);
        args.push(...ids, `%${a.container_name}%`);
      }
      if (a.host_name) {
        const hs = hostIdsByName(db, a.host_name);
        where.push(`host IN (${hs.map(() => "?").join(",") || "''"})`);
        args.push(...hs);
      }
      if (a.level) (where.push("level = ?"), args.push(a.level));
      if (a.event_name) (where.push("name = ?"), args.push(a.event_name));
      const rows = db
        .prepare(`SELECT ts,instance_id,host,container_name,name,level,detail FROM events WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`)
        .all(...args, a.limit) as { ts: number; instance_id: string; host: string; container_name: string; name: string; level: string; detail: string | null }[];
      if (!rows.length) return ok(`No events between ${fmtTime(from, tz)} and ${fmtTime(Math.min(to, t), tz)}${a.container_name ? ` for "${a.container_name}"` : ""}.`);
      return ok(
        `${rows.length} event(s), newest first:\n` +
          rows.map((r) => `${fmtTime(r.ts, tz)}  ${r.level.padEnd(7)} ${r.name.padEnd(13)} ${r.container_name ?? "?"} @ ${hostName(db, r.instance_id, r.host)}${r.detail ? "  " + r.detail : ""}`).join("\n"),
      );
    },
  );

  reg(
    "metrics_container_stats",
    "Actual container resource usage — CPU, memory, network and disk — sampled every second by Dozzle and stored in 30 s buckets for every container, whether or not anything alerted. Use for 'which container uses the most CPU/memory', 'how much memory does X use', 'is anything maxed out'. One line per container: average and peak CPU, average and peak memory (bytes and % of limit), average network and disk throughput over the window. Defaults to the last hour, all containers, ranked by CPU. Retention is RETENTION_DAYS (default 30).",
    {
      window_hours: z.number().min(0.05).max(24 * 90).default(1),
      container_name: z.string().optional(),
      host_name: hostArg,
      sort_by: z.enum(["cpu", "memory", "network", "disk"]).default("cpu"),
      limit: z.number().int().min(1).max(500).default(30),
    },
    (a) => {
      const t = now();
      const from = t - a.window_hours * H;
      const where = ["ts >= ?"];
      const args: (string | number)[] = [from];
      if (a.container_name) (where.push("container_name LIKE ?"), args.push(`%${a.container_name}%`));
      if (a.host_name) {
        const hs = hostIdsByName(db, a.host_name);
        where.push(`host IN (${hs.map(() => "?").join(",") || "''"})`);
        args.push(...hs);
      }
      const order = { cpu: "cpu_avg", memory: "mem_avg", network: "net", disk: "disk" }[a.sort_by];
      const rows = db
        .prepare(
          `SELECT instance_id, host, container_name AS name,
             sum(cpu_avg*samples)/sum(samples) AS cpu_avg, max(cpu_max) AS cpu_max,
             sum(mem_avg*samples)/sum(samples) AS mem_avg, max(mem_max) AS mem_max,
             sum(mem_pct_avg*samples)/sum(samples) AS pct_avg, max(mem_pct_max) AS pct_max,
             avg(net_rx_bps)+avg(net_tx_bps) AS net, avg(disk_r_bps)+avg(disk_w_bps) AS disk, count(*) AS buckets
           FROM metrics WHERE ${where.join(" AND ")}
           GROUP BY instance_id, host, container_name ORDER BY ${order} DESC LIMIT ?`,
        )
        .all(...args, a.limit) as Record<string, number & string>[];
      if (!rows.length) return ok(`No metrics in the last ${a.window_hours} h. The collector may have just started.`);
      return ok(
        `Last ${a.window_hours} h, ranked by ${a.sort_by} (CPU % is of one core; memory % is of the container limit or host memory):\n` +
          rows
            .map(
              (r) =>
                `${String(r.name)} @ ${hostName(db, r.instance_id, r.host)} — CPU avg ${pct(r.cpu_avg)} peak ${pct(r.cpu_max)} · mem avg ${fmtBytes(r.mem_avg)} (${pct(r.pct_avg)}) peak ${fmtBytes(r.mem_max)} (${pct(r.pct_max)}) · net ${fmtBytes(r.net)}/s · disk ${fmtBytes(r.disk)}/s`,
            )
            .join("\n"),
      );
    },
  );

  reg(
    "metrics_container_timeseries",
    "Resource usage over time for one container, as a short table of timestamped points. Use when the question is about SHAPE rather than level — 'when did it spike', 'has memory been climbing', 'did CPU jump before the restart'. Ask metrics_container_stats first if you don't know which container to look at. Returns about 40 points across the window with both the average and the peak in each bucket, so a real spike survives the downsampling.",
    { container_name: containerArg, host_name: hostArg, window_hours: z.number().min(0.1).max(24 * 90).default(6), points: z.number().int().min(5).max(200).default(40) },
    (a) => {
      const c = one(db, a.container_name, ctx, { hostName: a.host_name });
      if (typeof c === "string") return fail(c);
      const t = now();
      const from = t - a.window_hours * H;
      const step = Math.max(30_000, Math.ceil((a.window_hours * H) / a.points / 30_000) * 30_000);
      const rows = db
        .prepare(
          `SELECT CAST(ts / ? AS INTEGER) * ? AS b, avg(cpu_avg) cpu, max(cpu_max) cpu_pk, avg(mem_avg) mem, max(mem_max) mem_pk, avg(mem_pct_avg) pct
           FROM metrics WHERE instance_id=? AND host=? AND container_name=? AND ts >= ? GROUP BY b ORDER BY b`,
        )
        .all(step, step, c.instance_id, c.host, c.name, from) as { b: number; cpu: number; cpu_pk: number; mem: number; mem_pk: number; pct: number }[];
      if (!rows.length) return ok(`No metrics for ${c.name} in the last ${a.window_hours} h.`);
      return ok(
        `${c.name} @ ${hostName(db, c.instance_id, c.host)}, ${rows.length} points, step ${Math.round(step / 60000)} min:\ntime                 cpu_avg cpu_peak  mem_avg    mem_peak   mem%\n` +
          rows.map((r) => `${fmtTime(r.b, tz)}  ${pct(r.cpu).padStart(7)} ${pct(r.cpu_pk).padStart(8)}  ${fmtBytes(r.mem).padStart(9)}  ${fmtBytes(r.mem_pk).padStart(9)}  ${pct(r.pct)}`).join("\n"),
      );
    },
  );

  reg(
    "history_get_alerts",
    "Get stored alerts with summaries — log, container-event and CPU/memory threshold alerts alike. Each row has a Status: 'sent' means a notification actually went out; 'suppressed (held back)' / 'suppressed (rolled into prior incident)' means triage silenced the batch as duplicate noise. Sent rows also show 'follow-up batches absorbed'. Use status='suppressed' for 'which alerts were silenced today'. Optional: after/before (ISO or relative), source (rule name), level, status.",
    {
      after: z.string().optional(),
      before: z.string().optional(),
      source: z.string().optional(),
      level: z.string().optional(),
      status: z.enum(["sent", "suppressed", "muted"]).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    },
    (a) => {
      const t = now();
      const rows = ctx.alerts.list({ from: parseTime(a.after, t) ?? t - 168 * H, to: parseTime(a.before, t) ?? t + 60_000, source: a.source, level: a.level, status: a.status, limit: a.limit });
      if (!rows.length) return ok("No alerts in this window.");
      return ok(
        rows
          .map((r) => {
            const st = r.status === "suppressed" ? `suppressed (${r.suppressed_reason ?? "held back"})` : r.status;
            return `[alert #${r.id}] ${fmtTime(r.ts, tz)} · ${r.level} · ${r.kind} · ${r.source}\n  ${r.title ?? ""}\n  Status: ${st}${r.status === "sent" && r.absorbed ? ` · follow-up batches absorbed: ${r.absorbed}` : ""} · events: ${r.event_count}\n  Container: ${r.container_name ?? "-"}${r.summary ? `\n  ${r.summary}` : ""}`;
          })
          .join("\n\n"),
      );
    },
  );

  reg(
    "history_get_findings",
    "Get the findings of the scheduled log review — problems found by reading the logs, including ones that never raised an alert. Each has a severity, the containers involved, a status (open/ongoing = still happening, resolved = no longer seen), days open, a headline, why it matters and a suggested fix. Use for 'what did the review find', 'is anything still open', 'is the problem with X still happening'. Unresolved first, newest first.",
    { status: z.enum(["open", "ongoing", "resolved", "unresolved", "all"]).default("all"), include_ignored: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(50) },
    (a) => {
      const where: string[] = [];
      if (a.status === "unresolved") where.push("status IN ('open','ongoing')");
      else if (a.status !== "all") where.push(`status = '${a.status}'`);
      if (!a.include_ignored) where.push("ignored = 0");
      const rows = db
        .prepare(`SELECT * FROM findings ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY (status='resolved'), updated DESC LIMIT ?`)
        .all(a.limit) as Record<string, string & number>[];
      if (!rows.length) return ok("No findings. The log review has nothing open." + (config.llm ? "" : " (No LLM configured: LLM_BASE_URL is unset, so the review does not run.)"));
      const t = now();
      return ok(
        rows
          .map(
            (r) =>
              `[finding #${r.id}] ${String(r.severity).toUpperCase()} · ${r.status}${r.ignored ? " · ignored" : ""} · open ${Math.max(0, Math.floor(((r.resolved_at ?? t) - r.created) / 864e5))} day(s)\n  ${r.headline}\n  Containers: ${JSON.parse(String(r.containers)).join(", ")}${r.why ? `\n  Why it matters: ${r.why}` : ""}${r.fix ? `\n  Suggested fix: ${r.fix}` : ""}`,
          )
          .join("\n\n"),
      );
    },
  );

  reg(
    "ignore_finding",
    "Ignore one finding from the log review, by the [finding #N] id from history_get_findings: it stays tracked but is no longer reported. ignored=false brings it back. Call it only when the user asks, in their own words, to ignore, dismiss, hide or stop being told about a specific finding, or says yes to your offer to.",
    { finding_id: z.number().int(), ignored: z.boolean().default(true) },
    (a) => {
      const r = db.prepare("UPDATE findings SET ignored=?, updated=? WHERE id=?").run(a.ignored ? 1 : 0, now(), a.finding_id);
      return r.changes ? ok(`Finding #${a.finding_id} ${a.ignored ? "ignored" : "restored"}.`) : fail(`No finding #${a.finding_id}.`);
    },
    true,
  );

  reg(
    "mute_pattern",
    "Mute future alerts like a given alert: its log pattern(s), and the same kind of problem on the same container (e.g. every CPU reading of that container, not just the one value). Identify the alert by the [alert #N] id from history_get_alerts. ALWAYS state the exact pattern you are about to mute and get the user's explicit confirmation BEFORE calling this — muting is durable until undone and could hide a real future failure.",
    { alert_id: z.number().int() },
    (a) => {
      const m = ctx.alerts.mute(a.alert_id);
      return m ? ok(`Muted alerts like #${a.alert_id}: ${m.kind} on ${m.container_name ?? "any container"}, patterns ${m.patterns}.`) : fail(`No alert #${a.alert_id}.`);
    },
    true,
  );

  reg("list_mute_rules", "List the currently active mute rules — the patterns whose alerts are being suppressed. Use this to show what's muted before muting or unmuting.", {}, () => {
    const rows = db.prepare("SELECT * FROM mute_rules WHERE active=1 ORDER BY created DESC").all() as Record<string, string & number>[];
    if (!rows.length) return ok("No active mute rules.");
    return ok(rows.map((r) => `from [alert #${r.alert_id}] · ${fmtTime(r.created, tz)} · ${r.kind} on ${r.container_name ?? "any container"} · patterns ${r.patterns}`).join("\n"));
  });

  reg(
    "unmute_pattern",
    "Undo a mute created from an alert, so alerts matching its pattern(s) resume. Identify the alert by the [alert #N] id from history_get_alerts.",
    { alert_id: z.number().int() },
    (a) => {
      const r = db.prepare("UPDATE mute_rules SET active=0 WHERE alert_id=? AND active=1").run(a.alert_id);
      return r.changes ? ok(`Unmuted alerts like #${a.alert_id}.`) : fail(`No active mute from alert #${a.alert_id}.`);
    },
    true,
  );

  reg(
    "history_container_changes",
    "What changed, and how it went: every container image change, config change (compose config hash), exit and OOM kill recorded in the window (default 168 h / 7 days), newest first, with whether the update was made through Dozzle or outside it. With container_name set it returns that container's timeline, oldest first, so you can answer from the order of events: what changed just before the trouble started. Call it with container_name first for 'why did X break?', 'what happened to X?', 'when did X start failing?'.",
    { container_name: z.string().optional(), host_name: hostArg, window_hours: z.number().min(1).max(24 * 90).default(168) },
    (a) => {
      const from = now() - a.window_hours * H;
      if (a.container_name) {
        const rows = db
          .prepare("SELECT * FROM changes WHERE ts >= ? AND container_name LIKE ? ORDER BY ts ASC")
          .all(from, `%${a.container_name}%`) as Record<string, string & number>[];
        const ev = db
          .prepare("SELECT ts,name,level,detail,container_name FROM events WHERE ts >= ? AND container_name LIKE ? AND name IN ('start','die','health_status') ORDER BY ts ASC")
          .all(from, `%${a.container_name}%`) as Record<string, string & number>[];
        const line = [
          ...rows.map((r) => ({ ts: r.ts, s: `${r.kind}${r.origin ? ` (${r.origin === "dozzle" ? "made in Dozzle" : "made outside Dozzle"})` : ""}: ${r.before ? `${r.before} → ${r.after}` : (r.detail ?? "")}` })),
          ...ev.map((e) => ({ ts: e.ts, s: `${e.name}${e.detail ? " " + e.detail : ""}` })),
        ].sort((x, y) => x.ts - y.ts);
        if (!line.length) return ok(`Nothing recorded for "${a.container_name}" in the last ${a.window_hours} h.`);
        return ok(`Timeline of ${a.container_name}, oldest first:\n` + foldExits(line).map((l) => `${fmtTime(l.ts, tz)}  ${l.s}`).join("\n"));
      }
      const rows = db.prepare("SELECT * FROM changes WHERE ts >= ? AND kind IN ('image','config') ORDER BY ts DESC LIMIT 200").all(from) as Record<string, string & number>[];
      if (!rows.length) return ok(`No image or config change in the last ${a.window_hours} h.`);
      return ok(rows.map((r) => `${fmtTime(r.ts, tz)}  ${r.container_name} @ ${hostName(db, String(r.instance_id), r.host)} · ${r.kind} (${r.origin === "dozzle" ? "made in Dozzle" : "made outside Dozzle"}) ${r.before} → ${r.after}`).join("\n"));
    },
  );

  reg(
    "search_logs",
    "Search container log lines live through Dozzle (no log copy is kept: Dozzle reads Docker's own logs). Full-text/regex query, time window, host, container and level filters are optional. **When the user names a container, pass it via container_name — DO NOT put it in query (query searches log message bodies).** Without container_name, searches running containers (capped by max_containers). Do not bisect time windows to find WHEN something happened — get the timing from history_get_events, then come back once for the logs around it.",
    {
      query: z.string().optional().describe("Regex or plain text matched against log messages."),
      container_name: z.string().optional(),
      host_name: hostArg,
      level: z.array(z.enum(["trace", "debug", "info", "warn", "error", "fatal", "unknown"])).optional(),
      after: z.string().optional().describe("ISO or relative (default 1h)."),
      before: z.string().optional(),
      limit: z.number().int().min(1).max(1000).default(100),
      max_containers: z.number().int().min(1).max(400).default(60),
    },
    async (a) => {
      const t = now();
      const from = new Date(parseTime(a.after, t) ?? t - H);
      const to = a.before ? new Date(parseTime(a.before, t)!) : undefined;
      let targets: ContainerRow[];
      if (a.container_name) targets = resolveContainer(db, a.container_name, { hostName: a.host_name });
      else {
        const hs = a.host_name ? hostIdsByName(db, a.host_name) : undefined;
        targets = (db.prepare("SELECT instance_id,id,host,name,image,state,health,last_seen FROM containers WHERE state='running' ORDER BY last_seen DESC").all() as unknown as ContainerRow[]).filter(
          (r) => !hs || hs.includes(r.host),
        );
      }
      if (!targets.length) return fail(`No container matches "${a.container_name ?? a.host_name}".`);
      const capped = targets.slice(0, a.max_containers);
      const found: { ts: number; s: string }[] = [];
      const errors: string[] = [];
      await mapLimit(capped, 8, async (c) => {
        const cl = ctx.clients.get(c.instance_id);
        if (!cl) return;
        try {
          const lines = await cl.containerLines({ host: c.host, id: c.id, from, to, query: a.query, levels: a.level, limit: a.limit });
          for (const l of lines) found.push({ ts: l.ts, s: `${Number.isFinite(l.ts) ? fmtTime(l.ts, tz) : "-"}  ${l.level.padEnd(7)} ${c.name}  ${l.message}` });
        } catch (e) {
          errors.push(`${c.name}: ${(e as Error).message.slice(0, 120)}`);
        }
      });
      found.sort((x, y) => x.ts - y.ts);
      const note =
        (targets.length > capped.length ? `\n(searched ${capped.length} of ${targets.length} containers; raise max_containers or pass container_name/host_name)` : "") +
        (errors.length ? `\n(unreadable: ${errors.slice(0, 5).join("; ")})` : "");
      if (!found.length) return ok(`No log line matched between ${fmtTime(from.getTime(), tz)} and ${fmtTime((to ?? new Date(t)).getTime(), tz)}.${note}`);
      return ok(found.slice(-a.limit).map((f) => f.s).join("\n") + note);
    },
  );

  reg("list_dozzle_instances", "List the Dozzle instances this server reports on: instance_id (pass back as instance_id to the notification tools), display name, URL and Dozzle version. Instance-scoped tools apply to the whole Dozzle deployment, not a single Docker host.", {}, async () => {
    const lines: string[] = [];
    for (const c of ctx.clients.values()) {
      let v = "unreachable";
      try {
        v = await c.version();
      } catch {
        /* keep */
      }
      const hosts = (db.prepare("SELECT count(*) n FROM hosts WHERE instance_id=?").get(c.id) as { n: number }).n;
      const conts = (db.prepare("SELECT count(*) n FROM containers WHERE instance_id=? AND last_seen > ?").get(c.id, now() - 86_400_000) as { n: number }).n;
      lines.push(`${c.id} · ${c.instance.name} · ${c.instance.url} · Dozzle ${v} · ${hosts} hosts · ${conts} containers`);
    }
    return ok(lines.join("\n"));
  });

  // ───────────────────────── RPC (live) ─────────────────────────

  reg(
    "rpc_check_image_updates",
    "Check which containers run an outdated image: asks each image's registry whether its tag now points to a newer image than the one the container runs. Use for 'what needs updating' or 'is X up to date'. Updating is a separate step: call rpc_update_container only after the user confirms which containers to update.",
    { container_name: z.string().optional(), host_name: hostArg, instance_id: instanceArg, force: z.boolean().default(false) },
    async (a) => {
      if (a.container_name) {
        const c = one(db, a.container_name, ctx, { hostName: a.host_name, instanceId: a.instance_id });
        if (typeof c === "string") return fail(c);
        return ok(`${c.name}: ${JSON.stringify(await ctx.clients.get(c.instance_id)!.imageCheck(c.host, c.id, a.force))}`);
      }
      const res = await firstClient(a.instance_id).imageCheck(undefined, undefined, a.force);
      return ok(summarizeImageCheck(db, res));
    },
  );

  const createRule = (kind: "event" | "log" | "metric") => async (a: { name?: string; container_expression: string; expression: string; cooldown?: number; sample_window?: number; instance_id?: string }) => {
    const g = actionGuard();
    if (g) return g;
    const cl = firstClient(a.instance_id);
    const dispatcherId = await ctx.dispatcherId(cl.id);
    const rule = await cl.createRule({
      name: a.name ?? `${kind} alert · ${a.container_expression}`.slice(0, 80),
      enabled: true,
      dispatcherId,
      containerExpression: a.container_expression,
      logExpression: kind === "log" ? a.expression : "",
      metricExpression: kind === "metric" ? a.expression : undefined,
      eventExpression: kind === "event" ? a.expression : undefined,
      cooldown: a.cooldown,
      sampleWindow: a.sample_window,
    });
    return ok(`Created ${kind} alert #${rule.id} "${rule.name}" on ${cl.id}, delivered to dozzle-reporting.`);
  };
  const ruleShape = (exprDoc: string) => ({
    name: z.string().optional(),
    container_expression: z.string().describe('expr-lang over the container, e.g. name contains "db" or true for all.'),
    expression: z.string().describe(exprDoc),
    cooldown: z.number().int().optional().describe("Minimum seconds between notifications for the same container."),
    sample_window: z.number().int().optional().describe("Metric rules: seconds of samples to evaluate (default 15)."),
    instance_id: instanceArg,
  });
  reg(
    "rpc_create_event_notification",
    "Create an alert that fires on container lifecycle events (start, stop, die, oom, health_status…). Needs a container_expression selecting which containers to watch and an event expression, e.g. name == \"die\" && attributes[\"exitCode\"] != \"0\". Alerts land in dozzle-reporting (history_get_alerts) and its notification channels.",
    ruleShape('expr-lang over the event: name, attributes["exitCode"], attributes["healthStatus"].'),
    createRule("event"),
    true,
  );
  reg(
    "rpc_create_log_notification",
    "Create an alert that fires when a container log line matches a filter. Needs a container_expression and a log expression, e.g. level == \"error\" or message contains \"panic\".",
    ruleShape("expr-lang over the log line: level, message, stream."),
    createRule("log"),
    true,
  );
  reg(
    "rpc_create_metric_notification",
    "Create an alert that fires when container CPU/memory usage crosses a threshold. Needs a container_expression and a metric expression, e.g. cpu >= 90 or memory >= 85.",
    ruleShape("expr-lang over stats: cpu, memory (percent), mounts[].usedPercent."),
    createRule("metric"),
    true,
  );

  reg(
    "rpc_find_containers",
    "List or search Docker containers across all hosts. With no filters it returns EVERY container, including stopped and exited ones; filter by name, image, state or health. Returns id, name, image, state, health, host and start time.",
    { name: z.string().optional(), image: z.string().optional(), state: z.string().optional(), health: z.string().optional(), host_name: hostArg, limit: z.number().int().min(1).max(1000).default(200) },
    async (a) => {
      // Live snapshot from each instance, so the answer is current even if the collector lags.
      const out: string[] = [];
      for (const cl of ctx.clients.values()) {
        const hosts = new Map((await cl.hosts()).map((h) => [h.id, h.name]));
        for (const c of await cl.containers()) {
          if (a.name && !c.name.includes(a.name)) continue;
          if (a.image && !c.image.includes(a.image)) continue;
          if (a.state && c.state !== a.state) continue;
          if (a.health && c.health !== a.health) continue;
          const hn = hosts.get(c.host) ?? c.host;
          if (a.host_name && hn !== a.host_name && c.host !== a.host_name) continue;
          out.push(`${c.id.slice(0, 12)}  ${c.name}  ${c.image}  ${c.state}${c.health ? "/" + c.health : ""}  ${hn}  started ${c.startedAt ?? "-"}`);
        }
      }
      return ok(out.length ? `${out.length} container(s):\n${out.slice(0, a.limit).join("\n")}` : "No container matches.");
    },
  );

  reg(
    "rpc_get_running_container_stats",
    "Real-time CPU, memory and network usage for all running containers: current values, peaks over the last 5 minutes, and network bytes transferred in the last 5 minutes.",
    { host_name: hostArg, limit: z.number().int().min(1).max(500).default(50) },
    (a) => {
      const from = now() - 5 * 60_000;
      const hs = a.host_name ? hostIdsByName(db, a.host_name) : undefined;
      const rows = (
        db
          .prepare(
            `SELECT m.instance_id, m.host, m.container_name name,
               (SELECT cpu_avg FROM metrics x WHERE x.instance_id=m.instance_id AND x.container_id=m.container_id ORDER BY ts DESC LIMIT 1) cpu_now,
               (SELECT mem_avg FROM metrics x WHERE x.instance_id=m.instance_id AND x.container_id=m.container_id ORDER BY ts DESC LIMIT 1) mem_now,
               max(m.cpu_max) cpu_pk, max(m.mem_max) mem_pk, sum((m.net_rx_bps+m.net_tx_bps)*m.samples) net5
             FROM metrics m WHERE m.ts >= ? GROUP BY m.instance_id, m.container_id ORDER BY cpu_now DESC`,
          )
          .all(from) as Record<string, string & number>[]
      ).filter((r) => !hs || hs.includes(r.host));
      if (!rows.length) return ok("No stats in the last 5 minutes (collector starting or disconnected).");
      return ok(rows.slice(0, a.limit).map((r) => `${r.name} @ ${hostName(db, r.instance_id, r.host)} — CPU ${pct(r.cpu_now)} (5 min peak ${pct(r.cpu_pk)}) · mem ${fmtBytes(r.mem_now)} (peak ${fmtBytes(r.mem_pk)}) · net 5 min ${fmtBytes(r.net5)}`).join("\n"));
    },
  );

  reg(
    "rpc_inspect_container",
    "Detailed configuration of a Docker container: environment variables, port mappings, mounts, restart policy, network mode, labels and resource limits.",
    { container_name: containerArg, host_name: hostArg },
    async (a) => {
      const c = one(db, a.container_name, ctx, { hostName: a.host_name });
      if (typeof c === "string") return fail(c);
      return ok(JSON.stringify(await ctx.clients.get(c.instance_id)!.inspect(c.host, c.id), null, 1).slice(0, 60_000));
    },
  );

  reg("rpc_list_hosts", "List all Docker hosts connected to Dozzle with name, CPU cores, total memory, Docker version and availability.", {}, async () => {
    const out: string[] = [];
    for (const cl of ctx.clients.values())
      for (const h of await cl.hosts())
        out.push(`${h.name} (${h.id}) · ${h.nCPU ?? "?"} CPU · ${fmtBytes(h.memTotal)} · Docker ${h.dockerVersion ?? "?"} · ${h.type ?? ""}${h.endpoint ? " " + h.endpoint : ""} · ${h.available === false ? "UNAVAILABLE" : "available"}${ctx.clients.size > 1 ? ` · instance ${cl.id}` : ""}`);
    return ok(out.join("\n"));
  });

  reg(
    "rpc_list_notifications",
    "List configured alert rules on a Dozzle instance (with trigger counts and destination). Use this to check whether an alert already exists before creating one.",
    { instance_id: instanceArg },
    async (a) => {
      const rules = await firstClient(a.instance_id).listRules();
      if (!rules.length) return ok("No alert rules.");
      return ok(
        rules
          .map((r) => `#${r.id} ${r.enabled ? "on " : "off"} ${r.name} → ${r.dispatcher?.name ?? "?"} (${r.dispatcher?.type ?? "?"})\n  containers: ${r.containerExpression}${r.logExpression ? `\n  log: ${r.logExpression}` : ""}${r.eventExpression ? `\n  event: ${r.eventExpression}` : ""}${r.metricExpression ? `\n  metric: ${r.metricExpression}` : ""}\n  triggered ${r.triggerCount}× on ${r.triggeredContainers} container(s), last ${r.lastTriggeredAt ?? "never"}`)
          .join("\n"),
      );
    },
  );

  const act = (action: "start" | "stop" | "restart" | "remove") => async (a: { container_name: string; host_name?: string }) => {
    const g = actionGuard();
    if (g) return g;
    const c = one(db, a.container_name, ctx, { hostName: a.host_name });
    if (typeof c === "string") return fail(c);
    await ctx.clients.get(c.instance_id)!.action(c.host, c.id, action);
    return ok(`${action} sent to ${c.name} on ${hostName(db, c.instance_id, c.host)}.`);
  };
  reg("rpc_remove_container", "Remove a Docker container. It must be stopped first — call rpc_stop_container if it is still running. Confirm with the user before removing: the container is gone permanently.", { container_name: containerArg, host_name: hostArg }, act("remove"), true);
  reg("rpc_restart_container", "Restart a Docker container.", { container_name: containerArg, host_name: hostArg }, act("restart"), true);
  reg(
    "rpc_rollback_container",
    "Roll a container back to the image it ran before its last update. NOT AVAILABLE with a self-hosted Dozzle: rollback exists only on Dozzle Cloud's agent channel, not in Dozzle's local HTTP API. Returns the previous image recorded by history so it can be redeployed by hand.",
    { container_name: containerArg, host_name: hostArg },
    (a) => {
      const prev = db.prepare("SELECT ts, before, after FROM changes WHERE container_name=? AND kind='image' ORDER BY ts DESC LIMIT 1").get(a.container_name) as { ts: number; before: string; after: string } | undefined;
      return fail(
        `Rollback is not exposed by Dozzle's local API, so this server cannot perform it.${prev ? ` Last recorded image change of ${a.container_name} at ${fmtTime(prev.ts, tz)}: ${prev.before} → ${prev.after}. Redeploy the previous image with your compose file.` : ` No image change recorded for ${a.container_name}.`}`,
      );
    },
    true,
  );
  reg("rpc_start_container", "Start a stopped Docker container.", { container_name: containerArg, host_name: hostArg }, act("start"), true);
  reg("rpc_stop_container", "Stop a running Docker container.", { container_name: containerArg, host_name: hostArg }, act("stop"), true);
  reg(
    "rpc_update_container",
    "Update a Docker container by pulling the latest version of its image and recreating it with the same configuration. If the image is already up to date, no recreation occurs. A stopped container is never updated: start it first. Confirm with the user first.",
    { container_name: containerArg, host_name: hostArg },
    async (a) => {
      const g = actionGuard();
      if (g) return g;
      const c = one(db, a.container_name, ctx, { hostName: a.host_name });
      if (typeof c === "string") return fail(c);
      const res = await ctx.clients.get(c.instance_id)!.update(c.host, c.id);
      db.prepare("INSERT INTO changes(ts,instance_id,host,container_id,container_name,kind,origin,before,after,detail) VALUES(?,?,?,?,?,?,?,?,?,?)").run(
        now(),
        c.instance_id,
        c.host,
        c.id,
        c.name,
        "update-request",
        "dozzle",
        c.image,
        null,
        "update requested through dozzle-reporting",
      );
      return ok(`Update of ${c.name}: ${res.slice(-2000) || "done"}`);
    },
    true,
  );

  return {
    names,
    run: async (name, args) => {
      const f = local.get(name);
      if (!f) return fail(`no tool ${name}`);
      return f(args);
    },
  };
}

export async function mapLimit<T>(xs: T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (i < xs.length) await f(xs[i++]!);
    }),
  );
}

/** Fold crash loops: consecutive identical "die" rows become one row with a count. */
function foldExits(lines: { ts: number; s: string }[]): { ts: number; s: string }[] {
  const out: { ts: number; s: string; n?: number }[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev && l.s.startsWith("die") && prev.s.replace(/ \(×\d+\)$/, "") === l.s) {
      prev.n = (prev.n ?? 1) + 1;
      prev.s = `${l.s} (×${prev.n})`;
    } else out.push({ ...l });
  }
  return out;
}

function summarizeImageCheck(db: Db, res: unknown): string {
  if (!Array.isArray(res)) return JSON.stringify(res).slice(0, 20_000);
  const by = new Map<string, string[]>();
  for (const r of res as Record<string, unknown>[]) {
    const status = String(r["status"] ?? (r["hasUpdate"] ? "update-available" : "unknown"));
    const name = String(r["name"] ?? r["containerName"] ?? r["id"] ?? "?");
    by.set(status, [...(by.get(status) ?? []), name]);
  }
  void db;
  return [...by.entries()].map(([s, ns]) => `${s} (${ns.length}): ${ns.slice(0, 50).join(", ")}${ns.length > 50 ? "…" : ""}`).join("\n");
}
