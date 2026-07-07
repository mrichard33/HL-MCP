# HL Workflow Intelligence MCP

An MCP (Model Context Protocol) server for GoHighLevel CRM & Workflow Intelligence, backed by Supabase for data caching and analytics.

## Features

### CRM Tools
- **search_contacts** — Search contacts via GHL API or Supabase cache
- **get_contact** — Get a single contact by ID
- **create_contact** — Create a new contact
- **update_contact** — Update an existing contact
- **delete_contact** — Delete a contact
- **sync_contacts** — Sync contacts from GHL to Supabase

### Pipeline & Opportunities
- **list_pipelines** — List all pipelines and stages
- **get_opportunities** — Query opportunities by pipeline, stage, or status
- **create_opportunity** — Create a new deal
- **update_opportunity** — Update a deal
- **sync_pipelines** — Sync pipelines to Supabase

### Workflow Intelligence
- **list_workflows** — List all GHL workflows
- **sync_workflows** — Sync workflows to Supabase
- **get_workflow_executions** — Query execution history
- **log_workflow_execution** — Log execution events
- **workflow_analytics** — Get success/failure rates, durations, and trends

### Conversations & Messaging
- **list_conversations** — List conversations, optionally by contact
- **get_conversation** — Get a single conversation
- **get_messages** — Get messages in a conversation
- **send_message** — Send SMS, Email, WhatsApp, etc.
- **sync_conversations** — Sync conversations to Supabase

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your Supabase and GHL credentials
```

### 3. Run database migrations

Apply the SQL migration in `supabase/migrations/001_initial_schema.sql` to your Supabase project via the SQL Editor in the Supabase dashboard.

### 4. Build and run

```bash
npm run build
npm start
```

### 5. Add to Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hl-workflow-intelligence": {
      "command": "node",
      "args": ["/path/to/hl-workflow-intelligence-mcp/dist/index.js"],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "your-service-role-key",
        "GHL_API_KEY": "your-ghl-api-key",
        "GHL_LOCATION_ID": "your-location-id"
      }
    }
  }
}
```

## Architecture

```
src/
├── index.ts              # MCP server entry point
├── clients/
│   ├── ghl.ts            # GoHighLevel API client
│   └── supabase.ts       # Supabase client
├── tools/
│   ├── contacts.ts       # Contact CRUD + sync tools
│   ├── pipelines.ts      # Pipeline & opportunity tools
│   ├── workflows.ts      # Workflow intelligence & analytics
│   └── conversations.ts  # Conversation & messaging tools
└── types/
    └── ghl.ts            # GHL TypeScript types

supabase/
└── migrations/
    └── 001_initial_schema.sql  # Database schema
```

## WP Journey Pages (report.getreecewindows.com)

This service also serves the four-page "Weakest Point" founder-film journey
and captures its engagement telemetry.

### Routes

| Route | File | Purpose |
|-------|------|---------|
| `GET /` | `public/wp/index.html` | Film landing page |
| `GET /find` | `public/wp/find.html` | Step 1 — address |
| `GET /unlock` | `public/wp/unlock.html` | Step 2 — details + contact |
| `GET /report` | `public/wp/report.html` | Step 3 — Home Risk Report |
| `POST /api/telemetry` | — | Event ingestion (sendBeacon) |

The JSON health check moved to `GET /health` (it previously also answered on `/`).
The HTML files are finished artifacts — vendored verbatim, no build step.
They are served from an in-memory cache with gzip/brotli variants and ETags.

### Telemetry

`POST /api/telemetry` accepts `{ event, token, session_id, ts, path, data }`
and always returns 204 immediately. Allowlisted events: `page_view`,
`gate_start`, `gate_complete`, `cta_click`, `video_progress`, `report_ready`.
Every event is inserted into the `wp_page_events` Supabase table
(migration: `supabase/migrations/010_wp_page_events.sql` — run manually in
the Supabase dashboard).

Identity tokens arrive as `?t=<contactId>.<sig>` where
`sig = base64url(HMAC_SHA256(contactId, WP_TOKEN_SECRET))`. Verified tokens
trigger an async GHL write-back (tags `wp:gate-complete`/`wp:cta-click`,
custom fields `wp_gate_status`, `wp_last_engaged`, `wp_risk_grade`,
`wp_weakest_point`, `wp_watch_pct`, optional workflow enrollment), guarded
by a once-per-(contact, event) idempotency check on `ghl_synced`. Invalid or
missing tokens record the event anonymously and skip GHL entirely.

### Environment variables

- `WP_TOKEN_SECRET` — HMAC secret for identity tokens (32+ random bytes)
- `PAGE_ALLOWED_ORIGIN` — CORS origin for `/api/telemetry` (e.g. `https://report.getreecewindows.com`)
- `WP_FOLLOWUP_WORKFLOW_ID` — optional; GHL workflow enrolled on `gate_complete`
- `TRUST_RAW_CID` — dev only; accept bare contact IDs as tokens. Must be `false` in prod.

## Estimator Funnel Events (landing.reecewindows.com / link.reecewindows.com)

`POST /webhook/estimator-event` — public, fire-and-forget beacon ingestion for
the Window Estimator calculator funnel. Accepts `application/json` and
`text/plain` (sendBeacon Blob) bodies — the body is JSON either way. Returns
**204** on success (never a body; sent before the insert so beacons never block
navigation, and insert failures are logged, not surfaced), **400** on invalid
input, **413** over the 16KB transport cap, **429** over 60 req/min per IP,
**405** for non-POST. CORS origins: `https://landing.reecewindows.com`,
`https://link.reecewindows.com`. No auth and no new environment variables —
mitigations are the strict event vocabulary, the 8KB `payload` cap, the rate
limit, and no exposed reads.

Rows land in `estimator_events`
(migration: `supabase/migrations/012_estimator_events.sql` — run manually in
the Supabase dashboard); daily rollup view: `estimator_funnel_daily`
(distinct sessions per funnel stage by day × page_variant × utm_source, plus
average estimate value).

### Request body

```json
{
  "session_id": "required, ≤64 chars",
  "contact_id": "optional GHL contact id",
  "page_variant": "full | sml (default full)",
  "event_type": "see vocabulary below",
  "step": 1,
  "payload": {},
  "utm": { "source": "", "medium": "", "campaign": "", "content": "", "term": "" }
}
```

`user_agent` is captured server-side. Unexpected top-level keys are ignored.

### Event vocabulary

| event_type | step | fired when |
|------------|------|------------|
| `page_view` | 1 | page load |
| `step1_complete` | 1 | Step 1 validation passes (contact created in GHL) |
| `window_added` | 2 | "Add Window to Estimate" clicked (payload: style, qty, isImpact, unitedInches) |
| `step3_reached` | 3 | Step 3 (email/contact) shown |
| `step3_complete` | 3 | email + consent validation passes |
| `estimate_completed` | 4 | Step 4 rendered (payload: estimate_total, window_count, low, high) |
| `verify_cta_clicked` | 4 | "Secure My Exact Price" clicked |
| `keep_estimate_clicked` | 4 | "Keep My Estimate for Now" clicked |
