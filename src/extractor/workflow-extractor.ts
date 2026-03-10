import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';
import type { GHLWorkflow, GHLWorkflowStep } from '../types/ghl.js';
import { parseNodeGraph } from './node-graph-parser.js';
import { nowET } from '../utils/timezone.js';

export interface SyncResult {
  workflows_synced: number;
  steps_synced: number;
  triggers_synced: number;
  actions_synced: number;
  connections_synced: number;
  snapshots_created: number;
  errors: string[];
}

/**
 * Converts a delay value and unit into minutes.
 */
function toDelayMinutes(delay?: number, unit?: string): number {
  if (!delay) return 0;
  switch (unit?.toLowerCase()) {
    case 'hours': return delay * 60;
    case 'days': return delay * 60 * 24;
    case 'seconds': return Math.ceil(delay / 60);
    default: return delay; // assume minutes
  }
}

/**
 * Extracts and syncs all workflow data from GoHighLevel into Supabase.
 * Uses the internal backend API (via Firebase auth) for full workflow node graphs.
 * When Firebase auth is not configured, uses summary data only (no per-workflow
 * detail calls since steps/nodes require the internal API).
 *
 * Populates: workflows, workflow_steps, workflow_triggers, workflow_actions,
 * workflow_connections, and workflow_snapshots tables.
 */
