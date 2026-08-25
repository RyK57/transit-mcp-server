#!/usr/bin/env node
/**
 * transit-mcp-server — MCP server for the Canvas LMS REST API.
 *
 * Transports:
 *   stdio (default)      — local use, launched as a subprocess by the MCP client
 *   streamable HTTP      — set TRANSPORT=http; stateless, one transport per request
 *
 * All logging goes to stderr: stdout is the stdio transport's message channel.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { loadConfig, type TransitClientConfig } from "./services/transit-client.js";
import { registerAlertTools } from "./tools/alerts.js";
import { registerDepartureTools } from "./tools/departures.js";
import { registerNetworkTools } from "./tools/network.js";

const HELP_TEXT = `${SERVER_NAME} v${SERVER_VERSION}

MCP server exposing the 511.org SF Bay Area transit API.

Usage:
  transit-mcp-server            Run over stdio (default)
  TRANSPORT=http transit-mcp-server   Run a streamable HTTP server

Environment:
  TRANSIT_511_API_KEY        Required. Request one at https://511.org/open-data/token
  TRANSIT_511_BASE_URL       Optional. Defaults to https://api.511.org
  TRANSIT_511_REQUEST_TIMEOUT_MS  Optional. Defaults to 30000
  TRANSPORT                  Optional. 'stdio' (default) or 'http'
  PORT                       Optional. HTTP port, defaults to 3000
  HOST                       Optional. HTTP bind address, defaults to 127.0.0.1
  MCP_PATH_SECRET            Required when HOST is not loopback. Serves the endpoint at
                             /mcp/<secret>. Generate with: openssl rand -hex 32
  ALLOWED_ORIGINS            Optional. Comma-separated origin allowlist
`;

const buildServer = (config: TransitClientConfig): McpServer => {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for Bay Area public transit via 511.org: agencies, lines, stops, real-time " +
        "departures and service alerts, covering BART, Muni, AC Transit, Caltrain, VTA and " +
        "every other 511-reporting operator. " +
        "Two ids are needed for most calls: an operator code (e.g. 'BA' for BART, 'SF' for " +
        "Muni) from transit_list_operators, and a stop code from transit_find_stops. " +
        "For 'when is my next train', use transit_next_departures — it returns live " +
        "predictions, not the timetable. " +
        "Departure times are returned in Pacific time alongside minutes-from-now, which is " +
        "the part a rider acts on. " +
        "This API is quota-limited per key, so prefer one broad call over many narrow ones, " +
        "and avoid polling in a loop.",
    },
  );

  registerNetworkTools(server, config);
  registerDepartureTools(server, config);
  registerAlertTools(server, config);

  return server;
};

const runStdio = async (config: TransitClientConfig): Promise<void> => {
  const server = buildServer(config);
  await server.connect(new StdioServerTransport());
  console.error(`[${SERVER_NAME}] listening on stdio`);
};

/**
 * Stateless streamable HTTP: a fresh transport per request avoids request-id
 * collisions between concurrent clients.
 *
 * When deployed publicly, MCP_PATH_SECRET gates the endpoint. Without it, a
 * hosted server is an open proxy to the Canvas account whose token it holds.
 */
const runHttp = async (config: TransitClientConfig): Promise<void> => {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  const pathSecret = process.env.MCP_PATH_SECRET?.trim();

  const allowedOrigins = (
    process.env.ALLOWED_ORIGINS ??
    "http://localhost,http://127.0.0.1,https://claude.ai,https://www.claude.ai,https://claude.com"
  )
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  if (!pathSecret && host !== "127.0.0.1" && host !== "localhost") {
    console.error(
      `[${SERVER_NAME}] REFUSING TO START: bound to ${host} with no MCP_PATH_SECRET set. ` +
        "A publicly reachable server with no secret lets anyone read the Canvas account " +
        "this token belongs to. Generate one with: openssl rand -hex 32",
    );
    process.exit(1);
  }

  const expectedPath = pathSecret ? `/mcp/${pathSecret}` : "/mcp";

  /** Constant-time compare so the secret can't be recovered by timing the response. */
  const pathMatches = (urlPath: string): boolean => {
    const actual = Buffer.from(urlPath);
    const expected = Buffer.from(expectedPath);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  const originAllowed = (origin: string | undefined): boolean => {
    // Server-to-server callers (including Claude's infrastructure) send no Origin.
    if (!origin) return true;
    const normalized = origin.replace(/\/+$/, "");
    return allowedOrigins.some(
      (allowed) => normalized === allowed || normalized.startsWith(`${allowed}:`),
    );
  };

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : undefined;
  };

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const urlPath = (req.url ?? "").split("?")[0] ?? "";

      // Unauthenticated liveness probe for the platform's health checks.
      if (req.method === "GET" && urlPath === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION }));
        return;
      }

      // A wrong or missing secret gets the same 404 as any unknown path, so the
      // endpoint's existence isn't revealed to someone probing the host.
      if (!pathMatches(urlPath)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }

      // The path is right but the verb is not. Streamable HTTP clients probe
      // with GET to open a server-initiated SSE stream; 405 tells them the
      // endpoint is real and simply does not offer one, where a 404 would read
      // as a bad URL and abort the connection. Nothing leaks: reaching this
      // branch already required the secret.
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json", allow: "POST" });
        res.end(
          JSON.stringify({
            error: "Method not allowed. This endpoint speaks streamable HTTP over POST only.",
          }),
        );
        return;
      }

      if (!originAllowed(req.headers.origin)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Origin not allowed" }));
        return;
      }

      try {
        const body = await readBody(req);
        const server = buildServer(config);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        res.on("close", () => {
          void transport.close();
          void server.close();
        });

        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        console.error(`[${SERVER_NAME}] request failed:`, error);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
    })();
  });

  httpServer.listen(port, host, () => {
    console.error(
      `[${SERVER_NAME}] listening on http://${host}:${port}${pathSecret ? "/mcp/<secret>" : "/mcp"}`,
    );
  });
};

const main = async (): Promise<void> => {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP_TEXT);
    return;
  }
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log(SERVER_VERSION);
    return;
  }

  const config = loadConfig();

  if ((process.env.TRANSPORT ?? "stdio").toLowerCase() === "http") {
    await runHttp(config);
  } else {
    await runStdio(config);
  }
};

main().catch((error: unknown) => {
  console.error(
    `[${SERVER_NAME}] fatal: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
