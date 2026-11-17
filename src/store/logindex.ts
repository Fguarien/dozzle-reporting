import type { Db } from "./db.ts";

/** 15 minutes. The chart merges these into the bars it draws. */
export const LOG_BUCKET_MS = 900_000;

const LEVELS = ["debug", "info", "log", "warn", "error"] as const;
type BucketLevel = (typeof LEVELS)[number];

export function bucketLevel(level: string): BucketLevel {
  const l = level.toLowerCase();
  if (l === "error" || l === "err" || l === "fatal") return "error";
  if (l === "warn" || l === "warning") return "warn";
  if (l === "info") return "info";
  if (l === "debug" || l === "trace") return "debug";
  return "log";
}

export interface StoredLine {
  instance_id: string;
  host: string;
  container_id: string;
  container_name: string;
  ts: number;
  level: string;
  message: string;
}

export interface LogQuery {
  container?: string;
  levels?: string[];
  text?: string;
  from?: number;
  to?: number;
  now: number;
  limit: number;
}

export interface LogQueryResult {
  rows: { ts: number; level: string; container: string; message: string }[];
  total: number;
  from: number;
  to: number;
  bars: number[][];
}

/** Insert lines, ignore exact duplicates, and add one to the volume bucket per new line. */
export function insertLines(db: Db, lines: StoredLine[]): number {
  const ins = db.prepare(
    "INSERT OR IGNORE INTO log_lines(ts,instance_id,host,container_id,container_name,level,message) VALUES(?,?,?,?,?,?,?)",
  );
  const vol = db.prepare(
    `INSERT INTO log_volume(bucket,container_name,level,n) VALUES(?,?,?,1)
     ON CONFLICT(bucket,container_name,level) DO UPDATE SET n=n+1`,
  );
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const l of lines) {
      if (!l.ts || !l.message) continue;
      const level = bucketLevel(l.level);
      const message = l.message.slice(0, 500);
      const info = ins.run(l.ts, l.instance_id, l.host, l.container_id, l.container_name, level, message);
      if (!Number(info.changes)) continue;
      vol.run(Math.floor(l.ts / LOG_BUCKET_MS) * LOG_BUCKET_MS, l.container_name, level);
      n++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return n;
}

export function setCursor(db: Db, instance: string, id: string, ts: number): void {
  db.prepare(
    "INSERT INTO log_cursor(instance_id,container_id,ts) VALUES(?,?,?) ON CONFLICT(instance_id,container_id) DO UPDATE SET ts=excluded.ts",
  ).run(instance, id, ts);
}

interface VolRow {
  bucket: number;
  level: string;
  n: number;
}

/** Merge 15-minute counts into n display bars. */
export function barsFromVolume(rows: VolRow[], from: number, to: number, n = 48): number[][] {
  const span = Math.max(1, to - from);
  const bars = Array.from({ length: n }, () => [0, 0, 0, 0, 0]);
  for (const r of rows) {
    let i = Math.floor(((r.bucket - from) / span) * n);
    if (i < 0) i = 0;
    if (i >= n) i = n - 1;
    const li = LEVELS.indexOf(bucketLevel(r.level));
    bars[i]![li]! += r.n;
  }
  return bars;
}

function like(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The logs page. The chart and the total come from log_volume.
 * A text search counts log_lines instead, because the buckets have no message.
 * The table is the latest `limit` lines, newest first.
 */
export function queryLogs(db: Db, o: LogQuery): LogQueryResult {
  const to = o.to && o.to > 0 ? o.to : o.now;
  let from = o.from && o.from > 0 ? o.from : 0;
  if (!from) {
    const min = (db.prepare("SELECT min(bucket) b FROM log_volume").get() as { b: number | null }).b;
    from = min ?? to - 14 * 86_400_000;
  }
  if (from > to) from = to - 60_000;
  const levels = o.levels?.length ? [...new Set(o.levels.map(bucketLevel))] : undefined;
  const where = ["1=1"];
  const args: (string | number)[] = [];
  const addRange = (col: string) => {
    where.push(`${col}>=?`, `${col}<?`);
    args.push(from, to);
  };
  if (o.text) {
    addRange("ts");
    if (o.container) {
      where.push("container_name=?");
      args.push(o.container);
    }
    if (levels) {
      where.push(`level IN (${levels.map(() => "?").join(",")})`);
      args.push(...levels);
    }
    where.push("message LIKE ? ESCAPE '\\'");
    args.push(like(o.text));
    const grouped = db.prepare(
      `SELECT (ts / ${LOG_BUCKET_MS}) * ${LOG_BUCKET_MS} AS bucket, level, count(*) n FROM log_lines WHERE ${where.join(" AND ")} GROUP BY bucket, level`,
    ).all(...args) as unknown as VolRow[];
    const total = grouped.reduce((s, r) => s + r.n, 0);
    const rows = latest(db, where, args, o.limit);
    return { rows, total, from, to, bars: barsFromVolume(grouped, from, to) };
  }
  addRange("bucket");
  if (o.container) {
    where.push("container_name=?");
    args.push(o.container);
  }
  if (levels) {
    where.push(`level IN (${levels.map(() => "?").join(",")})`);
    args.push(...levels);
  }
  const grouped = db.prepare(`SELECT bucket, level, SUM(n) n FROM log_volume WHERE ${where.join(" AND ")} GROUP BY bucket, level`).all(...args) as unknown as VolRow[];
  const total = grouped.reduce((s, r) => s + r.n, 0);
  const lineWhere = ["ts>=?", "ts<?"];
  const lineArgs: (string | number)[] = [from, to];
  if (o.container) {
    lineWhere.push("container_name=?");
    lineArgs.push(o.container);
  }
  if (levels) {
    lineWhere.push(`level IN (${levels.map(() => "?").join(",")})`);
    lineArgs.push(...levels);
  }
  return { rows: latest(db, lineWhere, lineArgs, o.limit), total, from, to, bars: barsFromVolume(grouped, from, to) };
}

function latest(db: Db, where: string[], args: (string | number)[], limit: number): LogQueryResult["rows"] {
  const rows = db.prepare(
    `SELECT ts, level, container_name AS container, message FROM log_lines WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`,
  ).all(...args, limit) as unknown as LogQueryResult["rows"];
  return rows;
}
