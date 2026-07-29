import cron from 'node-cron';
import { extractAndSyncWorkflows } from './workflow-extractor.js';
import { syncTemplates } from './template-syncer.js';
import { toET } from '../utils/timezone.js';
import {
  syncContacts,
  syncOpportunities,
  syncAppointments,
  syncPipelines,
  syncConversationsAndMessages,
  computeFunnelProgression,
  syncCustomFields,
  syncCustomValues,
  syncTags,
  syncTriggerLinks,
} from './entity-syncer.js';
import { reapStaleSyncRuns, reapOnBoot } from './sync-reaper.js';
import { withBoundedRetry } from '../utils/retry.js';
import { getSupabaseClient } from '../clients/supabase.js';

/** Track running state per job to prevent concurrent runs. */
const runningJobs = new Map<string, boolean>();

function isJobRunning(name: string): boolean {
  return runningJobs.get(name) === true;
}

/**
 * Per-job hard timeout (milliseconds).
 *
 * v1.7: The previous `runJob` had no timeout. When a job's inner promise
 * never settled — most commonly because a Supabase RPC or a chained GHL
 * fetch stalled beneath the fetch-level timeout in clients/ghl.ts — the
 * `runningJobs` mutex stayed `true` forever. Every subsequent every-15-minute
 * cron fire saw `isJobRunning(name) === true` and silently skipped. Result:
 * contacts, opportunities, appointments, conversations, and messages
 * all stopped advancing for days at a time (Apr 7 / Apr 9 / Apr 22 freezes
 * all matched this signature — 0% failure rate because hung jobs are
 * neither failed nor completed).
 *
 * The fix is a Promise.race between the job body and a rejecting timer.
 * When the timer wins, we throw, the catch logs it, and finally releases
 * the mutex so the next cron fire can take over. Background work from
 * the lost race may continue briefly (we don't abort its fetches) but
 * it will self-terminate when its own fetch timeouts expire, and any
 * duplicate Supabase upserts are idempotent (ON CONFLICT keys set on all
 * synced tables). Trading "possible brief overlap" for "no permanent
 * deadlock" is the right call.
 *
 * v1.9 (2026-07-20) — KNOWN SIDE EFFECT of the above, now mitigated.
 * When the timeout wins the race, the abandoned inner promise never reaches
 * its own try/catch, so `logSyncFailed()` is never called and the `sync_log`
 * row inserted by `logSyncStart()` stays `status='running'` permanently.
 * Observed: 57 orphaned opportunities rows in a 24h window against only 31
 * completed. Two consequences, both bad:
 *   1. sync_log grows a permanent population of zombie rows.
 *   2. get_sync_health computes failure_rate as failed/total — orphans are
 *      neither, so a job timing out on most cycles still reported ~1.4%
 *      healthy. The monitoring was blind to its most common failure.
 * Mitigated by src/extractor/sync-reaper.ts (boot sweep + 30-min cron).
 * The reaper is cleanup, NOT a fix for whatever is making a job slow — if
 * you see the GroupMe alert firing, go find the slow path.
 *
 * v2.0 (2026-07-28) — opportunities raised 10 min → 20 min. This ceiling
 * was not a safety margin, it was a guillotine: the job's real runtime is
 * ~18 min (measured: a completed run 18:15:00 → 18:33:08 ET = 1088s), so
 * the 10-min timeout fired on essentially every cycle. Measured over 24h:
 * 96 runs, 84 failed (87.5%), 11 completed — and those 11 "completions"
 * were abandoned promises finishing AFTER the scheduler had already
 * declared the run failed and released the mutex. Every other entity in
 * the same window sat at 0-1%.
 *
 * WHY the job needs ~18 min is a separate, deeper defect documented on the
 * cron below: the server-side incremental filter 422s on every call, so
 * every cycle silently falls back to fetching all ~15k opportunities.
 * 20 min matches observed reality with headroom; it stays under the
 * 30-min sync-reaper threshold, so a genuinely hung job is still caught.
 * Override via JOB_TIMEOUT_MS_OPPORTUNITIES if the fallback path is ever
 * removed and the job gets fast again.
 *
 * Timeouts are sized to the realistic upper bound of a healthy sync:
 *   - workflows: 234 workflows × ~5s each = ~20 min observed; 30 min ceiling.
 *   - contacts: full mode is ~38 pages × rate limit = a few minutes;
 *     10 min ceiling is generous.
 *   - opportunities: see v2.0 note above — 20 min, matched to the
 *     client-diff fallback's measured ~18 min.
 *   - appointments: 2-week/30-day window is tiny (<1 min); 10 min ceiling
 *     covers the first-run 1-year backfill.
 *   - conversations: v1.7 watermark walk is typically <1 min per 15-min
 *     cycle. 15 min ceiling is very generous.
 *   - sync_reaper: Supabase-only, no GHL calls, touches at most a few dozen
 *     rows. 2 min is already generous.
 *   - Everything else defaults to 10 min.
 *
 * Override any job via env: JOB_TIMEOUT_MS_{NAME_UPPERCASED}
 *   e.g. JOB_TIMEOUT_MS_CONVERSATIONS=1800000 for 30 min.
 */
