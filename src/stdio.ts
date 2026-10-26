/**
 * Local stdio transport — lets you run this server directly inside Claude
 * Desktop / Claude Code without hosting it. Uses stdout for the protocol, so
 * all logging goes to stderr (see logger.ts).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { logger } from "./logger.js";
import type { Config } from "./config.js";

export async function startStdioServer(config: Config): Promise<void> {
  const server = createMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("brokerbin mcp stdio server ready");

  const shutdown = async () => {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
