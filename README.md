# Brokerbin MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the
[BrokerBin.com](https://brokerbin.com) REST API (v2.1.2) as tools for Claude and other MCP clients.

It supports two transports:

- **HTTP (Streamable HTTP, stateless)** — for hosting on Render or any cloud. Default.
- **stdio** — for running locally inside Claude Desktop / Claude Code.

## Tools

| Tool | BrokerBin endpoint | Description |
| --- | --- | --- |
| `search_parts` | `GET /part/search` | Keyword search of current part listings |
| `search_parts_prefix` | `GET /part/prefix` | Search by the beginning of a part number |
| `part_quote_requests` | `GET /part/history/rfq` | RFQ (quote request) counts over time |
| `part_stats` | `GET /part/history/stats` | Aggregate price & quantity statistics |
| `part_supply_demand` | `GET /part/history/supply-demand` | Supply/demand date histogram |
| `part_search_matches` | `GET /part/history/matches` | User searches that matched a part |
| `manufacturer_top_parts` | `GET /mfg/top-parts` | Top searched parts for a manufacturer |
| `send_message` | `PUT /message` | Send a new message (optionally with part line items) |
| `get_message_thread` | `GET /message/thread/{id}` | Read all messages in a thread |
| `reply_message` | `POST /message/thread/{id}` | Reply within an existing thread |

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` for local runs.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `BROKERBIN_API_KEY` | ✅ | — | Your BrokerBin bearer token |
| `MCP_TRANSPORT` | — | `http` | `http` or `stdio` |
| `PORT` | — | `3000` | HTTP port (Render injects this) |
| `HOST` | — | `0.0.0.0` | HTTP bind host |
| `MCP_AUTH_TOKEN` | — | — | If set, clients must send `Authorization: Bearer <token>`. **Set this for public hosting.** |
| `BROKERBIN_DEFAULT_LOGIN` | — | — | Default username to act as (BrokerBin falls back to the company "primary" user) |
| `BROKERBIN_BASE_URL` | — | `https://search.brokerbin.com/api/v2` | Override API base URL |
| `BROKERBIN_TIMEOUT_MS` | — | `30000` | Per-request timeout |
| `BROKERBIN_MAX_RETRIES` | — | `3` | Retries for 429/5xx/network errors |
| `LOG_LEVEL` | — | `info` | `debug` \| `info` \| `warn` \| `error` |

> **Security:** The server never logs your API key. When hosting publicly, always set
> `MCP_AUTH_TOKEN` so strangers can't use your Render URL to spend against your BrokerBin account.

## Deploy to Render

### Option A — Blueprint (recommended)

1. Push this repo to GitHub/GitLab.
2. In Render: **New + → Blueprint**, and select the repo. Render reads `render.yaml`.
3. When prompted, set **`BROKERBIN_API_KEY`** to your token. `MCP_AUTH_TOKEN` is auto-generated — copy it from the dashboard; you'll give it to your MCP client.
4. Deploy. Your endpoint is `https://<service>.onrender.com/mcp`, health at `/health`.

### Option B — Manual web service

- **Build command:** `npm ci && npm run build`
- **Start command:** `npm start`
- **Health check path:** `/health`
- Add env vars `BROKERBIN_API_KEY` and `MCP_AUTH_TOKEN` (and optionally the rest).

### Option C — Docker

A `Dockerfile` is included. On Render choose **runtime: Docker**, or build/run locally:

```bash
docker build -t brokerbin-mcp .
docker run -p 3000:3000 -e BROKERBIN_API_KEY=... -e MCP_AUTH_TOKEN=... brokerbin-mcp
```

## Connect a client

### ChatGPT custom MCP connector (no-auth clients)

ChatGPT's "Add custom MCP server" dialog only offers **OAuth** or **No authentication** —
it can't send a bearer header. Put the secret in the URL path instead:

- **Authentication:** No authentication
- **Server URL:** `https://<service>.onrender.com/mcp/<MCP_AUTH_TOKEN>`

The server accepts the token via the URL path (`/mcp/<token>`), a `?token=` query
param, or the `Authorization: Bearer` header — whichever the client supports. Use a
long random token (not a short PIN); URL secrets are only as strong as their entropy.

### Claude Code / Claude Desktop — remote (hosted on Render)

```bash
claude mcp add --transport http Brokerbin https://<service>.onrender.com/mcp \
  --header "Authorization: Bearer <your MCP_AUTH_TOKEN>"
```

Or in a client that uses JSON config:

```json
{
  "mcpServers": {
    "Brokerbin": {
      "type": "http",
      "url": "https://<service>.onrender.com/mcp",
      "headers": { "Authorization": "Bearer <your MCP_AUTH_TOKEN>" }
    }
  }
}
```

### Claude Desktop — local (stdio)

```json
{
  "mcpServers": {
    "Brokerbin": {
      "command": "node",
      "args": ["/absolute/path/to/brokerbin-mcp/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "BROKERBIN_API_KEY": "your-token"
      }
    }
  }
}
```

## Local development

```bash
npm install
npm run build

# HTTP mode
BROKERBIN_API_KEY=... MCP_AUTH_TOKEN=secret npm start

# stdio mode
BROKERBIN_API_KEY=... MCP_TRANSPORT=stdio node dist/index.js
```

Quick HTTP check:

```bash
curl -s localhost:3000/health
curl -s -X POST localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer secret" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Notes on BrokerBin behavior

- Array filters (`mfg`, `cond`, `state`, `country`, `region`, `fields`) are sent as repeated
  `key[]=value` query params. `sort` is sent as `sort[field]=asc|desc`.
- Condition codes: `NEW, ASIS, EXC, F/S, NOB, REF, REP, USED, OEMREF`.
- Regions: `North America, South America, Africa, Middle East, Europe, Oceania, Asia`.
- Date ranges (`from`/`to`) accept relative tokens (`day`, `week`, `month`, `year`) or absolute dates.
```
