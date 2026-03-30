import { z } from 'zod';
import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';
import { nowET } from '../utils/timezone.js';

export const pipelineTools = {
  list_pipelines: {
    description: 'List all pipelines and their stages. Queries Supabase by default (primary source). Set forceLive=true to bypass Supabase and query the GHL API directly.',
    inputSchema: z.object({
      forceLive: z.boolean().optional().default(false).describe('Bypass Supabase and query GHL API directly'),
    }),
    handler: async (args: { forceLive?: boolean }) => {
      if (!args.forceLive) {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase.from('pipelines').select('*').is('deleted_at', null);
        if (error) throw new Error(`Supabase error: ${error.message}`);
        return { pipelines: data, source: 'supabase' };
      }
      const ghl = new GHLClient();
      const pipelines = await ghl.getPipelines();
      return { pipelines, source: 'ghl_api' };
    },
  },

  get_opportunities: {
    description: 'Get opportunities (deals) from a pipeline, optionally filtered by stage or status. Queries Supabase by default (primary source). Set forceLive=true to bypass Supabase and query the GHL API directly.',
    inputSchema: z.object({
      pipelineId: z.string().optional().describe('Filter by pipeline ID'),
      stageId: z.string().optional().describe('Filter by stage ID'),
      status: z.enum(['open', 'won', 'lost', 'abandoned']).optional(),
      limit: z.number().optional().default(20),
      forceLive: z.boolean().optional().default(false).describe('Bypass Supabase and query GHL API directly'),
    }),
    handler: async (args: { pipelineId?: string; stageId?: string; status?: string; limit?: number; forceLive?: boolean }) => {
      if (!args.forceLive) {
        const supabase = getSupabaseClient();
        let qb = supabase.from('opportunities').select('*').is('deleted_at', null).limit(args.limit || 20);
        if (args.pipelineId) qb = qb.eq('ghl_pipeline_id', args.pipelineId);
        if (args.stageId) qb = qb.eq('ghl_stage_id', args.stageId);
        if (args.status) qb = qb.eq('status', args.status);
        const { data, error } = await qb;
        if (error) throw new Error(`Supabase error: ${error.message}`);
        return { opportunities: data, source: 'supabase' };
      }
      const ghl = new GHLClient();
      const result = await ghl.getOpportunities({
        pipelineId: args.pipelineId, stageId: args.stageId, status: args.status, limit: args.limit,
      });
      return { ...result, source: 'ghl_api' };
    },
  },

  create_opportunity: {
    description: 'Create a new opportunity (deal) in GoHighLevel.',
    inputSchema: z.object({
      pipelineId: z.string().describe('Pipeline ID'),
      name: z.string().describe('Opportunity name'),
      stageId: z.string().optional(),
      contactId: z.string().optional(),
      monetaryValue: z.number().optional(),
      status: z.enum(['open', 'won', 'lost', 'abandoned']).optional().default('open'),
    }),
    handler: async (args: Record<string, unknown>) => {
      const ghl = new GHLClient();
      // GHL API requires 'pipelineStageId', not 'stageId'
      const data = { ...args };
      if (data.stageId) {
        data.pipelineStageId = data.stageId;
        delete data.stageId;
      }
      return ghl.createOpportunity(data);
    },
  },

  update_opportunity: {
    description: 'Update an existing opportunity in GoHighLevel.',
    inputSchema: z.object({
      opportunityId: z.string().describe('Opportunity ID'),
      name: z.string().optional(),
      stageId: z.string().optional(),
      status: z.enum(['open', 'won', 'lost', 'abandoned']).optional(),
      monetaryValue: z.number().optional(),
    }),
    handler: async (args: { opportunityId: string; [key: string]: unknown }) => {
      const ghl = new GHLClient();
      const { opportunityId, ...data } = args;
      // GHL API requires 'pipelineStageId', not 'stageId'
      if (data.stageId) {
        data.pipelineStageId = data.stageId;
        delete data.stageId;
      }
      return ghl.updateOpportunity(opportunityId, data);
    },
  },

  sync_pipelines: {
    description: 'Sync pipelines and opportunities from GHL to Supabase cache.',
    inputSchema: z.object({}),
    handler: async () => {
      const ghl = new GHLClient();
      const supabase = getSupabaseClient();

      const pipelines = await ghl.getPipelines();
      const pipelineRows = pipelines.map((p) => ({
        ghl_pipeline_id: p.id,
        ghl_location_id: p.locationId,
        name: p.name,
        stages: p.stages,
        synced_at: nowET(),
      }));

      const { error } = await supabase.from('pipelines').upsert(pipelineRows, { onConflict: 'ghl_pipeline_id' });
      if (error) throw new Error(`Supabase error: ${error.message}`);

      return { synced_pipelines: pipelineRows.length, status: 'completed' };
    },
  },
};
