import { z } from 'zod';
import { getSupabaseClient } from '../../clients/supabase.js';
import { syncTemplates } from '../../extractor/template-syncer.js';

export const templateTools = {
  list_templates: {
    description:
      'List email/SMS templates from Supabase cache. Filter by type (email, sms, whatsapp) or search by name. Returns id, name, type, subject, body preview.',
    inputSchema: z.object({
      type: z
        .enum(['email', 'sms', 'whatsapp'])
        .optional()
        .describe('Filter by template type'),
      search: z
        .string()
        .optional()
        .describe('Search templates by name (case-insensitive partial match)'),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe('Max results (default 50)'),
      include_body: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include full template body in results (default false for performance)'),
    }),
    handler: async (args: { type?: string; search?: string; limit?: number; include_body?: boolean }) => {
      const supabase = getSupabaseClient();
      const limit = args.limit || 50;
      const fields = args.include_body
        ? 'ghl_template_id, name, type, subject, body, date_added, date_updated, synced_at'
        : 'ghl_template_id, name, type, subject, date_added, date_updated, synced_at';

      let query = supabase
        .from('templates')
        .select(fields)
        .is('deleted_at', null)
        .order('name', { ascending: true })
        .limit(limit);

      if (args.type) {
        query = query.eq('type', args.type);
      }

      if (args.search) {
        query = query.ilike('name', `%${args.search}%`);
      }

      const { data, error, count } = await query;
      if (error) throw new Error(`Template query failed: ${error.message}`);

      return {
        templates: data || [],
        count: data?.length || 0,
        filter: {
          type: args.type || 'all',
          search: args.search || null,
        },
      };
    },
  },

  get_template: {
    description:
      'Get a single template by GHL template ID. Returns full body, subject, type, and raw JSON.',
    inputSchema: z.object({
      template_id: z.string().describe('GHL template ID'),
    }),
    handler: async (args: { template_id: string }) => {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('templates')
        .select('*')
        .eq('ghl_template_id', args.template_id)
        .is('deleted_at', null)
        .single();

      if (error) throw new Error(`Template not found: ${error.message}`);
      return data;
    },
  },

  sync_templates: {
    description:
      'Manually trigger a full sync of all email/SMS templates from GHL to Supabase. Fetches from GET /locations/:locationId/templates.',
    inputSchema: z.object({}),
    handler: async (_args: Record<string, never>) => {
      const result = await syncTemplates();
      return {
        synced: result.synced,
        errors: result.errors.length > 0 ? result.errors : 'none',
      };
    },
  },
};
