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
 * `runningJobs` mutex stayed `true` forever. Every subsequent `*/15` cron
 * fire saw `isJobRunning(name) === true` and silently skipped. Result:
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
 * Timeouts are sized to the realistic upper bound of a healthy sync:
 *   - workflows: 234 workflows × ~5s each = ~20 min observed; 30 min ceiling.
 *   - contacts / opportunities: full mode is ~38 pages × rate limit =
 *     a few minutes; 10 min ceiling is generous.
 *   - appointments: 2-week/30-day window is tiny (<1 min); 10 min ceiling
 *     covers the first-run 1-year backfill.
 *   - conversations: current conversations sync iterates up to
 *     MAX_CONTACTS_PER_SYNC contacts with batch + inter-conv delays and
 *     per-contact message fetches. Legitimately takes 10–15 min on backfill.
 *     20 min ceiling. Patch 2 (conversation-driven /conversations/search
 *     with a lastMessageDate watermark) will reduce this substantially.
 *   - Everything else defaults to 10 min.
 *
 * Override any job via env: JOB_TIMEOUT_MS_{NAME_UPPERCASED}
 *   e.g. JOB_TIMEOUT_MS_CONVERSATIONS=1800000 for 30 min.
 */
const JOB_TIMEOUTS_MS: Record<string, number> = {
  workflows: 30 * 60 * 1000,
  contacts: 10 * 60 * 1000,
  opportunities: 10 * 60 * 1000,
  appointments: 10 * 60 * 1000,
  conversations: 20 * 60 * 1000,
  funnel_progression: 5 * 60 * 1000,
  pipelines: 5 * 60 * 1000,
  custom_fields: 5 * 60 * 1000,
  custom_values: 5 * 60 * 1000,
  tags: 5 * 60 * 1000,
  trigger_links: 5 * 60 * 1000,
  templates: 5 * 60 * 1000,
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
 *   - Incremental: every 15 min for contacts + opportunities. Contacts uses
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
 *   - Smart round-robin: conversations/messages every 15 min (already
 *     drip-syncs by staleness).
 *   - Low-volume config: pipelines, custom_fields, custom_values, tags,
 *     trigger_links, templates every 6 hours. These rarely change; 30-min
 *     cadence was overkill.
 *   - Synthetic: workflows + funnel_progression hourly.
 *
 * On first run (no prior sync_state), appointments use a 1-year lookback
 * to backfill historical data. Subsequent runs use the normal 2-week
 * back / 30-day forward window.
 *
 * v1.7: runJob now enforces a per-job hard timeout (see JOB_TIMEOUTS_MS)
 * so a stalled inner promise can never permanently pin the mutex.
 */
export function startScheduledSync(): void {
  console.log('[Scheduler] Starting scheduled sync jobs (v1.7)');

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

  // v1.7: Surface per-job timeout ceilings so hangs are easier to diagnose.
  const timeoutSummary = Object.entries(JOB_TIMEOUTS_MS)
    .map(([n, ms]) => `${n}:${Math.round(ms / 60000)}m`)
    .join(', ');
  console.log(`[Scheduler] Per-job hard timeouts: ${timeoutSummary}, default:${Math.round(DEFAULT_JOB_TIMEOUT_MS / 60000)}m (override via JOB_TIMEOUT_MS_{NAME})`);

  // Run initial sync with first-run detection
  (async () => {
    const appointmentsFirstRun = await isFirstRunFor('appointments');
    if (appointmentsFirstRun) {
      console.log('[Scheduler] First appointment sync detected — will perform 1-year historical backfill');
    }

    // Run workflow sync immediately
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

    // v1.6: On-boot entity syncs run in FULL mode to establish a clean
    // baseline. Subsequent 15-min crons run in incremental mode.
    setTimeout(() => runJob('pipelines', syncPipelines), 5_000);
    setTimeout(() => runJob('contacts', () => syncContacts({ mode: 'full' })), 10_000);
    setTimeout(() => runJob('opportunities', () => syncOpportunities({ mode: 'full' })), 15_000);

    // Appointments: 1-year lookback on first run, 2-week default otherwise
    setTimeout(() => runJob('appointments', () => {
      if (appointmentsFirstRun) {
        return syncAppointments({
          startTime: toET(Date.now() - 365 * 86_400_000),
          endTime: toET(Date.now() + 60 * 86_400_000),
        });
      }
      return syncAppointments();
    }), 20_000);

    setTimeout(() => runJob('conversations', async () => {
      const result = await syncConversationsAndMessages();
      console.log(
        `[Scheduler] Conversations: ${result.synced_conversations}, Messages: ${result.synced_messages}`,
      );
    }), 25_000);

    // Low-volume config entity syncs on boot (staggered)
    setTimeout(() => runJob('custom_fields', syncCustomFields), 30_000);
    setTimeout(() => runJob('custom_values', syncCustomValues), 35_000);
    setTimeout(() => runJob('tags', syncTags), 40_000);
    setTimeout(() => runJob('trigger_links', syncTriggerLinks), 45_000);
    setTimeout(() => runJob('templates', syncTemplates), 50_000);

    // Run funnel computation after initial syncs complete (2 minutes)
    setTimeout(() => runJob('funnel_progression', computeFunnelProgression), 120_000);
  })();

  // ─── Recurring jobs ──────────────────────────────────────────────

  // v1.5: Workflow sync cadence reduced from */10 to hourly. Workflow
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

  // v1.6: 15-min cadence for contacts + opportunities now runs in INCREMENTAL
  // mode. Pulls only records with dateUpdated >= (last_synced_at - overlap)
  // for contacts, and skips unchanged-row upserts for opportunities.
  cron.schedule('*/15 * * * *', () => {
    runJob('contacts', () => syncContacts({ mode: 'incremental' }));
  });

  cron.schedule('*/15 * * * *', () => {
    runJob('opportunities', () => syncOpportunities({ mode: 'incremental' }));
  });

  // Appointments stays at 15 min — already time-windowed, very efficient.
  cron.schedule('*/15 * * * *', () => {
    runJob('appointments', syncAppointments);
  });

  // Conversations/messages stays at 15 min — already smart-scheduled (drip
  // by staleness with MAX_CONTACTS_PER_SYNC cap).
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
  // would collide with the `*/15 * * * *` incremental cron (which fires at
  // :00/:15/:30/:45), and since both use the same job name the `runningJobs`
  // mutex would silently drop whichever fired second. If that happened to be
  // the daily full, we'd miss the nightly drift + soft-delete reconcile — the
  // whole point of having a daily full. Offsets to :05 and :10 keep the daily
  // crons off the 15-min boundary entirely. 3:10 ET for opportunities (rather
  // than running simultaneously with contacts) also avoids hammering the GHL
  // API with two concurrent full-fetch jobs at the same minute.
  cron.schedule('5 3 * * *', () => {
    console.log('[Scheduler] Daily 3:05 AM ET full reconcile — contacts');
    runJob('contacts', () => syncContacts({ mode: 'full' }));
  }, { timezone: 'America/New_York' });

  cron.schedule('10 3 * * *', () => {
    console.log('[Scheduler] Daily 3:10 AM ET full reconcile — opportunities');
    runJob('opportunities', () => syncOpportunities({ mode: 'full' }));
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

  console.log('[Scheduler] Cron jobs registered (v1.7):');
  console.log('  0 * * * *          — workflows, funnel progression (hourly)');
  console.log('  */15 * * * *       — contacts (incremental), opportunities (incremental), appointments, conversations/messages');
  console.log('  5 3 * * * ET       — contacts daily full reconcile (America/New_York)');
  console.log('  10 3 * * * ET      — opportunities daily full reconcile (America/New_York)');
  console.log('  0 */6 * * *        — pipelines, custom_fields, custom_values, tags, trigger_links, templates (every 6 hr)');
}
