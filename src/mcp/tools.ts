/**
 * MCP tools barrel — re-exports definitions and handlers so existing imports continue to work.
 */

export { toolDefinitions } from './definitions';
export {
  McpLogger,
  setLogger,
  ToolHandler,
  toolHandlers,
  handleGetDiConfig,
  handleGetPluginsForMethod,
  handleGetEventObservers,
  handleGetTemplateOverrides,
  handleGetClassContext,
  handleGetModuleOverview,
  handleResolveClass,
  handleSearchSymbols,
  handleGetClassHierarchy,
  handleReindex,
} from './handlers';
