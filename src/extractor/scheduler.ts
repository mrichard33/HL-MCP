import cron from 'node-cron';
import { extractAndSyncWorkflows } from './workflow-extractor.js';
import {
  syncContacts,
  syncOpportunities,
  syncAppointments,
  syncPipelines,
  syncConversationsAndMessages,
  computeFunnelProgression,
} from './entity-syncer.js';
import { getSupabaseClient } from '../clients/supabase.js';

/** Track running state per job to prevent concurrent runs. */
const runningJobs = new Map<string, boolean>();

function isJobRunning(name: string): boolean {
  return runningJobs.get(name) === true;
}

async function runJob(name: string, fn: () => Promise<unknown>): Promise<void> {
  if (isJobRunning(name)) {
    console.warn(`[Scheduler] ${name} already in progress, skipping`);
    return;
  }

  runningJobs.set(name, true);
  const startTime = Date.now();

  try {
    console.error(`[Scheduler] Starting ${name}...`);
    await fn();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`[Scheduler] ${name} completed in ${duration}s`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Scheduler] ${name} failed: ${msg}`);
  } finally {
    runningJobs.set(name, false);
  }
}

/**
 * Check if this is the first time we're syncing (no sync_state records exist).
 * If so, use a wider appointment lookback to backfill historical data.
 */
async function isFirstRun(): Promise<boolean> {
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('sync_state')
      .select('entity_name')
      .limit(1);
    return !data || data.length === 0;
  } catch {
    // Table might not exist yet or connection issue — treat as first run
    return true;
  }
}

/**
 * Starts all scheduled sync jobs.
 *
 * On first run (no prior sync_state), appointments use a 1-year lookback
 * to backfill historical data. Subsequent runs use the normal 24h lookback.
 *
 * Schedule:
 * - Workflows: every 10 minutes
 * - Contacts: every 15 minutes
 * - Opportunities: every 15 minutes
 * - Appointments: every 15 minutes
 * - Pipelines: every 30 minutes
 * - Conversations & Messages: every 15 minutes
 * - Funnel progression: every hour
 */
export function startScheduledSync(): void {
  console.error('[Scheduler] Starting scheduled sync jobs');

  // One-time diagnostic: Firebase auth status affects workflow data quality
  const hasFirebaseAuth = !!(process.env.GHL_FIREBASE_API_KEY && process.env.GHL_FIREBASE_REFRESH_TOKEN);
  if (hasFirebaseAuth) {
    console.error('[Scheduler] Firebase auth configured — workflows will use internal API for full node graph data');
  } else {
    console.error(
      '[Scheduler] Firebase auth NOT configured — workflow sync will use public API (no steps/node graphs). ' +
      'Set GHL_FIREBASE_API_KEY and GHL_FIREBASE_REFRESH_TOKEN for full data.',
    );
  }

  // Run initial sync with first-run detection
  (async () => {
    const firstRun = await isFirstRun();
    if (firstRun) {
      console.error('[Scheduler] First run detected — performing full historical backfill');
    }

    // Run workflow sync immediately
    runJob('workflows', async () => {
      const result = await extractAndSyncWorkflows();
      console.error(
        `[Scheduler] Workflows: ${result.workflows_synced} synced, ` +
        `${result.steps_synced} steps, ${result.triggers_synced} triggers, ` +
        `${result.actions_synced} actions, ${result.snapshots_created} snapshots`,
      );
      if (result.errors.length > 0) {
        console.error(`[Scheduler] Workflow errors: ${result.errors.join('; ')}`);
      }
    });

    // Run entity syncs immediately with staggered starts
    // Pipelines first (referenced by opportunities)
    setTimeout(() => runJob('pipelines', syncPipelines), 5_000);
    setTimeout(() => runJob('contacts', syncContacts), 10_000);
    setTimeout(() => runJob('opportunities', syncOpportunities), 15_000);

    // Appointments: wider lookback on first run (1 year back, 60 days forward)
    setTimeout(() => runJob('appointments', () => {
      if (firstRun) {
        return syncAppointments({
          startTime: new Date(Date.now() - 365 * 86_400_000).toISOString(),
          endTime: new Date(Date.now() + 60 * 86_400_000).toISOString(),
        });
      }
      return syncAppointments();
    }), 20_000);

    setTimeout(() => runJob('conversations', async () => {
      const result = await syncConversationsAndMessages();
      console.error(
        `[Scheduler] Conversations: ${result.synced_conversations}, Messages: ${result.synced_messages}`,
      );
    }), 25_000);

    // Run funnel computation after initial syncs complete (2 minutes)
    setTimeout(() => runJob('funnel_progression', computeFunnelProgression), 120_000);
  })();

  // Schedule recurring jobs (every 15 minutes for most entities)
  cron.schedule('*/10 * * * *', () => {
    runJob('workflows', async () => {
      const result = await extractAndSyncWorkflows();
      console.error(
        `[Scheduler] Workflows: ${result.workflows_synced} synced, ${result.snapshots_created} snapshots`,
      );
    });
  });

  cron.schedule('*/15 * * * *', () => {
    runJob('contacts', syncContacts);
  });

  cron.schedule('*/15 * * * *', () => {
    runJob('opportunities', syncOpportunities);
  });

  cron.schedule('*/15 * * * *', () => {
    runJob('appointments', syncAppointments);
  });

  cron.schedule('*/30 * * * *', () => {
    runJob('pipelines', syncPipelines);
  });

  cron.schedule('*/15 * * * *', () => {
    runJob('conversations', async () => {
      const result = await syncConversationsAndMessages();
      console.error(
        `[Scheduler] Conversations: ${result.synced_conversations}, Messages: ${result.synced_messages}`,
      );
    });
  });

  cron.schedule('0 * * * *', () => {
    runJob('funnel_progression', computeFunnelProgression);
  });

  console.error('[Scheduler] Cron jobs registered:');
  console.error('  */10 * * * * — workflows');
  console.error('  */15 * * * * — contacts, opportunities, appointments, conversations/messages');
  console.error('  */30 * * * * — pipelines');
  console.error('  0 * * * *    — funnel progression');
}
