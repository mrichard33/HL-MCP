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
 *   - On 429: drain bucket + pause ALL requests for 60 seconds
 *   - Singleton: one instance shared across the entire process
 * 
 * Usage in GHLClient.request():
 *   await acquireToken();           // Wait for a token
 *   const res = await fetch(url);   // Make the GHL API call
 *   if (res.status === 429) {
 *     report429();                  // Drain bucket + pause 60s
 *     throw ...;                    // Don't retry — let caller handle
 *   }
 * 
 * Why 60s pause (vs LP MCP's 30s)?
 *   The HL MCP EntitySync makes many more concurrent requests than the
 *   LP MCP Action Executor. A longer pause gives the GHL rate limit
 *   more time to fully reset before resuming.
 * 
 * v1.0 — Initial implementation for HL MCP
 */

const BUCKET_CAPACITY = 40;
const REFILL_RATE = 40;          // tokens per minute
const REFILL_INTERVAL_MS = (60 * 1000) / REFILL_RATE;  // ~1500ms per token
const PAUSE_ON_429_MS = 60000;   // 60 seconds pause on 429

let tokens = BUCKET_CAPACITY;
let lastRefill = Date.now();
let paused = false;
let pauseUntil = 0;

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
    tokens = Math.min(5, BUCKET_CAPACITY); // Very cautious restart
    console.log(`[RateLimiter] 429 pause ended. Resuming with ${tokens} tokens.`);
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
      }, 1000);
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
 */
export function report429(): void {
  stats.total429s++;
  tokens = 0;
  paused = true;
  pauseUntil = Date.now() + PAUSE_ON_429_MS;
  console.warn(
    `[RateLimiter] 429 received! Pausing ALL GHL requests for ${PAUSE_ON_429_MS / 1000}s. ` +
    `Queue depth: ${waitQueue.length}. Total 429s: ${stats.total429s}`
  );
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
    ...stats,
  };
}
