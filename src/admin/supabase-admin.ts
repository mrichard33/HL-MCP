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
  const wrapped = wrapSelectForJsonAgg(queryText);
  const { data, error } = await supabase.rpc('run_sql', { query_text: wrapped });

  if (error) {
    // Auto-fix: jsonb ILIKE/LIKE type mismatch — cast to text and retry once
    const isJsonbLikeError =
      error.message.includes('operator does not exist') &&
      error.message.includes('jsonb') &&
      (error.message.includes('~~') || error.message.includes('LIKE'));

    if (isJsonbLikeError) {
      const fixedQuery = autoFixJsonbLike(queryText);
      if (fixedQuery !== queryText) {
        const wrappedFixed = wrapSelectForJsonAgg(fixedQuery);
        const { data: retryData, error: retryError } = await supabase.rpc('run_sql', {
          query_text: wrappedFixed,
        });
        if (retryError) {
          throw new Error(
            `SQL execution error (auto-fix retry failed): ${retryError.message}\n` +
            `Original error: ${error.message}\n` +
            `Attempted fix: ${fixedQuery}`
          );
        }
        return unwrapSingleValue(retryData);
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

  return unwrapSingleValue(data);
}

/**
 * json_agg returns an array — for single-value queries (COUNT, MAX, etc.)
 * unwrap to return just the value for a cleaner caller experience.
 */
function unwrapSingleValue(data: unknown): unknown {
  if (Array.isArray(data) && data.length === 1 && typeof data[0] === 'object') {
    const keys = Object.keys(data[0] as Record<string, unknown>);
    if (keys.length === 1) {
      return (data[0] as Record<string, unknown>)[keys[0]];
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
