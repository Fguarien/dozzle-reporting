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
