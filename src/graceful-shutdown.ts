/**
 * Graceful shutdown — src/graceful-shutdown.ts
 *
 * Makes Railway's drain window (drainingSeconds=120) real. Before this HL-MCP
 * had NO signal handling at all: SIGTERM went straight to Node's default
 * behaviour, so every deploy killed in-flight requests and any fire-and-forget
 * work the webhook handlers had started but not awaited. That loss is silent —
 * GoHighLevel had already received its 200.
 *
 * Sequence on SIGTERM/SIGINT:
 *   1. stop accepting new connections (server.close)
 *   2. run 'start' hooks (stop node-cron and scheduled-sync jobs so no NEW
 *      sweep begins during the drain)
 *   3. wait until in-flight requests AND tracked background work reach 0,
 *      or SHUTDOWN_GRACE_MS elapses (default 90s — must stay < Railway's 120s)
 *   4. run 'exit' hooks (any final state writes), then exit
 *
 * Long-lived MCP streams (GET /mcp, GET /sse) are NOT counted as in-flight —
 * they never "finish" and would pin every drain to the full grace period.
 *
 * This is the TypeScript port of LP-MCP's src/graceful-shutdown.js and keeps
 * the same behaviour and the same SHUTDOWN_GRACE_MS env var. The one shape
 * difference: HL-MCP serves plain node:http rather than express, so
 * trackInflight takes (req, res) and is called at the top of the request
 * listener instead of being mounted as middleware.
 */

import type { IncomingMessage, ServerResponse, Server } from 'node:http';

const GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS || '90000', 10);

type Phase = 'start' | 'exit';
type Hook = (signal: string) => void | Promise<void>;

let shuttingDown = false;
let inflight = 0;
const background = new Set<Promise<unknown>>();
const hooks: Record<Phase, Hook[]> = { start: [], exit: [] };

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * A stream that never ends must not be counted, or every deploy waits out the
 * full grace period for a connection that was never going to close.
 */
function isLongLived(req: IncomingMessage): boolean {
  if (req.method !== 'GET') return false;
  const path = (req.url ?? '/').split('?')[0];
  return path === '/mcp' || path === '/sse';
}

/**
 * Count one request as in-flight until its response finishes or its socket
 * closes. Call this at the TOP of the request listener, before any routing or
 * early return — a request that returns early still needs its response
 * delivered.
 */
export function trackInflight(req: IncomingMessage, res: ServerResponse): void {
  if (isLongLived(req)) return;
  inflight++;
  let done = false;
  const finish = (): void => {
    if (!done) {
      done = true;
      inflight--;
    }
  };
  res.on('finish', finish);
  res.on('close', finish);
}

/**
 * Wrap fire-and-forget work so shutdown waits for it. Returns the original
 * value, so an existing `doThing().catch(...)` becomes
 * `trackBackground(doThing().catch(...))` with no other change.
 */
export function trackBackground<T>(promise: T): T {
  const p: Promise<unknown> = Promise.resolve(promise)
    .catch(() => {})
    .finally(() => {
      background.delete(p);
    });
  background.add(p);
  return promise;
}

export function onShutdown(fn: Hook, phase: Phase = 'start'): void {
  (hooks[phase] ?? hooks.start).push(fn);
}

async function runHooks(phase: Phase, signal: string): Promise<void> {
  for (const fn of hooks[phase]) {
    try {
      await fn(signal);
    } catch (e) {
      console.warn(`[Shutdown] ${phase} hook failed:`, e instanceof Error ? e.message : String(e));
    }
  }
}

export function installGracefulShutdown(server: Server): void {
  const handler = (signal: string) => async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const started = Date.now();
    console.log(
      `[Shutdown] ${signal} received — draining (inflight=${inflight}, background=${background.size}, grace=${GRACE_MS}ms)`,
    );
    try {
      server.close(() => console.log('[Shutdown] HTTP server closed to new connections'));
    } catch {
      /* already closed */
    }
    await runHooks('start', signal);
    while ((inflight > 0 || background.size > 0) && Date.now() - started < GRACE_MS) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const clean = inflight === 0 && background.size === 0;
    console.log(
      `[Shutdown] ${
        clean ? 'Drained cleanly' : `GRACE EXPIRED with inflight=${inflight}, background=${background.size}`
      } after ${Date.now() - started}ms`,
    );
    await runHooks('exit', signal);
    process.exit(0);
  };
  process.on('SIGTERM', handler('SIGTERM'));
  process.on('SIGINT', handler('SIGINT'));
}

// test-only
export function _stateForTests(): { shuttingDown: boolean; inflight: number; background: number } {
  return { shuttingDown, inflight, background: background.size };
}
