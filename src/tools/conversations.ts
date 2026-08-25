import { z } from 'zod';
import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';
import { nowET } from '../utils/timezone.js';
import { normalizeDirection } from '../utils/normalize.js';
import { isRealMessage } from '../utils/message-filter.js';
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

/**
 * MVI v2.5 — Advisory outbound-lock check against LP MCP.
 * Returns { held: boolean, ... } or { advisory_unavailable: true } on any
 * failure path. Fail-open: this is observability, not enforcement.
 */
async function checkAdvisoryLock(
  contactId: string,
  triggerId: string,
): Promise<{ held: boolean; held_by?: string; advisory_unavailable?: boolean }> {
  const lpUrl = process.env.LP_MCP_URL;
  if (!lpUrl) return { held: false, advisory_unavailable: true };
  const lpToken = process.env.LP_MCP_TOKEN;
  try {
    const url = `${lpUrl.replace(/\/$/, '')}/internal/check-outbound-lock`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(lpToken ? { 'Authorization': `Bearer ${lpToken}` } : {}),
      },
      body: JSON.stringify({ contact_id: contactId, trigger_id: triggerId }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { held: false, advisory_unavailable: true };
    const body = await res.json() as { held?: boolean; held_by?: string };
    return { held: !!body.held, held_by: body.held_by };
  } catch {
    return { held: false, advisory_unavailable: true };
  }
}

/**
 * Channels this tool cannot actually deliver, mapped to the instruction the
 * caller needs instead of a GHL rejection.
 *
 * ghl.sendMessage() sends the body in `message`. GHL's POST
 * /conversations/messages does not read the body from `message` on the Email
 * channel — it wants html, a subject and a resolved to-address — so it answers
 * 422 CONVERSATIONS_MSG_NO_CONTENT. That error reads like an empty body, which
 * sends whoever hit it looking for a regression that does not exist. Fail here,
 * where we can say what to do instead.
 *
 * ONLY Email is listed. WhatsApp, GMB, IG, FB and Live_Chat are not verified
 * either way; adding them on suspicion would break sends that may work today.
 * Verify against the live API before adding a channel to this map.
 */
const UNSUPPORTED_SEND_CHANNELS: Record<string, string> = {
  Email:
    "send_message cannot send Email. GHL's POST /conversations/messages ignores the `message` field on " +
    'the Email channel and answers 422 CONVERSATIONS_MSG_NO_CONTENT; it requires html, a subject and a ' +
    'resolved to-address, none of which this tool carries. Email sending lives in LP MCP ' +
    '(src/send-message-handler.js), which resolves the to-address, sets the subject, keeps the FROM ' +
    'correct and threads the reply. Queue an LP MCP send_message agent action with action_payload ' +
    '{ channel: "email", subject, message, pre_generated: true, requires_ai_generation: false }.',
};

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
    description:
      'Send a message in a conversation via GoHighLevel. DOES NOT SEND EMAIL — the Email channel is rejected ' +
      'with instructions, because GHL requires html/subject/to-address that this tool does not carry; email ' +
      'sends go through LP MCP send-message-handler. Optionally pass triggerId to trigger an advisory check ' +
      'against the LP MCP outbound-lock table — useful when the send is in response to an inbound message and ' +
      'you want to know if LP MCP already queued a reply for the same trigger.',
    inputSchema: z.object({
      conversationId: z.string().describe('GHL conversation ID'),
      contactId: z.string().describe('GHL contact ID'),
      type: z
        .enum(['SMS', 'Email', 'WhatsApp', 'GMB', 'IG', 'FB', 'Live_Chat'])
        .default('SMS')
        .describe("Channel. 'Email' is accepted by the schema but rejected at send time with the correct path — see UNSUPPORTED_SEND_CHANNELS."),
      message: z.string().describe('Message body'),
      triggerId: z
        .string()
        .optional()
        .describe(
          'Optional. When set, HL MCP performs an advisory check against LP MCP /internal/check-outbound-lock. Lock-held → warning logged but send proceeds. Use the inbound message_id you are replying to as the value.',
        ),
    }),
    handler: async (args: {
      conversationId: string;
      contactId: string;
      type: string;
      message: string;
      triggerId?: string;
    }) => {
      // Refuse channels this tool cannot deliver BEFORE spending a GHL call, so
      // the caller gets the real reason instead of a 422 that reads like an
      // empty message body.
      const unsupported = UNSUPPORTED_SEND_CHANNELS[args.type];
      if (unsupported) {
        throw new Error(unsupported);
      }

      let advisory: { held: boolean; held_by?: string; advisory_unavailable?: boolean } | undefined;
      if (args.triggerId) {
        advisory = await checkAdvisoryLock(args.contactId, args.triggerId);
        if (advisory.held && !advisory.advisory_unavailable) {
          console.warn(
            `[hl-mcp send_message] outbound lock held by ${advisory.held_by} for trigger=${args.triggerId} — proceeding anyway (manual send)`,
          );
        }
      }

      const ghl = new GHLClient();
      const result = await ghl.sendMessage({
        conversationId: args.conversationId,
        contactId: args.contactId,
        type: args.type,
        message: args.message,
      });
      return advisory ? { ...result, _advisory_lock: advisory } : result;
    },
  },

  sync_conversations: {
    description: 'Sync conversations and their messages from GoHighLevel to Supabase cache. If no contactId is provided, runs a bulk sync across all contacts. System activity events (opportunity created, chat ended, etc.) are filtered out — only real messages are stored.',
    inputSchema: z.object({
      contactId: z.string().optional().describe('Optional: sync a specific contact. If omitted, runs bulk sync across all contacts.'),
      limit: z.number().optional().default(50),
    }),
    handler: async (args: { contactId?: string; limit?: number }) => {
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
          const { persisted, skipped } = await persistMessages(
            messageList as unknown as Record<string, unknown>[],
            conv.id,
          );
          totalMessages += persisted;
          totalSkipped += skipped;
        } catch (err) {
          console.error(`[sync_conversations] Failed to sync messages for conv ${conv.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return {
        synced_conversations: rows.length,
        synced_messages: totalMessages,
        skipped_activity_events: totalSkipped,
        status: 'completed',
        mode: 'single_contact',
      };
    },
  },
};
