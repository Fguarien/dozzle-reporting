import { readFileSync } from "node:fs";
import type { Db } from "../store/db.ts";
import type { Config } from "../config.ts";
import { t, type Lang, type Key } from "./i18n.ts";

/** HTML escaping for every interpolated value. */
export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface PageCtx {
  db: Db;
  config: Config;
  lang: Lang;
  user?: string;
  breakglass?: boolean;
  now: number;
  query: URLSearchParams;
}

const H = 3_600_000;

const CSS = `
:root{--bg:#fff;--panel:#fafafa;--side:#f5f5f5;--fg:#111;--muted:#666;--line:#e6e6e6;--accent:#0f9d8a;--warn:#c27c0e;--err:#d33;--ok:#15a34a;--chip:#eef6f4;--cpu:#0f9d8a;--mem:#c8902b;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0b0b0b;--panel:#121212;--side:#0f0f0f;--fg:#ededed;--muted:#9a9a9a;--line:#262626;--chip:#10241f;color-scheme:dark}}
:root[data-theme=dark]{--bg:#0b0b0b;--panel:#121212;--side:#0f0f0f;--fg:#ededed;--muted:#9a9a9a;--line:#262626;--chip:#10241f;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:inherit}a.link{color:var(--accent);text-decoration:none}
.shell{display:grid;grid-template-columns:230px 1fr;min-height:100vh}
aside{background:var(--side);border-right:1px solid var(--line);padding:16px 12px;position:sticky;top:0;height:100vh}
aside .brand{font-weight:700;font-size:17px;padding:4px 8px 16px;display:flex;gap:8px;align-items:center}
aside .brand small{font:600 10px/1 ui-monospace,monospace;color:var(--accent);border:1px solid var(--accent);border-radius:4px;padding:2px 4px}
aside nav a{display:block;padding:7px 10px;border-radius:8px;text-decoration:none;color:var(--fg);margin:1px 0}
aside nav a.on{background:var(--line);font-weight:600}aside nav hr{border:0;border-top:1px solid var(--line);margin:10px 8px}
header.top{display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:10px 24px;border-bottom:1px solid var(--line)}
header.top form{flex:1;max-width:480px;margin-right:auto}header.top input{width:100%}
button,input,select{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 10px}
button{cursor:pointer}main{padding:28px 32px;max-width:1180px}
h1{font-size:30px;margin:6px 0 10px;letter-spacing:-.02em}h2{font-size:17px;margin:28px 0 10px}
.muted{color:var(--muted)}.date{color:var(--muted);font-size:14px}.date:before{content:"● ";color:var(--accent)}
.row{display:flex;gap:14px;align-items:flex-start;padding:12px 4px;border-bottom:1px solid var(--line)}
.row .t{width:76px;color:var(--muted);font-size:13px;flex:none}.row .b{flex:1}.row .s{font-size:13px;color:var(--muted)}
.card{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:16px 18px;margin:10px 0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:24px}.grid3{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.big{font-size:34px;font-weight:700;letter-spacing:-.02em}
.kv{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0}
.chip{display:inline-block;font-size:12px;padding:1px 8px;border-radius:99px;background:var(--chip);color:var(--accent)}
.chip.err{background:#fde8e8;color:var(--err)}.chip.warn{background:#fdf2e1;color:var(--warn)}.chip.ok{background:#e5f6ec;color:var(--ok)}.chip.q{background:var(--line);color:var(--muted)}
.tabs{display:flex;gap:6px;margin:14px 0}.tabs a{padding:6px 12px;border-radius:8px;text-decoration:none;border:1px solid var(--line)}.tabs a.on{background:var(--fg);color:var(--bg)}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
pre{white-space:pre-wrap;word-break:break-word;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}
.mono{font-family:ui-monospace,monospace;font-size:13px}svg.spark{display:block}
.mc h3{font-size:14px;margin:0 0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mc .l{font-size:12px;color:var(--muted)}
@media (max-width:820px){.shell{grid-template-columns:1fr}aside{position:static;height:auto}.grid2{grid-template-columns:1fr}main{padding:18px 16px}}
`;

