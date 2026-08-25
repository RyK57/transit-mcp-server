/**
 * Zod input schemas for every tool.
 *
 * One naming decision is worth stating: 511 calls the agency parameter
 * `operator_id` on its static endpoints and `agency` on its real-time ones,
 * for the same value. Every tool here takes `operator_id`, and the client maps
 * it per endpoint. That split is 511's problem, not the caller's.
 */

import { z } from "zod";
import { DEFAULT_DEPARTURE_LIMIT, DEFAULT_LIMIT, MAX_LIMIT } from "../constants.js";
import { RESPONSE_FORMATS } from "../formatters/response.js";

export const responseFormatField = z
  .enum(RESPONSE_FORMATS)
  .default("markdown")
  .describe("Output format: 'markdown' for human-readable, 'json' for machine-readable");

/**
 * 511 returns whole collections rather than pages, so this is a client-side
 * cap. Results beyond it are reported as withheld, never silently dropped.
 */
export const limitField = (defaultLimit = DEFAULT_LIMIT) =>
  z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT, `Capped at ${MAX_LIMIT} to keep a single call readable`)
    .default(defaultLimit)
    .describe(`Maximum results to return (max ${MAX_LIMIT})`);

/**
 * Operator codes are short and case-sensitive upstream, but an agent is as
 * likely to produce "ba" as "BA", so they are normalised here.
 */
export const operatorIdField = z
  .string()
  .min(1)
  .transform((value) => value.trim().toUpperCase())
  .describe("Operator code from transit_list_operators, e.g. 'BA' for BART, 'SF' for Muni");

/* -------------------------------------------------------------------------- */
/* Network / reference                                                         */
/* -------------------------------------------------------------------------- */

export const listOperatorsSchema = z
  .object({
    monitored_only: z
      .boolean()
      .default(false)
      .describe("Only agencies that publish real-time data, excluding schedule-only ones"),
    limit: limitField(50),
    response_format: responseFormatField,
  })
  .strict();

export const listLinesSchema = z
  .object({
    operator_id: operatorIdField,
    query: z
      .string()
      .min(1)
      .optional()
      .describe("Case-insensitive substring match on the line name or public code"),
    limit: limitField(),
    response_format: responseFormatField,
  })
  .strict();

export const findStopsSchema = z
  .object({
    operator_id: operatorIdField,
    query: z
      .string()
      .min(2)
      .optional()
      .describe(
        "Case-insensitive substring match on the stop name. Strongly recommended — a large " +
          "agency has thousands of stops",
      ),
    limit: limitField(),
    response_format: responseFormatField,
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Real-time                                                                   */
/* -------------------------------------------------------------------------- */

export const nextDeparturesSchema = z
  .object({
    operator_id: operatorIdField,
    stop_code: z
      .union([z.string().min(1), z.number().int()])
      .transform((value) => String(value).trim())
      .describe("Stop code from transit_find_stops. Codes are specific to one operator"),
    line: z
      .string()
      .min(1)
      .optional()
      .describe("Only departures on this line, matched against the line name or id"),
    limit: limitField(DEFAULT_DEPARTURE_LIMIT),
    response_format: responseFormatField,
  })
  .strict();

export const listVehiclesSchema = z
  .object({
    operator_id: operatorIdField,
    line: z.string().min(1).optional().describe("Only vehicles on this line"),
    limit: limitField(),
    response_format: responseFormatField,
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Alerts                                                                      */
/* -------------------------------------------------------------------------- */

export const listAlertsSchema = z
  .object({
    operator_id: operatorIdField
      .optional()
      .describe("Limit to one agency; omit for alerts across every Bay Area operator"),
    query: z
      .string()
      .min(2)
      .optional()
      .describe("Case-insensitive substring match on the alert headline or description"),
    active_only: z
      .boolean()
      .default(true)
      .describe("Only alerts whose active period covers now"),
    limit: limitField(),
    response_format: responseFormatField,
  })
  .strict();
