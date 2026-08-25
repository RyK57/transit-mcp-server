/**
 * Network reference tools — agencies, lines and stops.
 *
 * These resolve the two ids every other tool needs. They read 511's static
 * endpoints, which use `operator_id` where the real-time ones use `agency`,
 * and which wrap their payloads inconsistently: operators and lines arrive as
 * bare arrays, while stops are nested inside NeTEx containers.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { INTERNAL_OPERATOR_IDS, RATE_LIMIT_PER_HOUR } from "../constants.js";
import { formatLine, formatOperator, formatStop } from "../formatters/entities.js";
import {
  emptyResult,
  limitResults,
  toolResult,
  truncationFooter,
  withErrorHandling,
} from "../formatters/response.js";
import { findStopsSchema, listLinesSchema, listOperatorsSchema } from "../schemas/inputs.js";
import { listOutput } from "../schemas/outputs.js";
import type { TransitClientConfig } from "../services/transit-client.js";
import { rateLimit, request } from "../services/transit-client.js";
import type { Line, Operator, Stop } from "../types.js";

/**
 * Finds the collection inside a 511 static response.
 *
 * The endpoints are not consistent: some return a bare array, while `/stops`
 * nests its payload under NeTEx containers such as
 * `Contents.dataObjects.ScheduledStopPoint`. Rather than hard-coding one shape
 * per endpoint and breaking when 511 changes a wrapper, this walks the
 * candidate paths and falls back to the first array it can find.
 */
export const unwrapCollection = <T>(data: unknown, ...paths: string[]): T[] => {
  if (Array.isArray(data)) return data as T[];
  if (!data || typeof data !== "object") return [];

  for (const path of paths) {
    let cursor: unknown = data;
    for (const segment of path.split(".")) {
      if (!cursor || typeof cursor !== "object") {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    if (Array.isArray(cursor)) return cursor as T[];
    // A single-element collection can serialise as a bare object.
    if (cursor && typeof cursor === "object") return [cursor as T];
  }

  // Last resort: the first array-valued property at any depth of two.
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (Array.isArray(value)) return value as T[];
    if (value && typeof value === "object") {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        if (Array.isArray(nested)) return nested as T[];
      }
    }
  }
  return [];
};

const contains = (haystack: string | undefined, needle: string): boolean =>
  (haystack ?? "").toLowerCase().includes(needle);

