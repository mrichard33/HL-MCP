import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';
import type { GHLWorkflow, GHLWorkflowStep, GHLWorkflowTrigger, GHLWorkflowAction } from '../types/ghl.js';
import { parseNodeGraph } from './node-graph-parser.js';
import { nowET } from '../utils/timezone.js';
import { updateLastSynced, softDeleteMissing } from './entity-syncer.js';

// v1.9: Fixes recurring 23505 duplicate-key errors on workflow_steps_pkey and
// the resulting silent data loss. Cloned GHL workflows share their source
// workflow's step (template) IDs; under the old single-column PK(step_id) every
// clone's step inserts failed, leaving incomplete cached step graphs. Paired
// with a composite PRIMARY KEY (workflow_id, step_id) migration, this file now:
//   - batches the four detail-table inserts (was one PostgREST request per row),
//   - checks every insert's error and only counts rows on success,
//   - upserts steps with ignoreDuplicates as a defensive layer, and
//   - guards against overlapping sync runs (see workflowSyncInProgress below).

// v1.8: Verbose per-workflow diagnostic logging is gated behind
// DEBUG_WORKFLOW_SYNC=true. When enabled, every workflow prints its
// top-level Internal API keys + nested key structure (~7 lines/workflow).
// For 234 workflows that's ~1,600 lines per hourly sync, which drowns
// the 500-line Railway log buffer and pushes real diagnostics out.
// When disabled, only the first workflow per sync cycle prints the
// key structure (useful for catching GHL schema drift) and a
// one-line summary prints at the end.
const DEBUG_WORKFLOW_SYNC = process.env.DEBUG_WORKFLOW_SYNC === 'true';

// v1.9: Overlap guard. extractAndSyncWorkflows is awaited by the hourly
// scheduler, the sync_workflows MCP tool, and workflow-analysis. A manual
// sync_workflows call interleaving with the scheduler mid-workflow can race the
// delete-then-insert block; this module-level flag makes a concurrent run return
// immediately (status 'already_running') instead of starting a second pass.
// Mirrors the hlSyncInProgress pattern in src/tools/workflows.ts.
let workflowSyncInProgress = false;

export interface SyncResult {
  workflows_synced: number;
  workflows_total: number;
  steps_synced: number;
  triggers_synced: number;
  actions_synced: number;
  connections_synced: number;
  snapshots_created: number;
  errors: string[];
  failed_workflow_ids: string[];
  status?: string;
}

export interface SyncOptions {
  batchSize?: number;
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
 * Extracts a meaningful trigger value from a trigger object by checking
 * multiple possible GHL field names for the trigger's configuration value.
 * Handles string, number, and nested object values.
 */
function extractTriggerValue(trigger: Record<string, unknown>): string | null {
  const valueFields = [
    'triggerValue', 'filterValue',
    'formId', 'formName', 'tagId', 'tagName', 'tag',
    'pipelineId', 'pipelineName', 'stageId', 'stageName',
    'pipelineStageId', 'surveyId', 'surveyName',
    'calendarId', 'calendarName', 'webhookUrl',
    'customFieldId', 'customFieldName',
    'membershipId', 'membershipName',
    'invoiceId', 'campaignId', 'campaignName',
    'url', 'link', 'uri',
  ];

  // Helper: check an object for any known value field (accepts strings and numbers)
  function tryExtract(obj: Record<string, unknown>): string | null {
    for (const field of valueFields) {
      const val = obj[field];
      if (val !== null && val !== undefined && val !== '') {
        const str = typeof val === 'string' ? val.trim() : String(val);
        if (str && str !== 'undefined' && str !== 'null') return str;
      }
    }
    return null;
  }

  // 1. Check top-level fields
  let found = tryExtract(trigger);
  if (found) return found;

  // 2. Check nested objects commonly used in GHL trigger configs
  for (const nestedKey of ['data', 'config', 'settings', 'options', 'properties', 'metadata']) {
    const nested = trigger[nestedKey];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      found = tryExtract(nested as Record<string, unknown>);
      if (found) return found;
    }
  }

  // 3. Serialize filters if present
  if (trigger.filters && Array.isArray(trigger.filters) && trigger.filters.length > 0) {
    return JSON.stringify(trigger.filters);
  }

