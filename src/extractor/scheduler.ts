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

async function runJob(name: string, fn: () => Promise<unknown>): Promise<void> {
  if (isJobRunning(name)) {
    console.warn(`[Scheduler] ${name} already in progress, skipping`);
    return;
  }

  runningJobs.set(name, true);
  const startTime = Date.now();

  try {
    console.log(`[Scheduler] Starting ${name}...`);
    await fn();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Scheduler] ${name} completed in ${duration}s`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Scheduler] ${name} failed: ${msg}`);
  } finally {
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
 * - Templates: every 30 minutes
 * - Funnel progression: every hour
 */
export function startScheduledSync(): void {
  console.log('[Scheduler] Starting scheduled sync jobs');

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

    // Run entity syncs immediately with staggered starts
    // Pipelines first (referenced by opportunities)
    setTimeout(() => runJob('pipelines', syncPipelines), 5_000);
    setTimeout(() => runJob('contacts', syncContacts), 10_000);
    setTimeout(() => runJob('opportunities', syncOpportunities), 15_000);

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

    // Run new entity syncs with staggered starts
    setTimeout(() => runJob('custom_fields', syncCustomFields), 30_000);
    setTimeout(() => runJob('custom_values', syncCustomValues), 35_000);
    setTimeout(() => runJob('tags', syncTags), 40_000);
    setTimeout(() => runJob('trigger_links', syncTriggerLinks), 45_000);

    // Templates: sync on startup (50s stagger)
    setTimeout(() => runJob('templates', syncTemplates), 50_000);

    // Run funnel computation after initial syncs complete (2 minutes)
    setTimeout(() => runJob('funnel_progression', computeFunnelProgression), 120_000);
  })();

  // Schedule recurring jobs (every 15 minutes for most entities)
  cron.schedule('*/10 * * * *', () => {
    runJob('workflows', async () => {
      const result = await extractAndSyncWorkflows();
      console.log(
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
      console.log(
        `[Scheduler] Conversations: ${result.synced_conversations}, Messages: ${result.synced_messages}`,
      );
    });
  });

  cron.schedule('*/30 * * * *', () => {
    runJob('custom_fields', syncCustomFields);
  });

  cron.schedule('*/30 * * * *', () => {
    runJob('custom_values', syncCustomValues);
  });

  cron.schedule('*/30 * * * *', () => {
    runJob('tags', syncTags);
  });

  cron.schedule('*/30 * * * *', () => {
    runJob('trigger_links', syncTriggerLinks);
  });

  // Templates: every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    runJob('templates', syncTemplates);
  });

  cron.schedule('0 * * * *', () => {
    runJob('funnel_progression', computeFunnelProgression);
  });

  console.log('[Scheduler] Cron jobs registered:');
  console.log('  */10 * * * * — workflows');
  console.log('  */15 * * * * — contacts, opportunities, appointments, conversations/messages');
  console.log('  */30 * * * * — pipelines, custom_fields, custom_values, tags, trigger_links, templates');
  console.log('  0 * * * *    — funnel progression');
}
