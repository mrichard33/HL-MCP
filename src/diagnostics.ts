import { getSupabaseClient } from './clients/supabase.js';

interface DiagnosticResult {
  status: 'ok' | 'warning' | 'error';
  message: string;
}

interface DiagnosticsReport {
  timestamp: string;
  overall: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    supabase_connection: DiagnosticResult;
    ghl_credentials: DiagnosticResult;
    ghl_api_reachable: DiagnosticResult;
    scheduled_sync_enabled: DiagnosticResult;
    table_row_counts: Record<string, number>;
    env_vars_present: Record<string, boolean>;
  };
  recommendations: string[];
}

const KEY_TABLES = [
  'contacts',
  'conversations',
  'messages',
  'opportunities',
  'workflows',
  'workflow_steps',
  'workflow_triggers',
  'workflow_actions',
  'workflow_connections',
  'workflow_executions',
  'appointments',
  'pipelines',
  'sync_log',
  'lead_events',
] as const;

const ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'GHL_API_KEY',
  'GHL_LOCATION_ID',
  'GHL_FIREBASE_API_KEY',
  'GHL_FIREBASE_REFRESH_TOKEN',
  'ENABLE_SCHEDULED_SYNC',
  'MCP_AUTH_TOKEN',
  'OAUTH_AUTHORIZE_SECRET',
] as const;

export async function runDiagnostics(): Promise<DiagnosticsReport> {
  const recommendations: string[] = [];
  let hasError = false;
  let hasWarning = false;

  // 1. Check env vars
  const envVarsPresent: Record<string, boolean> = {};
  for (const name of ENV_VARS) {
    envVarsPresent[name] = !!process.env[name];
  }

  // 2. Check Supabase connection
  let supabaseCheck: DiagnosticResult;
  const tableCounts: Record<string, number> = {};

  try {
    const supabase = getSupabaseClient();
    const { count, error } = await supabase
      .from('sync_log')
      .select('*', { count: 'exact', head: true });

    if (error) throw new Error(error.message);

    supabaseCheck = { status: 'ok', message: `Connected. sync_log has ${count ?? 0} rows.` };

    // Get counts for all key tables
    for (const table of KEY_TABLES) {
      try {
        const { count: c, error: e } = await supabase
          .from(table)
          .select('*', { count: 'exact', head: true });
        tableCounts[table] = e ? -1 : (c ?? 0);
      } catch {
        tableCounts[table] = -1;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    supabaseCheck = { status: 'error', message: `Cannot connect: ${msg}` };
    hasError = true;

    if (!envVarsPresent.SUPABASE_URL) {
      recommendations.push('SUPABASE_URL is missing. Set it in your Railway environment variables.');
    }
    if (!envVarsPresent.SUPABASE_SERVICE_ROLE_KEY && !envVarsPresent.SUPABASE_ANON_KEY) {
      recommendations.push('Neither SUPABASE_SERVICE_ROLE_KEY nor SUPABASE_ANON_KEY is set. At least one is required.');
    }
  }

  // 3. Check GHL credentials
  let ghlCredentialsCheck: DiagnosticResult;
  if (!envVarsPresent.GHL_API_KEY) {
    ghlCredentialsCheck = { status: 'error', message: 'GHL_API_KEY is missing' };
    hasError = true;
    recommendations.push('GHL_API_KEY is missing. The server cannot pull data from GoHighLevel. Set it in Railway env vars.');
  } else if (!envVarsPresent.GHL_LOCATION_ID) {
    ghlCredentialsCheck = { status: 'error', message: 'GHL_LOCATION_ID is missing' };
    hasError = true;
    recommendations.push('GHL_LOCATION_ID is missing. Required for all GHL API v2 calls. Set it in Railway env vars.');
  } else {
    ghlCredentialsCheck = { status: 'ok', message: 'GHL_API_KEY and GHL_LOCATION_ID are set' };
  }

  // 4. Check GHL API reachability
  let ghlApiCheck: DiagnosticResult;
  if (ghlCredentialsCheck.status === 'error') {
    ghlApiCheck = { status: 'error', message: 'Skipped — credentials missing' };
  } else {
    try {
      // Dynamic import to avoid constructor throwing before we can catch it
      const { GHLClient } = await import('./clients/ghl.js');
      const ghl = new GHLClient();
      const workflows = await ghl.getWorkflows();
      ghlApiCheck = { status: 'ok', message: `API reachable. Found ${workflows.length} workflows.` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ghlApiCheck = { status: 'error', message: `API call failed: ${msg}` };
      hasError = true;
      recommendations.push(`GHL API is not reachable: ${msg}. Check that your GHL_API_KEY is valid and not expired.`);
    }
  }

  // 5. Check scheduled sync
  let syncCheck: DiagnosticResult;
  if (process.env.ENABLE_SCHEDULED_SYNC === 'true') {
    syncCheck = { status: 'ok', message: 'Scheduled sync is enabled' };
  } else {
    syncCheck = { status: 'warning', message: 'Scheduled sync is disabled' };
    hasWarning = true;
    recommendations.push(
      'ENABLE_SCHEDULED_SYNC is not set to "true". Without it, data only syncs when you manually call sync tools. ' +
      'Set ENABLE_SCHEDULED_SYNC=true in Railway env vars to enable automatic sync every 10-15 minutes.',
    );
  }

  // 6. Firebase auth check
  if (!envVarsPresent.GHL_FIREBASE_API_KEY || !envVarsPresent.GHL_FIREBASE_REFRESH_TOKEN) {
    hasWarning = true;
    recommendations.push(
      'Firebase auth is not configured (GHL_FIREBASE_API_KEY / GHL_FIREBASE_REFRESH_TOKEN). ' +
      'Without it, workflow extraction falls back to the public API which has less detail. ' +
      'This is optional but recommended for full workflow intelligence.',
    );
  }

  // 7. Table-specific recommendations
  const emptyTables = Object.entries(tableCounts).filter(([, count]) => count === 0).map(([name]) => name);
  if (emptyTables.length > 0) {
    const autoSyncTables = emptyTables.filter(t => t !== 'workflow_executions');
    if (autoSyncTables.length > 0) {
      recommendations.push(
        `Empty tables that should be auto-populated: ${autoSyncTables.join(', ')}. ` +
        'Ensure ENABLE_SCHEDULED_SYNC=true and GHL credentials are valid. ' +
        'Data will appear within 10-25 seconds of server start.',
      );
    }
  }

  if (tableCounts.workflow_executions === 0) {
    recommendations.push(
      'workflow_executions has 0 rows. This is expected — it is only populated via the ' +
      'log_workflow_execution MCP tool, not via automatic sync. GoHighLevel does not expose ' +
      'a workflow execution history API.',
    );
  }

  if (!envVarsPresent.MCP_AUTH_TOKEN) {
    hasWarning = true;
    recommendations.push(
      'MCP_AUTH_TOKEN is not set. The /mcp endpoint is accessible without authentication. ' +
      'Consider setting MCP_AUTH_TOKEN for production use.',
    );
  }

  // Determine overall status
  const overall = hasError ? 'unhealthy' : hasWarning ? 'degraded' : 'healthy';

  return {
    timestamp: new Date().toISOString(),
    overall,
    checks: {
      supabase_connection: supabaseCheck,
      ghl_credentials: ghlCredentialsCheck,
      ghl_api_reachable: ghlApiCheck,
      scheduled_sync_enabled: syncCheck,
      table_row_counts: tableCounts,
      env_vars_present: envVarsPresent,
    },
    recommendations,
  };
}