const THEME_JS = `(function(){var k="dozzle-reporting-theme";var v=null;try{v=localStorage.getItem(k)}catch(e){}if(v==="light"||v==="dark")document.documentElement.setAttribute("data-theme",v);
window.cycleTheme=function(){var cur=document.documentElement.getAttribute("data-theme");var nxt=cur===null?"light":cur==="light"?"dark":null;
if(nxt)document.documentElement.setAttribute("data-theme",nxt);else document.documentElement.removeAttribute("data-theme");try{nxt?localStorage.setItem(k,nxt):localStorage.removeItem(k)}catch(e){}label()};
function label(){var b=document.getElementById("themebtn");if(!b)return;var c=document.documentElement.getAttribute("data-theme");b.textContent=b.dataset[c||"auto"]}
document.addEventListener("DOMContentLoaded",label)})();
window.cycleLang=function(){var l=document.documentElement.lang==="fr"?"en":"fr";document.cookie="lang="+l+";path=/;max-age=31536000;samesite=lax";location.reload()};`;

let headInclude: string | undefined;
function extraHead(cfg: Config): string {
  if (headInclude !== undefined) return headInclude;
  const p = process.env["HEAD_INCLUDE"];
  headInclude = p ? readFileSync(p, "utf8") : "";
  void cfg;
  return headInclude;
}

const NAV: [string, Key][] = [
  ["", "overview"],
  ["/findings", "findings"],
  ["/updates", "updates"],
  ["/alerts", "alerts"],
  ["-", "overview"],
  ["/logs", "logs"],
  ["/metrics", "metrics"],
  ["-", "overview"],
  ["/instances", "instances"],
  ["/integrations", "integrations"],
];

export function layout(c: PageCtx, active: string, title: string, body: string): string {
  const b = c.config.basePath;
  const L = (k: Key, v?: Record<string, string | number>) => esc(t(c.lang, k, v));
  const nav = NAV.map(([p, k]) => (p === "-" ? "<hr>" : `<a href="${b}${p}" class="${active === p ? "on" : ""}">${L(k)}</a>`)).join("");
  return `<!doctype html><html lang="${c.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Dozzle Reporting</title><style>${CSS}</style><script>${THEME_JS}</script>${extraHead(c.config)}</head>
<body><div class="shell"><aside><div class="brand">Dozzle Reporting <small>SELF-HOSTED</small></div><nav>${nav}</nav></aside>
<div><header class="top"><form action="${b}/logs"><input name="q" placeholder="${L("query")}"></form>
<button id="langbtn" onclick="cycleLang()" data-lang="${c.lang}">${c.lang.toUpperCase()}</button>
<button id="themebtn" onclick="cycleTheme()" data-auto="${L("auto")}" data-light="${L("light")}" data-dark="${L("dark")}">${L("auto")}</button>
${c.user ? `<span class="muted">${esc(c.user)}</span> <a class="link" href="${b}/auth/logout">${L("signOut")}</a>` : ""}</header>
<main>${c.breakglass ? `<div class="card" style="background:#b91c1c;color:#fff;border:0">Session de secours (1 h) · Break-glass session (1 h)</div>` : ""}${body}</main></div></div></body></html>`;
}

function fmtTime(ms: number, c: PageCtx, withDate = false): string {
  return new Date(ms).toLocaleString(c.lang === "fr" ? "fr-BE" : "en-GB", {
    timeZone: c.config.timezone,
    hour: "2-digit",
    minute: "2-digit",
    ...(withDate ? { day: "2-digit", month: "short" } : {}),
  });
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) (v /= 1024), i++;
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

const pctS = (n: number | null | undefined) => (n === null || n === undefined ? "-" : `${n.toFixed(n >= 10 ? 0 : 1)}%`);