const JOB_TIMEOUTS_MS: Record<string, number> = {
  workflows: 30 * 60 * 1000,
  contacts: 10 * 60 * 1000,
  opportunities: 20 * 60 * 1000,
  appointments: 10 * 60 * 1000,
  conversations: 15 * 60 * 1000,
  funnel_progression: 5 * 60 * 1000,
  pipelines: 5 * 60 * 1000,
  custom_fields: 5 * 60 * 1000,
  custom_values: 5 * 60 * 1000,
  tags: 5 * 60 * 1000,
  trigger_links: 5 * 60 * 1000,
  templates: 5 * 60 * 1000,
  sync_reaper: 2 * 60 * 1000,
};
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;

function getJobTimeoutMs(name: string): number {
  const envKey = `JOB_TIMEOUT_MS_${name.toUpperCase()}`;
  const envVal = process.env[envKey];
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return JOB_TIMEOUTS_MS[name] ?? DEFAULT_JOB_TIMEOUT_MS;
}

async function runJob(name: string, fn: () => Promise<unknown>): Promise<void> {
  if (isJobRunning(name)) {
    console.warn(`[Scheduler] ${name} already in progress, skipping`);
    return;
  }

  runningJobs.set(name, true);
  const startTime = Date.now();
  const timeoutMs = getJobTimeoutMs(name);

  // v1.7: Hard timeout via Promise.race. Guarantees mutex release even if
  // the inner promise never settles (see JOB_TIMEOUTS_MS doc comment above).
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(
        `[Scheduler] ${name} exceeded ${Math.round(timeoutMs / 1000)}s hard timeout — aborting to release mutex. ` +
        `Background work may continue until its own fetch timeouts expire. ` +
        `Its sync_log row will be left 'running' and cleaned up by sync-reaper. ` +
        `Override via env JOB_TIMEOUT_MS_${name.toUpperCase()}.`,
      ));
    }, timeoutMs);
  });

  try {
    console.log(`[Scheduler] Starting ${name}... (timeout: ${Math.round(timeoutMs / 1000)}s)`);
    await Promise.race([fn(), timeoutPromise]);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Scheduler] ${name} completed in ${duration}s`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Scheduler] ${name} failed: ${msg}`);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    runningJobs.set(name, false);
  }
}

/** Small helper used by the serialized boot chain. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if a specific entity has ever been successfully synced.
 * The migration seeds sync_state rows with last_synced_at='1970-01-01',
 * so we check whether the timestamp has been updated from the default.
 */
