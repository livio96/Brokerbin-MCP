/**
 * Builds a fully-configured McpServer instance with all BrokerBin tools
 * registered. A fresh instance is created per HTTP request in stateless mode.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrokerBinClient } from "./brokerbin-client.js";
import { registerTools } from "./tools.js";
import type { Config } from "./config.js";

export const SERVER_NAME = "Brokerbin";
export const SERVER_VERSION = "1.0.0";

export function createMcpServer(config: Config): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for the BrokerBin.com marketplace: search current part listings (keyword or prefix), " +
        "pull historical analytics on a part (quote requests, price/quantity stats, supply & demand, " +
        "search matches), list a manufacturer's top searched parts, and send/read/reply to member messages.",
    },
  );

  const client = new BrokerBinClient(config);
  registerTools(server, client);
  return server;
}
