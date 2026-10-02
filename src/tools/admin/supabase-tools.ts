import { z } from 'zod';
import { runSQL, listTables, getTableSchema } from '../../admin/supabase-admin.js';
import { getSupabaseClient } from '../../clients/supabase.js';
import { toET } from '../../utils/timezone.js';

/**
 * The start of an ET calendar day as an ISO timestamp with the right offset
 * (-04:00 or -05:00). Noon UTC on that date always falls on the same ET date,
 * so its offset is the day's offset (DST switches at 2 AM, never at midnight).
 */
export function etDayStart(day: string): string {
  const offset = toET(new Date(`${day}T12:00:00Z`)).slice(-6);
  return `${day}T00:00:00${offset}`;
}

/** The day after a YYYY-MM-DD date, as YYYY-MM-DD. */
export function nextDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** True when a Supabase error means email_events / its views do not exist yet. */
export function isMissingRelation(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === '42P01' || err.code === 'PGRST205') return true;
  const m = (err.message || '').toLowerCase();
  return m.includes('does not exist') || m.includes('could not find the table');
}

const MIGRATION_019_MISSING = 'Migration 019 not applied. Apply supabase/migrations/019_email_events.sql in the HL MCP Supabase SQL editor.';

export const supabaseAdminTools = {
  supabase_run_query: {
    description:
      'Execute an arbitrary SQL query against the HL MCP Supabase database. DROP and TRUNCATE statements require confirm_destructive: true.',
    inputSchema: z.object({
      query: z.string().describe('SQL query to execute'),
      confirm_destructive: z
        .boolean()
        .optional()
        .default(false)
        .describe('Required for DROP/TRUNCATE statements. Must be true to execute destructive queries.'),
    }),
    handler: async (args: { query: string; confirm_destructive?: boolean }) => {
      const upper = args.query.toUpperCase().trim();
      const isDestructive = upper.startsWith('DROP') || upper.includes('TRUNCATE');
      if (isDestructive && !args.confirm_destructive) {
        return {
          preview: true,
          action: 'destructive_query',
          query: args.query,
          warning:
            'This query contains DROP or TRUNCATE. Pass confirm_destructive: true to execute.',
        };
      }
      return await runSQL(args.query);
    },
  },

  supabase_list_tables: {
    description:
      'List all tables in the HL MCP Supabase database with approximate row counts. Optionally filter by table name prefix.',
    inputSchema: z.object({
      prefix: z.string().optional().describe('Filter tables by name prefix (e.g. "ghl_", "sync_")'),
    }),
    handler: async (args: { prefix?: string }) => {
      return await listTables(args.prefix);
    },
  },

  supabase_get_table_schema: {
    description:
      'Get the schema (columns, types, defaults, constraints) for a specific table in the HL MCP Supabase database.',
    inputSchema: z.object({
      table_name: z.string().describe('Table name to inspect'),
    }),
    handler: async (args: { table_name: string }) => {
      return await getTableSchema(args.table_name);
    },
  },

  get_sync_health: {
    description:
      'Check sync health metrics for the HL MCP: last sync times, cache counts, and 24-hour failure rate. Gracefully handles missing tables.',
    inputSchema: z.object({}),
    handler: async (_args: Record<string, never>) => {
      const supabase = getSupabaseClient();
      const results: Record<string, unknown> = {};

      // Helper to safely extract error messages from Supabase errors
      const errMsg = (err: unknown): string => {
        if (err instanceof Error) return err.message;
        if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
        return String(err);
      };

      // Last sync times from sync_state
      // Column is entity_name (not entity_type) — verified against live schema
      try {
        const { data: syncState, error } = await supabase
          .from('sync_state')
          .select('entity_name, last_synced_at, updated_at')
          .order('last_synced_at', { ascending: false });
        if (error) throw error;
        results.sync_state = syncState;
      } catch (err) {
        results.sync_state = {
          error: errMsg(err),
          suggestion: 'Run supabase_list_tables to discover available tables.',
        };
      }

      // Recent sync log entries
      try {
        const { data: recentSyncs, error } = await supabase
          .from('sync_log')
          .select('entity_type, status, records_synced, started_at, completed_at')
          .order('started_at', { ascending: false })
          .limit(10);
        if (error) throw error;
        results.recent_syncs = recentSyncs;
      } catch (err) {
        results.recent_syncs = {
          error: errMsg(err),
          suggestion: 'Run supabase_list_tables to discover available tables.',
        };
      }

      // 24h failure rate from sync_log
      try {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: allRecent, error: allErr } = await supabase
          .from('sync_log')
          .select('status')
          .gte('started_at', twentyFourHoursAgo);
        if (allErr) throw allErr;

        const total = allRecent?.length || 0;
        const failed = allRecent?.filter((r: { status: string }) => r.status === 'failed').length || 0;
        results.failure_rate_24h = {
          total_syncs: total,
          failed_syncs: failed,
          failure_rate: total > 0 ? `${((failed / total) * 100).toFixed(1)}%` : 'N/A (no syncs in 24h)',
        };
      } catch (err) {
        results.failure_rate_24h = {
          error: errMsg(err),
        };
      }

      // Cache counts
      try {
        const tables = ['workflows', 'contacts', 'opportunities', 'conversations'];
        const cacheCounts: Record<string, number | string> = {};
        for (const table of tables) {
          try {
            const { count, error } = await supabase
              .from(table)
              .select('*', { count: 'exact', head: true });
            if (error) {
              cacheCounts[table] = `error: ${error.message}`;
            } else {
              cacheCounts[table] = count || 0;
            }
          } catch {
            cacheCounts[table] = 'table not found';
          }
        }
        results.cache_counts = cacheCounts;
      } catch (err) {
        results.cache_counts = {
          error: errMsg(err),
        };
      }

      return results;
    },
  },

  get_email_performance: {
    description:
      'Email engagement from GHL LCEmailStats (Mailgun) events: delivered, opens, clicks, bounces, complaints and unsubscribes. ' +
      'group_by "subject" (default) = one row per subject line; "link" = clicks per trigger link / URL; "day" = activity per ET day. ' +
      'contact_id = that contact\'s raw email events, newest first. Dates are YYYY-MM-DD in Eastern Time. ' +
      'human_open_rate excludes Apple Mail Privacy Protection machine opens (a heuristic: user agent "Mozilla/5.0"), so opens are approximate; ' +
      'clicks are the trusted engagement signal. Read-only.',
    inputSchema: z.object({
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('First day to include, YYYY-MM-DD (ET)'),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Last day to include, YYYY-MM-DD (ET)'),
      group_by: z.enum(['subject', 'link', 'day']).optional().default('subject').describe('How to group results (ignored when contact_id is set)'),
      contact_id: z.string().optional().describe('GHL contact id — returns that contact\'s email events instead of a rollup'),
      limit: z.number().int().min(1).max(500).optional().default(50).describe('Max rows (default 50)'),
    }),
    handler: async (args: {
      start_date?: string; end_date?: string; group_by?: 'subject' | 'link' | 'day'; contact_id?: string; limit?: number;
    }) => {
      const supabase = getSupabaseClient();
      const limit = args.limit ?? 50;
      const groupBy = args.group_by ?? 'subject';
      const from = args.start_date ? etDayStart(args.start_date) : null;
      // Exclusive upper bound: the start of the day AFTER end_date.
      const to = args.end_date ? etDayStart(nextDay(args.end_date)) : null;
      const window = { start_date: args.start_date ?? null, end_date: args.end_date ?? null };

      if (args.contact_id) {
        let q = supabase
          .from('email_events')
          .select('event, subject, occurred_at, trigger_link_name, clicked_url, is_machine_open')
          .eq('ghl_contact_id', args.contact_id);
        if (from) q = q.gte('occurred_at', from);
        if (to) q = q.lt('occurred_at', to);
        const { data, error } = await q.order('occurred_at', { ascending: false }).limit(limit);
        if (isMissingRelation(error)) return { message: MIGRATION_019_MISSING };
        if (error) throw new Error(error.message);
        return { contact_id: args.contact_id, window, rows: data };
      }

      if (groupBy === 'day') {
        let q = supabase.from('v_email_performance_daily').select('*');
        if (args.start_date) q = q.gte('day_et', args.start_date);
        if (args.end_date) q = q.lte('day_et', args.end_date);
        const { data, error } = await q.order('day_et', { ascending: false }).limit(limit);
        if (isMissingRelation(error)) return { message: MIGRATION_019_MISSING };
        if (error) throw new Error(error.message);
        return { group_by: 'day', window, rows: data };
      }

      if (groupBy === 'link') {
        // A link is in the window when its clicks overlap it. Counts are all-time.
        let q = supabase.from('v_email_clicks_by_link').select('*');
        if (from) q = q.gte('last_click_at', from);
        if (to) q = q.lt('first_click_at', to);
        const { data, error } = await q.order('clicks', { ascending: false }).limit(limit);
        if (isMissingRelation(error)) return { message: MIGRATION_019_MISSING };
        if (error) throw new Error(error.message);
        return { group_by: 'link', window, note: 'Counts are all-time for each link that had clicks in the window.', rows: data };
      }

      // A subject is in the window when its sends overlap it. Counts are all-time.
      let q = supabase.from('v_email_performance_by_subject').select('*');
      if (from) q = q.gte('last_sent_at', from);
      if (to) q = q.lt('first_sent_at', to);
      const { data, error } = await q.order('delivered', { ascending: false }).limit(limit);
      if (isMissingRelation(error)) return { message: MIGRATION_019_MISSING };
      if (error) throw new Error(error.message);
      return { group_by: 'subject', window, note: 'Counts are all-time for each subject sent in the window.', rows: data };
    },
  },
};
