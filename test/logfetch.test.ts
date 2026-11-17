import { describe, expect, it } from "vitest";
import type { DozzleClient } from "../src/dozzle/client.ts";
import { openDb } from "../src/store/db.ts";
import { tailContainer } from "../src/web/logfetch.ts";

const now = Date.UTC(2026, 10, 17, 18, 52, 0);

describe("tail of one container", () => {
  it("returns the newest lines and asks for the last day only when the short tail is empty", async () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO containers(instance_id,id,host,name,state,first_seen,last_seen) VALUES(?,?,?,?,?,?,?)").run(
      "main", "abc", "local", "authentik-postgres", "running", now, now,
    );
    const calls: { from?: string; limit?: number }[] = [];
    const client = {
      async containerLines(o: { from?: Date; limit?: number }) {
        calls.push({ from: o.from?.toISOString(), limit: o.limit });
        if (!o.from) return [{ ts: Number.NaN, level: "info", message: "drop me" }];
        return [
          { ts: now - 1000, level: "info", message: "older line" },
          { ts: now, level: "info", message: "newest line" },
        ];
      },
    };
    const out = await tailContainer(db, new Map([["main", client as unknown as DozzleClient]]), {
      container: "authentik-postgres",
      limit: 1,
    });
    expect(out.rows.map((r) => r.message)).toEqual(["newest line"]);
    expect(out.rows[0]?.container).toBe("authentik-postgres");
    expect(out.store).toEqual([
      {
        instance_id: "main",
        host: "local",
        container_id: "abc",
        container_name: "authentik-postgres",
        ts: now,
        level: "info",
        message: "newest line",
      },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.from).toBeUndefined();
    expect(calls[1]?.from).toBeTruthy();
    expect(calls[0]?.limit).toBe(1);
  });

  it("does not widen a short tail that already has lines", async () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO containers(instance_id,id,host,name,state,first_seen,last_seen) VALUES(?,?,?,?,?,?,?)").run(
      "main", "abc", "local", "authentik-postgres", "running", now, now,
    );
    let n = 0;
    const client = {
      async containerLines() {
        n += 1;
        return [{ ts: now, level: "info", message: "today" }];
      },
    };
    const out = await tailContainer(db, new Map([["main", client as unknown as DozzleClient]]), {
      container: "authentik-postgres",
      limit: 200,
    });
    expect(n).toBe(1);
    expect(out.rows[0]?.message).toBe("today");
  });
});
