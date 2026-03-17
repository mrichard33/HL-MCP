import { z } from 'zod';
import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';
import { extractAndSyncWorkflows } from '../extractor/workflow-extractor.js';
import {
  findDuplicateTriggers,
  detectCircularAutomations,
  detectMessageOverlap,
  detectWaitBottlenecks,
  detectDeadWorkflows,
} from '../analysis/detectors.js';
import {
  detectCycles,
  findUnreachableSteps,
  findBrokenFlows,
} from '../analysis/graph.js';

/**
 * Recursively traverses a templates array to extract all nodes including
 * those inside IF/ELSE branches. Follows `next` pointers and branch paths.
 */
function traverseTemplatesDeep(
  templates: Record<string, unknown>[],
): Record<string, unknown>[] {
  const templateMap = new Map<string, Record<string, unknown>>();
  for (const tmpl of templates) {
    const id = (tmpl.id || tmpl._id) as string;
    if (id) templateMap.set(id, tmpl);
  }

  const visited = new Set<string>();
  const result: Record<string, unknown>[] = [];

  function visit(id: string) {
    if (!id || visited.has(id)) return;
    visited.add(id);
    const tmpl = templateMap.get(id);
    if (!tmpl) return;
    result.push(tmpl);

    // Follow sequential next pointer
    const next = tmpl.next;
    if (typeof next === 'string' && next) {
      visit(next);
    } else if (Array.isArray(next)) {
      // IF/ELSE branches — follow all branch targets
      for (const branchTarget of next) {
        if (typeof branchTarget === 'string' && branchTarget) {
          visit(branchTarget);
        }
      }
    }

    // Check attributes for branch children
    const attrs = (tmpl.attributes || {}) as Record<string, unknown>;
    if (Array.isArray(attrs.branches)) {
      for (const branch of attrs.branches) {
        const b = branch as Record<string, unknown>;
        if (typeof b.nextStep === 'string') visit(b.nextStep);
        if (typeof b.target === 'string') visit(b.target);
        if (typeof b.id === 'string') visit(b.id);
      }
    }

    // Check data for branch children
    const data = (tmpl.data || {}) as Record<string, unknown>;
    if (Array.isArray(data.branches)) {
      for (const branch of data.branches) {
        const b = branch as Record<string, unknown>;
        if (typeof b.nextStep === 'string') visit(b.nextStep);
        if (typeof b.target === 'string') visit(b.target);
        if (typeof b.id === 'string') visit(b.id);
      }
    }
  }

  // Start traversal from all templates to catch any entry points
  for (const tmpl of templates) {
    const id = (tmpl.id || tmpl._id) as string;
    if (id) visit(id);
  }

  return result;
}

