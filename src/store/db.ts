import { DatabaseSync } from "node:sqlite";

/**
 * SQLite store. One file, WAL mode. Everything Dozzle Cloud keeps server-side lives here:
 * lifecycle events, 30 s metric buckets, container snapshots (to diff changes), alerts,
 * mute rules and log-review findings.
 */
export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS containers (
  instance_id TEXT NOT NULL,
  id TEXT NOT NULL,
  host TEXT NOT NULL,
  name TEXT NOT NULL,
  image TEXT,
  image_id TEXT,
  state TEXT,
  health TEXT,
  config_hash TEXT,
  config_json TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (instance_id, id)
);
CREATE INDEX IF NOT EXISTS containers_name ON containers(name);

CREATE TABLE IF NOT EXISTS hosts (
  instance_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT,
  json TEXT,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (instance_id, id)
);

CREATE TABLE IF NOT EXISTS events (
  rowid INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  instance_id TEXT NOT NULL,
  host TEXT,
  container_id TEXT,
  container_name TEXT,
  name TEXT NOT NULL,
  level TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_name ON events(container_name, ts);

CREATE TABLE IF NOT EXISTS metrics (
  ts INTEGER NOT NULL,
  instance_id TEXT NOT NULL,
  container_id TEXT NOT NULL,
  container_name TEXT NOT NULL,
  host TEXT,
  cpu_avg REAL, cpu_max REAL,
  mem_avg REAL, mem_max REAL,
  mem_pct_avg REAL, mem_pct_max REAL,
  net_rx_bps REAL, net_tx_bps REAL,
  disk_r_bps REAL, disk_w_bps REAL,
  samples INTEGER NOT NULL,
  PRIMARY KEY (instance_id, container_id, ts)
);
CREATE INDEX IF NOT EXISTS metrics_ts ON metrics(ts);
CREATE INDEX IF NOT EXISTS metrics_name ON metrics(container_name, ts);

CREATE TABLE IF NOT EXISTS changes (
  rowid INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  instance_id TEXT NOT NULL,
  host TEXT,
  container_id TEXT,
  container_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  origin TEXT,
  before TEXT,
  after TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS changes_ts ON changes(ts);
CREATE INDEX IF NOT EXISTS changes_name ON changes(container_name, ts);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  instance_id TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  level TEXT NOT NULL,
  container_name TEXT,
  host TEXT,
  fingerprint TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  status TEXT NOT NULL,
  suppressed_reason TEXT,
  parent_id INTEGER,
  absorbed INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 1,
  sample TEXT
);
CREATE INDEX IF NOT EXISTS alerts_ts ON alerts(ts);
CREATE INDEX IF NOT EXISTS alerts_fp ON alerts(fingerprint, ts);

CREATE TABLE IF NOT EXISTS mute_rules (
  id INTEGER PRIMARY KEY,
  created INTEGER NOT NULL,
  alert_id INTEGER NOT NULL UNIQUE,
  container_name TEXT,
  kind TEXT NOT NULL,
  patterns TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  resolved_at INTEGER,
  instance_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  containers TEXT NOT NULL,
  headline TEXT NOT NULL,
  why TEXT,
  fix TEXT,
  ignored INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
  db.exec(SCHEMA);
  return db;
}

export function kvGet(db: Db, k: string): string | undefined {
  const r = db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined;
  return r?.v;
}

export function kvSet(db: Db, k: string, v: string): void {
  db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);
}

/** Drop rows older than the retention window. Called hourly. */
export function prune(db: Db, retentionDays: number, now = Date.now()): void {
  const cut = now - retentionDays * 86_400_000;
  db.prepare("DELETE FROM metrics WHERE ts < ?").run(cut);
  db.prepare("DELETE FROM events WHERE ts < ?").run(cut);
  db.prepare("DELETE FROM changes WHERE ts < ?").run(cut);
  db.prepare("DELETE FROM alerts WHERE last_ts < ?").run(cut);
  db.prepare("DELETE FROM findings WHERE status='resolved' AND resolved_at < ?").run(cut);
}
