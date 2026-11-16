import type { Db } from "./store/db.ts";

/** Payload Dozzle's webhook dispatcher posts when no template is set (types.Notification). */
export interface DozzleNotification {
  id: string;
  type: "log" | "event" | "metric" | string;
  detail?: string;
  container: { id: string; name: string; image?: string; state?: string; health?: string; hostId?: string; hostName?: string };
  log?: { message: unknown; timestamp: number; level?: string; stream?: string };
  stat?: { cpu: number; memory: number; memoryUsage: number; mounts?: { destination: string; usedPercent: number }[] };
  event?: { name: string; actorId: string; attributes?: Record<string, string>; timestamp?: string };
  subscription: { id: number; name: string; logExpression?: string; metricExpression?: string; eventExpression?: string };
  timestamp: string;
}

export interface AlertRow {
  id: number;
  ts: number;
  last_ts: number;
  instance_id: string;
  source: string;
  kind: string;
  level: string;
  container_name: string | null;
  host: string | null;
  fingerprint: string;
  title: string | null;
  summary: string | null;
  status: "sent" | "suppressed" | "muted";
  suppressed_reason: string | null;
  parent_id: number | null;
  absorbed: number;
  event_count: number;
  sample: string | null;
}

export interface AlertsOptions {
  /** Notifications with the same fingerprint inside this window merge into one alert. */
  batchMs?: number;
  /** A new batch within this window of a sent alert is rolled into it instead of re-notifying. */
  incidentMs?: number;
  /** More than this many sent alerts per container per hour are held back. */
  maxPerHour?: number;
  now?: () => number;
  onSent?: (a: AlertRow) => void | Promise<void>;
}

/** Replace the variable parts of a log line so repeats of one problem share a pattern. */
export function logPattern(msg: string): string {
  return msg
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<ip>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?\b/g, "<time>")
    .replace(/\b[0-9a-f]{12,64}\b/gi, "<hex>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function messageText(m: unknown): string {
  if (typeof m === "string") return m;
  if (m && typeof m === "object") {
    const o = m as Record<string, unknown>;
    return String(o["msg"] ?? o["message"] ?? o["error"] ?? JSON.stringify(o));
  }
  return String(m ?? "");
}

export function describe(n: DozzleNotification): { kind: string; level: string; pattern: string; title: string; sample: string } {
  const c = n.container.name;
  if (n.type === "log" && n.log) {
    const text = messageText(n.log.message);
    const level = n.log.level === "fatal" || n.log.level === "error" ? "error" : n.log.level === "warn" ? "warning" : "info";
    return { kind: "log", level, pattern: logPattern(text), title: `${c}: ${text.slice(0, 140)}`, sample: text.slice(0, 2000) };
  }
  if (n.type === "event" && n.event) {
    const a = n.event.attributes ?? {};
    const code = a["exitCode"];
    const health = a["healthStatus"];
    const what = n.event.name === "die" ? `exited with code ${code ?? "?"}` : n.event.name === "oom" ? "was killed: out of memory" : health ? `became ${health}` : n.event.name;
    return { kind: "event", level: n.event.name === "oom" || (n.event.name === "die" && code !== "0") ? "error" : "warning", pattern: `${n.event.name}:${code ?? health ?? ""}`, title: `${c} ${what}`, sample: JSON.stringify(n.event) };
  }
  if (n.type === "metric" && n.stat) {
    const s = n.stat;
    const full = s.mounts?.find((m) => m.usedPercent >= 85);
    const title = full ? `${c}: volume ${full.destination} ${full.usedPercent.toFixed(0)}% full` : `${c}: CPU ${s.cpu.toFixed(0)}% · memory ${s.memory.toFixed(0)}%`;
    // Every reading of the same metric rule on the same container is the same problem.
    return { kind: "metric", level: "warning", pattern: `metric:${n.subscription.metricExpression ?? ""}`, title, sample: JSON.stringify(s) };
  }
  return { kind: n.type, level: "info", pattern: n.type, title: `${c}: ${n.detail ?? n.type}`, sample: JSON.stringify(n).slice(0, 2000) };
}

export class Alerts {
  private readonly db: Db;
  private readonly o: Required<Omit<AlertsOptions, "onSent">> & Pick<AlertsOptions, "onSent">;

  constructor(db: Db, opts: AlertsOptions = {}) {
    this.db = db;
    this.o = {
      batchMs: opts.batchMs ?? 60_000,
      incidentMs: opts.incidentMs ?? 6 * 3_600_000,
      maxPerHour: opts.maxPerHour ?? 6,
      now: opts.now ?? (() => Date.now()),
      onSent: opts.onSent,
    };
  }

