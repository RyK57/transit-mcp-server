/**
 * Thin functional wrapper over the 511.org SF Bay Open Data API.
 *
 * Uses the global fetch available in Node 18+ so the server ships with no HTTP
 * dependency. Three 511 behaviours shape this module:
 *
 *   - The API key travels as an `api_key` QUERY parameter, not a header. This
 *     was confirmed against the live API: `api_key` yields "This API key
 *     provided is invalid", while `apikey` and `token` yield "The API key is
 *     not provided".
 *   - `format=json` is appended to every request. Every published 511 spec says
 *     JSON is already the default, but a widely repeated claim says otherwise and
 *     the GTFS-Realtime endpoints genuinely default to protobuf, so the parameter
 *     is sent explicitly rather than trusted.
 *   - JSON bodies are widely reported to carry a UTF-8 byte order mark, which
 *     makes a naive JSON.parse throw on a perfectly valid payload. The BOM is
 *     stripped defensively before parsing.
 *
 * Auth failures come back as plain text rather than JSON, so error extraction
 * cannot assume a parseable body.
 */

import { DEFAULT_API_BASE_URL, DEFAULT_TIMEOUT_MS } from "../constants.js";

/**
 * The rolling-hour quota 511 reports on every successful response. Exposed so
 * tools can tell a user how much budget is left rather than discovering the
 * ceiling by hitting a 429.
 */
export const rateLimit: { limit: number | null; remaining: number | null } = {
  limit: null,
  remaining: null,
};

export interface TransitClientConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

/** Query values 511 accepts. Arrays become comma-joined, which is 511's form. */
export type QueryValue = string | number | boolean | string[] | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
}

/**
 * Error carrying the HTTP status so callers can produce status-specific,
 * actionable guidance instead of a generic failure string.
 *
 * Built with a factory rather than a subclass: it is a real Error (so stack
 * traces and `instanceof Error` still work) with the extra fields attached.
 */
export interface TransitApiError extends Error {
  readonly isTransitApiError: true;
  readonly status: number;
  readonly endpoint: string;
  readonly detail: string | undefined;
}

export const transitApiError = (
  status: number,
  endpoint: string,
  detail?: string,
): TransitApiError =>
  Object.assign(new Error(`511 API ${status} on ${endpoint}${detail ? `: ${detail}` : ""}`), {
    name: "TransitApiError",
    isTransitApiError: true as const,
    status,
    endpoint,
    detail,
  });

export const isTransitApiError = (error: unknown): error is TransitApiError =>
  typeof error === "object" &&
  error !== null &&
  (error as Partial<TransitApiError>).isTransitApiError === true;

/**
 * Reads configuration from the environment and fails fast with setup
 * instructions when the API key is missing.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): TransitClientConfig => {
  const apiKey = env.TRANSIT_511_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "TRANSIT_511_API_KEY is not set. Request a free token at " +
        "https://511.org/open-data/token and expose it to this server, e.g. " +
        'via the "env" block of your MCP client config.',
    );
  }

  const timeoutRaw = Number(env.TRANSIT_511_REQUEST_TIMEOUT_MS);

  return {
    apiKey,
    baseUrl: (env.TRANSIT_511_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, ""),
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS,
  };
};

/**
 * Builds a request URL, attaching the credentials and format every 511 call
 * needs. Neither is a tool-level concern, so no schema exposes them.
 */