/** Inline SVG sparkline, no client JS. */
export function spark(values: number[], color: string, w = 120, h = 28): string {
  if (values.length < 2) return `<svg class="spark" width="${w}" height="${h}"></svg>`;
  const max = Math.max(...values, 1e-9);
  const pts = values.map((v, i) => `${Math.round((i / (values.length - 1)) * w)},${Math.round(h - 2 - (v / max) * (h - 4))}`);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polygon points="0,${h} ${pts.join(" ")} ${w},${h}" fill="${color}" opacity=".15"/><polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}

function seriesFor(db: Db, instance: string, host: string, name: string, from: number, field: "cpu_avg" | "mem_avg", points = 30): number[] {
  from = dataFrom(db, from);
  const step = Math.max(30_000, Math.ceil((Date.now() - from) / points / 30_000) * 30_000);
  return (db.prepare(`SELECT avg(${field}) v FROM metrics WHERE instance_id=? AND host=? AND container_name=? AND ts>=? GROUP BY CAST(ts / ? AS INTEGER) ORDER BY ts`).all(instance, host, name, from, step) as { v: number }[]).map((r) => r.v);
}

/** All sparklines of a page in ONE query: key "instance|host|name" → cpu[] and mem[]. */
/** Span actually covered by data: a 24 h window over 1 h of history must not draw 2 points. */
function dataFrom(db: Db, from: number): number {
  const r = db.prepare("SELECT min(ts) t FROM metrics WHERE ts>=?").get(from) as { t: number | null };
  return Math.max(from, r.t ?? from);
}

function seriesAll(db: Db, from: number, now: number, points = 24): Map<string, { cpu: number[]; mem: number[] }> {
  from = dataFrom(db, from);
  const step = Math.max(30_000, Math.ceil((now - from) / points / 30_000) * 30_000);
  const rows = db
    .prepare(`SELECT instance_id i, host h, container_name n, CAST(ts / ? AS INTEGER) b, avg(cpu_avg) c, avg(mem_avg) m FROM metrics WHERE ts>=? GROUP BY i, h, n, b ORDER BY i, h, n, b`)
    .all(step, from) as { i: string; h: string; n: string; c: number; m: number }[];
  const out = new Map<string, { cpu: number[]; mem: number[] }>();
  for (const r of rows) {
    const k = `${r.i}|${r.h}|${r.n}`;
    let e = out.get(k);
    if (!e) out.set(k, (e = { cpu: [], mem: [] }));
    e.cpu.push(r.c);
    e.mem.push(r.m);
  }
  return out;
}

function hostNames(db: Db): Map<string, string> {
  return new Map((db.prepare("SELECT id, name FROM hosts").all() as { id: string; name: string }[]).map((r) => [r.id, r.name]));
}

// ─────────────────────────── pages ───────────────────────────

