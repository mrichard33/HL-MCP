#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env file if present (no external dependency needed)
const __dirname_env = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname_env, '..', '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { contactTools } from './tools/contacts.js';
import { pipelineTools } from './tools/pipelines.js';
import { workflowTools } from './tools/workflows.js';
import { conversationTools } from './tools/conversations.js';
import { workflowAnalysisTools } from './tools/workflow-analysis.js';
import { templateTools } from './tools/templates.js';
import { adminTools } from './tools/admin/index.js';
// MVI v2.5 — agentic integrity tools (audit_namespace_violations,
// get_drift_candidates). Pair with LP MCP MVI Antifragile patches.
import { agenticIntegrityTools } from './tools/agentic-integrity.js';
// MVI v2.6 — workflow_registry contamination check (Phase 2.5 of Workflow
// Registry rollout). Pairs with the n8n nightly cron workflow.
import { contaminationCheckTools } from './tools/contamination-check.js';
// MVI v2.5.1 — REST shim that wraps the integrity tools for service-to-service
// HTTP callers (LP MCP drift detector, audit cron, contamination cron).
import { tryHandleAgenticRoute } from './http/agentic-routes.js';
// WP journey — /api/telemetry ingestion + GHL write-back only. The four
// journey pages are served by the dedicated static service (Dockerfile.wp,
// same repo) at report.getreecewindows.com; GET / is back to health JSON.
import { tryHandleWpRoute } from './http/wp-routes.js';
import { startScheduledSync } from './extractor/scheduler.js';
import { handleWebhook } from './webhooks/handler.js';
import {
  getOAuthMetadata,
  handleRegister,
  handleAuthorize,
  handleToken,
  validateAccessToken,
} from './auth/oauth.js';
import { runDiagnostics } from './diagnostics.js';
import {
  isOAuthConfigured as isGhlOAuthConfigured,
  getAuthorizeUrl as getGhlAuthorizeUrl,
  exchangeCodeForTokens as exchangeGhlCode,
} from './clients/ghl-oauth.js';

function createMcpServer() {
  const server = new McpServer({
    name: 'hl-workflow-intelligence-mcp',
    version: '1.1.0',
  });

  // Register all tools
  const allTools = {
    ...contactTools,
    ...pipelineTools,
    ...workflowTools,
    ...conversationTools,
    ...workflowAnalysisTools,
    ...templateTools,
    ...adminTools,
    ...agenticIntegrityTools,
    ...contaminationCheckTools,
  };

  for (const [name, tool] of Object.entries(allTools)) {
    const t = tool as { description: string; inputSchema: unknown; handler: (args: Record<string, unknown>) => Promise<unknown> };
    server.tool(
      name,
      t.description,
      (t.inputSchema as { shape: Record<string, unknown> }).shape,
      async (args: Record<string, unknown>) => {
        try {
          const result = await t.handler(args);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      }
    );
  }

  return server;
}

// ─── Session Recovery (v1.1) ─────────────────────────────────────
// When Railway redeploys, all in-memory sessions are lost. Claude.ai
// then sends requests with the old mcp-session-id. Instead of rejecting
// (which forces manual reconnect), we auto-create a new session.

async function createAndRegisterSession(
  transports: Map<string, StreamableHTTPServerTransport>,
): Promise<{ transport: StreamableHTTPServerTransport; server: McpServer }> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  transport.onclose = () => {
    if (transport.sessionId) {
      transports.delete(transport.sessionId);
    }
  };
  const server = createMcpServer();
  await server.connect(transport);
  return { transport, server };
}