const buildUrl = (
  config: TransitClientConfig,
  path: string,
  query?: Record<string, QueryValue>,
): string => {
  const url = new URL(`${config.baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  url.searchParams.set("api_key", config.apiKey);
  // Documented as the default, but sent explicitly: the servicealerts feed
  // genuinely defaults to protobuf, which nothing downstream can read.
  url.searchParams.set("format", "json");
  return url.toString();
};

/** Removes a UTF-8 byte order mark, which 511 prepends to JSON bodies. */
export const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

/**
 * Pulls the most useful message out of a 511 error body. Auth failures are
 * plain text; other failures may be JSON, so both are handled.
 */
const extractErrorDetail = (raw: string): string | undefined => {
  const text = stripBom(raw).trim();
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["message", "Message", "error", "detail"]) {
        const value = record[key];
        if (typeof value === "string") return value;
      }
    }
  } catch {
    // Body was not JSON — 511 returns bare text for auth failures.
  }
  return text.slice(0, 300);
};

/**
 * Performs an authenticated request and returns the parsed JSON body.
 * Endpoints that return an empty body resolve to `undefined`.
 */
export const request = async <T>(
  config: TransitClientConfig,
  path: string,
  options: RequestOptions = {},
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(buildUrl(config, path, options.query), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });

    const limitHeader = Number(response.headers.get("ratelimit-limit"));
    const remainingHeader = Number(response.headers.get("ratelimit-remaining"));
    if (Number.isFinite(limitHeader) && response.headers.get("ratelimit-limit")) {
      rateLimit.limit = limitHeader;
    }
    if (Number.isFinite(remainingHeader) && response.headers.get("ratelimit-remaining")) {
      rateLimit.remaining = remainingHeader;
    }

    const text = await response.text();

    if (!response.ok) {
      throw transitApiError(response.status, `GET ${path}`, extractErrorDetail(text));
    }

    const body = stripBom(text);
    if (!body.trim()) return undefined as T;

    try {
      return JSON.parse(body) as T;
    } catch {
      throw transitApiError(
        response.status,
        `GET ${path}`,
        "Response was not valid JSON. 511 returns XML unless format=json is sent, " +
          "and prefixes JSON with a byte order mark — both are handled here, so this " +
          "likely means the endpoint returned something unexpected.",
      );
    }
  } catch (error) {
    if (isTransitApiError(error)) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw transitApiError(408, `GET ${path}`, `Request timed out after ${config.timeoutMs}ms`);
    }
    throw transitApiError(
      0,
      `GET ${path}`,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Converts any thrown error into a message that tells the agent what to do
 * next, rather than just what went wrong.
 */
export const describeError = (error: unknown): string => {
  if (isTransitApiError(error)) {
    const detail = error.detail ?? "";

    switch (error.status) {
      case 400:
        return (
          `Error: 511 rejected the request (400) on ${error.endpoint}. ${detail} ` +
          "Common causes: an unknown operator code — list valid ones with " +
          "transit_list_operators — or a stop code that does not belong to that operator."
        );
      case 401:
        // 511 distinguishes these two cases in plain text; pass the distinction on.
        return detail.toLowerCase().includes("not provided")
          ? `Error: 511 received no API key on ${error.endpoint}. TRANSIT_511_API_KEY is set but did not reach the request — this is a server configuration problem, not a bad key.`
          : `Error: 511 rejected the API key (401) on ${error.endpoint}. ${detail} Request a new token at https://511.org/open-data/token, and note that tokens can take a few minutes to activate after they are issued.`;
      case 404:
        return (
          `Error: Not found (404) on ${error.endpoint}. ${detail} ` +
          "Check the operator code with transit_list_operators and the stop code with " +
          "transit_find_stops — stop codes are operator-specific and are not interchangeable."
        );
      case 408:
        return `Error: ${detail || "Request timed out."} Retry, or lower \`limit\` to reduce the response size.`;
      case 429:
        return (
          `Error: 511 rate limit exceeded on ${error.endpoint}. ${detail} ` +
          "This API is quota-limited per key over a rolling window. Wait before retrying, " +
          "and prefer one broad call over repeated narrow ones — do not poll in a loop."
        );
      case 0:
        return (
          `Error: Could not reach 511 at ${error.endpoint}. ${detail} ` +
          "Check network access to api.511.org."
        ).trim();
      default:
        return `Error: 511 returned ${error.status} on ${error.endpoint}. ${detail}`.trim();
    }
  }

  return `Error: ${error instanceof Error ? error.message : String(error)}`;
};
