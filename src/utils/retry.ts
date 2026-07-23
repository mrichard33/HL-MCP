/**
 * Bounded retry with exponential backoff + jitter.
 *
 * Added 2026-07-20 in response to 8 hard sync failures in a single 24h window,
 * all with the signature:
 *
 *   GHL API error 500: {"statusCode":500,"message":"Internal server error"}
 *
 * Before this helper, a single transient upstream 500 anywhere in a sync
 * aborted the entire cycle. The work was simply lost until the next cron tick
 * 15 minutes later. GHL 5xx and 429 responses are overwhelmingly transient and
 * succeed on a second or third attempt, so discarding a whole cycle for one is
 * needlessly destructive.
 *
 * Deliberately BOUNDED. This is not an infinite retry loop:
 *   - a hard cap on attempts (default 3 total: 1 initial + 2 retries)
 *   - only retries errors the predicate says are transient
 *   - a non-retryable error (4xx other than 429, auth, validation) throws
 *     immediately on the first attempt, exactly as before
 *
 * That bound matters. An unbounded retry against a genuinely down upstream
 * would hold the job past its scheduler hard timeout, which is precisely the
 * failure mode that produces orphaned `running` rows in sync_log (see
 * src/extractor/sync-reaper.ts). Total worst-case added latency here is
 * ~1s + ~2s = ~3s plus jitter, comfortably inside every JOB_TIMEOUTS_MS
 * ceiling.
 */

export interface BoundedRetryOptions {
  /** Total attempts including the first. Default 3 (1 initial + 2 retries). */
  maxAttempts?: number;
  /** Base delay in ms for the first retry. Doubles each attempt. Default 1000. */
  baseDelayMs?: number;
  /** Upper bound on any single backoff delay. Default 10_000. */
  maxDelayMs?: number;
  /** Label used in log lines so retries are attributable. */
  label?: string;
  /** Decides whether a given error is worth retrying. Default: isTransientUpstreamError. */
  isRetryable?: (err: unknown) => boolean;
}

/**
 * Default retryability predicate: GHL/HTTP transient failures.
 *
 * Retries on:
 *   - any 5xx status (500, 502, 503, 504) — upstream instability
 *   - 429 — rate limited, backoff is the correct response
 *   - network-level errors (ECONNRESET, ETIMEDOUT, socket hang up, fetch failed)
 *
 * Does NOT retry on:
 *   - 400/401/403/404/422 — deterministic; retrying just burns rate-limit
 *     tokens and delays the real error surfacing.
 *
 * Matches on message text because GHLClient surfaces upstream failures as
 * `Error("GHL API error <status>: <body>")` rather than a typed error with a
 * numeric status field. If that ever changes to a structured error, prefer the
 * status field and keep this string match as the fallback.
 */
export function isTransientUpstreamError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);

  // Explicitly non-retryable client errors, checked first so a body that
  // happens to contain "500" elsewhere can't cause a false positive.
  if (/\b(400|401|403|404|422)\b/.test(msg) && /GHL API error/i.test(msg)) {
    return false;
  }

  if (/GHL API error 5\d{2}\b/i.test(msg)) return true;
  if (/\b(429|rate.?limit)\b/i.test(msg)) return true;
  if (/\b(5\d{2})\b/.test(msg) && /(internal server error|bad gateway|service unavailable|gateway timeout)/i.test(msg)) {
    return true;
  }
  if (/(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed)/i.test(msg)) {
    return true;
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn`, retrying transient failures with exponential backoff + jitter.
 *
 * Jitter is full-range (0..delay) to avoid synchronizing retries across the
 * several sync jobs that fire on the same every-15-minute cron boundary
 * ("15" schedule). Without it, a
 * GHL blip would put every job on an identical retry schedule and produce a
 * thundering herd against an already-struggling upstream.
 *
 * Rethrows the final error unchanged if all attempts are exhausted, so callers
 * see the original message and existing error handling still works.
 */
export async function withBoundedRetry<T>(
  fn: () => Promise<T>,
  options: BoundedRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  const label = options.label ?? 'operation';
  const isRetryable = options.isRetryable ?? isTransientUpstreamError;

  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) {
        console.log(`[Retry] ${label}: succeeded on attempt ${attempt}/${maxAttempts}`);
      }
      return result;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);

      if (!isRetryable(err)) {
        console.warn(`[Retry] ${label}: non-retryable error, failing immediately — ${msg}`);
        throw err;
      }

      if (attempt >= maxAttempts) {
        console.error(`[Retry] ${label}: exhausted ${maxAttempts} attempts — ${msg}`);
        throw err;
      }

      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delay = Math.floor(Math.random() * backoff);
      console.warn(
        `[Retry] ${label}: attempt ${attempt}/${maxAttempts} failed (${msg}) — ` +
        `retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }

  throw lastErr;
}