  // 4. Last resort: scan ALL keys for non-metadata values
  const skipKeys = new Set([
    'id', '_id', 'type', 'triggerType', 'event', 'name', 'triggerName',
    'createdAt', 'updatedAt', 'locationId', 'workflowId', '__v', 'raw',
    'filters', 'data', 'config', 'settings', 'options', 'properties', 'metadata',
    'created_at', 'updated_at', 'createdTs', 'updatedTs', 'timestamp',
    'modifiedAt', 'modified_at', 'lastModified', 'dateCreated', 'dateUpdated',
    'dateAdded', 'dateModified', 'version', 'order', 'priority',
    'value',  // Raw backend trigger 'value' is always a timestamp, not meaningful
    'entity', 'scope', 'source', 'category', 'channel',
    'status', 'active', 'enabled', 'deleted', 'archived',
    'location_id', 'workflow_id', 'contact_id', 'trigger_id',
  ]);
  // Generic values that are not meaningful as trigger values
  const genericValues = new Set(['workflow', 'trigger', 'action', 'contact', 'true', 'false']);
  // ISO 8601 timestamp pattern to skip values that look like dates
  const isoTimestampRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
  // GHL object IDs are long alphanumeric strings — not meaningful as trigger values
  const ghlIdRe = /^[a-zA-Z0-9]{15,}$/;
  for (const [key, val] of Object.entries(trigger)) {
    if (skipKeys.has(key)) continue;
    if (val && typeof val === 'object' && !Array.isArray(val)) continue;
    if (Array.isArray(val) && val.length > 0) {
      return JSON.stringify(val);
    }
    if (val !== null && val !== undefined && val !== '' && typeof val !== 'boolean') {
      const str = String(val).trim();
      if (str && str !== 'undefined' && str !== 'null' && !isoTimestampRe.test(str) && !genericValues.has(str.toLowerCase()) && !ghlIdRe.test(str)) return str;
    }
  }

  return null;
}

/**
 * Extracts a meaningful action target from template attributes based on the action type.
 */
function extractActionTargetFromAttrs(actionType: string, attrs: Record<string, unknown>): string | undefined {
  switch (actionType) {
    case 'email':
      return (attrs.subject || attrs.from_email || attrs.template_id) as string || undefined;
    case 'sms':
      return attrs.body ? String(attrs.body).substring(0, 100) : undefined;
    case 'add_contact_tag':
    case 'remove_contact_tag':
      return Array.isArray(attrs.tags) ? attrs.tags.join(', ') : undefined;
    case 'goto':
      return (attrs.targetNodeId as string) || undefined;
    case 'if_else':
      return (attrs.conditionName as string) || undefined;
    case 'create_opportunity':
      return (attrs.pipelineId || attrs.pipeline) as string || undefined;
    case 'assign_user':
      return (attrs.userId || attrs.assignedTo) as string || undefined;
    case 'task-notification':
      return (attrs.title || attrs.taskName) as string || undefined;
    case 'transition':
      return (attrs.targetStageId || attrs.stageId || attrs.stageName) as string || undefined;
    case 'wait': {
      if (attrs.startAfter && typeof attrs.startAfter === 'object') {
        const sa = attrs.startAfter as Record<string, unknown>;
        return `${sa.value || ''} ${sa.type || 'minutes'}`;
      }
      return undefined;
    }
    default:
      return (attrs.target || attrs.to || attrs.recipient) as string || undefined;
  }
}

/**
 * Iteratively traverses templates to find all nodes including those inside
 * IF/ELSE branches, following next pointers and branch paths.
 * Uses a queue instead of recursion to avoid stack overflow on deep chains.
 */
