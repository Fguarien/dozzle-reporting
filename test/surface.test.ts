import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.ts";
import { DICT } from "../src/web/i18n.ts";
import { hostRole, instancesPage, integrationsPage, metricsPage, verLabel, type PageCtx } from "../src/web/ui.ts";
import type { Config } from "../src/config.ts";
import { createToken, findToken, revokeToken } from "../src/mcp/tokens.ts";
import { digestText } from "../src/notify/digest.ts";
import { isMuted, muteDeadline, nextMidnight, setMuteUntil } from "../src/notify/mute.ts";
import { sendMail } from "../src/notify/smtp.ts";

const now = Date.UTC(2026, 10, 17, 15, 0, 0);

function page(db = openDb(":memory:")): PageCtx {
  const config = {
    instances: [{ id: "main", name: "Prod", url: "http://dozzle.invalid", auth: { mode: "none" } }],
    dbPath: "",
    port: 1,
    basePath: "/reporting",
    publicUrl: "http://x",
    retentionDays: 30,
    bucketSeconds: 30,
    reviewHour: 21,
    timezone: "Europe/Brussels",
    allowActions: false,
    hubConfigured: true,
    notifyChannel: "general",
    notifyEmail: "ops@example.com",
    smtp: { host: "127.0.0.1", port: 2525, from: "noreply@example.com" },
    mcpAdvertiseUrl: "http://mcp.example/mcp",
  } as Config;
  return { db, config, lang: "en", now, query: new URLSearchParams() };
}

describe("labels", () => {
  it("does not stack a second v on a version that already has one", () => {
    expect(verLabel("v11.3.4")).toBe("v11.3.4");
    expect(verLabel("vv11.3.4")).toBe("v11.3.4");
    expect(verLabel("11.4.3")).toBe("v11.4.3");
    expect(hostRole("local")).toBe("server");
    expect(hostRole("agent")).toBe("agent");
  });

  it("keeps the same keys in both languages", () => {
    expect(Object.keys(DICT.fr).sort()).toEqual(Object.keys(DICT.en).sort());
  });
});

describe("instances and metrics", () => {
  it("counts live containers, marks the engine as server, and keeps the agent version", () => {
    const c = page();
    const host = c.db.prepare("INSERT INTO hosts(instance_id,id,name,json,last_seen) VALUES(?,?,?,?,?)");
    host.run("main", "local", "vm-docker", JSON.stringify({ type: "local", nCPU: 4, memTotal: 4e9 }), now);
    host.run("main", "agent", "vm-compute-01", JSON.stringify({ type: "agent", agentVersion: "v11.4.3", nCPU: 16, memTotal: 8e9 }), now);
    const box = c.db.prepare("INSERT INTO containers(instance_id,id,host,name,state,first_seen,last_seen) VALUES(?,?,?,?,?,?,?)");
    box.run("main", "a", "agent", "web", "running", now, now);
    box.run("main", "ghost", "agent", "old", "running", now - 86_400_000, now - 86_400_000);
    box.run("main", "s", "local", "caddy", "running", now, now);
    const live = c.db.prepare("INSERT INTO live_metrics(instance_id,container_id,container_name,host,ts,cpu,cpu_max,mem,mem_pct,net_rx,net_tx,disk_r,disk_w) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    live.run("main", "a", "web", "agent", now, 160, 200, 1e9, 10, 0, 0, 0, 0);
    live.run("main", "s", "caddy", "local", now, 40, 40, 1e8, 2, 0, 0, 0, 0);
    const html = instancesPage(c, new Map([["main", "v11.3.4"]]));
    expect(html).toContain("v11.4.3");
    expect(html).toContain("v11.3.4");
    expect(html).not.toContain("vv");
    expect(html).toContain(">server<");
    expect(html).toContain(">agent<");
    expect(html).toContain("1 containers");
    expect(html).toContain("Emailed to you when there is something to report");
    const metrics = metricsPage(c);
    // 160% on 16 cores + 40% on 4 cores = 10% + 10%. The header is that sum.
    // The card still shows the container's own 160% and its 200% peak.
    expect(metrics).toContain("CPU now</div><div class=\"v\">20%</div>");
    expect(metrics).toContain(">160%</b>");
    expect(metrics).toContain("peak 200%");
  });
});

describe("integrations", () => {
  it("frames the mute control and lists the hub channels", () => {
    const html = integrationsPage(page());
    expect(html).toContain('class="mutebox"');
    expect(html).toContain('name="for" value="1h"');
    expect(html).toContain("ops@example.com");
    const chat = integrationsPage({ ...page(), query: new URLSearchParams("tab=chat") });
    expect(chat).toContain("Discord");
    expect(chat).toContain("Telegram");
    expect(chat).toContain("Zulip");
    expect(chat).not.toContain("No chat integration");
  });
});

describe("tokens and digest", () => {
  it("stores a hash and accepts the secret once", () => {
    const db = openDb(":memory:");
    const made = createToken(db, "opencode", now);
    expect(made.secret.startsWith("dz_")).toBe(true);
    expect(findToken(db, made.secret)?.name).toBe("opencode");
    expect(findToken(db, "dz_nope")).toBeUndefined();
    revokeToken(db, made.id);
    expect(findToken(db, made.secret)).toBeUndefined();
    expect(() => createToken(db, "bad/name")).toThrow(/invalid/);
  });

  it("mutes until a deadline and skips an empty digest", () => {
    const db = openDb(":memory:");
    expect(isMuted(db, now)).toBe(false);
    setMuteUntil(db, muteDeadline("1h", now, "UTC"));
    expect(isMuted(db, now + 1000)).toBe(true);
    expect(isMuted(db, now + 3_600_000)).toBe(false);
    expect(digestText(db, "en", now)).toBeUndefined();
    db.prepare("INSERT INTO alerts(ts,last_ts,instance_id,source,kind,level,fingerprint,title,status,container_name) VALUES(?,?,?,?,?,?,?,?,?,?)").run(now - 1000, now - 1000, "main", "rule", "log", "error", "fp", "disk full", "sent", "web");
    const text = digestText(db, "fr", now);
    expect(text?.subject).toContain("rapport");
    expect(text?.text).toContain("disk full");
    const midnight = nextMidnight("Europe/Brussels", now);
    const hour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", hour: "2-digit", hourCycle: "h23" }).format(new Date(midnight));
    expect(["00", "24"]).toContain(hour);
  });
});

describe("smtp", () => {
  it("sends a message to a local relay without AUTH", async () => {
    const got: string[] = [];
    const srv = createServer((sock) => {
      sock.write("220 ready\r\n");
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\r\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          got.push(line);
          if (line.startsWith("EHLO") || line.startsWith("MAIL") || line.startsWith("RCPT") || line === ".") sock.write("250 ok\r\n");
          else if (line === "DATA") sock.write("354 go\r\n");
          else if (line === "QUIT") {
            sock.write("221 bye\r\n");
            sock.end();
          }
        }
      });
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = (srv.address() as { port: number }).port;
    await sendMail({ host: "127.0.0.1", port, from: "a@example.com", to: "b@example.com", subject: "hi", text: "body" });
    srv.close();
    expect(got.some((line) => line === "MAIL FROM:<a@example.com>")).toBe(true);
    expect(got.some((line) => line === "RCPT TO:<b@example.com>")).toBe(true);
  });
});
