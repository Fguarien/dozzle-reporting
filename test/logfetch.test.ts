import { describe, expect, it } from "vitest";
import { DozzleClient, type DozzleClient as DozzleClientType } from "../src/dozzle/client.ts";
import { openDb } from "../src/store/db.ts";
import { tailContainer } from "../src/web/logfetch.ts";

const now = Date.UTC(2026, 10, 17, 18, 52, 0);

describe("tail of one container", () => {
  it("keeps the last lines, not the first ones of the same read", async () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO containers(instance_id,id,host,name,state,first_seen,last_seen) VALUES(?,?,?,?,?,?,?)").run(
      "main", "abc", "local", "authentik-postgres", "running", now, now,
    );
    const calls: { limit: number }[] = [];
    const client = {
      async logsNewest(_host: string, _id: string, limit: number) {
        calls.push({ limit });
        return [
          { ts: now - 4 * 86_400_000, level: "info", message: "first of history" },
          { ts: now - 1000, level: "info", message: "older line" },
          { ts: now, level: "info", message: "newest line" },
        ];
      },
    };
    const out = await tailContainer(db, new Map([["main", client as unknown as DozzleClientType]]), {
      container: "authentik-postgres",
      limit: 2,
    });
    expect(out.rows.map((r) => r.message)).toEqual(["newest line", "older line"]);
    expect(out.rows[0]?.container).toBe("authentik-postgres");
    expect(out.store.map((r) => r.message)).toEqual(["newest line", "older line"]);
    expect(out.store[0]?.container_id).toBe("abc");
    expect(calls).toEqual([{ limit: 2 }]);
  });

  it("reads the tail once when there is no text query", async () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO containers(instance_id,id,host,name,state,first_seen,last_seen) VALUES(?,?,?,?,?,?,?)").run(
      "main", "abc", "local", "authentik-postgres", "running", now, now,
    );
    let n = 0;
    const client = {
      async logsNewest() {
        n += 1;
        return [{ ts: now, level: "info", message: "today" }];
      },
      async containerLines() {
        throw new Error("a plain tail must not use the search tool");
      },
    };
    const out = await tailContainer(db, new Map([["main", client as unknown as DozzleClientType]]), {
      container: "authentik-postgres",
      limit: 200,
    });
    expect(n).toBe(1);
    expect(out.rows[0]?.message).toBe("today");
  });
});

describe("logsNewest", () => {
  it("sends min, never maxStart, and keeps the end of the body", async () => {
    let body = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = String(init?.body ?? "");
      const lines = [1, 2, 3].map((n) => JSON.stringify({ ts: n, l: "info", m: `line ${n}` })).join("\n");
      return new Response(lines, { status: 200 });
    }) as typeof fetch;
    const client = new DozzleClient({ id: "main", name: "t", url: "http://dozzle.invalid", auth: { mode: "none" } }, fetchImpl);
    const rows = await client.logsNewest("local", "abc", 2);
    const form = new URLSearchParams(body);
    expect(form.get("min")).toBe("2");
    expect(form.has("maxStart")).toBe(false);
    expect(form.get("format")).toBe("jsonl");
    expect(rows.map((r) => r.message)).toEqual(["line 2", "line 3"]);
  });
});