async function startHttpServer(port: number) {
  const instanceId = crypto.randomUUID();
  const staticToken = process.env.MCP_AUTH_TOKEN;
  const transports = new Map<string, StreamableHTTPServerTransport>();

  console.log(`[Server] Instance ${instanceId} starting`);

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    // CORS headers for OAuth and MCP endpoints
    const oauthPaths = ['/.well-known/oauth-authorization-server', '/authorize', '/token', '/register'];
    if (oauthPaths.includes(url.pathname) || url.pathname === '/mcp') {
      const origin = req.headers.origin || '*';
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    // MVI v2.5.1 — agentic integrity REST shim. Slotted before /health so
    // /internal/* never falls through to oauth/diagnostics or the 404.
    if (await tryHandleAgenticRoute(req, res, url.pathname)) {
      return;
    }

    // WP journey telemetry (/api/telemetry only — the pages moved to the
    // dedicated static service). /health, /mcp, OAuth, /webhooks and
    // /internal/* are untouched (no path overlap).
    if (await tryHandleWpRoute(req, res, url.pathname)) {
      return;
    }

    // Health check endpoint — GET / restored alongside /health now that the
    // film page lives on the dedicated static service
    if (url.pathname === '/' || url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        name: 'hl-workflow-intelligence-mcp',
        version: '1.0.0',
        instance_id: instanceId,
        sync_enabled: process.env.ENABLE_SCHEDULED_SYNC !== 'false',
        ghl_configured: !!(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID),
        ghl_oauth_configured: isGhlOAuthConfigured(),
        supabase_configured: !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)),
      }));
      return;
    }

    // OAuth endpoints — always enabled in HTTP mode for Claude Desktop compatibility
    // OAuth metadata discovery (RFC 8414)
    if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
      const issuer = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
      console.log(`[OAuth] Metadata requested, issuer: ${issuer}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getOAuthMetadata(issuer)));
      return;
    }

    // OAuth authorization endpoint
    if (url.pathname === '/authorize') {
      await handleAuthorize(req, res, url);
      return;
    }

    // OAuth token endpoint
    if (url.pathname === '/token' && req.method === 'POST') {
      await handleToken(req, res);
      return;
    }

    // OAuth dynamic client registration
    if (url.pathname === '/register' && req.method === 'POST') {
      await handleRegister(req, res);
      return;
    }

    // ---- CRM OAuth one-time setup routes ----

    if (url.pathname === '/crm-oauth/authorize' && req.method === 'GET') {
      if (!isGhlOAuthConfigured()) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'GHL_OAUTH_CLIENT_ID and GHL_OAUTH_CLIENT_SECRET must be set in .env' }));
        return;
      }
      const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
      const host = req.headers.host || `localhost:${port}`;
      const redirectUri = `${proto}://${host}/crm-oauth/callback`;
      const authorizeUrl = getGhlAuthorizeUrl(redirectUri);
      res.writeHead(302, { Location: authorizeUrl });
      res.end();
      return;
    }

    if (url.pathname === '/crm-oauth/callback' && req.method === 'GET') {
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing authorization code' }));
        return;
      }
      const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
      const host = req.headers.host || `localhost:${port}`;
      const redirectUri = `${proto}://${host}/crm-oauth/callback`;
      try {
        await exchangeGhlCode(code, redirectUri);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>CRM OAuth Connected!</h1><p>Conversations and messages will now sync directly. You can close this tab.</p>');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // Diagnostics endpoint
    if (url.pathname === '/diagnostics' && req.method === 'GET') {
      const authToken = process.env.MCP_AUTH_TOKEN;
      if (authToken) {
        const authHeader = req.headers['authorization'] || '';
        const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (bearerToken !== authToken) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized — provide Bearer token' }));
          return;
        }
      }
      try {
        const report = await runDiagnostics();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // Webhook endpoints for GoHighLevel real-time sync
    if (url.pathname.startsWith('/webhooks/highlevel/') && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const handled = await handleWebhook(url.pathname, payload);
          if (handled) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unknown webhook endpoint' }));
          }
        } catch (err) {
          console.error('[Webhook] Parse error:', err);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', warning: 'payload parse error' }));
        }
      });
      return;
    }

    // MCP endpoint
    if (url.pathname === '/mcp') {
      // Token-based authentication: accept OAuth-issued tokens or optional static MCP_AUTH_TOKEN
      const authHeader = req.headers['authorization'] || '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

      if (bearerToken) {
        const isOAuthValid = await validateAccessToken(bearerToken);
        const isStaticMatch = staticToken ? bearerToken === staticToken : false;
        if (!isOAuthValid && !isStaticMatch) {
          console.log(`[OAuth] /mcp: invalid bearer token (instance: ${instanceId})`);
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized — invalid or expired Bearer token' }));
          return;
        }
      } else if (staticToken) {
        // Static token is configured but no bearer provided — require auth
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized — Bearer token required' }));
        return;
      }

      // Handle DELETE for session cleanup
      if (req.method === 'DELETE') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (sessionId && transports.has(sessionId)) {
          const transport = transports.get(sessionId)!;
          await transport.close();
          transports.delete(sessionId);
        }
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.method === 'POST') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        // ── Known session — route to its transport
        if (sessionId && transports.has(sessionId)) {
          const transport = transports.get(sessionId)!;
          await transport.handleRequest(req, res);
          return;
        }

        // ── Unknown session after redeploy — return 404 per MCP spec
        // so the client knows to re-initialize with a fresh handshake.
        // The old v1.1 approach of creating a new session and passing the
        // stale request broke because the SDK rejects non-initialize
        // requests on a brand-new transport ("Server not initialized").
        if (sessionId) {
          console.log(`[MCP] Unknown session ${sessionId.slice(0, 8)}... — returning 404 to trigger client re-init`);
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session not found — please re-initialize' }));
          return;
        }

        // ── No session ID — fresh connect (initialize handshake)
        const { transport } = await createAndRegisterSession(transports);
        await transport.handleRequest(req, res);

        if (transport.sessionId) {
          transports.set(transport.sessionId, transport);
        }
        return;
      }

      // GET for SSE stream (stateful sessions)
      if (req.method === 'GET') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (sessionId && transports.has(sessionId)) {
          const transport = transports.get(sessionId)!;
          await transport.handleRequest(req, res);
          return;
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid session ID' }));
        return;
      }

      res.writeHead(405);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  httpServer.listen(port, () => {
    console.log(`HL Workflow Intelligence MCP server running on http://0.0.0.0:${port}`);
    console.log(`  Instance:      ${instanceId}`);
    console.log(`  Health check:  http://0.0.0.0:${port}/health (also at /)`);
    console.log(`  WP telemetry:  http://0.0.0.0:${port}/api/telemetry`);
    console.log(`  MCP endpoint:  http://0.0.0.0:${port}/mcp`);
    console.log(`  OAuth metadata: http://0.0.0.0:${port}/.well-known/oauth-authorization-server`);
    console.log(`  Static token:  ${staticToken ? 'configured' : 'not set (OAuth-only auth)'}`);
    console.log(`  Diagnostics:   http://0.0.0.0:${port}/diagnostics`);
    console.log(`  CRM OAuth:     http://0.0.0.0:${port}/crm-oauth/authorize`);
  });
}

async function startStdioServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log('HL Workflow Intelligence MCP server running on stdio');
}

async function main() {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;

  if (port) {
    await startHttpServer(port);
  } else {
    await startStdioServer();
  }

  // Start scheduled sync — enabled by default, set ENABLE_SCHEDULED_SYNC=false to disable
  if (process.env.ENABLE_SCHEDULED_SYNC !== 'false') {
    startScheduledSync();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
