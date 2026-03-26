# Magento 2 MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes Magento 2 configuration intelligence to AI coding agents. 

A single MCP server instance can serve multiple Magento projects simultaneously. The project root is auto-detected per tool call from a `filePath` parameter — the server walks up parent directories until it finds `app/etc/di.xml`. Projects are indexed on first access and cached in memory for subsequent calls.


## Guiding Principle

MCP tools are valuable when they aggregate cross-module merged configuration that an agent can't easily get by reading a single file. An agent can `cat` any XML file; it can't easily merge `di.xml` fragments from 20 modules to understand a table's full schema.

This is why not every LSP capability is mirrored in the MCP. LSP features like go-to-definition, hover, and find-references operate on individual files and positions — things an agent can replicate by reading files directly. MCP tools earn their place by surfacing the *merged* result of Magento's multi-file configuration system, where the answer depends on module load order, area scoping, and inheritance rules spread across hundreds of files.

For the full parameter and response reference, see [MCP Tools Reference](mcp-tools-reference.md).

## Installation

### Claude Code

Clone the repo first.  
Then add the MCP server to your project so it's available in every Claude Code session:

```bash
claude mcp add magento2-lsp-mcp /absolute/path/to/magento2-lsp/bin/magento2-lsp-mcp
```

Or add it manually to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "magento2-lsp-mcp": {
      "command": "/absolute/path/to/magento2-lsp/bin/magento2-lsp-mcp"
    }
  }
}
```

If `bin/` is already on your `$PATH`, you can use just `magento2-lsp-mcp` as the command.

## Available Tools

### magento_get_di_config

Returns the complete Dependency Injection configuration for a PHP class or interface after Magento's config merging. Shows which implementation wins as the preference (accounting for module load order and area scope), all plugins intercepting the class, virtual types referencing it, and constructor argument injections.

Use this when you need to understand how a class is wired in the Object Manager — for example, to find out which concrete class implements an interface, or what plugins might be modifying behavior.

### magento_get_plugins_for_method

Returns all plugins (before/after/around interceptors) for a specific method on a class, including plugins inherited from parent classes and implemented interfaces. Each result includes the plugin class, method name, file location, and whether it was inherited.

Use this when modifying a method and you need to know what plugins might interfere — a common source of unexpected behavior in Magento.

### magento_get_event_observers

Bidirectional event/observer lookup. Given an event name, returns all observer classes listening to it. Given an observer class, returns all events it handles. Results span all modules and areas.

Use this when working with event-driven code to understand the full observer chain for an event, or to see what events an observer class responds to.

### magento_get_template_overrides

Finds theme overrides and layout XML usages for a template identifier. Resolves the full theme fallback hierarchy (child → parent → module) to show where a template is overridden.

Use this when working with `.phtml` templates to see where they're used in layout XML and which themes override them.

### magento_get_class_context

Returns everything Magento does to or with a PHP class: resolves its FQCN from the file path, then returns DI preferences, all plugin interceptions grouped by method, event observer registrations, layout XML references, and module membership. If the class is itself a plugin, shows which classes it intercepts.

Use this as a starting point when you begin working on a PHP file — it gives you the full picture of how Magento's configuration system affects this class.

### magento_get_module_overview

Returns an overview of what a module declares: preferences, plugins, virtual types, event observers, routes, REST API endpoints, database tables, and ACL resources. For large modules (like Magento_Catalog with 200+ items), DI and event sections are automatically summarized as counts to keep the response compact.

Use this to orient yourself when starting work on a module — it shows the module's footprint across Magento's configuration system. Pass `detail: true` to force full arrays even for large modules.

### magento_resolve_class

Lightweight PSR-4 resolution: converts between a fully-qualified class name and its file path (in either direction). Also returns the module the class belongs to. No full indexing needed.

Use this when you have a class name from XML and need the file, or vice versa.

### magento_search_symbols

Searches for Magento symbols by name substring across all indexed data: PHP classes configured in DI, virtual types, event names, database table names, system config paths, ACL resource IDs, and route frontNames. Returns up to 100 matches.

Use this to discover symbols when you only know part of the name — for example, searching "customer" finds the `customer_entity` table, `Magento_Customer::manage` ACL resource, and `customer` route frontName.

### magento_get_class_hierarchy

Returns the class hierarchy: parent class, implemented interfaces, and the full ancestor chain walking up the inheritance tree.

Use this to understand inheritance relationships, especially when dealing with plugins that are declared on parent classes or interfaces.

### magento_get_db_schema

Returns the merged database table schema aggregated from all `db_schema.xml` files across modules. Includes the full column list with types and metadata, foreign key constraints, and which modules declare or extend the table.

Use this when working on models, repositories, data patches, or SQL queries — Magento tables are often extended by multiple modules (e.g., `catalog_product_entity` has columns from Catalog, CatalogInventory, Downloadable, and more), so reading a single `db_schema.xml` is not enough.

### magento_reindex

Rebuilds all in-memory indexes after creating or modifying modules, XML files, or theme templates. Uses disk caching for unchanged files, so incremental re-indexing is fast.

Use this after making changes to XML configuration files so the other tools return up-to-date results.
