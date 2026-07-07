/**
 * Estimator Routes — src/http/estimator-routes.ts
 *
 * HTTP surface for the Window Estimator funnel telemetry:
 *
 *   POST /webhook/estimator-event  -> estimator_events Supabase table
 *
 * The calculator pages live on landing.reecewindows.com / link.reecewindows.com
 * and beacon step-transition events cross-origin, so CORS is load-bearing.
 * navigator.sendBeacon sends text/plain Blobs (a CORS-safelisted simple
 * request — no preflight), so Content-Type is deliberately never checked and
 * the body is JSON.parsed regardless; the fetch() fallback posts
 * application/json, which does preflight, so OPTIONS is handled too.
 *
 * Public and unauthenticated by design (called from visitors' browsers).
 * Mitigations instead of auth: strict event vocabulary, 8KB payload cap,
 * per-IP rate limit, and no reads exposed. Valid events answer 204 BEFORE
 * the Supabase insert runs — analytics must never surface errors to the
 * browser or block page navigation. Invalid input is rejected with 400
 * (unlike /api/telemetry's silent 204: this endpoint's contract is verified
 * by curl, so rejections must be observable).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getSupabaseClient } from '../clients/supabase.js';

const ESTIMATOR_PATH = '/webhook/estimator-event';

// Funnel vocabulary — anything else is rejected with 400.
//
//   event_type             step  fired when
//   ---------------------  ----  ------------------------------------------
//   page_view              1     page load
//   step1_complete         1     Step 1 validation passes (GHL contact created)
//   window_added           2     "Add Window to Estimate" clicked
//                                (payload: style, qty, isImpact, unitedInches)
//   step3_reached          3     Step 3 (email/contact) shown
//   step3_complete         3     email + consent validation passes
//   estimate_completed     4     Step 4 rendered
//                                (payload: estimate_total, window_count, low, high)
//   verify_cta_clicked     4     "Secure My Exact Price" clicked
//   keep_estimate_clicked  4     "Keep My Estimate for Now" clicked
const EVENT_VOCABULARY = new Set([
  'page_view',
  'step1_complete',
  'window_added',
  'step3_reached',
  'step3_complete',
  'estimate_completed',
  'verify_cta_clicked',
  'keep_estimate_clicked',
]);

const ALLOWED_ORIGINS = new Set([
  'https://landing.reecewindows.com',
  'https://link.reecewindows.com',
]);

const MAX_BODY_BYTES = 16 * 1024;   // transport cap: 8KB payload + envelope headroom
const MAX_PAYLOAD_BYTES = 8 * 1024; // serialized `payload` field cap
const MAX_SESSION_ID_LEN = 64;
const MAX_CONTACT_ID_LEN = 64;
const MAX_UTM_LEN = 256;
const MAX_USER_AGENT_LEN = 512;

// ── Rate limit: fixed window per IP, in-memory (resets on redeploy — fine) ──
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_PRUNE_THRESHOLD = 5000;
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  if (rateBuckets.size > RATE_PRUNE_THRESHOLD) {
    for (const [key, bucket] of rateBuckets) {
      if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) rateBuckets.delete(key);
    }
  }
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(ip, { count: 1, windowStart: now });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

function clientIp(req: IncomingMessage): string {
  // Railway fronts the service with a proxy — first x-forwarded-for entry is the client
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
}

function readLimitedBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (value: string | null) => {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Resolve oversize immediately so the caller can send 413, but keep
        // draining (discarding) so the response can actually be delivered;
        // cut the socket only if the client keeps streaming way past the cap
        settle(null);
        chunks.length = 0;
        if (total > maxBytes * 100) req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', () => settle(null));
  });
}

interface EstimatorEventRow {
  session_id: string;
  contact_id: string | null;
  page_variant: 'full' | 'sml';
  event_type: string;
  step: number | null;
  payload: Record<string, unknown>;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  user_agent: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses and validates a request body into an insertable row. Returns an
 * error string (→ 400) on invalid input; never throws. The row is built
 * exclusively from known fields, so unexpected top-level keys are dropped.
 */