export function overview(c: PageCtx): string {
  const { db, now } = c;
  const L = (k: Key, v?: Record<string, string | number>) => esc(t(c.lang, k, v));
  const b = c.config.basePath;
  const day0 = new Date(new Date(now).toLocaleString("en-US", { timeZone: c.config.timezone })).setHours(0, 0, 0, 0) - (new Date(new Date(now).toLocaleString("en-US", { timeZone: c.config.timezone })).getTime() - now);
  const sentToday = (db.prepare("SELECT count(*) n FROM alerts WHERE status='sent' AND ts>=?").get(day0) as { n: number }).n;
  const wk = db.prepare("SELECT sum(status='sent') s, sum(status<>'sent') q FROM alerts WHERE ts>=?").get(now - 7 * 24 * H) as { s: number | null; q: number | null };
  const s = wk.s ?? 0, q = wk.q ?? 0;
  const happened = db
    .prepare(
      `SELECT ts, 'alert' k, title, status, container_name FROM alerts WHERE ts>=? AND status='sent'
       UNION ALL SELECT resolved_at ts, 'resolved' k, headline title, 'resolved' status, containers container_name FROM findings WHERE resolved_at>=?
       ORDER BY ts DESC LIMIT 12`,
    )
    .all(now - 24 * H, now - 24 * H) as { ts: number; k: string; title: string; status: string }[];
  const open = db.prepare("SELECT * FROM findings WHERE status IN ('open','ongoing') AND ignored=0 ORDER BY updated DESC LIMIT 5").all() as Record<string, string & number>[];
  const totals = db.prepare("SELECT sum(cpu) cpu, sum(mem) mem, count(*) n FROM (SELECT container_id, avg(cpu_avg) cpu, avg(mem_avg) mem FROM metrics WHERE ts>=? GROUP BY instance_id, container_id)").get(now - 15 * 60_000) as { cpu: number; mem: number; n: number };
  const top = (field: "cpu_avg" | "mem_avg") =>
    db.prepare(`SELECT instance_id, host, container_name name, avg(${field}) v FROM metrics WHERE ts>=? GROUP BY instance_id, host, container_name ORDER BY v DESC LIMIT 5`).all(now - 24 * H) as { instance_id: string; host: string; name: string; v: number }[];
  const topList = (field: "cpu_avg" | "mem_avg", color: string) =>
    top(field)
      .map((r) => `<div class="kv"><span>${esc(r.name)}</span><span style="display:flex;gap:8px;align-items:center">${spark(seriesFor(db, r.instance_id, r.host, r.name, now - 24 * H, field), color, 70, 24)}<span class="mono">${field === "cpu_avg" ? pctS(r.v) : fmtBytes(r.v)}</span></span></div>`)
      .join("");
  const dateStr = new Date(now).toLocaleDateString(c.lang === "fr" ? "fr-BE" : "en-GB", { timeZone: c.config.timezone, weekday: "long", day: "numeric", month: "long" });
  return layout(
    c,
    "",
    t(c.lang, "overview"),
    `<div class="date">${esc(dateStr)}</div>
<h1>${sentToday ? L("sentToday", { n: sentToday }) : L("noneToday")}</h1>
<p class="muted">${L("weekLine", { sent: s, quiet: q, pct: s + q ? Math.round((100 * q) / (s + q)) : 0 })} · <a class="link" href="${b}/alerts">${L("viewAlerts")}</a></p>
<h2>${L("whatHappened")} <span class="muted" style="float:right;font-size:13px;font-weight:400">${L("last24h")}</span></h2>
${happened.map((h) => `<div class="row"><div class="t">${fmtTime(h.ts, c)}</div><div class="b">${h.k === "resolved" ? `<span class="chip ok">${L("resolved")}</span>` : `<span class="chip">${L("alertSent")}</span>`} ${esc(h.title)}</div></div>`).join("") || `<p class="muted">—</p>`}
<h2>${L("worthFixing")}</h2>
${open.length ? open.map((f) => `<div class="card"><span class="chip ${f.severity === "high" || f.severity === "critical" ? "err" : "warn"}">${esc(f.severity)}</span> <b>${esc(f.headline)}</b><div class="muted">${esc(JSON.parse(String(f.containers)).join(", "))}</div></div>`).join("") : `<div class="card">✓ ${L("nothingToFix")}</div>`}
<h2>${L("resources24h")} <a class="link" style="float:right;font-size:13px;font-weight:400" href="${b}/metrics">${L("allMetrics")}</a></h2>
<div class="grid2"><div><div class="muted">${L("cpu")}</div><div class="big">${((totals.cpu ?? 0) / 100).toFixed(1)} <span style="font-size:18px">${c.lang === "fr" ? "cœurs" : "cores"}</span></div><div class="muted">${L("acrossN", { n: totals.n ?? 0 })}</div>${topList("cpu_avg", "var(--cpu)")}</div>
<div><div class="muted">${L("memory")}</div><div class="big">${fmtBytes(totals.mem)}</div><div class="muted">${L("acrossN", { n: totals.n ?? 0 })}</div>${topList("mem_avg", "var(--mem)")}</div></div>`,
  );
}

