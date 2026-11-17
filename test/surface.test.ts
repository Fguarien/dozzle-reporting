import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.ts";
import { DICT } from "../src/web/i18n.ts";
import { alertDetail, alertsPage, findings, hostRole, instancesPage, integrationsPage, layout, logsPage, metricsPage, parseAccess, parseLogsql, verLabel, type PageCtx } from "../src/web/ui.ts";
import type { Config } from "../src/config.ts";
import { kvSet } from "../src/store/db.ts";
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

  it("puts the viewer and the cloud pages in the same menu", () => {
    const html = layout(page(), "", "Overview", "");
    expect(html).toContain('href="/">');
    expect(html).toContain("Containers</a>");
    expect(html).toContain('href="/reporting/findings"');
    expect(html).toContain('href="/reporting/logs"');
    expect(html).toContain('href="/notifications"');
    expect(html).toContain('href="/settings"');
    expect(html).toContain('href="/reporting/ask"');
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

describe("logs, findings, alerts", () => {
  it("shows the container filter, the live switch and the loaded lines", () => {
    const c = page();
    c.db.prepare("INSERT INTO containers(instance_id,id,host,name,state,first_seen,last_seen) VALUES(?,?,?,?,?,?,?)").run("main", "n", "local", "nginx", "running", now, now);
    const bare = logsPage(c);
    expect(bare).toContain("All containers");
    expect(bare).toContain(">Live<");
    expect(bare).toContain("nginx");
    expect(bare).not.toContain("events loaded");
    const html = logsPage(c, {
      rows: [{ ts: now - 60_000, level: "info", container: "authentik-server", message: '127.0.0.1 - - "GET / HTTP/1.1" 302' }],
      ms: 12,
      from: now - 15 * 60_000,
      to: now,
    });
    expect(html).toContain('class="vol"');
    expect(html).toContain("1 events loaded");
    expect(html).toContain("in 12ms");
    expect(html).toContain("drag to zoom");
    expect(html).toContain("15:59:00.000");
    expect(html).toContain(">now<");
    expect(html).toContain("authentik-server");
    expect(html).toContain(">GET<");
    expect(html).toContain(">302<");
    expect(html).toContain("<td>/</td>");
    const indexed = logsPage(c, {
      rows: [{ ts: now - 60_000, level: "info", container: "tailscale-dns", message: "[INFO] A IN www.google.com" }],
      ms: 9,
      from: now - 12 * 86_400_000,
      to: now,
      total: 2_090_370,
    });
    expect(indexed).toContain("2,090,370");
    expect(indexed).toContain("1 events loaded");
    expect(indexed).toContain("tailscale-dns");
    expect(indexed).not.toContain("does not keep an index");
    expect(parseAccess('127.0.0.1 - - "GET / HTTP/1.1" 302').status).toBe("302");
    expect(parseLogsql("LogsQL level:error AND container_name:nginx")).toEqual({ query: undefined, container: "nginx", levels: ["error"] });
  });

  it("filters findings by the selected window", () => {
    const c = page();
    const ins = c.db.prepare("INSERT INTO findings(created,updated,last_seen,instance_id,fingerprint,severity,status,containers,headline) VALUES(?,?,?,?,?,?,?,?,?)");
    ins.run(now - 3_600_000, now - 60_000, now - 60_000, "main", "fresh", "high", "open", "[]", "fresh finding");
    ins.run(now - 5 * 86_400_000, now - 2 * 86_400_000, now - 2 * 86_400_000, "main", "old", "low", "open", "[]", "old finding");
    const all = findings(c);
    expect(all).toContain("fresh finding");
    expect(all).toContain("old finding");
    expect(all).toContain(">15m<");
    expect(all).toContain(">12h<");
    const recent = findings({ ...c, query: new URLSearchParams("w=15m") });
    expect(recent).toContain("fresh finding");
    expect(recent).not.toContain("old finding");
  });

  it("links an alert to a detail page with the investigation card", () => {
    const c = page();
    c.db.prepare("INSERT INTO alerts(ts,last_ts,instance_id,source,kind,level,fingerprint,title,status,container_name,sample,summary,event_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      now, now, "main", "e2e", "log", "error", "fp1", "dzr-temoin signale une erreur fatale", "sent", "temoin", "temoin dozzle-reporting e2e 2026-11-16", "Le journal fatal contient le message.", 1,
    );
    const list = alertsPage(c, "alerts");
    expect(list).toContain('href="/reporting/alerts/1"');
    const detail = alertDetail(c, 1);
    expect(detail).toContain("Back to alerts");
    expect(detail).toContain("Root cause still unclear");
    expect(detail).toContain("Run full investigation");
    expect(detail).toContain("What was checked (1)");
    expect(detail).toContain("temoin dozzle-reporting e2e 2026-11-16");
    expect(detail).toContain('value="investigate"');
    kvSet(c.db, "alert:invest:1", JSON.stringify({ text: "The fatal line is the test probe.", at: now, checked: ["logs", "events"] }));
    const done = alertDetail(c, 1);
    expect(done).toContain("The fatal line is the test probe.");
    expect(done).toContain("Investigation");
    expect(done).not.toContain("Root cause still unclear");
    expect(done).toContain("What was checked (3)");
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