  /** Record one Dozzle notification and triage it. Returns the alert row it landed in. */
  ingest(instanceId: string, n: DozzleNotification): AlertRow {
    const t = this.o.now();
    const d = describe(n);
    const fp = `${instanceId}|${n.subscription.id}|${n.container.hostId ?? ""}|${n.container.name}|${d.kind}|${d.pattern}`;

    // 1. Same problem within the batch window → same alert.
    const open = this.db.prepare("SELECT * FROM alerts WHERE fingerprint=? AND last_ts >= ? ORDER BY id DESC LIMIT 1").get(fp, t - this.o.batchMs) as AlertRow | undefined;
    if (open) {
      this.db.prepare("UPDATE alerts SET last_ts=?, event_count=event_count+1 WHERE id=?").run(t, open.id);
      return this.get(open.id)!;
    }

    const insert = (status: AlertRow["status"], reason: string | null, parent: number | null) => {
      const r = this.db
        .prepare(
          "INSERT INTO alerts(ts,last_ts,instance_id,source,kind,level,container_name,host,fingerprint,title,summary,status,suppressed_reason,parent_id,sample) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(t, t, instanceId, n.subscription.name, d.kind, d.level, n.container.name, n.container.hostName ?? n.container.hostId ?? null, fp, d.title, null, status, reason, parent, d.sample);
      return this.get(Number(r.lastInsertRowid))!;
    };

    // 2. Muted?
    if (this.isMuted(n.container.name, d.kind, d.pattern)) return insert("muted", "mute rule", null);

    // 3. A sent alert for the same problem is still the current incident → roll into it.
    const prior = this.db
      .prepare("SELECT * FROM alerts WHERE fingerprint=? AND status='sent' AND last_ts >= ? ORDER BY id DESC LIMIT 1")
      .get(fp, t - this.o.incidentMs) as AlertRow | undefined;
    if (prior) {
      this.db.prepare("UPDATE alerts SET absorbed=absorbed+1, last_ts=? WHERE id=?").run(t, prior.id);
      return insert("suppressed", "rolled into prior incident", prior.id);
    }

    // 4. Too many notifications for this container in the last hour → hold back.
    const recent = (this.db.prepare("SELECT count(*) n FROM alerts WHERE container_name=? AND status='sent' AND ts >= ?").get(n.container.name, t - 3_600_000) as { n: number }).n;
    if (recent >= this.o.maxPerHour) return insert("suppressed", "held back", null);

    const row = insert("sent", null, null);
    void this.o.onSent?.(row);
    return row;
  }

  get(id: number): AlertRow | undefined {
    return this.db.prepare("SELECT * FROM alerts WHERE id=?").get(id) as AlertRow | undefined;
  }

  setSummary(id: number, title: string | null, summary: string): void {
    this.db.prepare("UPDATE alerts SET summary=?, title=coalesce(?, title) WHERE id=?").run(summary, title, id);
  }

  list(f: { from: number; to: number; source?: string; level?: string; status?: string; limit: number }): AlertRow[] {
    const where = ["ts >= ?", "ts <= ?"];
    const args: (string | number)[] = [f.from, f.to];
    if (f.source) (where.push("source LIKE ?"), args.push(`%${f.source}%`));
    if (f.level) (where.push("level = ?"), args.push(f.level));
    if (f.status) (where.push("status = ?"), args.push(f.status));
    return this.db.prepare(`SELECT * FROM alerts WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`).all(...args, f.limit) as unknown as AlertRow[];
  }

  mute(alertId: number): { kind: string; container_name: string | null; patterns: string } | undefined {
    const a = this.get(alertId);
    if (!a) return undefined;
    const pattern = a.fingerprint.split("|").slice(5).join("|");
    const patterns = JSON.stringify([pattern]);
    this.db
      .prepare("INSERT INTO mute_rules(created,alert_id,container_name,kind,patterns,active) VALUES(?,?,?,?,?,1) ON CONFLICT(alert_id) DO UPDATE SET active=1")
      .run(this.o.now(), alertId, a.container_name, a.kind, patterns);
    return { kind: a.kind, container_name: a.container_name, patterns };
  }

  private isMuted(container: string, kind: string, pattern: string): boolean {
    const rules = this.db.prepare("SELECT container_name, kind, patterns FROM mute_rules WHERE active=1 AND kind=? AND (container_name IS NULL OR container_name=?)").all(kind, container) as {
      container_name: string | null;
      kind: string;
      patterns: string;
    }[];
    // A metric mute covers every reading of that container; log/event mutes match the pattern.
    return rules.some((r) => kind === "metric" || (JSON.parse(r.patterns) as string[]).includes(pattern));
  }
}
