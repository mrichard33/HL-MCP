import { z } from 'zod';
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
    description: 'Get all steps for a specific workflow, ordered by step sequence.',
    inputSchema: z.object({
      workflowId: z.string().describe('The workflow ID to get steps for'),
    }),
    handler: async (args: { workflowId: string }) => {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('workflow_steps')
        .select('*')
        .eq('workflow_id', args.workflowId)
        .order('step_order', { ascending: true });

      if (error) throw new Error(`Supabase error: ${error.message}`);
      return { steps: data || [], count: data?.length || 0 };
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
    description: 'Run a full workflow extraction and sync from GoHighLevel to Supabase. Populates workflow steps, triggers, actions, connections, and snapshots for analysis.',
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
};
