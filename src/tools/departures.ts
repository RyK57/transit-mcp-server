/**
 * Real-time tools — live departures at a stop, and vehicle positions.
 *
 * Both read SIRI feeds, but their envelopes differ in a way that is easy to
 * get wrong: StopMonitoring has NO `Siri` root wrapper, while
 * VehicleMonitoring does. The published spec shows one for both; the live API
 * disagrees, and the live API is what this parses.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RATE_LIMIT_PER_HOUR } from "../constants.js";
import { formatDeparture, formatVehicle } from "../formatters/entities.js";
import {
  emptyResult,
  formatClock,
  limitResults,
  minutesUntil,
  toolResult,
  truncationFooter,
  withErrorHandling,
} from "../formatters/response.js";
import { listVehiclesSchema, nextDeparturesSchema } from "../schemas/inputs.js";
import { departuresOutput, listOutput } from "../schemas/outputs.js";
import type { TransitClientConfig } from "../services/transit-client.js";
import { request } from "../services/transit-client.js";
import type {
  MonitoredStopVisit,
  MonitoredVehicleJourney,
  StopMonitoringResponse,
  VehicleActivity,
  VehicleMonitoringResponse,
} from "../types.js";

/**
 * SIRI producers vary in whether a single-element collection serialises as an
 * array or a bare object. 511 emits arrays, but normalising costs nothing and
 * removes a whole class of crash.
 */
