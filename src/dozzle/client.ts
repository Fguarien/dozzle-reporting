import type { InstanceConfig } from "../config.ts";

/** Container as reported by Dozzle in `containers-changed` / `container-updated`. */
export interface DzContainer {
  id: string;
  name: string;
  image: string;
  imageId?: string;
  command?: string;
  created?: string;
  startedAt?: string;
  finishedAt?: string;
  state: string;
  health?: string;
  host: string;
  labels?: Record<string, string>;
  memoryLimit?: number;
  cpuLimit?: number;
  [k: string]: unknown;
}

export interface DzStat {
  id: string;
  cpu: number;
  memory: number;
  memoryUsage: number;
  networkRxTotal?: number;
  networkTxTotal?: number;
  diskReadTotal?: number;
  diskWriteTotal?: number;
}

export interface DzEvent {
  name: string;
  host: string;
  actorId: string;
  time?: string;
  actorAttributes?: Record<string, string>;
  [k: string]: unknown;
}

export interface LogLine {
  ts: number;
  level: string;
  stream?: string;
  message: string;
}

export interface DzHost {
  id: string;
  name: string;
  nCPU?: number;
  memTotal?: number;
  dockerVersion?: string;
  agentVersion?: string;
  type?: string;
  endpoint?: string;
  available?: boolean;
  [k: string]: unknown;
}

export interface SseMessage {
  event: string;
  data: string;
}

export class DozzleError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Thin client over Dozzle's HTTP API (v11). Covers what the MCP tools and the collector need:
 * the SSE event stream, logs, inspect, actions, image checks and notification rules.
 */
export class DozzleClient {
  private cookie?: string;
  readonly instance: InstanceConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(instance: InstanceConfig, fetchImpl: typeof fetch = fetch) {
    this.instance = instance;
    this.fetchImpl = fetchImpl;
  }

  get id(): string {
    return this.instance.id;
  }

  private async headers(extra?: Record<string, string>): Promise<Record<string, string>> {
    const h: Record<string, string> = { ...(extra ?? {}) };
    const a = this.instance.auth;
    if (a.mode === "forward-proxy") {
      h[a.userHeader] = a.user;
      if (a.rolesHeader && a.roles) h[a.rolesHeader] = a.roles;
    } else if (a.mode === "simple") {
      if (!this.cookie) await this.login();
      if (this.cookie) h["Cookie"] = this.cookie;
    }
    return h;
  }