export function findings(c: PageCtx): string {
  const L = (k: Key, v?: Record<string, string | number>) => esc(t(c.lang, k, v));
  const tab = c.query.get("tab") ?? "open";
  const where = tab === "all" ? "1=1" : tab === "resolved" ? "status='resolved'" : tab === "ignored" ? "ignored=1" : "status IN ('open','ongoing') AND ignored=0";
  const rows = c.db.prepare(`SELECT * FROM findings WHERE ${where} ORDER BY (status='resolved'), updated DESC LIMIT 200`).all() as Record<string, string & number>[];
  const count = (w: string) => (c.db.prepare(`SELECT count(*) n FROM findings WHERE ${w}`).get() as { n: number }).n;
  const b = c.config.basePath;
  const tabs = [
    ["open", "needsAttention", count("status IN ('open','ongoing') AND ignored=0")],
    ["all", "all", count("1=1")],
    ["resolved", "resolved", count("status='resolved'")],
    ["ignored", "ignored", count("ignored=1")],
  ] as const;
  return layout(
    c,
    "/findings",
    t(c.lang, "findings"),
    `<h1>${L("findings")}</h1><p class="muted">${L("findingsIntro")}</p>
<p class="muted">${c.config.llm ? L("nextReview", { when: `${String(c.config.reviewHour).padStart(2, "0")}:00` }) : L("noLlm")}</p>
<div class="tabs">${tabs.map(([k, l, n]) => `<a class="${tab === k ? "on" : ""}" href="${b}/findings?tab=${k}">${L(l)} ${n}</a>`).join("")}</div>
${rows.length ? rows.map((f) => `<div class="card"><span class="chip ${f.status === "resolved" ? "ok" : f.severity === "high" || f.severity === "critical" ? "err" : "warn"}">${esc(f.status === "resolved" ? t(c.lang, "resolved") : f.severity)}</span> <span class="muted">#${f.id} · ${L("daysOpen", { n: Math.max(0, Math.floor(((f.resolved_at || c.now) - f.created) / 864e5)) })}</span><h3 style="margin:8px 0 4px">${esc(f.headline)}</h3><div class="muted">${esc(JSON.parse(String(f.containers)).join(", "))}</div>${f.why ? `<p><b>${L("why")}.</b> ${esc(f.why)}</p>` : ""}${f.fix ? `<p><b>${L("fix")}.</b> ${esc(f.fix)}</p>` : ""}</div>`).join("") : `<div class="card">✓ ${L("nothingToFix")}</div>`}`,
  );
}

export function updates(c: PageCtx): string {
  const L = (k: Key) => esc(t(c.lang, k));
  const hn = hostNames(c.db);
  const rows = c.db.prepare("SELECT * FROM changes WHERE kind IN ('image','config','update-request') AND ts>=? ORDER BY ts DESC LIMIT 300").all(c.now - 30 * 24 * H) as Record<string, string & number>[];
  return layout(
    c,
    "/updates",
    t(c.lang, "updates"),
    `<h1>${L("updates")}</h1><p class="muted">${L("updatesIntro")}</p>
${rows.length ? `<table><tr><th>${L("when")}</th><th>${L("container")}</th><th></th><th></th></tr>${rows.map((r) => `<tr><td class="mono">${fmtTime(r.ts, c, true)}</td><td>${esc(r.container_name)} <span class="muted">@ ${esc(hn.get(r.host) ?? r.host)}</span></td><td><span class="chip ${r.origin === "dozzle" ? "" : "q"}">${esc(r.kind)} · ${esc(r.origin === "dozzle" ? "Dozzle" : "outside")}</span></td><td class="mono">${esc(r.before ?? "")} → ${esc(r.after ?? r.detail ?? "")}</td></tr>`).join("")}</table>` : `<div class="card">${L("noUpdates")}</div>`}`,
  );
}