async function isFirstRunFor(entityName: string): Promise<boolean> {
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('sync_state')
      .select('last_synced_at')
      .eq('entity_name', entityName)
      .single();
    if (!data) return true;
    // Still at epoch default means never synced
    const ts = data.last_synced_at as string;
    return ts.startsWith('1970-01-01');
  } catch {
    return true;
  }
}

/**
 * Starts all scheduled sync jobs.
 *
 * v1.7 sync architecture:
 *   - Real-time: GHL webhooks (handled in src/webhooks/handler.ts)
 *   - Incremental: contacts every 15 min, opportunities every 30 min
 *     (v2.0 — see the opportunities cron below). Contacts uses
 *     POST /contacts/search with a dateUpdated filter; opportunities uses a
 *     client-side diff against Supabase's date_updated column.
 *   - Full reconcile: daily at 3:05 / 3:10 AM America/New_York for contacts
 *     and opportunities respectively. Runs softDeleteMissing and corrects
 *     any drift that webhooks + incremental missed. The minute offsets of 5
 *     and 10 are deliberate: they keep the daily crons off the every-15-minute
 *     boundary (:00/:15/:30/:45) so they can't collide with the recurring
 *     incremental cron and get skipped by the shared job-name mutex.
 *   - Time-windowed: appointments every 15 min (already bounded to a
 *     2-week back / 30-day forward window).
 *   - Watermark: conversations/messages every 15 min using v1.7 watermark
 *     walk — DESC by last_message_date, stop at floor.
 *   - Low-volume config: pipelines, custom_fields, custom_values, tags,
 *     trigger_links, templates every 6 hours. These rarely change; 30-min
 *     cadence was overkill.
 *   - Synthetic: workflows + funnel_progression hourly.
 *   - Hygiene: sync_reaper every 30 min (v1.9).
 *
 * On first run (no prior sync_state), appointments use a 1-year lookback
 * to backfill historical data. Subsequent runs use the normal 2-week
 * back / 30-day forward window.
 *
 * v1.7: runJob now enforces a per-job hard timeout (see JOB_TIMEOUTS_MS)
 * so a stalled inner promise can never permanently pin the mutex.
 *
 * v1.8 — Boot-time entity syncs are now SERIALIZED for the four
 * bucket-heavy ones (contacts, opportunities, appointments, conversations).
 * The previous fan-out pattern (5-second setTimeout stagger) launched all
 * four within 25s of boot, and each one needed 27-38 API calls, which
 * instantly drained the 40-token bucket and triggered a 429 from GHL. The
 * rate limiter then paused every queued caller for 5+ minutes, which
 * manifested as the post-deploy "everything stuck running" symptom we saw
 * after the 1a744e2a deploy. Running them sequentially instead lets each
 * get full bucket access, so none of them get throttled and all four
 * complete in less total wall time than the broken parallel version ever
 * did.
 *
 * v1.9 (2026-07-20) — Two additions, both driven by a single day's sync_log:
 *   - sync-reaper: boot sweep + 30-min cron to fail rows orphaned in
 *     'running' by the v1.7 timeout race (57 orphans/24h on opportunities).
 *   - withBoundedRetry around opportunities: 8 hard failures in 24h were all
 *     transient "GHL API error 500", retried zero times, each costing a full
 *     15-minute cycle.
 *
 * v2.0 (2026-07-28) — opportunities incremental moved off the every-15-minute
 * boundary to :20/:50, and its job timeout raised 10 min → 20 min. The v1.8 note
 * below said "if we ever see 429s on recurring cycles, serialize this block
 * the same way boot was" — that day arrived, but the honest fix turned out
 * to be cadence + ceiling rather than serialization. See the cron comment.
 */