function validateEventBody(
  raw: string,
  userAgent: string | null,
): EstimatorEventRow | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'body must be valid JSON' };
  }
  if (!isPlainObject(parsed)) return { error: 'body must be a JSON object' };

  const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id.trim() : '';
  if (!sessionId || sessionId.length > MAX_SESSION_ID_LEN) {
    return { error: `session_id required (string, 1-${MAX_SESSION_ID_LEN} chars)` };
  }

  const eventType = parsed.event_type;
  if (typeof eventType !== 'string' || !EVENT_VOCABULARY.has(eventType)) {
    return { error: 'unknown event_type' };
  }

  const pageVariant = parsed.page_variant ?? 'full';
  if (pageVariant !== 'full' && pageVariant !== 'sml') {
    return { error: "page_variant must be 'full' or 'sml'" };
  }

  let step: number | null = null;
  if (parsed.step !== undefined && parsed.step !== null) {
    if (!Number.isInteger(parsed.step) || (parsed.step as number) < 1 || (parsed.step as number) > 4) {
      return { error: 'step must be an integer 1-4' };
    }
    step = parsed.step as number;
  }

  let contactId: string | null = null;
  if (parsed.contact_id !== undefined && parsed.contact_id !== null) {
    if (typeof parsed.contact_id !== 'string' || parsed.contact_id.length > MAX_CONTACT_ID_LEN) {
      return { error: `contact_id must be a string of at most ${MAX_CONTACT_ID_LEN} chars` };
    }
    contactId = parsed.contact_id.trim() || null;
  }

  let payload: Record<string, unknown> = {};
  if (parsed.payload !== undefined && parsed.payload !== null) {
    if (!isPlainObject(parsed.payload)) return { error: 'payload must be an object' };
    if (Buffer.byteLength(JSON.stringify(parsed.payload), 'utf-8') > MAX_PAYLOAD_BYTES) {
      return { error: `payload exceeds ${MAX_PAYLOAD_BYTES} bytes` };
    }
    payload = parsed.payload;
  }

  // utm is lenient: ad-network junk shouldn't discard an otherwise-valid
  // event. Non-string/empty values become null; overlong values truncate.
  const utm = isPlainObject(parsed.utm) ? parsed.utm : {};
  const utmField = (value: unknown): string | null =>
    typeof value === 'string' ? value.trim().slice(0, MAX_UTM_LEN) || null : null;

  return {
    session_id: sessionId,
    contact_id: contactId,
    page_variant: pageVariant,
    event_type: eventType,
    step,
    payload,
    utm_source: utmField(utm.source),
    utm_medium: utmField(utm.medium),
    utm_campaign: utmField(utm.campaign),
    utm_content: utmField(utm.content),
    utm_term: utmField(utm.term),
    user_agent: userAgent ? userAgent.slice(0, MAX_USER_AGENT_LEN) : null,
  };
}

/**
 * Fire-and-forget persistence. getSupabaseClient() is called here, inside
 * the async function, so a missing-env throw lands in the caller's .catch
 * log rather than the request path (the 204 is already on the wire).
 */
async function insertEstimatorEvent(row: EstimatorEventRow): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('estimator_events').insert(row);
  if (error) {
    console.error('[estimator] supabase insert error:', error.message);
  }
}

export async function tryHandleEstimatorRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== ESTIMATOR_PATH) {
    return false;
  }

  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.writeHead(204);
    res.end();
    return true;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST, OPTIONS' });
    res.end();
    return true;
  }

  if (isRateLimited(clientIp(req))) {
    res.writeHead(429, { 'Retry-After': '60' });
    res.end();
    return true;
  }

  const body = await readLimitedBody(req, MAX_BODY_BYTES);
  if (body === null) {
    res.writeHead(413);
    res.end();
    return true;
  }

  const userAgentHeader = req.headers['user-agent'];
  const result = validateEventBody(body, typeof userAgentHeader === 'string' ? userAgentHeader : null);
  if ('error' in result) {
    console.warn('[estimator] rejected:', result.error);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: result.error }));
    return true;
  }

  // Respond before any I/O so the beacon never blocks navigation; insert
  // failures are logged only — 204 has already been sent by contract.
  res.writeHead(204);
  res.end();

  void insertEstimatorEvent(result).catch((err) => {
    console.error('[estimator] insert failed:', err instanceof Error ? err.message : err);
  });

  return true;
}
