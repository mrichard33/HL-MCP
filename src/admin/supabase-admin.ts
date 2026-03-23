/**
 * Supabase admin operations: direct SQL execution, table listing, schema inspection.
 * Uses the run_sql RPC function for arbitrary SQL.
 *
 * IMPORTANT: run_sql does `EXECUTE query_text INTO result` which returns a single JSON value.
 * SELECT queries are auto-wrapped in `SELECT json_agg(t) FROM (...) t` so multi-row
 * results are aggregated into one JSON array. This prevents "invalid input syntax for
 * type json" errors when the RPC tries to store multi-row results into a single variable.
 */

import { getSupabaseClient } from '../clients/supabase.js';

/**
 * Auto-wrap SELECT queries in json_agg so the run_sql RPC can return them.
 * Skips wrapping if the query already contains json_agg or is not a SELECT.
 */
function wrapSelectForJsonAgg(queryText: string): string {
  const trimmed = queryText.trim();
  const upper = trimmed.toUpperCase();

  // Only wrap SELECT statements
  if (!upper.startsWith('SELECT')) return trimmed;

  // Don't double-wrap if already using json_agg
  if (upper.includes('JSON_AGG')) return trimmed;

  // Don't wrap if it's a single-value query (COUNT, MAX, MIN, SUM, AVG with no other columns)
  // These already return a single value that works with INTO
  const selectBody = trimmed.replace(/^SELECT\s+/i, '').replace(/\s+FROM\s+.*/is, '');
  const isSimpleAggregate = /^(COUNT|MAX|MIN|SUM|AVG)\s*\(/i.test(selectBody.trim())
    && !selectBody.includes(',');
  if (isSimpleAggregate) return trimmed;

  // Wrap in json_agg
  return `SELECT json_agg(t) FROM (${trimmed}) t`;
}

export async function runSQL(queryText: string): Promise<unknown> {
  const supabase = getSupabaseClient();
  const wrapped = wrapSelectForJsonAgg(queryText);
  const { data, error } = await supabase.rpc('run_sql', { query_text: wrapped });
  if (error) throw new Error(`SQL execution error: ${error.message}`);
  return data;
}

export async function listTables(prefix?: string): Promise<unknown> {
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

  const query = `SELECT json_agg(t) FROM (${innerQuery}) t`;
  const result = await runSQL(query);
  return { tables: result };
}

export async function getTableSchema(tableName: string): Promise<unknown> {
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

  const query = `SELECT json_agg(t) FROM (${innerQuery}) t`;
  const result = await runSQL(query);
  return { table: tableName, columns: result };
}
