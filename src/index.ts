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
    version: '1.0.0',
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

async function startHttpServer(port: number) {
  const isAuthEnabled = !!process.env.MCP_AUTH_TOKEN;
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    // Health check endpoint
    if (url.pathname === '/' || url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        name: 'hl-workflow-intelligence-mcp',
        version: '1.0.0',
        sync_enabled: process.env.ENABLE_SCHEDULED_SYNC !== 'false',
        ghl_configured: !!(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID),
        ghl_oauth_configured: isGhlOAuthConfigured(),
        supabase_configured: !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)),
      }));
      return;
    }

    // OAuth endpoints — only enabled when MCP_AUTH_TOKEN is set
    if (isAuthEnabled) {
      // OAuth metadata discovery (RFC 8414)
      if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
        const issuer = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
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
    }

    // ---- CRM OAuth one-time setup routes ----

    // Step 1: Redirect user to CRM consent screen
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

    // Step 2: CRM redirects back here with ?code=...
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
      // Protect with MCP_AUTH_TOKEN if set
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
      // Token-based authentication: accept static MCP_AUTH_TOKEN or OAuth-issued tokens
      const authHeader = req.headers['authorization'] || '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      const staticToken = process.env.MCP_AUTH_TOKEN;

      if (staticToken) {
        // If a static token is configured, require either it or a valid OAuth token
        const isStaticMatch = bearerToken === staticToken;
        const isOAuthValid = bearerToken ? validateAccessToken(bearerToken) : false;
        if (!isStaticMatch && !isOAuthValid) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized — invalid or missing Bearer token' }));
          return;
        }
      } else if (bearerToken) {
        // No static token configured, but a bearer was provided — check if it's a valid OAuth token
        // (allow through even if invalid, to maintain backwards compatibility with no-auth mode)
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

      // For new initialize requests (POST without session), create a new transport and server
      if (req.method === 'POST') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (sessionId && transports.has(sessionId)) {
          // Existing session — reuse transport
          const transport = transports.get(sessionId)!;
          await transport.handleRequest(req, res);
          return;
        }

        // New session — create transport + server
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
    console.log(`  Health check:  http://0.0.0.0:${port}/`);
    console.log(`  MCP endpoint:  http://0.0.0.0:${port}/mcp`);
    if (isAuthEnabled) {
      console.log(`  OAuth metadata: http://0.0.0.0:${port}/.well-known/oauth-authorization-server`);
    } else {
      console.log(`  Auth:           disabled (set MCP_AUTH_TOKEN to enable)`);
    }
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
