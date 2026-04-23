/**
 * GHL Rate Limiter — src/clients/ghl-rate-limiter.ts
 *
 * Token bucket rate limiter shared by ALL GHL API calls in HL MCP.
 * Prevents the 429 feedback loop where EntitySync burns through the
 * GHL rate limit and retries make it worse.
 *
 * Design:
 *   - Bucket capacity: 60 tokens (conservative under GHL's ~600/min limit)
 *   - Refill rate: 60 tokens per minute (~1/s sustained, safe margin vs 10/s cap)
 *   - Queue-based backpressure: callers wait in FIFO queue when empty
 *   - On 429: drain bucket + pause ALL requests for 60 seconds
 *   - Exponential backoff on consecutive 429s: 60s → 120s → 180s (cap)
 *   - Singleton: one instance shared across the entire process
 *
 * v1.2 — Pause duration slashed from 5–15 min to 60s–3min.
 *   The previous 5-minute base pause was catastrophic: a single 429 spike
 *   during boot-time concurrent sync fan-out (contacts + opps + appts +
 *   conversations all hitting the bucket) would block every queued caller
 *   for 5+ minutes. With three consecutive 429 cycles that became 15
 *   minutes of complete sync paralysis — which is exactly how the
 *   scheduler mutex deadlock from Apr 7+ manifested: it wasn't fetch()
 *   hanging, it was acquireToken() waiting 5–15 min on a paused bucket
 *   beneath the fetch layer. The 60s base + 3min cap still gives GHL
 *   plenty of time to reset its per-account counter (their window is
 *   10–60 seconds depending on resource) without burning cycle time.
 *
 *   Bucket capacity also bumped 40 → 60 and refill 40/min → 60/min
 *   (~1/s). GHL's documented limit is ~600/min or 100/10s per account;
 *   60/min leaves 10× headroom and still gives each 15-min sync cycle
 *   enough tokens to complete without contention.
 *
 *   All four knobs are now env-overridable for live tuning without a
 *   redeploy:
 *     RATE_LIMIT_BUCKET_CAPACITY
 *     RATE_LIMIT_REFILL_RATE_PER_MIN
 *     RATE_LIMIT_BASE_PAUSE_MS
 *     RATE_LIMIT_MAX_PAUSE_MS
 *
 * v1.1 — Exponential pause: 5min base, doubles on consecutive 429s (cap 15min)
 *   60s was not enough for GHL to reset after sustained rate limit abuse.
 *   The longer pause ensures complete rate limit recovery before retry.
 *   [v1.2 note: this was over-corrected. The right answer was 60–180s, not
 *    5–15min. The real fix for the "sustained abuse" case is to not burn
 *    through the bucket in the first place — which v1.7's serialized boot
 *    sequence in scheduler.ts now handles.]
 *
 * v1.0 — Initial implementation (60s pause)
 */

const BUCKET_CAPACITY = parseInt(process.env.RATE_LIMIT_BUCKET_CAPACITY || '60', 10);
const REFILL_RATE = parseInt(process.env.RATE_LIMIT_REFILL_RATE_PER_MIN || '60', 10);
const REFILL_INTERVAL_MS = (60 * 1000) / REFILL_RATE;  // ~1000ms per token at 60/min
const BASE_PAUSE_MS = parseInt(process.env.RATE_LIMIT_BASE_PAUSE_MS || '60000', 10);
const MAX_PAUSE_MS = parseInt(process.env.RATE_LIMIT_MAX_PAUSE_MS || '180000', 10);

// v1.2: Cap consecutive 429 cycle counter so a sustained 429 storm can't
// permanently paralyze the bucket. Once we hit MAX_PAUSE_MS, the cycle
// counter stays at that level until a successful request clears it.
// Max pause = BASE_PAUSE_MS × MAX_429_CYCLES, capped by MAX_PAUSE_MS.
const MAX_429_CYCLES = Math.max(1, Math.floor(MAX_PAUSE_MS / BASE_PAUSE_MS));

let tokens = BUCKET_CAPACITY;
let lastRefill = Date.now();
let paused = false;
let pauseUntil = 0;
let consecutive429Cycles = 0;    // tracks how many resume→429 cycles in a row

interface QueueEntry {
  resolve: () => void;
  queuedAt: number;
}

const waitQueue: QueueEntry[] = [];

// Stats tracking
const stats = {
  totalAcquired: 0,
  totalWaited: 0,
  total429s: 0,
  longestWaitMs: 0,
  lastReset: Date.now(),
};

