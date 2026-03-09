#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { contactTools } from './tools/contacts.js';
import { pipelineTools } from './tools/pipelines.js';
import { workflowTools } from './tools/workflows.js';
import { conversationTools } from './tools/conversations.js';
import { workflowAnalysisTools } from './tools/workflow-analysis.js';
import { startScheduledSync } from './extractor/scheduler.js';

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('HL Workflow Intelligence MCP server running on stdio');

  // Start scheduled sync if enabled
  if (process.env.ENABLE_SCHEDULED_SYNC === 'true') {
    startScheduledSync();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
