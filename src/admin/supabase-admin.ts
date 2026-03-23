/**
 * Supabase admin operations: direct SQL execution, table listing, schema inspection.
 * Uses the run_sql RPC function for arbitrary SQL.
 */

import { getSupabaseClient } from '../clients/supabase.js';

export async function runSQL(queryText: string): Promise<unknown> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc('run_sql', { query_text: queryText });
  if (error) throw new Error(`SQL execution error: ${error.message}`);
  return data;
}

export async function listTables(prefix?: string): Promise<unknown> {
  let query = `
    SELECT
      schemaname,
      tablename,
      n_live_tup AS approximate_row_count
    FROM pg_stat_user_tables
    WHERE schemaname = 'public'
  `;
  if (prefix) {
    query += ` AND tablename LIKE '${prefix.replace(/'/g, "''")}%'`;
  }
  query += ' ORDER BY tablename';

  const result = await runSQL(query);
  return { tables: result };
}

export async function getTableSchema(tableName: string): Promise<unknown> {
  const query = `
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
      AND c.table_name = '${tableName.replace(/'/g, "''")}'
    ORDER BY c.ordinal_position
  `;

  const result = await runSQL(query);
  return { table: tableName, columns: result };
}
