/**
 * Supabase admin operations: direct SQL execution, table listing, schema inspection.
 * Uses the run_sql RPC function for arbitrary SQL.
 *
 * IMPORTANT: run_sql does `EXECUTE query_text INTO result` where result is typed as json.
 * ALL SELECT queries must be wrapped in json_agg because even simple aggregates like
 * MAX(timestamp) or COUNT(*) fail when the RPC tries to cast non-JSON types into the
 * json result variable. Only queries already containing json_agg are skipped.
 */

import { getSupabaseClient } from '../clients/supabase.js';

/**
 * Wrap ALL SELECT queries in json_agg so the run_sql RPC can return them.
 * The RPC's INTO variable is json-typed — even COUNT returns bigint which
 * sometimes fails, and MAX/MIN on timestamps always fails without wrapping.
 * Only skips if query already contains json_agg or is not a SELECT.
 */
function wrapSelectForJsonAgg(queryText: string): string {
  const trimmed = queryText.trim();
  const upper = trimmed.toUpperCase();

  // Only wrap SELECT statements
  if (!upper.startsWith('SELECT')) return trimmed;

  // Don't double-wrap if already using json_agg
  if (upper.includes('JSON_AGG')) return trimmed;

  // Wrap everything — the RPC result variable is json-typed
  return `SELECT json_agg(t) FROM (${trimmed}) t`;
}

export async function runSQL(queryText: string): Promise<unknown> {
  const supabase = getSupabaseClient();
  const wrapped = wrapSelectForJsonAgg(queryText);
  const { data, error } = await supabase.rpc('run_sql', { query_text: wrapped });
  if (error) throw new Error(`SQL execution error: ${error.message}`);

  // json_agg returns an array — for single-value queries (COUNT, MAX, etc.)
  // unwrap to return just the value for a cleaner caller experience
  if (Array.isArray(data) && data.length === 1 && typeof data[0] === 'object') {
    const keys = Object.keys(data[0]);
    if (keys.length === 1) {
      return data[0][keys[0]];
    }
  }

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
