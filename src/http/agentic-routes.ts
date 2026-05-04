/**
 * Agentic Routes — src/http/agentic-routes.ts
 *
 * Thin REST shim around agenticIntegrityTools so service-to-service
 * callers (LP MCP drift detector, audit cron) can reach the integrity
 * tools over plain HTTP without speaking the MCP protocol. Handlers
 * delegate to the same agenticIntegrityTools.handler functions the MCP
 * server uses — no logic is duplicated here.
 *
 * Routes:
 *   POST /internal/get-drift-candidates
 *   POST /internal/audit-namespace-violations
 *
 * Auth: Bearer HL_INTERNAL_TOKEN. Fail-closed if the env var is unset
 * (refuses every call rather than running open).
 *
 * MVI v2.5.1 (2026-05-04).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { agenticIntegrityTools } from '../tools/agentic-integrity.js';

type AgenticHandler = (args: Record<string, unknown>) => Promise<unknown>;

const AGENTIC_ROUTES: Record<string, AgenticHandler> = {
  '/internal/get-drift-candidates':
    agenticIntegrityTools.get_drift_candidates.handler as unknown as AgenticHandler,
  '/internal/audit-namespace-violations':
    agenticIntegrityTools.audit_namespace_violations.handler as unknown as AgenticHandler,
};

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body) as Record<string, unknown>); }
      catch (err) { reject(err instanceof Error ? err : new Error(String(err))); }
    });
    req.on('error', reject);
  });
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export async function tryHandleAgenticRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const handler = AGENTIC_ROUTES[pathname];
  if (!handler) return false;

  if (req.method !== 'POST') {
    writeJson(res, 405, { error: 'Method not allowed — POST only' });
    return true;
  }

  const expected = process.env.HL_INTERNAL_TOKEN;
  if (!expected) {
    console.error(`[agentic-routes] ${pathname}: HL_INTERNAL_TOKEN not set — fail-closed`);
    writeJson(res, 401, { error: 'Internal endpoint disabled — HL_INTERNAL_TOKEN not configured' });
    return true;
  }

  const authHeader = req.headers['authorization'];
  const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : '';
  if (bearer !== expected) {
    writeJson(res, 401, { error: 'Unauthorized — invalid bearer token' });
    return true;
  }

  let args: Record<string, unknown>;
  try {
    args = await readJsonBody(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeJson(res, 400, { error: `Invalid JSON body: ${message}` });
    return true;
  }

  try {
    const result = await handler(args);
    writeJson(res, 200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[agentic-routes] ${pathname} handler error: ${message}`);
    writeJson(res, 500, { error: message });
  }
  return true;
}
