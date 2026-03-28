/**
 * MCP tool schema definitions for Magento 2 project intelligence.
 *
 * This file is the "table of contents" for the MCP API surface — each entry
 * defines the tool name, description (written for LLM consumption), and input schema.
 */

const filePathProperty = {
  type: 'string',
  description:
    'Absolute path to any file or directory inside the Magento project. ' +
    'The project root is auto-detected by walking up parent directories.',
};

export const toolDefinitions = [
  {
    name: 'magento_get_di_config',
    description:
      'Get the complete DI configuration for a PHP class/interface after Magento config merging. ' +
      'Returns the effective preference (which implementation wins after module load order + scope precedence), ' +
      'all plugins, virtual types, and constructor argument injections. ' +
      'Use this to understand how a class is wired in the Magento Object Manager.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filePath: filePathProperty,
        fqcn: {
          type: 'string',
          description:
            'Fully-qualified PHP class name (e.g., Magento\\Catalog\\Api\\ProductRepositoryInterface)',
        },
        area: {
          type: 'string',
          description:
            'DI scope area: global, frontend, adminhtml, etc. Defaults to global.',
          default: 'global',
        },
      },
      required: ['filePath', 'fqcn'],
    },
  },
  {
    name: 'magento_get_plugins_for_method',
    description:
      'Get all plugins (before/after/around interceptors) for a specific method on a class, ' +
      'including plugins inherited from parent classes and implemented interfaces. ' +
      'This is critical for understanding method behavior — Magento plugins can modify ' +
      'input, output, or completely replace method logic.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filePath: filePathProperty,
        fqcn: {
          type: 'string',
          description: 'Target class FQCN',
        },
        method: {
          type: 'string',
          description: 'Method name to check for plugin interceptions',
        },
      },
      required: ['filePath', 'fqcn', 'method'],
    },
  },
  {
    name: 'magento_get_event_observers',
    description:
      'Get all observers for a Magento event, or all events handled by an observer class. ' +
      'Provide eventName to find observers, or observerClass to find which events a class handles. ' +
      'Results span all modules and areas (global, frontend, adminhtml).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filePath: filePathProperty,
        eventName: {
          type: 'string',
          description:
            'Magento event name (e.g., catalog_product_save_after)',
        },
        observerClass: {
          type: 'string',
          description: 'Observer PHP class FQCN',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'magento_get_template_overrides',
    description:
      'Find theme overrides and layout XML usages for a template identifier. ' +
      'Resolves the full theme fallback hierarchy (child -> parent -> ... -> module). ' +
      'Use this when working with .phtml templates to see where they are used and overridden.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filePath: filePathProperty,
        templateId: {
          type: 'string',
          description:
            'Template identifier in Module_Name::path format (e.g., Magento_Catalog::product/view.phtml)',
        },
        area: {
          type: 'string',
          description:
            'Area: frontend or adminhtml. Defaults to frontend.',
          default: 'frontend',
        },
      },
      required: ['filePath', 'templateId'],
    },
  },
  {
    name: 'magento_get_class_context',
    description:
      'Get the full Magento context for a PHP class file: resolves the FQCN from the file path, ' +
      'then returns the DI preference, all plugin interceptions on every method, event observer ' +
      'registrations, layout XML references, and the module it belongs to. ' +
      'Use this when you start working on a PHP file and need to understand everything Magento ' +
      'does to or with this class.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filePath: {
          type: 'string',
          description: 'Absolute path to a PHP class file inside the Magento project.',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'magento_get_module_overview',
    description:
      'Get an overview of what a Magento module declares: preferences, plugins, virtual types, ' +
      'event observers, routes, REST API endpoints, database tables, and ACL resources. ' +
      'For large modules, DI and event sections are automatically summarized as counts ' +
      'to keep the response compact. ' +
      'Pass either a module name (Vendor_Module) or any file inside the module.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filePath: filePathProperty,
        moduleName: {
          type: 'string',
          description:
            'Module name in Vendor_Module format (e.g., Magento_Catalog). ' +
            'If omitted, the module is detected from filePath.',
        },
        detail: {
          type: 'boolean',
          description:
            'When true, always return full arrays even for large modules. ' +
            'Default: false (large modules are auto-summarized to counts).',
          default: false,
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'magento_resolve_class',
    description:
      'Resolve a PHP class: given a file path, returns its FQCN; given a FQCN, returns its file path. ' +
      'Also returns the module the class belongs to. This is a lightweight lookup using the PSR-4 map ' +
      '— no full index needed. Use this when you need to map between file paths and class names.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filePath: filePathProperty,
        fqcn: {
          type: 'string',
          description:
            'Fully-qualified PHP class name to resolve to a file path. ' +
            'Provide either this or phpFile (or both to validate the mapping).',
        },
        phpFile: {
          type: 'string',
          description:
            'Absolute path to a PHP file to resolve to a FQCN. ' +
            'Provide either this or fqcn (or both to validate the mapping).',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'magento_search_symbols',
    description:
      'Search for Magento symbols by name substring: PHP classes/interfaces configured in DI, ' +
      'virtual types, event names, database table names, system config paths, ACL resource IDs, ' +
      'and route frontNames. Returns up to 100 matches with their type and declaration file. ' +
      'Use this to discover any Magento symbol when you only know part of the name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filePath: filePathProperty,
        query: {
          type: 'string',
          description: 'Search string (minimum 2 characters). Matches case-insensitively against symbol names.',
        },
      },
      required: ['filePath', 'query'],
    },
  },
  {
    name: 'magento_get_class_hierarchy',
    description:
      'Get the class hierarchy for a PHP class: its parent class, implemented interfaces, ' +
      'and full ancestor chain (all parent classes and interfaces, walking up the inheritance tree). ' +
      'Use this to understand inheritance relationships and which interfaces a class satisfies.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filePath: filePathProperty,
        fqcn: {
          type: 'string',
          description:
            'Fully-qualified PHP class name (e.g., Magento\\Catalog\\Model\\Product)',
        },
      },
      required: ['filePath', 'fqcn'],
    },
  },
  {
    name: 'magento_get_db_schema',
    description:
      'Get the merged database table schema from all db_schema.xml files across modules. ' +
      'Returns the full column list (with types, nullable, identity, default, comment), ' +
      'foreign key constraints, and which modules declare or extend the table. ' +
      'Use this when working on models, repositories, data patches, or SQL — ' +
      'Magento tables are often extended by multiple modules, so reading a single db_schema.xml is not enough.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filePath: filePathProperty,
        tableName: {
          type: 'string',
          description: 'Database table name (e.g., catalog_product_entity)',
        },
      },
      required: ['filePath', 'tableName'],
    },
  },
  {
    name: 'magento_rescan_project',
    description:
      'Rescan the Magento project to rebuild the MCP server cache. Call this after creating ' +
      'or modifying modules, di.xml, events.xml, layout XML, or theme templates. Rebuilds all ' +
      'in-memory indexes, using the disk cache for unchanged files so incremental rescanning is fast.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filePath: filePathProperty,
      },
      required: ['filePath'],
    },
  },
];
