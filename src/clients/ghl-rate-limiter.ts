/**
 * GHL Rate Limiter — src/clients/ghl-rate-limiter.ts
 * 
 * Token bucket rate limiter shared by ALL GHL API calls in HL MCP.
 * Prevents the 429 feedback loop where EntitySync burns through the
 * GHL rate limit and retries make it worse.
 * 
 * Design:
 *   - Bucket capacity: 40 tokens (conservative under GHL's ~100/min limit)
 *   - Refill rate: 40 tokens per minute (~1 every 1.5 seconds)
 *   - Queue-based backpressure: callers wait in FIFO queue when empty
 *   - On 429: drain bucket + pause ALL requests for 5 MINUTES
 *   - Exponential backoff on consecutive 429s: 5min → 10min → 15min (cap)
 *   - Singleton: one instance shared across the entire process
 * 
 * v1.1 — Exponential pause: 5min base, doubles on consecutive 429s (cap 15min)
 *   60s was not enough for GHL to reset after sustained rate limit abuse.
 *   The longer pause ensures complete rate limit recovery before retry.
 * 
 * v1.0 — Initial implementation (60s pause)
 */

const BUCKET_CAPACITY = 40;
const REFILL_RATE = 40;          // tokens per minute
const REFILL_INTERVAL_MS = (60 * 1000) / REFILL_RATE;  // ~1500ms per token
const BASE_PAUSE_MS = 300000;    // 5 minutes base pause
const MAX_PAUSE_MS = 900000;     // 15 minutes maximum pause

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
 * Uses exponential backoff: 5min → 10min → 15min on consecutive 429 cycles.
 * Resets to base pause after a successful request.
 */
export function report429(): void {
  stats.total429s++;
  tokens = 0;
  paused = true;
  consecutive429Cycles++;
  const pauseMs = Math.min(BASE_PAUSE_MS * consecutive429Cycles, MAX_PAUSE_MS);
  pauseUntil = Date.now() + pauseMs;
  console.warn(
    `[RateLimiter] 429 received! Pausing ALL GHL requests for ${Math.round(pauseMs / 1000)}s. ` +
    `Queue depth: ${waitQueue.length}. Total 429s: ${stats.total429s}. ` +
    `Consecutive cycles: ${consecutive429Cycles}`
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
    paused: isPaused(),
    pauseRemainingMs: paused ? Math.max(0, pauseUntil - Date.now()) : 0,
    queueDepth: waitQueue.length,
    consecutive429Cycles,
    currentPauseMs: Math.min(BASE_PAUSE_MS * Math.max(consecutive429Cycles, 1), MAX_PAUSE_MS),
    ...stats,
  };
}
