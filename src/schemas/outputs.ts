/**
 * Output schemas describing the `structuredContent` each tool returns.
 *
 * These are deliberately permissive (`passthrough`, optional fields). 511
 * aggregates feeds from more than two dozen independent agencies, and the
 * fields each one populates vary — a strict schema would turn one agency's
 * sparse feed into a hard tool failure for every rider using it.
 */

import { z } from "zod";

const loose = z.object({}).passthrough();

const resultShape = {
  count: z.number(),
  total: z.number(),
  truncated: z.boolean(),
};

/** List response: result metadata plus an array under a named key. */
export const listOutput = (key: string) =>
  z.object({ ...resultShape, [key]: z.array(loose) }).passthrough();

export const singleOutput = (key: string) =>
  z.object({ [key]: loose.nullable() }).passthrough();

export const departuresOutput = z
  .object({
    ...resultShape,
    operator: z.string().nullable().optional(),
    stop_code: z.string().nullable().optional(),
    stop_name: z.string().nullable().optional(),
    retrieved_at: z.string().nullable().optional(),
    departures: z.array(loose),
  })
  .passthrough();
