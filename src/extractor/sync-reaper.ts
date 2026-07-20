import { getSupabaseClient } from '../clients/supabase.js';
import { nowET } from '../utils/timezone.js';

/**
 * Reaper for sync_log rows orphaned in status='running'.
 *
 * ── Root cause this exists to clean up ──────────────────────────────────
 *
 * `scheduler.runJob` races the job body against a hard timeout (see
 * JOB_TIMEOUTS_MS). That race was added in v1.7 to fix a real deadlock: a
 * stalled inner promise would pin the `runningJobs` mutex forever and every
 * later cron fire would silently skip.
 *
 * The race fixed the mutex, but it left a leak. When the timer wins:
 *
 *   1. runJob's catch logs the timeout and `finally` releases the mutex.
 *   2. The inner sync promise (e.g. syncOpportunities) is STILL PENDING.
 *      It never reaches its own try/catch.
 *   3. So `logSyncFailed(syncLogId, ...)` is never called.
 *   4. The sync_log row inserted by `logSyncStart` — status 'running' — stays
 *      'running' for the lifetime of the table.
 *
 * Same outcome for a container SIGTERM or OOM mid-sync: the process dies
 * between logSyncStart and logSyncComplete/logSyncFailed.
 *
 * Observed on 2026-07-20: opportunities had 57 rows stuck 'running' in 24h
 * against 31 completed and 8 failed. That ratio says the opportunities job is
 * exceeding its 10-minute ceiling on most cycles — the reaper does not fix
 * that (see PR notes on the client-diff fallback path), it just stops the
 * orphans accumulating silently and makes the real failure rate visible.
 *
 * ── Why this matters beyond tidiness ────────────────────────────────────
 *
 * get_sync_health computes failure_rate as failed/total. Orphaned rows are
 * neither, so a job timing out on most cycles still reported a healthy ~1.4%.
 * The monitoring was structurally blind to the most common failure mode.
 * Reaping into 'failed' makes the number honest.
 */

/** A run in 'running' older than this is considered dead. Override: SYNC_REAPER_TIMEOUT_MINUTES. */
const REAPER_TIMEOUT_MINUTES = parseInt(
  process.env.SYNC_REAPER_TIMEOUT_MINUTES || '30',
  10,
);

/**
 * Reap more than this many rows in a single pass and we alert GroupMe.
 * Override: SYNC_REAPER_ALERT_THRESHOLD.
 *
 * Default 5 is deliberately above normal noise. A deploy or container restart
 * can legitimately orphan 1-4 rows (one per in-flight job). Crossing 5 in a
 * single 30-minute pass means a job is timing out repeatedly, not that
 * something restarted once.
 */
const REAPER_ALERT_THRESHOLD = parseInt(
  process.env.SYNC_REAPER_ALERT_THRESHOLD || '5',
  10,
);

export interface ReapResult {
  reaped: number;
  byEntity: Record<string, number>;
  alerted: boolean;
  errors: string[];
}

/**
 * Post a system-class alert to GroupMe.
 *
 * Best-effort and never throws: a failed alert must not fail the reaper, or
 * we'd be back to losing the cleanup for a monitoring problem. Silently no-ops
 * when GROUPME_BOT_ID is unset (local dev / test).
 */
async function postGroupMeAlert(text: string): Promise<boolean> {
  const botId = process.env.GROUPME_BOT_ID;
  if (!botId) {
    console.warn('[SyncReaper] GROUPME_BOT_ID not set — skipping alert');
    return false;
  }

  try {
    const res = await fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: botId, text }),
    });
    if (!res.ok) {
      console.error(`[SyncReaper] GroupMe alert failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[SyncReaper] GroupMe alert threw: ${msg}`);
    return false;
  }
}

/**
 * Find and fail every sync_log row stuck in 'running' past the timeout.
 *
 * Two-step (select ids, then update by id) rather than a single conditional
 * UPDATE so we can report exactly what was reaped and group it by entity for
 * the alert. The window is small enough that the extra round trip is free.
 *
 * The written error_message is intentionally explicit about the mechanism so
 * whoever reads sync_log later doesn't have to rediscover the runJob race.
 */
