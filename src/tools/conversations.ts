import { z } from 'zod';
import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';
import { nowET } from '../utils/timezone.js';
import { normalizeDirection } from '../utils/normalize.js';

/** Convert GHL date values (ms timestamp or ISO string) to ISO string for PostgreSQL TIMESTAMPTZ. */
function toISODate(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!isNaN(n) && n > 946684800000) {
    return new Date(n).toISOString();
  }
  return typeof value === 'string' ? value : null;
}

/** Upsert an array of raw GHL messages into the Supabase messages table. */
async function persistMessages(
  messages: Record<string, unknown>[],
  conversationId: string,
): Promise<number> {
  if (!messages.length) return 0;
  const supabase = getSupabaseClient();
  const now = nowET();
  let count = 0;

  for (const msg of messages) {
    const { error } = await supabase.from('messages').upsert(
      {
        ghl_message_id: msg.id as string,
        ghl_conversation_id: (msg.conversationId as string) || conversationId,
        ghl_contact_id: (msg.contactId as string) || null,
        direction: normalizeDirection(msg.direction as string | number | undefined),
        type: (msg.type as string) || 'sms',
        body: (msg.body || msg.message || msg.text) as string || null,
        status: (msg.status as string) || 'delivered',
        sent_at: toISODate(msg.dateAdded as string | number | undefined) || now,
      },
      { onConflict: 'ghl_message_id' },
    );
    if (!error) count++;
  }

  return count;
}

export const conversationTools = {
  list_conversations: {
    description: 'List conversations from GoHighLevel, optionally filtered by contact. Uses OAuth tokens automatically when configured. Use useCache=true to query synced data from Supabase.',
    inputSchema: z.object({
      contactId: z.string().optional().describe('Filter by contact ID'),
      limit: z.number().optional().default(20),
      useCache: z.boolean().optional().default(false),
    }),
    handler: async (args: { contactId?: string; limit?: number; useCache?: boolean }) => {
      if (args.useCache) {
        const supabase = getSupabaseClient();
        let qb = supabase.from('conversations').select('*').is('deleted_at', null).limit(args.limit || 20);
        if (args.contactId) qb = qb.eq('ghl_contact_id', args.contactId);
        const { data, error } = await qb;
        if (error) throw new Error(`Supabase error: ${error.message}`);
        return { conversations: data, source: 'cache' };
      }
      if (!args.contactId) {
        throw new Error('contactId is required for live GHL API calls — the conversations/search endpoint requires it. Use useCache=true to query from Supabase without a contactId.');
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
    description: 'Get messages in a conversation. Fetches from the live GHL API and persists to Supabase. Use useCache=true to query from Supabase instead.',
    inputSchema: z.object({
      conversationId: z.string().describe('GHL conversation ID'),
      useCache: z.boolean().optional().default(false).describe('Query from Supabase cache instead of live API'),
    }),
    handler: async (args: { conversationId: string; useCache?: boolean }) => {
      if (args.useCache) {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase
          .from('messages')
          .select('*')
          .eq('ghl_conversation_id', args.conversationId)
          .is('deleted_at', null)
          .order('sent_at', { ascending: true });
        if (error) throw new Error(`Supabase error: ${error.message}`);
        return { messages: data, source: 'cache' };
      }

      const ghl = new GHLClient();
      const raw = await ghl.getAllMessages(args.conversationId);

      // Persist fetched messages to Supabase
      const persisted = await persistMessages(
        raw as unknown as Record<string, unknown>[],
        args.conversationId,
      );

      return { messages: raw, persisted, source: 'ghl_api' };
    },
  },

  send_message: {
    description: 'Send a message in a conversation via GoHighLevel.',
    inputSchema: z.object({
      conversationId: z.string().describe('GHL conversation ID'),
      contactId: z.string().describe('GHL contact ID'),
      type: z.enum(['SMS', 'Email', 'WhatsApp', 'GMB', 'IG', 'FB', 'Live_Chat']).default('SMS'),
      message: z.string().describe('Message body'),
    }),
    handler: async (args: { conversationId: string; contactId: string; type: string; message: string }) => {
      const ghl = new GHLClient();
      return ghl.sendMessage(args);
    },
  },

  sync_conversations: {
    description: 'Sync conversations and their messages from GoHighLevel to Supabase cache.',
    inputSchema: z.object({
      contactId: z.string().optional(),
      limit: z.number().optional().default(50),
    }),
    handler: async (args: { contactId?: string; limit?: number }) => {
      if (!args.contactId) {
        throw new Error('contactId is required — the GHL conversations/search endpoint requires it.');
      }
      const ghl = new GHLClient();
      const supabase = getSupabaseClient();
      const now = nowET();

      const { conversations } = await ghl.getConversations({ contactId: args.contactId, limit: args.limit });
      const rows = conversations.map((c) => ({
        ghl_conversation_id: c.id,
        ghl_contact_id: c.contactId,
        ghl_location_id: c.locationId,
        type: c.type || null,
        last_message_at: toISODate(c.lastMessageDate),
        unread_count: c.unreadCount || 0,
        synced_at: now,
      }));

      const { error } = await supabase.from('conversations').upsert(rows, { onConflict: 'ghl_conversation_id' });
      if (error) throw new Error(`Supabase error: ${error.message}`);

      // Also fetch and persist messages for each synced conversation
      let totalMessages = 0;
      for (const conv of conversations) {
        try {
          const messageList = await ghl.getAllMessages(conv.id, 5);
          const persisted = await persistMessages(
            messageList as unknown as Record<string, unknown>[],
            conv.id,
          );
          totalMessages += persisted;
        } catch (err) {
          console.error(`[sync_conversations] Failed to sync messages for conv ${conv.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return { synced_conversations: rows.length, synced_messages: totalMessages, status: 'completed' };
    },
  },
};
