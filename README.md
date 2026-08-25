# transit-mcp-server

MCP server for the [511.org SF Bay Open Data](https://511.org/open-data/transit) transit API. Gives an LLM live Bay Area transit data — agencies, routes, stops, real-time departures, vehicle positions and service alerts — across BART, Muni, AC Transit, Caltrain, VTA and every other 511-reporting operator.

6 tools, all read-only.

## Requirements

- Node.js 18+
- A free 511 API token from https://511.org/open-data/token

## Install

```bash
npm install
npm run build
```

## Configure

```json
{
  "mcpServers": {
    "transit": {
      "command": "node",
      "args": ["/absolute/path/to/transit-mcp-server/dist/index.js"],
      "env": { "TRANSIT_511_API_KEY": "your-token-here" }
    }
  }
}
```

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TRANSIT_511_API_KEY` | yes | — | Token from https://511.org/open-data/token |
| `TRANSIT_511_BASE_URL` | no | `https://api.511.org` | Override the API host |
| `TRANSIT_511_REQUEST_TIMEOUT_MS` | no | `30000` | Per-request timeout |
| `TRANSPORT` | no | `stdio` | `stdio` or `http` |
| `PORT` / `HOST` | no | `3000` / `127.0.0.1` | HTTP transport bind address |
| `MCP_PATH_SECRET` | when hosted | — | Serves the endpoint at `/mcp/<secret>`. **Required** when `HOST` is not loopback |
| `ALLOWED_ORIGINS` | no | localhost + claude.ai | Comma-separated origin allowlist |

## The quota is the main constraint

511 allows **60 requests per hour per key, shared across every endpoint**. That is low enough to shape how these tools should be used:

- Resolve operator codes and stop codes once, then reuse them. They do not change.
- Prefer `transit_list_service_alerts` with no `operator_id` — one call covers every agency.
- Never poll `transit_next_departures` in a loop. Ten checks over a commute is a sixth of the hourly budget.

`transit_list_operators` reports how much budget is left, read from the `RateLimit-Remaining` header 511 returns on every response. Exceeding the quota returns 429; request an increase from `transitdata@511.org`.

## Deploying (for Claude mobile / claude.ai connectors)

Same shape as any hosted MCP server: generate a path secret with `openssl rand -hex 32`, set `TRANSIT_511_API_KEY` and `MCP_PATH_SECRET` in the platform dashboard, and the included `Dockerfile` and `railway.json` work as-is on Railway, Render or Fly. The server refuses to start on a public interface without a secret. `/healthz` is an unauthenticated liveness probe.

Then on claude.ai **in a browser**: **Customize → Connectors → Add custom connector**, URL `https://your-app.up.railway.app/mcp/<secret>`.

## Tools

**Network** — `transit_list_operators`, `transit_list_lines`, `transit_find_stops`

**Real-time** — `transit_next_departures`, `transit_list_vehicles`

**Alerts** — `transit_list_service_alerts`

Every tool takes `response_format: "markdown" | "json"`. Markdown is the default and is optimized for an LLM reading it; JSON is the full structured payload. `structuredContent` is always populated regardless of format.

## Examples

**"When's the next N Judah?"**
→ `transit_find_stops` with `operator_id="SF"`, `query="judah"` to get the stop code, then `transit_next_departures` with that code and `line="N"`.

**"Is BART running normally?"**
→ `transit_list_service_alerts` with `operator_id="BA"`.

**"Anything wrong on my commute?"**
→ `transit_list_service_alerts` with no operator — one call sweeps every Bay Area agency.

**"Where are the trains right now?"**
→ `transit_list_vehicles` with `operator_id="BA"`.

## Design notes

**Read-only by construction.** 511 publishes no write endpoints, and every tool carries `readOnlyHint: true`. A test asserts it.

**One `operator_id`, mapped per endpoint.** 511 calls this parameter `operator_id` on its static endpoints and `agency` on its real-time ones, for the same value. Every tool here takes `operator_id` and the client maps it. That split is 511's problem, not the caller's.

**The two real-time endpoints have genuinely different envelopes.** `StopMonitoring` has **no** `Siri` root wrapper; `VehicleMonitoring` **does**. The published spec shows one for both — the spec is wrong, and parsing the documented shape would return nothing at all for departures. Both are parsed as the live API actually emits them, with a test pinning each.

**Arrivals carry the countdown, not departures.** `ExpectedDepartureTime` is null in essentially every real row, so keying a countdown off it would show a stop with no service. `ExpectedArrivalTime` is the reliable field.

**A UTF-8 BOM is stripped before parsing.** 511 prefixes JSON bodies with `U+FEFF`, which makes a naive `JSON.parse` throw on a perfectly valid payload. Auth failures are plain text with no BOM, so the strip happens after the status check.

**Values that look like numbers and booleans often are not.** Coordinates and bearings arrive as JSON strings, `VehicleAtStop` is the string `"false"`, and `""` is used throughout where null is meant. Coercing blindly would turn a missing position into a valid-looking 0,0 off the coast of Africa, so empty strings are treated as absent rather than zero.

**The epoch-zero sentinel is not a timestamp.** A trip that is scheduled but has no vehicle assigned reports `RecordedAtTime` of `1970-01-01T00:00:00Z`. It renders as "no vehicle assigned yet" rather than "recorded 56 years ago".

**GTFS-Realtime enums are decoded.** 511's JSON alert rendering emits `"effect": 3` where the XML rendering says `SignificantDelays`. Both cause and effect are mapped back to words.

**511-internal pseudo-agencies are filtered out.** `5E`, `5F`, `5O` and `5S` are 511 Emergency, Flap Sign, Operations and Staff — they appear in the operator list carrying no service data.

**Everything is Pacific.** Timestamps arrive as UTC and are rendered in `America/Los_Angeles`, so daylight saving is handled once here rather than by the model twice a year. Note that 511's own `TimeZone` field reports `America/Vancouver` for every Bay Area agency — a known upstream data bug, ignored deliberately.

**Truncation is always stated.** 511 does not paginate; it returns whole collections, and a large agency has thousands of stops. Tools take a client-side `limit` and every trimmed result says how much was withheld, because a silently shortened list reads as "that is everything".

## Caveats

- The hourly quota is 60 requests across all endpoints. This is the binding constraint on any workflow.
- Operator codes are easy to guess wrong: VTA is `SC` (not `VT`), Capitol Corridor is `AM` (not `CC`), Tri Delta is `3D`. `transit_list_operators` prints these traps in its output.
- Stop codes belong to one operator and are not interchangeable between agencies.
- `transit_find_stops` filters on this server, so a narrow query does not save quota — the full stop list is fetched either way.
- Real-time predictions extend roughly 90 minutes ahead, and 511 omits a route's final arrival-only stop from the departures feed.
- `tripupdates` and `vehiclepositions` are protobuf-only with no JSON option, so they are deliberately not exposed — supporting them would mean taking on a protobuf dependency for data the SIRI endpoints already cover.

## Project layout

```
src/
├── index.ts               # entry point, transport selection
├── constants.ts           # enums, limits, operator-code traps
├── types.ts               # interfaces for every 511 entity
├── services/
│   └── transit-client.ts  # fetch wrapper, auth, BOM stripping, quota tracking, errors
├── schemas/
│   ├── inputs.ts          # Zod input schemas
│   └── outputs.ts         # structuredContent schemas
├── formatters/
│   ├── response.ts        # limiting, truncation, Pacific-time rendering
│   └── entities.ts        # per-entity markdown rendering
└── tools/
    ├── network.ts         # operators, lines, stops
    ├── departures.ts      # real-time arrivals and vehicles
    └── alerts.ts          # service alerts
```

## Tests

```bash
npm run build
npm test            # 42 checks: handshake, BOM, envelopes, quirks, errors (mocked API)
npm run test:http   # 17 checks: config validation, path-secret gating, method handling, origins
```

Both suites run against a local mock that deliberately reproduces 511's real quirks — the BOM, the missing `Siri` wrapper, stringified booleans and coordinates, the epoch sentinel, and plain-text error bodies — because those are exactly what a naive client gets wrong.