export async function reapStaleSyncRuns(): Promise<ReapResult> {
  const supabase = getSupabaseClient();
  const errors: string[] = [];
  const byEntity: Record<string, number> = {};

  const cutoffIso = new Date(Date.now() - REAPER_TIMEOUT_MINUTES * 60_000).toISOString();

  const { data: stale, error: selectError } = await supabase
    .from('sync_log')
    .select('id, entity_type, started_at')
    .eq('status', 'running')
    .lt('started_at', cutoffIso);

  if (selectError) {
    const msg = `select stale runs: ${selectError.message}`;
    console.error(`[SyncReaper] ${msg}`);
    return { reaped: 0, byEntity, alerted: false, errors: [msg] };
  }

  if (!stale || stale.length === 0) {
    console.log(`[SyncReaper] No stale runs (cutoff ${REAPER_TIMEOUT_MINUTES}m)`);
    return { reaped: 0, byEntity, alerted: false, errors };
  }

  const now = nowET();
  let reaped = 0;

  for (const row of stale) {
    const entity = (row as { entity_type: string }).entity_type;
    const id = (row as { id: string }).id;
    const startedAt = (row as { started_at: string }).started_at;

    const ageMin = Math.round((Date.now() - Date.parse(startedAt)) / 60_000);

    const { error: updateError } = await supabase
      .from('sync_log')
      .update({
        status: 'failed',
        completed_at: now,
        error_message:
          `Reaped by sync-reaper after ${ageMin}m in 'running' ` +
          `(threshold ${REAPER_TIMEOUT_MINUTES}m). The job never called ` +
          `logSyncComplete/logSyncFailed — most likely the scheduler's ` +
          `Promise.race hard timeout fired and abandoned the pending inner ` +
          `promise, or the container was terminated mid-sync. This row was ` +
          `orphaned, not genuinely long-running.`,
      })
      .eq('id', id)
      // Re-assert status in the WHERE clause so we can't clobber a row that
      // completed between our SELECT and this UPDATE.
      .eq('status', 'running');

    if (updateError) {
      const msg = `reap ${entity}/${id}: ${updateError.message}`;
      errors.push(msg);
      console.error(`[SyncReaper] ${msg}`);
      continue;
    }

    reaped++;
    byEntity[entity] = (byEntity[entity] || 0) + 1;
  }

  const summary = Object.entries(byEntity)
    .sort((a, b) => b[1] - a[1])
    .map(([e, n]) => `${e}:${n}`)
    .join(', ');

  console.log(`[SyncReaper] Reaped ${reaped} stale run(s) — ${summary || 'none'}`);

  let alerted = false;
  if (reaped > REAPER_ALERT_THRESHOLD) {
    const worst = Object.entries(byEntity).sort((a, b) => b[1] - a[1])[0];
    alerted = await postGroupMeAlert(
      `[SYSTEM] Sync reaper: ${reaped} sync runs orphaned in 'running' and marked failed ` +
      `(threshold ${REAPER_ALERT_THRESHOLD}).\n` +
      `Breakdown: ${summary}\n` +
      `Worst offender: ${worst[0]} (${worst[1]}).\n` +
      `This means that job is exceeding its hard timeout repeatedly — check ` +
      `JOB_TIMEOUTS_MS and the job's slow path. Reaped rows are cleanup, not the fix.`,
    );
  }

  return { reaped, byEntity, alerted, errors };
}

/**
 * Startup sweep. Any row still 'running' at boot is definitionally orphaned —
 * this process just started, so nothing it owns can be in flight.
 *
 * Uses a 0-minute cutoff via a direct query rather than reusing
 * reapStaleSyncRuns, because at boot we do not want to wait out the 30-minute
 * window to clear rows a crash left behind. Mirrors the "Stale lock — cleaned
 * up on boot" pattern already proven in LP-MCP's sync_log.
 */
export async function reapOnBoot(): Promise<ReapResult> {
  const supabase = getSupabaseClient();
  const errors: string[] = [];
  const byEntity: Record<string, number> = {};

  const { data: stale, error: selectError } = await supabase
    .from('sync_log')
    .select('id, entity_type, started_at')
    .eq('status', 'running');

  if (selectError) {
    const msg = `boot select: ${selectError.message}`;
    console.error(`[SyncReaper] ${msg}`);
    return { reaped: 0, byEntity, alerted: false, errors: [msg] };
  }

  if (!stale || stale.length === 0) {
    console.log('[SyncReaper] Boot sweep: no orphaned runs');
    return { reaped: 0, byEntity, alerted: false, errors };
  }

  const now = nowET();
  let reaped = 0;

  for (const row of stale) {
    const entity = (row as { entity_type: string }).entity_type;
    const id = (row as { id: string }).id;

    const { error: updateError } = await supabase
      .from('sync_log')
      .update({
        status: 'failed',
        completed_at: now,
        error_message: 'Stale run — cleaned up on boot (process restarted while sync was in flight)',
      })
      .eq('id', id)
      .eq('status', 'running');

    if (updateError) {
      errors.push(`boot reap ${entity}/${id}: ${updateError.message}`);
      continue;
    }

    reaped++;
    byEntity[entity] = (byEntity[entity] || 0) + 1;
  }

  const summary = Object.entries(byEntity).map(([e, n]) => `${e}:${n}`).join(', ');
  console.log(`[SyncReaper] Boot sweep: reaped ${reaped} orphaned run(s) — ${summary || 'none'}`);

  return { reaped, byEntity, alerted: false, errors };
}