export async function extractAndSyncWorkflows(): Promise<SyncResult> {
  const ghl = new GHLClient();
  const supabase = getSupabaseClient();

  const result: SyncResult = {
    workflows_synced: 0,
    steps_synced: 0,
    triggers_synced: 0,
    actions_synced: 0,
    connections_synced: 0,
    snapshots_created: 0,
    errors: [],
  };

  // Log sync start
  const { data: syncLog } = await supabase.from('sync_log').insert({
    entity_type: 'workflows_full',
    sync_type: 'full',
    status: 'running',
  }).select().single();

  try {
    // 1. Fetch all workflows (summary list from public API)
    const workflows = await ghl.getWorkflows();
    let noNodesCount = 0;

    for (const workflowSummary of workflows) {
      try {
        // 2. Fetch full workflow detail from internal API (requires Firebase auth)
        let workflowDetail: GHLWorkflow;
        let fullJson: Record<string, unknown>;
        let parsedConnections: Array<{ fromStep: string; toStep: string; condition?: string }> = [];

        const internalJson = await ghl.getWorkflowDetail(workflowSummary.id);

        if (internalJson) {
          // Internal API returned data — parse the full node graph
          fullJson = internalJson;
          const parsed = parseNodeGraph(fullJson);
          parsedConnections = parsed.connections;
          if (parsed.triggers.length === 0 && parsed.steps.length === 0 && parsed.actions.length === 0) {
            noNodesCount++;
          }

          // Fetch triggers from the dedicated backend trigger endpoint
          const backendTriggers = await ghl.getWorkflowTriggers(workflowSummary.id);

          // Merge trigger sources: prefer backend triggers, fall back to parsed/summary
          let mergedTriggers: GHLWorkflow['triggers'];
          if (backendTriggers.length > 0) {
            mergedTriggers = backendTriggers.map(t => ({
              id: (t.id || t._id) as string | undefined,
              type: (t.type || t.triggerType || t.event) as string | undefined,
              name: (t.name || t.triggerName || t.type) as string | undefined,
              value: (t.value || t.triggerValue) as string | undefined,
              filters: Array.isArray(t.filters) ? t.filters as Record<string, unknown>[] : undefined,
              ...t,
            }));
          } else {
            mergedTriggers = parsed.triggers.length > 0
              ? parsed.triggers
              : (fullJson.triggers as GHLWorkflow['triggers']) || workflowSummary.triggers || [];
          }

          // Build a GHLWorkflow from parsed data
          workflowDetail = {
            id: workflowSummary.id,
            locationId: (fullJson.locationId as string) || workflowSummary.locationId,
            name: (fullJson.name as string) || workflowSummary.name,
            status: (fullJson.status as string) || workflowSummary.status,
            version: (fullJson.version as number) || workflowSummary.version,
            steps: parsed.steps.length > 0 ? parsed.steps : (fullJson.steps as GHLWorkflowStep[]) || workflowSummary.steps || [],
            triggers: mergedTriggers,
            actions: parsed.actions.length > 0 ? parsed.actions : (fullJson.actions as GHLWorkflow['actions']) || workflowSummary.actions || [],
          };
        } else {
          // No internal API available — use summary data directly (no redundant API calls)
          workflowDetail = workflowSummary;
          fullJson = JSON.parse(JSON.stringify(workflowSummary));
        }

        // Store the complete raw JSON (from internal API if available)
        const rawJson = JSON.parse(JSON.stringify(fullJson));

        // 3. Upsert workflow with raw JSON
        await supabase.from('workflows').upsert({
          ghl_workflow_id: workflowDetail.id,
          ghl_location_id: workflowDetail.locationId,
          name: workflowDetail.name,
          status: workflowDetail.status,
          version: workflowDetail.version || 1,
          trigger_type: workflowDetail.triggers?.[0]?.type || null,
          trigger_config: workflowDetail.triggers && workflowDetail.triggers.length > 0 ? workflowDetail.triggers : {},
          actions: workflowDetail.actions && workflowDetail.actions.length > 0 ? workflowDetail.actions : [],
          raw_json: rawJson,
          synced_at: nowET(),
        }, { onConflict: 'ghl_workflow_id' });
        result.workflows_synced++;

        // 4. Check for version changes and create snapshot
        const { data: existingSnapshots } = await supabase
          .from('workflow_snapshots')
          .select('version, json_structure')
          .eq('workflow_id', workflowDetail.id)
          .order('version', { ascending: false })
          .limit(1);

        const currentVersion = workflowDetail.version || 1;
        const latestSnapshot = existingSnapshots?.[0];

        if (!latestSnapshot ||
            latestSnapshot.version !== currentVersion ||
            JSON.stringify(latestSnapshot.json_structure) !== JSON.stringify(rawJson)) {
          const newVersion = latestSnapshot ? latestSnapshot.version + 1 : 1;
          await supabase.from('workflow_snapshots').insert({
            workflow_id: workflowDetail.id,
            version: newVersion,
            json_structure: rawJson,
          });
          result.snapshots_created++;
        }

        // 5. Clear existing detail data for this workflow before re-inserting
        await supabase.from('workflow_steps').delete().eq('workflow_id', workflowDetail.id);
        await supabase.from('workflow_connections').delete().eq('workflow_id', workflowDetail.id);
        await supabase.from('workflow_triggers').delete().eq('workflow_id', workflowDetail.id);
        await supabase.from('workflow_actions').delete().eq('workflow_id', workflowDetail.id);

        // 6. Extract and insert steps
        const steps = workflowDetail.steps || [];
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i] as GHLWorkflowStep;
          await supabase.from('workflow_steps').insert({
            step_id: step.id || `${workflowDetail.id}_step_${i}`,
            workflow_id: workflowDetail.id,
            step_order: i + 1,
            step_type: step.type || 'unknown',
            delay_minutes: toDelayMinutes(step.delay, step.delayUnit),
            template_id: step.templateId || null,
            branch_condition: step.condition || null,
            raw_json: step,
          });
          result.steps_synced++;

          // Extract actions from steps
          if (step.actions) {
            for (const action of step.actions) {
              await supabase.from('workflow_actions').insert({
                workflow_id: workflowDetail.id,
                step_id: step.id || `${workflowDetail.id}_step_${i}`,
                action_type: action.type || 'unknown',
                action_target: action.target || null,
                raw_json: action,
              });
              result.actions_synced++;
            }
          }

        }

        // 6b. Insert connections from parsed graph (or fallback to sequential)
        if (parsedConnections.length > 0) {
          for (const conn of parsedConnections) {
            await supabase.from('workflow_connections').insert({
              workflow_id: workflowDetail.id,
              from_step: conn.fromStep,
              to_step: conn.toStep,
              condition: conn.condition || null,
            });
            result.connections_synced++;
          }
        } else {
          // Fallback: build connections between sequential steps
          for (let j = 0; j < steps.length - 1; j++) {
            const fromStep = steps[j] as GHLWorkflowStep;
            const toStep = steps[j + 1] as GHLWorkflowStep;
            await supabase.from('workflow_connections').insert({
              workflow_id: workflowDetail.id,
              from_step: fromStep.id || `${workflowDetail.id}_step_${j}`,
              to_step: toStep.id || `${workflowDetail.id}_step_${j + 1}`,
              condition: fromStep.condition || null,
            });
            result.connections_synced++;
          }
        }

        // 7. Extract and insert triggers
        const triggers = workflowDetail.triggers || [];
        for (const trigger of triggers) {
          await supabase.from('workflow_triggers').insert({
            workflow_id: workflowDetail.id,
            trigger_event: trigger.type || trigger.name || 'unknown',
            trigger_value: trigger.value || null,
            raw_json: trigger,
          });
          result.triggers_synced++;
        }

        // 8. Extract top-level actions (not step-level)
        const topActions = workflowDetail.actions || [];
        for (const action of topActions) {
          await supabase.from('workflow_actions').insert({
            workflow_id: workflowDetail.id,
            step_id: null,
            action_type: action.type || 'unknown',
            action_target: action.target || null,
            raw_json: action,
          });
          result.actions_synced++;
        }

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Workflow ${workflowSummary.id}: ${msg}`);
      }
    }

    if (noNodesCount > 0) {
      console.warn(`[WorkflowSync] ${noNodesCount}/${workflows.length} workflows had no parseable nodes (internal API format unrecognized)`);
    }

    // Update sync log
    if (syncLog) {
      await supabase.from('sync_log').update({
        status: 'completed',
        records_synced: result.workflows_synced,
        completed_at: nowET(),
      }).eq('id', syncLog.id);
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Fatal: ${msg}`);

    if (syncLog) {
      await supabase.from('sync_log').update({
        status: 'failed',
        error_message: msg,
        completed_at: nowET(),
      }).eq('id', syncLog.id);
    }
  }

  return result;
}