function collectAllTemplateNodes(templates: Record<string, unknown>[]): Record<string, unknown>[] {
  const templateMap = new Map<string, Record<string, unknown>>();
  for (const tmpl of templates) {
    const id = (tmpl.id || tmpl._id) as string;
    if (id) templateMap.set(id, tmpl);
  }

  const visited = new Set<string>();
  const result: Record<string, unknown>[] = [];

  // Seed queue with all template IDs
  const queue: string[] = [];
  for (const tmpl of templates) {
    const id = (tmpl.id || tmpl._id) as string;
    if (id) queue.push(id);
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const tmpl = templateMap.get(id);
    if (!tmpl) continue;
    result.push(tmpl);

    const next = tmpl.next;
    if (typeof next === 'string' && next) {
      queue.push(next);
    } else if (Array.isArray(next)) {
      for (const branchTarget of next) {
        if (typeof branchTarget === 'string' && branchTarget) {
          queue.push(branchTarget);
        }
      }
    }

    const attrs = (tmpl.attributes || {}) as Record<string, unknown>;
    if (Array.isArray(attrs.branches)) {
      for (const branch of attrs.branches) {
        const b = branch as Record<string, unknown>;
        if (typeof b.nextStep === 'string') queue.push(b.nextStep);
        if (typeof b.target === 'string') queue.push(b.target);
        if (typeof b.id === 'string') queue.push(b.id);
      }
    }
  }

  return result;
}

/**
 * Extracts workflow steps, actions, and connections from the GHL internal API's
 * `workflowData.templates` format. Templates are a flat array of step/action
 * objects linked via `next` fields (string for sequential, array for branches).
 * Now traverses all branch paths to include IF/ELSE child nodes.
 */
