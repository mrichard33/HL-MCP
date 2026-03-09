import { z } from 'zod';
import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';

export const conversationTools = {
  list_conversations: {
    description: 'List conversations from GoHighLevel, optionally filtered by contact.',
    inputSchema: z.object({
      contactId: z.string().optional().describe('Filter by contact ID'),
      limit: z.number().optional().default(20),
      useCache: z.boolean().optional().default(false),
    }),
    handler: async (args: { contactId?: string; limit?: number; useCache?: boolean }) => {
      if (args.useCache) {
        const supabase = getSupabaseClient();
        let qb = supabase.from('conversations').select('*').limit(args.limit || 20);
        if (args.contactId) qb = qb.eq('ghl_contact_id', args.contactId);
        const { data, error } = await qb;
        if (error) throw new Error(`Supabase error: ${error.message}`);
        return { conversations: data, source: 'cache' };
      }
      const ghl = new GHLClient();
      const result = await ghl.getConversations({ contactId: args.contactId, limit: args.limit });
      return { ...result, source: 'ghl_api' };
    },
  },

  get_conversation: {
    description: 'Get a single conversation by ID.',
    inputSchema: z.object({
      conversationId: z.string().describe('GHL conversation ID'),
    }),
    handler: async (args: { conversationId: string }) => {
      const ghl = new GHLClient();
      return ghl.getConversation(args.conversationId);
    },
  },

  get_messages: {
    description: 'Get messages in a conversation.',
    inputSchema: z.object({
      conversationId: z.string().describe('GHL conversation ID'),
    }),
    handler: async (args: { conversationId: string }) => {
      const ghl = new GHLClient();
      return ghl.getMessages(args.conversationId);
    },
  },

  send_message: {
    description: 'Send a message in a conversation via GoHighLevel.',
    inputSchema: z.object({
      conversationId: z.string().describe('GHL conversation ID'),
      contactId: z.string().describe('GHL contact ID'),
      type: z.enum(['SMS', 'Email', 'WhatsApp', 'GMB', 'IG', 'FB']).default('SMS'),
      message: z.string().describe('Message body'),
    }),
    handler: async (args: { conversationId: string; contactId: string; type: string; message: string }) => {
      const ghl = new GHLClient();
      return ghl.sendMessage(args);
    },
  },

  sync_conversations: {
    description: 'Sync conversations from GoHighLevel to Supabase cache.',
    inputSchema: z.object({
      contactId: z.string().optional(),
      limit: z.number().optional().default(50),
    }),
    handler: async (args: { contactId?: string; limit?: number }) => {
      const ghl = new GHLClient();
      const supabase = getSupabaseClient();

      const { conversations } = await ghl.getConversations({ contactId: args.contactId, limit: args.limit });
      const rows = conversations.map((c) => ({
        ghl_conversation_id: c.id,
        ghl_contact_id: c.contactId,
        ghl_location_id: c.locationId,
        type: c.type || 'sms',
        last_message_at: c.lastMessageDate,
        unread_count: c.unreadCount || 0,
        synced_at: new Date().toISOString(),
      }));

      const { error } = await supabase.from('conversations').upsert(rows, { onConflict: 'ghl_conversation_id' });
      if (error) throw new Error(`Supabase error: ${error.message}`);

      return { synced: rows.length, status: 'completed' };
    },
  },
};
