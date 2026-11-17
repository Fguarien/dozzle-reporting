import { describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.ts";
import { insertLines, queryLogs, type StoredLine } from "../src/store/logindex.ts";

const now = Date.UTC(2026, 10, 17, 15, 0, 0);

function line(over: Partial<StoredLine> = {}): StoredLine {
  return {
    instance_id: "main",
    host: "local",
    container_id: "c1",
    container_name: "tailscale-dns",
    ts: now - 60_000,
    level: "info",
    message: "[INFO] A IN www.google.com",
    ...over,
  };
}

describe("log index", () => {
  it("counts every stored line, ignores a duplicate, and returns the newest page", () => {
    const db = openDb(":memory:");
    const first = line();
    expect(insertLines(db, [first, line({ ts: now - 30_000, message: "second line" })])).toBe(2);
    expect(insertLines(db, [first])).toBe(0);
    const q = queryLogs(db, { now, limit: 1 });
    expect(q.total).toBe(2);
    expect(q.rows).toHaveLength(1);
    expect(q.rows[0]?.message).toBe("second line");
    expect(q.bars.some((b) => b.reduce((s, n) => s + n, 0) > 0)).toBe(true);
    expect(q.from).toBeLessThanOrEqual(first.ts);
    expect(q.to).toBe(now);
  });

  it("filters by container, level and text without counting the other lines", () => {
    const db = openDb(":memory:");
    insertLines(db, [
      line({ container_id: "a", container_name: "nginx", level: "fatal", message: "boom 100%" }),
      line({ container_id: "b", container_name: "caddy", level: "info", message: "ok" }),
    ]);
    const named = queryLogs(db, { now, limit: 50, container: "nginx", levels: ["error"] });
    expect(named.total).toBe(1);
    expect(named.rows[0]?.container).toBe("nginx");
    expect(named.rows[0]?.level).toBe("error");
    const text = queryLogs(db, { now, limit: 50, text: "100%" });
    expect(text.total).toBe(1);
    expect(queryLogs(db, { now, limit: 50, text: "nope" }).total).toBe(0);
  });
});
