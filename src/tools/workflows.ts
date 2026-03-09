import { z } from 'zod';
import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';
import { extractAndSyncWorkflows } from '../extractor/workflow-extractor.js';
import {
  syncContacts,
  syncOpportunities,
  syncAppointments,
  syncPipelines,
  syncConversationsAndMessages,
} from '../extractor/entity-syncer.js';

export const workflowTools = {
  list_workflows: {
    description: 'List all workflows from GoHighLevel.',
    inputSchema: z.object({
      useCache: z.boolean().optional().default(false).describe('Read from Supabase cache'),
    }),
    handler: async (args: { useCache?: boolean }) => {
      if (args.useCache) {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase.from('workflows').select('*');
        if (error) throw new Error(`Supabase error: ${error.message}`);
        return { workflows: data, source: 'cache' };
      }
      const ghl = new GHLClient();
      const workflows = await ghl.getWorkflows();
      return { workflows, source: 'ghl_api' };
    },
  },

  sync_workflows: {
    description: 'Full sync of workflows from GoHighLevel to Supabase — fetches complete workflow JSON with all steps, triggers, actions, and connections.',
    inputSchema: z.object({}),
    handler: async () => {
      const result = await extractAndSyncWorkflows();
      return {
        workflows_synced: result.workflows_synced,
        steps_synced: result.steps_synced,
        triggers_synced: result.triggers_synced,
        actions_synced: result.actions_synced,
        connections_synced: result.connections_synced,
        snapshots_created: result.snapshots_created,
        errors: result.errors,
        status: result.errors.length === 0 ? 'completed' : 'completed_with_errors',
      };
    },
  },

  get_workflow_executions: {
    description: 'Query workflow execution history from Supabase for analytics.',
    inputSchema: z.object({
      workflowId: z.string().optional().describe('Filter by workflow ID'),
      status: z.enum(['running', 'completed', 'failed']).optional(),
      limit: z.number().optional().default(50),
      since: z.string().optional().describe('ISO date string — only executions after this date'),
    }),
    handler: async (args: { workflowId?: string; status?: string; limit?: number; since?: string }) => {
      const supabase = getSupabaseClient();
      let qb = supabase.from('workflow_executions').select('*').order('started_at', { ascending: false }).limit(args.limit || 50);
      if (args.workflowId) qb = qb.eq('ghl_workflow_id', args.workflowId);
      if (args.status) qb = qb.eq('status', args.status);
      if (args.since) qb = qb.gte('started_at', args.since);

      const { data, error } = await qb;
      if (error) throw new Error(`Supabase error: ${error.message}`);
      return { executions: data, count: data?.length || 0 };
    },
  },

  log_workflow_execution: {
    description: 'Log a workflow execution event to Supabase for tracking and analytics.',
    inputSchema: z.object({
      workflowId: z.string().describe('GHL workflow ID'),
      contactId: z.string().optional(),
      status: z.enum(['running', 'completed', 'failed']).default('running'),
      stepsCompleted: z.number().optional().default(0),
      stepsTotal: z.number().optional().default(0),
      errorMessage: z.string().optional(),
      executionData: z.record(z.unknown()).optional(),
    }),
    handler: async (args: {
      workflowId: string; contactId?: string; status: string;
      stepsCompleted?: number; stepsTotal?: number; errorMessage?: string; executionData?: Record<string, unknown>;
    }) => {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.from('workflow_executions').insert({
        ghl_workflow_id: args.workflowId,
        ghl_contact_id: args.contactId,
        status: args.status,
        steps_completed: args.stepsCompleted || 0,
        steps_total: args.stepsTotal || 0,
        error_message: args.errorMessage,
        execution_data: args.executionData || {},
        completed_at: args.status !== 'running' ? new Date().toISOString() : null,
      }).select().single();

      if (error) throw new Error(`Supabase error: ${error.message}`);
      return data;
    },
  },

  workflow_analytics: {
    description: 'Get workflow analytics: success/failure rates, average completion, and trends.',
    inputSchema: z.object({
      workflowId: z.string().optional().describe('Filter by specific workflow'),
      days: z.number().optional().default(30).describe('Look-back period in days'),
    }),
    handler: async (args: { workflowId?: string; days?: number }) => {
      const supabase = getSupabaseClient();
      const since = new Date();
      since.setDate(since.getDate() - (args.days || 30));

      let qb = supabase.from('workflow_executions').select('*').gte('started_at', since.toISOString());
      if (args.workflowId) qb = qb.eq('ghl_workflow_id', args.workflowId);

      const { data, error } = await qb;
      if (error) throw new Error(`Supabase error: ${error.message}`);

      const executions = data || [];
      const total = executions.length;
      const completed = executions.filter((e) => e.status === 'completed').length;
      const failed = executions.filter((e) => e.status === 'failed').length;
      const running = executions.filter((e) => e.status === 'running').length;

      const completedWithTime = executions.filter((e) => e.status === 'completed' && e.completed_at && e.started_at);
      const avgDurationMs = completedWithTime.length > 0
        ? completedWithTime.reduce((sum, e) => {
            return sum + (new Date(e.completed_at).getTime() - new Date(e.started_at).getTime());
          }, 0) / completedWithTime.length
        : 0;

      return {
        period_days: args.days || 30,
        total_executions: total,
        completed,
        failed,
        running,
        success_rate: total > 0 ? ((completed / total) * 100).toFixed(1) + '%' : 'N/A',
        failure_rate: total > 0 ? ((failed / total) * 100).toFixed(1) + '%' : 'N/A',
        avg_duration_seconds: avgDurationMs > 0 ? (avgDurationMs / 1000).toFixed(1) : 'N/A',
      };
    },
  },

  inspect_workflow_raw_json: {
    description: 'Inspect the raw JSON structure of a workflow stored in Supabase. Useful for debugging workflow data extraction.',
    inputSchema: z.object({
      workflowId: z.string().describe('GHL workflow ID'),
    }),
    handler: async (args: { workflowId: string }) => {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('workflows')
        .select('ghl_workflow_id, name, trigger_type, trigger_config, actions, raw_json')
        .eq('ghl_workflow_id', args.workflowId)
        .single();

      if (error) throw new Error(`Supabase error: ${error.message}`);
      if (!data) throw new Error(`Workflow ${args.workflowId} not found`);

      const raw = (data.raw_json || {}) as Record<string, unknown>;
      return {
        workflow_id: data.ghl_workflow_id,
        name: data.name,
        current_trigger_type: data.trigger_type,
        current_trigger_config: data.trigger_config,
        current_actions: data.actions,
        raw_json_top_level_keys: Object.keys(raw),
        raw_json_structure: Object.fromEntries(
          Object.entries(raw).map(([k, v]) => [
            k,
            Array.isArray(v)
              ? `Array[${v.length}]${v.length > 0 ? ` of ${typeof v[0]}` : ''}`
              : typeof v,
          ])
        ),
        raw_json: raw,
      };
    },
  },

  sync_all_entities: {
    description: 'Run a full sync of all entities (contacts, opportunities, appointments, pipelines, conversations, messages) from GoHighLevel to Supabase.',
    inputSchema: z.object({}),
    handler: async () => {
      const results: Record<string, unknown> = {};

      try {
        const contactResult = await syncContacts();
        results.contacts = { synced: contactResult.synced, errors: contactResult.errors.length };
      } catch (err) {
        results.contacts = { error: err instanceof Error ? err.message : String(err) };
      }

      try {
        const oppResult = await syncOpportunities();
        results.opportunities = { synced: oppResult.synced, errors: oppResult.errors.length };
      } catch (err) {
        results.opportunities = { error: err instanceof Error ? err.message : String(err) };
      }

      try {
        const aptResult = await syncAppointments();
        results.appointments = { synced: aptResult.synced, errors: aptResult.errors.length };
      } catch (err) {
        results.appointments = { error: err instanceof Error ? err.message : String(err) };
      }

      try {
        const pipResult = await syncPipelines();
        results.pipelines = { synced: pipResult.synced, errors: pipResult.errors.length };
      } catch (err) {
        results.pipelines = { error: err instanceof Error ? err.message : String(err) };
      }

      try {
        const convResult = await syncConversationsAndMessages();
        results.conversations = {
          synced_conversations: convResult.synced_conversations,
          synced_messages: convResult.synced_messages,
          errors: convResult.errors.length,
        };
      } catch (err) {
        results.conversations = { error: err instanceof Error ? err.message : String(err) };
      }

      return results;
    },
  },
};
