/**
 * Service alert tools.
 *
 * 511 serves this feed as GTFS-Realtime, and protobuf is its DEFAULT encoding.
 * The client always sends format=json, which is what keeps this server free of
 * a protobuf dependency. The JSON rendering is PascalCase — except `cause`,
 * `effect` and `incrementality`, which are lowercase — and its timestamps are
 * epoch seconds rather than the ISO strings the rest of 511 uses.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RATE_LIMIT_PER_HOUR } from "../constants.js";
import { formatAlert } from "../formatters/entities.js";
import {
  emptyResult,
  limitResults,
  toolResult,
  truncationFooter,
  withErrorHandling,
} from "../formatters/response.js";
import { listAlertsSchema } from "../schemas/inputs.js";
import { listOutput } from "../schemas/outputs.js";
import type { TransitClientConfig } from "../services/transit-client.js";
import { request } from "../services/transit-client.js";
import type { AlertEntity, AlertTranslation, ServiceAlertsResponse } from "../types.js";

const allText = (entity: AlertEntity): string => {
  const gather = (translations: AlertTranslation[] | undefined) =>
    (translations ?? []).map((entry) => entry.Text ?? "").join(" ");
  const alert = entity.Alert ?? {};
  return [
    gather(alert.HeaderText?.Translations),
    gather(alert.DescriptionText?.Translations),
  ]
    .join(" ")
    .toLowerCase();
};

/**
 * An alert is current when now falls inside any of its active periods. A
 * missing End means open-ended, and an alert with no periods at all is treated
 * as current rather than filtered away — dropping it would hide a live
 * disruption on a technicality.
 */
const isActive = (entity: AlertEntity, nowSeconds: number): boolean => {
  const periods = entity.Alert?.ActivePeriods ?? [];
  if (periods.length === 0) return true;
  return periods.some((period) => {
    const start = period.Start ?? 0;
    const end = period.End ?? Number.POSITIVE_INFINITY;
    return nowSeconds >= start && nowSeconds <= end;
  });
};

export const registerAlertTools = (server: McpServer, config: TransitClientConfig): void => {
  server.registerTool(
    "transit_list_service_alerts",
    {
      title: "List Transit Service Alerts",
      description: `Service alerts — delays, outages, detours and planned disruptions.

Answers "is BART running normally", "why is my line delayed" and "anything I should know before I leave". Omit operator_id to sweep every Bay Area agency in a single request, which is also the kinder option against the hourly quota.

Args:
  - operator_id (string): limit to one agency; omit for all operators
  - query (string): substring match on the headline or description
  - active_only (boolean): only alerts whose active period covers now (default: true)
  - limit (number): maximum alerts to return (default: 25)
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  {
    "count": number, "total": number, "truncated": boolean,
    "alerts": [ { "id": string, "header": string, "description": string,
                  "effect": string, "cause": string, "routes": [string],
                  "start": number, "end": number } ]     // epoch SECONDS
  }

Examples:
  - "Any BART delays?" -> operator_id='BA'
  - "Anything wrong on my commute?" -> omit operator_id, read across agencies
  - "Weekend track work?" -> active_only=false, query='weekend'
  - Don't use when: you want a specific stop's arrivals (use transit_next_departures)

Error Handling:
  - No alerts is genuinely good news, not an error — it means normal service
  - Timestamps here are epoch seconds, unlike the ISO strings elsewhere in this API
  - Setting active_only=false surfaces future planned work as well as current problems
  - 511 allows ${RATE_LIMIT_PER_HOUR} requests per hour across ALL endpoints`,
      inputSchema: listAlertsSchema,
      outputSchema: listOutput("alerts"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof listAlertsSchema>) => {
      const data = await request<ServiceAlertsResponse>(config, "/transit/servicealerts", {
        query: { agency: params.operator_id },
      });

      const nowSeconds = Math.floor(Date.now() / 1000);
      const needle = params.query?.trim().toLowerCase();

      const all = (data?.Entities ?? [])
        .filter((entity) => Boolean(entity.Alert))
        .filter((entity) => (params.active_only ? isActive(entity, nowSeconds) : true))
        .filter((entity) => (needle ? allText(entity).includes(needle) : true));

      const { items, meta } = limitResults(all, params.limit);

      const pickText = (translations: AlertTranslation[] | undefined): string | null => {
        const list = translations ?? [];
        const english = list.find((entry) => (entry.Language ?? "").toLowerCase().startsWith("en"));
        return (english ?? list[0])?.Text ?? null;
      };

      const alerts = items.map((entity) => {
        const alert = entity.Alert ?? {};
        const period = (alert.ActivePeriods ?? [])[0] ?? {};
        return {
          id: entity.Id ?? null,
          header: pickText(alert.HeaderText?.Translations),
          description: pickText(alert.DescriptionText?.Translations),
          url: pickText(alert.Url?.Translations),
          effect: alert.effect ?? null,
          cause: alert.cause ?? null,
          routes: [
            ...new Set(
              (alert.InformedEntities ?? [])
                .map((informed) => informed.RouteId)
                .filter((route): route is string => Boolean(route)),
            ),
          ],
          start: period.Start ?? null,
          end: period.End ?? null,
        };
      });

      const structured = { ...meta, alerts };

      if (all.length === 0) {
        return emptyResult(
          params.operator_id
            ? `No ${params.active_only ? "active " : ""}service alerts for ${params.operator_id} — normal service.` +
                (params.active_only ? " Pass active_only=false to see planned future work." : "")
            : `No ${params.active_only ? "active " : ""}service alerts across Bay Area operators — normal service.`,
          structured,
        );
      }

      return toolResult(params.response_format, structured, () =>
        [
          `# Service alerts (${meta.total})`,
          "",
          items.map((entity) => formatAlert(entity, true)).join("\n\n"),
          truncationFooter(meta, "Raise `limit` or narrow with `query`."),
        ].join("\n"),
      );
    }),
  );
};
