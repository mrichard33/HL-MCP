/**
 * Graceful shutdown — scripts/test-graceful-shutdown.js
 *
 * Proves the drain window is real on HL-MCP. Before this change the service
 * had NO signal handling at all, so SIGTERM took Node's default path and every
 * deploy killed in-flight requests and any fire-and-forget webhook work
 * mid-flight — silently, because GoHighLevel already had its 200.
 *
 * Each case spawns a CHILD node process running a tiny plain-node:http server
 * wired exactly like src/index.ts (trackInflight at the top of the request
 * listener + installGracefulShutdown on the server), sends it a real SIGTERM,
 * and asserts on what the client received and when the child exited. A child
 * process is the only honest way to test this: the module installs
 * process-level handlers and calls process.exit(0), neither of which can be
 * exercised in-process without killing the test runner.
 *
 * Runs against dist/ because `npm test` builds first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// The child lives in a tmpdir, so it is handed an absolute specifier.
const SHUTDOWN_MODULE = JSON.stringify(join(ROOT, 'dist/graceful-shutdown.js'));

// Plain node:http, matching src/index.ts — no express anywhere in this service.
const CHILD_APP = `
import http from 'node:http';
import { trackInflight, trackBackground, installGracefulShutdown } from ${SHUTDOWN_MODULE};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  // Exactly as index.ts does it: count the request before any routing.
  trackInflight(req, res);

  const path = (req.url ?? '/').split('?')[0];

  // 1. Slow in-flight request.
  if (path === '/slow') {
    await sleep(2000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, route: 'slow' }));
    return;
  }

  // 2. Ack immediately, then tracked background work.
  if (path === '/ack-then-work') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, route: 'ack-then-work' }));
    trackBackground(sleep(1500).then(() => console.log('BACKGROUND_DONE')));
    return;
  }

  // 3. Never finishes — must be cut off by the grace timer.
  if (path === '/hang') {
    await sleep(8000);
    res.writeHead(200);
    res.end('late');
    return;
  }

  // 4. Long-lived stream, the /mcp shape. Headers flush, body never ends.
  if (path === '/mcp') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': open\\n\\n');
    return; // deliberately never res.end()
  }

  res.writeHead(404);
  res.end();
});

installGracefulShutdown(server);

server.listen(0, () => {
  console.log('LISTENING ' + server.address().port);
});
`;

const tmp = mkdtempSync(join(tmpdir(), 'hl-gshut-'));
const CHILD_PATH = join(tmp, 'child-app.mjs');
writeFileSync(CHILD_PATH, CHILD_APP);

/**
 * Boot the child, wait for its port, and return handles plus a promise that
 * resolves with {code, ms} when it exits. stdout is captured whole so a case
 * can assert on the ordering of log lines.
 */
