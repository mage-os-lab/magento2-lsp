# Magento 2 MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes Magento 2 configuration intelligence to AI coding agents. It provides the same deep understanding of Magento's DI system, plugin interceptors, event/observer wiring, and template overrides as the magento2-lsp, but through tool calls instead of editor integration.

A single MCP server instance can serve multiple Magento projects simultaneously. The project root is auto-detected per tool call from a `filePath` parameter — the server walks up parent directories until it finds `app/etc/di.xml`. Projects are indexed on first access and cached in memory for subsequent calls.

## Why agents need this

When working on a Magento 2 project, AI coding agents face several challenges that can't be solved with grep alone:

- **DI config merging**: Magento determines which class implements an interface by evaluating declarations across hundreds of di.xml files, applying module load order (from `config.php`) and scope precedence (area-specific overrides beat global). Grepping will find all declarations but can't tell you which one wins.

- **Plugin inheritance**: Plugins (interceptors) declared on an interface automatically apply to all implementing classes. Finding all plugins for a method requires building the class hierarchy, cross-referencing di.xml, and reading plugin PHP files to determine which methods they intercept.

- **Event/observer mapping**: Event observers are scattered across hundreds of modules in both global and area-specific events.xml files. The MCP server provides a complete, pre-indexed cross-module view.

- **Template fallback chains**: Theme template resolution follows a fallback hierarchy (child theme → parent theme → ... → module) defined by `<parent>` elements in theme.xml. An agent manually searching would likely miss overrides in parent themes.

## Available Tools

All tools require a `filePath` parameter — an absolute path to any file or directory inside the Magento project. The project root is auto-detected by walking up parent directories to find `app/etc/di.xml`.

### `magento_get_class_context`

Get the full Magento context for a PHP class file in a single call. Resolves the FQCN from the file path, then returns everything Magento does to or with this class. Use this when you start working on a PHP file and need to understand the complete picture.

**Parameters:**
- `filePath` (required) — Absolute path to a PHP class file

**Returns:**
- Resolved FQCN and module name
- Effective DI preference (if the class is an interface)
- All plugin interceptions grouped by method (including inherited plugins)
- Event observer registrations (if the class is an observer)
- Virtual types referencing this class
- Constructor argument injection sites
- Layout XML references
- Whether the class is a plugin, and if so, which classes it targets

### `magento_get_module_overview`

Get an overview of what a Magento module declares. Use this to understand the scope and purpose of a module before diving into its code.

**Parameters:**
- `filePath` (required) — Any file or directory in the Magento project
- `moduleName` (optional) — Module name in `Vendor_Module` format. If omitted, detected from `filePath`.

**Returns:**
- Module name, path, and load order
- Preferences (interface → implementation mappings)
- Plugin declarations (target class → plugin class)
- Virtual type declarations
- Event observer registrations

### `magento_get_di_config`

Get the complete DI configuration for a PHP class or interface after config merging.

**Parameters:**
- `filePath` (required) — Any file in the Magento project
- `fqcn` (required) — Fully-qualified PHP class name
- `area` (optional, default: `"global"`) — DI scope: `global`, `frontend`, `adminhtml`

**Returns:** Effective preference, plugins, virtual types, constructor argument injections, layout XML references, and resolved class file path.

### `magento_get_plugins_for_method`

Get all before/after/around plugins intercepting a specific method, including inherited plugins from parent classes and interfaces.

**Parameters:**
- `filePath` (required) — Any file in the Magento project
- `fqcn` (required) — Target class FQCN
- `method` (required) — Method name

**Returns:** List of plugin interceptions with class, method, file path, and whether the plugin is inherited.

### `magento_get_event_observers`

Get all observers for an event, or all events handled by an observer class.

**Parameters:**
- `filePath` (required) — Any file in the Magento project
- `eventName` — Magento event name (e.g., `catalog_product_save_after`)
- `observerClass` — Observer PHP class FQCN

At least one of `eventName` or `observerClass` is required.

**Returns:** Observer registrations with class, event name, declaring file, area, and module.

### `magento_get_template_overrides`

Find theme overrides and layout XML usages for a template identifier.

**Parameters:**
- `filePath` (required) — Any file in the Magento project
- `templateId` (required) — Template in `Module_Name::path` format (e.g., `Magento_Catalog::product/view.phtml`)
- `area` (optional, default: `"frontend"`) — `frontend` or `adminhtml`

**Returns:** Module source template path, theme overrides with theme codes, and layout XML files using the template.

### `magento_reindex`

Rebuild all in-memory indexes after making changes to the project (creating modules, adding di.xml entries, etc.). Uses the disk cache for unchanged files, so incremental re-indexing is fast.

**Parameters:**
- `filePath` (required) — Any file or directory in the Magento project (the project root directory works)

**Returns:** Summary with module count and indexed file counts.

## Installation

### Claude Code

```sh
claude mcp add --transport stdio --scope user magento2-lsp-mcp -- /path/to/magento2-lsp/bin/magento2-lsp-mcp
```

The `--scope user` flag makes the server available across all projects.

### Generic MCP Client

The server uses stdio transport. Configure your MCP client to run:

```sh
magento2-lsp-mcp
```

Or if installed locally (not globally):

```sh
npx magento2-lsp-mcp
```

No `--project-root` argument is needed — the project is auto-detected from the `filePath` parameter on each tool call.

## Caching

The MCP server shares the same `.magento2-lsp-cache.json` disk cache as the LSP server. If the LSP has already indexed the project, the MCP server will read the cache and skip re-parsing unchanged files — startup is near-instant for a warm cache.

After calling `magento_reindex`, the updated cache is written to disk so subsequent MCP server startups (and LSP sessions) benefit from the latest parse results.
