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

/** Track running state per job to prevent concurrent runs. */
const runningJobs = new Map<string, boolean>();

function isJobRunning(name: string): boolean {
  return runningJobs.get(name) === true;
}

async function runJob(name: string, fn: () => Promise<unknown>): Promise<void> {
  if (isJobRunning(name)) {
    console.error(`[Scheduler] ${name} already in progress, skipping`);
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
 * Starts all scheduled sync jobs:
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

  // Run workflow sync immediately, then every 10 minutes
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
  setTimeout(() => runJob('contacts', syncContacts), 5_000);
  setTimeout(() => runJob('opportunities', syncOpportunities), 10_000);
  setTimeout(() => runJob('appointments', syncAppointments), 15_000);
  setTimeout(() => runJob('pipelines', syncPipelines), 20_000);
  setTimeout(() => runJob('conversations', async () => {
    const result = await syncConversationsAndMessages();
    console.error(
      `[Scheduler] Conversations: ${result.synced_conversations}, Messages: ${result.synced_messages}`,
    );
  }), 25_000);

  // Run funnel computation after initial syncs complete (2 minutes)
  setTimeout(() => runJob('funnel_progression', computeFunnelProgression), 120_000);

  // Schedule recurring jobs
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
