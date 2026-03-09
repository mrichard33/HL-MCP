import { z } from 'zod';
import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';

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
    description: 'Sync workflows from GoHighLevel to Supabase cache.',
    inputSchema: z.object({}),
    handler: async () => {
      const ghl = new GHLClient();
      const supabase = getSupabaseClient();

      const workflows = await ghl.getWorkflows();
      const rows = workflows.map((w) => ({
        ghl_workflow_id: w.id,
        ghl_location_id: w.locationId,
        name: w.name,
        status: w.status,
        version: w.version || 1,
        synced_at: new Date().toISOString(),
      }));

      const { error } = await supabase.from('workflows').upsert(rows, { onConflict: 'ghl_workflow_id' });
      if (error) throw new Error(`Supabase error: ${error.message}`);

      return { synced: rows.length, status: 'completed' };
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
};