function extractFromTemplates(templates: Record<string, unknown>[]): {
  steps: GHLWorkflowStep[];
  actions: GHLWorkflowAction[];
  connections: Array<{ fromStep: string; toStep: string; condition?: string }>;
} {
  const steps: GHLWorkflowStep[] = [];
  const actions: GHLWorkflowAction[] = [];
  const connections: Array<{ fromStep: string; toStep: string; condition?: string }> = [];

  // Collect all nodes including those inside branches
  const allTemplates = collectAllTemplateNodes(templates);

  for (const tmpl of allTemplates) {
    const id = (tmpl.id || tmpl._id) as string;
    if (!id) continue;
    const type = (tmpl.type as string) || 'unknown';
    const name = (tmpl.name as string) || type;
    const order = (tmpl.order as number) ?? steps.length;
    const attrs = (tmpl.attributes || {}) as Record<string, unknown>;

    // Create step
    const step: GHLWorkflowStep = {
      id,
      type,
      name,
      delay: undefined,
      delayUnit: undefined,
      templateId: (attrs.template_id || attrs.templateId) as string || undefined,
      condition: type === 'if_else' ? (attrs.conditionName || attrs.condition) as string || undefined : undefined,
    };

    // Extract delay for wait steps
    if (type === 'wait' && attrs.startAfter && typeof attrs.startAfter === 'object') {
      const sa = attrs.startAfter as Record<string, unknown>;
      step.delay = (sa.value as number) || undefined;
      step.delayUnit = (sa.type as string) || undefined;
    }

    Object.assign(step, { raw: tmpl, stepOrder: order + 1 });
    steps.push(step);

    // Create action entry with type-aware target extraction
    const action: GHLWorkflowAction = {
      id,
      type,
      name,
      target: extractActionTargetFromAttrs(type, attrs),
    };
    Object.assign(action, { raw: tmpl });
    actions.push(action);

    // Build connections from "next" field
    const next = tmpl.next;
    if (typeof next === 'string' && next) {
      connections.push({ fromStep: id, toStep: next });
    } else if (Array.isArray(next)) {
      // if_else branches — get branch names from attributes.branches
      const branches = (attrs.branches || []) as Record<string, unknown>[];
      for (let i = 0; i < next.length; i++) {
        const branchId = next[i] as string;
        if (!branchId) continue;
        const branchName = branches[i] ? (branches[i].name as string) : undefined;
        // Last next ID beyond branches count is the "none/default" branch
        const condition = branchName || (i >= branches.length ? 'Default' : undefined);
        connections.push({ fromStep: id, toStep: branchId, condition });
      }
    }

    // Handle goto targets
    if (type === 'goto' && attrs.targetNodeId) {
      connections.push({ fromStep: id, toStep: attrs.targetNodeId as string });
    }
  }

  // Sort steps by order field
  steps.sort((a, b) => ((a as Record<string, unknown>).stepOrder as number || 0) - ((b as Record<string, unknown>).stepOrder as number || 0));

  return { steps, actions, connections };
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
export async function extractAndSyncWorkflows(options: SyncOptions = {}): Promise<SyncResult> {
  // v1.9: Bail out if another sync is already running (see workflowSyncInProgress).
  if (workflowSyncInProgress) {
    return {
      workflows_synced: 0,
      workflows_total: 0,
      steps_synced: 0,
      triggers_synced: 0,
      actions_synced: 0,
      connections_synced: 0,
      snapshots_created: 0,
      errors: ['Workflow sync already in progress — skipping overlapping run.'],
      failed_workflow_ids: [],
      status: 'already_running',
    };
  }
  workflowSyncInProgress = true;

  const ghl = new GHLClient();
  const supabase = getSupabaseClient();
  const batchSize = options.batchSize || 0;

  const result: SyncResult = {
    workflows_synced: 0,
    workflows_total: 0,
    steps_synced: 0,
    triggers_synced: 0,
    actions_synced: 0,
    connections_synced: 0,
    snapshots_created: 0,
    errors: [],
    failed_workflow_ids: [],
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
    result.workflows_total = workflows.length;
    let noNodesCount = 0;
    let firebaseFailureLogged = false;
    // v1.8: Track whether we've logged the schema sample. Previously this used
    // `noNodesCount === 0` which only logged on the first workflow that had
    // zero parsed nodes — potentially never logging in a healthy cycle.
    // Now logs once per cycle on the first successful internal API response.
    let loggedSchemaSample = false;

    for (let wIdx = 0; wIdx < workflows.length; wIdx++) {
      const workflowSummary = workflows[wIdx];

      // Batch delay: pause between batches to avoid API rate limiting
      if (batchSize > 0 && wIdx > 0 && wIdx % batchSize === 0) {
        console.log(`[WorkflowSync] Batch pause after ${wIdx}/${workflows.length} workflows...`);
        await new Promise(r => setTimeout(r, 2000));
      }
      try {
        // 2. Fetch full workflow detail from internal API (requires Firebase auth)
        let workflowDetail: GHLWorkflow;
        let fullJson: Record<string, unknown>;
        let parsedConnections: Array<{ fromStep: string; toStep: string; condition?: string }> = [];

        const internalJson = await ghl.getWorkflowDetail(workflowSummary.id);

        if (!internalJson && ghl.isFirebaseAuthConfigured) {
          // Firebase auth is configured but failed at runtime (expired/invalid token).
          // Update basic metadata only — preserve existing trigger_type, trigger_config,
          // actions, and raw_json in the database since the public API cannot provide them.
          if (!firebaseFailureLogged) {
            console.error('[WorkflowSync] Firebase auth failed — updating metadata only, preserving existing trigger/action data. Check GHL_FIREBASE_REFRESH_TOKEN.');
            firebaseFailureLogged = true;
          }
          const { error: metaUpsertError } = await supabase.from('workflows').upsert({
            ghl_workflow_id: workflowSummary.id,
            ghl_location_id: workflowSummary.locationId,
            name: workflowSummary.name,
            status: workflowSummary.status,
            version: workflowSummary.version || 1,
            synced_at: nowET(),
            deleted_at: null,
          }, { onConflict: 'ghl_workflow_id' });
          if (metaUpsertError) {
            result.errors.push(`Workflow ${workflowSummary.id} metadata upsert failed: ${metaUpsertError.message}`);
          } else {
            result.workflows_synced++;
          }
          continue;
        }

        if (internalJson) {
          // Internal API returned data — parse the full node graph
          fullJson = internalJson;

          // v1.8: Schema diagnostic log — gated behind DEBUG_WORKFLOW_SYNC.
          // Without the gate this prints ~7 lines for EVERY workflow (234 per
          // hourly cycle = ~1600 lines), drowning the log buffer. With the gate
          // it prints only when debugging. Either way, log once per cycle on
          // the first internal API response so we can catch schema drift.
          if (!loggedSchemaSample) {
            loggedSchemaSample = true;
            const topKeys = Object.keys(fullJson);
            console.log(`[WorkflowSync] Internal API sample schema for "${workflowSummary.name}": top-level keys [${topKeys.join(', ')}]`);
            if (DEBUG_WORKFLOW_SYNC) {
              for (const key of topKeys) {
                const val = fullJson[key];
                if (val && typeof val === 'object' && !Array.isArray(val)) {
                  console.log(`[WorkflowSync]   .${key} keys: [${Object.keys(val as object).join(', ')}]`);
                } else if (Array.isArray(val)) {
                  console.log(`[WorkflowSync]   .${key}: Array(${val.length})`);
                }
              }
            }
          }

          const parsed = parseNodeGraph(fullJson);
          parsedConnections = parsed.connections;
          if (parsed.triggers.length === 0 && parsed.steps.length === 0 && parsed.actions.length === 0) {
            noNodesCount++;

            // Primary fallback: extract from workflowData.templates (GHL internal format)
            const wd = fullJson.workflowData as Record<string, unknown> | undefined;
            if (wd && Array.isArray(wd.templates) && wd.templates.length > 0) {
              const extracted = extractFromTemplates(wd.templates as Record<string, unknown>[]);
              parsed.steps = extracted.steps;
              parsed.actions = extracted.actions;
              parsedConnections = extracted.connections;
            }

            // Secondary fallback: try public API if templates extraction also failed
            if (parsed.steps.length === 0) {
              try {
                const publicDetail = await ghl.getWorkflow(workflowSummary.id);
                if (publicDetail.steps && publicDetail.steps.length > 0) {
                  parsed.steps = publicDetail.steps as GHLWorkflowStep[];
                }
                if (publicDetail.triggers && publicDetail.triggers.length > 0) {
                  parsed.triggers = publicDetail.triggers as GHLWorkflowTrigger[];
                }
                if (publicDetail.actions && publicDetail.actions.length > 0) {
                  parsed.actions = publicDetail.actions as GHLWorkflow['actions'] & GHLWorkflowTrigger[];
                }
              } catch {
                // Public API fallback is best-effort
              }
            }
          }

          // Fetch triggers from the dedicated backend trigger endpoint
          const backendTriggers = await ghl.getWorkflowTriggers(workflowSummary.id);

          // v1.8: Trigger API response logging — gated behind DEBUG_WORKFLOW_SYNC.
          // This log line runs inside ghl.getWorkflowTriggers() in ghl.ts, not
          // here — the gating applies at the source. We still log trigger
          // diagnostics for the first workflow of each cycle below.

          // Merge trigger sources: prefer backend triggers, fall back to parsed/summary
          let mergedTriggers: GHLWorkflow['triggers'];
          if (backendTriggers.length > 0) {
            mergedTriggers = backendTriggers.map(t => ({
              ...t,  // Raw data as base (preserves all fields for raw_json)
              id: (t.id || t._id) as string | undefined,
              type: (t.type || t.triggerType || t.event) as string | undefined,
              name: (t.name || t.triggerName || t.type) as string | undefined,
              value: extractTriggerValue(t as Record<string, unknown>) || undefined,
              filters: Array.isArray(t.filters) ? t.filters as Record<string, unknown>[] : undefined,
            }));
          } else {
            mergedTriggers = parsed.triggers.length > 0
              ? parsed.triggers
              : (fullJson.triggers as GHLWorkflow['triggers']) || workflowSummary.triggers || [];
          }

          // Diagnostic: log trigger/action counts for first workflow per sync cycle
          if (result.workflows_synced === 0) {
            console.log(`[WorkflowSync] Trigger diagnostics for "${workflowSummary.name}": backendTriggers=${backendTriggers.length}, parsedTriggers=${parsed.triggers.length}, mergedTriggers=${mergedTriggers.length}, parsedActions=${parsed.actions.length}`);
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
          // No internal API — call public API individual endpoint for more detail
          try {
            const publicDetail = await ghl.getWorkflow(workflowSummary.id);
            workflowDetail = {
              ...workflowSummary,
              ...publicDetail,
              id: workflowSummary.id,
            };
            fullJson = JSON.parse(JSON.stringify(publicDetail));
          } catch (err) {
            console.warn(`[WorkflowSync] Public API fallback failed for ${workflowSummary.id}: ${err instanceof Error ? err.message : String(err)}`);
            workflowDetail = workflowSummary;
            fullJson = JSON.parse(JSON.stringify(workflowSummary));
          }
        }

        // Store the complete raw JSON (from internal API if available)
        const rawJson = JSON.parse(JSON.stringify(fullJson));

        // 3. Upsert workflow with raw JSON
        // If we have no trigger data from any source, preserve existing DB values
        let upsertTriggerType: string | null = workflowDetail.triggers?.[0]?.type || null;
        let upsertTriggerConfig: unknown = workflowDetail.triggers && workflowDetail.triggers.length > 0 ? workflowDetail.triggers : [];
        let upsertActions: unknown = workflowDetail.actions && workflowDetail.actions.length > 0 ? workflowDetail.actions : [];

        if (!workflowDetail.triggers?.length || !workflowDetail.actions?.length) {
          const { data: existing } = await supabase
            .from('workflows')
            .select('trigger_type, trigger_config, actions')
            .eq('ghl_workflow_id', workflowDetail.id)
            .single();

          if (existing) {
            if (!workflowDetail.triggers?.length && existing.trigger_type) {
              console.warn(`[WorkflowSync] No trigger data for "${workflowDetail.name}" — preserving existing DB values`);
              upsertTriggerType = existing.trigger_type;
              upsertTriggerConfig = existing.trigger_config;
            }
            if (!workflowDetail.actions?.length && existing.actions && Array.isArray(existing.actions) && existing.actions.length > 0) {
              console.warn(`[WorkflowSync] No action data for "${workflowDetail.name}" — preserving existing DB values`);
              upsertActions = existing.actions;
            }
          }
        }

        const { error: upsertError } = await supabase.from('workflows').upsert({
          ghl_workflow_id: workflowDetail.id,
          ghl_location_id: workflowDetail.locationId,
          name: workflowDetail.name,
          status: workflowDetail.status,
          version: workflowDetail.version || 1,
          trigger_type: upsertTriggerType,
          trigger_config: upsertTriggerConfig,
          actions: upsertActions,
          raw_json: rawJson,
          synced_at: nowET(),
          deleted_at: null,
        }, { onConflict: 'ghl_workflow_id' });
        if (upsertError) {
          result.errors.push(`Workflow ${workflowDetail.id} upsert failed: ${upsertError.message}`);
          continue;
        }
        result.workflows_synced++;

        // 4. Check for version changes and create snapshot
        // Only create a new snapshot if the workflow content actually changed
        const { data: existingSnapshots } = await supabase
          .from('workflow_snapshots')
          .select('version, json_structure')
          .eq('workflow_id', workflowDetail.id)
          .order('version', { ascending: false })
          .limit(1);

        const latestSnapshot = existingSnapshots?.[0];

        // Deep-compare by sorting keys recursively to handle JSONB key reordering
        const stableStringify = (obj: unknown): string => JSON.stringify(obj, (_key, value) =>
          value && typeof value === 'object' && !Array.isArray(value)
            ? Object.keys(value).sort().reduce((sorted: Record<string, unknown>, k) => { sorted[k] = value[k]; return sorted; }, {})
            : value
        );
        const normalizedExisting = latestSnapshot ? stableStringify(latestSnapshot.json_structure) : null;
        const normalizedNew = stableStringify(rawJson);

        if (!latestSnapshot || normalizedExisting !== normalizedNew) {
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

        // v1.9: Accumulate detail rows into in-memory arrays and insert one
        // batched call per table (was one PostgREST request per row). actionRows
        // collects both step-level (here) and top-level (section 8) actions and
        // is inserted once, in section 8, before the actions backfill reads it.
        const steps = workflowDetail.steps || [];
        const stepRows: Array<Record<string, unknown>> = [];
        const actionRows: Array<Record<string, unknown>> = [];
        const connectionRows: Array<Record<string, unknown>> = [];
        const triggerRows: Array<Record<string, unknown>> = [];

        // 6. Build step rows (and step-level action rows)
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i] as GHLWorkflowStep;
          const stepId = step.id || `${workflowDetail.id}_step_${i}`;
          stepRows.push({
            step_id: stepId,
            workflow_id: workflowDetail.id,
            step_order: i + 1,
            step_type: step.type || 'unknown',
            delay_minutes: toDelayMinutes(step.delay, step.delayUnit),
            template_id: step.templateId || null,
            branch_condition: step.condition || null,
            raw_json: step,
          });

          // Extract actions from steps
          if (step.actions) {
            for (const action of step.actions) {
              actionRows.push({
                workflow_id: workflowDetail.id,
                step_id: stepId,
                action_type: action.type || 'unknown',
                action_target: action.target || null,
                raw_json: action,
              });
            }
          }
        }

        // Dedupe steps in-memory on step_id (keep first occurrence) — defends
        // against a parser emitting the same node twice within one workflow.
        const seenStepIds = new Set<string>();
        const dedupedStepRows = stepRows.filter((r) => {
          const id = r.step_id as string;
          if (seenStepIds.has(id)) return false;
          seenStepIds.add(id);
          return true;
        });

        // Insert steps: single upsert on the composite (workflow_id, step_id) PK.
        // ignoreDuplicates is a defensive layer against a manual sync racing the
        // scheduler mid-workflow. Counter increments only on success.
        if (dedupedStepRows.length > 0) {
          const { error: stepsError } = await supabase
            .from('workflow_steps')
            .upsert(dedupedStepRows, { onConflict: 'workflow_id,step_id', ignoreDuplicates: true });
          if (stepsError) {
            result.errors.push(`Workflow ${workflowDetail.id} steps insert failed: ${stepsError.message}`);
          } else {
            result.steps_synced += dedupedStepRows.length;
          }
        }

        // 6b. Build connections from parsed graph (or fallback to sequential)
        if (parsedConnections.length > 0) {
          for (const conn of parsedConnections) {
            connectionRows.push({
              workflow_id: workflowDetail.id,
              from_step: conn.fromStep,
              to_step: conn.toStep,
              condition: conn.condition || null,
            });
          }
        } else {
          // Fallback: build connections between sequential steps
          for (let j = 0; j < steps.length - 1; j++) {
            const fromStep = steps[j] as GHLWorkflowStep;
            const toStep = steps[j + 1] as GHLWorkflowStep;
            connectionRows.push({
              workflow_id: workflowDetail.id,
              from_step: fromStep.id || `${workflowDetail.id}_step_${j}`,
              to_step: toStep.id || `${workflowDetail.id}_step_${j + 1}`,
              condition: fromStep.condition || null,
            });
          }
        }

        if (connectionRows.length > 0) {
          const { error: connectionsError } = await supabase
            .from('workflow_connections')
            .insert(connectionRows);
          if (connectionsError) {
            result.errors.push(`Workflow ${workflowDetail.id} connections insert failed: ${connectionsError.message}`);
          } else {
            result.connections_synced += connectionRows.length;
          }
        }

        // 7. Build and insert triggers. Triggers must land before the
        // workflows.trigger_type/trigger_config backfill reads them back below.
        const triggers = workflowDetail.triggers || [];
        for (const trigger of triggers) {
          triggerRows.push({
            workflow_id: workflowDetail.id,
            trigger_event: trigger.type || trigger.name || (trigger as Record<string, unknown>).triggerName as string || (trigger as Record<string, unknown>).event as string || 'unknown',
            trigger_value: extractTriggerValue(trigger as unknown as Record<string, unknown>),
            raw_json: trigger,
          });
        }

        if (triggerRows.length > 0) {
          const { error: triggersError } = await supabase
            .from('workflow_triggers')
            .insert(triggerRows);
          if (triggersError) {
            result.errors.push(`Workflow ${workflowDetail.id} triggers insert failed: ${triggersError.message}`);
          } else {
            result.triggers_synced += triggerRows.length;
          }
        }

        // Backfill workflows.trigger_type and trigger_config from workflow_triggers data
        if (triggers.length > 0) {
          const { data: insertedTriggers } = await supabase
            .from('workflow_triggers')
            .select('trigger_event, raw_json')
            .eq('workflow_id', workflowDetail.id);

          if (insertedTriggers && insertedTriggers.length > 0) {
            const { error: triggerUpdateError } = await supabase
              .from('workflows')
              .update({
                trigger_type: insertedTriggers[0].trigger_event,
                trigger_config: insertedTriggers.map(t => t.raw_json),
              })
              .eq('ghl_workflow_id', workflowDetail.id);

            if (triggerUpdateError) {
              console.error(`[WorkflowSync] Failed to backfill trigger data for "${workflowDetail.name}": ${triggerUpdateError.message}`);
            }
          }
        }

        // 8. Extract top-level actions (not step-level)
        // In the GHL templates format, each template is both a step and an action (1:1),
        // so we link actions to their corresponding steps by matching IDs.
        const stepIds = new Set(steps.map(s => (s as GHLWorkflowStep).id));
        const topActions = workflowDetail.actions || [];
        for (const action of topActions) {
          const actionStepId = action.id && stepIds.has(action.id) ? action.id : null;
          actionRows.push({
            workflow_id: workflowDetail.id,
            step_id: actionStepId,
            action_type: action.type || 'unknown',
            action_target: action.target || null,
            raw_json: action,
          });
        }

        // Insert all actions (step-level from section 6 + top-level) in one
        // batched call, before the actions backfill reads them back below.
        if (actionRows.length > 0) {
          const { error: actionsError } = await supabase
            .from('workflow_actions')
            .insert(actionRows);
          if (actionsError) {
            result.errors.push(`Workflow ${workflowDetail.id} actions insert failed: ${actionsError.message}`);
          } else {
            result.actions_synced += actionRows.length;
          }
        }

        // Backfill workflows.actions from workflow_actions data
        if (topActions.length > 0) {
          const { data: insertedActions } = await supabase
            .from('workflow_actions')
            .select('action_type, action_target, raw_json')
            .eq('workflow_id', workflowDetail.id);

          if (insertedActions && insertedActions.length > 0) {
            const { error: actionsUpdateError } = await supabase
              .from('workflows')
              .update({ actions: insertedActions.map(a => a.raw_json) })
              .eq('ghl_workflow_id', workflowDetail.id);

            if (actionsUpdateError) {
              console.error(`[WorkflowSync] Failed to backfill actions for "${workflowDetail.name}": ${actionsUpdateError.message}`);
            }
          }
        }

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        // Extract HTTP status code from error message if present
        const httpStatusMatch = msg.match(/error (\d{3})/i);
        const httpStatus = httpStatusMatch ? httpStatusMatch[1] : undefined;
        const errorDetail = [
          `Workflow ${workflowSummary.id} ("${workflowSummary.name}")`,
          httpStatus ? `HTTP ${httpStatus}` : undefined,
          msg,
          `(${result.workflows_synced} workflows synced before failure)`,
          stack ? `Stack: ${stack.split('\n').slice(0, 3).join(' | ')}` : undefined,
        ].filter(Boolean).join(' — ');
        result.errors.push(errorDetail);
        result.failed_workflow_ids.push(workflowSummary.id);
      }
    }

    if (noNodesCount > 0) {
      console.log(`[WorkflowSync] ${noNodesCount}/${workflows.length} workflows had no parseable nodes (internal API format unrecognized)`);
    }

    // Soft-delete workflows no longer in GHL
    const activeWorkflowIds = workflows.map((w) => w.id);
    await softDeleteMissing('workflows', 'ghl_workflow_id', activeWorkflowIds, ghl.getLocationId());

    // Update sync log and sync state
    if (syncLog) {
      await supabase.from('sync_log').update({
        status: 'completed',
        records_synced: result.workflows_synced,
        completed_at: nowET(),
      }).eq('id', syncLog.id);
    }
    await updateLastSynced('workflows');

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const httpStatusMatch = msg.match(/error (\d{3})/i);
    const httpStatus = httpStatusMatch ? httpStatusMatch[1] : undefined;
    const fatalDetail = [
      'Fatal sync error',
      httpStatus ? `HTTP ${httpStatus}` : undefined,
      msg,
      `(${result.workflows_synced}/${result.workflows_total} workflows synced before failure)`,
      stack ? `Stack: ${stack.split('\n').slice(0, 5).join(' | ')}` : undefined,
    ].filter(Boolean).join(' — ');
    result.errors.push(fatalDetail);

    if (syncLog) {
      await supabase.from('sync_log').update({
        status: 'failed',
        error_message: fatalDetail,
        completed_at: nowET(),
      }).eq('id', syncLog.id);
    }
  } finally {
    // v1.9: Always release the overlap guard, even on fatal error.
    workflowSyncInProgress = false;
  }

  return result;
}
