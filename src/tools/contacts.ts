import { z } from 'zod';
import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';
import { nowET } from '../utils/timezone.js';

export const contactTools = {
  search_contacts: {
    description: 'Search for contacts. Queries Supabase by default. Set forceLive=true for live GHL API.',
    inputSchema: z.object({
      query: z.string().optional().describe('Search query (name, email, phone)'),
      limit: z.number().optional().default(20).describe('Max results to return'),
      forceLive: z.boolean().optional().default(false).describe('Bypass Supabase and query GHL API directly'),
    }),
    handler: async (args: { query?: string; limit?: number; forceLive?: boolean }) => {
      if (!args.forceLive) {
        const supabase = getSupabaseClient();
        let qb = supabase.from('contacts').select('*').is('deleted_at', null).limit(args.limit || 20);
        if (args.query) {
          qb = qb.or(
            `first_name.ilike.%${args.query}%,last_name.ilike.%${args.query}%,email.ilike.%${args.query}%,phone.ilike.%${args.query}%`
          );
        }
        const { data, error } = await qb;
        if (error) throw new Error(`Supabase error: ${error.message}`);
        return { contacts: data, source: 'supabase' };
      }
      const ghl = new GHLClient();
      const result = await ghl.getContacts({ query: args.query, limit: args.limit });
      return { ...result, source: 'ghl_api' };
    },
  },

  get_contact: {
    description: 'Get a single contact by ID. Checks Supabase first, falls back to GHL API. Set forceLive=true to skip cache.',
    inputSchema: z.object({
      contactId: z.string().describe('GoHighLevel contact ID'),
      forceLive: z.boolean().optional().default(false).describe('Bypass Supabase and query GHL API directly'),
    }),
    handler: async (args: { contactId: string; forceLive?: boolean }) => {
      if (!args.forceLive) {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase
          .from('contacts')
          .select('*')
          .eq('ghl_contact_id', args.contactId)
          .is('deleted_at', null)
          .single();
        if (!error && data) {
          return { contact: data, source: 'supabase' };
        }
        // Not found in Supabase — fall back to GHL API
      }
      const ghl = new GHLClient();
      const contact = await ghl.getContact(args.contactId);
      return { contact, source: 'ghl_api' };
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
    description: 'Update an existing contact in GoHighLevel. WARNING: tags array does FULL REPLACEMENT — use add_tags/remove_tags for safe additive operations.',
    inputSchema: z.object({
      contactId: z.string().describe('GoHighLevel contact ID'),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      companyName: z.string().optional(),
      tags: z.array(z.string()).optional().describe('FULL REPLACEMENT — replaces ALL tags. Use add_tags/remove_tags instead for safe operations.'),
    }),
    handler: async (args: { contactId: string; [key: string]: unknown }) => {
      const ghl = new GHLClient();
      const { contactId, ...data } = args;
      return ghl.updateContact(contactId, data);
    },
  },

  add_tags: {
    description: 'Add tags to a contact WITHOUT removing existing tags. Safe additive operation.',
    inputSchema: z.object({
      contactId: z.string().describe('GoHighLevel contact ID'),
      tags: z.array(z.string()).describe('Tags to add (existing tags are preserved)'),
    }),
    handler: async (args: { contactId: string; tags: string[] }) => {
      const ghl = new GHLClient();
      const result = await ghl.addContactTags(args.contactId, args.tags);
      return { success: true, tags: result.tags, operation: 'add' };
    },
  },

  remove_tags: {
    description: 'Remove specific tags from a contact WITHOUT affecting other tags. Safe subtractive operation.',
    inputSchema: z.object({
      contactId: z.string().describe('GoHighLevel contact ID'),
      tags: z.array(z.string()).describe('Tags to remove (other tags are preserved)'),
    }),
    handler: async (args: { contactId: string; tags: string[] }) => {
      const ghl = new GHLClient();
      const result = await ghl.removeContactTags(args.contactId, args.tags);
      return { success: true, tags: result.tags, operation: 'remove' };
    },
  },

  add_note: {
    description: 'Add an internal note to a contact\'s GoHighLevel record. Notes are visible to all reps. Body must be 1–2000 chars; HTML tags are stripped.',
    inputSchema: z.object({
      contactId: z.string().describe('GoHighLevel contact ID'),
      body: z.string().describe('Note body (1–2000 chars, HTML stripped)'),
      userId: z.string().optional().describe('GHL user ID to attribute the note to (default: API user)'),
    }),
    handler: async (args: { contactId: string; body: string; userId?: string }) => {
      const stripped = (args.body || '').replace(/<[^>]+>/g, '').trim();
      if (!stripped) {
        throw new Error('Note body must not be empty.');
      }
      if (stripped.length > 2000) {
        throw new Error(`Note body must be ≤ 2000 chars (got ${stripped.length}).`);
      }
      const ghl = new GHLClient();
      const note = await ghl.addContactNote(args.contactId, stripped, args.userId);
      return { note_id: note.id, created_at: note.dateAdded, body: note.body };
    },
  },

  update_custom_fields: {
    description: 'Update custom fields on a contact without touching tags or other standard fields. Pass an array of {id, field_value} objects.',
    inputSchema: z.object({
      contactId: z.string().describe('GoHighLevel contact ID'),
      customFields: z.array(z.object({
        id: z.string().describe('Custom field ID (e.g. ZZCpHTthFMaVc3g5vMAS)'),
        field_value: z.union([z.string(), z.number(), z.boolean()]).describe('Value to set'),
      })).describe('Array of custom field updates'),
    }),
    handler: async (args: { contactId: string; customFields: Array<{ id: string; field_value: string | number | boolean }> }) => {
      const ghl = new GHLClient();
      const contact = await ghl.updateContactCustomFields(args.contactId, args.customFields);
      return { success: true, contact };
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
