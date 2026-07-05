/**
 * WP Telemetry — src/wp/telemetry.ts
 *
 * Identity resolution + persistence for Weakest Point page events.
 *
 * Identity: pages arrive with ?t=<contactId>.<sig> where
 * sig = base64url(HMAC_SHA256(contactId, WP_TOKEN_SECRET)). Verification
 * uses a constant-time compare on the decoded digest bytes. Invalid or
 * missing tokens record the event anonymously (contact_id null) and skip
 * all GHL write-back — the beacon still gets its 204 upstream.
 *
 * Every allowlisted event is inserted into wp_page_events (including
 * anonymous ones). GHL projection runs only for resolved contacts, guarded
 * by a once-per-(contact, event) idempotency check on ghl_synced — re-fire
 * spam has bitten this system before. video_progress is exempt from that
 * skip: its max(existing, pct) projection is monotonic and self-idempotent,
 * and a blanket skip would freeze wp_watch_pct at the first synced value.
 *
 * SUPABASE_ONLY_EVENTS (page_view, guide_progress) persist rows but never
 * run the idempotency lookup or GHL projection.
 *
 * Failure tolerance: the wp_page_events table is migrated manually
 * (supabase/migrations/010_wp_page_events.sql) — every Supabase call here
 * logs-and-continues so the service works before the migration runs.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getSupabaseClient } from '../clients/supabase.js';
import { projectEventToGhl } from './ghl-projection.js';

// GHL contact IDs are alphanumeric, typically 20 chars
const RAW_CID_PATTERN = /^[A-Za-z0-9]{15,32}$/;

// Events that persist to wp_page_events but never project to GHL
const SUPABASE_ONLY_EVENTS = new Set(['page_view', 'guide_progress']);

/**
 * Verify a <contactId>.<sig> token. Returns the contact ID on success,
 * null on any failure (missing secret, malformed token, bad signature).
 * Dev escape hatch: TRUST_RAW_CID=true accepts a bare contact ID —
 * insecure by design, must be false in prod.
 */
export function resolveContactId(token: unknown): string | null {
  if (typeof token !== 'string' || token.length === 0) return null;

  const dot = token.indexOf('.');
  if (dot > 0) {
    const secret = process.env.WP_TOKEN_SECRET;
    if (secret) {
      const contactId = token.slice(0, dot);
      const sig = token.slice(dot + 1);
      const expected = createHmac('sha256', secret).update(contactId).digest();
      let given: Buffer;
      try {
        given = Buffer.from(sig, 'base64url');
      } catch {
        return null;
      }
      // timingSafeEqual throws on length mismatch; length is public info
      if (given.length === expected.length && timingSafeEqual(given, expected)) {
        return contactId;
      }
    }
    return null;
  }

  if (process.env.TRUST_RAW_CID === 'true' && RAW_CID_PATTERN.test(token)) {
    return token;
  }
  return null;
}

export interface WpTelemetryPayload {
  event: string;
  token?: unknown;
  session_id?: unknown;
  ts?: unknown;
  path?: unknown;
  data?: unknown;
}

const asTextOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Persist one event row and (for resolved contacts) project it to GHL.
 * Runs after the 204 has been sent — must never throw to the caller.
 */
export async function recordTelemetryEvent(payload: WpTelemetryPayload): Promise<void> {
  const contactId = resolveContactId(payload.token);
  const clientTs = asTextOrNull(payload.ts) ?? new Date().toISOString();
  const data =
    payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : {};

  const supabase = getSupabaseClient();

  let insertedId: number | null = null;
  try {
    const { data: row, error } = await supabase
      .from('wp_page_events')
      .insert({
        event: payload.event,
        contact_id: contactId,
        session_id: asTextOrNull(payload.session_id),
        client_ts: asTextOrNull(payload.ts),
        path: asTextOrNull(payload.path),
        data,
      })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    insertedId = row?.id ?? null;
  } catch (err) {
    // Table may not be migrated yet — log and keep going
    console.error(`[wp-telemetry] insert failed for "${payload.event}":`, err instanceof Error ? err.message : err);
  }

  if (!contactId || SUPABASE_ONLY_EVENTS.has(payload.event)) return;

  // Idempotency guard (skipped for video_progress — see module header)
  if (payload.event !== 'video_progress') {
    try {
      const { data: prior, error } = await supabase
        .from('wp_page_events')
        .select('id')
        .eq('contact_id', contactId)
        .eq('event', payload.event)
        .eq('ghl_synced', true)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (prior) return; // already projected for this contact — event row kept, no GHL re-write
    } catch (err) {
      console.error(
        `[wp-telemetry] idempotency check failed for "${payload.event}" (${contactId}) — proceeding without guard:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  try {
    await projectEventToGhl({ event: payload.event, contactId, clientTs, data });
  } catch (err) {
    console.error(`[wp-telemetry] GHL projection failed for "${payload.event}" (${contactId}):`, err instanceof Error ? err.message : err);
    return; // leave ghl_synced=false so the next occurrence retries
  }

  if (insertedId !== null) {
    try {
      const { error } = await supabase
        .from('wp_page_events')
        .update({ ghl_synced: true, ghl_synced_at: new Date().toISOString() })
        .eq('id', insertedId);
      if (error) throw new Error(error.message);
    } catch (err) {
      console.error(`[wp-telemetry] failed to mark row ${insertedId} synced:`, err instanceof Error ? err.message : err);
    }
  }
}
