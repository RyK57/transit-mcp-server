/**
 * Interfaces for the 511 entities this server renders.
 *
 * Every field is optional. 511 aggregates feeds from more than two dozen
 * independent agencies whose data quality varies widely, so only `LineRef`,
 * `StopPointRef`, `StopPointName` and the `Aimed*` times can be relied on to
 * be present at all.
 *
 * Several fields are typed as strings where a number or boolean would be
 * expected. That is not an oversight — it is what the live API emits.
 */

/* -------------------------------------------------------------------------- */
/* Static / reference data                                                     */
/* -------------------------------------------------------------------------- */

export interface Operator {
  Id?: string;
  Name?: string;
  ShortName?: string;
  SiriOperatorRef?: string;
  Monitored?: boolean;
  TimeZone?: string;
  PrimaryMode?: string;
}

export interface Line {
  Id?: string;
  Name?: string;
  PublicCode?: string;
  TransportMode?: string;
  OperatorRef?: string;
  Monitored?: boolean;
}

/** 511 nests stop coordinates under NeTEx-style Location. */
export interface StopLocation {
  Longitude?: string | number;
  Latitude?: string | number;
}

export interface Stop {
  id?: string;
  Name?: string;
  Location?: StopLocation;
  StopType?: string;
  Url?: string;
}

/* -------------------------------------------------------------------------- */
/* Real-time (SIRI)                                                            */
/* -------------------------------------------------------------------------- */

export interface MonitoredCall {
  StopPointRef?: string;
  StopPointName?: string;
  DestinationDisplay?: string;
  AimedArrivalTime?: string | null;
  /** The dependable live prediction — this is what a countdown should use. */
  ExpectedArrivalTime?: string | null;
  AimedDepartureTime?: string | null;
  /**
   * Observed null in every sampled row. Present in the spec, absent in
   * practice, so arrival times carry the countdown instead.
   */
  ExpectedDepartureTime?: string | null;
  /** A stringified boolean — "false" or "" — never a real boolean. */
  VehicleAtStop?: string;
  /** Always an empty string live, despite the spec typing it as an object. */
  VehicleLocationAtStop?: string;
}

export interface VehicleLocation {
  /** Emitted as JSON strings, and "" stands in for absent. */
  Longitude?: string;
  Latitude?: string;
}

export interface MonitoredVehicleJourney {
  LineRef?: string;
  DirectionRef?: string;
  PublishedLineName?: string;
  OperatorRef?: string;
  OriginRef?: string;
  OriginName?: string;
  DestinationRef?: string;
  DestinationName?: string;
  Monitored?: boolean;
  VehicleLocation?: VehicleLocation;
  /** String, not number. */
  Bearing?: string | null;
  Occupancy?: string | null;
  /** Null until a vehicle is actually assigned to the trip. */
  VehicleRef?: string | null;
  MonitoredCall?: MonitoredCall;
}

export interface MonitoredStopVisit {
  /**
   * Can be the epoch-zero sentinel "1970-01-01T00:00:00Z" for a scheduled but
   * unassigned trip. Rendering it literally would claim the data was recorded
   * in 1970.
   */
  RecordedAtTime?: string;
  MonitoringRef?: string;
  MonitoredVehicleJourney?: MonitoredVehicleJourney;
}

/**
 * StopMonitoring's envelope. Note there is NO `Siri` root wrapper here, unlike
 * VehicleMonitoring — the published spec shows one for both, but the live API
 * omits it for this endpoint.
 */
export interface StopMonitoringResponse {
  ServiceDelivery?: {
    ResponseTimestamp?: string;
    ProducerRef?: string;
    Status?: boolean;
    StopMonitoringDelivery?: {
      version?: string;
      ResponseTimestamp?: string;
      MonitoredStopVisit?: MonitoredStopVisit[];
    };
  };
}

export interface VehicleActivity {
  RecordedAtTime?: string;
  ValidUntilTime?: string;
  MonitoredVehicleJourney?: MonitoredVehicleJourney;
}

/** VehicleMonitoring DOES carry the `Siri` wrapper that StopMonitoring lacks. */
export interface VehicleMonitoringResponse {
  Siri?: {
    ServiceDelivery?: {
      ResponseTimestamp?: string;
      VehicleMonitoringDelivery?: {
        version?: string;
        ResponseTimestamp?: string;
        VehicleActivity?: VehicleActivity[];
      };
    };
  };
}

/* -------------------------------------------------------------------------- */
/* Service alerts (GTFS-Realtime rendered as PascalCase JSON)                   */
/* -------------------------------------------------------------------------- */

export interface AlertTranslation {
  Text?: string;
  Language?: string;
}

export interface InformedEntity {
  AgencyId?: string;
  RouteId?: string;
  RouteType?: number;
  StopId?: string;
  Trip?: unknown;
}

export interface ActivePeriod {
  /** Epoch SECONDS, not milliseconds, and not an ISO string. */
  Start?: number;
  End?: number;
}

export interface Alert {
  ActivePeriods?: ActivePeriod[];
  InformedEntities?: InformedEntity[];
  /** Lowercase, and integers in the JSON rendering where XML uses enum names. */
  cause?: number;
  effect?: number;
  HeaderText?: { Translations?: AlertTranslation[] };
  DescriptionText?: { Translations?: AlertTranslation[] };
  Url?: { Translations?: AlertTranslation[] };
}

export interface AlertEntity {
  Id?: string;
  Alert?: Alert;
  TripUpdate?: unknown;
  Vehicle?: unknown;
}

export interface ServiceAlertsResponse {
  Header?: {
    GtfsRealtimeVersion?: string;
    incrementality?: number | string;
    /** Epoch seconds. */
    Timestamp?: number;
  };
  Entities?: AlertEntity[];
}