// v1.2: One-time startup log so config is visible on boot.
console.log(
  `[RateLimiter] Initialized — capacity:${BUCKET_CAPACITY} refill:${REFILL_RATE}/min ` +
  `pause:${BASE_PAUSE_MS / 1000}s→${MAX_PAUSE_MS / 1000}s (max cycles:${MAX_429_CYCLES}). ` +
  `Override via RATE_LIMIT_* env vars.`,
);

function refill(): void {
  const now = Date.now();
  const elapsed = now - lastRefill;
  const newTokens = Math.floor(elapsed / REFILL_INTERVAL_MS);
  if (newTokens > 0) {
    tokens = Math.min(BUCKET_CAPACITY, tokens + newTokens);
    lastRefill = now;
  }
}

function isPaused(): boolean {
  if (!paused) return false;
  if (Date.now() >= pauseUntil) {
    paused = false;
    tokens = Math.min(2, BUCKET_CAPACITY); // Very cautious: only 2 tokens on resume
    console.log(`[RateLimiter] Pause ended. Resuming with ${tokens} tokens. Consecutive 429 cycles: ${consecutive429Cycles}`);
    processQueue();
    return false;
  }
  return true;
}

function processQueue(): void {
  while (waitQueue.length > 0 && tokens > 0 && !isPaused()) {
    tokens--;
    const entry = waitQueue.shift()!;
    const waitMs = Date.now() - entry.queuedAt;
    stats.totalWaited++;
    if (waitMs > stats.longestWaitMs) stats.longestWaitMs = waitMs;
    entry.resolve();
  }
}

/**
 * Acquire a token before making a GHL API call.
 * Returns immediately if tokens available, otherwise waits in FIFO queue.
 */
export function acquireToken(): Promise<void> {
  refill();

  if (isPaused()) {
    return new Promise<void>((resolve) => {
      waitQueue.push({ resolve, queuedAt: Date.now() });
      const checkInterval = setInterval(() => {
        if (!isPaused()) {
          clearInterval(checkInterval);
          refill();
          processQueue();
        }
      }, 5000); // Check every 5s during long pauses
    });
  }

  if (tokens > 0) {
    tokens--;
    stats.totalAcquired++;
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    waitQueue.push({ resolve, queuedAt: Date.now() });
    const checkInterval = setInterval(() => {
      refill();
      if (tokens > 0 || !isPaused()) {
        clearInterval(checkInterval);
        processQueue();
      }
    }, REFILL_INTERVAL_MS);
  });
}

/**
 * Report a 429 response. Drains bucket and pauses all requests.
 * Uses exponential backoff: BASE_PAUSE_MS × N on consecutive 429 cycles,
 * capped at MAX_PAUSE_MS. Resets after a successful request.
 */
export function report429(): void {
  stats.total429s++;
  tokens = 0;
  paused = true;
  // v1.2: Cap the cycle counter so repeated 429s can't compound past MAX_PAUSE_MS.
  consecutive429Cycles = Math.min(consecutive429Cycles + 1, MAX_429_CYCLES);
  const pauseMs = Math.min(BASE_PAUSE_MS * consecutive429Cycles, MAX_PAUSE_MS);
  pauseUntil = Date.now() + pauseMs;
  console.warn(
    `[RateLimiter] 429 received! Pausing ALL GHL requests for ${Math.round(pauseMs / 1000)}s. ` +
    `Queue depth: ${waitQueue.length}. Total 429s: ${stats.total429s}. ` +
    `Consecutive cycles: ${consecutive429Cycles}/${MAX_429_CYCLES}`
  );
}

/**
 * Call after a SUCCESSFUL GHL request to reset the consecutive 429 counter.
 * This allows the pause duration to shrink back to base after recovery.
 */
export function reportSuccess(): void {
  if (consecutive429Cycles > 0) {
    console.log(`[RateLimiter] GHL request succeeded! Resetting consecutive 429 counter from ${consecutive429Cycles} to 0.`);
    consecutive429Cycles = 0;
  }
}

/**
 * Get current rate limiter stats for monitoring.
 */
export function getRateLimiterStats(): Record<string, unknown> {
  refill();
  return {
    tokens,
    capacity: BUCKET_CAPACITY,
    refillRatePerMin: REFILL_RATE,
    basePauseMs: BASE_PAUSE_MS,
    maxPauseMs: MAX_PAUSE_MS,
    maxCycles: MAX_429_CYCLES,
    paused: isPaused(),
    pauseRemainingMs: paused ? Math.max(0, pauseUntil - Date.now()) : 0,
    queueDepth: waitQueue.length,
    consecutive429Cycles,
    currentPauseMs: Math.min(BASE_PAUSE_MS * Math.max(consecutive429Cycles, 1), MAX_PAUSE_MS),
    ...stats,
  };
}
