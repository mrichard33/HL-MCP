-- 010_wp_page_events.sql
-- Weakest Point journey telemetry (report.getreecewindows.com).
-- Every allowlisted page event lands here, including anonymous ones
-- (contact_id null when the HMAC token is missing or invalid).
-- ghl_synced/ghl_synced_at guard the once-per-(contact,event) GHL
-- projection done by src/wp/telemetry.ts.
--
-- Run manually in the Supabase dashboard (DDL is dashboard-only in this stack).

create table if not exists wp_page_events (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  event         text not null,
  contact_id    text,
  session_id    text,
  client_ts     timestamptz,
  path          text,
  data          jsonb not null default '{}'::jsonb,
  ghl_synced    boolean not null default false,
  ghl_synced_at timestamptz
);
create index if not exists wp_events_contact_idx on wp_page_events (contact_id, event);
create index if not exists wp_events_session_idx on wp_page_events (session_id);
create index if not exists wp_events_created_idx on wp_page_events (created_at);