export const workflowAnalysisTools = {
  get_all_workflows: {
    description: 'Get a summary list of all workflows with their ID, name, status, and trigger type.',
    inputSchema: z.object({}),
    handler: async () => {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('workflows')
        .select('ghl_workflow_id, name, status, trigger_type')
        .is('deleted_at', null)
        .order('name');

      if (error) throw new Error(`Supabase error: ${error.message}`);
      return { workflows: data || [], count: data?.length || 0 };
    },
  },

  get_workflow_steps: {
    description: 'Get all steps for a specific workflow, ordered by step sequence. Includes nodes inside IF/ELSE branches. Set includeFullTemplates=true to also return the raw workflowData.templates structure for complete branch analysis. Set forceLive=true to fetch directly from the HighLevel API instead of Supabase cache.',
    inputSchema: z.object({
      workflowId: z.string().describe('The workflow ID to get steps for'),
      includeFullTemplates: z.boolean().optional().default(false).describe('Include the full workflowData.templates array with all branch nodes'),
      forceLive: z.boolean().optional().default(false).describe('Fetch live data from HighLevel API instead of Supabase cache'),
    }),
    handler: async (args: { workflowId: string; includeFullTemplates?: boolean; forceLive?: boolean }) => {
      if (args.forceLive) {
        // Fetch live from HighLevel API and parse all branches
        const ghl = new GHLClient();
        const detail = await ghl.getWorkflowDetail(args.workflowId);
        if (!detail) {
          // Fallback: try public API
          const pub = await ghl.getWorkflow(args.workflowId);
          return {
            steps: pub.steps || [],
            count: (pub.steps || []).length,
            source: 'highlevel_public_api',
            note: 'Public API may not include branch nodes. Configure Firebase auth for full detail.',
          };
        }

        // Extract templates and traverse all branches
        const wd = detail.workflowData as Record<string, unknown> | undefined;
        const templates = wd && Array.isArray(wd.templates) ? wd.templates as Record<string, unknown>[] : [];
        const allNodes = templates.length > 0 ? traverseTemplatesDeep(templates) : [];

        const steps = allNodes.map((tmpl, idx) => {
          const attrs = (tmpl.attributes || {}) as Record<string, unknown>;
          return {
            step_id: (tmpl.id || tmpl._id) as string,
            workflow_id: args.workflowId,
            step_order: idx + 1,
            step_type: (tmpl.type as string) || 'unknown',
            step_name: (tmpl.name as string) || (tmpl.type as string) || 'unknown',
            template_id: (attrs.template_id || attrs.templateId) as string || null,
            branch_condition: (attrs.conditionName || attrs.condition) as string || null,
            has_branches: Array.isArray(tmpl.next) && (tmpl.next as unknown[]).length > 1,
            raw_json: tmpl,
          };
        });

        return {
          steps,
          count: steps.length,
          source: 'highlevel_internal_api',
          ...(args.includeFullTemplates ? { full_templates: templates } : {}),
        };
      }

      // Default: read from Supabase cache
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('workflow_steps')
        .select('*')
        .eq('workflow_id', args.workflowId)
        .order('step_order', { ascending: true });

      if (error) throw new Error(`Supabase error: ${error.message}`);

      const steps = data || [];

      // If includeFullTemplates, also fetch raw_json from workflows table
      if (args.includeFullTemplates) {
        const { data: wfData } = await supabase
          .from('workflows')
          .select('raw_json')
          .eq('ghl_workflow_id', args.workflowId)
          .single();

        const raw = (wfData?.raw_json || {}) as Record<string, unknown>;
        const wd = raw.workflowData as Record<string, unknown> | undefined;
        const templates = wd && Array.isArray(wd.templates) ? wd.templates : [];

        return {
          steps,
          count: steps.length,
          source: 'supabase_cache',
          full_templates: templates,
          full_templates_count: templates.length,
        };
      }

      return { steps, count: steps.length, source: 'supabase_cache' };
    },
  },

  get_workflow_graph: {
    description: 'Get the connection graph (edges between steps) for a workflow. Also detects cycles, unreachable steps, and broken flows.',
    inputSchema: z.object({
      workflowId: z.string().describe('The workflow ID to get the graph for'),
    }),
    handler: async (args: { workflowId: string }) => {
      const supabase = getSupabaseClient();
      const { data: connections, error } = await supabase
        .from('workflow_connections')
        .select('*')
        .eq('workflow_id', args.workflowId);

      if (error) throw new Error(`Supabase error: ${error.message}`);

      const cycles = await detectCycles(args.workflowId);
      const unreachable = await findUnreachableSteps(args.workflowId);
      const broken = await findBrokenFlows(args.workflowId);

      return {
        connections: connections || [],
        analysis: {
          cycles: cycles.length > 0 ? cycles : 'none',
          unreachable_steps: unreachable.length > 0 ? unreachable : 'none',
          broken_flows: broken.length > 0 ? broken : 'none',
        },
      };
    },
  },

  find_duplicate_triggers: {
    description: 'Find workflows that share identical trigger events and values, which may cause automation conflicts.',
    inputSchema: z.object({}),
    handler: async () => {
      const duplicates = await findDuplicateTriggers();
      return {
        duplicates,
        count: duplicates.length,
        summary: duplicates.length > 0
          ? `Found ${duplicates.length} duplicate trigger group(s) that may cause conflicts.`
          : 'No duplicate triggers detected.',
      };
    },
  },

  detect_circular_automations: {
    description: 'Detect circular automation loops where workflows trigger each other in cycles (e.g., workflow A adds a tag that triggers workflow B which triggers workflow A).',
    inputSchema: z.object({}),
    handler: async () => {
      const circulars = await detectCircularAutomations();
      return {
        circular_automations: circulars,
        count: circulars.length,
        summary: circulars.length > 0
          ? `Found ${circulars.length} circular automation(s). These may cause infinite loops.`
          : 'No circular automations detected.',
      };
    },
  },

  detect_message_overlap: {
    description: 'Detect SMS or email actions across workflows that fire within a short interval, risking message flooding to contacts.',
    inputSchema: z.object({
      intervalMinutes: z.number().optional().default(5).describe('Maximum minutes between messages to flag as overlap (default: 5)'),
    }),
    handler: async (args: { intervalMinutes?: number }) => {
      const overlaps = await detectMessageOverlap(args.intervalMinutes || 5);
      return {
        overlaps,
        count: overlaps.length,
        summary: overlaps.length > 0
          ? `Found ${overlaps.length} messaging overlap(s). Consider staggering send times.`
          : 'No messaging overlaps detected.',
      };
    },
  },

  detect_wait_bottlenecks: {
    description: 'Find workflow steps with excessive wait/delay times that may bottleneck automation flow.',
    inputSchema: z.object({
      thresholdMinutes: z.number().optional().default(720).describe('Minimum delay in minutes to flag as a bottleneck (default: 720 = 12 hours)'),
    }),
    handler: async (args: { thresholdMinutes?: number }) => {
      const bottlenecks = await detectWaitBottlenecks(args.thresholdMinutes || 720);
      return {
        bottlenecks,
        count: bottlenecks.length,
        summary: bottlenecks.length > 0
          ? `Found ${bottlenecks.length} step(s) with delays exceeding ${args.thresholdMinutes || 720} minutes.`
          : 'No wait bottlenecks detected.',
      };
    },
  },

  detect_dead_workflows: {
    description: 'Detect workflows with triggers referencing deleted or non-existent resources (forms, pipeline stages, tags) or workflows stuck in draft status.',
    inputSchema: z.object({}),
    handler: async () => {
      const dead = await detectDeadWorkflows();
      return {
        dead_workflows: dead,
        count: dead.length,
        summary: dead.length > 0
          ? `Found ${dead.length} potentially dead workflow(s) referencing missing resources.`
          : 'No dead workflows detected.',
      };
    },
  },

  sync_workflow_intelligence: {
    description: '[HighLevel MCP — Workflow & Automation] Run a full workflow extraction and sync from GoHighLevel to Supabase. Populates workflow steps, triggers, actions, connections, and snapshots for analysis.',
    inputSchema: z.object({}),
    handler: async () => {
      const result = await extractAndSyncWorkflows();
      return {
        ...result,
        summary: result.errors.length > 0
          ? `Sync completed with ${result.errors.length} error(s).`
          : `Sync completed successfully: ${result.workflows_synced} workflows, ${result.steps_synced} steps, ${result.triggers_synced} triggers, ${result.actions_synced} actions.`,
      };
    },
  },

  get_workflow_diff: {
    description: 'Compare workflow versions to detect what changed. Returns added, removed, and modified nodes, changed template IDs, and trigger configuration changes. Uses workflow snapshots stored during sync.',
    inputSchema: z.object({
      workflowId: z.string().describe('The workflow ID to compare versions for'),
      sinceVersion: z.number().optional().describe('Compare current version against this specific version number'),
      sinceDate: z.string().optional().describe('Compare current version against the most recent snapshot before this ISO date'),
    }),
    handler: async (args: { workflowId: string; sinceVersion?: number; sinceDate?: string }) => {
      const supabase = getSupabaseClient();

      // Get latest snapshot
      const { data: latestSnapshots } = await supabase
        .from('workflow_snapshots')
        .select('version, json_structure, created_at')
        .eq('workflow_id', args.workflowId)
        .order('version', { ascending: false })
        .limit(1);

      if (!latestSnapshots || latestSnapshots.length === 0) {
        return { error: 'No snapshots found for this workflow. Run sync_workflows first.' };
      }

      const latest = latestSnapshots[0];

      // Get the comparison snapshot
      let compareQuery = supabase
        .from('workflow_snapshots')
        .select('version, json_structure, created_at')
        .eq('workflow_id', args.workflowId);

      if (args.sinceVersion !== undefined) {
        compareQuery = compareQuery.eq('version', args.sinceVersion);
      } else if (args.sinceDate) {
        compareQuery = compareQuery.lte('created_at', args.sinceDate).order('version', { ascending: false });
      } else {
        // Default: compare with previous version
        compareQuery = compareQuery.lt('version', latest.version).order('version', { ascending: false });
      }

      const { data: compareSnapshots } = await compareQuery.limit(1);

      if (!compareSnapshots || compareSnapshots.length === 0) {
        return {
          workflow_id: args.workflowId,
          current_version: latest.version,
          current_updated_at: latest.created_at,
          diff: null,
          note: 'Only one version exists — no previous version to compare against.',
        };
      }

      const previous = compareSnapshots[0];

      // Extract templates/nodes from both versions for comparison
      const getTemplates = (snapshot: Record<string, unknown>): Record<string, unknown>[] => {
        const wd = snapshot.workflowData as Record<string, unknown> | undefined;
        if (wd && Array.isArray(wd.templates)) return wd.templates as Record<string, unknown>[];
        if (Array.isArray(snapshot.nodes)) return snapshot.nodes as Record<string, unknown>[];
        if (Array.isArray(snapshot.steps)) return snapshot.steps as Record<string, unknown>[];
        return [];
      };

      const latestJson = (latest.json_structure || {}) as Record<string, unknown>;
      const previousJson = (previous.json_structure || {}) as Record<string, unknown>;
      const latestTemplates = getTemplates(latestJson);
      const previousTemplates = getTemplates(previousJson);

      const latestNodeMap = new Map(latestTemplates.map(t => [(t.id || t._id) as string, t]));
      const previousNodeMap = new Map(previousTemplates.map(t => [(t.id || t._id) as string, t]));

      // Compute diff
      const addedNodes: string[] = [];
      const removedNodes: string[] = [];
      const modifiedNodes: Array<{ id: string; type: string; changes: string[] }> = [];
      const changedTemplateIds: Array<{ nodeId: string; oldTemplateId: string | null; newTemplateId: string | null }> = [];

      // Find added and modified nodes
      for (const [id, node] of latestNodeMap) {
        if (!previousNodeMap.has(id)) {
          addedNodes.push(`${id} (${(node.type as string) || (node.name as string) || 'unknown'})`);
        } else {
          const prev = previousNodeMap.get(id)!;
          const changes: string[] = [];
          if ((node.type as string) !== (prev.type as string)) changes.push(`type: ${prev.type} → ${node.type}`);
          if ((node.name as string) !== (prev.name as string)) changes.push(`name: ${prev.name} → ${node.name}`);

          const nodeAttrs = (node.attributes || {}) as Record<string, unknown>;
          const prevAttrs = (prev.attributes || {}) as Record<string, unknown>;
          const newTid = (nodeAttrs.template_id || nodeAttrs.templateId) as string || null;
          const oldTid = (prevAttrs.template_id || prevAttrs.templateId) as string || null;
          if (newTid !== oldTid) {
            changes.push(`template_id: ${oldTid} → ${newTid}`);
            changedTemplateIds.push({ nodeId: id, oldTemplateId: oldTid, newTemplateId: newTid });
          }

          if (JSON.stringify(node.next) !== JSON.stringify(prev.next)) changes.push('connections changed');

          if (changes.length > 0) {
            modifiedNodes.push({ id, type: (node.type as string) || 'unknown', changes });
          }
        }
      }

      // Find removed nodes
      for (const [id, node] of previousNodeMap) {
        if (!latestNodeMap.has(id)) {
          removedNodes.push(`${id} (${(node.type as string) || (node.name as string) || 'unknown'})`);
        }
      }

      // Check trigger changes
      const latestTriggers = (latestJson.triggers || []) as Record<string, unknown>[];
      const previousTriggers = (previousJson.triggers || []) as Record<string, unknown>[];
      const triggerChanged = JSON.stringify(latestTriggers) !== JSON.stringify(previousTriggers);

      return {
        workflow_id: args.workflowId,
        current_version: latest.version,
        current_updated_at: latest.created_at,
        compared_version: previous.version,
        compared_updated_at: previous.created_at,
        has_changes: addedNodes.length > 0 || removedNodes.length > 0 || modifiedNodes.length > 0 || triggerChanged,
        diff: {
          added_nodes: addedNodes,
          removed_nodes: removedNodes,
          modified_nodes: modifiedNodes,
          changed_template_ids: changedTemplateIds,
          trigger_config_changed: triggerChanged,
        },
        summary: [
          addedNodes.length > 0 ? `${addedNodes.length} node(s) added` : null,
          removedNodes.length > 0 ? `${removedNodes.length} node(s) removed` : null,
          modifiedNodes.length > 0 ? `${modifiedNodes.length} node(s) modified` : null,
          changedTemplateIds.length > 0 ? `${changedTemplateIds.length} template ID(s) changed` : null,
          triggerChanged ? 'trigger configuration changed' : null,
        ].filter(Boolean).join(', ') || 'No changes detected',
      };
    },
  },
};
