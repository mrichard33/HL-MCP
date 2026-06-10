/**
 * WP Routes — src/http/wp-routes.ts
 *
 * HTTP surface for the Weakest Point journey (report.getreecewindows.com):
 *
 *   GET  /  /find  /unlock  /report   -> static pages (src/wp/static-pages.ts)
 *   POST /api/telemetry               -> event ingestion (src/wp/telemetry.ts)
 *
 * /api/telemetry always answers 204 immediately; Supabase persistence and
 * GHL write-back run fire-and-forget so navigator.sendBeacon never blocks
 * page navigation. Unknown event names get the same 204 with nothing
 * stored (the allowlist is not leaked to clients).
 *
 * CORS: only PAGE_ALLOWED_ORIGIN is allowed. The pages post same-origin in
 * practice, but sendBeacon with an application/json Blob is not
 * CORS-safelisted, so cross-origin callers preflight — OPTIONS is handled.
 *
 * Mounted in src/index.ts BEFORE the health check (GET / serves the film
 * page now; /health keeps the JSON health check).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveWpPage } from '../wp/static-pages.js';
import { recordTelemetryEvent } from '../wp/telemetry.js';

const TELEMETRY_PATH = '/api/telemetry';

const EVENT_ALLOWLIST = new Set([
  'page_view',
  'gate_start',
  'gate_complete',
  'cta_click',
  'video_progress',
  'report_ready',
]);

const MAX_BODY_BYTES = 10 * 1024;

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
  const allowed = process.env.PAGE_ALLOWED_ORIGIN;
  if (allowed && req.headers.origin === allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Vary', 'Origin');
  }
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

export async function tryHandleWpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== TELEMETRY_PATH) {
    return serveWpPage(req, res, pathname);
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

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // Beacons can't act on errors — accept and drop
    res.writeHead(204);
    res.end();
    return true;
  }

  const event = payload?.event;
  if (typeof event !== 'string' || !EVENT_ALLOWLIST.has(event)) {
    res.writeHead(204);
    res.end();
    return true;
  }

  // Respond before any I/O so the beacon never blocks navigation
  res.writeHead(204);
  res.end();

  void recordTelemetryEvent({
    event,
    token: payload.token,
    session_id: payload.session_id,
    ts: payload.ts,
    path: payload.path,
    data: payload.data,
  }).catch((err) => {
    console.error('[wp-telemetry] async processing failed:', err instanceof Error ? err.message : err);
  });

  return true;
}
