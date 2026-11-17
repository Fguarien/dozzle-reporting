import { readFileSync } from "node:fs";
import type { Db } from "../store/db.ts";
import type { Config } from "../config.ts";
import { t, type Lang, type Key } from "./i18n.ts";
import { ico, type IconName } from "./icons.ts";

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

/** DaisyUI light/dark tokens from amir20/dozzle (MIT) — hex stand-ins of the oklch theme. */
const CSS = `
:root{
  --bg:#fff;--panel:#fafafa;--side:#f7f7f8;--fg:#1c1917;--muted:#6b7280;--line:#ececec;
  --accent:#14b8a6;--accent-fg:#0f766e;--warn:#d97706;--err:#dc2626;--ok:#16a34a;--info:#2563eb;
  --chip:#ecfdf5;--cpu:#14b8a6;--mem:#ca8a04;--hover:#f3f4f6;--sel:#ececec;--soft:#f5f5f5;
  color-scheme:light
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#1c1c1c;--panel:#242424;--side:#171717;--fg:#e7e5e4;--muted:#a8a29e;--line:#2a2a2a;
  --chip:#134e4a;--hover:#262626;--sel:#2e2e2e;--soft:#222;color-scheme:dark
}}
:root[data-theme=dark]{
  --bg:#1c1c1c;--panel:#242424;--side:#171717;--fg:#e7e5e4;--muted:#a8a29e;--line:#2a2a2a;
  --chip:#134e4a;--hover:#262626;--sel:#2e2e2e;--soft:#222;color-scheme:dark
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14.5px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,sans-serif}
a{color:inherit}a.link{color:var(--accent-fg);text-decoration:none}a.link:hover{text-decoration:underline}
.ico{display:inline-block;vertical-align:-3px;flex:none}
.shell{display:grid;grid-template-columns:248px 1fr;min-height:100vh}
aside{background:var(--side);border-right:1px solid var(--line);padding:14px 10px;position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:10px;overflow:auto}
aside .brand{display:flex;align-items:center;gap:8px;padding:4px 8px 6px;font-weight:650;font-size:15.5px;letter-spacing:-.01em}
aside .brand .logo{width:22px;height:22px;color:var(--accent)}
aside .brand small{font:600 9px/1.1 ui-sans-serif,system-ui,sans-serif;color:var(--accent-fg);border:1px solid color-mix(in srgb,var(--accent) 55%,transparent);background:color-mix(in srgb,var(--accent) 12%,transparent);border-radius:4px;padding:2px 5px;letter-spacing:.04em}
aside .inst{display:flex;align-items:center;gap:8px;margin:0 4px 6px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);font-size:13px;color:var(--fg)}
aside .inst .grow{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
aside .inst .ico{opacity:.45}
aside nav{display:flex;flex-direction:column;gap:1px}
aside nav a.n,aside nav .n{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;text-decoration:none;color:var(--fg);margin:0}
aside nav a.n .ico,aside nav .n .ico{opacity:.5;width:16px;height:16px}
aside nav a.n:hover,aside nav .n:hover{background:var(--hover)}
aside nav a.n.on,aside nav .n.on{background:var(--sel);font-weight:550}
aside nav a.n.on .ico,aside nav .n.on .ico{opacity:.85}
aside nav a.n .ch,aside nav .n .ch{margin-left:auto;opacity:.35}
aside nav .sub{padding:2px 0 6px}
aside nav .sub a{display:flex;align-items:center;gap:8px;padding:5px 10px 5px 36px;border-radius:8px;text-decoration:none;color:var(--muted);font-size:13.5px}
aside nav .sub a:hover{background:var(--hover);color:var(--fg)}
aside nav .sub a.on{background:var(--sel);color:var(--fg);font-weight:550}
aside nav hr{border:0;border-top:1px solid var(--line);margin:8px 6px}
header.top{display:flex;gap:8px;align-items:center;padding:10px 20px;border-bottom:1px solid var(--line);background:var(--bg);position:sticky;top:0;z-index:2}
header.top form.search{flex:1;max-width:640px;position:relative}
header.top form.search .ico{position:absolute;left:12px;top:50%;transform:translateY(-50%);opacity:.4}
header.top form.search input{width:100%;padding:8px 44px 8px 36px;border-radius:999px;background:var(--soft);border:1px solid var(--line)}
header.top form.search kbd{position:absolute;right:10px;top:50%;transform:translateY(-50%);font:11px/1 ui-sans-serif,system-ui,sans-serif;color:var(--muted);border:1px solid var(--line);border-radius:6px;padding:3px 6px;background:var(--bg)}
header.top .iconbtn{width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--muted)}
header.top .iconbtn:hover{background:var(--hover);color:var(--fg)}
header.top .avatar{width:28px;height:28px;border-radius:50%;background:#dc2626;color:#fff;display:inline-flex;align-items:center;justify-content:center;font:650 12px/1 ui-sans-serif,system-ui,sans-serif;text-decoration:none}
button,input,select{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 10px}
button{cursor:pointer}button.ghost{background:transparent}
main{padding:28px 36px 48px;max-width:1120px}
h1{font-size:28px;margin:4px 0 8px;letter-spacing:-.03em;font-weight:650;display:flex;align-items:center;gap:10px}
h1 .ico{opacity:.55;width:22px;height:22px}
h2{font-size:16px;margin:28px 0 8px;font-weight:600;letter-spacing:-.01em}
.muted{color:var(--muted)}.date{color:var(--muted);font-size:13.5px}
.row{display:flex;gap:14px;align-items:flex-start;padding:12px 2px;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
.row .t{width:72px;color:var(--muted);font-size:12.5px;flex:none;padding-top:2px}
.row .b{flex:1;min-width:0}
.row .s{font-size:12.5px;color:var(--muted)}
.row .bell{opacity:.45;margin-right:6px}
.card{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:16px 18px;margin:10px 0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:28px}.grid3{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.big{font-size:36px;font-weight:700;letter-spacing:-.03em;line-height:1.1}
.kv{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 0;font-size:13.5px}
.chip{display:inline-block;font-size:11.5px;padding:1px 8px;border-radius:99px;background:var(--chip);color:var(--accent-fg)}
.chip.err{background:#fde8e8;color:var(--err)}.chip.warn{background:#fdf2e1;color:var(--warn)}.chip.ok{background:#e5f6ec;color:var(--ok)}.chip.q{background:var(--line);color:var(--muted)}.chip.info{background:#e8f0fe;color:var(--info)}
.tabs{display:flex;gap:0;margin:16px 0 8px;border-bottom:1px solid var(--line)}
.tabs a{padding:8px 14px;text-decoration:none;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px;font-size:13.5px}
.tabs a.on{color:var(--fg);border-bottom-color:var(--fg);font-weight:550}
.tabs.pills{border:0;gap:6px;margin:14px 0}
.tabs.pills a{border:1px solid var(--line);border-radius:8px;margin:0;padding:6px 12px}
.tabs.pills a.on{background:var(--fg);color:var(--bg);border-color:var(--fg)}
table{border-collapse:collapse;width:100%;font-size:13.5px}td,th{text-align:left;padding:8px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
pre{white-space:pre-wrap;word-break:break-word;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}svg.spark{display:block}
.mc{display:block;text-decoration:none;margin:0;padding:14px 16px}
.mc h3{font-size:14px;margin:0 0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.mc .l{font-size:12px;color:var(--muted)}
.find{display:grid;grid-template-columns:14px 1fr 16px;gap:10px 12px;padding:16px 4px;border-bottom:1px solid var(--line);text-decoration:none;color:inherit}
.find:hover{background:var(--hover)}
.find .dot{width:8px;height:8px;border-radius:50%;margin-top:7px;background:var(--warn)}
.find .dot.high,.find .dot.critical{background:var(--err)}
.find .dot.low,.find .dot.info{background:var(--info)}
.find .dot.ok{background:var(--ok)}
.find h3{margin:0 0 4px;font-size:14.5px;font-weight:600;letter-spacing:-.01em}
.find .why{color:var(--fg);font-size:13.5px;margin:0 0 6px}
.find .fix{color:var(--accent-fg);font-size:13.5px;margin:0 0 6px}
.find .meta{color:var(--muted);font-size:12.5px;display:flex;flex-wrap:wrap;gap:8px}
.find .ch{opacity:.3;margin-top:6px}
.badge-new{font-size:10.5px;color:var(--err);border:1px solid color-mix(in srgb,var(--err) 40%,transparent);border-radius:4px;padding:1px 6px;margin-left:8px;vertical-align:middle}
.stat{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12.5px;margin-bottom:4px}
.stat .ico{opacity:.5}
.hostbar{display:flex;align-items:center;gap:10px;padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--panel);margin:14px 0 8px;font-weight:550}
.hostbar .muted{font-weight:400;margin-left:auto;display:flex;gap:16px;align-items:center}
.sum{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:12px 0 20px}
.sum .card{margin:0}
.sum .k{font-size:12.5px;color:var(--muted);display:flex;align-items:center;gap:6px}
.sum .v{font-size:22px;font-weight:650;letter-spacing:-.02em;margin-top:4px}
.pagehead{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
.pagehead .right{color:var(--muted);font-size:13px;text-align:right}
.logbar{display:flex;align-items:center;gap:8px;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:12px 0}
.logbar input{flex:1;border:0;background:transparent;padding:4px 0}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 4px}
@media (max-width:900px){.shell{grid-template-columns:1fr}aside{position:static;height:auto}.grid2,.sum{grid-template-columns:1fr}main{padding:18px 16px}header.top form.search kbd{display:none}}
`;

