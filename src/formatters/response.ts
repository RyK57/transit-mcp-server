/**
 * Shared response construction: result limiting, character-limit truncation,
 * time rendering, and the markdown primitives every formatter reuses.
 *
 * Unlike a paginated API, 511 returns complete collections — every operator,
 * every stop on an agency — so there is no page cursor to thread. What the
 * tools expose instead is a client-side `limit`, and every truncation says
 * plainly how much was withheld rather than implying the list simply ended.
 */

import { BAY_AREA_TIMEZONE, CHARACTER_LIMIT } from "../constants.js";
import { describeError } from "../services/transit-client.js";

export const RESPONSE_FORMATS = ["markdown", "json"] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

/**
 * Shape returned by every tool handler.
 * The index signature is required to satisfy the SDK's `CallToolResult`.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ResultMeta {
  count: number;
  total: number;
  truncated: boolean;
}

/**
 * Applies the caller's limit and records what was dropped. A silently trimmed
 * list reads as "that is everything", which for transit data is actively
 * misleading — an agency can have thousands of stops.
 */
export const limitResults = <T>(items: T[], limit: number): { items: T[]; meta: ResultMeta } => ({
  items: items.slice(0, limit),
  meta: { count: Math.min(items.length, limit), total: items.length, truncated: items.length > limit },
});

export const truncationFooter = (meta: ResultMeta, remedy: string): string =>
  meta.truncated
    ? `\n_Showing ${meta.count} of ${meta.total}. ${remedy}_`
    : `\n_${meta.total} result(s) — complete list._`;

const clockFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BAY_AREA_TIMEZONE,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BAY_AREA_TIMEZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
});

/**
 * Renders a timestamp as Bay Area wall-clock time. 511 returns UTC, but a
 * rider reasons in Pacific, and the gap is either 7 or 8 hours depending on
 * daylight saving — so the conversion is done here rather than left to the
 * model to get wrong twice a year.
 */
export const formatClock = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return clockFormatter.format(date);
};

export const formatDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return dateFormatter.format(date);
};

/** Whole minutes from `reference` until `iso`; negative once it is in the past. */
export const minutesUntil = (iso: string | null | undefined, reference = new Date()): number | null => {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return Math.round((date.getTime() - reference.getTime()) / 60_000);
};

/**
 * The rider-facing rendering of a departure: minutes away first, because that
 * is what decides whether you run for it, with clock time for confirmation.
 */
export const formatCountdown = (iso: string | null | undefined, reference = new Date()): string => {
  const minutes = minutesUntil(iso, reference);
  if (minutes === null) return "no prediction";
  const clock = formatClock(iso);
  if (minutes < 0) return `departed ${Math.abs(minutes)} min ago (${clock})`;
  if (minutes === 0) return `now (${clock})`;
  if (minutes === 1) return `1 min (${clock})`;
  return `${minutes} min (${clock})`;
};

/**
 * Truncates oversized markdown so a single tool call cannot blow out the
 * agent's context, and says explicitly how to get the rest.
 */
const truncateText = (text: string, remedy: string): string => {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    `${text.slice(0, CHARACTER_LIMIT)}\n\n` +
    `_[Truncated at ${CHARACTER_LIMIT} characters. ${remedy}]_`
  );
};

/**
 * Assembles the final tool result in the requested format.
 * `structured` is always attached so clients that consume structuredContent
 * get the full, untruncated data regardless of the text rendering.
 */
export const toolResult = (
  format: ResponseFormat,
  structured: Record<string, unknown>,
  markdown: () => string,
  remedy = "Lower `limit` or narrow your filters to see the rest.",
): ToolResult => {
  const text =
    format === "json"
      ? truncateText(JSON.stringify(structured, null, 2), remedy)
      : truncateText(markdown(), remedy);

  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
};

/** Wraps a tool handler so every thrown error becomes actionable agent-facing text. */
export const withErrorHandling = <TArgs>(
  handler: (args: TArgs) => Promise<ToolResult>,
): ((args: TArgs) => Promise<ToolResult>) => {
  return async (args: TArgs): Promise<ToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      return {
        content: [{ type: "text", text: describeError(error) }],
        isError: true,
      };
    }
  };
};

/** Standard empty-result response with guidance on what to try instead. */
export const emptyResult = (message: string, structured: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: message }],
  structuredContent: structured,
});