export function startScheduledSync(): void {
  console.log('[Scheduler] Starting scheduled sync jobs (v2.0)');

  // One-time diagnostic: Firebase auth status affects workflow data quality
  const hasFirebaseAuth = !!(process.env.GHL_FIREBASE_API_KEY && process.env.GHL_FIREBASE_REFRESH_TOKEN);
  if (hasFirebaseAuth) {
    console.log('[Scheduler] Firebase auth configured — workflows will use internal API for full node graph data');
  } else {
    console.warn(
      '[Scheduler] Firebase auth NOT configured — workflow sync will use public API (no steps/node graphs). ' +
      'Set GHL_FIREBASE_API_KEY and GHL_FIREBASE_REFRESH_TOKEN for full data.',
    );
  }

  // Diagnostic: GHL OAuth for conversations/messages sync
  const hasGhlOAuth = !!(process.env.GHL_OAUTH_CLIENT_ID && process.env.GHL_OAUTH_CLIENT_SECRET);
  if (hasGhlOAuth) {
    console.log('[Scheduler] GHL OAuth configured — conversations/messages sync enabled');
  } else {
    console.warn(
      '[Scheduler] GHL OAuth NOT configured — conversations/messages will NOT sync. ' +
      'Set GHL_OAUTH_CLIENT_ID and GHL_OAUTH_CLIENT_SECRET, then visit /crm-oauth/authorize.',
    );
  }

  // v1.6: Surface the incremental overlap buffer for easy verification in logs.
  const incrementalOverlap = parseInt(process.env.INCREMENTAL_SYNC_OVERLAP_MINUTES || '10', 10);
  console.log(`[Scheduler] Incremental sync overlap buffer: ${incrementalOverlap} min (override via INCREMENTAL_SYNC_OVERLAP_MINUTES)`);

  // v2.0: The opportunities incremental now runs every 30 min. Its overlap
  // buffer must stay comfortably under that gap or changes can fall between
  // cycles. Warn loudly rather than fail — the daily full reconcile still
  // backstops any gap, but a silent 30-min hole is worth surfacing.
  if (incrementalOverlap < 10) {
    console.warn(
      `[Scheduler] INCREMENTAL_SYNC_OVERLAP_MINUTES=${incrementalOverlap} is below the recommended 10 min. ` +
      'Opportunities now sync every 30 min (v2.0); a short overlap risks missing edge-of-window updates.',
    );
  }

  // v1.7: Surface per-job timeout ceilings so hangs are easier to diagnose.
  const timeoutSummary = Object.entries(JOB_TIMEOUTS_MS)
    .map(([n, ms]) => `${n}:${Math.round(ms / 60000)}m`)
    .join(', ');
  console.log(`[Scheduler] Per-job hard timeouts: ${timeoutSummary}, default:${Math.round(DEFAULT_JOB_TIMEOUT_MS / 60000)}m (override via JOB_TIMEOUT_MS_{NAME})`);

  // v1.9: Surface reaper config.
  console.log(
    `[Scheduler] Sync reaper: timeout ${process.env.SYNC_REAPER_TIMEOUT_MINUTES || '30'}m, ` +
    `alert threshold ${process.env.SYNC_REAPER_ALERT_THRESHOLD || '5'} ` +
    `(override via SYNC_REAPER_TIMEOUT_MINUTES / SYNC_REAPER_ALERT_THRESHOLD)`,
  );

  // Run initial sync with first-run detection
  (async () => {
    // v1.9: Boot sweep FIRST, before any job starts. Anything still marked
    // 'running' at this point is definitionally orphaned — this process just
    // started, so nothing it owns can be in flight. Clearing these before the
    // boot chain keeps the reaper's later counts meaningful (otherwise the
    // first 30-min pass would reap a pile of pre-restart rows and trip the
    // GroupMe alert for what is really just a redeploy).
    try {
      await reapOnBoot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] Boot reap failed (non-fatal): ${msg}`);
    }

    const appointmentsFirstRun = await isFirstRunFor('appointments');
    if (appointmentsFirstRun) {
      console.log('[Scheduler] First appointment sync detected — will perform 1-year historical backfill');
    }

    // ─── Parallel: low-bucket jobs ──────────────────────────────────
    //
    // Workflows uses the Firebase backend API for per-workflow details
    // (not the rate-limited bucket) — safe to start immediately alongside
    // short config syncs. Short syncs each cost 1-5 bucket tokens and
    // complete in seconds, so parallel fan-out here is fine.

    runJob('workflows', async () => {
      const result = await extractAndSyncWorkflows();
      console.log(
        `[Scheduler] Workflows: ${result.workflows_synced} synced, ` +
        `${result.steps_synced} steps, ${result.triggers_synced} triggers, ` +
        `${result.actions_synced} actions, ${result.snapshots_created} snapshots`,
      );
      if (result.errors.length > 0) {
        console.error(`[Scheduler] Workflow errors: ${result.errors.join('; ')}`);
      }
    });

    setTimeout(() => runJob('pipelines', syncPipelines), 5_000);
    setTimeout(() => runJob('custom_fields', syncCustomFields), 10_000);
    setTimeout(() => runJob('custom_values', syncCustomValues), 15_000);
    setTimeout(() => runJob('tags', syncTags), 20_000);
    setTimeout(() => runJob('trigger_links', syncTriggerLinks), 25_000);
    setTimeout(() => runJob('templates', syncTemplates), 30_000);

    // ─── Serialized: bucket-heavy boot-time syncs ──────────────────
    //
    // v1.8: contacts/opportunities/appointments/conversations each need
    // many tokens in full mode (contacts full: 38 pages, opps full: 27
    // pages, convs first-run backfill: up to ~300 conversations × 1-2
    // message pages each). Running them in parallel guarantees 429s and
    // a rate-limiter pause. Serialize them so each gets uncontested
    // bucket access, and push the first big sync off until 45s after
    // boot so the parallel shorts above have cleared the initial bucket
    // usage.
    (async () => {
      await sleep(45_000);
      console.log('[Scheduler] v1.8: starting serialized boot chain (contacts → opportunities → appointments → conversations)');

      await runJob('contacts', () => syncContacts({ mode: 'full' }));

      await runJob('opportunities', () => withBoundedRetry(
        () => syncOpportunities({ mode: 'full' }),
        { label: 'syncOpportunities(boot/full)' },
      ));

      await runJob('appointments', () => {
        if (appointmentsFirstRun) {
          return syncAppointments({
            startTime: toET(Date.now() - 365 * 86_400_000),
            endTime: toET(Date.now() + 60 * 86_400_000),
          });
        }
        return syncAppointments();
      });

      await runJob('conversations', async () => {
        const result = await syncConversationsAndMessages();
        console.log(
          `[Scheduler] Conversations: ${result.synced_conversations}, Messages: ${result.synced_messages}`,
        );
      });

      console.log('[Scheduler] v1.8: serialized boot chain complete');
    })();

    // Funnel progression runs after boot chain typically completes (2 min).
    // Not bucket-heavy (Supabase-only), so independent timer is fine.
    setTimeout(() => runJob('funnel_progression', computeFunnelProgression), 120_000);
  })();

  // ─── Recurring jobs ──────────────────────────────────────────────

  // v1.5: Workflow sync cadence reduced from every-10-min to hourly. Workflow
  // definitions change rarely; hourly is plenty and reduces Firebase/GHL
  // internal-API load. Funnel progression also hourly — same top-of-hour slot.
  cron.schedule('0 * * * *', () => {
    runJob('workflows', async () => {
      const result = await extractAndSyncWorkflows();
      console.log(
        `[Scheduler] Workflows: ${result.workflows_synced} synced, ${result.snapshots_created} snapshots`,
      );
    });
  });

  cron.schedule('0 * * * *', () => {
    runJob('funnel_progression', computeFunnelProgression);
  });

  // v1.9: Stale-run reaper every 30 minutes.
  //
  // Offset to :07/:37 deliberately. The 15-min sync crons fire at
  // :00/:15/:30/:45; running the reaper on those same boundaries risks
  // reading sync_log mid-write and, worse, could reap a row belonging to a
  // job that had only just started. :07 and :37 sit well clear of every
  // other scheduled job in this file.
  cron.schedule('7,37 * * * *', () => {
    runJob('sync_reaper', reapStaleSyncRuns);
  });

  // v1.6: 15-min cadence for contacts now runs in INCREMENTAL mode. Pulls
  // only records with dateUpdated >= (last_synced_at - overlap).
  //
  // Contacts genuinely is cheap: POST /contacts/search honours the
  // dateUpdated filter, so a normal cycle is a handful of calls and
  // finishes in ~7s (measured avg over 24h: 96/97 runs completed).
  cron.schedule('*/15 * * * *', () => {
    runJob('contacts', () => syncContacts({ mode: 'incremental' }));
  });

  // v2.0 (2026-07-28): opportunities incremental moved from */15 to :20/:50.
  //
  // WHY THE CADENCE CHANGED. This job is not cheap, and the comment that
  // said it was ("opps incremental: full list fetch + client-side diff,
  // ~27 calls") was describing an opportunity book a quarter of today's
  // size. Two compounding facts:
  //
  //   1. The server-side filter is DEAD. Every cycle logs
  //        syncOpportunities: server-side search failed
  //        (GHL API error 422: {"message":"Invalid field - dateUpdated"})
  //      POST /opportunities/search rejects the dateUpdated filter on this
  //      tenant and always has — the "fast path" added in v1.8 (T2.3b) has
  //      never once succeeded. Its fallback was designed for occasional
  //      failure, so nothing ever flagged that the fallback had quietly
  //      become the ONLY path.
  //   2. The fallback fetches EVERYTHING. getAllOpportunities() pages the
  //      whole location — ~14.9k opportunities at 100/page ≈ 150
  //      rate-limited GHL calls — then paginates Supabase for a
  //      date_updated map and diffs client-side. Measured runtime ~18 min,
  //      against a 15-min cron and a 10-min job ceiling.
  //
  // The result was a job mathematically guaranteed to fail: 96 runs/24h,
  // 84 failed (87.5%), while every other entity sat at 0-1%. It also
  // meant ~150 GHL calls every 15 min contending with contacts,
  // appointments and conversations on the same :00/:15/:30/:45 boundary.
  //
  // :20/:50 is chosen to clear every other job in this file — the 15-min
  // boundary, the reaper at :07/:37, and the 3:05/3:10 ET daily fulls —
  // so the heavy fetch runs uncontended. 30 min also exceeds the measured
  // 18-min runtime with real headroom, and pairs with the 20-min job
  // ceiling above.
  //
  // TRADE-OFF, stated plainly: opportunity cache freshness goes from
  // ~15 min to ~30 min. The 10-min incremental overlap buffer means no
  // gap opens between cycles, and the 3:10 AM ET full reconcile still
  // handles drift and soft-deletes. Reporting that reads the
  // opportunities cache is unaffected at this resolution.
  //
  // THIS IS A MITIGATION, NOT THE CURE. The cure is a working server-side
  // filter, which would take this job back to seconds and let it return to
  // a 15-min (or faster) cadence. That needs the correct GHL field name
  // verified against the live API — do NOT guess it. Guessing `dateUpdated`
  // by analogy with the contacts DTO is precisely what produced a fast path
  // that 422'd silently for months.
  cron.schedule('20,50 * * * *', () => {
    runJob('opportunities', () => withBoundedRetry(
      () => syncOpportunities({ mode: 'incremental' }),
      { label: 'syncOpportunities(incremental)' },
    ));
  });

  // Appointments stays at 15 min — already time-windowed, very efficient.
  cron.schedule('*/15 * * * *', () => {
    runJob('appointments', syncAppointments);
  });

  // Conversations/messages stays at 15 min — v1.7 watermark walk is fast.
  cron.schedule('*/15 * * * *', () => {
    runJob('conversations', async () => {
      const result = await syncConversationsAndMessages();
      console.log(
        `[Scheduler] Conversations: ${result.synced_conversations}, Messages: ${result.synced_messages}`,
      );
    });
  });

  // v1.6: Daily full reconcile for contacts + opportunities in America/New_York.
  // Runs softDeleteMissing and corrects any drift that webhooks + incremental
  // missed. Using node-cron 4.x's timezone option so the job fires at the right
  // clock time year-round across the EST/EDT transition.
  //
  // IMPORTANT: Minute offsets are 5 and 10, NOT 0. A `0 3 * * *` daily cron
  // would collide with the every-15-min incremental cron (which fires at
  // :00/:15/:30/:45), and since both use the same job name the `runningJobs`
  // mutex would silently drop whichever fires second. If that happened to be
  // the daily full, we'd miss the nightly drift + soft-delete reconcile — the
  // whole point of having a daily full. Offsets to :05 and :10 keep the daily
  // crons off the 15-min boundary entirely. 3:10 ET for opportunities (rather
  // than running simultaneously with contacts) also avoids hammering the GHL
  // API with two concurrent full-fetch jobs at the same minute.
  //
  // v2.0: still correct after the opportunities incremental moved to :20/:50 —
  // 3:10 clears :20 and :50 by a wide margin, so the daily full can never be
  // dropped by the shared job-name mutex.
  cron.schedule('5 3 * * *', () => {
    console.log('[Scheduler] Daily 3:05 AM ET full reconcile — contacts');
    runJob('contacts', () => syncContacts({ mode: 'full' }));
  }, { timezone: 'America/New_York' });

  cron.schedule('10 3 * * *', () => {
    console.log('[Scheduler] Daily 3:10 AM ET full reconcile — opportunities');
    runJob('opportunities', () => withBoundedRetry(
      () => syncOpportunities({ mode: 'full' }),
      { label: 'syncOpportunities(daily/full)' },
    ));
  }, { timezone: 'America/New_York' });

  // v1.6: Low-volume config entities moved from every 30 min to every
  // 6 hours (00:00, 06:00, 12:00, 18:00 UTC). These rarely change;
  // 30-min cadence was overkill and contributed to Supabase write churn.
  cron.schedule('0 */6 * * *', () => {
    runJob('pipelines', syncPipelines);
  });

  cron.schedule('0 */6 * * *', () => {
    runJob('custom_fields', syncCustomFields);
  });

  cron.schedule('0 */6 * * *', () => {
    runJob('custom_values', syncCustomValues);
  });

  cron.schedule('0 */6 * * *', () => {
    runJob('tags', syncTags);
  });

  cron.schedule('0 */6 * * *', () => {
    runJob('trigger_links', syncTriggerLinks);
  });

  cron.schedule('0 */6 * * *', () => {
    runJob('templates', syncTemplates);
  });

  console.log('[Scheduler] Cron jobs registered (v2.0):');
  console.log('  0 * * * *          — workflows, funnel progression (hourly)');
  console.log('  7,37 * * * *       — sync reaper (stale running-run cleanup)');
  console.log('  */15 * * * *       — contacts (incremental), appointments, conversations/messages');
  console.log('  20,50 * * * *      — opportunities (incremental, bounded-retry) [v2.0: off the 15-min boundary, 30-min cadence]');
  console.log('  5 3 * * * ET       — contacts daily full reconcile (America/New_York)');
  console.log('  10 3 * * * ET      — opportunities daily full reconcile (America/New_York, bounded-retry)');
  console.log('  0 */6 * * *        — pipelines, custom_fields, custom_values, tags, trigger_links, templates (every 6 hr)');
}
