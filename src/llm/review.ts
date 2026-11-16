import type { Db } from "../store/db.ts";
import type { Config } from "../config.ts";
import type { DozzleClient } from "../dozzle/client.ts";
import type { AlertRow } from "../alerts.ts";
import { mapLimit } from "../mcp/tools.ts";

type Llm = NonNullable<Config["llm"]>;

/** One chat completion against an OpenAI-compatible endpoint (LiteLLM, Ollama, OpenAI…). */
export async function chat(llm: Llm, system: string, user: string, json = false): Promise<string> {
  const r = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}) },
    body: JSON.stringify({
      model: llm.model,
      temperature: 0.1,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(Number(process.env["LLM_TIMEOUT_MS"] ?? 300_000)),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { choices: { message: { content: string } }[] };
  return j.choices[0]?.message.content ?? "";
}

const LANG_NAME: Record<string, string> = { fr: "French", en: "English", de: "German", nl: "Dutch", es: "Spanish" };

/** Two-sentence summary + short title for a sent alert, in the configured language. */
export async function summarizeAlert(llm: Llm, a: AlertRow): Promise<{ title: string; summary: string }> {
  const out = await chat(
    llm,
    `You triage Docker container alerts for an operator. Answer in ${LANG_NAME[llm.language] ?? llm.language}. Return JSON {"title": string, "summary": string}. ` +
      `title: under 90 characters, "<container> <what happened> — <cause>". summary: 2 sentences, quote the exact error, say what to check. No speculation beyond the evidence.`,
    `Container: ${a.container_name}\nRule: ${a.source}\nKind: ${a.kind}\nEvidence:\n${(a.sample ?? "").slice(0, 3000)}`,
    true,
  );
  const j = JSON.parse(out) as { title?: string; summary?: string };
  return { title: j.title ?? a.title ?? "", summary: j.summary ?? "" };
}

interface RawFinding {
  key: string;
  severity: "low" | "medium" | "high" | "critical";
  containers: string[];
  headline: string;
  why: string;
  fix: string;
}

/**
 * Daily log review: read the last 24 h of warn/error/fatal lines of every running container,
 * ask the LLM which problems are worth fixing, and reconcile with stored findings:
 * still seen → ongoing, not seen → resolved, new → open.
 */
export async function reviewLogs(db: Db, cfg: Config, clients: Map<string, DozzleClient>, log: (m: string) => void, now = Date.now()): Promise<{ open: number; resolved: number }> {
  if (!cfg.llm) return { open: 0, resolved: 0 };
  const llm = cfg.llm;
  const running = db.prepare("SELECT instance_id, id, host, name FROM containers WHERE state='running' AND last_seen > ?").all(now - 3_600_000) as { instance_id: string; id: string; host: string; name: string }[];
  const evidence: string[] = [];
  await mapLimit(running, 8, async (c) => {
    const cl = clients.get(c.instance_id);
    if (!cl) return;
    try {
      const lines = await cl.containerLines({ host: c.host, id: c.id, from: new Date(now - 86_400_000), levels: ["warn", "error", "fatal"], limit: 300 });
      if (!lines.length) return;
      // Deduplicate by shape so one noisy loop does not crowd out everything else.
      const seen = new Map<string, { n: number; msg: string; level: string }>();
      for (const l of lines) {
        const k = l.message.replace(/\d+/g, "#").slice(0, 160);
        const e = seen.get(k);
        if (e) e.n++;
        else seen.set(k, { n: 1, msg: l.message.slice(0, 400), level: l.level });
      }
      const top = [...seen.values()].sort((a, b) => b.n - a.n).slice(0, 8);
      evidence.push(`## ${c.name}\n${top.map((t) => `- [${t.level} ×${t.n}] ${t.msg}`).join("\n")}`);
    } catch (e) {
      // Ephemeral containers vanish between the snapshot and the read: not worth a log line.
      if (!/not found/i.test((e as Error).message)) log(`review: ${c.name}: ${(e as Error).message}`);
    }
  });
  const known = db.prepare("SELECT fingerprint, headline FROM findings WHERE status IN ('open','ongoing')").all() as { fingerprint: string; headline: string }[];
  let found: RawFinding[] = [];
  // Chunk the evidence so a large fleet stays within the model's context.
  const chunks: string[] = [];
  let cur = "";
  for (const e of evidence) {
    if (cur.length + e.length > Number(process.env["LLM_CHUNK_CHARS"] ?? 12_000)) (chunks.push(cur), (cur = ""));
    cur += e + "\n\n";
  }
  if (cur) chunks.push(cur);
  let failedChunks = 0;
  for (const ch of chunks) {
    let out: string;
    try {
      out = await chat(
      llm,
      `You review 24 hours of Docker container warning/error logs and report only problems worth an operator's time. Answer in ${LANG_NAME[llm.language] ?? llm.language}. ` +
        `Return JSON {"findings":[{"key":string,"severity":"low"|"medium"|"high"|"critical","containers":[string],"headline":string,"why":string,"fix":string}]}. ` +
        `key: a stable kebab-case id for the underlying problem (reuse a known key when it is the same problem). ` +
        `Report a problem ONLY if the evidence shows it repeating (×2 or more) or a fatal/panic, AND it plausibly breaks or degrades the service (failed connections, auth failures, crashes, data errors, full disks). ` +
        `NEVER report: startup/configuration advisories (Redis vm.overcommit_memory, transparent huge pages, "no password set"), deprecation notices, single retries that recovered, debug chatter, or warnings a healthy service emits by design. ` +
        `When unsure, leave it out: an empty list is a good answer. Severity: critical = service down or data loss; high = a feature is broken for users; medium = degraded or failing in the background; low = worth a look. ` +
        `Write every headline, why and fix in the requested language, quoting the exact error text. ` +
        `Known open findings (reuse their key if still present): ${JSON.stringify(known.map((k) => ({ key: k.fingerprint, headline: k.headline })))}`,
      ch,
      true,
    );
    } catch (e) {
      // One slow or failed chunk must not lose the whole review.
      failedChunks++;
      log(`review: chunk failed: ${(e as Error).message}`);
      continue;
    }
    try {
      found = found.concat((JSON.parse(out) as { findings?: RawFinding[] }).findings ?? []);
    } catch {
      log("review: unparsable LLM answer, chunk skipped");
    }
  }
  const seenKeys = new Set<string>();
  const instanceId = [...clients.keys()][0] ?? "main";
  for (const f of found) {
    if (!f.key || !f.headline) continue;
    seenKeys.add(f.key);
    db.prepare(
      `INSERT INTO findings(created,updated,last_seen,instance_id,fingerprint,severity,status,containers,headline,why,fix)
       VALUES(?,?,?,?,?,?,'open',?,?,?,?)
       ON CONFLICT(fingerprint) DO UPDATE SET updated=excluded.updated,last_seen=excluded.last_seen,severity=excluded.severity,
         status=CASE WHEN findings.status='resolved' THEN 'open' ELSE 'ongoing' END, resolved_at=NULL,
         containers=excluded.containers,headline=excluded.headline,why=excluded.why,fix=excluded.fix`,
    ).run(now, now, now, instanceId, f.key, f.severity ?? "medium", JSON.stringify(f.containers ?? []), f.headline, f.why ?? null, f.fix ?? null);
  }
  let resolved = 0;
  // A failed chunk means some containers were not reviewed: their findings are not "gone".
  for (const k of failedChunks ? [] : known) {
    if (!seenKeys.has(k.fingerprint)) {
      db.prepare("UPDATE findings SET status='resolved', resolved_at=?, updated=? WHERE fingerprint=?").run(now, now, k.fingerprint);
      resolved++;
    }
  }
  log(`review: ${evidence.length} containers with warnings, ${chunks.length} chunks (${failedChunks} failed), ${found.length} findings, ${resolved} resolved`);
  return { open: found.length, resolved };
}
