import { describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.ts";
import { Collector } from "../src/collector.ts";
import { DozzleClient, parseSse } from "../src/dozzle/client.ts";

const client = new DozzleClient({ id: "main", name: "t", url: "http://dozzle.invalid", auth: { mode: "none" } });
const c = (id: string, name: string, host: string, extra: Record<string, unknown> = {}) => ({ id, name, host, image: "img:1", state: "running", labels: { "com.docker.compose.config-hash": "h1" }, ...extra });

function setup() {
  let t = Date.UTC(2026, 10, 16, 12, 0, 0);
  const db = openDb(":memory:");
  const col = new Collector(db, client, { bucketSeconds: 30, now: () => t });
  return { db, col, advance: (ms: number) => (t += ms) };
}

describe("Collector", () => {
  it("does not mistake same-named containers on two hosts for a change", () => {
    const s = setup();
    s.col.handle("containers-changed", JSON.stringify([c("a", "cadvisor", "h1"), c("b", "cadvisor", "h2", { image: "img:2", labels: { "com.docker.compose.config-hash": "h2" } })]));
    expect((s.db.prepare("SELECT count(*) n FROM changes").get() as { n: number }).n).toBe(0);
  });

  it("records an image change when a container is recreated on the same host", () => {
    const s = setup();
    s.col.handle("containers-changed", JSON.stringify([c("a", "web", "h1")]));
    s.advance(60_000);
    s.col.handle("containers-changed", JSON.stringify([c("a2", "web", "h1", { image: "img:2" })]));
    const rows = s.db.prepare("SELECT kind, before, after FROM changes").all() as { kind: string; before: string; after: string }[];
    expect(rows).toEqual([{ kind: "image", before: "img:1", after: "img:2" }]);
  });

  it("aggregates per-second stats into one bucket with avg, peak and rates", () => {
    const s = setup();
    s.col.handle("containers-changed", JSON.stringify([c("a", "web", "h1")]));
    for (let i = 0; i < 10; i++) {
      s.col.handle("container-stat", JSON.stringify({ id: "a", cpu: i === 5 ? 90 : 10, memory: 20, memoryUsage: 1000, networkRxTotal: 1000 * i, networkTxTotal: 0 }));
      s.advance(1000);
    }
    s.col.flush();
    const m = s.db.prepare("SELECT cpu_avg, cpu_max, mem_avg, net_rx_bps, samples FROM metrics").get() as Record<string, number>;
    expect(m.samples).toBe(10);
    expect(m.cpu_max).toBe(90);
    expect(m.cpu_avg).toBeCloseTo(18);
    expect(m.net_rx_bps).toBeCloseTo(1000);
  });

  it("levels a non-zero exit as error and folds exit into changes", () => {
    const s = setup();
    s.col.handle("containers-changed", JSON.stringify([c("a", "web", "h1")]));
    s.col.handle("container-event", JSON.stringify({ name: "die", host: "h1", actorId: "a", actorAttributes: { exitCode: "1" } }));
    expect(s.db.prepare("SELECT name, level, container_name FROM events").get()).toEqual({ name: "die", level: "error", container_name: "web" });
    expect((s.db.prepare("SELECT kind FROM changes").get() as { kind: string }).kind).toBe("exit");
  });
});

describe("parseSse", () => {
  it("splits events across chunk boundaries", async () => {
    const enc = new TextEncoder();
    const parts = ["event: a\ndata: {\"x\":", "1}\n\nevent: b\n", "data: 2\n\n"];
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (const p of parts) ctrl.enqueue(enc.encode(p));
        ctrl.close();
      },
    });
    const out = [];
    for await (const m of parseSse(body)) out.push(m);
    expect(out).toEqual([
      { event: "a", data: '{"x":1}' },
      { event: "b", data: "2" },
    ]);
  });
});