export function alertsPage(c: PageCtx, tab: "alerts" | "events" | "muted"): string {
  const L = (k: Key, v?: Record<string, string | number>) => esc(t(c.lang, k, v));
  const b = c.config.basePath;
  const hn = hostNames(c.db);
  let body = "";
  if (tab === "alerts") {
    const rows = c.db.prepare("SELECT * FROM alerts WHERE ts>=? ORDER BY ts DESC LIMIT 200").all(c.now - 14 * 24 * H) as Record<string, string & number>[];
    body = rows.length
      ? rows
          .map(
            (a) =>
              `<div class="card"><span class="chip ${a.status === "sent" ? (a.level === "error" ? "err" : "warn") : "q"}">${esc(a.status === "sent" ? t(c.lang, "alertSent") : a.status === "muted" ? t(c.lang, "muted") : `${t(c.lang, "suppressed")} · ${a.suppressed_reason}`)}</span> <span class="muted">#${a.id} · ${fmtTime(a.ts, c, true)} · ${esc(a.source)}</span><h3 style="margin:8px 0 4px">${esc(a.title)}</h3>${a.summary ? `<p>${esc(a.summary)}</p>` : a.sample ? `<pre class="muted">${esc(String(a.sample).slice(0, 600))}</pre>` : ""}<div class="muted">${esc(a.container_name)} · ${L("eventsN", { n: a.event_count })}${a.absorbed ? ` · ${a.absorbed} ${L("absorbed")}` : ""}</div></div>`,
          )
          .join("")
      : `<div class="card">${L("noAlerts")}</div>`;
  } else if (tab === "events") {
    const rows = c.db.prepare("SELECT * FROM events WHERE ts>=? ORDER BY ts DESC LIMIT 300").all(c.now - 7 * 24 * H) as Record<string, string & number>[];
    body = `<table><tr><th>${L("when")}</th><th>${L("level")}</th><th></th><th>${L("container")}</th><th></th></tr>${rows.map((e) => `<tr><td class="mono">${fmtTime(e.ts, c, true)}</td><td><span class="chip ${e.level === "error" ? "err" : e.level === "warning" ? "warn" : "q"}">${esc(e.level)}</span></td><td>${esc(e.name)}</td><td>${esc(e.container_name)} <span class="muted">@ ${esc(hn.get(e.host) ?? "")}</span></td><td class="mono muted">${esc(e.detail ?? "")}</td></tr>`).join("")}</table>`;
  } else {
    const rows = c.db.prepare("SELECT * FROM mute_rules WHERE active=1 ORDER BY created DESC").all() as Record<string, string & number>[];
    body = rows.length ? `<table>${rows.map((m) => `<tr><td>#${m.alert_id}</td><td>${esc(m.kind)}</td><td>${esc(m.container_name ?? "*")}</td><td class="mono">${esc(m.patterns)}</td></tr>`).join("")}</table>` : `<div class="card">${L("noMutes")}</div>`;
  }
  const tabs = (["alerts", "events", "muted"] as const).map((k) => `<a class="${tab === k ? "on" : ""}" href="${b}/alerts${k === "alerts" ? "" : "/" + k}">${L(k === "alerts" ? "alerts" : k === "events" ? "events" : "muted")}</a>`).join("");
  return layout(c, "/alerts", t(c.lang, "alerts"), `<h1>${L("alerts")}</h1><p class="muted">${L("alertsIntro")}</p><div class="tabs">${tabs}</div>${body}`);
}

