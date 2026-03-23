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
import {
  toolDefinitions,
  handleGetDiConfig,
  handleGetPluginsForMethod,
  handleGetEventObservers,
  handleGetTemplateOverrides,
  handleGetClassContext,
  handleGetModuleOverview,
  handleReindex,
} from './mcp/tools';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const projectManager = new ProjectManager();

  // Create the MCP server
  const server = new Server(
    { name: 'magento2-lsp-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'magento_get_di_config': {
          const result = await handleGetDiConfig(projectManager, args as { filePath: string; fqcn: string; area?: string });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'magento_get_plugins_for_method': {
          const result = await handleGetPluginsForMethod(projectManager, args as { filePath: string; fqcn: string; method: string });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'magento_get_event_observers': {
          const result = await handleGetEventObservers(projectManager, args as { filePath: string; eventName?: string; observerClass?: string });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'magento_get_template_overrides': {
          const result = await handleGetTemplateOverrides(projectManager, args as { filePath: string; templateId: string; area?: string });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'magento_get_class_context': {
          const result = await handleGetClassContext(projectManager, args as { filePath: string });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'magento_get_module_overview': {
          const result = await handleGetModuleOverview(projectManager, args as { filePath: string; moduleName?: string });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'magento_reindex': {
          const { summary } = await handleReindex(projectManager, (args as { filePath: string }).filePath);
          return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
        }

        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
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
