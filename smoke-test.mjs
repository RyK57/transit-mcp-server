/**
 * Smoke test: drives the built server over stdio with a real JSON-RPC handshake,
 * pointed at a local mock of the 511 API so no key or network is needed.
 *
 * The mock deliberately reproduces 511's real quirks — the BOM, the missing
 * Siri wrapper on StopMonitoring, stringified booleans and coordinates, the
 * epoch-zero sentinel, and plain-text error bodies — because those are exactly
 * what a naive client gets wrong.
 */

import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = 8789;
const KEY = "test-key-0000";

// --- Mock 511 API ------------------------------------------------------------
const operators = [
  { Id: "BA", Name: "Bay Area Rapid Transit", ShortName: "BART", PrimaryMode: "rail", Monitored: true, TimeZone: "America/Vancouver", OtherModes: "" },
  { Id: "SF", Name: "San Francisco Municipal Transportation Agency", ShortName: "Muni", PrimaryMode: "bus", Monitored: true, TimeZone: "America/Vancouver", OtherModes: "metro,cableway" },
  { Id: "RV", Name: "Rio Vista Delta Breeze", PrimaryMode: "bus", Monitored: false, TimeZone: "America/Vancouver", OtherModes: "" },
  // 511-internal pseudo-agencies that must never reach the user.
  { Id: "5E", Name: "511 Emergency", PrimaryMode: "other", Monitored: false, TimeZone: "America/Vancouver", OtherModes: "" },
  { Id: "5S", Name: "511 Staff", PrimaryMode: "other", Monitored: false, TimeZone: "America/Vancouver", OtherModes: "" },
];

const lines = [
  { Id: "N", Name: "JUDAH", PublicCode: "N", TransportMode: "metro", Monitored: true, OperatorRef: "SF", FromDate: "2026-05-15T00:00:00-07:00" },
  { Id: "38", Name: "GEARY", PublicCode: "38", TransportMode: "bus", Monitored: true, OperatorRef: "SF" },
];

// Stops are nested under NeTEx containers, unlike operators and lines.
const stopsPayload = {
  Contents: {
    ResponseTimestamp: "2026-08-25T00:00:00Z",
    dataObjects: {
      id: "SF",
      ScheduledStopPoint: [
        { id: "17872", Name: "4th & Brannan Southbound", Location: { Longitude: "-122.396613", Latitude: "37.778341" }, StopType: "onstreetBus" },
        { id: "13220", Name: "Judah St & 9th Ave", Location: { Longitude: "-122.466179", Latitude: "37.760780" }, StopType: "onstreetBus" },
        { id: "99999", Name: "Powell St Cable Car Turnaround", Location: { Longitude: "", Latitude: "" }, StopType: "onstreetBus" },
      ],
    },
  },
};

const inMin = (m) => new Date(Date.now() + m * 60_000).toISOString().replace(/\.\d+Z$/, "Z");

