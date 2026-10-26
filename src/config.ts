/**
 * Runtime configuration, read once at startup from environment variables.
 *
 * Fail fast: if something required is missing or malformed we throw here so the
 * process never starts in a half-configured state.
 */

export interface Config {
  /** BrokerBin bearer token used to authenticate against their REST API. */
  brokerbinApiKey: string;
  /** Base URL for the BrokerBin API (no trailing slash). */
  brokerbinBaseUrl: string;
  /**
   * Optional default `login` username forwarded to BrokerBin when a tool call
   * doesn't specify one. BrokerBin falls back to the company "primary" user
   * when absent.
   */
  defaultLogin?: string;

  /** Which MCP transport to serve: "http" (Render / remote) or "stdio" (local). */
  transport: "http" | "stdio";
  /** Port for the HTTP transport. Render injects PORT automatically. */
  port: number;
  /** Bind host for the HTTP transport. */
  host: string;
  /**
   * Optional shared secret. When set, HTTP MCP requests must present it as
   * `Authorization: Bearer <token>`. This protects your public Render URL (and
   * therefore your BrokerBin key) from anonymous use.
   */
  mcpAuthToken?: string;

  /** Per-request timeout against BrokerBin, in milliseconds. */
  requestTimeoutMs: number;
  /** Max retry attempts for transient failures (429 / 5xx / network). */
  maxRetries: number;
  /** Log verbosity. */
  logLevel: "debug" | "info" | "warn" | "error";
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Set it before starting the server (for Render, add it as an environment variable in the dashboard).`,
    );
  }
  return value.trim();
}

function intEnv(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    throw new Error(`Environment variable ${name} must be an integer in [${min}, ${max}], got "${raw}".`);
  }
  return parsed;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const transportRaw = (env.MCP_TRANSPORT ?? "http").toLowerCase();
  if (transportRaw !== "http" && transportRaw !== "stdio") {
    throw new Error(`MCP_TRANSPORT must be "http" or "stdio", got "${transportRaw}".`);
  }

  const logLevelRaw = (env.LOG_LEVEL ?? "info").toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(logLevelRaw)) {
    throw new Error(`LOG_LEVEL must be one of debug|info|warn|error, got "${logLevelRaw}".`);
  }

  return {
    brokerbinApiKey: requireEnv("BROKERBIN_API_KEY"),
    brokerbinBaseUrl: stripTrailingSlash(env.BROKERBIN_BASE_URL?.trim() || "https://search.brokerbin.com/api/v2"),
    defaultLogin: env.BROKERBIN_DEFAULT_LOGIN?.trim() || undefined,

    transport: transportRaw,
    port: intEnv("PORT", 3000, 1, 65535),
    host: env.HOST?.trim() || "0.0.0.0",
    mcpAuthToken: env.MCP_AUTH_TOKEN?.trim() || undefined,

    requestTimeoutMs: intEnv("BROKERBIN_TIMEOUT_MS", 30_000, 1_000, 300_000),
    maxRetries: intEnv("BROKERBIN_MAX_RETRIES", 3, 0, 10),
    logLevel: logLevelRaw as Config["logLevel"],
  };
}