const THEME_JS = `(function(){var k="dozzle-reporting-theme";var v=null;try{v=localStorage.getItem(k)}catch(e){}if(v==="light"||v==="dark")document.documentElement.setAttribute("data-theme",v);
window.cycleTheme=function(){var cur=document.documentElement.getAttribute("data-theme");var nxt=cur===null?"light":cur==="light"?"dark":null;
if(nxt)document.documentElement.setAttribute("data-theme",nxt);else document.documentElement.removeAttribute("data-theme");try{nxt?localStorage.setItem(k,nxt):localStorage.removeItem(k)}catch(e){}};
window.cycleLang=function(){var l=document.documentElement.lang==="fr"?"en":"fr";document.cookie="lang="+l+";path=/;max-age=31536000;samesite=lax";location.reload()};})();`;

let headInclude: string | undefined;
function extraHead(cfg: Config): string {
  if (headInclude !== undefined) return headInclude;
  const p = process.env["HEAD_INCLUDE"];
  headInclude = p ? readFileSync(p, "utf8") : "";
  void cfg;
  return headInclude;
}

function parseNames(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function initials(name: string): string {
  const p = name.trim().split(/[\s@._-]+/).filter(Boolean);
  return ((p[0]?.[0] ?? "?") + (p[1]?.[0] ?? "")).toUpperCase();
}

export function layout(c: PageCtx, active: string, title: string, body: string): string {
  const b = c.config.basePath;
  const L = (k: Key, v?: Record<string, string | number>) => esc(t(c.lang, k, v));
  const on = (p: string) => (active === p || (p !== "" && active.startsWith(p)) ? "on" : "");
  const inst = c.config.instances[0];
  const instLabel = inst?.name ?? "dozzle";
  const fTab = c.query.get("tab") ?? "open";
  const findingsOpen = active === "/findings";
  const alertsOpen = active.startsWith("/alerts");
  const navItem = (href: string, key: Key, icon: IconName, extra = "") =>
    `<a class="n ${on(href)}" href="${b}${href}">${ico(icon)} ${L(key)}${extra}</a>`;
  const sub = (href: string, key: Key, n?: number, isOn?: boolean) =>
    `<a class="${isOn ? "on" : ""}" href="${b}${href}">${L(key)}${n !== undefined ? ` ${n}` : ""}</a>`;
  const fCount = (w: string) => (c.db.prepare(`SELECT count(*) n FROM findings WHERE ${w}`).get() as { n: number }).n;
  const nOpen = findingsOpen ? fCount("status IN ('open','ongoing') AND ignored=0") : 0;
  const nAll = findingsOpen ? fCount("1=1") : 0;
  const nRes = findingsOpen ? fCount("status='resolved'") : 0;
  const nIgn = findingsOpen ? fCount("ignored=1") : 0;
  return `<!doctype html><html lang="${c.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${L("brand")}</title><style>${CSS}</style><script>${THEME_JS}</script>${extraHead(c.config)}</head>
<body><div class="shell"><aside>
  <div class="brand">${ico("cloud", "logo")} ${L("brand")} <small>${L("selfHosted")}</small></div>
  <div class="inst">${ico("server")}<span class="grow" title="${esc(instLabel)}">${esc(instLabel)}</span>${ico("chevronDown")}</div>
  <nav>
    ${navItem("", "overview", "house")}
    ${navItem("/findings", "findings", "bell", ico("chevronRight", "ch"))}
    ${findingsOpen ? `<div class="sub">${sub("/findings?tab=open", "needsAttention", nOpen, fTab === "open")}${sub("/findings?tab=all", "all", nAll, fTab === "all")}${sub("/findings?tab=resolved", "resolved", nRes, fTab === "resolved")}${sub("/findings?tab=ignored", "ignored", nIgn, fTab === "ignored")}</div>` : ""}
    ${navItem("/updates", "updates", "refresh")}
    ${navItem("/alerts", "alerts", "bell", ico("chevronRight", "ch"))}
    ${alertsOpen ? `<div class="sub">${sub("/alerts", "alerts", undefined, active === "/alerts")}${sub("/alerts/events", "events", undefined, active === "/alerts/events")}${sub("/alerts/muted", "muted", undefined, active === "/alerts/muted")}</div>` : ""}
    <hr>
    ${navItem("/logs", "logs", "terminal")}
    ${navItem("/metrics", "metrics", "chart")}
    <hr>
    ${navItem("/instances", "instances", "server", ico("chevronRight", "ch"))}
    ${navItem("/integrations", "integrations", "puzzle", ico("chevronRight", "ch"))}
  </nav>
</aside>
<div><header class="top">
  <form class="search" action="${b}/logs">${ico("search")}<input name="q" placeholder="${L("searchAsk")}" value="${esc(c.query.get("q") ?? "")}" autocomplete="off"><kbd>${ico("kbd")}</kbd></form>
  <button class="iconbtn" type="button" onclick="cycleLang()" title="${c.lang === "fr" ? "English" : "Français"}">${c.lang.toUpperCase()}</button>
  <button class="iconbtn" type="button" id="themebtn" onclick="cycleTheme()" title="${L("theme")}">${ico("sun")}</button>
  ${c.user ? `<a class="avatar" href="${b}/auth/logout" title="${esc(c.user)} · ${L("signOut")}">${esc(initials(c.user))}</a>` : ""}
</header>
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

function relTime(ms: number, c: PageCtx): string {
  const sec = Math.round((c.now - ms) / 1000);
  const rtf = new Intl.RelativeTimeFormat(c.lang === "fr" ? "fr" : "en", { numeric: "auto" });
  if (Math.abs(sec) < 60) return rtf.format(-Math.round(sec), "second");
  if (Math.abs(sec) < 3600) return rtf.format(-Math.round(sec / 60), "minute");
  if (Math.abs(sec) < 86400) return rtf.format(-Math.round(sec / 3600), "hour");
  if (Math.abs(sec) < 86400 * 7) return rtf.format(-Math.round(sec / 86400), "day");
  return new Date(ms).toLocaleDateString(c.lang === "fr" ? "fr-BE" : "en-GB", {
    timeZone: c.config.timezone,
    day: "numeric",
    month: "short",
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
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polygon points="0,${h} ${pts.join(" ")} ${w},${h}" fill="${color}" opacity=".18"/><polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}

function seriesFor(db: Db, instance: string, host: string, name: string, from: number, field: "cpu_avg" | "mem_avg", points = 30): number[] {
  from = dataFrom(db, from);
  const step = Math.max(30_000, Math.ceil((Date.now() - from) / points / 30_000) * 30_000);
  return (db.prepare(`SELECT avg(${field}) v FROM metrics WHERE instance_id=? AND host=? AND container_name=? AND ts>=? GROUP BY CAST(ts / ? AS INTEGER) ORDER BY ts`).all(instance, host, name, from, step) as { v: number }[]).map((r) => r.v);
}

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

function instanceName(c: PageCtx, id: string): string {
  return c.config.instances.find((i) => i.id === id)?.name ?? id;
}

function daysOpen(f: Record<string, unknown>, now: number): number {
  const created = Number(f.created ?? now);
  const resolved = f.resolved_at == null ? now : Number(f.resolved_at);
  return Math.max(0, Math.floor((resolved - created) / 864e5));
}

function findingRow(c: PageCtx, f: Record<string, string & number>, opts: { compact?: boolean } = {}): string {
  const L = (k: Key, v?: Record<string, string | number>) => esc(t(c.lang, k, v));
  const names = parseNames(f.containers);
  const sev = String(f.severity ?? "medium");
  const days = daysOpen(f, c.now);
  const inst = instanceName(c, String(f.instance_id ?? ""));
  const fresh = c.now - Number(f.created) < 36 * H;
  return `<a class="find" href="${c.config.basePath}/findings?tab=${f.ignored ? "ignored" : f.status === "resolved" ? "resolved" : "open"}">
    <span class="dot ${esc(sev)}"></span>
    <div>
      <h3>${esc(f.headline)}${fresh && f.status !== "resolved" ? `<span class="badge-new">${L("newError")}</span>` : ""}</h3>
      ${opts.compact ? "" : f.why ? `<p class="why">${esc(f.why)}</p>` : ""}
      ${f.fix ? `<p class="fix">${L("fix")}: ${esc(f.fix)}</p>` : ""}
      <div class="meta"><span>${f.status === "resolved" ? L("resolved") : L("stillHappening", { n: days })}</span><span>${esc(names.join(", "))}</span><span>${esc(inst)}</span></div>
    </div>
    ${ico("chevronRight", "ch")}
  </a>`;
}

// ─────────────────────────── pages ───────────────────────────

export function overview(c: PageCtx): string {
  const { db, now } = c;
  const L = (k: Key, v?: Record<string, string | number>) => esc(t(c.lang, k, v));
  const b = c.config.basePath;
  const happened = db
    .prepare(
      `SELECT ts, 'alert' k, title, status, container_name FROM alerts WHERE ts>=? AND status='sent'
       UNION ALL SELECT resolved_at ts, 'resolved' k, headline title, 'resolved' status, containers container_name FROM findings WHERE resolved_at>=?
       ORDER BY ts DESC LIMIT 10`,
    )
    .all(now - 24 * H, now - 24 * H) as { ts: number; k: string; title: string; status: string; container_name: string }[];
  const open = db.prepare("SELECT * FROM findings WHERE status IN ('open','ongoing') AND ignored=0 ORDER BY updated DESC LIMIT 5").all() as Record<string, string & number>[];
  const totals = db.prepare("SELECT sum(cpu) cpu, sum(mem) mem, count(*) n FROM (SELECT container_id, avg(cpu_avg) cpu, avg(mem_avg) mem FROM metrics WHERE ts>=? GROUP BY instance_id, container_id)").get(now - 15 * 60_000) as { cpu: number; mem: number; n: number };
  const top = (field: "cpu_avg" | "mem_avg") =>
    db.prepare(`SELECT instance_id, host, container_name name, avg(${field}) v FROM metrics WHERE ts>=? GROUP BY instance_id, host, container_name ORDER BY v DESC LIMIT 5`).all(now - 24 * H) as { instance_id: string; host: string; name: string; v: number }[];
  const topList = (field: "cpu_avg" | "mem_avg", color: string) =>
    top(field)
      .map((r) => `<div class="kv"><span>${esc(r.name)}</span><span style="display:flex;gap:8px;align-items:center">${spark(seriesFor(db, r.instance_id, r.host, r.name, now - 24 * H, field), color, 88, 22)}<span class="mono">${field === "cpu_avg" ? pctS(r.v) : fmtBytes(r.v)}</span></span></div>`)
      .join("");
  const nHappened = (db.prepare("SELECT count(*) n FROM alerts WHERE ts>=? AND status='sent'").get(now - 24 * H) as { n: number }).n;
  return layout(
    c,
    "",
    t(c.lang, "overview"),
    `${happened
      .map(
        (h) =>
          `<div class="row"><div class="t">${fmtTime(h.ts, c)}</div><div class="b">${h.k === "resolved" ? ico("bell", "bell") : ico("bell", "bell")} <b>${h.k === "resolved" ? L("resolved") : L("alertSent")}:</b> ${esc(h.title)}<div class="s">${esc(h.container_name ?? "")} · ${esc(instanceName(c, c.config.instances[0]?.id ?? ""))}</div></div></div>`,
      )
      .join("") || `<p class="muted">—</p>`}
${nHappened > happened.length ? `<p class="muted"><a class="link" href="${b}/alerts">${L("showAll", { n: nHappened })}</a></p>` : nHappened ? `<p class="muted"><a class="link" href="${b}/alerts">${L("showAll", { n: nHappened })}</a></p>` : ""}
<h2>${L("worthFixing")}</h2>
${open.length ? open.map((f) => findingRow(c, f)).join("") : `<div class="card">✓ ${L("nothingToFix")}</div>`}
<h2>${L("resources24h")} <a class="link" style="float:right;font-size:13px;font-weight:400" href="${b}/metrics">${L("allMetrics")}</a></h2>
<div class="grid2">
  <div><div class="stat">${ico("cpu")} ${L("cpu")}</div><div class="big">${pctS(totals.cpu ?? 0)}</div><div class="muted">${L("acrossN", { n: totals.n ?? 0 })}</div>${topList("cpu_avg", "var(--cpu)")}</div>
  <div><div class="stat">${ico("memory")} ${L("memory")}</div><div class="big">${fmtBytes(totals.mem)}</div><div class="muted">${L("acrossN", { n: totals.n ?? 0 })}</div>${topList("mem_avg", "var(--mem)")}</div>
</div>`,
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
  const when = `${String(c.config.reviewHour).padStart(2, "0")}:00`;
  return layout(
    c,
    "/findings",
    t(c.lang, "findings"),
    `<div class="pagehead"><div><h1>${ico("bell")} ${L("findings")}</h1><p class="muted">${L("findingsIntro")}</p></div>
<div class="right">${c.config.llm ? L("nextReview", { when }) : L("noLlm")}</div></div>
<div class="tabs">${tabs.map(([k, l, n]) => `<a class="${tab === k ? "on" : ""}" href="${b}/findings?tab=${k}">${L(l)} ${n}</a>`).join("")}</div>
${rows.length ? rows.map((f) => findingRow(c, f)).join("") : `<div class="card">✓ ${L("nothingToFix")}</div>`}`,
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
    `<h1>${ico("refresh")} ${L("updates")}</h1><p class="muted">${L("updatesIntro")}</p>
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
          .map((a) => {
            const sev = a.status === "sent" ? (a.level === "error" ? "high" : "medium") : "ok";
            return `<div class="find">
              <span class="dot ${sev}"></span>
              <div>
                <h3>${esc(a.title)}</h3>
                ${a.summary ? `<p class="why">${esc(a.summary)}</p>` : a.sample ? `<pre class="muted">${esc(String(a.sample).slice(0, 400))}</pre>` : ""}
                <div class="meta"><span>${esc(a.status === "sent" ? t(c.lang, "alertSent") : a.status === "muted" ? t(c.lang, "muted") : `${t(c.lang, "suppressed")} · ${a.suppressed_reason}`)}</span><span>${esc(a.container_name ?? "")}</span><span>${L("eventsN", { n: a.event_count })}</span>${a.absorbed ? `<span>${a.absorbed} ${L("absorbed")}</span>` : ""}</div>
              </div>
              <span class="muted" style="font-size:12.5px;white-space:nowrap">${relTime(a.ts, c)}</span>
            </div>`;
          })
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
  return layout(c, tab === "alerts" ? "/alerts" : `/alerts/${tab}`, t(c.lang, "alerts"), `<h1>${ico("bell")} ${L("alerts")}</h1><p class="muted">${L("alertsIntro")}</p><div class="tabs">${tabs}</div>${body}`);
}

export function metricsPage(c: PageCtx): string {
  const L = (k: Key, v?: Record<string, string | number>) => esc(t(c.lang, k, v));
  const sort = c.query.get("sort") === "memory" ? "mem_avg" : "cpu_avg";
  const hours = Math.min(720, Math.max(1, Number(c.query.get("h") ?? 24)));
  const from = c.now - hours * H;
  const hn = hostNames(c.db);
  const filter = (c.query.get("q") ?? "").trim().toLowerCase();
  const rows = (
    c.db
      .prepare(`SELECT instance_id, host, container_name name, avg(cpu_avg) cpu, max(cpu_max) cpu_pk, avg(mem_avg) mem, avg(mem_pct_avg) pct FROM metrics WHERE ts>=? GROUP BY instance_id, host, container_name ORDER BY host, ${sort === "mem_avg" ? "mem" : "cpu"} DESC`)
      .all(from) as { instance_id: string; host: string; name: string; cpu: number; cpu_pk: number; mem: number; pct: number }[]
  ).filter((r) => !filter || r.name.toLowerCase().includes(filter));
  const series = seriesAll(c.db, from, c.now);
  const sp = (r: { instance_id: string; host: string; name: string }) => series.get(`${r.instance_id}|${r.host}|${r.name}`) ?? { cpu: [], mem: [] };
  const byHost = new Map<string, typeof rows>();
  for (const r of rows) byHost.set(r.host, [...(byHost.get(r.host) ?? []), r]);
  const b = c.config.basePath;
  const cpuNow = rows.reduce((s, r) => s + r.cpu, 0);
  const memNow = rows.reduce((s, r) => s + r.mem, 0);
  const memLimit = rows.reduce((s, r) => s + (r.pct > 1 ? r.mem / (r.pct / 100) : 0), 0);
  const cards = [...byHost.entries()]
    .map(([h, rs]) => {
      const cpu = rs.reduce((s, r) => s + r.cpu, 0);
      const mem = rs.reduce((s, r) => s + r.mem, 0);
      return `<div class="hostbar">${ico("server")} ${esc(hn.get(h) ?? h)} <span class="muted">${rs.length} ${L("containers")} <span>${pctS(cpu)}</span> <span>${fmtBytes(mem)}</span> ${spark(
        rs.slice(0, 1).length ? sp(rs[0]!).cpu : [],
        "var(--cpu)",
        72,
        18,
      )}</span></div><div class="grid3">${rs
        .map(
          (r) =>
            `<a class="card mc" href="${b}/metrics/${encodeURIComponent(r.instance_id)}/${encodeURIComponent(r.host)}/${encodeURIComponent(r.name)}?h=${hours}"><h3>${esc(r.name)} ${ico("expand", "ch")}</h3><div class="kv"><div><div class="l">${ico("cpu")} ${L("cpu")}</div><b>${pctS(r.cpu)}</b> <span class="l">${L("peak")} ${pctS(r.cpu_pk)}</span></div>${spark(sp(r).cpu, "var(--cpu)", 110, 28)}</div><div class="kv"><div><div class="l">${ico("memory")} ${L("memory")}</div><b>${fmtBytes(r.mem)}</b> <span class="l">${pctS(r.pct)} ${L("ofLimit")}</span></div>${spark(sp(r).mem, "var(--mem)", 110, 28)}</div></a>`,
        )
        .join("")}</div>`;
    })
    .join("");
  const sel = (v: string, cur: string, label: string) => `<option value="${v}" ${v === cur ? "selected" : ""}>${label}</option>`;
  return layout(
    c,
    "/metrics",
    t(c.lang, "metrics"),
    `<h1>${ico("chart")} ${L("metrics")}</h1><p class="muted">${L("metricsIntro")}</p>
<form class="filters"><input name="q" placeholder="${L("filterContainers")}" value="${esc(c.query.get("q") ?? "")}">
<select name="h" onchange="this.form.submit()">${sel("1", String(hours), "1h")}${sel("6", String(hours), "6h")}${sel("24", String(hours), "24h")}${sel("168", String(hours), "7d")}${sel("720", String(hours), "30d")}</select>
<select name="sort" onchange="this.form.submit()">${sel("cpu", sort === "cpu_avg" ? "cpu" : "memory", `${t(c.lang, "sortBy")} CPU`)}${sel("memory", sort === "cpu_avg" ? "cpu" : "memory", `${t(c.lang, "sortBy")} ${t(c.lang, "memory")}`)}</select></form>
<div class="sum">
  <div class="card"><div class="k">${ico("cpu")} ${L("cpuNow")}</div><div class="v">${pctS(cpuNow)}</div></div>
  <div class="card"><div class="k">${ico("memory")} ${L("memory")}</div><div class="v">${memLimit ? L("ofTotal", { used: fmtBytes(memNow), total: fmtBytes(memLimit) }) : fmtBytes(memNow)}</div></div>
  <div class="card"><div class="k">${ico("boxes")} ${L("containers")}</div><div class="v">${rows.length}</div></div>
  <div class="card"><div class="k">${ico("server")} ${L("hosts")}</div><div class="v">${byHost.size}</div></div>
</div>
<p class="muted">${rows.length} of ${rows.length}</p>
${cards}`,
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
  const lines = result ? result.split("\n").filter(Boolean) : [];
  return layout(
    c,
    "/logs",
    t(c.lang, "logs"),
    `<h1>${ico("terminal")} ${L("logs")}</h1><p class="muted">${L("logsIntro")}</p>
<form class="logbar">${ico("search")}
<input name="q" placeholder="${L("logsql")}  level:error AND container_name:${esc(q.get("container") ?? "")}" value="${esc(q.get("q") ?? "")}">
<input name="container" placeholder="${L("container")}" value="${esc(q.get("container") ?? "")}" style="max-width:180px">
<select name="after">${["15m", "1h", "6h", "24h", "7d"].map((w) => `<option ${q.get("after") === w || (!q.get("after") && w === "15m") ? "selected" : ""}>${w}</option>`).join("")}</select>
<button>${L("search")}</button></form>
${result !== undefined ? `<p class="muted">${lines.length} events loaded</p><div class="card"><pre>${esc(result)}</pre></div>` : ""}`,
  );
}

export function instancesPage(c: PageCtx, versions: Map<string, string>): string {
  const L = (k: Key) => esc(t(c.lang, k));
  const items = c.config.instances
    .map((i) => {
      const hosts = (c.db.prepare("SELECT id, name FROM hosts WHERE instance_id=?").all(i.id) as { id: string; name: string }[]);
      const conts = (c.db.prepare("SELECT count(*) n FROM containers WHERE instance_id=? AND last_seen>?").get(i.id, c.now - 24 * H) as { n: number }).n;
      const v = versions.get(i.id);
      const hostRows = hosts
        .map((h) => {
          const n = (c.db.prepare("SELECT count(*) n FROM containers WHERE instance_id=? AND host=? AND last_seen>?").get(i.id, h.id, c.now - 24 * H) as { n: number }).n;
          return `<div class="kv"><span>${ico("server")} ${esc(h.name || h.id)}</span><span class="muted">${n} ${L("containers")} · Dozzle ${esc(v ?? "?")}</span></div>`;
        })
        .join("");
      return `<div class="card"><div class="kv"><b>${esc(i.name)}</b> <span class="chip ${v ? "ok" : "err"}">${v ? L("online") : L("offline")}</span></div>
<div class="muted">${hosts.length} ${L("hosts")} · ${conts} ${L("containers")} · Dozzle ${esc(v ?? "?")}</div>
<div class="mono muted" style="margin:8px 0">${esc(i.url)}</div>
${hostRows}
<div class="muted" style="margin-top:10px">${ico("clock")} ${L("connectedNow")} · ${L("dailyReport")}</div></div>`;
    })
    .join("");
  return layout(c, "/instances", t(c.lang, "instances"), `<h1>${ico("server")} ${L("instances")}</h1><p class="muted">${L("instancesIntro")}</p>${items}`);
}

export function integrationsPage(c: PageCtx): string {
  const L = (k: Key) => esc(t(c.lang, k));
  const notify = process.env["NOTIFY_URL"] ? new URL(process.env["NOTIFY_URL"]).host : t(c.lang, "none");
  const b = c.config.basePath;
  const tab = c.query.get("tab") ?? "notifications";
  return layout(
    c,
    "/integrations",
    t(c.lang, "integrations"),
    `<h1>${ico("puzzle")} ${L("integrations")}</h1><p class="muted">${L("integrationsIntro")}</p>
<div class="tabs"><a class="${tab === "notifications" ? "on" : ""}" href="${b}/integrations">${L("notifications")}</a>
<a class="${tab === "mcp" ? "on" : ""}" href="${b}/integrations?tab=mcp">MCP</a></div>
${
  tab === "mcp"
    ? `<div class="card"><b>${L("mcpEndpoint")}</b><pre>${esc(c.config.publicUrl)}/mcp  (Authorization: Bearer &lt;MCP_TOKEN&gt;)</pre>
<pre class="muted">{ "mcpServers": { "dozzle": { "type": "http", "url": "${esc(c.config.publicUrl)}/mcp", "headers": { "Authorization": "Bearer …" } } } }</pre></div>`
    : `<h2>${ico("bell")} ${L("muteNotif")}</h2>
<div class="card muted">${L("alertsIntro")}</div>
<h2>${ico("mail")} ${L("notifChannels")}</h2>
<div class="card"><div class="kv"><span>${ico("mail")} ${L("emailNotif")}<div class="muted">${esc(notify)}</div></span><span class="chip ok">ON</span></div></div>`
}`,
  );
}
