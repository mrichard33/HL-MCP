import cron from 'node-cron';
import { extractAndSyncWorkflows } from './workflow-extractor.js';

let isRunning = false;

/**
 * Starts the scheduled workflow sync.
 * Runs every 10 minutes to maintain a real-time mirror of GHL automations.
 */
export function startScheduledSync(): void {
  console.error('[Scheduler] Starting workflow sync schedule (every 10 minutes)');

  // Run immediately on start
  runSync();

  // Schedule recurring sync
  cron.schedule('*/10 * * * *', () => {
    runSync();
  });
}

async function runSync(): Promise<void> {
  if (isRunning) {
    console.error('[Scheduler] Sync already in progress, skipping');
    return;
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    console.error('[Scheduler] Starting workflow extraction sync...');
    const result = await extractAndSyncWorkflows();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.error(
      `[Scheduler] Sync completed in ${duration}s — ` +
      `${result.workflows_synced} workflows, ` +
      `${result.steps_synced} steps, ` +
      `${result.triggers_synced} triggers, ` +
      `${result.actions_synced} actions, ` +
      `${result.snapshots_created} snapshots`
    );

    if (result.errors.length > 0) {
      console.error(`[Scheduler] Sync errors: ${result.errors.join('; ')}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Scheduler] Sync failed: ${msg}`);
  } finally {
    isRunning = false;
  }
}
