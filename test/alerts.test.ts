import { describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.ts";
import { Alerts, logPattern, type DozzleNotification } from "../src/alerts.ts";

const logN = (msg: string, container = "api", sub = 8): DozzleNotification => ({
  id: "x",
  type: "log",
  container: { id: "c1", name: container, hostId: "h1", hostName: "host1" },
  log: { message: msg, timestamp: 0, level: "fatal" },
  subscription: { id: sub, name: "Fatal log line", logExpression: 'level == "fatal"' },
  timestamp: new Date().toISOString(),
});

function setup() {
  let t = 1_000_000;
  const sent: number[] = [];
  const db = openDb(":memory:");
  const alerts = new Alerts(db, { now: () => t, onSent: (a) => void sent.push(a.id) });
  return { db, alerts, sent, advance: (ms: number) => (t += ms) };
}

describe("logPattern", () => {
  it("normalises numbers, ids, ips and times", () => {
    expect(logPattern("conn 10.0.0.5:5432 failed after 3 tries id=4f9c2a1b3c4d5e6f at 2026-11-16T09:48:20.434Z")).toBe(
      "conn <ip> failed after <n> tries id=<hex> at <time>",
    );
  });
});

describe("Alerts triage", () => {
  it("merges repeats inside the batch window", () => {
    const s = setup();
    const a = s.alerts.ingest("main", logN("role root does not exist 1"));
    s.advance(10_000);
    const b = s.alerts.ingest("main", logN("role root does not exist 2"));
    expect(b.id).toBe(a.id);
    expect(b.event_count).toBe(2);
    expect(s.sent).toEqual([a.id]);
  });

  it("rolls a later batch of the same problem into the sent incident", () => {
    const s = setup();
    const a = s.alerts.ingest("main", logN("disk full"));
    s.advance(5 * 60_000);
    const b = s.alerts.ingest("main", logN("disk full"));
    expect(b.status).toBe("suppressed");
    expect(b.suppressed_reason).toBe("rolled into prior incident");
    expect(s.alerts.get(a.id)!.absorbed).toBe(1);
    expect(s.sent).toEqual([a.id]);
  });

  it("sends again once the incident window has passed", () => {
    const s = setup();
    s.alerts.ingest("main", logN("disk full"));
    s.advance(7 * 3_600_000);
    expect(s.alerts.ingest("main", logN("disk full")).status).toBe("sent");
  });

  it("holds back a noisy container", () => {
    const s = setup();
    for (let i = 0; i < 6; i++) {
      s.alerts.ingest("main", logN(`distinct problem ${"abcdef"[i]}`));
      s.advance(61_000);
    }
    expect(s.alerts.ingest("main", logN("yet another problem")).suppressed_reason).toBe("held back");
  });

  it("resolve removes the incident so a later batch is a new alert", () => {
    const s = setup();
    const a = s.alerts.ingest("main", logN("permission denied on ./x.py"));
    expect(s.alerts.resolve(a.id)).toBe(true);
    expect(s.alerts.get(a.id)!.status).toBe("resolved");
    s.advance(61_000);
    const b = s.alerts.ingest("main", logN("permission denied on ./x.py"));
    expect(b.status).toBe("sent");
    expect(b.id).not.toBe(a.id);
  });

  it("mutes by pattern and unmutes", () => {
    const s = setup();
    const a = s.alerts.ingest("main", logN("timeout talking to redis"));
    s.alerts.mute(a.id);
    s.advance(7 * 3_600_000);
    expect(s.alerts.ingest("main", logN("timeout talking to redis")).status).toBe("muted");
    expect(s.alerts.ingest("main", logN("something else entirely")).status).toBe("sent");
    s.db.prepare("UPDATE mute_rules SET active=0 WHERE alert_id=?").run(a.id);
    s.advance(7 * 3_600_000);
    expect(s.alerts.ingest("main", logN("timeout talking to redis")).status).toBe("sent");
  });
});