export const registerNetworkTools = (server: McpServer, config: TransitClientConfig): void => {
  server.registerTool(
    "transit_list_operators",
    {
      title: "List Transit Operators",
      description: `List Bay Area transit agencies and their operator codes.

Start here. Every other tool needs an operator code, and this is what produces them — BART is 'BA', Muni is 'SF', AC Transit is 'AC', Caltrain is 'CT'.

The Monitored flag matters: agencies reporting real-time data support live departures and vehicle positions, while schedule-only agencies do not.

Args:
  - monitored_only (boolean): only agencies publishing real-time data (default: false)
  - limit (number): maximum operators to return (default: 50)
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  {
    "count": number, "total": number, "truncated": boolean,
    "operators": [ { "Id": string, "Name": string, "Monitored": boolean,
                     "PrimaryMode": string, "TimeZone": string } ]
  }

Examples:
  - "What transit agencies are there?" -> call with no arguments
  - "Which ones have live tracking?" -> monitored_only=true
  - Call this first whenever the user names an agency, to resolve its code

Error Handling:
  - Ignore the TimeZone field: 511 reports "America/Vancouver" for every Bay Area agency,
    which is a known upstream data bug. Everything here is Pacific time
  - 511-internal pseudo-agencies (5E, 5F, 5O, 5S) are filtered out — they carry no service data
  - 511 allows ${RATE_LIMIT_PER_HOUR} requests per hour across ALL endpoints, so cache this rather than re-fetching`,
      inputSchema: listOperatorsSchema,
      outputSchema: listOutput("operators"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof listOperatorsSchema>) => {
      const data = await request<unknown>(config, "/transit/operators");
      const all = unwrapCollection<Operator>(data, "Operators.Operator", "Operator")
        // 511 lists internal pseudo-agencies alongside real ones; they carry no
        // service data and only add noise for someone picking an agency.
        .filter((operator) => !INTERNAL_OPERATOR_IDS.has((operator.Id ?? "").toUpperCase()))
        .filter((operator) => (params.monitored_only ? operator.Monitored !== false : true));

      const { items, meta } = limitResults(all, params.limit);
      const structured = { ...meta, operators: items };

      if (all.length === 0) {
        return emptyResult(
          params.monitored_only
            ? "No agencies reported real-time support. Retry with monitored_only=false."
            : "511 returned no operators, which is unexpected — verify the API key is active.",
          structured,
        );
      }

      return toolResult(params.response_format, structured, () =>
        [
          `# Transit operators (${meta.total})`,
          "",
          items.map(formatOperator).join("\n"),
          "",
          "_Codes that are easy to guess wrong: VTA is `SC` (not VT), Capitol Corridor is " +
            "`AM` (not CC), Tri Delta is `3D`._",
          truncationFooter(meta, "Raise `limit` for the rest."),
          rateLimit.remaining !== null
            ? `_API quota: ${rateLimit.remaining} of ${rateLimit.limit ?? RATE_LIMIT_PER_HOUR} requests left this hour._`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }),
  );

  server.registerTool(
    "transit_list_lines",
    {
      title: "List Transit Lines",
      description: `List an agency's routes.

Use this to resolve a line name a user mentions into the id the real-time tools filter on, or to answer "what routes does this agency run".

Args:
  - operator_id (string): agency code from transit_list_operators
  - query (string): substring match on the line name or public code
  - limit (number): maximum lines to return (default: 25)
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  {
    "count": number, "total": number, "truncated": boolean,
    "lines": [ { "Id": string, "Name": string, "PublicCode": string,
                 "TransportMode": string, "Monitored": boolean } ]
  }

Examples:
  - "What BART lines are there?" -> operator_id='BA'
  - "Is there an N line on Muni?" -> operator_id='SF', query='N'
  - Don't use when: you want stops on a line (use transit_find_stops)

Error Handling:
  - A large agency returns many lines; use query to narrow rather than raising limit
  - 511 allows ${RATE_LIMIT_PER_HOUR} requests per hour across ALL endpoints`,
      inputSchema: listLinesSchema,
      outputSchema: listOutput("lines"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof listLinesSchema>) => {
      const data = await request<unknown>(config, "/transit/lines", {
        // Static endpoints spell this `operator_id`, unlike the real-time ones.
        query: { operator_id: params.operator_id },
      });

      const needle = params.query?.trim().toLowerCase();
      const all = unwrapCollection<Line>(data, "Lines.Line", "Line").filter((line) =>
        needle ? contains(line.Name, needle) || contains(line.PublicCode, needle) || contains(line.Id, needle) : true,
      );

      const { items, meta } = limitResults(all, params.limit);
      const structured = { ...meta, lines: items };

      if (all.length === 0) {
        return emptyResult(
          needle
            ? `No lines matching '${params.query}' for ${params.operator_id}. Drop the query to see all of them.`
            : `No lines for operator '${params.operator_id}'. Confirm the code with transit_list_operators.`,
          structured,
        );
      }

      return toolResult(params.response_format, structured, () =>
        [
          `# Lines — ${params.operator_id} (${meta.total})`,
          "",
          items.map(formatLine).join("\n"),
          truncationFooter(meta, "Narrow with `query`, or raise `limit`."),
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "transit_find_stops",
    {
      title: "Find Transit Stops",
      description: `Find an agency's stops by name, and get the stop codes the real-time tools need.

This is the bridge between "Downtown Berkeley" and the code transit_next_departures wants. Pass a query: a large agency has thousands of stops, and 511 returns all of them in one unpaginated response.

Args:
  - operator_id (string): agency code from transit_list_operators
  - query (string): substring match on the stop name — strongly recommended
  - limit (number): maximum stops to return (default: 25)
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  {
    "count": number, "total": number, "truncated": boolean,
    "stops": [ { "id": string, "Name": string,
                 "Location": { "Latitude": string, "Longitude": string } } ]
  }

Examples:
  - "When's the next train from Downtown Berkeley?" -> operator_id='BA', query='downtown berkeley', then pass the id to transit_next_departures
  - "Find Muni stops on Judah" -> operator_id='SF', query='judah'
  - Don't use when: you already have the stop code

Error Handling:
  - Stop codes belong to ONE operator and are not interchangeable between agencies
  - Filtering happens on this server, so a narrow query does not save quota — the full list is fetched either way
  - 511 allows ${RATE_LIMIT_PER_HOUR} requests per hour across ALL endpoints`,
      inputSchema: findStopsSchema,
      outputSchema: listOutput("stops"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof findStopsSchema>) => {
      const data = await request<unknown>(config, "/transit/stops", {
        query: { operator_id: params.operator_id },
      });

      const needle = params.query?.trim().toLowerCase();
      const all = unwrapCollection<Stop>(
        data,
        "Contents.dataObjects.ScheduledStopPoint",
        "dataObjects.ScheduledStopPoint",
        "ScheduledStopPoint",
      ).filter((stop) => (needle ? contains(stop.Name, needle) || contains(stop.id, needle) : true));

      const { items, meta } = limitResults(all, params.limit);
      const structured = { ...meta, stops: items };

      if (all.length === 0) {
        return emptyResult(
          needle
            ? `No stops matching '${params.query}' for ${params.operator_id}. Try a shorter or ` +
                "differently-spelled fragment — 511 stop names often abbreviate, e.g. 'St' for Street."
            : `No stops for operator '${params.operator_id}'. Confirm the code with transit_list_operators.`,
          structured,
        );
      }

      return toolResult(params.response_format, structured, () =>
        [
          `# Stops — ${params.operator_id} (${meta.total} matching)`,
          "",
          items.map(formatStop).join("\n"),
          truncationFooter(meta, "Narrow with `query`, or raise `limit`."),
        ].join("\n"),
      );
    }),
  );
};
