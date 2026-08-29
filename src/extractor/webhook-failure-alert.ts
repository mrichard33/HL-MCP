/**
 * src/extractor/webhook-failure-alert.ts
 *
 * Daily check on webhook_failures growth.
 *
 * Added 2026-08-29 (Project 2 — GHL tag webhook durability). The table had
 * been accumulating for three months — 4,222 rows — with nothing watching it.
 * Every row is a tag event that never reached LP MCP, which means a contact
 * silently skipped its tag-triggered agent rules, entry hygiene and stage
 * advancement. Nobody knew, because a write-only failure table tells nobody.
 *
 * The bounded retry in src/webhooks/handler.ts should take normal daily
 * growth to zero. This alert is what notices when it does not.
 *
 * Per Mark's notification doctrine: fire only when something needs attention,
 * and carry the contact details in the message so it can be acted on without
 * a second lookup.
 */

import { getSupabaseClient } from '../clients/supabase.js';
import { postGroupMeAlert } from '../utils/groupme.js';

/**
 * More than this many new failures in 24h and we alert.
 * Override: WEBHOOK_FAILURE_ALERT_THRESHOLD.
 *
 * Default 5 mirrors the sync reaper's threshold and sits above normal noise:
 * a single Railway redeploy can legitimately cost a couple of in-flight
 * forwards. Crossing 5 in a day means the retry ladder is not holding, not
 * that something restarted once.
 */
const ALERT_THRESHOLD = parseInt(
  process.env.WEBHOOK_FAILURE_ALERT_THRESHOLD || '5',
  10,
);

/** Contacts named individually in the alert before it switches to a count. */
const MAX_CONTACTS_LISTED = 10;

export interface WebhookFailureAlertResult {
  total: number;
  threshold: number;
  alerted: boolean;
  byEndpoint: Record<string, number>;
  contactIds: string[];
  error?: string;
}

interface FailureRow {
  endpoint: string | null;
  event_type: string | null;
  error_message: string | null;
  payload: { contact_id?: string } | null;
}

/** Collapse an error string to a stable bucket for the breakdown. */
function classify(message: string | null): string {
  const msg = message || '(no message)';
  if (/aborted due to timeout|timed out|AbortError/i.test(msg)) return 'timeout';
  if (/returned 5\d{2}|failed to respond/i.test(msg)) return 'upstream 5xx';
  if (/fetch failed|ECONNRESET|ENOTFOUND/i.test(msg)) return 'network';
  return msg.slice(0, 60);
}

/**
 * Count the last 24h of webhook_failures and alert if growth crosses the
 * threshold. Never throws — a monitoring failure must not take down the
 * scheduler tick that called it.
 */
export async function checkWebhookFailures(): Promise<WebhookFailureAlertResult> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const empty = { byEndpoint: {} as Record<string, number>, contactIds: [] as string[] };

  let rows: FailureRow[];
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('webhook_failures')
      .select('endpoint, event_type, error_message, payload')
      .gte('created_at', since);

    if (error) {
      console.error(`[WebhookFailureAlert] query failed: ${error.message}`);
      return { total: 0, threshold: ALERT_THRESHOLD, alerted: false, ...empty, error: error.message };
    }
    rows = (data || []) as FailureRow[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[WebhookFailureAlert] threw: ${msg}`);
    return { total: 0, threshold: ALERT_THRESHOLD, alerted: false, ...empty, error: msg };
  }

  const total = rows.length;
  const byEndpoint: Record<string, number> = {};
  const byMode: Record<string, number> = {};
  const contactIds: string[] = [];

  for (const row of rows) {
    const ep = row.endpoint || '(unknown)';
    byEndpoint[ep] = (byEndpoint[ep] || 0) + 1;
    const mode = classify(row.error_message);
    byMode[mode] = (byMode[mode] || 0) + 1;
    const cid = row.payload?.contact_id;
    if (cid && !contactIds.includes(cid)) contactIds.push(cid);
  }

  console.log(
    `[WebhookFailureAlert] ${total} failure(s) in the last 24h ` +
    `(threshold ${ALERT_THRESHOLD}, ${contactIds.length} contact(s) affected)`,
  );

  if (total <= ALERT_THRESHOLD) {
    return { total, threshold: ALERT_THRESHOLD, alerted: false, byEndpoint, contactIds };
  }

  const fmt = (rec: Record<string, number>) =>
    Object.entries(rec).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`).join('\n  ');

  const listed = contactIds.slice(0, MAX_CONTACTS_LISTED);
  const contactLine = contactIds.length === 0
    ? '(no contact_id on these payloads)'
    : listed.join(', ') + (contactIds.length > listed.length
      ? ` … +${contactIds.length - listed.length} more`
      : '');

  const alerted = await postGroupMeAlert(
    `[SYSTEM] webhook_failures grew by ${total} in 24h (threshold ${ALERT_THRESHOLD}).\n` +
    `Each row is an event that never reached its destination — the contact skipped ` +
    `whatever that event would have triggered.\n\n` +
    `Endpoint:\n  ${fmt(byEndpoint)}\n\n` +
    `Failure mode:\n  ${fmt(byMode)}\n\n` +
    `Contacts affected (${contactIds.length}):\n  ${contactLine}\n\n` +
    `The bounded retry already spent 3 attempts on each of these. Replay with ` +
    `scripts/replay-webhook-failures.ts once the underlying cause is fixed.`,
    'WebhookFailureAlert',
  );

  return { total, threshold: ALERT_THRESHOLD, alerted, byEndpoint, contactIds };
}
