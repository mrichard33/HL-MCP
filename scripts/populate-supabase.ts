#!/usr/bin/env npx tsx
/**
 * Initial Supabase Population Script
 *
 * Fetches all data from GoHighLevel and populates Supabase tables.
 * Safe to re-run (all operations use upserts).
 *
 * Usage:
 *   npm run populate
 *   npm run populate -- --lookback-days 180 --forward-days 90
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Load .env file if present (no external dependency needed)
const envPath = resolve(import.meta.dirname || '.', '..', '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

import {
  syncContacts,
  syncOpportunities,
  syncAppointments,
  syncPipelines,
  syncConversationsAndMessages,
  computeFunnelProgression,
} from '../src/extractor/entity-syncer.js';
import { extractAndSyncWorkflows } from '../src/extractor/workflow-extractor.js';

// ---- CLI Argument Parsing ----

function getArgValue(flag: string, defaultValue: number): number {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return defaultValue;
  const val = parseInt(process.argv[idx + 1], 10);
  return isNaN(val) ? defaultValue : val;
}

const lookbackDays = getArgValue('--lookback-days', 365);
const forwardDays = getArgValue('--forward-days', 60);

// ---- Environment Validation ----

const requiredEnvVars = ['GHL_API_KEY', 'GHL_LOCATION_ID', 'SUPABASE_URL'];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);

if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_ANON_KEY) {
  missingVars.push('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY');
}

if (missingVars.length > 0) {
  console.error('Missing required environment variables:');
  missingVars.forEach((v) => console.error(`  - ${v}`));
  console.error('\nSee .env.example for configuration details.');
  process.exit(1);
}

// ---- Sync Steps ----

interface SyncStep {
  name: string;
  fn: () => Promise<unknown>;
}

const steps: SyncStep[] = [
  {
    name: 'Pipelines',
    fn: () => syncPipelines(),
  },
  {
    name: 'Contacts',
    fn: () => syncContacts(),
  },
  {
    name: 'Opportunities',
    fn: () => syncOpportunities(),
  },
  {
    name: 'Appointments',
    fn: () =>
      syncAppointments({
        startTime: new Date(Date.now() - lookbackDays * 86_400_000).toISOString(),
        endTime: new Date(Date.now() + forwardDays * 86_400_000).toISOString(),
      }),
  },
  {
    name: 'Conversations & Messages',
    fn: () => syncConversationsAndMessages(),
  },
  {
    name: 'Workflows (steps, triggers, actions, connections)',
    fn: () => extractAndSyncWorkflows(),
  },
  {
    name: 'Funnel Progression',
    fn: () => computeFunnelProgression(),
  },
];

// ---- Main ----

async function main(): Promise<void> {
  const startDate = new Date(Date.now() - lookbackDays * 86_400_000);
  const endDate = new Date(Date.now() + forwardDays * 86_400_000);

  console.log('='.repeat(60));
  console.log('  GoHighLevel -> Supabase: Initial Population');
  console.log('='.repeat(60));
  console.log(`  Appointment range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`  Steps: ${steps.length}`);
  console.log('='.repeat(60));
  console.log();

  const results: { name: string; status: string; detail: string; duration: number }[] = [];
  let hasFailure = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepNum = `[${i + 1}/${steps.length}]`;
    console.log(`${stepNum} Syncing ${step.name}...`);
    const t0 = Date.now();

    try {
      const result = await step.fn();
      const duration = (Date.now() - t0) / 1000;
      const detail = summarizeResult(result);
      console.log(`${stepNum} ${step.name} completed in ${duration.toFixed(1)}s — ${detail}`);
      results.push({ name: step.name, status: 'OK', detail, duration });
    } catch (err) {
      const duration = (Date.now() - t0) / 1000;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${stepNum} ${step.name} FAILED in ${duration.toFixed(1)}s — ${msg}`);
      results.push({ name: step.name, status: 'FAILED', detail: msg, duration });
      hasFailure = true;
    }

    console.log();
  }

  // Print summary
  console.log('='.repeat(60));
  console.log('  Summary');
  console.log('='.repeat(60));

  for (const r of results) {
    const icon = r.status === 'OK' ? '[OK]' : '[FAIL]';
    console.log(`  ${icon} ${r.name.padEnd(42)} ${r.detail}`);
  }

  console.log();
  console.log('NOTE: workflow_executions cannot be populated from API.');
  console.log('      It is filled via the log_workflow_execution MCP tool and webhook events.');
  console.log();

  if (hasFailure) {
    console.error('Some steps failed. Check logs above for details.');
    process.exit(1);
  } else {
    console.log('All steps completed successfully.');
  }
}

function summarizeResult(result: unknown): string {
  if (!result || typeof result !== 'object') return 'done';
  const r = result as Record<string, unknown>;

  const parts: string[] = [];
  if ('synced' in r) parts.push(`${r.synced} synced`);
  if ('synced_conversations' in r) parts.push(`${r.synced_conversations} conversations`);
  if ('synced_messages' in r) parts.push(`${r.synced_messages} messages`);
  if ('workflows_synced' in r) parts.push(`${r.workflows_synced} workflows`);
  if ('steps_synced' in r) parts.push(`${r.steps_synced} steps`);
  if ('triggers_synced' in r) parts.push(`${r.triggers_synced} triggers`);
  if ('actions_synced' in r) parts.push(`${r.actions_synced} actions`);
  if ('computed' in r) parts.push(`${r.computed} contacts computed`);

  const errorCount = Array.isArray(r.errors) ? r.errors.length : 0;
  if (errorCount > 0) parts.push(`${errorCount} errors`);

  return parts.length > 0 ? parts.join(', ') : 'done';
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
