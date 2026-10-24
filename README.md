# Cal.com MCP Server

Model Context Protocol server for [Cal.com](https://cal.com/) scheduling — built first for **self-hosted
[Cal.diy](https://github.com/calcom/cal.diy)** (Cal.com's MIT community edition), and compatible with Cal.com Cloud.

It ships with **39 tools** (17 read-only on every connection) for bookings, availability, calendars, event types,
private links, schedules, video apps and webhooks, and supports:

- hosted key-service mode with `usr_...` user keys ([MCP Key Service](https://mcpkeys.techmavie.digital))
- self-hosted Streamable HTTP deployments
- CLI/stdio usage for local MCP clients

**MCP Endpoint:** `https://mcp.techmavie.digital/calcom/mcp`

> Originally forked from [calcom/cal-mcp](https://github.com/calcom/cal-mcp) (auto-generated, Cloud-only, stdio-only).
> v2 is a ground-up rewrite by [@hithereiamaliff](https://github.com/hithereiamaliff); none of the generated code remains.

## Before you start: Cal API v2

The server talks to **Cal API v2**. Cal.com Cloud has it at `https://api.cal.com/v2`. A self-hosted Cal.diy / Cal.com
instance runs API v2 as a **separate service** next to the web app — if `https://your-cal/api/v2/me` returns the web
app's 404 page, deploy it first: [docs/CALDIY-API-V2.md](docs/CALDIY-API-V2.md).

Then create an API key in Cal: **Settings → Developer → API Keys** (it starts with `cal_`).

## Quick Start

### Option 1: Hosted key-service mode (recommended)

1. Go to [mcpkeys.techmavie.digital](https://mcpkeys.techmavie.digital), choose **Cal.com / Cal.diy** and enter:
   - **API URL** — your API v2 URL, e.g. `https://cal.example.com/api/v2` (leave blank for Cal.com Cloud)
   - **API Key** — `cal_…` from Settings → Developer → API Keys
   - *Optional* **Access Level** — `read` (default), `bookings` or `full` (see [Access levels](#access-levels))
2. Use the `usr_...` key you get back:

```json
{
  "mcpServers": {
    "calcom": {
      "transport": "streamable-http",
      "url": "https://mcp.techmavie.digital/calcom/mcp/usr_YOUR_USER_KEY"
    }
  }
}
```

Other forms of the same hosted connection:

```text
https://mcp.techmavie.digital/calcom/mcp?api_key=usr_YOUR_USER_KEY
https://mcp.techmavie.digital/calcom/mcp   +   header  Authorization: Bearer usr_YOUR_USER_KEY
```

### Option 2: Self-hosted HTTP

Header-based auth on `/mcp` (requires `MCP_API_KEY` on the server):

```json
{
  "mcpServers": {
    "calcom": {
      "transport": "streamable-http",
      "url": "https://your-host/calcom/mcp",
      "headers": {
        "X-API-Key": "YOUR_MCP_API_KEY",
        "X-Calcom-Api-Key": "cal_YOUR_CAL_API_KEY",
        "X-Calcom-Api-Url": "https://cal.example.com/api/v2",
        "X-Calcom-Access": "bookings"
      }
    }
  }
}
```

### Option 3: CLI / stdio

```json
{
  "mcpServers": {
    "calcom": {
      "command": "npx",
      "args": ["-y", "github:hithereiamaliff/mcp-calcom"],
      "env": {
        "CALCOM_API_KEY": "cal_YOUR_CAL_API_KEY",
        "CALCOM_API_URL": "https://cal.example.com/api/v2",
        "CALCOM_ACCESS": "read"
      }
    }
  }
}
```

`CALCOM_API_URL` is optional (default: Cal.com Cloud) and `CAL_API_KEY` from the old `@calcom/cal-mcp` config is still
accepted. The URL can also be just the instance (`https://cal.example.com`) — the server adds `/api/v2`.

## Authentication Modes

| Mode | Endpoint | Client auth | Credentials from |
|------|----------|-------------|------------------|
| Hosted key-service | `/mcp/usr_...` | none | MCP Key Service (`calcom` connector) |
| Hosted, query form | `/mcp?api_key=usr_...` | none | MCP Key Service |
| Hosted, header form | `/mcp` | `Authorization: Bearer usr_...` | MCP Key Service |
| Self-hosted HTTP | `/mcp` | `X-API-Key` | `X-Calcom-*` headers |
| CLI / stdio | — | — | `CALCOM_*` environment variables |

Raw Cal keys in the URL are **not** accepted — they leak into proxy logs. The HTTP server never falls back to a key
from its own environment.

## Access levels

| Level | Tools | What it allows |
|---|---|---|
| `read` (default) | 17 | Everything read-only |
| `bookings` | 28 | + create / reschedule / cancel / confirm / decline bookings, no-shows, guests, locations, private links |
| `full` | 39 | + change event types, availability schedules, profile, default video app and webhooks |

Tools a connection may not use are not registered at all. Destructive tools (cancel, decline, remove attendee, delete
event type / schedule / webhook / private link) also refuse to run until the model passes `confirm: true`, which it
should only do after you agree.

## Tools

Full parameter reference: **[TOOLS.md](TOOLS.md)** (generated from the code).

### Profile & diagnostics

| Tool | Access | Description |
|------|--------|-------------|
| `hello` | read | Connection summary (no API call) |
| `get_instance_info` | read | Diagnoses the connection: API v2 reachable? key valid? account, event types, calendars, rate limit |
| `get_my_profile` | read | Name, username, email, time zone, week start, clock, default schedule |
| `update_my_profile` | full | Change name, time zone, week start, 12/24 h, language, bio, default schedule |

### Bookings

| Tool | Access | Description |
|------|--------|-------------|
| `list_bookings` | read | Agenda grouped by day in your time zone; upcoming by default, or today / this week / past / cancelled / custom range |
| `get_booking` | read | Full details; optional attendee ids, calendar links, references, recordings, transcripts, meeting sessions |
| `get_booking_summary` | read | Stats for a period vs the previous one: statuses, event types, booked hours, cancellations, no-shows, busiest times, top attendees, estimated revenue |
| `create_booking` | bookings | Book someone into an event type — checks the time against open slots first and suggests alternatives |
| `reschedule_booking` | bookings | Move a booking (slot-checked) |
| `cancel_booking` | bookings ⚠️ | Cancel (attendees are notified) |
| `confirm_booking` / `decline_booking` | bookings / ⚠️ | Handle bookings that need confirmation (bookings of paid event types still awaiting payment are refused unless `allow_unpaid: true`) |
| `mark_no_show` | bookings | Mark host / attendees absent |
| `add_booking_guests` / `remove_booking_attendee` | bookings / ⚠️ | Manage who is invited |
| `update_booking_location` | bookings | Switch to a video app, link, address or phone |

### Availability & calendars

| Tool | Access | Description |
|------|--------|-------------|
| `get_available_slots` | read | Open times for an event type, compact list per day |
| `list_calendars` | read | Connected calendars, conflict checking, destination calendar |
| `get_busy_times` | read | Busy blocks from your connected calendars (Google, Office 365, Apple, CalDAV) |
| `list_calendar_events` | read | Events on your Google Calendar (Google only — Cal API limitation) |

### Event types & private links

| Tool | Access | Description |
|------|--------|-------------|
| `list_event_types` / `get_event_type` | read | Event types with length, price, visibility, confirmation rule, locations, booking URL, booking form |
| `list_private_links` | read | Private (single-use / expiring) booking links |
| `create_private_link` / `delete_private_link` | bookings / ⚠️ | Send one client a private link |
| `create_event_type` / `update_event_type` / `delete_event_type` | full / ⚠️ | Manage event types (friendly fields + `advanced` passthrough) |

### Availability schedules

| Tool | Access | Description |
|------|--------|-------------|
| `list_schedules` / `get_schedule` | read | Working hours and date overrides |
| `create_schedule` / `update_schedule` / `delete_schedule` | full / ⚠️ | Change hours, block holidays (`block_dates`), manage overrides |

### Video apps & webhooks

| Tool | Access | Description |
|------|--------|-------------|
| `list_conferencing_apps` | read | Installed video apps and the default |
| `set_default_conferencing_app` | full | Google Meet, Zoom, Teams or Cal Video |
| `list_webhooks` | read | Webhooks (secrets never shown) |
| `create_webhook` / `update_webhook` / `delete_webhook` | full / ⚠️ | Account-wide or per event type |

⚠️ = destructive, needs `confirm: true`. All tools carry MCP annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`).

## How it handles time

Cal stores UTC; people think in local time. Tools read times like `2026-10-27 15:00` in your Cal profile time zone (or
`time_zone`), refuse times that a daylight-saving change skips, and show every result in that zone with the zone named.
ISO times with an offset (`2026-10-27T15:00:00+08:00`) work too.

## Usage Examples

- "What's on my schedule this week?" → `list_bookings` with `when: "this_week"`
- "Any booking requests I still need to accept?" → `list_bookings` with `when: "unconfirmed"` → `confirm_booking`
- "When can someone book a 30-minute call with me next Tuesday?" → `get_available_slots`
- "Book Sam (sam@example.com) for the intro call tomorrow at 3pm" → `create_booking`
- "Move my 10:00 with John to Thursday 2pm, he's sick" → `reschedule_booking`
- "How did last month compare with the month before?" → `get_booking_summary` with `period: "last_month"`
- "Block 25 December" → `update_schedule` with `block_dates: ["2026-12-25"]`
- "Send Aisha a one-time link for the consultation" → `create_private_link`

## Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `/` | — | Server info |
| `/health` | — | Health check |
| `/.well-known/mcp/server-card.json` | — | MCP server card |
| `/mcp/:userKey` | usr_ key | Hosted key-service mode |
| `/mcp` | `?api_key=`, Bearer usr_ or headers | Hosted query / header form, self-hosted mode (POST only — stateless) |
| `/analytics`, `/analytics/tools` | `X-API-Key` | Usage JSON (IPs hashed, user keys never recorded) |
| `/analytics/import` | `X-API-Key` | Merge backup totals |
| `/analytics/dashboard` | key prompt | Usage dashboard |
| `/mcp-debug/open` | — | Diagnostics server, only with `ENABLE_MCP_DIAGNOSTICS=true` |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `MCP_API_KEY` | — | Enables self-hosted `/mcp` mode and analytics endpoints |
| `KEY_SERVICE_URL` | — | Full resolve URL, e.g. `http://mcp-key-service:8090/internal/resolve` |
| `KEY_SERVICE_TOKEN` | — | This server's token (`calcom:<token>` in the key service) |
| `PUBLIC_BASE_PATH` | — | Public prefix, e.g. `/calcom` |
| `ALLOWED_ORIGINS` | `*` | CORS allowlist |
| `ALLOW_PRIVATE_CALCOM_HOSTS` | — | Hostnames exempt from the private-IP block |
| `CALCOM_TIMEOUT_MS` | `30000` | Upstream request timeout |
| `MCP_TRACE_HTTP` / `ENABLE_MCP_DIAGNOSTICS` | `false` | Debug aids |
| `ANALYTICS_DIR` | `/app/data` | Local analytics JSON |
| `FIREBASE_SERVICE_ACCOUNT_PATH` / `FIREBASE_DATABASE_URL` | `/app/.credentials/...` / derived | Optional Firebase analytics |
| `CALCOM_API_KEY` (or `CAL_API_KEY`), `CALCOM_API_URL`, `CALCOM_ACCESS` | — | CLI / stdio only |

## Local Development

```bash
npm install
cp .env.sample .env          # fill in values
npm run dev:http             # HTTP server with tsx
npm run dev:cli              # stdio server with tsx
npm run typecheck
npm test                     # unit tests (node:test)
npm run smoke                # end-to-end test against a fake Cal API v2 + key service
npm run live-check           # read-only checks against your real instance (.env)
npm run docs:tools           # regenerate TOOLS.md
```

## Project Structure

```
src/
├── cli.ts                    # stdio entry (bin)
├── http-server.ts            # Express app, auth modes, per-request servers
├── index.ts                  # createAppServer + access-gated tool registration
├── config.ts                 # connection normalisation (API URL, key, access) + SSRF guard
├── errors.ts / version.ts
├── calcom/
│   ├── http.ts               # fetch wrapper: Bearer key, cal-api-version, timeouts, 429 retry, no redirects
│   ├── versions.ts           # which endpoint needs which cal-api-version
│   ├── client.ts             # typed client, one method per endpoint
│   ├── profile.ts            # /me cache (time zone, week start, clock)
│   ├── time.ts               # DST-safe time-zone conversion, range presets, formatting
│   ├── locations.ts          # friendly location input ↔ Cal location objects
│   ├── format.ts             # agenda, slots, weekly hours, prices, error hints
│   └── types.ts
├── tools/                    # core, bookings, availability, event-types, schedules, settings
├── utils/                    # key-service resolver, HttpError, masking
└── analytics/                # usage tracker, Firebase persistence, dashboard
test/                         # unit tests
scripts/                      # smoke-mcp.mjs, live-check.mjs, generate-tools-md.ts
deploy/                       # DEPLOYMENT.md, nginx-mcp.conf
docs/                         # REVAMP-PLAN.md, CALDIY-API-V2.md
```

## Security Notes

- Read-only by default; booking and configuration tools appear only at higher access levels, and destructive tools
  also need `confirm: true`. The key-rotation endpoint is never exposed (it would invalidate the key the server uses).
- API URLs resolving to private / loopback / link-local addresses are rejected and redirects are never followed, so a
  user-supplied URL cannot reach internal services.
- Self-hosted mode fails closed without `MCP_API_KEY`; keys are compared in constant time.
- Analytics store hashed IPs only; `usr_` keys and Cal keys are never logged (masked in traces) and never appear in
  tool schemas or output.

## Deployment

See [deploy/DEPLOYMENT.md](deploy/DEPLOYMENT.md). Pushes to `main` run the tests and then deploy to the VPS via
GitHub Actions.

## License

[MIT](./LICENSE)

---

Made with care by [Aliff](https://mynameisaliff.co.uk/) (TechMavie Digital)
