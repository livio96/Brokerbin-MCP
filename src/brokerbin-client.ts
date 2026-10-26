/**
 * Thin, robust HTTP client for the BrokerBin REST API.
 *
 * Responsibilities:
 *  - attach bearer auth and the optional `login` header
 *  - serialize query parameters the way BrokerBin expects (repeated `key[]`
 *    entries for arrays, `sort[field]=dir` for the sort object)
 *  - enforce a per-request timeout
 *  - retry transient failures (429 / 5xx / network) with exponential backoff
 *    and jitter, honouring `Retry-After`
 *  - turn every failure into a typed BrokerBinApiError with a useful message
 */

import { logger } from "./logger.js";
import type { Config } from "./config.js";

export class BrokerBinApiError extends Error {
  readonly status?: number;
  readonly body?: unknown;
  readonly retriable: boolean;

  constructor(message: string, opts: { status?: number; body?: unknown; retriable?: boolean } = {}) {
    super(message);
    this.name = "BrokerBinApiError";
    this.status = opts.status;
    this.body = opts.body;
    this.retriable = opts.retriable ?? false;
  }
}

/** A query value can be a scalar, an array of scalars, or a flat object (for `sort`). */
export type QueryValue = string | number | boolean | Array<string | number | boolean> | Record<string, string | number | boolean> | undefined | null;

export interface RequestOptions {
  method: "GET" | "POST" | "PUT";
  path: string; // e.g. "/part/search" — must start with "/"
  query?: Record<string, QueryValue>;
  body?: unknown; // JSON-serializable
  /** Overrides the default login for this call; forwarded as the `login` header. */
  login?: string;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class BrokerBinClient {
  constructor(private readonly config: Config) {}

  /** Build a fully-qualified URL with BrokerBin-style query serialization. */
  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(this.config.brokerbinBaseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          // BrokerBin expects repeated params with a trailing "[]".
          const arrayKey = key.endsWith("[]") ? key : `${key}[]`;
          for (const item of value) url.searchParams.append(arrayKey, String(item));
        } else if (typeof value === "object") {
          // Flat object, e.g. sort => sort[price]=asc
          for (const [subKey, subValue] of Object.entries(value)) {
            if (subValue === undefined || subValue === null) continue;
            url.searchParams.append(`${key}[${subKey}]`, String(subValue));
          }
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private computeBackoff(attempt: number, retryAfterHeader: string | null): number {
    // Honour an explicit Retry-After (seconds or HTTP-date) when present.
    if (retryAfterHeader) {
      const asSeconds = Number(retryAfterHeader);
      if (!Number.isNaN(asSeconds)) return Math.min(asSeconds * 1000, 60_000);
      const asDate = Date.parse(retryAfterHeader);
      if (!Number.isNaN(asDate)) return Math.max(0, Math.min(asDate - Date.now(), 60_000));
    }
    // Exponential backoff with full jitter: base 500ms, capped at 10s.
    const base = Math.min(500 * 2 ** attempt, 10_000);
    return Math.floor(Math.random() * base);
  }

  async request<T = unknown>(opts: RequestOptions): Promise<T> {
    const url = this.buildUrl(opts.path, opts.query);
    const login = opts.login ?? this.config.defaultLogin;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.brokerbinApiKey}`,
      Accept: "application/json",
      "User-Agent": "brokerbin-mcp-server/1.0",
    };
    if (login) headers.login = login;

    let payload: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(opts.body);
    }

    let lastError: BrokerBinApiError | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      // Per-attempt timeout, composed with any caller-provided abort signal.
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), this.config.requestTimeoutMs);
      const signal = opts.signal
        ? anySignal([opts.signal, timeoutController.signal])
        : timeoutController.signal;

      try {
        logger.debug("brokerbin request", { method: opts.method, url, attempt });
        const res = await fetch(url, { method: opts.method, headers, body: payload, signal });

        const text = await res.text();
        const parsed = parseMaybeJson(text);

        if (res.ok) {
          return parsed as T;
        }

        const retriable = res.status === 429 || (res.status >= 500 && res.status <= 599);
        const message = extractErrorMessage(parsed, text) ?? res.statusText;
        lastError = new BrokerBinApiError(`BrokerBin API ${res.status}: ${message}`, {
          status: res.status,
          body: parsed,
          retriable,
        });

        if (!retriable || attempt === this.config.maxRetries) throw lastError;

        const delay = this.computeBackoff(attempt, res.headers.get("retry-after"));
        logger.warn("brokerbin retry", { status: res.status, attempt, delayMs: delay });
        await sleep(delay);
        continue;
      } catch (err) {
        if (err instanceof BrokerBinApiError) throw err;

        // Network-level failure (DNS, reset, timeout abort). Treat as retriable.
        const aborted = (err as Error)?.name === "AbortError";
        const reason = aborted ? `request timed out after ${this.config.requestTimeoutMs}ms` : (err as Error).message;
        lastError = new BrokerBinApiError(`BrokerBin request failed: ${reason}`, { retriable: true });

        if (attempt === this.config.maxRetries) throw lastError;
        const delay = this.computeBackoff(attempt, null);
        logger.warn("brokerbin retry (network)", { attempt, delayMs: delay, reason });
        await sleep(delay);
      } finally {
        clearTimeout(timer);
      }
    }

    // Unreachable in practice, but keeps the type checker happy.
    throw lastError ?? new BrokerBinApiError("BrokerBin request failed for an unknown reason.");
  }
}

/** Combine multiple AbortSignals into one (Node 20 lacks AbortSignal.any in older minors). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as unknown as { any?: unknown }).any === "function") {
    return (AbortSignal as unknown as { any(s: AbortSignal[]): AbortSignal }).any(signals);
  }
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function parseMaybeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractErrorMessage(parsed: unknown, raw: string): string | undefined {
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    if (obj.errors) return JSON.stringify(obj.errors);
  }
  return raw ? raw.slice(0, 500) : undefined;
}
