import type { Db } from "./store/db.ts";
import type { DozzleClient, DzContainer, DzEvent, DzStat } from "./dozzle/client.ts";

/** Running aggregate of one container's stats inside the current bucket. */
interface Acc {
  name: string;
  host: string;
  n: number;
  cpuSum: number;
  cpuMax: number;
  memSum: number;
  memMax: number;
  pctSum: number;
  pctMax: number;
  first?: { t: number; rx: number; tx: number; dr: number; dw: number };
  last?: { t: number; rx: number; tx: number; dr: number; dw: number };
}

export interface CollectorOptions {
  bucketSeconds: number;
  log?: (msg: string) => void;
  now?: () => number;
}

/**
 * Subscribes to one Dozzle instance's SSE stream and writes history:
 * container snapshots + changes, lifecycle events, and 30 s metric buckets.
 * Dozzle sends a stat per container per second; we never store raw samples.
 */
export class Collector {
  private acc = new Map<string, Acc>();
  private known = new Map<string, DzContainer>();
  private bucketStart: number;
  private stopped = false;
  private ac?: AbortController;
  connected = false;
  lastMessageAt = 0;

  private readonly db: Db;
  private readonly client: DozzleClient;
  private readonly opts: CollectorOptions;

  constructor(db: Db, client: DozzleClient, opts: CollectorOptions) {
    this.db = db;
    this.client = client;
    this.opts = opts;
    this.bucketStart = this.floor(this.now());
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private floor(t: number): number {
    const b = this.opts.bucketSeconds * 1000;
    return Math.floor(t / b) * b;
  }

  private log(m: string): void {
    this.opts.log?.(`[collector ${this.client.id}] ${m}`);
  }

  /** Reconnecting loop. Resolves when stop() is called. */
  async run(): Promise<void> {
    let backoff = 1000;
    const timer = setInterval(() => this.maybeFlush(), 1000);
    try {
      while (!this.stopped) {
        this.ac = new AbortController();
        try {
          await this.refreshHosts();
          for await (const m of this.client.events(this.ac.signal)) {
            this.connected = true;
            backoff = 1000;
            this.handle(m.event, m.data);
          }
        } catch (e) {
          if (this.stopped) break;
          this.log(`stream error: ${(e as Error).message}`);
        }
        this.connected = false;
        if (this.stopped) break;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    } finally {
      clearInterval(timer);
      this.flush(true);
    }
  }

  stop(): void {
    this.stopped = true;
    this.ac?.abort();
  }

  async refreshHosts(): Promise<void> {
    try {
      const hosts = await this.client.hosts();
      const st = this.db.prepare(
        "INSERT INTO hosts(instance_id,id,name,json,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(instance_id,id) DO UPDATE SET name=excluded.name,json=excluded.json,last_seen=excluded.last_seen",
      );
      for (const h of hosts) st.run(this.client.id, h.id, h.name, JSON.stringify(h), this.now());
    } catch (e) {
      this.log(`hosts: ${(e as Error).message}`);
    }
  }

  /** Entry point for one SSE message. Public for tests. */
  handle(event: string, data: string): void {
    this.lastMessageAt = this.now();
    switch (event) {
      case "containers-changed": {
        // Authoritative for the hosts it names. An empty payload is a parse miss, not "everyone left".
        const list = JSON.parse(data) as DzContainer[];
        if (list.length === 0) break;
        for (const c of list) this.upsert(c, "snapshot");
        this.retireMissing(list);
        break;
      }
      case "container-updated":
        this.upsert(JSON.parse(data) as DzContainer, "update");
        break;
      case "container-stat":
        this.stat(JSON.parse(data) as DzStat);
        break;
      case "container-event":
        this.event(JSON.parse(data) as DzEvent);
        break;
      case "container-health": {
        const p = JSON.parse(data) as { actorId: string; health: string };
        const c = this.known.get(p.actorId);
        this.insertEvent(this.now(), c?.host, p.actorId, c?.name, "health_status", p.health === "unhealthy" ? "warning" : "info", { healthStatus: p.health });
        break;
      }
      case "update-host":
        void this.refreshHosts();
        break;
      default:
        break;
    }
  }

  private upsert(c: DzContainer, origin: "snapshot" | "update"): void {
    const now = this.now();
    const prevById = this.known.get(c.id);
    const configHash = c.labels?.["com.docker.compose.config-hash"] ?? null;
    const imageId = (c.labels?.["com.docker.compose.image"] as string | undefined) ?? (c.imageId as string | undefined) ?? null;
    // A recreated container has a new id but the same name on the same host: compare against
    // the last row by (host, name). Same-named containers on other hosts are different services.
    const prev =
      prevById ??
      (this.db
        .prepare("SELECT id, image, image_id AS imageId, config_hash AS configHash, state FROM containers WHERE instance_id=? AND host=? AND name=? AND id<>? ORDER BY last_seen DESC LIMIT 1")
        .get(this.client.id, c.host, c.name, c.id) as { id: string; image: string; imageId: string | null; configHash: string | null; state: string } | undefined);
    if (prev) {
      const prevImage = (prev as DzContainer).image;
      const prevImageId = (prev as { imageId?: string | null }).imageId ?? (prevById?.labels?.["com.docker.compose.image"] as string | undefined) ?? null;
      const prevHash = (prev as { configHash?: string | null }).configHash ?? (prevById?.labels?.["com.docker.compose.config-hash"] as string | undefined) ?? null;
      if (prevImage !== c.image || (prevImageId && imageId && prevImageId !== imageId)) {
        this.insertChange(now, c, "image", origin === "update" ? "dozzle" : "outside", `${prevImage}${prevImageId ? "@" + prevImageId.slice(0, 19) : ""}`, `${c.image}${imageId ? "@" + imageId.slice(0, 19) : ""}`);
      }
      if (prevHash && configHash && prevHash !== configHash) {
        this.insertChange(now, c, "config", "outside", prevHash.slice(0, 12), configHash.slice(0, 12), "compose config hash changed");
      }
    }
    this.known.set(c.id, c);
    this.db
      .prepare(
        `INSERT INTO containers(instance_id,id,host,name,image,image_id,state,health,config_hash,config_json,first_seen,last_seen)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(instance_id,id) DO UPDATE SET host=excluded.host,name=excluded.name,image=excluded.image,image_id=excluded.image_id,
           state=excluded.state,health=excluded.health,config_hash=excluded.config_hash,config_json=excluded.config_json,last_seen=excluded.last_seen`,
      )
      .run(this.client.id, c.id, c.host, c.name, c.image, imageId, c.state, c.health ?? null, configHash, JSON.stringify(slim(c)), now, now);
  }

  /** Drop ids this host no longer reports. Hosts absent from the payload are left alone. */
  private retireMissing(list: DzContainer[]): void {
    const byHost = new Map<string, Set<string>>();
    for (const c of list) {
      if (!c.host) continue;
      let ids = byHost.get(c.host);
      if (!ids) byHost.set(c.host, (ids = new Set()));
      ids.add(c.id);
    }
    const seen = this.db.prepare("SELECT id FROM containers WHERE instance_id=? AND host=? AND state='running'");
    const retire = this.db.prepare("UPDATE containers SET state='exited' WHERE instance_id=? AND id=?");
    const dropLive = this.db.prepare("DELETE FROM live_metrics WHERE instance_id=? AND container_id=?");
    for (const [host, ids] of byHost) {
      for (const row of seen.all(this.client.id, host) as { id: string }[]) {
        if (ids.has(row.id)) continue;
        retire.run(this.client.id, row.id);
        dropLive.run(this.client.id, row.id);
        this.known.delete(row.id);
      }
    }
  }

  private event(e: DzEvent): void {
    const c = this.known.get(e.actorId);
    const ts = e.time ? Date.parse(e.time) || this.now() : this.now();
    const attrs = e.actorAttributes ?? {};
    let level = "info";
    if (e.name === "die") {
      const code = attrs["exitCode"];
      level = code && !["0", "130", "143"].includes(code) ? "error" : "info";
      if (code === "137") level = "warning";
    } else if (e.name === "oom") level = "error";
    else if (e.name === "destroy") level = "info";
    const name = c?.name ?? attrs["name"] ?? null;
    this.insertEvent(ts, e.host, e.actorId, name, e.name, level, { exitCode: attrs["exitCode"], image: attrs["image"] });
    if (e.name === "die" && name) {
      this.insertChange(ts, { id: e.actorId, name, host: e.host } as DzContainer, "exit", null, null, null, `exit code ${attrs["exitCode"] ?? "?"}`);
    }
    if (e.name === "oom" && name) {
      this.insertChange(ts, { id: e.actorId, name, host: e.host } as DzContainer, "oom", null, null, null, "killed: out of memory");
    }
  }

  private insertEvent(ts: number, host: string | undefined | null, id: string, name: string | undefined | null, ev: string, level: string, detail: Record<string, unknown>): void {
    const clean = Object.fromEntries(Object.entries(detail).filter(([, v]) => v !== undefined && v !== null));
    this.db
      .prepare("INSERT INTO events(ts,instance_id,host,container_id,container_name,name,level,detail) VALUES(?,?,?,?,?,?,?,?)")
      .run(ts, this.client.id, host ?? null, id, name ?? null, ev, level, Object.keys(clean).length ? JSON.stringify(clean) : null);
  }

  private insertChange(ts: number, c: Pick<DzContainer, "id" | "name" | "host">, kind: string, origin: string | null, before: string | null, after: string | null, detail: string | null = null): void {
    this.db
      .prepare("INSERT INTO changes(ts,instance_id,host,container_id,container_name,kind,origin,before,after,detail) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(ts, this.client.id, c.host ?? null, c.id, c.name, kind, origin, before, after, detail);
  }

  private stat(s: DzStat): void {
    const t = this.now();
    if (this.floor(t) !== this.bucketStart) this.flush();
    const c = this.known.get(s.id);
    let a = this.acc.get(s.id);
    if (!a) {
      a = { name: c?.name ?? s.id, host: c?.host ?? "", n: 0, cpuSum: 0, cpuMax: 0, memSum: 0, memMax: 0, pctSum: 0, pctMax: 0 };
      this.acc.set(s.id, a);
    }
    a.n++;
    a.cpuSum += s.cpu;
    a.cpuMax = Math.max(a.cpuMax, s.cpu);
    a.memSum += s.memoryUsage;
    a.memMax = Math.max(a.memMax, s.memoryUsage);
    a.pctSum += s.memory;
    a.pctMax = Math.max(a.pctMax, s.memory);
    const io = { t, rx: s.networkRxTotal ?? 0, tx: s.networkTxTotal ?? 0, dr: s.diskReadTotal ?? 0, dw: s.diskWriteTotal ?? 0 };
    if (!a.first) a.first = io;
    a.last = io;
  }

  private maybeFlush(): void {
    if (this.floor(this.now()) !== this.bucketStart) this.flush();
  }

  /** Write the current bucket. Rates come from first/last cumulative counters in the bucket. */
  flush(final = false): void {
    if (this.acc.size === 0) {
      this.bucketStart = this.floor(this.now());
      return;
    }
    const st = this.db.prepare(
      `INSERT OR REPLACE INTO metrics(ts,instance_id,container_id,container_name,host,cpu_avg,cpu_max,mem_avg,mem_max,mem_pct_avg,mem_pct_max,net_rx_bps,net_tx_bps,disk_r_bps,disk_w_bps,samples)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const liveSt = this.db.prepare(
      `INSERT OR REPLACE INTO live_metrics(instance_id,container_id,container_name,host,ts,cpu,cpu_max,mem,mem_pct,net_rx,net_tx,disk_r,disk_w)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const rollSt = this.db.prepare(
      `INSERT INTO metric_roll(ts,instance_id,container_id,container_name,host,cpu_avg,cpu_max,mem_avg,mem_max,mem_pct_avg,net_rx,net_tx,disk_r,disk_w,samples)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(ts, instance_id, container_id) DO UPDATE SET
         container_name=excluded.container_name, host=excluded.host,
         cpu_avg=(metric_roll.cpu_avg*metric_roll.samples + excluded.cpu_avg*excluded.samples)/(metric_roll.samples+excluded.samples),
         cpu_max=max(metric_roll.cpu_max, excluded.cpu_max),
         mem_avg=(metric_roll.mem_avg*metric_roll.samples + excluded.mem_avg*excluded.samples)/(metric_roll.samples+excluded.samples),
         mem_max=max(metric_roll.mem_max, excluded.mem_max),
         mem_pct_avg=(metric_roll.mem_pct_avg*metric_roll.samples + excluded.mem_pct_avg*excluded.samples)/(metric_roll.samples+excluded.samples),
         net_rx=(metric_roll.net_rx*metric_roll.samples + excluded.net_rx*excluded.samples)/(metric_roll.samples+excluded.samples),
         net_tx=(metric_roll.net_tx*metric_roll.samples + excluded.net_tx*excluded.samples)/(metric_roll.samples+excluded.samples),
         disk_r=(metric_roll.disk_r*metric_roll.samples + excluded.disk_r*excluded.samples)/(metric_roll.samples+excluded.samples),
         disk_w=(metric_roll.disk_w*metric_roll.samples + excluded.disk_w*excluded.samples)/(metric_roll.samples+excluded.samples),
         samples=metric_roll.samples+excluded.samples`,
    );
    const hour = Math.floor(this.bucketStart / 3_600_000) * 3_600_000;
    const seenAt = this.now();
    const rate = (a: Acc, k: "rx" | "tx" | "dr" | "dw") => {
      if (!a.first || !a.last || a.last.t <= a.first.t) return 0;
      const d = a.last[k] - a.first[k];
      return d > 0 ? d / ((a.last.t - a.first.t) / 1000) : 0;
    };
    this.db.exec("BEGIN");
    try {
      for (const [id, a] of this.acc) {
        const cpu = a.cpuSum / a.n;
        const mem = a.memSum / a.n;
        const pct = a.pctSum / a.n;
        const rx = rate(a, "rx");
        const tx = rate(a, "tx");
        const dr = rate(a, "dr");
        const dw = rate(a, "dw");
        st.run(this.bucketStart, this.client.id, id, a.name, a.host, cpu, a.cpuMax, mem, a.memMax, pct, a.pctMax, rx, tx, dr, dw, a.n);
        liveSt.run(this.client.id, id, a.name, a.host, seenAt, cpu, a.cpuMax, mem, pct, rx, tx, dr, dw);
        rollSt.run(hour, this.client.id, id, a.name, a.host, cpu, a.cpuMax, mem, a.memMax, pct, rx, tx, dr, dw, a.n);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.acc.clear();
    if (!final) this.bucketStart = this.floor(this.now());
  }
}

/** Keep what `history_container_changes` needs to diff config; drop noisy fields. */
function slim(c: DzContainer): Record<string, unknown> {
  const { labels, ...rest } = c;
  return { ...rest, labelKeys: labels ? Object.keys(labels).sort() : [] };
}
