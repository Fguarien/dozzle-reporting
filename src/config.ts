/**
 * Configuration from environment variables. Everything has a default except the Dozzle URL.
 *
 * DOZZLE_URL           base URL of one Dozzle instance (e.g. http://dozzle:8080)
 * DOZZLE_INSTANCES     JSON array for several instances, overrides DOZZLE_URL:
 *                      [{"id":"main","name":"Prod","url":"http://dozzle:8080","auth":{...}}]
 * DOZZLE_AUTH          none | forward-proxy | simple   (default none)
 * DOZZLE_PROXY_USER_HEADER / DOZZLE_PROXY_USER / DOZZLE_PROXY_ROLES_HEADER / DOZZLE_PROXY_ROLES
 * DOZZLE_USERNAME / DOZZLE_PASSWORD   for simple auth
 */
export type DozzleAuth =
  | { mode: "none" }
  | { mode: "forward-proxy"; userHeader: string; user: string; rolesHeader?: string; roles?: string }
  | { mode: "simple"; username: string; password: string };

export interface InstanceConfig {
  id: string;
  name: string;
  url: string;
  auth: DozzleAuth;
}

export interface Config {
  instances: InstanceConfig[];
  dbPath: string;
  port: number;
  basePath: string;
  publicUrl: string;
  mcpToken?: string;
  webhookSecret?: string;
  retentionDays: number;
  bucketSeconds: number;
  llm?: { baseUrl: string; apiKey?: string; model: string; language: string };
  reviewHour: number;
  timezone: string;
  allowActions: boolean;
}

function env(name: string, def?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}

function authFromEnv(): DozzleAuth {
  const mode = env("DOZZLE_AUTH", "none");
  if (mode === "forward-proxy") {
    return {
      mode,
      userHeader: env("DOZZLE_PROXY_USER_HEADER", "Remote-User")!,
      user: env("DOZZLE_PROXY_USER", "dozzle-reporting")!,
      rolesHeader: env("DOZZLE_PROXY_ROLES_HEADER"),
      roles: env("DOZZLE_PROXY_ROLES", "all"),
    };
  }
  if (mode === "simple") {
    return { mode, username: env("DOZZLE_USERNAME", "")!, password: env("DOZZLE_PASSWORD", "")! };
  }
  return { mode: "none" };
}

export function loadConfig(): Config {
  let instances: InstanceConfig[];
  const multi = env("DOZZLE_INSTANCES");
  if (multi) {
    instances = (JSON.parse(multi) as Partial<InstanceConfig>[]).map((i, n) => ({
      id: i.id ?? `instance-${n + 1}`,
      name: i.name ?? i.url ?? `instance-${n + 1}`,
      url: String(i.url).replace(/\/$/, ""),
      auth: i.auth ?? authFromEnv(),
    }));
  } else {
    const url = env("DOZZLE_URL");
    if (!url) throw new Error("DOZZLE_URL (or DOZZLE_INSTANCES) is required");
    instances = [
      { id: env("DOZZLE_INSTANCE_ID", "main")!, name: env("DOZZLE_INSTANCE_NAME", url)!, url: url.replace(/\/$/, ""), auth: authFromEnv() },
    ];
  }
  const llmUrl = env("LLM_BASE_URL");
  return {
    instances,
    dbPath: env("DB_PATH", "./dozzle-reporting.db")!,
    port: Number(env("PORT", "8095")),
    basePath: (env("BASE_PATH", "/reporting")!).replace(/\/$/, ""),
    publicUrl: (env("PUBLIC_URL", "http://localhost:8095")!).replace(/\/$/, ""),
    mcpToken: env("MCP_TOKEN"),
    webhookSecret: env("WEBHOOK_SECRET"),
    retentionDays: Number(env("RETENTION_DAYS", "30")),
    bucketSeconds: Number(env("BUCKET_SECONDS", "30")),
    llm: llmUrl
      ? { baseUrl: llmUrl.replace(/\/$/, ""), apiKey: env("LLM_API_KEY"), model: env("LLM_MODEL", "gpt-4o-mini")!, language: env("LLM_LANGUAGE", "en")! }
      : undefined,
    reviewHour: Number(env("REVIEW_HOUR", "21")),
    timezone: env("TZ", "UTC")!,
    allowActions: env("ALLOW_ACTIONS", "true") !== "false",
  };
}
