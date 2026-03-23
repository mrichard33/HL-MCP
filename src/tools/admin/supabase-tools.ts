import { z } from 'zod';
import { runSQL, listTables, getTableSchema } from '../../admin/supabase-admin.js';
import { getSupabaseClient } from '../../clients/supabase.js';

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

      // Last sync times from sync_state
      try {
        const { data: syncState, error } = await supabase
          .from('sync_state')
          .select('entity_type, last_synced_at')
          .order('last_synced_at', { ascending: false });
        if (error) throw error;
        results.sync_state = syncState;
      } catch (err) {
        results.sync_state = {
          error: err instanceof Error ? err.message : String(err),
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
          error: err instanceof Error ? err.message : String(err),
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
          error: err instanceof Error ? err.message : String(err),
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
          error: err instanceof Error ? err.message : String(err),
        };
      }

      return results;
    },
  },
};
