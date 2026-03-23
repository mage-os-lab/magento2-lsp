/**
 * MCP tool handler implementations for Magento 2 project intelligence.
 *
 * Each handler takes a ProjectManager and raw args (validated internally),
 * resolves the project from a filePath parameter, and returns structured JSON.
 */

import * as path from 'path';
import * as fs from 'fs';
import { ProjectContext, ProjectManager } from '../project/projectManager';
import { detectMagentoRoot } from '../project/detector';
import { resolveClassFile } from '../indexer/phpClassLocator';
import { Psr4Map, ModuleInfo } from '../indexer/types';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/** Logger interface for MCP tool progress/status messages. */
export interface McpLogger {
  /** Log a status/progress message. */
  log(message: string): void;
}

/** Default logger that writes to stderr (suitable for stdio transport). */
const stderrLogger: McpLogger = {
  log(message: string) {
    process.stderr.write(message);
  },
};

/** Module-level logger instance, replaceable via setLogger(). */
let logger: McpLogger = stderrLogger;

/** Replace the default stderr logger (e.g., for MCP notifications or testing). */
export function setLogger(newLogger: McpLogger): void {
  logger = newLogger;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a path relative to the project root for readable output. */
function relPath(absPath: string, root: string): string {
  return path.relative(root, absPath);
}

/** Reverse PSR-4 lookup: resolve a .php file path to its FQCN (longest-prefix-match). */
function resolveFileToFqcn(filePath: string, psr4Map: Psr4Map): string | undefined {
  const normalized = path.resolve(filePath);
  if (!normalized.endsWith('.php')) return undefined;
  // Find the most specific (longest path) matching PSR-4 entry
  let best: { path: string; prefix: string } | undefined;
  for (const entry of psr4Map) {
    if (normalized.startsWith(entry.path) && (!best || entry.path.length > best.path.length)) {
      best = entry;
    }
  }
  if (!best) return undefined;
  const base = best.path.endsWith(path.sep) ? best.path : best.path + path.sep;
  const relative = normalized.slice(base.length);
  const withoutExt = relative.slice(0, -4);
  return best.prefix + withoutExt.split(path.sep).join('\\');
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
      logger.log(`magento2-lsp-mcp: Indexing ${total} di.xml files...\n`);
    },
    onProgress() {},
    onEnd() {
      logger.log('magento2-lsp-mcp: Indexing complete.\n');
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
// Input validation
// ---------------------------------------------------------------------------

/** Validate that required string parameters are present and are strings. */
function validateParams(
  args: unknown,
  required: string[],
): { filePath: string } & Record<string, unknown> {
  if (!args || typeof args !== 'object') {
    throw new Error('Missing parameters object');
  }
  const params = args as Record<string, unknown>;
  for (const key of required) {
    if (typeof params[key] !== 'string' || (params[key] as string).trim() === '') {
      throw new Error(`Missing or invalid required parameter: ${key} (expected non-empty string)`);
    }
  }
  return params as { filePath: string } & Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Shared DI summary builder (used by handleGetDiConfig and handleGetClassContext)
// ---------------------------------------------------------------------------

function buildDiSummary(project: ProjectContext, fqcn: string, area: string) {
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

  // Virtual types that reference this FQCN
  const virtualTypes = refs
    .filter((r) => r.kind === 'virtualtype-type')
    .map((r) => ({
      name: r.pairedFqcn ?? 'unknown',
      declaredIn: relPath(r.file, root),
      area: r.area,
      module: r.module,
    }));

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

  return { preference, virtualTypes, argumentInjections, layoutReferences };
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

export async function handleGetDiConfig(
  pm: ProjectManager,
  args: unknown,
) {
  const params = validateParams(args, ['filePath', 'fqcn']);
  const project = await resolveProject(pm, params.filePath);
  const fqcn = params.fqcn as string;
  const area = (typeof params.area === 'string' && params.area) || 'global';
  const root = project.root;

  const { preference, virtualTypes: baseVirtualTypes, argumentInjections, layoutReferences } =
    buildDiSummary(project, fqcn, area);

  // Plugins summary from the plugin method index (grouped by plugin class)
  const interceptedMethods = project.pluginMethodIndex.getInterceptedMethods(fqcn);
  const plugins: {
    pluginClass: string;
    methods: string[];
    declaredIn: string;
    area: string;
    module: string;
  }[] = [];
  if (interceptedMethods) {
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

  // Enrich virtual types with effective parent type info
  const virtualTypes = baseVirtualTypes.map((vt) => {
    const vtDecls = project.index.getAllVirtualTypeDecls(vt.name);
    const effectiveVt = vtDecls.length > 0
      ? project.index.getEffectiveVirtualType(vtDecls[0].name)
      : undefined;
    return {
      ...vt,
      ...(effectiveVt ? { effectiveParentType: effectiveVt.parentType } : {}),
    };
  });

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
  args: unknown,
) {
  const params = validateParams(args, ['filePath', 'fqcn', 'method']);
  const project = await resolveProject(pm, params.filePath);
  const fqcn = params.fqcn as string;
  const method = params.method as string;
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
  args: unknown,
) {
  const params = validateParams(args, ['filePath']);
  const project = await resolveProject(pm, params.filePath);
  const eventName = typeof params.eventName === 'string' ? params.eventName : undefined;
  const observerClass = typeof params.observerClass === 'string' ? params.observerClass : undefined;
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
  args: unknown,
) {
  const params = validateParams(args, ['filePath', 'templateId']);
  const project = await resolveProject(pm, params.filePath);
  const templateId = params.templateId as string;
  const area = (typeof params.area === 'string' && params.area) || 'frontend';
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
  args: unknown,
) {
  const params = validateParams(args, ['filePath']);
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
  const { preference, virtualTypes, argumentInjections, layoutReferences } =
    buildDiSummary(project, fqcn, 'global');

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
  args: unknown,
) {
  const params = validateParams(args, ['filePath']);
  const moduleName = typeof params.moduleName === 'string' ? params.moduleName : undefined;
  const project = await resolveProject(pm, params.filePath);
  const root = project.root;

  // Resolve module
  let mod: ModuleInfo | undefined;
  if (moduleName) {
    mod = project.modules.find((m) => m.name === moduleName);
    if (!mod) {
      return { error: `Module ${moduleName} not found in active modules.` };
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

export async function handleResolveClass(
  pm: ProjectManager,
  args: unknown,
) {
  const params = validateParams(args, ['filePath']);
  const fqcn = typeof params.fqcn === 'string' ? params.fqcn : undefined;
  const phpFile = typeof params.phpFile === 'string' ? params.phpFile : undefined;

  if (!fqcn && !phpFile) {
    return { error: 'Provide at least one of fqcn or phpFile' };
  }

  const project = await resolveProject(pm, params.filePath);
  const root = project.root;

  const result: Record<string, unknown> = {};

  if (phpFile) {
    const resolved = resolveFileToFqcn(phpFile, project.psr4Map);
    result.phpFile = relPath(phpFile, root);
    result.resolvedFqcn = resolved ?? null;
    if (resolved) {
      const mod = findModuleForFile(phpFile, project.modules);
      result.module = mod ? mod.name : null;
    }
  }

  if (fqcn) {
    const resolved = resolveClassFile(fqcn, project.psr4Map);
    result.fqcn = fqcn;
    result.resolvedFile = resolved ? relPath(resolved, root) : null;
    if (resolved && !result.module) {
      const mod = findModuleForFile(resolved, project.modules);
      result.module = mod ? mod.name : null;
    }
  }

  return result;
}

export async function handleReindex(
  pm: ProjectManager,
  args: unknown,
): Promise<{ project: ProjectContext; summary: object }> {
  const params = validateParams(args, ['filePath']);
  const filePath = params.filePath;
  // Detect the root without triggering a full index (avoids double-indexing on first call)
  const startDir = fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
  const projectRoot = detectMagentoRoot(startDir);
  if (!projectRoot) {
    throw new Error(
      `Could not detect a Magento project from ${filePath}. ` +
        'Make sure the path is inside a directory tree containing app/etc/di.xml.',
    );
  }
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

// ---------------------------------------------------------------------------
// Tool handler registry (maps tool name -> handler, eliminates switch/case dispatch)
// ---------------------------------------------------------------------------

export type ToolHandler = (pm: ProjectManager, args: unknown) => Promise<unknown>;

export const toolHandlers = new Map<string, ToolHandler>([
  ['magento_get_di_config', handleGetDiConfig],
  ['magento_get_plugins_for_method', handleGetPluginsForMethod],
  ['magento_get_event_observers', handleGetEventObservers],
  ['magento_get_template_overrides', handleGetTemplateOverrides],
  ['magento_get_class_context', handleGetClassContext],
  ['magento_get_module_overview', handleGetModuleOverview],
  ['magento_resolve_class', handleResolveClass],
  ['magento_reindex', handleReindex],
]);
