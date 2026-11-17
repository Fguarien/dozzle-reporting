import type { Db } from "../store/db.ts";
import { LOG_PAGE, type DozzleClient } from "../dozzle/client.ts";
import { insertLines, setCursor } from "../store/logindex.ts";
import { mapLimit } from "../mcp/tools.ts";

interface Due {
  instance_id: string;
  id: string;
  host: string;
  name: string;
  cursor: number;
}

/**
 * Fill the log index from Dozzle, in the background.
 * Each pass reads the next oldest page (500 lines) of the 20 stalest running containers.
 * A container read in the last 30 s waits. Nothing here blocks the HTTP server.
 */
export function startLogIngest(db: Db, clients: Map<string, DozzleClient>, log: (m: string) => void, retentionDays: number): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const step = async () => {
    if (stopped) return;
    let wait = 5_000;
    try {
      const due = db.prepare(
        `SELECT c.instance_id, c.id, c.host, c.name, IFNULL(k.ts, 0) AS cursor
         FROM containers c
         LEFT JOIN log_cursor k ON k.instance_id=c.instance_id AND k.container_id=c.id
         WHERE c.state='running' AND IFNULL(k.ts, 0) < ?
         ORDER BY IFNULL(k.ts, 0) ASC
         LIMIT 20`,
      ).all(Date.now() - 30_000) as unknown as Due[];
      if (due.length) {
        wait = 2_000;
        await mapLimit(due, 4, async (c) => {
          const cl = clients.get(c.instance_id);
          if (!cl || stopped) return;
          const to = Date.now();
          const from = c.cursor > 0 ? c.cursor : to - retentionDays * 86_400_000;
          try {
            const lines = await cl.logsBetween(c.host, c.id, new Date(from), new Date(to), LOG_PAGE);
            const added = insertLines(
              db,
              lines.map((l) => ({
                instance_id: c.instance_id,
                host: c.host,
                container_id: c.id,
                container_name: c.name,
                ts: l.ts,
                level: l.level,
                message: l.message,
              })),
            );
            const newest = lines.reduce((m, l) => Math.max(m, l.ts), 0);
            const next = lines.length >= LOG_PAGE ? Math.max(c.cursor + 1, newest) : to;
            setCursor(db, c.instance_id, c.id, next > c.cursor ? next : c.cursor + 1);
            if (added) log(`[logs] ${c.name} +${added}`);
          } catch (e) {
            log(`[logs] ${c.name}: ${(e as Error).message}`);
          }
        });
      }
    } catch (e) {
      log(`[logs] ${((e as Error).message)}`);
    }
    if (!stopped) timer = setTimeout(() => void step(), wait);
  };
  timer = setTimeout(() => void step(), 800);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