// NOTE: no `Siri` wrapper here — that is the real shape, and the spec is wrong.
const stopMonitoring = {
  ServiceDelivery: {
    ResponseTimestamp: inMin(0),
    ProducerRef: "SF",
    Status: true,
    StopMonitoringDelivery: {
      version: "1.4",
      ResponseTimestamp: inMin(0),
      MonitoredStopVisit: [
        {
          RecordedAtTime: inMin(0),
          MonitoringRef: "13220",
          MonitoredVehicleJourney: {
            LineRef: "N", PublishedLineName: "N", DirectionRef: "IB", OperatorRef: "SF",
            DestinationName: "Ocean Beach", Monitored: true,
            VehicleLocation: { Longitude: "-122.46", Latitude: "37.76" },
            Bearing: "270.0000000000", Occupancy: null, VehicleRef: "1234",
            MonitoredCall: {
              StopPointRef: "13220", StopPointName: "Judah St & 9th Ave",
              AimedArrivalTime: inMin(9), ExpectedArrivalTime: inMin(12),
              AimedDepartureTime: inMin(9),
              ExpectedDepartureTime: null,      // null in every real row
              VehicleAtStop: "false",           // stringified boolean
              VehicleLocationAtStop: "",
            },
          },
        },
        {
          // Scheduled but unassigned: epoch sentinel, null vehicle, empty coords.
          RecordedAtTime: "1970-01-01T00:00:00Z",
          MonitoringRef: "13220",
          MonitoredVehicleJourney: {
            LineRef: "N", PublishedLineName: "N", OperatorRef: "SF",
            DestinationName: "Ocean Beach", Monitored: true,
            VehicleLocation: { Longitude: "", Latitude: "" },
            Bearing: null, Occupancy: null, VehicleRef: null,
            MonitoredCall: {
              StopPointRef: "13220", StopPointName: "Judah St & 9th Ave",
              AimedArrivalTime: inMin(24), ExpectedArrivalTime: null,
              AimedDepartureTime: inMin(24), ExpectedDepartureTime: null,
              VehicleAtStop: "", VehicleLocationAtStop: "",
            },
          },
        },
        {
          RecordedAtTime: inMin(0),
          MonitoringRef: "13220",
          MonitoredVehicleJourney: {
            LineRef: "38", PublishedLineName: "38", OperatorRef: "SF",
            DestinationName: "Point Lobos", Monitored: true, VehicleRef: "5678",
            MonitoredCall: {
              StopPointRef: "13220", StopPointName: "Judah St & 9th Ave",
              AimedArrivalTime: inMin(3), ExpectedArrivalTime: inMin(3),
              AimedDepartureTime: inMin(3), ExpectedDepartureTime: null,
              VehicleAtStop: "true", VehicleLocationAtStop: "",
            },
          },
        },
      ],
    },
  },
};

// VehicleMonitoring DOES have the Siri wrapper that StopMonitoring lacks.
const vehicleMonitoring = {
  Siri: {
    ServiceDelivery: {
      ResponseTimestamp: inMin(0),
      VehicleMonitoringDelivery: {
        version: "1.4",
        VehicleActivity: [
          { RecordedAtTime: inMin(0), MonitoredVehicleJourney: { LineRef: "N", PublishedLineName: "N", DestinationName: "Ocean Beach", VehicleRef: "1234", VehicleLocation: { Longitude: "-122.46", Latitude: "37.76" }, Bearing: "270.0" } },
          { RecordedAtTime: inMin(0), MonitoredVehicleJourney: { LineRef: "38", PublishedLineName: "38", DestinationName: "Point Lobos", VehicleRef: "5678", VehicleLocation: { Longitude: "", Latitude: "" }, Bearing: null } },
        ],
      },
    },
  },
};

const nowSec = Math.floor(Date.now() / 1000);
const serviceAlerts = {
  Header: { GtfsRealtimeVersion: "2.0", incrementality: 0, Timestamp: nowSec },
  Entities: [
    {
      Id: "alert-1",
      Alert: {
        ActivePeriods: [{ Start: nowSec - 3600, End: nowSec + 3600 }],
        InformedEntities: [{ AgencyId: "BA", RouteId: "Red" }, { AgencyId: "BA", RouteId: "Yellow" }],
        cause: 8, effect: 3,
        HeaderText: { Translations: [{ Text: "Major delays on the Red Line", Language: "en" }] },
        DescriptionText: { Translations: [{ Text: "Delays of up to 20 minutes due to weather.", Language: "en" }] },
        Url: { Translations: [{ Text: "https://bart.gov/alert/1", Language: "en" }] },
      },
    },
    {
      Id: "alert-2",
      Alert: {
        ActivePeriods: [{ Start: nowSec + 86_400 * 7, End: nowSec + 86_400 * 8 }],
        InformedEntities: [{ AgencyId: "SF", RouteId: "N" }],
        cause: 10, effect: 4,
        HeaderText: { Translations: [{ Text: "Weekend track work on the N Judah", Language: "en" }] },
        DescriptionText: { Translations: [{ Text: "Bus substitution in effect.", Language: "en" }] },
      },
    },
  ],
};

const requestLog = [];
const BOM = "﻿";

