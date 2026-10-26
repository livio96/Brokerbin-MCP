#!/usr/bin/env node
/**
 * Entry point. Loads config, selects a transport, and starts the server.
 *
 *   MCP_TRANSPORT=http  (default) -> remote HTTP server for Render
 *   MCP_TRANSPORT=stdio           -> local stdio server for Claude Desktop/Code
 */

import { loadConfig } from "./config.js";
import { setLogLevel, logger } from "./logger.js";
import { startHttpServer } from "./http.js";
import { startStdioServer } from "./stdio.js";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  if (config.transport === "stdio") {
    await startStdioServer(config);
  } else {
    startHttpServer(config);
  }
}

main().catch((err) => {
  logger.error("fatal startup error", { error: (err as Error).message });
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
