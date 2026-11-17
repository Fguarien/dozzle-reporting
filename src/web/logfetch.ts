import type { Db } from "../store/db.ts";
import type { DozzleClient } from "../dozzle/client.ts";
import { mapLimit, parseTime, resolveContainer } from "../mcp/tools.ts";

/** One log line read live from Dozzle. Nothing here is stored. */
export interface LogHit {
  ts: number;
  level: string;
  container: string;
  message: string;
}

export interface LogNote {
  kind: "missing" | "capped";
  name?: string;
  n?: number;
  total?: number;
}

export interface LogFetch {
  rows: LogHit[];
  from: number;
  to: number;
  note?: LogNote;
}

/** How many running containers an "all containers" search may read. */
export const LOG_CAP = 24;

type StoredTail = {
  instance_id: string;
  host: string;
  container_id: string;
  container_name: string;
  ts: number;
  level: string;
  message: string;
};

/**
 * Newest lines of one container, the page Cloud calls Tailing.
 * No time window: Dozzle's log tool then reads the last minutes and keeps the
 * newest `limit`. A quiet container (nothing in that window) is read once more
 * over the last day. The index backfill is still on the oldest page, so the
 * table must not read it for this.
 */
export async function tailContainer(
  db: Db,
  clients: Map<string, DozzleClient>,
  o: { container: string; query?: string; levels?: string[]; limit: number },
): Promise<{ rows: LogHit[]; store: StoredTail[] }> {
  const target = resolveContainer(db, o.container)[0];
  if (!target) return { rows: [], store: [] };
  const cl = clients.get(target.instance_id);
  if (!cl) return { rows: [], store: [] };
  const pack = (lines: { ts: number; level: string; message: string }[]) => {
    const packed: { row: LogHit; store: StoredTail }[] = [];
    for (const l of lines) {
      if (!Number.isFinite(l.ts) || l.ts <= 0 || !l.message) continue;
      const row = { ts: l.ts, level: l.level, container: target.name, message: l.message };
      packed.push({
        row,
        store: {
          instance_id: target.instance_id,
          host: target.host,
          container_id: target.id,
          container_name: target.name,
          ts: l.ts,
          level: l.level,
          message: l.message,
        },
      });
    }
    packed.sort((a, b) => b.row.ts - a.row.ts);
    const shown = packed.slice(0, o.limit);
    return { rows: shown.map((p) => p.row), store: shown.map((p) => p.store) };
  };
  const base = { host: target.host, id: target.id, query: o.query, levels: o.levels, limit: o.limit };
  let got = pack(await cl.containerLines(base));
  if (!got.rows.length && !o.query) {
    got = pack(await cl.containerLines({ ...base, from: new Date(Date.now() - 86_400_000) }));
  }
  return got;
}

interface Target {
  instance_id: string;
  id: string;
  host: string;
  name: string;
}

/**
 * Read log lines from Docker through Dozzle for the page.
 * A named container is resolved exactly. "All containers" reads only the
 * LOG_CAP running containers seen most recently — there is no fleet index.
 */
export async function fetchLogs(
  db: Db,
  clients: Map<string, DozzleClient>,
  o: { query?: string; container?: string; levels?: string[]; after: string; limit: number; now: number },
): Promise<LogFetch> {
  const to = o.now;
  const from = parseTime(o.after, to) ?? to - 15 * 60_000;
  let targets: Target[];
  let note: LogNote | undefined;
  if (o.container) {
    targets = resolveContainer(db, o.container).slice(0, 12);
    if (!targets.length) return { rows: [], from, to, note: { kind: "missing", name: o.container } };
  } else {
    const all = db
      .prepare("SELECT instance_id,id,host,name FROM containers WHERE state='running' ORDER BY last_seen DESC")
      .all() as unknown as Target[];
    if (all.length > LOG_CAP) note = { kind: "capped", n: LOG_CAP, total: all.length };
    targets = all.slice(0, LOG_CAP);
  }
  const found: LogHit[] = [];
  await mapLimit(targets, 6, async (c) => {
    const cl = clients.get(c.instance_id);
    if (!cl) return;
    try {
      const lines = await cl.containerLines({
        host: c.host,
        id: c.id,
        from: new Date(from),
        to: new Date(to),
        query: o.query,
        levels: o.levels,
        limit: o.limit,
      });
      for (const l of lines) found.push({ ts: Number.isFinite(l.ts) ? l.ts : 0, level: l.level, container: c.name, message: l.message });
    } catch {
      /* one container being unreadable does not drop the others */
    }
  });
  found.sort((a, b) => a.ts - b.ts);
  return { rows: found.slice(-o.limit), from, to, note };
}
