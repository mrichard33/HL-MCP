/**
 * Supabase admin operations: direct SQL execution, table listing, schema inspection.
 * Uses the run_sql RPC function for arbitrary SQL.
 *
 * A SELECT returns an array of row objects — [] for zero rows, and a single-row
 * single-column result stays [{col: value}] rather than collapsing to a scalar.
 *
 * ─── History (2026-08-30) ──────────────────────────────────────────────────
 * This module used to wrap every SELECT in json_agg before sending, and unwrap
 * single values on the way back, because run_sql carried the original
 * `EXECUTE query_text INTO result` body — which returns only the FIRST COLUMN of
 * the FIRST ROW and raises on any non-JSON scalar. Migration
 * 014_run_sql_full_resultset.sql fixes that server-side, so the workaround is
 * gone.
 *
 * Removing it also fixes a bug the workaround itself had. It wrapped as
 * `SELECT json_agg(t) FROM (<query>) t`, and Postgres binds a bare `t` to a
 * COLUMN named t before the subquery alias. So any query with a column called
 * `t` aggregated that column instead of the row:
 *
 *   SELECT now() AS ts, 'text-value' AS t, count(*) AS n FROM contacts
 *     -> ["text-value"]        -- other columns and the row shape, gone
 *
 * No error, just a plausible-looking wrong answer — the same failure class as
 * the defect 014 fixed, one layer up.
 */

import { getSupabaseClient } from '../clients/supabase.js';

export function isSelectish(queryText: string): boolean {
  const upper = (queryText || '').trim().toUpperCase();
  return upper.startsWith('SELECT') || upper.startsWith('WITH');
}

/**
 * Throw unless a SELECT came back as a row array.
 *
 * Pure, so it is testable without a Supabase client. A non-array here means
 * run_sql is still the pre-014 body, which answers a multi-column SELECT with
 * its first column and drops the rest. There is no safe way to use that value,
 * so this refuses it rather than letting a caller act on truncated data.
 */
export function assertRowArray(queryText: string, data: unknown): unknown {
  if (!isSelectish(queryText) || Array.isArray(data)) return data;
  throw new Error(
    'run_sql returned a non-array for a SELECT, which means migration '
    + '014_run_sql_full_resultset.sql is NOT applied on this Supabase instance. '
    + 'Refusing the result: the old function body returns only the first column '
    + 'of the first row, so this value is silently truncated.',
  );
}

/**
 * Auto-fix jsonb ILIKE/LIKE errors by casting jsonb expressions to ::text.
 * 
 * PostgreSQL throws "operator does not exist: jsonb ~~* unknown" when ILIKE
 * is used directly on a jsonb column. This function detects jsonb arrow 
 * expressions (-> not ->>) followed by ILIKE/LIKE and wraps them with ::text.
 * 
 * Handles patterns like:
 *   t.value->'attributes'->'tags' ILIKE '%foo%'
 *     → (t.value->'attributes'->'tags')::text ILIKE '%foo%'
 * 
 *   t.value->'attributes'->'tags'::text ILIKE '%foo%'  (misplaced cast)
 *     → (t.value->'attributes'->'tags')::text ILIKE '%foo%'
 * 
 * Does NOT modify ->> expressions (already return text).
 */
function autoFixJsonbLike(query: string): string {
  let fixed = query;
  let changed = false;

  // Pattern 1: jsonb_path ILIKE/LIKE (no ::text at all)
  // Matches: something->'key' ILIKE or something->'key'  ILIKE
  // The -> returns jsonb, needs ::text cast
  // Negative lookahead ensures we don't match ->> (which returns text)
  fixed = fixed.replace(
    /(\b\w+(?:\.[\w.]+)?(?:(?:->>'[^']*')|(?:->'[^']*'))*(?:->'[^']*'))(\s+)(I?LIKE\s)/gi,
    (match, expr, space, like) => {
      // If the expression already ends with ::text, skip
      if (expr.trim().endsWith('::text')) return match;
      // If the last accessor is ->> (returns text already), skip
      if (/->>'[^']*'\s*$/.test(expr)) return match;
      changed = true;
      return `(${expr})::text${space}${like}`;
    }
  );

  // Pattern 2: jsonb_path::text ILIKE (misplaced cast - ::text applied to string literal)
  // Example: t.value->'attributes'->'tags'::text ILIKE '%foo%'
  // Here ::text applies to the literal 'tags' (already text), not the jsonb result
  // Fix: wrap the whole expression in parens before ::text
  fixed = fixed.replace(
    /(\b\w+(?:\.[\w.]+)?(?:->>?'[^']*')*)->('[^']*')::text(\s+)(I?LIKE\s)/gi,
    (match, prefix, key, space, like) => {
      changed = true;
      return `(${prefix}->${key})::text${space}${like}`;
    }
  );

  // Pattern 3: Already-parenthesized expressions missing ::text
  // Example: (t.value->'attributes'->'tags') ILIKE '%foo%'  
  // Fix: add ::text after the closing paren
  fixed = fixed.replace(
    /(\([^()]*->'[^']*'\s*\))(\s+)(I?LIKE\s)/gi,
    (match, expr, space, like) => {
      if (expr.includes('::text')) return match;
      if (/->>'[^']*'\s*\)$/.test(expr)) return match;
      changed = true;
      return `${expr}::text${space}${like}`;
    }
  );

  return changed ? fixed : query;
}

export async function runSQL(queryText: string): Promise<unknown> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc('run_sql', { query_text: queryText });

  if (error) {
    // Auto-fix: jsonb ILIKE/LIKE type mismatch — cast to text and retry once
    const isJsonbLikeError =
      error.message.includes('operator does not exist') &&
      error.message.includes('jsonb') &&
      (error.message.includes('~~') || error.message.includes('LIKE'));

    if (isJsonbLikeError) {
      const fixedQuery = autoFixJsonbLike(queryText);
      if (fixedQuery !== queryText) {
        const { data: retryData, error: retryError } = await supabase.rpc('run_sql', {
          query_text: fixedQuery,
        });
        if (retryError) {
          throw new Error(
            `SQL execution error (auto-fix retry failed): ${retryError.message}\n` +
            `Original error: ${error.message}\n` +
            `Attempted fix: ${fixedQuery}`
          );
        }
        return assertRowArray(fixedQuery, retryData);
      }
      // Could not auto-fix — provide helpful guidance
      throw new Error(
        `SQL execution error: ${error.message}\n` +
        `Hint: ILIKE/LIKE cannot operate on jsonb columns directly. ` +
        `Cast jsonb expressions to text: (jsonb_expr)::text ILIKE '%pattern%'`
      );
    }

    throw new Error(`SQL execution error: ${error.message}`);
  }

  return assertRowArray(queryText, data);
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

  // No json_agg wrap — run_sql aggregates server-side since 014.
  const result = await runSQL(innerQuery);
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

  // No json_agg wrap — run_sql aggregates server-side since 014.
  const result = await runSQL(innerQuery);
  return { table: tableName, columns: result };
}