export function metricsPage(c: PageCtx): string {
  const L = (k: Key, v?: Record<string, string | number>) => esc(t(c.lang, k, v));
  const sort = c.query.get("sort") === "memory" ? "mem_avg" : "cpu_avg";
  const hours = Math.min(720, Math.max(1, Number(c.query.get("h") ?? 24)));
  const from = c.now - hours * H;
  const hn = hostNames(c.db);
  const rows = c.db
    .prepare(`SELECT instance_id, host, container_name name, avg(cpu_avg) cpu, max(cpu_max) cpu_pk, avg(mem_avg) mem, avg(mem_pct_avg) pct FROM metrics WHERE ts>=? GROUP BY instance_id, host, container_name ORDER BY host, ${sort === "mem_avg" ? "mem" : "cpu"} DESC`)
    .all(from) as { instance_id: string; host: string; name: string; cpu: number; cpu_pk: number; mem: number; pct: number }[];
  const series = seriesAll(c.db, from, c.now);
  const sp = (r: { instance_id: string; host: string; name: string }) => series.get(`${r.instance_id}|${r.host}|${r.name}`) ?? { cpu: [], mem: [] };
  const byHost = new Map<string, typeof rows>();
  for (const r of rows) byHost.set(r.host, [...(byHost.get(r.host) ?? []), r]);
  const b = c.config.basePath;
  const cards = [...byHost.entries()]
    .map(([h, rs]) => {
      const cpu = rs.reduce((s, r) => s + r.cpu, 0);
      const mem = rs.reduce((s, r) => s + r.mem, 0);
      return `<h2>${esc(hn.get(h) ?? h)} <span class="muted" style="font-weight:400;font-size:13px">${rs.length} ${L("containers")} · ${pctS(cpu)} · ${fmtBytes(mem)}</span></h2><div class="grid3">${rs
        .map(
          (r) =>
            `<a class="card mc" style="text-decoration:none;margin:0" href="${b}/metrics/${encodeURIComponent(r.instance_id)}/${encodeURIComponent(r.host)}/${encodeURIComponent(r.name)}?h=${hours}"><h3>${esc(r.name)}</h3><div class="kv"><div><div class="l">${L("cpu")}</div><b>${pctS(r.cpu)}</b> <span class="l">${L("peak")} ${pctS(r.cpu_pk)}</span></div>${spark(sp(r).cpu, "var(--cpu)", 90, 26)}</div><div class="kv"><div><div class="l">${L("memory")}</div><b>${fmtBytes(r.mem)}</b> <span class="l">${pctS(r.pct)} ${L("ofLimit")}</span></div>${spark(sp(r).mem, "var(--mem)", 90, 26)}</div></a>`,
        )
        .join("")}</div>`;
    })
    .join("");
  const sel = (v: string, cur: string, label: string) => `<option value="${v}" ${v === cur ? "selected" : ""}>${label}</option>`;
  return layout(
    c,
    "/metrics",
    t(c.lang, "metrics"),
    `<h1>${L("metrics")}</h1><p class="muted">${L("metricsIntro")}</p>
<form class="tabs"><select name="h" onchange="this.form.submit()">${sel("1", String(hours), "1h")}${sel("6", String(hours), "6h")}${sel("24", String(hours), "24h")}${sel("168", String(hours), "7d")}${sel("720", String(hours), "30d")}</select>
<select name="sort" onchange="this.form.submit()">${sel("cpu", sort === "cpu_avg" ? "cpu" : "memory", `${t(c.lang, "sortBy")} CPU`)}${sel("memory", sort === "cpu_avg" ? "cpu" : "memory", `${t(c.lang, "sortBy")} ${t(c.lang, "memory")}`)}</select></form>${cards}`,
  );
}

