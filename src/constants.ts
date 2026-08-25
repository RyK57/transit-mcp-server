/**
 * Shared constants for the 511 Bay Area transit MCP server.
 */

export const SERVER_NAME = "transit-mcp-server";
export const SERVER_VERSION = "1.0.0";

export const DEFAULT_API_BASE_URL = "https://api.511.org";
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Every 511 timestamp is UTC; riders reason in Pacific. */
export const BAY_AREA_TIMEZONE = "America/Los_Angeles";

/** Maximum characters returned by any single tool call before truncation kicks in. */
export const CHARACTER_LIMIT = 25_000;

/**
 * 511 does not paginate — it returns whole collections, and a large agency has
 * thousands of stops. These bound what one call can return so a single tool
 * result cannot swamp an agent's context.
 */
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;

/** Departures further out than this are rarely actionable for a rider. */
export const DEFAULT_DEPARTURE_LIMIT = 10;

/**
 * 511 allows 60 requests per hour per key, shared across every endpoint.
 * Quoted in tool descriptions so an agent knows not to poll or fan out.
 */
export const RATE_LIMIT_PER_HOUR = 60;

/**
 * GTFS-Realtime enums. 511's JSON rendering emits these as bare integers
 * (`"effect": 8`) where the XML rendering uses names, so they are mapped back
 * to words here rather than surfacing a number nobody can interpret.
 */
export const ALERT_CAUSES: Record<number, string> = {
  1: "unknown cause",
  2: "other cause",
  3: "technical problem",
  4: "strike",
  5: "demonstration",
  6: "accident",
  7: "holiday",
  8: "weather",
  9: "maintenance",
  10: "construction",
  11: "police activity",
  12: "medical emergency",
};

export const ALERT_EFFECTS: Record<number, string> = {
  1: "no service",
  2: "reduced service",
  3: "significant delays",
  4: "detour",
  5: "additional service",
  6: "modified service",
  7: "other effect",
  8: "unknown effect",
  9: "stop moved",
  10: "no effect",
  11: "accessibility issue",
};

/**
 * StopMonitoring's RecordedAtTime carries this sentinel for a trip that is
 * scheduled but has no vehicle assigned yet.
 */
export const EPOCH_SENTINEL = "1970-01-01T00:00:00Z";

/**
 * 511-internal pseudo-agencies (511 Emergency, Flap Sign, Operations, Staff).
 * They appear in the operator list with no service data and only confuse a
 * rider looking for a real agency.
 */
export const INTERNAL_OPERATOR_IDS = new Set(["5E", "5F", "5O", "5S"]);

/**
 * Codes that are easy to guess wrong. Surfaced in tool output so an agent
 * reaching for the obvious abbreviation is corrected rather than 404'd.
 */
export const OPERATOR_CODE_HINTS: Record<string, string> = {
  VTA: "SC",
  VT: "SC",
  CAPITOL: "AM",
  MUNI: "SF",
  SFMTA: "SF",
  BART: "BA",
  CALTRAIN: "CT",
};
