import { z } from 'zod';
import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';
import { nowET } from '../utils/timezone.js';
import { normalizeDirection } from '../utils/normalize.js';
import { syncConversationsAndMessages } from '../extractor/entity-syncer.js';

/** Convert GHL date values (ms timestamp or ISO string) to ISO string for PostgreSQL TIMESTAMPTZ. */
function toISODate(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!isNaN(n) && n > 946684800000) {
    return new Date(n).toISOString();
  }
  return typeof value === 'string' ? value : null;
}

/**
 * Upsert an array of raw GHL messages into the Supabase messages table.
 * Filters out system activity events (opportunity created, chat ended, etc.)
 * that GHL injects into the conversation timeline — those are NOT real messages.
 */
async function persistMessages(
  messages: Record<string, unknown>[],
  conversationId: string,
): Promise<{ persisted: number; skipped: number }> {
  if (!messages.length) return { persisted: 0, skipped: 0 };
  const supabase = getSupabaseClient();
  const now = nowET();
  let persisted = 0;
  let skipped = 0;

  for (const msg of messages) {
    // Skip system activity events — not real messages
    if (!isRealMessage(msg)) {
      skipped++;
      continue;
    }

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
    if (!error) persisted++;
  }

  return { persisted, skipped };
}

export const conversationTools = {
  list_conversations: {
    description: 'List conversations, optionally filtered by contact. Queries Supabase by default. Set forceLive=true for live GHL API (requires contactId).',
    inputSchema: z.object({
      contactId: z.string().optional().describe('Filter by contact ID'),
      limit: z.number().optional().default(20),
      forceLive: z.boolean().optional().default(false).describe('Bypass Supabase and query GHL API directly'),
    }),
    handler: async (args: { contactId?: string; limit?: number; forceLive?: boolean }) => {
      if (!args.forceLive) {
        const supabase = getSupabaseClient();
        let qb = supabase.from('conversations').select('*').is('deleted_at', null).limit(args.limit || 20);
        if (args.contactId) qb = qb.eq('ghl_contact_id', args.contactId);
        const { data, error } = await qb;
        if (error) throw new Error(`Supabase error: ${error.message}`);
        return { conversations: data, source: 'supabase' };
      }
      if (!args.contactId) {
        throw new Error('contactId is required for live GHL API calls — the conversations/search endpoint requires it.');
      }
      const ghl = new GHLClient();
      const result = await ghl.getConversations({ contactId: args.contactId, limit: args.limit });
      return { ...result, source: 'ghl_api' };
    },
  },

  get_conversation: {
    description: 'Get a single conversation by ID. Checks Supabase first (primary source), falls back to GHL API if not found. Set forceLive=true to skip Supabase.',
    inputSchema: z.object({
      conversationId: z.string().describe('GHL conversation ID'),
      forceLive: z.boolean().optional().default(false).describe('Bypass Supabase and query GHL API directly'),
    }),
    handler: async (args: { conversationId: string; forceLive?: boolean }) => {
      if (!args.forceLive) {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase
          .from('conversations')
          .select('*')
          .eq('ghl_conversation_id', args.conversationId)
          .is('deleted_at', null)
          .single();
        if (!error && data) {
          return { conversation: data, source: 'supabase' };
        }
      }
      const ghl = new GHLClient();
      const conversation = await ghl.getConversation(args.conversationId);
      return { conversation, source: 'ghl_api' };
    },
  },

  get_messages: {
    description: 'Get messages in a conversation. Queries Supabase by default (primary source). Set forceLive=true to fetch from the GHL API (also persists fetched messages to Supabase).',
    inputSchema: z.object({
      conversationId: z.string().describe('GHL conversation ID'),
      forceLive: z.boolean().optional().default(false).describe('Bypass Supabase and fetch from GHL API directly'),
    }),
    handler: async (args: { conversationId: string; forceLive?: boolean }) => {
      if (!args.forceLive) {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase
          .from('messages')
          .select('*')
          .eq('ghl_conversation_id', args.conversationId)
          .is('deleted_at', null)
          .order('sent_at', { ascending: true });
        if (error) throw new Error(`Supabase error: ${error.message}`);
        return { messages: data, source: 'supabase' };
      }

      const ghl = new GHLClient();
      const raw = await ghl.getAllMessages(args.conversationId);

      // Persist real messages only (filters out system activity events)
      const { persisted, skipped } = await persistMessages(
        raw as unknown as Record<string, unknown>[],
        args.conversationId,
      );

      return { messages: raw, persisted, skipped_activity_events: skipped, source: 'ghl_api' };
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
    description: 'Sync conversations and their messages from GoHighLevel to Supabase cache. If no contactId is provided, runs a bulk sync across all contacts (backfill mode for unsynced contacts, then incremental round-robin for already-synced ones).',
    inputSchema: z.object({
      contactId: z.string().optional().describe('Optional: sync a specific contact. If omitted, runs bulk sync across all contacts.'),
      limit: z.number().optional().default(50),
    }),
    handler: async (args: { contactId?: string; limit?: number }) => {
      // If no contactId, run the full bulk sync from entity-syncer
      if (!args.contactId) {
        const result = await syncConversationsAndMessages();
        return {
          synced_conversations: result.synced_conversations,
          synced_messages: result.synced_messages,
          errors: result.errors.length > 0 ? result.errors.slice(0, 20) : 'none',
          status: 'completed',
          mode: 'bulk',
        };
      }

      // Single-contact sync
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

      let totalMessages = 0;
      let totalSkipped = 0;
      for (const conv of conversations) {
        try {
          const messageList = await ghl.getAllMessages(conv.id);
          const persisted = await persistMessages(
            messageList as unknown as Record<string, unknown>[],
            conv.id,
          );
          totalMessages += persisted;
          totalSkipped += skipped;
        } catch (err) {
          console.error(`[sync_conversations] Failed to sync messages for conv ${conv.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return { synced_conversations: rows.length, synced_messages: totalMessages, status: 'completed', mode: 'single_contact' };
    },
  },
};
