/**
 * Supabase admin operations: direct SQL execution, table listing, schema inspection.
 * Uses the run_sql RPC function for arbitrary SQL.
 *
 * IMPORTANT: run_sql does `EXECUTE query_text INTO result` which returns a single JSON value.
 * Multi-row queries MUST be wrapped in `SELECT json_agg(t) FROM (...) t` to aggregate
 * all rows into one JSON array. This is the same pattern used in LP MCP.
 */

import { getSupabaseClient } from '../clients/supabase.js';

export async function runSQL(queryText: string): Promise<unknown> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc('run_sql', { query_text: queryText });
  if (error) throw new Error(`SQL execution error: ${error.message}`);
  return data;
}

export async function listTables(prefix?: string): Promise<unknown> {
  // pg_stat_user_tables uses 'relname' (not 'tablename' — that's pg_tables)
  let innerQuery = `
    SELECT
      relname AS table_name,
      n_live_tup AS approximate_row_count
    FROM pg_stat_user_tables
    WHERE schemaname = 'public'
  `;
  if (prefix) {
    innerQuery += ` AND relname LIKE '${prefix.replace(/'/g, "''").replace(/[\\%_]/g, '\\$&')}%'`;
  }
  innerQuery += ' ORDER BY relname';

  // Wrap in json_agg so run_sql returns a single JSON array
  const query = `SELECT json_agg(t) FROM (${innerQuery}) t`;
  const result = await runSQL(query);
  return { tables: result };
}

export async function getTableSchema(tableName: string): Promise<unknown> {
  // Validate table name to prevent SQL injection
  if (!/^[a-z_][a-z0-9_]*$/i.test(tableName)) {
    throw new Error('Invalid table name — must be alphanumeric with underscores only');
  }

  const innerQuery = `
    SELECT
      c.column_name,
      c.data_type,
      c.column_default,
      c.is_nullable,
      c.character_maximum_length,
      tc.constraint_type
    FROM information_schema.columns c
    LEFT JOIN information_schema.key_column_usage kcu
      ON c.table_name = kcu.table_name
      AND c.column_name = kcu.column_name
      AND c.table_schema = kcu.table_schema
    LEFT JOIN information_schema.table_constraints tc
      ON kcu.constraint_name = tc.constraint_name
      AND kcu.table_schema = tc.table_schema
    WHERE c.table_schema = 'public'
      AND c.table_name = '${tableName}'
    ORDER BY c.ordinal_position
  `;

  // Wrap in json_agg so run_sql returns a single JSON array
  const query = `SELECT json_agg(t) FROM (${innerQuery}) t`;
  const result = await runSQL(query);
  return { table: tableName, columns: result };
}
