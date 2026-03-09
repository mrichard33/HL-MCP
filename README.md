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
