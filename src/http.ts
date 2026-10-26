/**
 * HTTP transport for Render (and any remote host).
 *
 * Implements the MCP Streamable HTTP transport in stateless mode: every POST to
 * /mcp spins up a throwaway server + transport, handles the single JSON-RPC
 * message, and tears down. This keeps the service horizontally scalable with no
 * shared session state — ideal for Render's autoscaling web services.
 *
 * Also serves:
 *   GET /health  -> liveness/readiness probe
 *   GET /        -> tiny human-readable landing blurb
 */

import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { logger } from "./logger.js";
import type { Config } from "./config.js";

const JSONRPC_UNAUTHORIZED = -32001;

function unauthorized(res: Response, id: unknown = null): void {
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: JSONRPC_UNAUTHORIZED, message: "Unauthorized: missing or invalid bearer token." },
    id,
  });
}

/** Constant-time-ish comparison to avoid trivial timing leaks on the shared secret. */
function tokenMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * Pull the caller-supplied token from (in priority order):
 *   1. Authorization: Bearer <token>   — for the OpenAI Responses API / CLI clients
 *   2. ?token= / ?key= query parameter
 *   3. the URL path segment, e.g. POST /mcp/<token>  — lets clients that only
 *      support "no authentication" (like the ChatGPT connector UI) still carry
 *      the secret in the URL.
 */
function extractToken(req: Request): string | null {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) return match[1].trim();

  const q = req.query.token ?? req.query.key;
  if (typeof q === "string" && q.length > 0) return q;

  const pathSecret = (req.params as { secret?: string }).secret;
  if (typeof pathSecret === "string" && pathSecret.length > 0) return pathSecret;

  return null;
}

function isAuthorized(req: Request, config: Config): boolean {
  if (!config.mcpAuthToken) return true; // auth disabled
  const provided = extractToken(req);
  if (!provided) return false;
  return tokenMatches(provided, config.mcpAuthToken);
}

export function createHttpApp(config: Config) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Assign a request id for log correlation.
  app.use((req, _res, next) => {
    (req as Request & { id: string }).id = randomUUID();
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
  });

  app.get("/", (_req, res) => {
    res
      .type("text/plain")
      .send(`${SERVER_NAME} MCP server v${SERVER_VERSION}\nMCP endpoint: POST /mcp\nHealth: GET /health\n`);
  });

  // Main MCP endpoint (stateless streamable HTTP).
  // Mounted at both /mcp (token via header or ?token=) and /mcp/:secret
  // (token embedded in the URL path, for "no auth" clients like ChatGPT).
  const mcpHandler = async (req: Request, res: Response) => {
    const reqId = (req as Request & { id: string }).id;

    if (!isAuthorized(req, config)) {
      logger.warn("mcp unauthorized", { reqId });
      unauthorized(res, (req.body as { id?: unknown })?.id ?? null);
      return;
    }

    const server = createMcpServer(config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error("mcp request failed", { reqId, error: (err as Error).message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error." },
          id: (req.body as { id?: unknown })?.id ?? null,
        });
      }
    }
  };
  app.post("/mcp", mcpHandler);
  app.post("/mcp/:secret", mcpHandler);

  // Stateless transport doesn't support server-initiated streams over GET/DELETE.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. This stateless server only accepts POST /mcp." },
      id: null,
    });
  };
  app.get(["/mcp", "/mcp/:secret"], methodNotAllowed);
  app.delete(["/mcp", "/mcp/:secret"], methodNotAllowed);

  return app;
}

export function startHttpServer(config: Config): void {
  const app = createHttpApp(config);
  const httpServer = app.listen(config.port, config.host, () => {
    logger.info("brokerbin mcp http server listening", {
      host: config.host,
      port: config.port,
      authProtected: Boolean(config.mcpAuthToken),
    });
  });

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    httpServer.close(() => process.exit(0));
    // Force-exit if connections linger.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
