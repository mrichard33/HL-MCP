#!/usr/bin/env node

import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { contactTools } from './tools/contacts.js';
import { pipelineTools } from './tools/pipelines.js';
import { workflowTools } from './tools/workflows.js';
import { conversationTools } from './tools/conversations.js';
import { workflowAnalysisTools } from './tools/workflow-analysis.js';
import { startScheduledSync } from './extractor/scheduler.js';
import { handleWebhook } from './webhooks/handler.js';

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
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    // Health check endpoint
    if (url.pathname === '/' || url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', name: 'hl-workflow-intelligence-mcp', version: '1.0.0' }));
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
      // Token-based authentication
      const authToken = process.env.MCP_AUTH_TOKEN;
      if (authToken) {
        const authHeader = req.headers['authorization'] || '';
        const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (bearerToken !== authToken) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized — invalid or missing Bearer token' }));
          return;
        }
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
    console.error(`HL Workflow Intelligence MCP server running on http://0.0.0.0:${port}`);
    console.error(`  Health check: http://0.0.0.0:${port}/`);
    console.error(`  MCP endpoint: http://0.0.0.0:${port}/mcp`);
  });
}

async function startStdioServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('HL Workflow Intelligence MCP server running on stdio');
}

async function main() {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;

  if (port) {
    await startHttpServer(port);
  } else {
    await startStdioServer();
  }

  // Start scheduled sync if enabled
  if (process.env.ENABLE_SCHEDULED_SYNC === 'true') {
    startScheduledSync();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
