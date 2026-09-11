/**
 * Payload-hash change detection — src/utils/delta-gate.ts
 *
 * WHY THIS EXISTS
 *
 * Most syncs re-upsert every record they fetch, every cycle, whether or not the
 * record actually changed. Measured on production 2026-09-11:
 *
 *   opportunities  21,117 rows   19,843 rewritten/24h   429 actually changed
 *   contacts       22,578 rows   19,609 rewritten/24h  1,200 actually changed
 *
 * ~95% of all write traffic is rewriting rows byte-for-byte identical to what is
 * already stored.
 *
 * The fix is not new: syncAppointments has done this since v2.0 via
 * APPT_SYNC_DELTA_MODE, and it works — 1,586 appointments sit inside the sync
 * window but only 178 were rewritten in 24h, an ~89% reduction, running in
 * `enforce` in production. This module is that exact logic lifted out so every
 * sync can use it instead of each one reinventing change detection (today:
 * opportunities compares timestamps, workflow-extractor deep-compares strings,
 * and the config entities compare nothing at all).
 *
 * THREE PROPERTIES THAT MAKE IT SAFE — do not "simplify" any of them away:
 *
 *   1. HASH CONTENT ONLY. Never include synced_at / updated_at / payload_hash.
 *      They change every cycle by construction and would make every row look
 *      changed, silently reverting the gate to a no-op.
 *   2. FAIL OPEN. Any prefetch error — including "column payload_hash does not
 *      exist" — runs the cycle ungated and writes everything. This is what makes
 *      it safe to deploy the code before the DDL is applied, which matters
 *      because DDL in this stack is applied by hand in the Supabase dashboard.
 *   3. CHUNK THE PREFETCH. PostgREST serialises `.in()` into the URL; an
 *      unchunked 21k-id list blows the server's URL length limit.
 *
 * A row with no stored hash is always treated as changed, so new records and
 * rows written by webhook handlers (which deliberately do not compute a hash —
 * see src/webhooks/handler.ts) are picked up on the next cycle.
 */

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { chunk, UPSERT_BATCH_SIZE } from './batching.js';

export type DeltaMode = 'off' | 'shadow' | 'enforce';

/**
 * Stable content hash.
 *
 * Object keys are sorted recursively so JSONB key reordering coming back from
 * Postgres/GHL does not read as a change. Array order IS significant — a
 * reordered array is a real change in every payload we sync.
 */
export function payloadHash(content: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.keys(v as Record<string, unknown>).sort().reduce((acc: Record<string, unknown>, k) => {
        acc[k] = sortKeys((v as Record<string, unknown>)[k]);
        return acc;
      }, {});
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(sortKeys(content))).digest('hex');
}

/**
 * Resolve the delta mode for one entity.
 *
 * Precedence: SYNC_DELTA_MODE_<ENTITY> → SYNC_DELTA_MODE → `fallback`.
 * An unrecognised value resolves to `fallback` rather than throwing — a typo in
 * a Railway variable must not take the sync down.
 *
 * APPT_SYNC_DELTA_MODE is still honoured for appointments so the existing
 * production setting keeps working across this deploy.
 */
export function deltaMode(entity: string, fallback: DeltaMode = 'shadow'): DeltaMode {
  const candidates = [
    process.env[`SYNC_DELTA_MODE_${entity.toUpperCase()}`],
    entity === 'appointments' ? process.env.APPT_SYNC_DELTA_MODE : undefined,
    process.env.SYNC_DELTA_MODE,
  ];
  for (const raw of candidates) {
    const v = (raw || '').trim().toLowerCase();
    if (v === 'off' || v === 'shadow' || v === 'enforce') return v;
  }
  return fallback;
}

export interface GateResult<T> {
  /** Rows to write. In `shadow`/`off` this is every input row. */
  rows: T[];
  /** How many rows were unchanged (reported in both shadow and enforce). */
  skippedUnchanged: number;
  /** False when the gate could not run (mode `off`, or the prefetch failed). */
  gated: boolean;
}

/**
 * Keep only rows whose stored hash differs from the freshly computed one.
 *
 * `rows` must already carry the hash under `hashColumn` — callers compute it
 * over their content fields before adding synced_at/updated_at, so the hash can
 * never include a per-cycle timestamp.
 */
export async function gateByPayloadHash<T extends Record<string, unknown>>(opts: {
  supabase: SupabaseClient;
  table: string;
  idColumn: string;
  rows: T[];
  mode: DeltaMode;
  /** Defaults to 'payload_hash'. */
  hashColumn?: string;
  /** Label for log lines, e.g. 'syncOpportunities'. */
  label: string;
  /**
   * Pre-loaded id → stored hash map. Pass this when the caller already reads
   * the table for another reason (syncContacts prefetches tags for its tag
   * diff) so the gate costs no extra round trip. Omit and the gate loads it.
   */
  storedHashes?: Map<string, string | null>;
}): Promise<GateResult<T>> {
  const { supabase, table, idColumn, rows, mode, label } = opts;
  const hashColumn = opts.hashColumn || 'payload_hash';

  if (mode === 'off' || rows.length === 0) {
    return { rows, skippedUnchanged: 0, gated: false };
  }

  let storedHash = opts.storedHashes;
  if (!storedHash) {
    storedHash = new Map<string, string | null>();
    const ids = rows.map((r) => r[idColumn] as string).filter(Boolean);

    for (const batch of chunk(ids, UPSERT_BATCH_SIZE)) {
      const { data, error } = await supabase
        .from(table)
        .select(`${idColumn}, ${hashColumn}`)
        .in(idColumn, batch);
      if (error) {
        // Fail open — see property 2 in the module header.
        console.warn(`[DeltaGate] ${label}: hash prefetch failed (${error.message}) — cycle runs ungated`);
        return { rows, skippedUnchanged: 0, gated: false };
      }
      // The select list is built at runtime, so supabase-js cannot infer a row
      // type for it — cast through unknown rather than fight the parser types.
      for (const r of ((data || []) as unknown) as Record<string, unknown>[]) {
        storedHash.set(r[idColumn] as string, (r[hashColumn] as string | null) ?? null);
      }
    }
  }

  // Missing key → undefined ≠ hash → treated as changed. Correct for new rows
  // and for rows a webhook wrote without a hash.
  const changed = rows.filter((r) => storedHash.get(r[idColumn] as string) !== r[hashColumn]);
  const skippedUnchanged = rows.length - changed.length;

  if (mode === 'enforce') {
    console.log(`[DeltaGate] ${label}: enforce — ${changed.length} changed, ${skippedUnchanged} unchanged skipped`);
    return { rows: changed, skippedUnchanged, gated: true };
  }

  console.log(`[DeltaGate] ${label}: shadow — ${changed.length} changed, ${skippedUnchanged} would skip (writing all)`);
  return { rows, skippedUnchanged, gated: true };
}