const ensureArray = <T>(value: T | T[] | undefined | null): T[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/** Case-insensitive match of a line filter against the name or the id. */
const matchesLine = (journey: MonitoredVehicleJourney, filter: string): boolean => {
  const needle = filter.trim().toLowerCase();
  return [journey.PublishedLineName, journey.LineRef].some(
    (candidate) => (candidate ?? "").toLowerCase() === needle,
  );
};

/** Sort key: the live prediction, falling back to the timetable. */
const departureTime = (visit: MonitoredStopVisit): number => {
  const call = visit.MonitoredVehicleJourney?.MonitoredCall ?? {};
  const raw = call.ExpectedArrivalTime || call.AimedArrivalTime || call.AimedDepartureTime;
  const parsed = raw ? new Date(raw).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

export const registerDepartureTools = (server: McpServer, config: TransitClientConfig): void => {
  server.registerTool(
    "transit_next_departures",
    {
      title: "Next Transit Departures",
      description: `Live arrival predictions for the next vehicles at a stop.

This is the tool for "when is my next train/bus". It returns real-time predictions, not the printed timetable, and reports minutes-from-now alongside Pacific clock time.

Args:
  - operator_id (string): agency code from transit_list_operators, e.g. 'BA', 'SF'
  - stop_code (string): stop code from transit_find_stops. Codes belong to ONE operator
    and are not interchangeable between agencies
  - line (string): only departures on this line, matched on name or id
  - limit (number): maximum departures to return (default: ${10})
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  {
    "count": number, "total": number, "truncated": boolean,
    "operator": string, "stop_code": string, "stop_name": string, "retrieved_at": string,
    "departures": [ { "line": string, "destination": string,
                      "expected": string, "aimed": string, "minutes": number,
                      "vehicle": string | null, "at_stop": boolean } ]
  }

Examples:
  - "When's the next N Judah?" -> operator_id='SF', stop_code from transit_find_stops, line='N'
  - "Next BART from Downtown Berkeley?" -> operator_id='BA', the stop's code
  - Don't use when: you want the scheduled timetable rather than live predictions

Error Handling:
  - An empty result usually means service has ended for the night, or the stop is a route's
    final stop — 511 omits arrival-only terminals from this feed
  - Predictions extend roughly 90 minutes ahead; nothing beyond that appears
  - Rows reading "scheduled only, no live prediction" have no vehicle assigned yet
  - 511 allows ${RATE_LIMIT_PER_HOUR} requests per hour across ALL endpoints — never poll this in a loop`,
      inputSchema: nextDeparturesSchema,
      outputSchema: departuresOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof nextDeparturesSchema>) => {
      const data = await request<StopMonitoringResponse>(config, "/transit/StopMonitoring", {
        // Real-time endpoints spell this `agency`, unlike the static ones.
        query: { agency: params.operator_id, stopCode: params.stop_code },
      });

      const delivery = data?.ServiceDelivery?.StopMonitoringDelivery;
      const retrievedAt =
        delivery?.ResponseTimestamp ?? data?.ServiceDelivery?.ResponseTimestamp ?? null;

      const all = ensureArray(delivery?.MonitoredStopVisit)
        .filter((visit) => {
          const journey = visit.MonitoredVehicleJourney;
          if (!journey) return false;
          return params.line ? matchesLine(journey, params.line) : true;
        })
        .sort((a, b) => departureTime(a) - departureTime(b));

      const { items, meta } = limitResults(all, params.limit);
      const now = new Date();

      const stopName =
        items[0]?.MonitoredVehicleJourney?.MonitoredCall?.StopPointName ?? null;

      const departures = items.map((visit) => {
        const journey = visit.MonitoredVehicleJourney ?? {};
        const call = journey.MonitoredCall ?? {};
        const expected = call.ExpectedArrivalTime ?? null;
        return {
          line: journey.PublishedLineName ?? journey.LineRef ?? null,
          destination: journey.DestinationName ?? call.DestinationDisplay ?? null,
          expected,
          aimed: call.AimedArrivalTime ?? null,
          minutes: minutesUntil(expected ?? call.AimedArrivalTime, now),
          vehicle: journey.VehicleRef ?? null,
          at_stop: String(call.VehicleAtStop ?? "").toLowerCase() === "true",
        };
      });

      const structured = {
        ...meta,
        operator: params.operator_id,
        stop_code: params.stop_code,
        stop_name: stopName,
        retrieved_at: retrievedAt,
        departures,
      };

      if (all.length === 0) {
        return emptyResult(
          `No live departures at stop ${params.stop_code} on ${params.operator_id}` +
            (params.line ? ` for line '${params.line}'` : "") +
            ". Service may have ended for the night, the line filter may not match " +
            "(try transit_next_departures without it), or this may be a route's final stop — " +
            "511 omits arrival-only terminals from the real-time feed.",
          structured,
        );
      }

      return toolResult(params.response_format, structured, () =>
        [
          `# Departures — ${stopName ?? `stop ${params.stop_code}`} (${params.operator_id})`,
          retrievedAt ? `_Live as of ${formatClock(retrievedAt)}_` : "",
          "",
          items.map((visit) => formatDeparture(visit, now)).join("\n"),
          truncationFooter(meta, "Raise `limit` for more."),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }),
  );

  server.registerTool(
    "transit_list_vehicles",
    {
      title: "List Transit Vehicle Positions",
      description: `Live positions of an agency's vehicles currently in service.

Answers "where are the trains right now" and "how many buses are running on this line". For "when does one get to me", use transit_next_departures instead.

Args:
  - operator_id (string): agency code from transit_list_operators
  - line (string): only vehicles on this line, matched on name or id
  - limit (number): maximum vehicles to return (default: 25)
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  {
    "count": number, "total": number, "truncated": boolean,
    "vehicles": [ { "line": string, "vehicle": string, "destination": string,
                    "latitude": number | null, "longitude": number | null,
                    "bearing": number | null, "recorded_at": string } ]
  }

Examples:
  - "How many Muni trains are running on the N?" -> operator_id='SF', line='N'
  - "Where are the BART trains?" -> operator_id='BA'
  - Don't use when: you want arrival times at a stop (use transit_next_departures)

Error Handling:
  - Coordinates arrive as strings and may be empty; those vehicles report "position unavailable" rather than a false 0,0
  - An agency with no real-time feed returns nothing — check Monitored in transit_list_operators
  - 511 allows ${RATE_LIMIT_PER_HOUR} requests per hour across ALL endpoints`,
      inputSchema: listVehiclesSchema,
      outputSchema: listOutput("vehicles"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof listVehiclesSchema>) => {
      const data = await request<VehicleMonitoringResponse>(config, "/transit/VehicleMonitoring", {
        query: { agency: params.operator_id },
      });

      // Unlike StopMonitoring, this endpoint DOES nest under a `Siri` root.
      const delivery = data?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery;

      const all = ensureArray<VehicleActivity>(delivery?.VehicleActivity).filter((activity) => {
        const journey = activity.MonitoredVehicleJourney;
        if (!journey) return false;
        return params.line ? matchesLine(journey, params.line) : true;
      });

      const { items, meta } = limitResults(all, params.limit);

      const vehicles = items.map((activity) => {
        const journey = activity.MonitoredVehicleJourney ?? {};
        const lat = Number(journey.VehicleLocation?.Latitude);
        const lon = Number(journey.VehicleLocation?.Longitude);
        const bearing = Number(journey.Bearing);
        return {
          line: journey.PublishedLineName ?? journey.LineRef ?? null,
          vehicle: journey.VehicleRef ?? null,
          destination: journey.DestinationName ?? null,
          latitude: Number.isFinite(lat) && journey.VehicleLocation?.Latitude ? lat : null,
          longitude: Number.isFinite(lon) && journey.VehicleLocation?.Longitude ? lon : null,
          bearing: Number.isFinite(bearing) && journey.Bearing ? bearing : null,
          recorded_at: activity.RecordedAtTime ?? null,
        };
      });

      const structured = { ...meta, vehicles };

      if (all.length === 0) {
        return emptyResult(
          `No vehicles currently reporting for ${params.operator_id}` +
            (params.line ? ` on line '${params.line}'` : "") +
            ". The agency may not publish real-time data — check Monitored in " +
            "transit_list_operators — or service may not be running.",
          structured,
        );
      }

      return toolResult(params.response_format, structured, () =>
        [
          `# Vehicles — ${params.operator_id} (${meta.total} in service)`,
          "",
          items.map(formatVehicle).join("\n"),
          truncationFooter(meta, "Raise `limit` or filter by `line`."),
        ].join("\n"),
      );
    }),
  );
};
