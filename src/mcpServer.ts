/**
 * MCP (Model Context Protocol) server entry point for Magento 2 project intelligence.
 *
 * Exposes the LSP's indexing capabilities as MCP tools that AI coding agents can query.
 * Reuses all existing project detection, XML parsing, and index-building infrastructure.
 *
 * The project root is auto-detected per tool call from a filePath parameter — the server
 * walks up parent directories until it finds app/etc/di.xml. This allows a single MCP
 * server instance to serve multiple Magento projects simultaneously.
 *
 * Usage: magento2-lsp-mcp
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ProjectManager } from './project/projectManager';
import { toolDefinitions, toolHandlers, setLogger } from './mcp/tools';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../package.json');

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const projectManager = new ProjectManager();

  // Create the MCP server
  const server = new Server(
    { name: 'magento2-lsp-mcp', version },
    { capabilities: { tools: {}, logging: {} } },
  );

  // Wire up tool-layer logging to MCP notifications (with stderr fallback)
  setLogger({
    log(message: string) {
      process.stderr.write(message);
      server.sendLoggingMessage({
        level: 'info',
        logger: 'magento2-lsp-mcp',
        data: message.trimEnd(),
      }).catch(() => {
        // Swallow errors if client hasn't connected yet or doesn't support logging
      });
    },
  });

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  // Register tool call handler (registry-based dispatch)
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const handler = toolHandlers.get(name);
    if (!handler) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      const result = await handler(projectManager, args);
      // handleReindex returns { project, summary } — only send the summary
      const output = name === 'magento_reindex'
        ? (result as { summary: unknown }).summary
        : result;
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write('magento2-lsp-mcp: Ready. Projects will be indexed on first tool call.\n');
}

main().catch((error) => {
  process.stderr.write(`magento2-lsp-mcp: Fatal error: ${error}\n`);
  process.exit(1);
});
