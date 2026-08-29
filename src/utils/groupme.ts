/**
 * GroupMe alerting.
 *
 * Extracted from src/extractor/sync-reaper.ts on 2026-08-29 (Project 2) when
 * the webhook-failure alert needed the same posting path. Behaviour is
 * unchanged; only the home moved.
 *
 * Per Mark's notification doctrine an alert fires only when something needs
 * attention, and carries enough detail to act on without a second lookup.
 * Threshold gating belongs to the caller — this function just posts.
 */

/**
 * Post a system-class alert to GroupMe.
 *
 * Best-effort and never throws: a failed alert must not fail the job that
 * raised it, or a monitoring problem becomes a data problem. Silently no-ops
 * when GROUPME_BOT_ID is unset (local dev / test).
 *
 * @param text    message body
 * @param logTag  prefix for this caller's log lines, e.g. 'SyncReaper'
 */
export async function postGroupMeAlert(text: string, logTag = 'GroupMe'): Promise<boolean> {
  const botId = process.env.GROUPME_BOT_ID;
  if (!botId) {
    console.warn(`[${logTag}] GROUPME_BOT_ID not set — skipping alert`);
    return false;
  }

  try {
    const res = await fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: botId, text }),
    });
    if (!res.ok) {
      console.error(`[${logTag}] GroupMe alert failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${logTag}] GroupMe alert threw: ${msg}`);
    return false;
  }
}
