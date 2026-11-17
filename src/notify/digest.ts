import type { Db } from "../store/db.ts";

/** Text of the daily report, or undefined when the last day has nothing to say. */
export function digestText(db: Db, lang: "fr" | "en", now = Date.now()): { subject: string; text: string } | undefined {
  const since = now - 86_400_000;
  const alerts = db.prepare("SELECT title, container_name FROM alerts WHERE ts>=? AND status='sent' ORDER BY ts DESC LIMIT 20").all(since) as { title: string; container_name: string | null }[];
  const findings = db.prepare("SELECT headline, severity FROM findings WHERE status IN ('open','ongoing') AND ignored=0 ORDER BY updated DESC LIMIT 12").all() as { headline: string; severity: string }[];
  if (!alerts.length && !findings.length) return undefined;
  const fr = lang === "fr";
  const lines = [
    fr ? "Rapport quotidien Dozzle" : "Dozzle daily report",
    "",
  ];
  if (alerts.length) {
    lines.push(fr ? `Alertes envoyées (24 h) : ${alerts.length}` : `Alerts sent (24 h): ${alerts.length}`);
    for (const a of alerts) lines.push(`- ${a.container_name ?? "?"} : ${a.title ?? ""}`);
    lines.push("");
  }
  if (findings.length) {
    lines.push(fr ? "Constats encore ouverts :" : "Findings still open:");
    for (const f of findings) lines.push(`- [${f.severity}] ${f.headline}`);
  }
  return { subject: fr ? "Dozzle — rapport quotidien" : "Dozzle — daily report", text: lines.join("\n") };
}