export function metricDetail(c: PageCtx, instance: string, host: string, name: string): string {
  const L = (k: Key) => esc(t(c.lang, k));
  const hours = Math.min(720, Math.max(1, Number(c.query.get("h") ?? 24)));
  const from = c.now - hours * H;
  const pts = Math.min(120, hours * 4);
  const big = (field: "cpu_avg" | "mem_avg", color: string) => spark(seriesFor(c.db, instance, host, name, from, field, pts), color, 900, 140);
  const ev = c.db.prepare("SELECT ts,name,level,detail FROM events WHERE instance_id=? AND host=? AND container_name=? AND ts>=? ORDER BY ts DESC LIMIT 50").all(instance, host, name, from) as Record<string, string & number>[];
  return layout(
    c,
    "/metrics",
    name,
    `<h1>${esc(name)}</h1><p class="muted">${esc(hostNames(c.db).get(host) ?? host)} · ${hours}h</p>
<h2>${L("cpu")}</h2><div class="card">${big("cpu_avg", "var(--cpu)")}</div><h2>${L("memory")}</h2><div class="card">${big("mem_avg", "var(--mem)")}</div>
<h2>${L("events")}</h2>${ev.map((e) => `<div class="row"><div class="t">${fmtTime(e.ts, c, true)}</div><div class="b"><span class="chip ${e.level === "error" ? "err" : "q"}">${esc(e.name)}</span> <span class="mono muted">${esc(e.detail ?? "")}</span></div></div>`).join("") || `<p class="muted">—</p>`}`,
  );
}

export function logsPage(c: PageCtx, result: string | undefined): string {
  const L = (k: Key) => esc(t(c.lang, k));
  const q = c.query;
  return layout(
    c,
    "/logs",
    t(c.lang, "logs"),
    `<h1>${L("logs")}</h1><p class="muted">${L("logsIntro")}</p>
<form class="tabs" style="flex-wrap:wrap"><input name="container" placeholder="${L("container")}" value="${esc(q.get("container") ?? "")}">
<input name="q" placeholder="${L("query")}" value="${esc(q.get("q") ?? "")}" style="min-width:260px">
<select name="after">${["15m", "1h", "6h", "24h", "7d"].map((w) => `<option ${q.get("after") === w ? "selected" : ""}>${w}</option>`).join("")}</select>
<button>${L("search")}</button></form>${result !== undefined ? `<div class="card"><pre>${esc(result)}</pre></div>` : ""}`,
  );
}

export function instancesPage(c: PageCtx, versions: Map<string, string>): string {
  const L = (k: Key) => esc(t(c.lang, k));
  const items = c.config.instances
    .map((i) => {
      const hosts = (c.db.prepare("SELECT count(*) n FROM hosts WHERE instance_id=?").get(i.id) as { n: number }).n;
      const conts = (c.db.prepare("SELECT count(*) n FROM containers WHERE instance_id=? AND last_seen>?").get(i.id, c.now - 24 * H) as { n: number }).n;
      const v = versions.get(i.id);
      return `<div class="card"><b>${esc(i.name)}</b> <span class="chip ${v ? "ok" : "err"}">${v ? L("online") : L("offline")}</span><div class="muted">${hosts} ${L("hosts")} · ${conts} ${L("containers")} · Dozzle ${esc(v ?? "?")}</div><div class="mono muted">${esc(i.url)} · id ${esc(i.id)}</div></div>`;
    })
    .join("");
  return layout(c, "/instances", t(c.lang, "instances"), `<h1>${L("instances")}</h1><p class="muted">${L("instancesIntro")}</p>${items}`);
}

export function integrationsPage(c: PageCtx): string {
  const L = (k: Key) => esc(t(c.lang, k));
  const notify = process.env["NOTIFY_URL"] ? new URL(process.env["NOTIFY_URL"]).host : t(c.lang, "none");
  return layout(
    c,
    "/integrations",
    t(c.lang, "integrations"),
    `<h1>${L("integrations")}</h1><p class="muted">${L("integrationsIntro")}</p>
<div class="card"><b>${L("mcpEndpoint")}</b><pre>${esc(c.config.publicUrl)}/mcp  (Authorization: Bearer &lt;MCP_TOKEN&gt;)</pre>
<pre class="muted">{ "mcpServers": { "dozzle": { "type": "http", "url": "${esc(c.config.publicUrl)}/mcp", "headers": { "Authorization": "Bearer …" } } } }</pre></div>
<div class="card"><b>${L("notifyChannel")}</b><div class="muted">${esc(notify)}</div></div>`,
  );
}
