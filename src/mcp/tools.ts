/**
 * MCP tool definitions and handler functions for Magento 2 project intelligence.
 *
 * Each tool handler takes a ProjectManager and a filePath (any file inside the
 * Magento project). The project root is auto-detected by walking up from filePath
 * until app/etc/di.xml is found, so one MCP server instance can serve many projects.
 */

import * as path from 'path';
import { ProjectContext, ProjectManager } from '../project/projectManager';
import { resolveClassFile } from '../indexer/phpClassLocator';
import { Psr4Map, ModuleInfo } from '../indexer/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a path relative to the project root for readable output. */
function relPath(absPath: string, root: string): string {
  return path.relative(root, absPath);
}

/** Reverse PSR-4 lookup: resolve a .php file path to its FQCN. */
function resolveFileToFqcn(filePath: string, psr4Map: Psr4Map): string | undefined {
  const normalized = path.resolve(filePath);
  if (!normalized.endsWith('.php')) return undefined;
  for (const entry of psr4Map) {
    if (normalized.startsWith(entry.path)) {
      // entry.path may or may not end with a separator — strip it to get the relative part
      const base = entry.path.endsWith(path.sep) ? entry.path : entry.path + path.sep;
      const relative = normalized.slice(base.length);
      const withoutExt = relative.slice(0, -4);
      return entry.prefix + withoutExt.split(path.sep).join('\\');
    }
  }
  return undefined;
}

/** Find which module a file belongs to by matching against module paths. */
function findModuleForFile(filePath: string, modules: ModuleInfo[]): ModuleInfo | undefined {
  const normalized = path.resolve(filePath);
  // Longest path match wins (most specific module)
  let best: ModuleInfo | undefined;
  for (const mod of modules) {
    if (normalized.startsWith(mod.path) && (!best || mod.path.length > best.path.length)) {
      best = mod;
    }
  }
  return best;
}

const filePathProperty = {
  type: 'string',
  description:
    'Absolute path to any file or directory inside the Magento project. ' +
    'The project root is auto-detected by walking up parent directories.',
};

/**
 * Resolve a ProjectContext from a filePath via the ProjectManager.
 * Indexes on first access; subsequent calls for the same project are cached.
 */
async function resolveProject(
  pm: ProjectManager,
  filePath: string,
): Promise<ProjectContext> {
  const project = await pm.ensureProject(filePath, {
    onBegin(total: number) {
      process.stderr.write(`magento2-lsp-mcp: Indexing ${total} di.xml files...\n`);
    },
    onProgress() {},
    onEnd() {
      process.stderr.write('magento2-lsp-mcp: Indexing complete.\n');
    },
  });
  if (!project) {
    throw new Error(
      `Could not detect a Magento project from ${filePath}. ` +
        'Make sure the path is inside a directory tree containing app/etc/di.xml.',
    );
  }
  return project;
}

