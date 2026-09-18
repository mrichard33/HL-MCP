/**
 * Mirror freshness — src/utils/freshness.ts
 *
 * WHAT
 *   The verified stamp for tables that MIRROR a mutable upstream record.
 *   Here that is `contacts`; the LP-side mirrors and the field-precedence
 *   rulebook live in LP-MCP (docs/data-freshness-rulebook.md).
 *
 * WHY A SECOND TIMESTAMP
 *   synced_at only moves on a WRITE, and the payload-hash gate means an
 *   unchanged contact is never written. So a contact that is correct and
 *   untouched for a year is indistinguishable from one nobody has checked in a
 *   year. verified_at records the last time we COMPARED the row against live
 *   GHL — and a hash match IS a comparison, which is why callers pass every id
 *   the cycle FETCHED, not just the ones it wrote.
 *
 * TWO PROPERTIES THAT MAKE IT SAFE — do not "simplify" either away:
 *
 *   1. ITS OWN STATEMENT. Never fold verified_at into a sync's existing
 *      prefetch select. Those prefetches FAIL OPEN, so before the DDL is
 *      applied a missing column there would not error — it would run the cycle
 *      ungated and rewrite the whole table. Isolated here, a failure costs a
 *      stamp and nothing else.
 *   2. THE RATE LIMIT IS A FILTER, NOT A READ. "verified_at is null or older
 *      than maxAgeMs" is applied server-side inside the UPDATE, so stamping
 *      25k rows daily costs no extra round trip and cannot rewrite a row twice
 *      in a day.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { chunk, UPSERT_BATCH_SIZE } from './batching.js';

/** Sources a row can be verified against. Mirrors VERIFIED_FROM in LP-MCP. */
export const VERIFIED_FROM = {
  LP: 'lp',
  GHL: 'ghl',
} as const;

export type VerifiedFrom = (typeof VERIFIED_FROM)[keyof typeof VERIFIED_FROM];

/** Off by default — leave false until the migration adding the columns lands. */
export function verifiedStampEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.GHL_VERIFIED_AT_ENABLED || 'false').toLowerCase() === 'true';
}

export interface StampResult {
  /** Rows actually stamped (i.e. those past the rate-limit filter). */
  stamped: number;
  /** Set when the stamp could not run; the sync itself is never affected. */
  error?: string;
  /** False when the flag is off, so the caller can stay quiet. */
  ran: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Stamp verified_at / verified_from on every id the cycle compared.
 *
 * Best-effort by contract: on the first error it stops and reports, because a
 * freshness number that undercounts is strictly better than a sync that fails.
 */
export async function stampVerified(opts: {
  supabase: SupabaseClient;
  table: string;
  idColumn: string;
  ids: string[];
  now: string;
  source: VerifiedFrom;
  /** Do not restamp a row touched more recently than this. Default 24h. */
  maxAgeMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<StampResult> {
  const { supabase, table, idColumn, ids, now, source } = opts;
  if (!verifiedStampEnabled(opts.env)) return { stamped: 0, ran: false };
  if (ids.length === 0) return { stamped: 0, ran: true };

  const staleBefore = new Date(Date.parse(now) - (opts.maxAgeMs ?? DAY_MS)).toISOString();
  let stamped = 0;

  for (const slice of chunk(ids, UPSERT_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from(table)
      .update({ verified_at: now, verified_from: source })
      .in(idColumn, slice)
      .or(`verified_at.is.null,verified_at.lt.${staleBefore}`)
      .select(idColumn);
    if (error) return { stamped, ran: true, error: error.message };
    stamped += (data || []).length;
  }

  return { stamped, ran: true };
}
