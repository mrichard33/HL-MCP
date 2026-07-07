-- 012_estimator_events.sql
-- Window Estimator funnel telemetry (landing.reecewindows.com / link.reecewindows.com).
-- Ingested by POST /webhook/estimator-event (src/http/estimator-routes.ts) —
-- public fire-and-forget beacon endpoint; the event vocabulary is validated
-- server-side (see that module and README "Estimator Funnel Events").
-- Analytics-only: no GHL projection, no reads exposed to the browser.
--
-- Run manually in the Supabase dashboard (DDL is dashboard-only in this stack).

create table if not exists estimator_events (
  id            uuid primary key default gen_random_uuid(),
  session_id    text not null,
  contact_id    text,                          -- GHL contact id once known (Step 1+)
  page_variant  text not null default 'full',  -- 'full' | 'sml'
  event_type    text not null,                 -- validated vocabulary, see estimator-routes.ts
  step          smallint,                      -- 1-4 where applicable
  payload       jsonb not null default '{}'::jsonb,
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  utm_content   text,
  utm_term      text,
  user_agent    text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_estimator_events_session on estimator_events (session_id, created_at);
create index if not exists idx_estimator_events_type    on estimator_events (event_type, created_at);
create index if not exists idx_estimator_events_contact on estimator_events (contact_id) where contact_id is not null;

-- Daily funnel rollup: distinct sessions per stage by variant and UTM source.
-- avg_estimate_total guards the numeric cast with a regex — this table is fed
-- by a public unauthenticated endpoint, so a junk estimate_total string must
-- count as null rather than break the whole view at query time.
create or replace view estimator_funnel_daily as
select
  date_trunc('day', created_at) as day,
  page_variant,
  coalesce(utm_source, '(none)') as utm_source,
  count(distinct session_id) filter (where event_type = 'page_view')          as page_views,
  count(distinct session_id) filter (where event_type = 'step1_complete')     as step1_completes,
  count(distinct session_id) filter (where event_type = 'window_added')       as configured_window,
  count(distinct session_id) filter (where event_type = 'step3_complete')     as step3_completes,
  count(distinct session_id) filter (where event_type = 'estimate_completed') as estimates_completed,
  count(distinct session_id) filter (where event_type = 'verify_cta_clicked') as verify_clicks,
  round(avg(case when payload->>'estimate_total' ~ '^\d+(\.\d+)?$'
             then (payload->>'estimate_total')::numeric end)
        filter (where event_type = 'estimate_completed'), 2) as avg_estimate_total
from estimator_events
group by 1, 2, 3;