const mock = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  requestLog.push({ path: url.pathname, params: url.searchParams });

  // Auth failures are plain text, not JSON, and carry no BOM.
  const sendText = (code, body) => {
    res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
    res.end(body);
  };
  // Success bodies are JSON prefixed with a UTF-8 BOM.
  const sendJson = (payload) => {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "ratelimit-limit": "60",
      "ratelimit-remaining": "57",
    });
    res.end(BOM + JSON.stringify(payload));
  };

  const key = url.searchParams.get("api_key");
  if (!key) return sendText(401, "The API key is not provided.");
  if (key !== KEY) return sendText(401, "This API key provided is invalid.");

  const p = url.pathname;
  const operator = (url.searchParams.get("operator_id") ?? url.searchParams.get("agency") ?? "").toUpperCase();

  if (p === "/transit/operators") return sendJson(operators);
  if (p === "/transit/lines") {
    if (operator !== "SF") return sendText(404, "Operator not found.");
    return sendJson(lines);
  }
  if (p === "/transit/stops") {
    if (operator !== "SF") return sendText(404, "Operator not found.");
    return sendJson(stopsPayload);
  }
  if (p === "/transit/StopMonitoring") {
    if (url.searchParams.get("stopCode") === "00000") return sendJson({ ServiceDelivery: { StopMonitoringDelivery: { MonitoredStopVisit: [] } } });
    if (url.searchParams.get("stopCode") === "429") return sendText(429, "Rate limit exceeded.");
    return sendJson(stopMonitoring);
  }
  if (p === "/transit/VehicleMonitoring") return sendJson(vehicleMonitoring);
  if (p === "/transit/servicealerts") return sendJson(serviceAlerts);

  return sendText(404, `No mock for ${p}`);
});

await new Promise((r) => mock.listen(PORT, "127.0.0.1", r));

// --- Drive the server over stdio --------------------------------------------
const child = spawn("node", ["dist/index.js"], {
  cwd: REPO_ROOT,
  env: { ...process.env, TRANSIT_511_API_KEY: KEY, TRANSIT_511_BASE_URL: `http://localhost:${PORT}` },
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let nextId = 1;
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => reject(new Error(`timeout on ${method}`)), 15000);
  });

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-test", version: "1.0.0" } });
check("initialize handshake", init.result?.serverInfo?.name === "transit-mcp-server", init.result?.serverInfo?.name);
check("server sends instructions", typeof init.result?.instructions === "string" && init.result.instructions.length > 50);
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const list = await rpc("tools/list", {});
const tools = list.result?.tools ?? [];
check("tools/list returns tools", tools.length === 6, `${tools.length} tools`);
check("all tools prefixed transit_", tools.every((t) => t.name.startsWith("transit_")));
check("all tools have descriptions", tools.every((t) => (t.description ?? "").length > 100));
check("all tools have annotations", tools.every((t) => t.annotations && "readOnlyHint" in t.annotations));
check("all tools have output schemas", tools.every((t) => t.outputSchema?.type === "object"));
check("every tool is read-only", tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false));

const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result ?? {};

// --- Auth, BOM, format -------------------------------------------------------
const ops = await call("transit_list_operators", {});
check("BOM-prefixed JSON parses", ops.structuredContent?.operators?.length > 0, "UTF-8 BOM stripped");
check("api_key sent as query param", requestLog.every((r) => r.params.get("api_key") === KEY));
check("format=json always sent", requestLog.every((r) => r.params.get("format") === "json"));

// --- Operator handling -------------------------------------------------------
check("511-internal agencies filtered out", !ops.content[0].text.includes("511 Emergency") && !ops.content[0].text.includes("511 Staff"), "5E/5S hidden");
check("real agencies retained", ops.content[0].text.includes("BART") || ops.content[0].text.includes("Bay Area Rapid Transit"));
check("schedule-only agencies flagged", ops.content[0].text.includes("schedule only"), "Rio Vista");
check("operator code traps surfaced", ops.content[0].text.includes("VTA is `SC`"));
check("remaining quota reported", ops.content[0].text.includes("57 of 60"), "from RateLimit headers");
const monitored = await call("transit_list_operators", { monitored_only: true });
check("monitored_only filters", !monitored.content[0].text.includes("Rio Vista"));

