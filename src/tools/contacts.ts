import { z } from 'zod';
import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';
import { nowET } from '../utils/timezone.js';

export const contactTools = {
  search_contacts: {
    description: 'Search for contacts in GoHighLevel. Optionally searches Supabase cache.',
    inputSchema: z.object({
      query: z.string().optional().describe('Search query (name, email, phone)'),
      limit: z.number().optional().default(20).describe('Max results to return'),
      useCache: z.boolean().optional().default(false).describe('Search Supabase cache instead of GHL API'),
    }),
    handler: async (args: { query?: string; limit?: number; useCache?: boolean }) => {
      if (args.useCache) {
        const supabase = getSupabaseClient();
        let qb = supabase.from('contacts').select('*').is('deleted_at', null).limit(args.limit || 20);
        if (args.query) {
          qb = qb.or(
            `first_name.ilike.%${args.query}%,last_name.ilike.%${args.query}%,email.ilike.%${args.query}%,phone.ilike.%${args.query}%`
          );
        }
        const { data, error } = await qb;
        if (error) throw new Error(`Supabase error: ${error.message}`);
        return { contacts: data, source: 'cache' };
      }
      const ghl = new GHLClient();
      const result = await ghl.getContacts({ query: args.query, limit: args.limit });
      return { ...result, source: 'ghl_api' };
    },
  },

  get_contact: {
    description: 'Get a single contact by GHL contact ID.',
    inputSchema: z.object({
      contactId: z.string().describe('GoHighLevel contact ID'),
    }),
    handler: async (args: { contactId: string }) => {
      const ghl = new GHLClient();
      return ghl.getContact(args.contactId);
    },
  },

  create_contact: {
    description: 'Create a new contact in GoHighLevel.',
    inputSchema: z.object({
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      companyName: z.string().optional(),
      tags: z.array(z.string()).optional(),
      source: z.string().optional(),
    }),
    handler: async (args: Record<string, unknown>) => {
      const ghl = new GHLClient();
      return ghl.createContact(args);
    },
  },

  update_contact: {
    description: 'Update an existing contact in GoHighLevel.',
    inputSchema: z.object({
      contactId: z.string().describe('GoHighLevel contact ID'),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      companyName: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
    handler: async (args: { contactId: string; [key: string]: unknown }) => {
      const ghl = new GHLClient();
      const { contactId, ...data } = args;
      return ghl.updateContact(contactId, data);
    },
  },

  delete_contact: {
    description: 'Delete a contact from GoHighLevel.',
    inputSchema: z.object({
      contactId: z.string().describe('GoHighLevel contact ID'),
    }),
    handler: async (args: { contactId: string }) => {
      const ghl = new GHLClient();
      await ghl.deleteContact(args.contactId);
      return { success: true, message: `Contact ${args.contactId} deleted.` };
    },
  },

  sync_contacts: {
    description: 'Sync contacts from GoHighLevel API to Supabase cache for faster querying and analytics.',
    inputSchema: z.object({
      limit: z.number().optional().default(100).describe('Number of contacts to sync'),
    }),
    handler: async (args: { limit?: number }) => {
      const ghl = new GHLClient();
      const supabase = getSupabaseClient();

      const { data: syncLog } = await supabase
        .from('sync_log')
        .insert({ entity_type: 'contacts', sync_type: 'incremental', status: 'running' })
        .select()
        .single();

      try {
        const { contacts } = await ghl.getContacts({ limit: args.limit });
        const rows = contacts.map((c) => ({
          ghl_contact_id: c.id,
          ghl_location_id: c.locationId,
          first_name: c.firstName,
          last_name: c.lastName,
          email: c.email,
          phone: c.phone,
          company_name: c.companyName,
          tags: c.tags || [],
          source: c.source,
          custom_fields: c.customFields || {},
          date_added: c.dateAdded,
          date_updated: c.dateUpdated,
          synced_at: nowET(),
        }));

        const { error } = await supabase.from('contacts').upsert(rows, { onConflict: 'ghl_contact_id' });
        if (error) throw new Error(`Supabase upsert error: ${error.message}`);

        if (syncLog) {
          await supabase.from('sync_log').update({
            status: 'completed', records_synced: rows.length, completed_at: nowET(),
          }).eq('id', syncLog.id);
        }
        return { synced: rows.length, status: 'completed' };
      } catch (err) {
        if (syncLog) {
          await supabase.from('sync_log').update({
            status: 'failed', error_message: err instanceof Error ? err.message : String(err), completed_at: nowET(),
          }).eq('id', syncLog.id);
        }
        throw err;
      }
    },
  },
};
