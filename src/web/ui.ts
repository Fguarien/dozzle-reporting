import { readFileSync } from "node:fs";
import { kvGet, type Db } from "../store/db.ts";
import type { Config } from "../config.ts";
import { t, type Lang, type Key } from "./i18n.ts";
import { ico, type IconName } from "./icons.ts";
import type { LogHit, LogNote } from "./logfetch.ts";

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
  /** Set by the logs page while Live is on. layout emits a refresh meta. */
  refreshSec?: number;
}

/** Windows the findings page and the logs page both offer. */
export const TIME_WINDOWS = ["15m", "30m", "45m", "1h", "6h", "12h", "24h", "7d", "30d"] as const;

/** Relative window (`15m`, `6h`, `7d`) as milliseconds. Unknown text is undefined. */
export function windowMs(w: string): number | undefined {
  const m = /^(\d+)(m|h|d)$/.exec(w);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 366) return undefined;
  return n * (m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000);
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
header.top .iconbtn{width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--muted);text-decoration:none}
header.top .iconbtn:hover{background:var(--hover);color:var(--fg)}
header.top .avatar{width:28px;height:28px;border-radius:50%;background:#dc2626;color:#fff;display:inline-flex;align-items:center;justify-content:center;font:650 12px/1 ui-sans-serif,system-ui,sans-serif;text-decoration:none}
button,input,select{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 10px}
button{cursor:pointer}button.ghost{background:transparent}
main{padding:28px 36px 48px;max-width:1120px}
h1{font-size:28px;margin:4px 0 8px;letter-spacing:-.03em;font-weight:650;display:flex;align-items:center;gap:10px}
h1 .ico{opacity:.55;width:22px;height:22px}
h2{font-size:16px;margin:28px 0 8px;font-weight:600;letter-spacing:-.01em}
.muted{color:var(--muted)}.date{color:var(--muted);font-size:13.5px}
.row{display:flex;gap:14px;align-items:flex-start;padding:12px 2px;border-bottom:1px solid var(--line);text-decoration:none;color:inherit}
a.row:hover{background:var(--hover)}a.row .ch{margin-left:auto;opacity:.3;flex:none}
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
.find{display:grid;grid-template-columns:14px 1fr auto;gap:10px 12px;padding:16px 4px;border-bottom:1px solid var(--line);text-decoration:none;color:inherit}
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
.filters{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 4px;align-items:center}
.filters input,.filters select{border-radius:999px;background:var(--soft);padding:7px 12px}
.pills{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.pills a,.pills span,.pills button{border:1px solid var(--line);border-radius:999px;padding:6px 12px;text-decoration:none;font-size:13px;background:var(--bg);color:var(--fg);display:inline-block;cursor:pointer;font:inherit}
.pills a:hover,.pills button:hover{background:var(--hover)}.pills a.on{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.mutebox{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:14px 16px;margin:8px 0 18px}
.mutebox h2{margin:0 0 6px;font-size:15px}
.secret{font-family:ui-monospace,Menlo,monospace;background:var(--soft);border-radius:8px;padding:10px 12px;word-break:break-all}
.hist{display:flex;align-items:flex-end;gap:3px;height:72px;padding:8px 4px 0;border:1px solid var(--line);border-radius:10px;background:var(--panel);margin:10px 0 16px}
.hist i{flex:1;display:block;border-radius:2px 2px 0 0;min-height:2px;background:var(--ok)}
.hist i.warn{background:var(--warn)}.hist i.err{background:var(--err)}.hist i.mix{background:linear-gradient(to top,var(--ok) 40%,var(--warn) 70%,var(--err) 100%)}
.logtbl{width:100%;font-size:13px}.logtbl td:first-child{white-space:nowrap;color:var(--muted);font-variant-numeric:tabular-nums}
.logtools{display:flex;justify-content:flex-end;gap:8px;align-items:center;margin-top:8px}
.logtools select,.logbar select{border-radius:999px;background:var(--bg);border:1px solid var(--line);padding:6px 10px}
.pill{border:1px solid var(--line);border-radius:999px;padding:6px 12px;background:var(--bg);color:var(--fg);text-decoration:none;font-size:13px}
.pill.on{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.vol{display:flex;align-items:flex-end;gap:2px;height:84px;padding:8px 4px 0;border:1px solid var(--line);border-radius:10px;background:var(--panel);margin:4px 0 8px}
.vol i{flex:1;display:flex;flex-direction:column-reverse;min-height:2px;border-radius:2px 2px 0 0;overflow:hidden;background:color-mix(in srgb,var(--line) 65%,transparent)}
.vol i b{display:block;width:100%}
.vol i b.debug{background:#94a3b8}.vol i b.info{background:#16a34a}.vol i b.log{background:#86efac}.vol i b.warn{background:#d97706}.vol i b.err{background:#dc2626}
.volhead{display:flex;justify-content:space-between;gap:12px;align-items:center;color:var(--muted);font-size:12.5px}
.volcard{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:12px 14px 8px;margin:12px 0}
.vol{cursor:crosshair;user-select:none}
.volaxis{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin:2px 2px 8px;font-variant-numeric:tabular-nums}
.loaded{display:flex;gap:16px;align-items:baseline;margin:10px 0 6px;font-size:14px}
.loaded b{font-weight:650}
.zoomhint{margin-left:10px}
.voltitle b{color:var(--fg);font-weight:650}
.logsql{color:var(--muted);font-size:13px;white-space:nowrap}
.logtbl .lvdot{display:inline-flex;align-items:center;gap:6px}
.logtbl .lvdot::before{content:"";width:8px;height:8px;border-radius:50%;background:#86efac;flex:none}
.logtbl .lvdot.info::before{background:#16a34a}
.logtbl .lvdot.warn::before{background:#d97706}
.logtbl .lvdot.err::before{background:#dc2626}
.logtbl .lvdot.debug::before{background:#94a3b8}
.logtbl .ch{opacity:.35}
.volhead .legend b{border-radius:2px}
.evtrow{display:grid;grid-template-columns:9.5rem 11rem 1fr;gap:10px;padding:8px 2px;border-bottom:1px solid var(--line);font-size:13.5px;align-items:baseline}
.cause{border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:14px 0;background:var(--panel)}
.cause h2{margin:0 0 6px;font-size:15px;display:flex;gap:8px;align-items:center}
.cause p{margin:0 0 10px;white-space:pre-wrap}
.logtbl .lv{font-size:11px}.hostrow{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line);font-size:13.5px}
.hostrow:last-child{border-bottom:0}.hostrow .nm{flex:1;font-weight:500}.hostrow .tag{font-size:10.5px;border:1px solid var(--line);border-radius:99px;padding:1px 7px;color:var(--muted);text-transform:lowercase}
.chart{width:100%;height:180px}.chart .axis{font:10px ui-sans-serif,system-ui,sans-serif;fill:var(--muted)}
.back{display:inline-flex;align-items:center;gap:4px;color:var(--muted);text-decoration:none;font-size:13px;margin-bottom:8px}
.back:hover{color:var(--fg)}.back .ico{transform:rotate(180deg)}
.legend{display:flex;gap:12px;font-size:12px;color:var(--muted);justify-content:flex-end;margin-bottom:4px}
.legend b{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}
details.evt{border:1px solid var(--line);border-radius:10px;background:var(--panel);margin:8px 0;padding:10px 14px}
details.evt summary{cursor:pointer;list-style:none;display:flex;gap:10px;align-items:baseline}
details.evt summary::-webkit-details-marker{display:none}
details.evt .kvb{font:12.5px/1.5 ui-monospace,Menlo,monospace;background:var(--soft);border-radius:8px;padding:10px 12px;margin:10px 0 6px;display:flex;flex-wrap:wrap;gap:8px 16px}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 16px}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.actions form{display:inline}
.actions a,.actions button{border:1px solid var(--line);border-radius:999px;padding:6px 12px;text-decoration:none;font-size:13px;background:var(--bg);color:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.actions button.ask{background:#0d9488;border-color:#0d9488;color:#fff}
.askbox{border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:12px 0;background:var(--panel)}
.askbox textarea{width:100%;min-height:72px;margin:8px 0}
.notice{border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:8px 0;background:var(--chip)}
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
  const fWin = windowMs(c.query.get("w") ?? "") ? c.query.get("w")! : "";
  const fW = fWin ? `&w=${encodeURIComponent(fWin)}` : "";
  const findingsOpen = active === "/findings" || active.startsWith("/findings/");
  const alertsOpen = active.startsWith("/alerts");
  const integOpen = active === "/integrations";
  const navItem = (href: string, key: Key, icon: IconName, extra = "") =>
    `<a class="n ${on(href)}" href="${b}${href}">${ico(icon)} ${L(key)}${extra}</a>`;
  const sub = (href: string, key: Key, n?: number, isOn?: boolean) =>
    `<a class="${isOn ? "on" : ""}" href="${b}${href}">${L(key)}${n !== undefined ? ` ${n}` : ""}</a>`;
  const fSpan = windowMs(c.query.get("w") ?? "");
  const fTime = fSpan ? " AND updated>=?" : "";
  const fArgs = fSpan ? [c.now - fSpan] : [];
  const fCount = (w: string) => (c.db.prepare(`SELECT count(*) n FROM findings WHERE ${w}${fTime}`).get(...fArgs) as { n: number }).n;
  const nOpen = findingsOpen ? fCount("status IN ('open','ongoing') AND ignored=0") : 0;
  const nAll = findingsOpen ? fCount("1=1") : 0;
  const nRes = findingsOpen ? fCount("status='resolved'") : 0;
  const nIgn = findingsOpen ? fCount("ignored=1") : 0;
  return `<!doctype html><html lang="${c.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${L("brand")}</title><style>${CSS}</style><script>${THEME_JS}</script>${c.refreshSec ? `<meta http-equiv="refresh" content="${Math.min(60, Math.max(5, Math.round(c.refreshSec)))}">` : ""}${extraHead(c.config)}</head>
<body><div class="shell"><aside>
  <div class="brand">${ico("cloud", "logo")} ${L("brand")} <small>${L("selfHosted")}</small></div>
  <div class="inst">${ico("server")}<span class="grow" title="${esc(instLabel)}">${esc(instLabel)}</span>${ico("chevronDown")}</div>
  <nav>
    <a class="n" href="/">${ico("boxes")} ${L("viewer")}</a>
    ${navItem("", "overview", "house")}
    ${navItem("/findings", "findings", "bell", ico("chevronRight", "ch"))}
    ${findingsOpen ? `<div class="sub">${sub(`/findings?tab=open${fW}`, "needsAttention", nOpen, fTab === "open")}${sub(`/findings?tab=all${fW}`, "all", nAll, fTab === "all")}${sub(`/findings?tab=resolved${fW}`, "resolved", nRes, fTab === "resolved")}${sub(`/findings?tab=ignored${fW}`, "ignored", nIgn, fTab === "ignored")}</div>` : ""}
    ${navItem("/updates", "updates", "refresh")}
    ${navItem("/alerts", "alerts", "bell", ico("chevronRight", "ch"))}
    ${alertsOpen ? `<div class="sub">${sub("/alerts", "alerts", undefined, active === "/alerts")}${sub("/alerts/events", "events", undefined, active === "/alerts/events")}${sub("/alerts/muted", "muted", undefined, active === "/alerts/muted")}</div>` : ""}
    <hr>
    ${navItem("/logs", "logs", "terminal")}
    ${navItem("/metrics", "metrics", "chart")}
    <hr>
    ${navItem("/instances", "instances", "server", ico("chevronRight", "ch"))}
    ${navItem("/integrations", "integrations", "puzzle", ico("chevronRight", "ch"))}
    ${integOpen ? `<div class="sub">${sub("/integrations", "notifications", undefined, (c.query.get("tab") ?? "notifications") === "notifications")}${sub("/integrations?tab=chat", "chat", undefined, c.query.get("tab") === "chat")}${sub("/integrations?tab=mcp", "mcp", undefined, c.query.get("tab") === "mcp")}</div>` : ""}
  </nav>
</aside>
<div><header class="top">
  <form class="search" action="${b}/logs">${ico("search")}<input name="q" placeholder="${L("searchAsk")}" value="${esc(c.query.get("q") ?? "")}" autocomplete="off"><kbd>${ico("kbd")}</kbd></form>
  <a class="iconbtn" href="/notifications" title="${L("notifications")}">${ico("bell")}</a>
  <a class="iconbtn" href="${b}" title="${L("brand")}">${ico("cloud")}</a>
  <a class="iconbtn" href="/settings" title="${L("viewerSettings")}">${ico("cog")}</a>
  <a class="iconbtn" href="${b}/ask" title="${L("askAbout")}">${ico("sparkles")}</a>
  <button class="iconbtn" type="button" onclick="cycleLang()" title="${c.lang === "fr" ? "English" : "Français"}">${c.lang.toUpperCase()}</button>
  <button class="iconbtn" type="button" id="themebtn" onclick="cycleTheme()" title="${L("theme")}">${ico("sun")}</button>
  ${c.user ? `<a class="avatar" href="${b}/auth/logout" title="${esc(c.user)} · ${L("signOut")}">${esc(initials(c.user))}</a>` : ""}
</header>
<main>${c.breakglass ? `<div class="card" style="background:#b91c1c;color:#fff;border:0">Session de secours (1 h) · Break-glass session (1 h)</div>` : ""}${body}</main></div></div></body></html>`;
}

function fmtTime(ms: number, c: PageCtx, withDate = false): string {
  return new Date(ms).toLocaleString(c.lang === "fr" ? "fr-BE" : "en-US", {
    timeZone: c.config.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: c.lang !== "fr",
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

/** A stat older than this is not "now". Stats do not refresh last_seen, so this window is the freshness test. */
const FRESH_MS = 180_000;

/** Dozzle reports `v11.3.4` already. Prefixing another v produced `vv11.3.4`. */
export function verLabel(v: string | undefined | null): string {
  const s = String(v ?? "").trim().replace(/^v+/i, "");
  return s ? `v${s}` : "?";
}

/** Dozzle's own engine is `type=local`. Agents are `type=agent`. */
export function hostRole(type: string): "server" | "agent" {
  return type === "local" || type === "server" ? "server" : "agent";
}

function stride<T>(values: T[], points: number): T[] {
  if (values.length <= points) return values;
  const step = Math.ceil(values.length / points);
  return values.filter((_, i) => i % step === 0);
}

function seriesFor(db: Db, instance: string, host: string, name: string, from: number, field: "cpu_avg" | "mem_avg", points = 30): number[] {
  const rows = db.prepare(`SELECT ${field} v FROM metric_roll WHERE instance_id=? AND host=? AND container_name=? AND ts>=? ORDER BY ts`).all(instance, host, name, from) as { v: number | null }[];
  return stride(rows.map((r) => r.v ?? 0), points);
}

function seriesAll(db: Db, from: number, points = 48): Map<string, { cpu: number[]; mem: number[] }> {
  const rows = db.prepare("SELECT instance_id i, host h, container_name n, cpu_avg c, mem_avg m FROM metric_roll WHERE ts>=? ORDER BY i, h, n, ts").all(from) as { i: string; h: string; n: string; c: number | null; m: number | null }[];
  const out = new Map<string, { cpu: number[]; mem: number[] }>();
  for (const r of rows) {
    const k = `${r.i}|${r.h}|${r.n}`;
    let e = out.get(k);
    if (!e) out.set(k, (e = { cpu: [], mem: [] }));
    e.cpu.push(r.c ?? 0);
    e.mem.push(r.m ?? 0);
  }
  for (const [k, e] of out) out.set(k, { cpu: stride(e.cpu, points), mem: stride(e.mem, points) });
  return out;
}

function hostNames(db: Db): Map<string, string> {
  return new Map((db.prepare("SELECT id, name FROM hosts").all() as { id: string; name: string }[]).map((r) => [r.id, r.name]));
}

function hostInfo(db: Db, instance: string, id: string): { name: string; type: string; mem: number; ncpu: number; agentVersion: string } {
  const r = db.prepare("SELECT name, json FROM hosts WHERE instance_id=? AND id=?").get(instance, id) as { name: string; json: string } | undefined;
  let type = "", mem = 0, ncpu = 0, agentVersion = "";
  try {
    const j = JSON.parse(r?.json ?? "{}") as { type?: string; memTotal?: number; nCPU?: number; agentVersion?: string };
    type = String(j.type ?? "");
    mem = Number(j.memTotal ?? 0);
    ncpu = Number(j.nCPU ?? 0);
    agentVersion = String(j.agentVersion ?? "");
  } catch {
    /* ignore */
  }
  return { name: r?.name || id, type, mem, ncpu, agentVersion };
}

function hostMemTotal(db: Db): number {
  const rows = db.prepare("SELECT json FROM hosts").all() as { json: string }[];
  let s = 0;
  for (const r of rows) {
    try {
      s += Number((JSON.parse(r.json) as { memTotal?: number }).memTotal ?? 0);
    } catch {
      /* ignore */
    }
  }
  return s;
}

interface LiveRow {
  instance_id: string;
  host: string;
  name: string;
  cpu: number;
  cpu_pk: number;
  mem: number;
  pct: number;
}

/** One row per container name. Docker CPU% is already "100 = one core". */
function collapseLive(rows: LiveRow[]): LiveRow[] {
  const m = new Map<string, LiveRow>();
  for (const r of rows) {
    const k = `${r.instance_id}|${r.host}|${r.name}`;
    const e = m.get(k);
    if (!e) m.set(k, { ...r });
    else {
      e.cpu += r.cpu;
      e.mem += r.mem;
      e.cpu_pk = Math.max(e.cpu_pk, r.cpu_pk);
      e.pct = Math.max(e.pct, r.pct);
    }
  }
  return [...m.values()];
}

function liveRows(db: Db, now: number, onlyRunning: boolean): LiveRow[] {
  if (onlyRunning) {
    return collapseLive(
      db.prepare(
        `SELECT l.instance_id, l.host, l.container_name name, l.cpu, l.cpu_max cpu_pk, l.mem, l.mem_pct pct
         FROM live_metrics l
         JOIN containers c ON c.instance_id=l.instance_id AND c.id=l.container_id AND c.state='running'
         WHERE l.ts>=?`,
      ).all(now - FRESH_MS) as unknown as LiveRow[],
    );
  }
  return collapseLive(
    db.prepare(
      `SELECT r.instance_id, r.host, r.container_name name, r.cpu_avg cpu, r.cpu_max cpu_pk, r.mem_avg mem, r.mem_pct_avg pct
       FROM metric_roll r
       JOIN (SELECT instance_id, container_id, max(ts) ts FROM metric_roll GROUP BY instance_id, container_id) x
         ON x.instance_id=r.instance_id AND x.container_id=r.container_id AND x.ts=r.ts`,
    ).all() as unknown as LiveRow[],
  );
}

/** Container-sum CPU (can exceed 100) and memory of containers that reported in the last 3 min. */
function nowStats(db: Db, now: number): { cpu: number; mem: number; n: number } {
  const rows = liveRows(db, now, true);
  return { cpu: rows.reduce((s, r) => s + r.cpu, 0), mem: rows.reduce((s, r) => s + r.mem, 0), n: rows.length };
}

/** Host utilization = sum(container CPU%) / nCPU. nCPU 0 keeps the raw sum. */
function hostUtil(db: Db, instance: string, host: string, cpuSum: number): number {
  const ncpu = hostInfo(db, instance, host).ncpu;
  return ncpu > 0 ? cpuSum / ncpu : cpuSum;
}

/** Running containers this host still reports. Ghosts stay state=running until the next full snapshot. */
function aliveCount(db: Db, instance: string, host: string, now: number): number {
  const fresh = now - FRESH_MS;
  const n = (db.prepare(
    `SELECT count(*) n FROM live_metrics l
     JOIN containers c ON c.instance_id=l.instance_id AND c.id=l.container_id AND c.state='running'
     WHERE l.instance_id=? AND l.host=? AND l.ts>=?`,
  ).get(instance, host, fresh) as { n: number }).n;
  const any = (db.prepare("SELECT count(*) n FROM live_metrics WHERE ts>=?").get(fresh) as { n: number }).n;
  if (any > 0) return n;
  return (db.prepare("SELECT count(*) n FROM containers WHERE instance_id=? AND host=? AND state='running' AND last_seen>?").get(instance, host, now - 600_000) as { n: number }).n;
}

export interface LogRow {
  ts: string;
  level: string;
  container: string;
  message: string;
}

export function parseLogsql(raw: string): { query?: string; container?: string; levels?: string[] } {
  let s = raw.trim();
  let container: string | undefined;
  const levels: string[] = [];
  s = s.replace(/\bcontainer_name:(\S+)/gi, (_, n: string) => {
    container = n.replace(/^["']|["']$/g, "");
    return "";
  });
  s = s.replace(/\blevel:(\S+)/gi, (_, n: string) => {
    for (const x of n.split(",")) levels.push(x.toLowerCase());
    return "";
  });
  s = s.replace(/^\s*LogsQL\s+/i, "").replace(/\bAND\b/gi, " ").replace(/\s+/g, " ").trim();
  return { query: s || undefined, container, levels: levels.length ? levels : undefined };
}

const LOG_LEVELS = ["debug", "info", "log", "warn", "error"] as const;

export function levelBucket(level: string): (typeof LOG_LEVELS)[number] {
  const l = level.toLowerCase();
  if (l === "error" || l === "err" || l === "fatal") return "error";
  if (l === "warn" || l === "warning") return "warn";
  if (l === "info") return "info";
  if (l === "debug" || l === "trace") return "debug";
  return "log";
}

/** Split [from, to] into n buckets and count lines by level. */
export function logBars(rows: { ts: number; level: string }[], from: number, to: number, n = 24): number[][] {
  const span = Math.max(1, to - from);
  const bars = Array.from({ length: n }, () => [0, 0, 0, 0, 0]);
  for (const r of rows) {
    if (!r.ts) continue;
    let i = Math.floor(((r.ts - from) / span) * n);
    if (i < 0) i = 0;
    if (i >= n) i = n - 1;
    bars[i]![LOG_LEVELS.indexOf(levelBucket(r.level))]!++;
  }
  return bars;
}

/** Pull method, path, status and duration out of a line when it looks like an access log. */
export function parseAccess(message: string): { method: string; path: string; status: string; duration: string; text: string } {
  let method = "";
  let path = "";
  let status = "";
  let duration = "";
  let text = message;
  if (message.trimStart().startsWith("{")) {
    try {
      const j = JSON.parse(message) as Record<string, unknown>;
      if (typeof j.method === "string") method = j.method;
      const p = j.path ?? j.url ?? j.uri;
      if (typeof p === "string") path = p;
      const s = j.status ?? j.statusCode;
      if (s != null && typeof s !== "object") status = String(s);
      const d = j.duration ?? j.latency;
      if (d != null && typeof d !== "object") duration = String(d);
      if (typeof j.message === "string") text = j.message;
      else if (typeof j.msg === "string") text = j.msg;
    } catch {
      /* not JSON */
    }
  }
  const quoted = message.match(/"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(?:\s+HTTP\/[\d.]+)?"\s+(\d{3})/i);
  const bare = message.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)/);
  const http = quoted ?? bare;
  if (http) {
    method = method || http[1]!.toUpperCase();
    path = path || http[2]!;
    if (http[3]) status = status || http[3];
  }
  const st = message.match(/\bstatus[=: ](\d{3})\b/i);
  if (st && !status) status = st[1]!;
  const dur = message.match(/\b(?:duration|latency|took)[=: ](\d+(?:\.\d+)?)(ms|µs|us|s)?\b/i);
  if (dur && !duration) duration = `${dur[1]}${dur[2] ?? ""}`;
  if (path) text = path;
  return { method, path, status, duration, text };
}

export function parseLogText(text: string): LogRow[] {
  const rows: LogRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("(")) continue;
    const m = line.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (m) rows.push({ ts: m[1]!, level: m[2]!.trim(), container: m[3]!, message: m[4]! });
    else rows.push({ ts: "", level: "", container: "", message: line });
  }
  return rows;
}

function lvClass(level: string): string {
  const l = level.toLowerCase();
  if (l === "error" || l === "fatal" || l === "err") return "err";
  if (l === "warn" || l === "warning") return "warn";
  if (l === "info") return "info";
  if (l === "debug" || l === "trace") return "debug";
  return "log";
}

function chart(
  series: { t: number; a: number; p?: number }[],
  color: string,
  w = 720,
  h = 160,
  yFmt: (n: number) => string = (n) => String(Math.round(n)),
  tz = "Europe/Brussels",
): string {
  if (series.length < 2) return `<svg class="chart" width="${w}" height="${h}"></svg>`;
  const padL = 48, padR = 8, padT = 8, padB = 22;
  const iw = w - padL - padR, ih = h - padT - padB;
  const max = Math.max(...series.map((s) => Math.max(s.a, s.p ?? 0)), 1e-9);
  const x = (i: number) => padL + (i / (series.length - 1)) * iw;
  const y = (v: number) => padT + ih - (v / max) * ih;
  const avg = series.map((s, i) => `${x(i).toFixed(1)},${y(s.a).toFixed(1)}`);
  const peak = series[0]?.p != null ? series.map((s, i) => `${x(i).toFixed(1)},${y(s.p ?? 0).toFixed(1)}`) : [];
  const ticks = [0, 0.5, 1].map((f) => {
    const v = max * f;
    const yy = y(v);
    return `<line x1="${padL}" x2="${w - padR}" y1="${yy}" y2="${yy}" stroke="currentColor" opacity=".08"/><text class="axis" x="${padL - 6}" y="${yy + 3}" text-anchor="end">${esc(yFmt(v))}</text>`;
  });
  const nLab = Math.min(6, series.length);
  const labs = Array.from({ length: nLab }, (_, i) => {
    const idx = Math.round((i / (nLab - 1)) * (series.length - 1));
    const t = series[idx]!.t;
    const label = new Date(t).toLocaleString("en-GB", { timeZone: tz, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
    return `<text class="axis" x="${x(idx)}" y="${h - 6}" text-anchor="middle">${esc(label)}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
    ${ticks.join("")}
    <polygon points="${padL},${padT + ih} ${avg.join(" ")} ${padL + iw},${padT + ih}" fill="${color}" opacity=".16"/>
    <polyline points="${avg.join(" ")}" fill="none" stroke="${color}" stroke-width="1.6"/>
    ${peak.length ? `<polyline points="${peak.join(" ")}" fill="none" stroke="#d97706" stroke-width="1.2" opacity=".85"/>` : ""}
    ${labs.join("")}
  </svg>`;
}

function seriesDetail(db: Db, instance: string, host: string, name: string, from: number, points = 96): { t: number; cpu: number; cpuPk: number; mem: number; memPk: number; pct: number; rx: number; tx: number; dr: number; dw: number }[] {
  const rows = db
    .prepare(
      `SELECT ts t, cpu_avg cpu, cpu_max cpuPk, mem_avg mem, mem_max memPk, mem_pct_avg pct, net_rx rx, net_tx tx, disk_r dr, disk_w dw
       FROM metric_roll WHERE instance_id=? AND host=? AND container_name=? AND ts>=? ORDER BY ts`,
    )
    .all(instance, host, name, from) as { t: number; cpu: number; cpuPk: number; mem: number; memPk: number; pct: number; rx: number; tx: number; dr: number; dw: number }[];
  return stride(rows, points);
}

function instanceName(c: PageCtx, id: string): string {
  return c.config.instances.find((i) => i.id === id)?.name ?? id;
}

function daysOpen(f: Record<string, unknown>, now: number): number {
  const created = Number(f.created ?? now);
  const resolved = f.resolved_at == null ? now : Number(f.resolved_at);
  return Math.max(0, Math.floor((resolved - created) / 864e5));
}

function firstSeenLabel(c: PageCtx, created: number): string {
  return t(c.lang, "firstSeen", {
    when: new Date(created).toLocaleDateString(c.lang === "fr" ? "fr-BE" : "en-US", {
      timeZone: c.config.timezone,
      month: "short",
      day: "numeric",
    }),
  });
}

function findingRow(c: PageCtx, f: Record<string, string & number>, opts: { compact?: boolean } = {}): string {
  const L = (k: Key, v?: Record<string, string | number>) => esc(t(c.lang, k, v));
  const names = parseNames(f.containers);
  const sev = String(f.severity ?? "medium");
  const days = daysOpen(f, c.now);
  const inst = instanceName(c, String(f.instance_id ?? ""));
  const fresh = c.now - Number(f.created) < 36 * H;
  const why = f.why ? String(f.why) : "";
  const whyShort = why.length > 280 ? why.slice(0, 277) + "…" : why;
  const seen = f.status === "resolved" ? L("resolved") : days === 0 ? esc(firstSeenLabel(c, Number(f.created))) : L("stillHappening", { n: days });
  return `<a class="find" href="${c.config.basePath}/findings/${f.id}">
    <span class="dot ${esc(sev)}"></span>
    <div>
      <h3>${esc(f.headline)}${fresh && f.status !== "resolved" ? `<span class="badge-new">${L("newError")}</span>` : ""}</h3>
      ${opts.compact ? "" : whyShort ? `<p class="why">${esc(whyShort)}</p>` : ""}
      ${f.fix ? `<p class="fix">${L("fix")}: ${esc(f.fix)}</p>` : ""}
      <div class="meta"><span>${seen}</span><span>${esc(names.join(", "))}</span><span>${esc(inst)}</span></div>
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
      `SELECT ts, 'alert' k, title, status, container_name, id FROM alerts WHERE ts>=? AND status='sent'
       UNION ALL SELECT resolved_at ts, 'resolved' k, headline title, 'resolved' status, containers container_name, id FROM findings WHERE resolved_at>=?
       ORDER BY ts DESC LIMIT 10`,
    )
    .all(now - 24 * H, now - 24 * H) as { ts: number; k: string; title: string; status: string; container_name: string; id: number }[];
  const open = db.prepare("SELECT * FROM findings WHERE status IN ('open','ongoing') AND ignored=0 ORDER BY updated DESC LIMIT 5").all() as Record<string, string & number>[];
  const nHappened = (db.prepare("SELECT count(*) n FROM alerts WHERE ts>=? AND status='sent'").get(now - 24 * H) as { n: number }).n;
  const wk = db.prepare("SELECT sum(status='sent') s, sum(status<>'sent') q FROM alerts WHERE ts>=?").get(now - 7 * 24 * H) as { s: number | null; q: number | null };
  const s = wk.s ?? 0, q = wk.q ?? 0;
  const live = nowStats(db, now);
  const topRunning = (col: "cpu" | "mem") =>
    (db
      .prepare(
        `SELECT l.instance_id, l.host, l.container_name name, l.${col} v
         FROM live_metrics l JOIN containers c ON c.instance_id=l.instance_id AND c.id=l.container_id AND c.state='running'
         WHERE l.ts>=? ORDER BY v DESC LIMIT 5`,
      )
      .all(now - FRESH_MS) as { instance_id: string; host: string; name: string; v: number }[]);
  const topListLive = (col: "cpu" | "mem", color: string) =>
    topRunning(col)
      .map((r) => `<div class="kv"><span>${esc(r.name)}</span><span style="display:flex;gap:8px;align-items:center">${spark(seriesFor(db, r.instance_id, r.host, r.name, now - 24 * H, col === "cpu" ? "cpu_avg" : "mem_avg"), color, 88, 22)}<span class="mono">${col === "cpu" ? pctS(r.v) : fmtBytes(r.v)}</span></span></div>`)
      .join("");
  return layout(
    c,
    "",
    t(c.lang, "overview"),
    `<p class="muted">${ico("bell")} ${L("weekLine", { sent: s, quiet: q, pct: s + q ? Math.round((100 * q) / (s + q)) : 0 })} · <a class="link" href="${b}/alerts">${L("viewAlerts")}</a></p>
<div class="pagehead"><h2 style="margin-top:8px">${L("whatHappened")}</h2><span class="muted">${L("last24h")}</span></div>
${happened
  .map((h) => {
    const href = h.k === "resolved" ? `${b}/findings/${h.id}` : `${b}/alerts/${h.id}`;
    return `<a class="row" href="${href}"><div class="t">${fmtTime(h.ts, c)}</div><div class="b">${ico("bell", "bell")} <b>${h.k === "resolved" ? L("resolved") : L("alertSent")}:</b> ${esc(h.title)}<div class="s">${esc(h.container_name ?? "")} · ${esc(instanceName(c, c.config.instances[0]?.id ?? ""))}</div></div>${ico("chevronRight", "ch")}</a>`;
  })
  .join("") || `<p class="muted">—</p>`}
${nHappened ? `<p class="muted"><a class="link" href="${b}/alerts">${L("showAll", { n: nHappened })}</a></p>` : ""}
<h2>${L("worthFixing")}</h2>
${open.length ? open.map((f) => findingRow(c, f)).join("") : `<div class="card">✓ ${L("nothingToFix")}</div>`}
<h2>${L("resources24h")} <a class="link" style="float:right;font-size:13px;font-weight:400" href="${b}/metrics">${L("allMetrics")}</a></h2>
<div class="grid2">
  <div><div class="stat">${ico("cpu")} ${L("cpu")}</div><div class="big">${pctS(live.cpu)}</div><div class="muted">${L("acrossN", { n: live.n })}</div>${topListLive("cpu", "var(--cpu)")}</div>
  <div><div class="stat">${ico("memory")} ${L("memory")}</div><div class="big">${fmtBytes(live.mem)}</div><div class="muted">${L("acrossN", { n: live.n })}</div>${topListLive("mem", "var(--mem)")}</div>
</div>`,
  );
}

export function findings(c: PageCtx): string {
  const L = (k: Key, v?: Record<string, string | number>) => esc(t(c.lang, k, v));
  const tab = c.query.get("tab") ?? "open";
  const win = windowMs(c.query.get("w") ?? "") ? c.query.get("w")! : "all";
  const span = win === "all" ? undefined : windowMs(win);
  const time = span ? " AND updated>=?" : "";
  const timeArgs = span ? [c.now - span] : [];
  const where = tab === "all" ? "1=1" : tab === "resolved" ? "status='resolved'" : tab === "ignored" ? "ignored=1" : "status IN ('open','ongoing') AND ignored=0";
  const rows = c.db.prepare(`SELECT * FROM findings WHERE ${where}${time} ORDER BY (status='resolved'), updated DESC LIMIT 200`).all(...timeArgs) as Record<string, string & number>[];
  const count = (w: string) => (c.db.prepare(`SELECT count(*) n FROM findings WHERE ${w}${time}`).get(...timeArgs) as { n: number }).n;
  const b = c.config.basePath;
  const tabs = [
    ["open", "needsAttention", count("status IN ('open','ongoing') AND ignored=0")],
    ["all", "all", count("1=1")],
    ["resolved", "resolved", count("status='resolved'")],
    ["ignored", "ignored", count("ignored=1")],
  ] as const;
  const when = `${String(c.config.reviewHour).padStart(2, "0")}:00`;
  const tabIco: Record<string, IconName> = { open: "bell", all: "list", resolved: "bell", ignored: "filter" };
  const href = (k: string, w: string) => `${b}/findings?tab=${k}${w === "all" ? "" : `&w=${encodeURIComponent(w)}`}`;
  const wins = ["all", ...TIME_WINDOWS] as const;
  return layout(
    c,
    "/findings",
    t(c.lang, "findings"),
    `<div class="pagehead"><div><h1>${ico("bell")} ${L("findings")}</h1><p class="muted">${L("findingsIntro")}</p></div>
<div class="right">${c.config.llm ? L("nextReview", { when }) : L("noLlm")}</div></div>
<div class="pills">${wins.map((w) => `<a class="${win === w ? "on" : ""}" href="${href(tab, w)}">${w === "all" ? L("windowAll") : w}</a>`).join("")}</div>
<div class="tabs">${tabs.map(([k, l, n]) => `<a class="${tab === k ? "on" : ""}" href="${href(k, win)}">${ico(tabIco[k] ?? "bell")} ${L(l)} ${n}</a>`).join("")}</div>
${rows.length ? rows.map((f) => findingRow(c, f)).join("") : `<div class="card">✓ ${L("nothingToFix")}</div>`}`,
  );
}

export function findingDetail(c: PageCtx, id: number, logs?: string, extra: { ask?: string; notice?: string } = {}): string {
  const L = (k: Key, v?: Record<string, string | number>) => esc(t(c.lang, k, v));
  const f = c.db.prepare("SELECT * FROM findings WHERE id=?").get(id) as Record<string, string & number> | undefined;
  if (!f) return layout(c, "/findings", t(c.lang, "findings"), `<p class="muted">#${id}</p>`);
  const names = parseNames(f.containers);
  const sev = String(f.severity ?? "medium");
  const rows = logs ? parseLogText(logs) : [];
  const b = c.config.basePath;
  return layout(
    c,
    "/findings",
    String(f.headline),
    `<a class="back" href="${b}/findings">${ico("chevronRight")} ${L("findings")}</a>
<div class="pagehead"><h1>${ico("bell")} ${esc(f.headline)}</h1>
<span class="chip ${sev === "high" || sev === "critical" ? "err" : sev === "low" ? "info" : "warn"}">${esc(sev)}</span>
${actionBar(c, `${b}/findings/${id}`, { fix: f.status !== "resolved", ignore: !f.ignored, ask: true })}</div>
<p class="muted">${esc(firstSeenLabel(c, Number(f.created)))} · ${esc(names.join(", "))} · ${esc(instanceName(c, String(f.instance_id)))}</p>
${askBox(c, `${b}/findings/${id}`, extra.ask, extra.notice)}
${f.why ? `<p>${esc(f.why)}</p>` : ""}
${f.fix ? `<p class="fix">${L("fix")}<br>${esc(f.fix)}</p>` : ""}
<h2>${L("whatLogsShow")}</h2>
${
  rows.length
    ? `<table class="logtbl"><tr><th>${L("when")}</th><th>${L("level")}</th><th>${L("container")}</th><th>${L("message")}</th></tr>${rows
        .slice(-80)
        .map((r) => `<tr><td class="mono">${esc(r.ts)}</td><td><span class="chip ${lvClass(r.level)}">${esc(r.level)}</span></td><td class="mono">${esc(r.container)}</td><td>${esc(r.message.slice(0, 500))}</td></tr>`)
        .join("")}</table>`
    : `<p class="muted">—</p>`
}`,
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
    const rows = c.db.prepare("SELECT * FROM alerts WHERE ts>=? AND status!='resolved' ORDER BY ts DESC LIMIT 200").all(c.now - 14 * 24 * H) as Record<string, string & number>[];
    body = rows.length
      ? rows
          .map((a) => {
            const sev = a.status === "sent" ? (a.level === "error" ? "high" : "medium") : "ok";
            return `<a class="find" href="${b}/alerts/${a.id}">
              <span class="dot ${sev}"></span>
              <div>
                <h3>${esc(a.title)}</h3>
                ${a.summary ? `<p class="why">${esc(a.summary)}</p>` : ""}
                <div class="meta"><span>${esc(a.status === "sent" ? t(c.lang, "alertSent") : a.status === "muted" ? t(c.lang, "muted") : `${t(c.lang, "suppressed")} · ${a.suppressed_reason}`)}</span><span>${esc(a.container_name ?? "")}</span><span>${L("eventsN", { n: a.event_count })}</span>${a.absorbed ? `<span>${a.absorbed} ${L("absorbed")}</span>` : ""}</div>
              </div>
              <span class="muted" style="font-size:12.5px;white-space:nowrap">${relTime(a.ts, c)} ${ico("chevronRight", "ch")}</span>
            </a>`;
          })
          .join("")
      : `<div class="card">${L("noAlerts")}</div>`;
  } else if (tab === "events") {
    const raw = c.query.get("raw") === "1";
    const lv = c.query.get("lv") ?? "all";
    const from = c.now - 24 * H;
    const noise = raw ? "" : " AND name NOT IN ('start','destroy')";
    const lvSql = lv === "error" ? " AND level='error'" : lv === "warn" ? " AND level IN ('warning','warn')" : lv === "info" ? " AND level='info'" : "";
    const rows = c.db.prepare(`SELECT * FROM events WHERE ts>=?${noise}${lvSql} ORDER BY ts DESC LIMIT 200`).all(from) as Record<string, string & number>[];
    const buckets = c.db
      .prepare(`SELECT CAST((ts - ?) / 3600000 AS INTEGER) b, sum(level='error') e, sum(level IN ('warning','warn')) w, count(*) n FROM events WHERE ts>=? GROUP BY b ORDER BY b`)
      .all(from, from) as { b: number; e: number; w: number; n: number }[];
    const maxN = Math.max(1, ...buckets.map((x) => x.n));
    const hist = `<div class="hist" title="${L("events24h")}">${Array.from({ length: 24 }, (_, i) => {
      const bk = buckets.find((x) => x.b === i);
      const n = bk?.n ?? 0;
      const cls = (bk?.e ?? 0) > 0 ? "err" : (bk?.w ?? 0) > 0 ? "warn" : "";
      return `<i class="${cls}" style="height:${Math.max(4, Math.round((n / maxN) * 64))}px"></i>`;
    }).join("")}</div>`;
    const counts = {
      all: (c.db.prepare(`SELECT count(*) n FROM events WHERE ts>=?${noise}`).get(from) as { n: number }).n,
      error: (c.db.prepare(`SELECT count(*) n FROM events WHERE ts>=?${noise} AND level='error'`).get(from) as { n: number }).n,
      warn: (c.db.prepare(`SELECT count(*) n FROM events WHERE ts>=?${noise} AND level IN ('warning','warn')`).get(from) as { n: number }).n,
      info: (c.db.prepare(`SELECT count(*) n FROM events WHERE ts>=?${noise} AND level='info'`).get(from) as { n: number }).n,
    };
    const human = (e: Record<string, string & number>) => {
      let extra = "";
      try {
        const d = JSON.parse(String(e.detail ?? "{}")) as { exitCode?: string; image?: string };
        if (d.exitCode != null) extra = ` (exit code ${d.exitCode})`;
      } catch {
        extra = e.detail ? ` ${String(e.detail).slice(0, 80)}` : "";
      }
      return `Container event: ${e.name}${extra}`;
    };
    body = `<div class="pills">
      <a class="${lv === "all" ? "on" : ""}" href="${b}/alerts/events?lv=all${raw ? "&raw=1" : ""}">${L("all")} ${counts.all}</a>
      <a class="${lv === "error" ? "on" : ""}" href="${b}/alerts/events?lv=error${raw ? "&raw=1" : ""}">${L("filterError")} ${counts.error}</a>
      <a class="${lv === "warn" ? "on" : ""}" href="${b}/alerts/events?lv=warn${raw ? "&raw=1" : ""}">${L("filterWarn")} ${counts.warn}</a>
      <a class="${lv === "info" ? "on" : ""}" href="${b}/alerts/events?lv=info${raw ? "&raw=1" : ""}">${L("filterInfo")} ${counts.info}</a>
    </div>
    <p class="muted">${L("events24h")} · ${raw ? "" : L("hideNoise")}<a class="link" href="${b}/alerts/events?lv=${esc(lv)}${raw ? "" : "&raw=1"}">${raw ? L("hideRaw") : L("showRaw")}</a></p>
    ${hist}
    ${rows
      .map((e) => {
        const sev = e.level === "error" ? "high" : e.level === "warning" || e.level === "warn" ? "medium" : "info";
        return `<div class="find"><span class="dot ${sev}"></span><div><h3>${esc(human(e))}</h3>
          <div class="meta"><span>${esc(e.container_name ?? "")}</span><span>${esc(hn.get(e.host) ?? e.host ?? "")}</span></div></div>
          <span class="muted" style="font-size:12.5px;white-space:nowrap">${relTime(e.ts, c)}</span></div>`;
      })
      .join("") || `<p class="muted">—</p>`}`;
  } else {
    const rows = c.db.prepare("SELECT * FROM mute_rules WHERE active=1 ORDER BY created DESC").all() as Record<string, string & number>[];
    body = rows.length ? `<table>${rows.map((m) => `<tr><td>#${m.alert_id}</td><td>${esc(m.kind)}</td><td>${esc(m.container_name ?? "*")}</td><td class="mono">${esc(m.patterns)}</td></tr>`).join("")}</table>` : `<div class="card">${L("noMutes")}</div>`;
  }
  const tabs = (["alerts", "events", "muted"] as const).map((k) => `<a class="${tab === k ? "on" : ""}" href="${b}/alerts${k === "alerts" ? "" : "/" + k}">${L(k === "alerts" ? "alerts" : k === "events" ? "events" : "muted")}</a>`).join("");
  return layout(c, tab === "alerts" ? "/alerts" : `/alerts/${tab}`, t(c.lang, "alerts"), `<h1>${ico("bell")} ${L("alerts")}</h1><p class="muted">${L("alertsIntro")}</p><div class="tabs">${tabs}</div>${body}`);
}

function parseSample(sample: string | null): { name: string; attrs: Record<string, string> } {
  if (!sample) return { name: "", attrs: {} };
  try {
    const j = JSON.parse(sample) as Record<string, unknown>;
    if (typeof j.name === "string") {
      const attrs = (j.attributes && typeof j.attributes === "object" ? j.attributes : j) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "name" || k === "attributes" || k === "actorId" || k === "timestamp") continue;
        if (v == null || typeof v === "object") continue;
        out[k] = String(v);
      }
      if (typeof j.actorId === "string") out.actorId = j.actorId;
      return { name: j.name, attrs: out };
    }
    if (typeof j.cpu === "number") {
      return { name: "metric", attrs: { cpu: String(j.cpu), memory: String(j.memory ?? ""), memoryUsage: String(j.memoryUsage ?? "") } };
    }
  } catch {
    /* text sample */
  }
  return { name: "log", attrs: { message: sample.slice(0, 400) } };
}

function actionBar(c: PageCtx, actionUrl: string, opts: { fix?: boolean; mute?: boolean; ignore?: boolean; ask?: boolean }): string {
  const L = (k: Key) => esc(t(c.lang, k));
  const btn = (action: string, label: Key, icon: IconName, cls = "") =>
    `<form method="post" action="${actionUrl}"><input type="hidden" name="action" value="${action}"><button class="${cls}" type="submit">${ico(icon)} ${L(label)}</button></form>`;
  return `<div class="actions">${opts.fix ? btn("fix", "markFixed", "check") : ""}${opts.ask ? btn("ask", "askAbout", "sparkles", "ask") : ""}${opts.mute ? btn("mute", "muteThese", "bellOff") : ""}${opts.ignore ? btn("ignore", "ignore", "filter") : ""}</div>`;
}

function askBox(c: PageCtx, actionUrl: string, answer?: string, notice?: string): string {
  const L = (k: Key) => esc(t(c.lang, k));
  return `${notice ? `<p class="notice">${esc(notice)}</p>` : ""}
${answer ? `<div class="askbox"><b>${L("askAbout")}</b><p style="white-space:pre-wrap">${esc(answer)}</p></div>` : ""}
${
  c.config.llm
    ? `<form method="post" action="${actionUrl}" class="askbox"><input type="hidden" name="action" value="ask">
<textarea name="q" placeholder="${L("askPlaceholder")}"></textarea>
<button class="ask" type="submit">${ico("sparkles")} ${L("askSend")}</button></form>`
    : `<p class="muted">${L("askNeedLlm")}</p>`
}`;
}

interface Invest {
  text?: string;
  error?: string;
  at?: number;
  checked?: string[];
}

function investOf(db: Db, id: number): Invest | undefined {
  const raw = kvGet(db, `alert:invest:${id}`);
  if (!raw) return undefined;
  try {
    const j = JSON.parse(raw) as Invest;
    return j && typeof j === "object" ? j : undefined;
  } catch {
    return undefined;
  }
}

function evidenceText(a: Record<string, string & number>): string {
  const sample = a.sample == null ? "" : String(a.sample);
  if (String(a.kind) === "metric") {
    const bits = parseSample(sample);
    if (bits.attrs.cpu) return `cpu ${bits.attrs.cpu}% · memory ${bits.attrs.memory ?? ""}%`;
  }
  if (String(a.kind) === "event") {
    const bits = parseSample(sample);
    const code = bits.attrs.exitCode;
    return `${bits.name || a.kind}${code != null ? ` (exit code ${code})` : ""}`;
  }
  return sample || String(a.summary ?? "");
}

export function alertDetail(c: PageCtx, id: number, extra: { ask?: string; notice?: string } = {}): string {
  const L = (k: Key, v?: Record<string, string | number>) => esc(t(c.lang, k, v));
  const a = c.db.prepare("SELECT * FROM alerts WHERE id=?").get(id) as Record<string, string & number> | undefined;
  const b = c.config.basePath;
  if (!a) return layout(c, "/alerts", t(c.lang, "alerts"), `<a class="back" href="${b}/alerts">${ico("chevronRight")} ${L("backToAlerts")}</a><p class="muted">#${id}</p>`);
  const cont = c.db
    .prepare("SELECT instance_id, host, name FROM containers WHERE name=? ORDER BY (state='running') DESC, last_seen DESC LIMIT 1")
    .get(String(a.container_name ?? "")) as { instance_id: string; host: string; name: string } | undefined;
  const metricsHref = cont ? `${b}/metrics/${encodeURIComponent(cont.instance_id)}/${encodeURIComponent(cont.host)}/${encodeURIComponent(cont.name)}` : `${b}/metrics`;
  const logsHref = `${b}/logs?container=${encodeURIComponent(String(a.container_name ?? ""))}&after=1h`;
  const line = evidenceText(a).slice(0, 500);
  const invest = investOf(c.db, id);
  const checks = [line].filter(Boolean);
  if (invest?.checked?.includes("logs")) checks.push(t(c.lang, "checkedLogs"));
  if (invest?.checked?.includes("events")) checks.push(t(c.lang, "checkedEvents"));
  const when = new Date(Number(a.ts)).toLocaleString(c.lang === "fr" ? "fr-BE" : "en-US", {
    timeZone: c.config.timezone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: c.lang !== "fr",
  });
  const done = Boolean(invest?.text);
  const causeBody = done
    ? esc(invest?.text)
    : invest?.error === "no-llm"
      ? L("askNeedLlm")
      : invest?.error
        ? esc(invest.error)
        : L("rootUnclearBody");
  const investigated = invest?.at
    ? L("investigatedAt", {
        when: new Date(invest.at).toLocaleString(c.lang === "fr" ? "fr-BE" : "en-US", {
          timeZone: c.config.timezone,
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: c.lang !== "fr",
        }),
      })
    : "";
  return layout(
    c,
    "/alerts",
    String(a.title ?? t(c.lang, "alerts")),
    `<a class="back" href="${b}/alerts">${ico("chevronRight")} ${L("backToAlerts")}</a>
<div class="pagehead"><h1>${esc(a.title)}</h1>${actionBar(c, `${b}/alerts/${id}`, { fix: a.status !== "resolved", mute: true, ask: true })}</div>
<p class="muted">${esc(a.container_name ?? "")} / ${esc(when)}${a.status === "resolved" ? ` · ${L("markedFixed")}` : a.status === "muted" ? ` · ${L("muted")}` : ""}</p>
${askBox(c, `${b}/alerts/${id}`, extra.ask, extra.notice)}
${a.summary ? `<p>${esc(a.summary)}</p>` : line && String(a.kind) === "log" ? `<p>${esc(line)}</p>` : ""}
<div class="cause">
  <h2>${ico("search")} ${done ? L("investigation") : L("rootUnclear")}</h2>
  <p>${causeBody}</p>
  ${investigated ? `<p class="muted">${investigated}</p>` : ""}
  ${done ? "" : `<form method="post" action="${b}/alerts/${id}"><input type="hidden" name="action" value="investigate"><button class="ask" type="submit">${ico("search")} ${L("runInvestigation")}</button></form>`}
</div>
<details class="evt"><summary>${L("whatChecked", { n: checks.length })}</summary>
<ul>${checks.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>
<h2>${L("events")} ${Number(a.event_count) || 1}</h2>
<div class="evtrow"><span class="muted">${fmtTime(Number(a.ts), c)}</span><a class="link" href="${logsHref}">${esc(a.container_name ?? "")}</a><span>${esc(line || "—")}</span></div>
<p class="muted"><a class="link" href="${metricsHref}">${L("viewMetrics")}</a></p>`,
  );
}

export function metricsPage(c: PageCtx): string {
  const L = (k: Key, v?: Record<string, string | number>) => esc(t(c.lang, k, v));
  const sortMem = c.query.get("sort") === "memory";
  const hours = Math.min(720, Math.max(1, Number(c.query.get("h") ?? 24)));
  const from = c.now - hours * H;
  const hn = hostNames(c.db);
  const filter = (c.query.get("q") ?? "").trim().toLowerCase();
  const onlyRunning = c.query.get("state") !== "all";
  const hostF = c.query.get("host") ?? "";
  const current = liveRows(c.db, c.now, true);
  const listed = (onlyRunning ? current : liveRows(c.db, c.now, false)).filter((r) => (!hostF || r.host === hostF) && (!filter || r.name.toLowerCase().includes(filter)));
  const peaks = new Map<string, { cpu: number; mem: number }>();
  for (const p of c.db.prepare("SELECT instance_id, host, container_name, max(cpu_max) cpu, max(mem_max) mem FROM metric_roll WHERE ts>=? GROUP BY instance_id, host, container_name").all(from) as { instance_id: string; host: string; container_name: string; cpu: number | null; mem: number | null }[]) {
    peaks.set(`${p.instance_id}|${p.host}|${p.container_name}`, { cpu: p.cpu ?? 0, mem: p.mem ?? 0 });
  }
  listed.sort((a, b) => (sortMem ? b.mem - a.mem : b.cpu - a.cpu));
  const series = seriesAll(c.db, from);
  const sp = (r: { instance_id: string; host: string; name: string }) => series.get(`${r.instance_id}|${r.host}|${r.name}`) ?? { cpu: [], mem: [] };
  const byHost = new Map<string, LiveRow[]>();
  for (const r of listed) byHost.set(r.host, [...(byHost.get(r.host) ?? []), r]);
  const b = c.config.basePath;
  const live = nowStats(c.db, c.now);
  const hostRam = hostMemTotal(c.db);
  let util = 0;
  const seenHost = new Set<string>();
  for (const r of current) {
    if (seenHost.has(r.host)) continue;
    seenHost.add(r.host);
    const cpuSum = current.filter((x) => x.host === r.host).reduce((s, x) => s + x.cpu, 0);
    util += hostUtil(c.db, r.instance_id, r.host, cpuSum);
  }
  const cards = [...byHost.entries()]
    .map(([h, rs]) => {
      const cpu = rs.reduce((s, r) => s + r.cpu, 0);
      const mem = rs.reduce((s, r) => s + r.mem, 0);
      const hi = hostInfo(c.db, rs[0]?.instance_id ?? "", h);
      const utilHere = hostUtil(c.db, rs[0]?.instance_id ?? "", h, cpu);
      const hostCpu = rs.reduce<number[]>((acc, r) => {
        const s = sp(r).cpu;
        const scale = hi.ncpu > 0 ? hi.ncpu : 1;
        return s.map((v, i) => (acc[i] ?? 0) + v / scale);
      }, []);
      const hostMem = rs.reduce<number[]>((acc, r) => {
        const s = sp(r).mem;
        return s.map((v, i) => (acc[i] ?? 0) + v);
      }, []);
      return `<div class="hostbar">${ico("server")} ${esc(hi.name || hn.get(h) || h)} <span class="muted">${rs.length} ${L("containers")}
        <span>${ico("cpu")} ${pctS(utilHere)}</span> ${spark(hostCpu, "var(--cpu)", 72, 18)}
        <span>${ico("memory")} ${fmtBytes(mem)}${hi.mem ? " / " + fmtBytes(hi.mem) : ""}</span> ${spark(hostMem, "var(--mem)", 72, 18)}</span></div>
        <div class="grid3">${rs
          .map((r) => {
            const pk = peaks.get(`${r.instance_id}|${r.host}|${r.name}`);
            const cpuPk = Math.max(r.cpu_pk, pk?.cpu ?? 0);
            return `<a class="card mc" href="${b}/metrics/${encodeURIComponent(r.instance_id)}/${encodeURIComponent(r.host)}/${encodeURIComponent(r.name)}?h=${hours}"><h3>${esc(r.name)} ${ico("expand")}</h3>
               <div class="kv"><div><div class="l">${ico("cpu")} ${L("cpu")}</div><b>${pctS(r.cpu)}</b> <span class="l">${L("peak")} ${pctS(cpuPk)}</span></div>${spark(sp(r).cpu, "var(--cpu)", 140, 36)}</div>
               <div class="kv"><div><div class="l">${ico("memory")} ${L("memory")}</div><b>${fmtBytes(r.mem)}</b> <span class="l">${pctS(r.pct)} ${L("ofLimit")}</span></div>${spark(sp(r).mem, "var(--mem)", 140, 36)}</div></a>`;
          })
          .join("")}</div>`;
    })
    .join("");
  const qs = (k: string, v: string) => {
    const p = new URLSearchParams(c.query);
    p.set(k, v);
    return `${b}/metrics?${p}`;
  };
  return layout(
    c,
    "/metrics",
    t(c.lang, "metrics"),
    `<h1>${ico("chart")} ${L("metrics")}</h1><p class="muted">${L("metricsIntro")}</p>
<form class="filters" method="get" action="${b}/metrics">
<input name="q" placeholder="${L("filterContainers")}" value="${esc(c.query.get("q") ?? "")}">
<select name="h" onchange="this.form.submit()"><option value="1" ${hours === 1 ? "selected" : ""}>1h</option><option value="6" ${hours === 6 ? "selected" : ""}>6h</option><option value="24" ${hours === 24 ? "selected" : ""}>24h</option><option value="168" ${hours === 168 ? "selected" : ""}>7d</option></select>
<select name="state" onchange="this.form.submit()"><option value="running" ${onlyRunning ? "selected" : ""}>${L("running")}</option><option value="all" ${onlyRunning ? "" : "selected"}>${L("all")}</option></select>
<select name="sort" onchange="this.form.submit()"><option value="cpu" ${sortMem ? "" : "selected"}>${t(c.lang, "sortBy")} CPU</option><option value="memory" ${sortMem ? "selected" : ""}>${t(c.lang, "sortBy")} ${t(c.lang, "memory")}</option></select>
</form>
<div class="sum">
  <div class="card"><div class="k">${ico("cpu")} ${L("cpuNow")}</div><div class="v">${pctS(util)}</div></div>
  <div class="card"><div class="k">${ico("memory")} ${L("memory")}</div><div class="v">${hostRam ? L("ofTotal", { used: fmtBytes(live.mem), total: fmtBytes(hostRam) }) : fmtBytes(live.mem)}</div></div>
  <div class="card"><div class="k">${ico("boxes")} ${L("containers")}</div><div class="v">${live.n}</div></div>
  <div class="card"><div class="k">${ico("server")} ${L("hosts")}</div><div class="v">${seenHost.size}</div></div>
</div>
<p class="muted">${L("cpuNowHint")}</p>
<p class="muted">${L("ofN", { shown: listed.length, total: Math.max(current.length, listed.length) })} · <a class="link" href="${qs("state", onlyRunning ? "all" : "running")}">${onlyRunning ? L("all") : L("running")}</a></p>
${cards}`,
  );
}

export function metricDetail(c: PageCtx, instance: string, host: string, name: string, extra: { ask?: string; notice?: string } = {}): string {
  const L = (k: Key) => esc(t(c.lang, k));
  const hours = Math.min(720, Math.max(1, Number(c.query.get("h") ?? 24)));
  const from = c.now - hours * H;
  const pts = Math.min(120, hours * 4);
  const s = seriesDetail(c.db, instance, host, name, from, pts);
  const liveNow = c.db.prepare("SELECT coalesce(sum(cpu),0) cpu, coalesce(sum(mem),0) mem, max(mem_pct) pct, count(*) n FROM live_metrics WHERE instance_id=? AND host=? AND container_name=? AND ts>=?").get(instance, host, name, c.now - FRESH_MS) as { cpu: number; mem: number; pct: number | null; n: number };
  const last = liveNow.n ? { cpu: liveNow.cpu, mem: liveNow.mem, pct: liveNow.pct ?? 0 } : s.at(-1);
  const cpuPk = Math.max(0, ...s.map((x) => x.cpuPk), liveNow.cpu);
  const memPk = Math.max(0, ...s.map((x) => x.memPk), liveNow.mem);
  const ev = c.db.prepare("SELECT ts,name,level,detail FROM events WHERE instance_id=? AND host=? AND container_name=? AND ts>=? AND name NOT IN ('start') ORDER BY ts DESC LIMIT 50").all(instance, host, name, from) as Record<string, string & number>[];
  const b = c.config.basePath;
  const tz = c.config.timezone;
  const hi = hostInfo(c.db, instance, host);
  return layout(
    c,
    "/metrics",
    name,
    `<a class="back" href="${b}/metrics?h=${hours}">${ico("chevronRight")} ${L("backMetrics")}</a>
<div class="pagehead"><h1>${ico("chart")} ${esc(name)}</h1>
  ${actionBar(c, `${b}/metrics/${encodeURIComponent(instance)}/${encodeURIComponent(host)}/${encodeURIComponent(name)}?h=${hours}`, { ask: true })}
  <form><select name="h" onchange="this.form.submit()"><option ${hours === 1 ? "selected" : ""} value="1">1h</option><option ${hours === 6 ? "selected" : ""} value="6">6h</option><option ${hours === 24 ? "selected" : ""} value="24">24h</option><option ${hours === 168 ? "selected" : ""} value="168">7d</option></select></form>
</div>
${askBox(c, `${b}/metrics/${encodeURIComponent(instance)}/${encodeURIComponent(host)}/${encodeURIComponent(name)}?h=${hours}`, extra.ask, extra.notice)}
<p class="muted">${esc(hi.name || hostNames(c.db).get(host) || host)}</p>
<div class="sum">
  <div class="card"><div class="k">${ico("cpu")} ${L("cpuNow")}</div><div class="v">${pctS(last?.cpu)}</div></div>
  <div class="card"><div class="k">${L("cpuPeak")}</div><div class="v">${pctS(cpuPk)}</div></div>
  <div class="card"><div class="k">${ico("memory")} ${L("memory")}</div><div class="v">${fmtBytes(last?.mem)}<div class="l">${pctS(last?.pct)} ${L("ofLimit")}</div></div></div>
  <div class="card"><div class="k">${L("memPeak")}</div><div class="v">${fmtBytes(memPk)}</div></div>
</div>
<div class="legend"><span><b style="background:var(--cpu)"></b>${L("avg")}</span><span><b style="background:#d97706"></b>${L("peak")}</span></div>
<h2>${L("cpu")} %</h2><div class="card">${chart(s.map((x) => ({ t: x.t, a: x.cpu, p: x.cpuPk })), "var(--cpu)", 720, 180, (n) => `${Math.round(n)}%`, tz)}</div>
<h2>${L("memory")}</h2><div class="card">${chart(s.map((x) => ({ t: x.t, a: x.mem, p: x.memPk })), "var(--mem)", 720, 180, fmtBytes, tz)}</div>
<h2>${L("network")} B/s</h2><div class="card">${chart(s.map((x) => ({ t: x.t, a: x.rx, p: x.tx })), "var(--cpu)", 720, 140, (n) => fmtBytes(n) + "/s", tz)}</div>
<h2>${L("disk")} B/s</h2><div class="card">${chart(s.map((x) => ({ t: x.t, a: x.dr, p: x.dw })), "var(--mem)", 720, 140, (n) => fmtBytes(n) + "/s", tz)}</div>
<h2>${L("events")}</h2>${ev.map((e) => `<div class="row"><div class="t">${fmtTime(e.ts, c, true)}</div><div class="b"><span class="chip ${e.level === "error" ? "err" : "q"}">${esc(e.name)}</span></div></div>`).join("") || `<p class="muted">—</p>`}`,
  );
}

export interface LogSearch {
  rows: LogHit[];
  ms: number;
  from: number;
  to: number;
  /** Every stored line in the window. The table only shows `rows`. */
  total?: number;
  bars?: number[][];
  note?: LogNote;
}

function part(ms: number, c: PageCtx, type: Intl.DateTimeFormatPartTypes): string {
  const parts = new Intl.DateTimeFormat(c.lang === "fr" ? "fr-BE" : "en-US", {
    timeZone: c.config.timezone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  return parts.find((p) => p.type === type)?.value ?? "";
}

/** Axis label, month/day and clock, no year. `11/5 13:00:21`. */
function axisClock(ms: number, c: PageCtx): string {
  const h = part(ms, c, "hour").padStart(2, "0");
  return `${part(ms, c, "month")}/${part(ms, c, "day")} ${h}:${part(ms, c, "minute")}:${part(ms, c, "second")}`;
}

/** Row clock with milliseconds. The milliseconds do not depend on the timezone. */
function rowClock(ms: number, c: PageCtx): string {
  const h = part(ms, c, "hour").padStart(2, "0");
  return `${h}:${part(ms, c, "minute")}:${part(ms, c, "second")}.${String(Math.abs(ms) % 1000).padStart(3, "0")}`;
}

const LOG_ZOOM = `<script>(function(){var el=document.querySelector(".vol");if(!el)return;var from=Number(el.getAttribute("data-from")),to=Number(el.getAttribute("data-to")),x0=-1;el.addEventListener("pointerdown",function(e){x0=e.clientX;el.setPointerCapture(e.pointerId)});el.addEventListener("pointerup",function(e){if(x0<0)return;var box=el.getBoundingClientRect(),a=(Math.min(x0,e.clientX)-box.left)/box.width,b=(Math.max(x0,e.clientX)-box.left)/box.width;x0=-1;if(!(b-a>0.02)||!box.width)return;var span=to-from,u=new URL(location.href);u.searchParams.set("from",String(Math.round(from+Math.max(0,a)*span)));u.searchParams.set("to",String(Math.round(from+Math.min(1,b)*span)));u.searchParams.delete("live");location.assign(u.pathname+u.search)});el.addEventListener("dblclick",function(){var u=new URL(location.href);u.searchParams.delete("from");u.searchParams.delete("to");location.assign(u.pathname+u.search)})})();</script>`;

export function logsPage(c: PageCtx, result?: LogSearch): string {
  const L = (k: Key, v?: Record<string, string | number>) => esc(t(c.lang, k, v));
  const q = c.query;
  const b = c.config.basePath;
  const names = c.db.prepare(
    `SELECT name FROM (
       SELECT container_name AS name FROM log_volume
       UNION
       SELECT name FROM containers WHERE state='running'
     ) WHERE name!='' ORDER BY name COLLATE NOCASE LIMIT 2000`,
  ).all() as { name: string }[];
  const selected = q.get("container") ?? "";
  const live = q.get("live") === "1";
  const qVal = q.get("q") ?? "";
  const fromQ = q.get("from") ?? "";
  const toQ = q.get("to") ?? "";
  const hidden = `${qVal ? `<input type="hidden" name="q" value="${esc(qVal)}">` : ""}${fromQ ? `<input type="hidden" name="from" value="${esc(fromQ)}">` : ""}${toQ ? `<input type="hidden" name="to" value="${esc(toQ)}">` : ""}${live ? `<input type="hidden" name="live" value="1">` : ""}`;
  const keep = new URLSearchParams();
  if (qVal) keep.set("q", qVal);
  if (selected) keep.set("container", selected);
  if (fromQ) keep.set("from", fromQ);
  if (toQ) keep.set("to", toQ);
  const liveHref = new URLSearchParams(keep);
  if (live) liveHref.delete("live");
  else liveHref.set("live", "1");
  const rows = result?.rows ?? [];
  const total = result ? (result.total ?? rows.length) : 0;
  const bars = result ? (result.bars ?? logBars(rows, result.from, result.to, 48)) : [];
  const maxN = Math.max(1, ...bars.map((x) => x.reduce((s, n) => s + n, 0)));
  const grouped = total.toLocaleString(c.lang === "fr" ? "fr-BE" : "en-US");
  const endLabel = result && c.now - result.to < 120_000 ? L("rangeNow") : result ? esc(axisClock(result.to, c)) : "";
  const hist = result
    ? `<div class="volcard"><div class="volhead"><span class="voltitle"><b>${L("volume")}</b> ${esc(grouped)} ${L("eventsWord")}</span><span class="zoomhint">${L("dragToZoom")}</span><span class="legend"><span><b style="background:#94a3b8"></b>debug</span><span><b style="background:#16a34a"></b>info</span><span><b style="background:#86efac"></b>log</span><span><b style="background:#d97706"></b>warn</span><span><b style="background:#dc2626"></b>error</span></span></div>
<div class="vol" data-from="${result.from}" data-to="${result.to}">${bars
        .map((counts) => {
          const n = counts.reduce((s, x) => s + x, 0);
          const h = Math.max(2, Math.round((n / maxN) * 72));
          const parts = counts
            .map((x, i) => (x ? `<b class="${["debug", "info", "log", "warn", "err"][i]}" style="flex:${x}"></b>` : ""))
            .join("");
          return `<i style="height:${h}px">${parts}</i>`;
        })
        .join("")}</div>
<div class="volaxis"><span>${esc(axisClock(result.from, c))}</span><span>${endLabel}</span></div></div>`
    : "";
  const note =
    result?.note?.kind === "missing"
      ? `<p class="muted">${L("noSuchContainer", { name: result.note.name ?? "" })}</p>`
      : "";
  const dash = "—";
  const table = result
    ? `<div class="loaded"><b>${L("eventsLoaded", { n: rows.length })}</b><span class="muted">${L("loadedIn", { ms: result.ms })}</span></div>
       ${rows.length ? "" : `<p class="muted">${L("noLogMatch")}</p>`}
       <table class="logtbl"><tr><th></th><th>${L("when")}</th><th>${L("container")}</th><th>${L("level")}</th><th>${L("method")}</th><th>${L("message")}</th><th>${L("status")}</th><th>${L("duration")}</th></tr>${rows
         .map((r) => {
           const acc = parseAccess(r.message);
           const href = new URLSearchParams(keep);
           href.set("container", r.container);
           return `<tr><td class="ch">${ico("chevronRight")}</td><td class="mono">${r.ts ? esc(rowClock(r.ts, c)) : dash}</td><td class="mono"><a class="link" href="${b}/logs?${href}">${esc(r.container)}</a></td><td><span class="lvdot ${lvClass(r.level)}">${esc(r.level || "log")}</span></td><td class="mono">${esc(acc.method || dash)}</td><td>${esc((acc.text || r.message).slice(0, 400))}</td><td class="mono">${esc(acc.status || dash)}</td><td class="mono">${esc(acc.duration || dash)}</td></tr>`;
         })
         .join("")}</table>${LOG_ZOOM}`
    : "";
  return layout(
    c,
    "/logs",
    t(c.lang, "logs"),
    `<div class="pagehead"><div><h1>${ico("terminal")} ${L("logs")}</h1><p class="muted">${L("logsIntro")}</p></div>
<form method="get" action="${b}/logs" class="logtools">${ico("boxes")}
<select name="container" onchange="this.form.submit()"><option value="">${L("allContainers")}</option>${names.map((n) => `<option value="${esc(n.name)}" ${n.name === selected ? "selected" : ""}>${esc(n.name)}</option>`).join("")}</select>
${hidden}
<a class="pill ${live ? "on" : ""}" href="${b}/logs?${liveHref}">${ico("play")}${L("live")}</a>
</form></div>
<form class="logbar" method="get" action="${b}/logs">${ico("search")}<span class="logsql">${L("logsql")}</span>
<input type="hidden" name="container" value="${esc(selected)}">
${fromQ ? `<input type="hidden" name="from" value="${esc(fromQ)}">` : ""}
${toQ ? `<input type="hidden" name="to" value="${esc(toQ)}">` : ""}
${live ? `<input type="hidden" name="live" value="1">` : ""}
<input name="q" placeholder="level:error AND container_name:nginx" value="${esc(qVal)}"></form>
${hist}
${note}
${table}
${total === 0 ? `<p class="muted">${L("logHint")}</p>` : ""}`,
  );
}

export function instancesPage(c: PageCtx, versions: Map<string, string>): string {
  const L = (k: Key, v?: Record<string, string | number>) => esc(t(c.lang, k, v));
  const b = c.config.basePath;
  const items = c.config.instances
    .map((i) => {
      const hosts = c.db.prepare("SELECT id, name FROM hosts WHERE instance_id=?").all(i.id) as { id: string; name: string }[];
      const hostRows = hosts
        .map((h) => {
          const n = aliveCount(c.db, i.id, h.id, c.now);
          const hi = hostInfo(c.db, i.id, h.id);
          const role = hostRole(hi.type);
          const ver = role === "agent" ? verLabel(hi.agentVersion) : verLabel(versions.get(i.id));
          return `<div class="hostrow">${ico("server")} <span class="nm">${esc(hi.name || h.name || h.id)}</span>
            <span class="tag">${esc(role === "server" ? t(c.lang, "serverRole") : t(c.lang, "agent"))}</span>
            <span class="muted">${n} ${L("containers")} · ${esc(ver)}</span></div>`;
        })
        .join("");
      const conts = hosts.reduce((s, h) => s + aliveCount(c.db, i.id, h.id, c.now), 0);
      const online = versions.has(i.id);
      return `<div class="card">
        <div class="kv"><span>${ico("server")} <b>${esc(i.name)}</b> <span class="chip ${online ? "ok" : "err"}">${online ? L("online") : L("offline")}</span></span>
          <span><a class="link" href="${b}/metrics">${ico("chart")} ${L("metrics")}</a> · <a class="link" href="${esc(i.url)}" rel="noreferrer">${L("open")} ${ico("external")}</a></span></div>
        <div class="muted">${hosts.length} ${L("hosts")} · ${conts} ${L("containers")}</div>
        ${hostRows}
        <div class="muted" style="margin-top:10px">${ico("clock")} ${L("dailyReportLine")}</div></div>`;
    })
    .join("");
  return layout(
    c,
    "/instances",
    t(c.lang, "instances"),
    `<h1>${ico("server")} ${L("instances")}</h1><p class="muted">${L("instancesConnected", { n: c.config.instances.length })}</p>${items}`,
  );
}

export function askPage(c: PageCtx, extra: { ask?: string; notice?: string } = {}): string {
  const L = (k: Key) => esc(t(c.lang, k));
  return layout(c, "", t(c.lang, "askAbout"), `<h1>${ico("sparkles")} ${L("askAbout")}</h1>${askBox(c, `${c.config.basePath}/ask`, extra.ask, extra.notice)}`);
}

export interface IntegrationsView {
  freshToken?: string;
  tokenError?: string;
  tokens?: { id: number; name: string; prefix: string; created: number; last_used: number | null; calls: number; revoked: number }[];
  calls?: { ts: number; token_name: string; tool: string; ms: number }[];
  muteUntil?: number;
  toolCount?: number;
}

export function integrationsPage(c: PageCtx, extra: IntegrationsView = {}): string {
  const L = (k: Key, v?: Record<string, string | number>) => esc(t(c.lang, k, v));
  const b = c.config.basePath;
  const tab = c.query.get("tab") ?? "notifications";
  const when = (ms: number) => new Date(ms).toLocaleString(c.lang === "fr" ? "fr-BE" : "en-US", { timeZone: c.config.timezone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const mailOn = Boolean(c.config.smtp && c.config.notifyEmail);
  const mailLabel = mailOn ? c.config.notifyEmail! : t(c.lang, "emailMissing");
  const muted = (extra.muteUntil ?? 0) > c.now;
  const muteBox = `<div class="mutebox"><h2>${ico("bell")} ${L("muteNotif")}</h2>
<p class="muted">${L("muteHint")}</p>
${muted
  ? `<p>${L("mutedUntil", { when: when(extra.muteUntil!) })}</p><form method="post" action="${b}/integrations"><input type="hidden" name="action" value="unmute"><button>${L("unmute")}</button></form>`
  : `<form method="post" action="${b}/integrations"><input type="hidden" name="action" value="mute_for"><div class="pills">
<button name="for" value="1h">${L("mute1h")}</button><button name="for" value="8h">${L("mute8h")}</button><button name="for" value="tomorrow">${L("muteTomorrow")}</button><button name="for" value="week">${L("muteWeek")}</button>
</div></form>`}</div>`;
  const channel = c.config.notifyChannel || "general";
  const chatCard = (name: string) => `<div class="card"><div class="kv"><span>${ico("message")} <b>${esc(name)}</b><div class="muted">${L("chatConnected")}</div></span><span class="chip ok">ON</span></div></div>`;
  const url = c.config.mcpAdvertiseUrl;
  const tokens = (extra.tokens ?? []).filter((tk) => !tk.revoked);
  const mcpBody = `<h2>${L("mcpServer")}</h2>
<div class="card"><pre>${url ? esc(url) : L("mcpMissing")}</pre>
${c.config.litellmMcpUrl ? `<p class="muted">LiteLLM · ${esc(c.config.litellmMcpUrl)}</p>` : ""}
<p class="muted">${L("litellmNote")}</p></div>
<h2>${L("createToken")}</h2>
<form method="post" action="${b}/integrations?tab=mcp" class="filters"><input name="name" placeholder="${L("tokenName")}" maxlength="40" required><input type="hidden" name="action" value="create_token"><button>${L("createToken")}</button></form>
${extra.tokenError ? `<p class="notice">${esc(extra.tokenError)}</p>` : ""}
${extra.freshToken ? `<div class="notice secret">${esc(extra.freshToken)}<div class="muted">${L("tokenOnce")}</div></div>` : ""}
<h2>${L("connectedApps")} ${tokens.length}</h2>
<table class="logtbl"><tr><th>${L("tokenName")}</th><th>${L("lastUsed")}</th><th>${L("created")}</th><th></th></tr>
${tokens.map((tk) => `<tr><td>${esc(tk.name)} <span class="muted">${esc(tk.prefix)}…</span><div class="muted">${tk.calls}</div></td><td>${tk.last_used ? esc(when(tk.last_used)) : "—"}</td><td>${esc(when(tk.created))}</td><td><form method="post" action="${b}/integrations?tab=mcp"><input type="hidden" name="action" value="revoke_token"><input type="hidden" name="id" value="${tk.id}"><button>${L("revoke")}</button></form></td></tr>`).join("") || `<tr><td colspan="4" class="muted">—</td></tr>`}
</table>
<h2>${L("callsRecent")}</h2>
<table class="logtbl"><tr><th>${L("when")}</th><th>${L("tokenName")}</th><th>tool</th><th>ms</th></tr>
${(extra.calls ?? []).map((call) => `<tr><td>${esc(when(call.ts))}</td><td>${esc(call.token_name)}</td><td class="mono">${esc(call.tool)}</td><td>${call.ms}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">${L("noCalls")}</td></tr>`}
</table>
<h2>${L("setupTitle")}</h2>
<ol><li>${L("setup1")}</li><li>${L("setup2")}</li><li>${L("setup3")}</li></ol>
<p class="muted">${L("availableTools", { n: extra.toolCount ?? 0 })}</p>`;
  const body =
    tab === "mcp"
      ? mcpBody
      : tab === "chat"
        ? c.config.hubConfigured
          ? `${chatCard("Discord")}${chatCard("Telegram")}${chatCard("Zulip")}<p class="muted">${L("chatVia", { channel })}</p>`
          : `<div class="card">${ico("message")} ${L("noChat")}<p class="muted">${L("chatIntro")}</p></div>`
        : `${muteBox}
<h2>${ico("mail")} ${L("notifChannels")}</h2>
<div class="card"><div class="kv"><span>${ico("mail")} <b>${esc(mailLabel)}</b><div class="muted">${L("emailNotif")}</div></span>
<span><span class="chip">${L("primary")}</span> ${mailOn ? `<span class="chip ok">ON</span>` : ""}</span></div>
<div class="muted" style="margin-top:8px">${L("dailyReportLine")}</div></div>`;
  return layout(
    c,
    "/integrations",
    t(c.lang, "integrations"),
    `<h1>${ico("puzzle")} ${L("integrations")}</h1><p class="muted">${L("integrationsIntro")}</p>
<div class="tabs"><a class="${tab === "notifications" ? "on" : ""}" href="${b}/integrations">${ico("bell")} ${L("notifications")}</a>
<a class="${tab === "chat" ? "on" : ""}" href="${b}/integrations?tab=chat">${ico("message")} ${L("chat")}</a>
<a class="${tab === "mcp" ? "on" : ""}" href="${b}/integrations?tab=mcp">${ico("plug")} ${L("mcp")}</a></div>
${body}`,
  );
}