// ---------------------------------------------------------------------------
// Tool schemas (for MCP ListTools)
// ---------------------------------------------------------------------------

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
      'event observers, layout XML files, and theme template overrides. ' +
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
      },
      required: ['filePath'],
    },
  },
  {
    name: 'magento_reindex',
    description:
      'Re-index the Magento project. Call this after creating or modifying modules, ' +
      'di.xml, events.xml, layout XML, or theme templates. Rebuilds all in-memory indexes, ' +
      'using the disk cache for unchanged files so incremental re-indexing is fast.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filePath: filePathProperty,
      },
      required: ['filePath'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

export async function handleGetDiConfig(
  pm: ProjectManager,
  params: { filePath: string; fqcn: string; area?: string },
) {
  const project = await resolveProject(pm, params.filePath);
  const { fqcn, area = 'global' } = params;
  const root = project.root;
  const refs = project.index.getReferencesForFqcn(fqcn);

  // Effective preference
  const effectivePref = project.index.getEffectivePreferenceType(fqcn, area);
  const preference = effectivePref
    ? {
        implementation: effectivePref.fqcn,
        declaredIn: relPath(effectivePref.file, root),
        area: effectivePref.area,
        module: effectivePref.module,
      }
    : null;

  // Plugins summary from the plugin method index
  const interceptedMethods = project.pluginMethodIndex.getInterceptedMethods(fqcn);
  const plugins: {
    pluginClass: string;
    methods: string[];
    declaredIn: string;
    area: string;
    module: string;
  }[] = [];
  if (interceptedMethods) {
    // Group by plugin FQCN
    const pluginMap = new Map<
      string,
      { methods: Set<string>; declaredIn: string; area: string; module: string }
    >();
    for (const [, interceptions] of interceptedMethods) {
      for (const i of interceptions) {
        const existing = pluginMap.get(i.pluginFqcn);
        if (existing) {
          existing.methods.add(i.pluginMethodName);
        } else {
          pluginMap.set(i.pluginFqcn, {
            methods: new Set([i.pluginMethodName]),
            declaredIn: relPath(i.diRef.file, root),
            area: i.diRef.area,
            module: i.diRef.module,
          });
        }
      }
    }
    for (const [pluginClass, info] of pluginMap) {
      plugins.push({
        pluginClass,
        methods: Array.from(info.methods),
        declaredIn: info.declaredIn,
        area: info.area,
        module: info.module,
      });
    }
  }

  // Virtual types that reference this FQCN
  const virtualTypes = refs
    .filter((r) => r.kind === 'virtualtype-type')
    .map((r) => {
      // Find the corresponding virtualType name
      const vtDecls = project.index.getAllVirtualTypeDecls(r.pairedFqcn ?? '');
      const effectiveVt = vtDecls.length > 0
        ? project.index.getEffectiveVirtualType(vtDecls[0].name)
        : undefined;
      return {
        name: r.pairedFqcn ?? 'unknown',
        declaredIn: relPath(r.file, root),
        area: r.area,
        module: r.module,
        ...(effectiveVt ? { effectiveParentType: effectiveVt.parentType } : {}),
      };
    });

  // Argument object injections — where this class is injected as a constructor argument
  const argumentInjections = refs
    .filter((r) => r.kind === 'argument-object')
    .map((r) => ({
      declaredIn: relPath(r.file, root),
      area: r.area,
      module: r.module,
    }));

  // Layout XML references
  const layoutRefs = project.layoutIndex.getReferencesForFqcn(fqcn);
  const layoutReferences = layoutRefs.map((r) => ({
    kind: r.kind,
    file: relPath(r.file, root),
  }));

  // Resolve class file
  const classFile = resolveClassFile(fqcn, project.psr4Map);

  return {
    fqcn,
    area,
    classFile: classFile ? relPath(classFile, root) : null,
    preference,
    plugins,
    virtualTypes,
    argumentInjections,
    layoutReferences,
  };
}

export async function handleGetPluginsForMethod(
  pm: ProjectManager,
  params: { filePath: string; fqcn: string; method: string },
) {
  const project = await resolveProject(pm, params.filePath);
  const { fqcn, method } = params;
  const root = project.root;
  const interceptions = project.pluginMethodIndex.getPluginsForMethod(fqcn, method);

  const plugins = interceptions.map((i) => {
    // Use the reverse index to find which target class the plugin was declared on
    const reverseEntry = project.pluginMethodIndex.getReverseEntry(
      i.pluginFqcn,
      i.pluginMethodName,
    );
    const declaredOnTarget = reverseEntry?.targetFqcn;

    return {
      prefix: i.prefix,
      pluginClass: i.pluginFqcn,
      pluginMethod: i.pluginMethodName,
      pluginFile: relPath(i.pluginMethodFile, root),
      declaredIn: relPath(i.diRef.file, root),
      area: i.diRef.area,
      module: i.diRef.module,
      inherited: declaredOnTarget !== fqcn,
    };
  });

  return {
    targetClass: fqcn,
    targetMethod: method,
    plugins,
  };
}

export async function handleGetEventObservers(
  pm: ProjectManager,
  params: { filePath: string; eventName?: string; observerClass?: string },
) {
  const project = await resolveProject(pm, params.filePath);
  const { eventName, observerClass } = params;
  const root = project.root;

  if (!eventName && !observerClass) {
    return { error: 'Provide at least one of eventName or observerClass' };
  }

  if (eventName) {
    const observers = project.eventsIndex.getObserversForEvent(eventName);
    return {
      eventName,
      observers: observers.map((o) => ({
        observerName: o.observerName,
        observerClass: o.fqcn,
        declaredIn: relPath(o.file, root),
        area: o.area,
        module: o.module,
      })),
    };
  }

  // Query by observer class
  const registrations = project.eventsIndex.getObserversForFqcn(observerClass!);
  return {
    observerClass,
    events: registrations.map((o) => ({
      eventName: o.eventName,
      observerName: o.observerName,
      declaredIn: relPath(o.file, root),
      area: o.area,
      module: o.module,
    })),
  };
}

export async function handleGetTemplateOverrides(
  pm: ProjectManager,
  params: { filePath: string; templateId: string; area?: string },
) {
  const project = await resolveProject(pm, params.filePath);
  const { templateId, area = 'frontend' } = params;
  const root = project.root;

  // Find the module source template
  const modulePaths = project.themeResolver.resolveTemplate(
    templateId,
    area,
    undefined,
    project.modules,
  );
  const moduleTemplate = modulePaths.length > 0 ? relPath(modulePaths[0], root) : null;

  // Find theme overrides
  const overrides = project.themeResolver.findOverrides(templateId, area);
  const themeOverrides = overrides.map((o) => ({
    theme: o.theme.code,
    file: relPath(o.filePath, root),
  }));

  // Layout XML files using this template
  const layoutRefs = project.layoutIndex.getReferencesForTemplate(templateId);
  const layoutUsages = layoutRefs.map((r) => ({
    kind: r.kind,
    file: relPath(r.file, root),
  }));

  return {
    templateId,
    area,
    moduleTemplate,
    themeOverrides,
    layoutUsages,
  };
}

export async function handleGetClassContext(
  pm: ProjectManager,
  params: { filePath: string },
) {
  const project = await resolveProject(pm, params.filePath);
  const root = project.root;

  const fqcn = resolveFileToFqcn(params.filePath, project.psr4Map);
  if (!fqcn) {
    return {
      error: `Could not resolve a PHP class FQCN from ${relPath(params.filePath, root)}. ` +
        'Make sure the file is a PHP class within a PSR-4 autoloaded namespace.',
    };
  }

  const mod = findModuleForFile(params.filePath, project.modules);

  // DI references
  const refs = project.index.getReferencesForFqcn(fqcn);

  // Effective preference (is this an interface with a preference?)
  const effectivePref = project.index.getEffectivePreferenceType(fqcn, 'global');
  const preference = effectivePref
    ? {
        implementation: effectivePref.fqcn,
        declaredIn: relPath(effectivePref.file, root),
        area: effectivePref.area,
        module: effectivePref.module,
      }
    : null;

  // All plugin interceptions, grouped by method
  const interceptedMethods = project.pluginMethodIndex.getInterceptedMethods(fqcn);
  const pluginsByMethod: Record<string, {
    prefix: string;
    pluginClass: string;
    pluginMethod: string;
    pluginFile: string;
    declaredIn: string;
    area: string;
    module: string;
    inherited: boolean;
  }[]> = {};
  if (interceptedMethods) {
    for (const [methodName, interceptions] of interceptedMethods) {
      pluginsByMethod[methodName] = interceptions.map((i) => {
        const reverseEntry = project.pluginMethodIndex.getReverseEntry(
          i.pluginFqcn,
          i.pluginMethodName,
        );
        return {
          prefix: i.prefix,
          pluginClass: i.pluginFqcn,
          pluginMethod: i.pluginMethodName,
          pluginFile: relPath(i.pluginMethodFile, root),
          declaredIn: relPath(i.diRef.file, root),
          area: i.diRef.area,
          module: i.diRef.module,
          inherited: reverseEntry?.targetFqcn !== fqcn,
        };
      });
    }
  }

  // Event observer registrations (if this class is an observer)
  const observerRegistrations = project.eventsIndex.getObserversForFqcn(fqcn);
  const events = observerRegistrations.map((o) => ({
    eventName: o.eventName,
    observerName: o.observerName,
    declaredIn: relPath(o.file, root),
    area: o.area,
    module: o.module,
  }));

  // Virtual types referencing this class
  const virtualTypes = refs
    .filter((r) => r.kind === 'virtualtype-type')
    .map((r) => ({
      name: r.pairedFqcn ?? 'unknown',
      declaredIn: relPath(r.file, root),
      area: r.area,
      module: r.module,
    }));

  // Where this class is injected as a constructor argument
  const argumentInjections = refs
    .filter((r) => r.kind === 'argument-object')
    .map((r) => ({
      declaredIn: relPath(r.file, root),
      area: r.area,
      module: r.module,
    }));

  // Layout XML references
  const layoutRefs = project.layoutIndex.getReferencesForFqcn(fqcn);
  const layoutReferences = layoutRefs.map((r) => ({
    kind: r.kind,
    file: relPath(r.file, root),
  }));

  // Is this class used as a plugin? If so, find the target class(es) it intercepts.
  const isPlugin = project.pluginMethodIndex.isPluginClass(fqcn);
  const pluginTargets = isPlugin
    ? [...new Set(
        project.pluginMethodIndex.getAllReverseEntries(fqcn).map((e) => e.targetFqcn),
      )]
    : [];

  return {
    fqcn,
    file: relPath(params.filePath, root),
    module: mod ? mod.name : null,
    preference,
    pluginsByMethod,
    events,
    virtualTypes,
    argumentInjections,
    layoutReferences,
    ...(isPlugin ? { isPlugin: true, pluginTargets } : {}),
  };
}

export async function handleGetModuleOverview(
  pm: ProjectManager,
  params: { filePath: string; moduleName?: string },
) {
  const project = await resolveProject(pm, params.filePath);
  const root = project.root;

  // Resolve module
  let mod: ModuleInfo | undefined;
  if (params.moduleName) {
    mod = project.modules.find((m) => m.name === params.moduleName);
    if (!mod) {
      return { error: `Module ${params.moduleName} not found in active modules.` };
    }
  } else {
    mod = findModuleForFile(params.filePath, project.modules);
    if (!mod) {
      return {
        error: `Could not detect a module from ${relPath(params.filePath, root)}. ` +
          'Provide moduleName explicitly.',
      };
    }
  }

  // DI declarations from this module
  const diRefs = project.index.getReferencesByModule(mod.name);

  const preferences: { interface: string; implementation: string; area: string; file: string }[] = [];
  const plugins: { targetClass: string; pluginClass: string; area: string; file: string }[] = [];
  const virtualTypes: { name: string; parentType: string; area: string; file: string }[] = [];

  for (const ref of diRefs) {
    switch (ref.kind) {
      case 'preference-type':
        preferences.push({
          interface: ref.pairedFqcn ?? 'unknown',
          implementation: ref.fqcn,
          area: ref.area,
          file: relPath(ref.file, root),
        });
        break;
      case 'plugin-type':
        plugins.push({
          targetClass: ref.pairedFqcn ?? 'unknown',
          pluginClass: ref.fqcn,
          area: ref.area,
          file: relPath(ref.file, root),
        });
        break;
      case 'virtualtype-type':
        virtualTypes.push({
          name: ref.pairedFqcn ?? 'unknown',
          parentType: ref.fqcn,
          area: ref.area,
          file: relPath(ref.file, root),
        });
        break;
    }
  }

  // Event observers declared by this module
  const moduleObservers = project.eventsIndex.getObserversByModule(mod.name);
  const observers = moduleObservers.map((o) => ({
    eventName: o.eventName,
    observerName: o.observerName,
    observerClass: o.fqcn,
    area: o.area,
    file: relPath(o.file, root),
  }));

  return {
    moduleName: mod.name,
    modulePath: relPath(mod.path, root),
    loadOrder: mod.order,
    preferences,
    plugins,
    virtualTypes,
    observers,
  };
}

export async function handleReindex(
  pm: ProjectManager,
  filePath: string,
): Promise<{ project: ProjectContext; summary: object }> {
  // Resolve the root first, then remove and re-index
  const existing = await resolveProject(pm, filePath);
  const projectRoot = existing.root;
  pm.removeProject(projectRoot);

  const project = await pm.ensureProject(projectRoot);
  if (!project) {
    throw new Error(`Failed to re-index project at ${projectRoot}`);
  }

  return {
    project,
    summary: {
      projectRoot,
      moduleCount: project.modules.length,
      diXmlFiles: project.index.getFileCount(),
      eventsXmlFiles: project.eventsIndex.getFileCount(),
      layoutXmlFiles: project.layoutIndex.getFileCount(),
      themes: project.themeResolver.getAllThemes().length,
    },
  };
}
