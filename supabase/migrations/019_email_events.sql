-- 019_email_events.sql — email engagement from GHL LCEmailStats (2026-10-02)
--
-- Nothing subscribed to GHL's LCEmailStats webhook before this, so no email
-- open, click or bounce ever reached Supabase. src/webhooks/email-stats.ts
-- writes one row per Mailgun event here; lead_events gets a mirror row only
-- for contact timelines.
--
-- Apply MANUALLY in the HL MCP Supabase dashboard SQL editor (not LP MCP),
-- as one execution, BEFORE enabling the LCEmailStats subscription in GHL.
-- New empty table, so plain CREATE INDEX is fine.

CREATE TABLE IF NOT EXISTS public.email_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_hash            text NOT NULL UNIQUE,
  provider_event_id     text,
  event                 text NOT NULL,
  severity              text,
  ghl_contact_id        text,
  recipient             text,
  subject               text,
  from_address          text,
  provider_message_id   text,
  attributed_message_id text,
  attribution_method    text,
  clicked_url           text,
  trigger_link_id       text,
  trigger_link_name     text,
  utm_campaign          text,
  utm_content           text,
  is_machine_open       boolean NOT NULL DEFAULT false,
  failure_reason        text,
  client_info           jsonb,
  occurred_at           timestamptz NOT NULL,
  raw_json              jsonb NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_events_contact_idx ON public.email_events (ghl_contact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS email_events_event_idx   ON public.email_events (event, occurred_at DESC);
CREATE INDEX IF NOT EXISTS email_events_msg_idx     ON public.email_events (provider_message_id);
CREATE INDEX IF NOT EXISTS email_events_link_idx    ON public.email_events (trigger_link_id) WHERE trigger_link_id IS NOT NULL;

-- Activity by day (ET). Counts events on the day they happened.
CREATE OR REPLACE VIEW public.v_email_performance_daily AS
SELECT (occurred_at AT TIME ZONE 'America/New_York')::date AS day_et,
  count(DISTINCT provider_message_id) FILTER (WHERE event = 'delivered')                       AS delivered,
  count(DISTINCT provider_message_id) FILTER (WHERE event = 'failed')                          AS failed,
  count(DISTINCT provider_message_id) FILTER (WHERE event = 'opened' AND NOT is_machine_open)  AS human_opens,
  count(DISTINCT provider_message_id) FILTER (WHERE event = 'opened')                          AS all_opens,
  count(DISTINCT provider_message_id) FILTER (WHERE event = 'clicked')                         AS clicks,
  count(*) FILTER (WHERE event = 'complained')                                                 AS complaints,
  count(*) FILTER (WHERE event = 'unsubscribed')                                               AS unsubscribes
FROM public.email_events
GROUP BY 1;

-- Per-email performance (one row per subject line, each send counted once).
CREATE OR REPLACE VIEW public.v_email_performance_by_subject AS
WITH per_msg AS (
  SELECT provider_message_id,
    max(subject)                                    AS subject,
    min(occurred_at)                                AS first_event_at,
    bool_or(event = 'delivered')                    AS delivered,
    bool_or(event = 'failed')                       AS failed,
    bool_or(event = 'opened' AND NOT is_machine_open) AS human_opened,
    bool_or(event = 'opened')                       AS opened_any,
    bool_or(event = 'clicked')                      AS clicked,
    bool_or(event = 'complained')                   AS complained,
    bool_or(event = 'unsubscribed')                 AS unsubscribed
  FROM public.email_events
  WHERE provider_message_id IS NOT NULL
  GROUP BY provider_message_id
)
SELECT coalesce(subject, '(no subject)') AS subject,
  min(first_event_at) AS first_sent_at,
  max(first_event_at) AS last_sent_at,
  count(*) FILTER (WHERE delivered)    AS delivered,
  count(*) FILTER (WHERE failed)       AS failed,
  count(*) FILTER (WHERE human_opened) AS human_opens,
  count(*) FILTER (WHERE opened_any)   AS all_opens,
  count(*) FILTER (WHERE clicked)      AS clicks,
  count(*) FILTER (WHERE complained)   AS complaints,
  count(*) FILTER (WHERE unsubscribed) AS unsubscribes,
  round(100.0 * count(*) FILTER (WHERE human_opened) / nullif(count(*) FILTER (WHERE delivered), 0), 1) AS human_open_rate_pct,
  round(100.0 * count(*) FILTER (WHERE clicked)      / nullif(count(*) FILTER (WHERE delivered), 0), 1) AS click_rate_pct,
  round(100.0 * count(*) FILTER (WHERE failed)       / nullif(count(*), 0), 1)                          AS failure_rate_pct
FROM per_msg
GROUP BY 1;

-- Which links get clicked (trigger links resolved by name).
CREATE OR REPLACE VIEW public.v_email_clicks_by_link AS
SELECT coalesce(trigger_link_name, utm_content, clicked_url) AS link,
  trigger_link_id, utm_campaign, utm_content,
  count(*)                       AS clicks,
  count(DISTINCT ghl_contact_id) AS unique_contacts,
  min(occurred_at)               AS first_click_at,
  max(occurred_at)               AS last_click_at
FROM public.email_events
WHERE event = 'clicked'
GROUP BY 1, 2, 3, 4;

-- Correct channel for historic messages (history is not rewritten in lead_events).
CREATE OR REPLACE VIEW public.v_messages_channel AS
SELECT m.*,
  CASE
    WHEN m.type IN ('3','9') OR lower(m.type) LIKE '%email%' THEN 'email'
    WHEN m.type IN ('5','29') OR lower(m.type) LIKE '%live_chat%' OR lower(m.type) LIKE '%webchat%' THEN 'live_chat'
    WHEN m.type IN ('1','8') OR lower(m.type) LIKE '%call%' THEN 'call'
    ELSE 'sms_or_social'
  END AS channel
FROM public.messages m
WHERE m.deleted_at IS NULL;
