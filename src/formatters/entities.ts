/**
 * Per-entity markdown rendering.
 *
 * Every renderer tolerates missing fields. 511 aggregates 20+ independent
 * agency feeds, so a field one operator always populates may be absent from
 * another's entirely.
 */

import { ALERT_CAUSES, ALERT_EFFECTS, EPOCH_SENTINEL } from "../constants.js";
import { formatClock, formatCountdown, formatDate, minutesUntil } from "./response.js";
import type {
  AlertEntity,
  AlertTranslation,
  Line,
  MonitoredStopVisit,
  Operator,
  Stop,
  VehicleActivity,
} from "../types.js";

/** Treats 511's empty-string-as-null convention as absent. */
const present = (value: string | null | undefined): string | undefined => {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? undefined : trimmed;
};

/**
 * 511 emits coordinates as JSON strings and uses "" for absent. Coercing
 * blindly would turn a missing position into a valid-looking 0,0 off the coast
 * of Africa.
 */
const coord = (value: string | number | null | undefined): number | undefined => {
  const raw = present(typeof value === "number" ? String(value) : value);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** `VehicleAtStop` arrives as the string "false"/"true", never a real boolean. */
const isTrueish = (value: string | boolean | null | undefined): boolean =>
  value === true || (typeof value === "string" && value.toLowerCase() === "true");

export const formatOperator = (operator: Operator): string => {
  const facts = [`id: ${operator.Id ?? "?"}`];
  if (operator.PrimaryMode) facts.push(operator.PrimaryMode);
  // Unmonitored agencies have no real-time feed, only schedules.
  facts.push(operator.Monitored === false ? "schedule only" : "real-time");
  return `- **${operator.Name ?? operator.ShortName ?? "Unknown"}** _(${facts.join(" · ")})_`;
};

export const formatLine = (line: Line): string => {
  const facts = [`id: ${line.Id ?? "?"}`];
  if (line.TransportMode) facts.push(line.TransportMode);
  if (line.Monitored === false) facts.push("schedule only");
  const label = line.PublicCode && line.PublicCode !== line.Name ? `${line.PublicCode} — ` : "";
  return `- **${label}${line.Name ?? "Unnamed"}** _(${facts.join(" · ")})_`;
};

export const formatStop = (stop: Stop): string => {
  const facts = [`code: ${stop.id ?? "?"}`];
  const lat = coord(stop.Location?.Latitude);
  const lon = coord(stop.Location?.Longitude);
  if (lat !== undefined && lon !== undefined) facts.push(`${lat.toFixed(5)}, ${lon.toFixed(5)}`);
  return `- **${stop.Name ?? "Unnamed stop"}** _(${facts.join(" · ")})_`;
};

/**
 * Renders one upcoming departure.
 *
 * Arrival times carry the countdown rather than departure times: 511 populates
 * `ExpectedArrivalTime` reliably while `ExpectedDepartureTime` was null in
 * every sampled row, so keying off departures would show nothing at all.
 */
export const formatDeparture = (visit: MonitoredStopVisit, reference = new Date()): string => {
  const journey = visit.MonitoredVehicleJourney ?? {};
  const call = journey.MonitoredCall ?? {};

  const expected = present(call.ExpectedArrivalTime) ?? present(call.ExpectedDepartureTime);
  const aimed = present(call.AimedArrivalTime) ?? present(call.AimedDepartureTime);
  const line = present(journey.PublishedLineName) ?? present(journey.LineRef) ?? "?";
  const destination =
    present(journey.DestinationName) ?? present(call.DestinationDisplay) ?? "unknown destination";

  const facts: string[] = [];

  // Schedule adherence is only meaningful when both times are real.
  if (expected && aimed) {
    const drift = Math.round((new Date(expected).getTime() - new Date(aimed).getTime()) / 60_000);
    if (Number.isFinite(drift) && Math.abs(drift) >= 1) {
      facts.push(drift > 0 ? `${drift} min late` : `${Math.abs(drift)} min early`);
    } else {
      facts.push("on time");
    }
    facts.push(`sched ${formatClock(aimed)}`);
  } else if (!expected && aimed) {
    // No live prediction: this row is the timetable, not a real observation.
    facts.push("scheduled only, no live prediction");
  }

  if (isTrueish(call.VehicleAtStop)) facts.push("**at stop now**");
  // A null VehicleRef means the trip is scheduled but no vehicle is assigned.
  if (!present(journey.VehicleRef)) facts.push("no vehicle assigned yet");
  if (journey.Monitored === false) facts.push("not monitored");

  const countdown = formatCountdown(expected ?? aimed, reference);

  return (
    `- **${line}** → ${destination} — ${countdown}` +
    (facts.length > 0 ? `\n  _${facts.join(" · ")}_` : "")
  );
};

export const formatVehicle = (activity: VehicleActivity): string => {
  const journey = activity.MonitoredVehicleJourney ?? {};
  const lat = coord(journey.VehicleLocation?.Latitude);
  const lon = coord(journey.VehicleLocation?.Longitude);

  const facts: string[] = [];
  if (lat !== undefined && lon !== undefined) facts.push(`${lat.toFixed(5)}, ${lon.toFixed(5)}`);
  else facts.push("position unavailable");

  const bearing = coord(journey.Bearing);
  if (bearing !== undefined) facts.push(`bearing ${Math.round(bearing)}°`);
  if (present(journey.Occupancy)) facts.push(String(journey.Occupancy));

  // Epoch zero is 511's "scheduled but unassigned" sentinel, not a real time.
  const recorded = present(activity.RecordedAtTime);
  if (recorded && recorded !== EPOCH_SENTINEL) facts.push(`as of ${formatClock(recorded)}`);

  const line = present(journey.PublishedLineName) ?? present(journey.LineRef) ?? "?";
  const vehicle = present(journey.VehicleRef) ?? "unknown vehicle";

  return (
    `- **${line}** vehicle ${vehicle} → ${present(journey.DestinationName) ?? "unknown"}` +
    `\n  _${facts.join(" · ")}_`
  );
};

const firstTranslation = (translations: AlertTranslation[] | undefined): string | undefined => {
  const list = translations ?? [];
  const english = list.find((entry) => (entry.Language ?? "").toLowerCase().startsWith("en"));
  return present((english ?? list[0])?.Text);
};

/** Epoch SECONDS in this feed, unlike the ISO strings everywhere else in 511. */
const epochSeconds = (value: number | undefined): string =>
  value === undefined || value === 0
    ? "—"
    : `${formatDate(new Date(value * 1000).toISOString())} ${formatClock(new Date(value * 1000).toISOString())}`;

export const formatAlert = (entity: AlertEntity, detailed = false): string => {
  const alert = entity.Alert ?? {};
  const header = firstTranslation(alert.HeaderText?.Translations) ?? "Untitled alert";

  const facts: string[] = [];
  if (alert.effect !== undefined) facts.push(ALERT_EFFECTS[alert.effect] ?? `effect ${alert.effect}`);
  if (alert.cause !== undefined) facts.push(ALERT_CAUSES[alert.cause] ?? `cause ${alert.cause}`);

  const routes = (alert.InformedEntities ?? [])
    .map((informed) => present(informed.RouteId))
    .filter((route): route is string => Boolean(route));
  const uniqueRoutes = [...new Set(routes)];
  if (uniqueRoutes.length > 0) {
    facts.push(
      uniqueRoutes.length > 6
        ? `${uniqueRoutes.length} routes affected`
        : `routes: ${uniqueRoutes.join(", ")}`,
    );
  }

  const lines = [`### ${header}`, `_${facts.join(" · ") || "no classification"}_`];

  const period = (alert.ActivePeriods ?? [])[0];
  if (period?.Start) {
    lines.push(`**Active:** ${epochSeconds(period.Start)} → ${period.End ? epochSeconds(period.End) : "ongoing"}`);
  }

  if (detailed) {
    const description = firstTranslation(alert.DescriptionText?.Translations);
    if (description) lines.push("", description);
    const url = firstTranslation(alert.Url?.Translations);
    if (url) lines.push("", `**More:** ${url}`);
  }

  return lines.join("\n");
};

export { minutesUntil };
