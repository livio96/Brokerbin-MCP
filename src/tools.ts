/**
 * MCP tool definitions. Each BrokerBin endpoint is exposed as one tool with a
 * zod-validated input schema. Handlers delegate to the BrokerBinClient and
 * return the API payload as pretty-printed JSON text content.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BrokerBinApiError, type BrokerBinClient, type QueryValue } from "./brokerbin-client.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Shared enums / fragments (mirrors the BrokerBin OpenAPI spec v2.1.2)
// ---------------------------------------------------------------------------

const CONDITIONS = ["NEW", "ASIS", "EXC", "F/S", "NOB", "REF", "REP", "USED", "OEMREF"] as const;
const REGIONS = ["North America", "South America", "Africa", "Middle East", "Europe", "Oceania", "Asia"] as const;
const SEARCH_FIELDS = ["partsno", "clei", "manufacturer", "description", "condition", "company", "country", "state", "city"] as const;

const conditionSchema = z.enum(CONDITIONS);
const regionSchema = z.enum(REGIONS);

const loginField = {
  login: z
    .string()
    .min(1)
    .optional()
    .describe('Optional BrokerBin username to act as. Defaults to the company "primary" user when omitted.'),
};

/** A part line item used in messages / quote requests. */
const partItemSchema = z
  .object({
    part_number: z.string().min(1).describe("Manufacturer part number."),
    manufacturer: z.string().min(1).describe("Manufacturer / brand name."),
    condition: conditionSchema.describe("Part condition code."),
    quantity: z.number().int().positive().describe("Quantity."),
    clei: z.string().nullable().optional().describe("Optional CLEI code."),
    price: z.number().nonnegative().optional().describe("Optional unit price."),
    terms: z.string().nullable().optional().describe("Optional terms text."),
  })
  .describe("A single part line item.");

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown): CallToolResult {
  let message: string;
  const meta: Record<string, unknown> = {};
  if (err instanceof BrokerBinApiError) {
    message = err.message;
    if (err.status !== undefined) meta.status = err.status;
    if (err.body !== undefined) meta.details = err.body;
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  logger.error("tool error", { message, ...meta });
  const text =
    Object.keys(meta).length > 0 ? `${message}\n\n${JSON.stringify(meta, null, 2)}` : message;
  return { content: [{ type: "text", text }], isError: true };
}

/** Wrap a handler so thrown errors become MCP tool errors instead of crashing. */
function safe(handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
  return handler().catch(errorResult);
}

/** Drop undefined entries so we don't emit empty query params. */
function cleanQuery(query: Record<string, QueryValue>): Record<string, QueryValue> {
  const out: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, client: BrokerBinClient): void {
  // --- Part Search -------------------------------------------------------

  server.registerTool(
    "search_parts",
    {
      title: "Keyword Part Search",
      description:
        "Search parts currently listed on BrokerBin by keyword. Returns listings with company, condition, quantity, price, location, etc. Use this for general part lookups.",
      inputSchema: {
        query: z.string().min(1).describe('Search string, e.g. a part number or keyword. Required unless "prefix" is given.'),
        prefix: z.string().optional().describe("Alternative: match the beginning of a part number instead of a full keyword search."),
        fields: z.array(z.enum(SEARCH_FIELDS)).optional().describe("Restrict which fields the query matches against."),
        mfg: z.array(z.string()).optional().describe("Filter by one or more manufacturers."),
        cond: z.array(conditionSchema).optional().describe("Filter by one or more condition codes."),
        state: z.array(z.string()).optional().describe("Filter by seller state(s)."),
        country: z.array(z.string()).optional().describe("Filter by seller country/countries."),
        region: z.array(regionSchema).optional().describe("Filter by seller region(s)."),
        age: z.number().int().optional().describe("Max listing age in days."),
        size: z.number().int().positive().optional().describe("Page size (priced parts only)."),
        offset: z.number().int().nonnegative().optional().describe("Result offset for pagination."),
        fuzziness: z.number().int().min(0).optional().describe("Fuzzy-match tolerance (0 = exact)."),
        first: z.boolean().optional().describe('Boost "show first" companies.'),
        last: z.boolean().optional().describe('Deboost "show last" companies.'),
        never: z.boolean().optional().describe('Remove "show never" companies.'),
        priced: z.boolean().optional().describe("Only return parts that have a price."),
        sort: z.record(z.string(), z.enum(["asc", "desc"])).optional().describe('Sort map, e.g. {"price":"asc"}.'),
        ...loginField,
      },
    },
    async (args) =>
      safe(async () => {
        const { login, ...q } = args;
        const data = await client.request({ method: "GET", path: "/part/search", query: cleanQuery(q), login });
        return jsonResult(data);
      }),
  );

  // --- Prefix Part Search ------------------------------------------------

  server.registerTool(
    "search_parts_prefix",
    {
      title: "Prefix Part Search",
      description:
        "Search parts currently listed on BrokerBin by the beginning of the part number. Useful for autocomplete-style or partial-number lookups.",
      inputSchema: {
        query: z.string().min(1).describe("Beginning of the part number to match."),
        mfg: z.array(z.string()).optional().describe("Filter by one or more manufacturers."),
        cond: z.array(conditionSchema).optional().describe("Filter by one or more condition codes."),
        state: z.array(z.string()).optional().describe("Filter by seller state(s)."),
        country: z.array(z.string()).optional().describe("Filter by seller country/countries."),
        region: z.array(regionSchema).optional().describe("Filter by seller region(s)."),
        age: z.number().int().optional().describe("Max listing age in days."),
        size: z.number().int().positive().optional().describe("Page size (priced parts only)."),
        offset: z.number().int().nonnegative().optional().describe("Result offset for pagination."),
        first: z.boolean().optional().describe('Boost "show first" companies.'),
        last: z.boolean().optional().describe('Deboost "show last" companies.'),
        never: z.boolean().optional().describe('Remove "show never" companies.'),
        priced: z.boolean().optional().describe("Only return parts that have a price."),
        sort: z.record(z.string(), z.enum(["asc", "desc"])).optional().describe('Sort map, e.g. {"price":"asc"}.'),
        ...loginField,
      },
    },
    async (args) =>
      safe(async () => {
        const { login, ...q } = args;
        const data = await client.request({ method: "GET", path: "/part/prefix", query: cleanQuery(q), login });
        return jsonResult(data);
      }),
  );

  // --- Part History: Quote Requests (RFQ) --------------------------------

  server.registerTool(
    "part_quote_requests",
    {
      title: "Part Quote Requests (RFQ)",
      description: "Show the number of quote requests (RFQs) on a specific part over time.",
      inputSchema: {
        query: z.string().min(1).describe("Part number to analyze."),
        mfg: z.array(z.string()).optional().describe("Filter by one or more manufacturers."),
        cond: z.array(conditionSchema).optional().describe("Filter by one or more condition codes."),
        interval: z.string().optional().describe("Histogram bucket interval, e.g. day, week, month, year."),
        from: z.string().optional().describe("Start of range. Relative (day|week|month|year) or an absolute date."),
        to: z.string().optional().describe("End of range (absolute date)."),
        fuzziness: z.number().int().min(0).optional().describe("Fuzzy-match tolerance (0 = exact)."),
        ...loginField,
      },
    },
    async (args) =>
      safe(async () => {
        const { login, ...q } = args;
        const data = await client.request({ method: "GET", path: "/part/history/rfq", query: cleanQuery(q), login });
        return jsonResult(data);
      }),
  );

  // --- Part History: Stats -----------------------------------------------

  server.registerTool(
    "part_stats",
    {
      title: "Part Price & Quantity Stats",
      description: "Show aggregate price and quantity statistics on a specific part.",
      inputSchema: {
        query: z.string().min(1).describe("Part number to analyze."),
        mfg: z.array(z.string()).optional().describe("Filter by one or more manufacturers."),
        cond: z.array(conditionSchema).optional().describe("Filter by one or more condition codes."),
        state: z.array(z.string()).optional().describe("Filter by seller state(s)."),
        country: z.array(z.string()).optional().describe("Filter by seller country/countries."),
        region: z.array(regionSchema).optional().describe("Filter by seller region(s)."),
        interval: z.string().optional().describe("Histogram bucket interval, e.g. day, week, month, year."),
        from: z.string().optional().describe("Start of range. Relative (day|week|month|year) or an absolute date."),
        to: z.string().optional().describe("End of range (absolute date)."),
        never: z.boolean().optional().describe('Remove "show never" companies.'),
        priced: z.boolean().optional().describe("Only consider parts that have a price."),
        ...loginField,
      },
    },
    async (args) =>
      safe(async () => {
        const { login, ...q } = args;
        const data = await client.request({ method: "GET", path: "/part/history/stats", query: cleanQuery(q), login });
        return jsonResult(data);
      }),
  );

  // --- Part History: Supply & Demand -------------------------------------

  server.registerTool(
    "part_supply_demand",
    {
      title: "Part Supply & Demand",
      description:
        "Show supply and demand (quantity & matches) for a specific part number as a date histogram.",
      inputSchema: {
        query: z.string().min(1).describe("Part number to analyze."),
        mfg: z.array(z.string()).optional().describe("Filter by one or more manufacturers."),
        interval: z.string().optional().describe("Histogram bucket interval, e.g. day, week, month, year."),
        from: z.string().optional().describe("Start of range. Relative (day|week|month|year) or an absolute date."),
        to: z.string().optional().describe("End of range (absolute date)."),
        fuzziness: z.number().int().min(0).optional().describe("Fuzzy-match tolerance (0 = exact)."),
        ...loginField,
      },
    },
    async (args) =>
      safe(async () => {
        const { login, ...q } = args;
        const data = await client.request({ method: "GET", path: "/part/history/supply-demand", query: cleanQuery(q), login });
        return jsonResult(data);
      }),
  );

  // --- Part History: Search Matches --------------------------------------

  server.registerTool(
    "part_search_matches",
    {
      title: "Part Search Matches",
      description: "Searches performed by users that matched a specific part.",
      inputSchema: {
        query: z.string().min(1).describe("Part number to analyze."),
        from: z.string().optional().describe("Start of range (relative or absolute date)."),
        in_stock: z.string().optional().describe("Filter to in-stock matches."),
        never: z.string().optional().describe('Remove "show never" companies.'),
        ...loginField,
      },
    },
    async (args) =>
      safe(async () => {
        const { login, ...q } = args;
        const data = await client.request({ method: "GET", path: "/part/history/matches", query: cleanQuery(q), login });
        return jsonResult(data);
      }),
  );

  // --- Manufacturer Top Parts --------------------------------------------

  server.registerTool(
    "manufacturer_top_parts",
    {
      title: "Manufacturer Top Parts",
      description: "Get the top searched parts for a specific manufacturer.",
      inputSchema: {
        query: z.string().min(1).describe("Manufacturer name."),
        from: z.string().optional().describe("Start of range (relative or absolute date)."),
        to: z.string().optional().describe("End of range (absolute date)."),
        size: z.number().int().positive().optional().describe("Number of top parts to return."),
        fuzziness: z.number().int().min(0).optional().describe("Fuzzy-match tolerance (0 = exact)."),
        ...loginField,
      },
    },
    async (args) =>
      safe(async () => {
        const { login, ...q } = args;
        const data = await client.request({ method: "GET", path: "/mfg/top-parts", query: cleanQuery(q), login });
        return jsonResult(data);
      }),
  );

  // --- Messaging: Send ---------------------------------------------------

  server.registerTool(
    "send_message",
    {
      title: "Send Message",
      description:
        "Send a new message to another BrokerBin member. Can include part line items (e.g. to request a quote). Creates a new thread.",
      inputSchema: {
        recipient: z.string().min(1).describe("Username of the member to message."),
        subject: z.string().min(1).describe("Message subject."),
        body_html: z.string().nullable().optional().describe("Message body (HTML allowed)."),
        purchase_order_in_hand: z.boolean().nullable().optional().describe("Whether the requester has a purchase order ready."),
        parts: z.array(partItemSchema).optional().describe("Optional part line items to attach to the message."),
        ...loginField,
      },
    },
    async (args) =>
      safe(async () => {
        const { login, purchase_order_in_hand, ...body } = args;
        const data = await client.request({
          method: "PUT",
          path: "/message",
          query: cleanQuery({ purchase_order_in_hand }),
          body,
          login,
        });
        return jsonResult(data);
      }),
  );

  // --- Messaging: Get Thread ---------------------------------------------

  server.registerTool(
    "get_message_thread",
    {
      title: "Get Message Thread",
      description: "Get all messages within a thread, by thread id.",
      inputSchema: {
        id: z.string().min(1).describe("Thread id."),
        ...loginField,
      },
    },
    async (args) =>
      safe(async () => {
        const { login, id } = args;
        const data = await client.request({
          method: "GET",
          path: `/message/thread/${encodeURIComponent(id)}`,
          login,
        });
        return jsonResult(data);
      }),
  );

  // --- Messaging: Reply --------------------------------------------------

  server.registerTool(
    "reply_message",
    {
      title: "Reply to Message Thread",
      description: "Reply to a message within an existing thread.",
      inputSchema: {
        id: z.string().min(1).describe("Thread id to reply to."),
        subject: z.string().min(1).describe("Reply subject."),
        body_html: z.string().nullable().optional().describe("Reply body (HTML allowed)."),
        parts: z.array(partItemSchema).optional().describe("Optional part line items to attach to the reply."),
        ...loginField,
      },
    },
    async (args) =>
      safe(async () => {
        const { login, id, ...body } = args;
        const data = await client.request({
          method: "POST",
          path: `/message/thread/${encodeURIComponent(id)}`,
          body,
          login,
        });
        return jsonResult(data);
      }),
  );
}