function startChild(env = {}) {
  const child = spawn(process.execPath, [CHILD_PATH], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const startedAt = Date.now();
  const exited = new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, ms: Date.now() - startedAt }));
  });

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child never listened. stderr:\n${stderr}`)), 10000);
    child.stdout.on('data', () => {
      const m = /LISTENING (\d+)/.exec(stdout);
      if (m) { clearTimeout(timer); resolve(parseInt(m[1], 10)); }
    });
  });

  return { child, ready, exited, out: () => stdout, err: () => stderr };
}

/** A GET that resolves with the full body, or rejects if the socket dies first. */
function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('aborted', () => reject(new Error('response aborted mid-flight')));
    });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('an in-flight request completes after SIGTERM, and the child exits after it', async () => {
  const { child, ready, exited, out } = startChild({ SHUTDOWN_GRACE_MS: '5000' });
  const port = await ready;

  const pending = get(port, '/slow');
  await sleep(300);
  child.kill('SIGTERM');

  // Before this change: Node's default SIGTERM handling killed the process
  // here and this rejected with ECONNRESET.
  const res = await pending;
  assert.equal(res.status, 200, 'in-flight request must still get its response');
  assert.equal(JSON.parse(res.body).route, 'slow');

  const { code } = await exited;
  assert.equal(code, 0);
  assert.match(out(), /\[Shutdown\] SIGTERM received — draining/);
  assert.match(out(), /Drained cleanly/, 'must drain cleanly, not expire');
});

test('tracked background work finishes before exit, even though the client was already acked', async () => {
  const { child, ready, exited, out } = startChild({ SHUTDOWN_GRACE_MS: '5000' });
  const port = await ready;

  const res = await get(port, '/ack-then-work');
  assert.equal(res.status, 200);

  await sleep(200);
  child.kill('SIGTERM');

  const { code } = await exited;
  assert.equal(code, 0);
  // This is the silent loss the webhook handlers were exposed to: emitSystemEvent,
  // the workflow_executions tag diff, and the LP MCP tag forward all run here.
  assert.match(out(), /BACKGROUND_DONE/, 'background work must run to completion');
  assert.match(out(), /Drained cleanly/);
  assert.ok(
    out().indexOf('BACKGROUND_DONE') < out().indexOf('Drained cleanly'),
    'background work must complete before the drain reports clean'
  );
});

test('a request that never finishes cannot hold the container past the grace window', async () => {
  const { child, ready, exited, out } = startChild({ SHUTDOWN_GRACE_MS: '1000' });
  const port = await ready;

  // The 8s route outlives the 1s grace. Its socket dies with the process; that
  // rejection is expected and must not fail the test.
  get(port, '/hang').catch(() => {});
  await sleep(300);

  const killedAt = Date.now();
  child.kill('SIGTERM');

  const { code } = await exited;
  const drainMs = Date.now() - killedAt;
  assert.equal(code, 0);
  assert.ok(drainMs < 3000, `must exit on the grace timer, took ${drainMs}ms`);
  assert.ok(drainMs >= 900, `must not exit before the grace window, took ${drainMs}ms`);
  assert.match(out(), /GRACE EXPIRED with inflight=1/, 'must name what held the drain');
});

test('an open long-lived /mcp stream does not delay exit', async () => {
  const { child, ready, exited, out } = startChild({ SHUTDOWN_GRACE_MS: '5000' });
  const port = await ready;

  const streamOpen = new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/mcp' }, (res) => {
      res.on('data', () => resolve());
      res.on('error', () => {});
    });
    req.on('error', reject);
    setTimeout(() => reject(new Error('stream never opened')), 5000);
  });
  await streamOpen;

  const killedAt = Date.now();
  child.kill('SIGTERM');

  const { code } = await exited;
  const drainMs = Date.now() - killedAt;
  assert.equal(code, 0);
  // Without the isLongLived() exemption this pins to the full 5s grace — and
  // /mcp is the service's primary endpoint, so every deploy would pay it.
  assert.ok(drainMs < 2000, `open stream must not pin the drain, took ${drainMs}ms`);
  assert.match(out(), /Drained cleanly/, 'stream must not be counted as in-flight');
});

test('exactly one SIGTERM and one SIGINT handler exist in the codebase [source-level]', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');

  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts')) files.push(full);
    }
  })(join(ROOT, 'src'));

  const hits = { SIGTERM: [], SIGINT: [] };
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const sig of ['SIGTERM', 'SIGINT']) {
      const re = new RegExp(`process\\.on\\(\\s*['"\`]${sig}['"\`]`, 'g');
      for (const _ of src.matchAll(re)) hits[sig].push(f.replace(ROOT, ''));
    }
  }

  // A second handler that called process.exit(0) would race the drain and
  // reinstate the very defect this module exists to fix.
  assert.equal(hits.SIGTERM.length, 1, `expected exactly one SIGTERM handler, found: ${hits.SIGTERM.join(', ')}`);
  assert.equal(hits.SIGINT.length, 1, `expected exactly one SIGINT handler, found: ${hits.SIGINT.join(', ')}`);
  assert.match(hits.SIGTERM[0], /graceful-shutdown\.ts$/, 'graceful-shutdown.ts must own the signal');
  assert.match(hits.SIGINT[0], /graceful-shutdown\.ts$/, 'graceful-shutdown.ts must own the signal');
});