  private async login(): Promise<void> {
    const a = this.instance.auth;
    if (a.mode !== "simple") return;
    const body = new URLSearchParams({ username: a.username, password: a.password });
    const r = await this.fetchImpl(`${this.instance.url}/api/token`, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    const set = r.headers.get("set-cookie");
    const m = set?.match(/jwt=[^;]+/);
    if (!m) throw new DozzleError(r.status, "Dozzle login failed (no jwt cookie)");
    this.cookie = m[0];
  }

  async request(path: string, init: RequestInit & { query?: Record<string, string | string[] | undefined> } = {}): Promise<Response> {
    const url = new URL(this.instance.url + path);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, one);
    }
    const doIt = async () =>
      this.fetchImpl(url, { ...init, headers: await this.headers(init.headers as Record<string, string>) });
    let r = await doIt();
    if (r.status === 401 && this.instance.auth.mode === "simple") {
      this.cookie = undefined;
      r = await doIt();
    }
    return r;
  }

  async json<T>(path: string, init: Parameters<DozzleClient["request"]>[1] = {}): Promise<T> {
    const r = await this.request(path, { ...init, headers: { Accept: "application/json", ...((init.headers as Record<string, string>) ?? {}) } });
    if (!r.ok) throw new DozzleError(r.status, `${init.method ?? "GET"} ${path} → ${r.status} ${(await r.text()).slice(0, 300)}`);
    const t = await r.text();
    return (t ? JSON.parse(t) : undefined) as T;
  }

  async version(): Promise<string> {
    const r = await this.request("/api/version");
    return (await r.text()).replace(/<[^>]+>/g, "").trim();
  }

  /**
   * Hosts known to Dozzle. There is no JSON endpoint for them: the UI receives them in the
   * config object embedded in the index page, so we extract the `"hosts":[...]` array.
   */
  async hosts(): Promise<DzHost[]> {
    const r = await this.request("/");
    const html = await r.text();
    const at = html.indexOf('"hosts":[');
    if (at < 0) return [];
    const start = at + '"hosts":'.length;
    let depth = 0;
    let inStr = false;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") {
        depth--;
        if (depth === 0) return JSON.parse(html.slice(start, i + 1)) as DzHost[];
      }
    }
    return [];
  }

  /** Open the SSE stream and yield messages until the signal aborts or the stream ends. */
  async *events(signal?: AbortSignal): AsyncGenerator<SseMessage> {
    const r = await this.request("/api/events/stream", { signal, headers: { Accept: "text/event-stream" } });
    if (!r.ok || !r.body) throw new DozzleError(r.status, `event stream → ${r.status}`);
    yield* parseSse(r.body);
  }

  /** One-shot snapshot of all containers: first `containers-changed` message of the stream. */
  async containers(timeoutMs = 15_000): Promise<DzContainer[]> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      for await (const m of this.events(ac.signal)) {
        if (m.event === "containers-changed") return JSON.parse(m.data) as DzContainer[];
      }
    } catch (e) {
      if (!ac.signal.aborted) throw e;
    } finally {
      clearTimeout(t);
      ac.abort();
    }
    throw new DozzleError(504, "no containers-changed message from Dozzle");
  }

  /** Fetch logs of one or more containers as JSON lines (Dozzle `POST /api/containers/logs`). */
  async logs(opts: {
    containers: { host: string; id: string }[];
    from?: Date;
    to?: Date;
    levels?: string[];
    filter?: string;
    stdout?: boolean;
    stderr?: boolean;
    max?: number;
  }): Promise<Record<string, unknown>[]> {
    const form = new URLSearchParams();
    for (const c of opts.containers) form.append("container", `${c.host}/${c.id}`);
    form.set("format", "jsonl");
    if (opts.stdout !== false) form.set("stdout", "1");
    if (opts.stderr !== false) form.set("stderr", "1");
    if (opts.from) form.set("from", opts.from.toISOString());
    if (opts.to) form.set("to", opts.to.toISOString());
    for (const l of opts.levels ?? []) form.append("levels", l);
    if (opts.filter) form.set("filter", opts.filter);
    const r = await this.request("/api/containers/logs", {
      method: "POST",
      body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (!r.ok) throw new DozzleError(r.status, `logs → ${r.status} ${(await r.text()).slice(0, 300)}`);
    const out: Record<string, unknown>[] = [];
    const max = opts.max ?? 500;
    for (const line of (await r.text()).split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        out.push({ m: line });
      }
    }
    return out.length > max ? out.slice(out.length - max) : out;
  }

  private mcpSession?: string;

  /**
   * Call one tool of Dozzle's built-in MCP server (`/api/mcp`, DOZZLE_ENABLE_MCP=true).
   * It is the only local API that returns plain-text log lines with their detected level:
   * the jsonl export keeps structured (JSON) lines only.
   */
  async nativeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const post = async (body: unknown, session?: string) => {
      const h: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
      if (session) h["Mcp-Session-Id"] = session;
      const token = process.env["DOZZLE_MCP_TOKEN"];
      if (token) h["Authorization"] = `Bearer ${token}`;
      const r = await this.request("/api/mcp", { method: "POST", body: JSON.stringify(body), headers: h });
      const raw = await r.text();
      if (!r.ok) throw new DozzleError(r.status, `native MCP ${r.status} ${raw.slice(0, 200)}`);
      const msgs = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5)));
      return { sid: r.headers.get("mcp-session-id") ?? session, msg: msgs.length ? msgs[msgs.length - 1] : raw.trim() ? JSON.parse(raw) : undefined };
    };
    const init = async () => {
      const { sid } = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dozzle-reporting", version: "0.1.0" } } });
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
      this.mcpSession = sid ?? undefined;
    };
    if (!this.mcpSession) await init();
    let res;
    try {
      res = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, this.mcpSession);
    } catch (e) {
      if (!(e instanceof DozzleError) || ![400, 404].includes(e.status)) throw e;
      await init();
      res = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, this.mcpSession);
    }
    const m = res.msg as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message: string } };
    if (m?.error) throw new DozzleError(500, m.error.message);
    const text = m?.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
    if (m?.result?.isError) throw new DozzleError(500, text);
    return text;
  }

  /** Log lines of one container with level, via the native MCP. Optional query = search. */
  async containerLines(o: { host: string; id: string; from?: Date; to?: Date; query?: string; levels?: string[]; limit?: number }): Promise<LogLine[]> {
    const args: Record<string, unknown> = { host: o.host, container_id: o.id, limit: o.limit ?? 200 };
    if (o.from) args["start"] = o.from.toISOString();
    if (o.to) args["end"] = o.to.toISOString();
    if (o.levels?.length === 1) args["level"] = o.levels[0];
    let text: string;
    if (o.query) text = await this.nativeTool("search_container_logs", { ...args, query: o.query });
    else text = await this.nativeTool("get_container_logs", args);
    const out: LogLine[] = [];
    for (const l of text.split("\n")) {
      if (!l.trimStart().startsWith("{")) continue;
      try {
        const j = JSON.parse(l) as { timestamp?: string; level?: string; stream?: string; message?: unknown };
        if (o.levels?.length && !o.levels.includes(String(j.level))) continue;
        out.push({ ts: j.timestamp ? Date.parse(j.timestamp) : NaN, level: j.level ?? "unknown", stream: j.stream, message: typeof j.message === "string" ? j.message : JSON.stringify(j.message) });
      } catch {
        /* skip */
      }
    }
    return out;
  }

  inspect(host: string, id: string): Promise<Record<string, unknown>> {
    return this.json(`/api/hosts/${encodeURIComponent(host)}/containers/${encodeURIComponent(id)}/inspect`);
  }

  async action(host: string, id: string, action: "start" | "stop" | "restart" | "remove"): Promise<void> {
    const r = await this.request(`/api/hosts/${encodeURIComponent(host)}/containers/${encodeURIComponent(id)}/actions/${action}`, { method: "POST" });
    if (!r.ok) throw new DozzleError(r.status, `${action} → ${r.status} ${(await r.text()).slice(0, 300)}`);
  }

  /** Pull + recreate. Dozzle streams progress; we return the raw text. */
  async update(host: string, id: string): Promise<string> {
    const r = await this.request(`/api/hosts/${encodeURIComponent(host)}/containers/${encodeURIComponent(id)}/actions/update`, { method: "POST" });
    const t = await r.text();
    if (!r.ok) throw new DozzleError(r.status, `update → ${r.status} ${t.slice(0, 300)}`);
    return t;
  }

  imageCheck(host?: string, id?: string, force = false): Promise<unknown> {
    const q = { force: force ? "true" : undefined };
    if (host && id) return this.json(`/api/hosts/${encodeURIComponent(host)}/containers/${encodeURIComponent(id)}/image/check`, { query: q });
    return this.json("/api/image/check", { query: q });
  }

  listRules(): Promise<NotificationRule[]> {
    return this.json("/api/notifications/rules");
  }

  createRule(rule: NotificationRuleInput): Promise<NotificationRule> {
    return this.json("/api/notifications/rules", { method: "POST", body: JSON.stringify(rule), headers: { "Content-Type": "application/json" } });
  }

  listDispatchers(): Promise<Dispatcher[]> {
    return this.json("/api/notifications/dispatchers");
  }

  createDispatcher(d: { name: string; type: "webhook"; url: string; template?: string; headers?: Record<string, string> }): Promise<Dispatcher> {
    return this.json("/api/notifications/dispatchers", { method: "POST", body: JSON.stringify(d), headers: { "Content-Type": "application/json" } });
  }
}

export interface NotificationRuleInput {
  name: string;
  enabled: boolean;
  dispatcherId: number;
  containerExpression: string;
  logExpression: string;
  metricExpression?: string;
  eventExpression?: string;
  cooldown?: number;
  sampleWindow?: number;
}

export interface NotificationRule extends Omit<NotificationRuleInput, "dispatcherId"> {
  id: number;
  triggerCount: number;
  triggeredContainers: number;
  lastTriggeredAt: string | null;
  dispatcher: Dispatcher | null;
}

export interface Dispatcher {
  id: number;
  name: string;
  type: string;
  url?: string;
}

/** Minimal SSE parser over a web ReadableStream. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const dec = new TextDecoder();
  let buf = "";
  let event = "message";
  let data: string[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") {
        if (data.length) yield { event, data: data.join("\n") };
        event = "message";
        data = [];
      } else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (data.length) yield { event, data: data.join("\n") };
}