// --- Static endpoints use operator_id ----------------------------------------
await call("transit_list_lines", { operator_id: "sf" });
const linesReq = requestLog.filter((r) => r.path === "/transit/lines").at(-1);
check("static endpoints send operator_id", linesReq.params.get("operator_id") === "SF", "and lowercase input normalised");

// --- Stops: nested envelope + string coords ----------------------------------
const stops = await call("transit_find_stops", { operator_id: "SF", query: "judah" });
check("nested NeTEx stop envelope unwrapped", stops.structuredContent?.count === 1, "Contents.dataObjects.ScheduledStopPoint");
check("string coordinates parsed", stops.content[0].text.includes("37.76078"));
const allStops = await call("transit_find_stops", { operator_id: "SF" });
check("empty coords do not render as 0,0", !allStops.content[0].text.includes("0.00000, 0.00000"), "Powell St has blank coords");

// --- Real-time: agency param, no Siri wrapper --------------------------------
const dep = await call("transit_next_departures", { operator_id: "SF", stop_code: "13220" });
const depReq = requestLog.filter((r) => r.path === "/transit/StopMonitoring").at(-1);
check("real-time endpoints send agency not operator_id", depReq.params.get("agency") === "SF" && !depReq.params.get("operator_id"));
check("StopMonitoring parsed without Siri wrapper", dep.structuredContent?.count === 3, `${dep.structuredContent?.count} departures`);
check("departures sorted soonest first", dep.structuredContent?.departures?.[0]?.line === "38", "38 at 3 min before N at 12");
check("countdown uses ExpectedArrivalTime", dep.content[0].text.includes("12 min"), "ExpectedDepartureTime is always null");
check("stringified VehicleAtStop honoured", dep.content[0].text.includes("at stop now") && dep.structuredContent.departures[0].at_stop === true);
check("schedule drift computed", dep.content[0].text.includes("3 min late"));
check("unassigned trips flagged", dep.content[0].text.includes("no vehicle assigned yet"));
check("epoch sentinel not rendered as 1970", !dep.content[0].text.includes("1970"));
check("scheduled-only rows labelled", dep.content[0].text.includes("scheduled only, no live prediction"));

const filtered = await call("transit_next_departures", { operator_id: "SF", stop_code: "13220", line: "N" });
check("line filter applied", filtered.structuredContent?.count === 2);
const noDep = await call("transit_next_departures", { operator_id: "SF", stop_code: "00000" });
check("empty departures explain terminals", noDep.content[0].text.includes("final stop"));

// --- Vehicles: Siri wrapper IS present ---------------------------------------
const veh = await call("transit_list_vehicles", { operator_id: "SF" });
check("VehicleMonitoring parsed WITH Siri wrapper", veh.structuredContent?.count === 2);
check("missing vehicle position handled", veh.content[0].text.includes("position unavailable"));

// --- Alerts ------------------------------------------------------------------
const alerts = await call("transit_list_service_alerts", {});
check("active alerts returned", alerts.structuredContent?.count === 1, "future track work excluded");
check("GTFS-RT effect enum decoded", alerts.content[0].text.includes("significant delays"), "effect 3");
check("GTFS-RT cause enum decoded", alerts.content[0].text.includes("weather"), "cause 8");
check("epoch-seconds period rendered", !alerts.content[0].text.includes("1970") && alerts.content[0].text.includes("Active:"));
const allAlerts = await call("transit_list_service_alerts", { active_only: false });
check("active_only=false surfaces planned work", allAlerts.structuredContent?.count === 2);
const noAlerts = await call("transit_list_service_alerts", { query: "zzzznotfound" });
check("no alerts reads as good news", noAlerts.content[0].text.includes("normal service"));

// --- Error mapping -----------------------------------------------------------
const rateLimited = await call("transit_next_departures", { operator_id: "SF", stop_code: "429" });
check("429 warns against polling", rateLimited.isError === true && rateLimited.content[0].text.includes("do not poll"));
const badOperator = await call("transit_list_lines", { operator_id: "ZZ" });
check("404 points at transit_list_operators", badOperator.content[0].text.includes("transit_list_operators"));

child.kill();
mock.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
