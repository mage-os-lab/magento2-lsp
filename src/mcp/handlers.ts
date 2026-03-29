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
import { resolveClassFile, resolveFileToFqcn } from '../indexer/phpClassLocator';
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
    onBegin() {
      logger.log('magento2-lsp-mcp: Indexing...\n');
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
  const refs = project.indexes.di.getReferencesForFqcn(fqcn);

  // Effective preference
  const effectivePref = project.indexes.di.getEffectivePreferenceType(fqcn, area);
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
  const layoutRefs = project.indexes.layout.getReferencesForFqcn(fqcn);
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
  const interceptedMethods = project.indexes.pluginMethod.getInterceptedMethods(fqcn);
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
    const vtDecls = project.indexes.di.getAllVirtualTypeDecls(vt.name);
    const effectiveVt = vtDecls.length > 0
      ? project.indexes.di.getEffectiveVirtualType(vtDecls[0].name)
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
  const interceptions = project.indexes.pluginMethod.getPluginsForMethod(fqcn, method);

  const plugins = interceptions.map((i) => {
    // Use the reverse index to find which target class the plugin was declared on
    const reverseEntry = project.indexes.pluginMethod.getReverseEntry(
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
    const observers = project.indexes.events.getObserversForEvent(eventName);
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
  const registrations = project.indexes.events.getObserversForFqcn(observerClass!);
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
  const layoutRefs = project.indexes.layout.getReferencesForTemplate(templateId);
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
  const interceptedMethods = project.indexes.pluginMethod.getInterceptedMethods(fqcn);
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
        const reverseEntry = project.indexes.pluginMethod.getReverseEntry(
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
  const observerRegistrations = project.indexes.events.getObserversForFqcn(fqcn);
  const events = observerRegistrations.map((o) => ({
    eventName: o.eventName,
    observerName: o.observerName,
    declaredIn: relPath(o.file, root),
    area: o.area,
    module: o.module,
  }));

  // Is this class used as a plugin? If so, find the target class(es) it intercepts.
  const isPlugin = project.indexes.pluginMethod.isPluginClass(fqcn);
  const pluginTargets = isPlugin
    ? [...new Set(
        project.indexes.pluginMethod.getAllReverseEntries(fqcn).map((e) => e.targetFqcn),
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
  const diRefs = project.indexes.di.getReferencesByModule(mod.name);

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
  const moduleObservers = project.indexes.events.getObserversByModule(mod.name);
  const observers = moduleObservers.map((o) => ({
    eventName: o.eventName,
    observerName: o.observerName,
    observerClass: o.fqcn,
    area: o.area,
    file: relPath(o.file, root),
  }));

  // Routes declared by this module (from routes.xml)
  const routeModuleRefs = project.indexes.routes.getRefsByModule(mod.name);
  const routes = routeModuleRefs.map((r) => ({
    routeId: r.routeId,
    frontName: r.frontName,
    routerType: r.routerType,
    area: r.area,
  }));

  // REST API endpoints declared by this module (from webapi.xml)
  const webapiRefs = project.indexes.webapi.getRefsByModule(mod.name);
  const webapiEndpoints = webapiRefs
    .filter((r) => r.kind === 'service-method')
    .map((r) => ({
      url: r.routeUrl,
      httpMethod: r.httpMethod,
      serviceClass: r.fqcn ?? null,
      serviceMethod: r.methodName ?? null,
    }));

  // Database tables declared by this module (from db_schema.xml)
  const dbRefs = project.indexes.dbSchema.getRefsByModule(mod.name);
  const dbTables = [...new Set(
    dbRefs.filter((r) => r.kind === 'table-name').map((r) => r.value),
  )];

  // ACL resources declared by this module (from acl.xml)
  const aclResources = project.indexes.acl.getResourcesByModule(mod.name).map((r) => ({
    id: r.id,
    title: r.title || null,
  }));

  // Auto-summarize: if the total item count across collapsible sections exceeds
  // the threshold, replace large sections with { count } to keep the response
  // compact for agent context windows. Threshold of 30 was determined by
  // measuring real Magento modules (see plan for rationale).
  // The `detail` parameter lets agents override this and get full arrays.
  const forceDetail = params.detail === true;
  const SUMMARY_THRESHOLD = 30;
  const collapsibleTotal =
    preferences.length + plugins.length + virtualTypes.length +
    observers.length + webapiEndpoints.length;
  const summarize = !forceDetail && collapsibleTotal > SUMMARY_THRESHOLD;

  return {
    moduleName: mod.name,
    modulePath: relPath(mod.path, root),
    loadOrder: mod.order,
    preferences: summarize ? { count: preferences.length } : preferences,
    plugins: summarize ? { count: plugins.length } : plugins,
    virtualTypes: summarize ? { count: virtualTypes.length } : virtualTypes,
    observers: summarize ? { count: observers.length } : observers,
    routes,
    webapiEndpoints: summarize ? { count: webapiEndpoints.length } : webapiEndpoints,
    dbTables,
    aclResources,
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

export async function handleRescanProject(
  pm: ProjectManager,
  args: unknown,
): Promise<object> {
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
    projectRoot,
    moduleCount: project.modules.length,
    diXmlFiles: project.indexes.di.getFileCount(),
    eventsXmlFiles: project.indexes.events.getFileCount(),
    layoutXmlFiles: project.indexes.layout.getFileCount(),
    routesXmlFiles: project.indexes.routes.getFileCount(),
    themes: project.themeResolver.getAllThemes().length,
  };
}

// ---------------------------------------------------------------------------
// magento_get_db_schema
// ---------------------------------------------------------------------------

/**
 * Returns the merged database table schema aggregated from all db_schema.xml
 * files across modules. Partitions the raw DbSchemaReference entries by kind
 * to assemble a clean table definition with columns, foreign keys, and the
 * list of modules that declare or extend the table.
 */
export async function handleGetDbSchema(
  pm: ProjectManager,
  args: unknown,
) {
  const params = validateParams(args, ['filePath', 'tableName']);
  const project = await resolveProject(pm, params.filePath);
  const tableName = params.tableName as string;
  const root = project.root;

  const allRefs = project.indexes.dbSchema.getRefsForTable(tableName);
  if (allRefs.length === 0) {
    return { tableName, error: `Table '${tableName}' not found in any db_schema.xml.` };
  }

  // Extract table-level metadata from the first table-name ref that has it
  let comment: string | null = null;
  let resource: string | null = null;
  let engine: string | null = null;
  const declaredInMap = new Map<string, string>(); // module -> file (dedup)

  for (const ref of allRefs) {
    if (ref.kind === 'table-name' && ref.value === tableName) {
      if (ref.tableComment && !comment) comment = ref.tableComment;
      if (ref.tableResource && !resource) resource = ref.tableResource;
      if (ref.tableEngine && !engine) engine = ref.tableEngine;
      declaredInMap.set(ref.module, relPath(ref.file, root));
    }
  }

  // Collect columns (skip disabled ones)
  const columns = allRefs
    .filter((r) => r.kind === 'column-name' && !r.disabled)
    .map((r) => ({
      name: r.value,
      type: r.columnType ?? null,
      ...(r.columnLength ? { length: r.columnLength } : {}),
      nullable: r.columnNullable === 'true',
      identity: r.columnIdentity === 'true',
      ...(r.columnUnsigned === 'true' ? { unsigned: true } : {}),
      ...(r.columnDefault !== undefined ? { default: r.columnDefault } : {}),
      ...(r.columnPrecision ? { precision: r.columnPrecision } : {}),
      ...(r.columnScale ? { scale: r.columnScale } : {}),
      ...(r.columnComment ? { comment: r.columnComment } : {}),
      module: r.module,
    }));

  // Collect foreign keys from fk-ref-table refs (each FK produces one fk-ref-table ref)
  const foreignKeys = allRefs
    .filter((r) => r.kind === 'fk-ref-table' && !r.disabled)
    .map((r) => ({
      referenceId: r.fkReferenceId ?? null,
      column: r.fkColumn ?? null,
      referenceTable: r.fkRefTable ?? r.value,
      referenceColumn: r.fkRefColumn ?? null,
      onDelete: r.fkOnDelete ?? null,
    }));

  const declaredIn = Array.from(declaredInMap.entries()).map(([mod, file]) => ({
    module: mod,
    file,
  }));

  return {
    tableName,
    ...(comment ? { comment } : {}),
    ...(resource ? { resource } : {}),
    ...(engine ? { engine } : {}),
    columns,
    foreignKeys,
    declaredIn,
  };
}

// ---------------------------------------------------------------------------
// magento_search_symbols
// ---------------------------------------------------------------------------

/**
 * Maximum total results returned by magento_search_symbols.
 * Each category gets its own cap (MAX_PER_CATEGORY) so that broad queries
 * like "customer" don't fill the entire result set with DI class matches
 * before other categories (tables, ACL, routes) get a chance.
 */
const MAX_SEARCH_RESULTS = 100;
const MAX_PER_CATEGORY = 25;

type SymbolResult = { name: string; kind: string; file: string; classFile?: string };

export async function handleSearchSymbols(
  pm: ProjectManager,
  args: unknown,
) {
  const params = validateParams(args, ['filePath', 'query']);
  const query = (params.query as string).toLowerCase();
  if (query.length < 2) {
    return { error: 'Query must be at least 2 characters' };
  }

  const project = await resolveProject(pm, params.filePath);
  const root = project.root;
  const area = typeof params.area === 'string' ? params.area : 'frontend';

  // Search each category independently with a per-category cap, then merge.
  // This ensures every category gets representation for broad queries.

  // PHP classes (from the full symbol index, not just DI-configured ones).
  // Use segment-boundary matching first, then supplement with substring matching
  // to handle plain lowercase queries like "foointerface".
  const classMatches = project.symbolIndex.matchClasses(
    params.query as string, project.symbolMatcher, MAX_PER_CATEGORY,
  );
  const classMatchSet = new Set(classMatches);

  // Supplement with substring matching for broad queries
  if (classMatches.length < MAX_PER_CATEGORY) {
    for (const fqcn of project.symbolIndex.getAllClassFqcns()) {
      if (classMatchSet.size >= MAX_PER_CATEGORY) break;
      if (classMatchSet.has(fqcn)) continue;
      if (fqcn.toLowerCase().includes(query)) {
        classMatchSet.add(fqcn);
      }
    }
  }

  const classes: SymbolResult[] = [...classMatchSet].map(fqcn => {
    const resolved = resolveClassFile(fqcn, project.psr4Map);
    return {
      name: fqcn,
      kind: 'class',
      file: resolved ? relPath(resolved, root) : '',
      ...(resolved ? { classFile: relPath(resolved, root) } : {}),
    };
  });

  // Virtual types
  const virtualTypes: SymbolResult[] = [];
  for (const name of project.indexes.di.getAllVirtualTypeNames()) {
    if (virtualTypes.length >= MAX_PER_CATEGORY) break;
    if (!name.toLowerCase().includes(query)) continue;
    const decls = project.indexes.di.getAllVirtualTypeDecls(name);
    if (decls.length > 0) {
      virtualTypes.push({ name, kind: 'virtualType', file: relPath(decls[0].file, root) });
    }
  }

  // Event names
  const events: SymbolResult[] = [];
  for (const eventName of project.indexes.events.getAllEventNames()) {
    if (events.length >= MAX_PER_CATEGORY) break;
    if (!eventName.toLowerCase().includes(query)) continue;
    const refs = project.indexes.events.getEventNameRefs(eventName);
    if (refs.length > 0) {
      events.push({ name: eventName, kind: 'event', file: relPath(refs[0].file, root) });
    }
  }

  // Database table names
  const tables: SymbolResult[] = [];
  for (const tableName of project.indexes.dbSchema.getAllTableNames()) {
    if (tables.length >= MAX_PER_CATEGORY) break;
    if (!tableName.toLowerCase().includes(query)) continue;
    const defs = project.indexes.dbSchema.getTableDefs(tableName);
    if (defs.length > 0) {
      tables.push({ name: tableName, kind: 'table', file: relPath(defs[0].file, root) });
    }
  }

  // System config paths (e.g., "payment/account/active")
  const configPaths: SymbolResult[] = [];
  for (const configPath of project.indexes.systemConfig.getAllConfigPaths()) {
    if (configPaths.length >= MAX_PER_CATEGORY) break;
    if (!configPath.toLowerCase().includes(query)) continue;
    const refs = project.indexes.systemConfig.getRefsForPath(configPath);
    if (refs.length > 0) {
      configPaths.push({ name: configPath, kind: 'configPath', file: relPath(refs[0].file, root) });
    }
  }

  // ACL resource IDs (e.g., "Magento_Catalog::catalog")
  const aclResources: SymbolResult[] = [];
  for (const resourceId of project.indexes.acl.getAllResourceIds()) {
    if (aclResources.length >= MAX_PER_CATEGORY) break;
    if (!resourceId.toLowerCase().includes(query)) continue;
    const resource = project.indexes.acl.getResource(resourceId);
    if (resource) {
      aclResources.push({ name: resourceId, kind: 'aclResource', file: relPath(resource.file, root) });
    }
  }

  // Route frontNames (e.g., "catalog", "customer", "checkout")
  const routes: SymbolResult[] = [];
  for (const frontName of project.indexes.routes.getAllFrontNames()) {
    if (routes.length >= MAX_PER_CATEGORY) break;
    if (!frontName.toLowerCase().includes(query)) continue;
    const refs = project.indexes.routes.getRefsForFrontName(frontName);
    if (refs.length > 0) {
      routes.push({ name: frontName, kind: 'route', file: relPath(refs[0].file, root) });
    }
  }

  // Templates (from the full symbol index)
  const templateMatches = project.symbolIndex.matchTemplates(
    params.query as string, area, project.symbolMatcher, MAX_PER_CATEGORY,
  );
  const templates: SymbolResult[] = templateMatches.map(id => ({
    name: id,
    kind: 'template',
    file: '',
  }));

  // Merge all categories, capped at the global maximum
  const results = [
    ...classes, ...virtualTypes, ...events,
    ...tables, ...configPaths, ...aclResources, ...routes, ...templates,
  ].slice(0, MAX_SEARCH_RESULTS);

  return { query: params.query as string, resultCount: results.length, results };
}

// ---------------------------------------------------------------------------
// magento_get_class_hierarchy
// ---------------------------------------------------------------------------

export async function handleGetClassHierarchy(
  pm: ProjectManager,
  args: unknown,
) {
  const params = validateParams(args, ['filePath', 'fqcn']);
  const project = await resolveProject(pm, params.filePath);
  const fqcn = params.fqcn as string;
  const root = project.root;

  // Ensure the class is scanned (it may not have been referenced in di.xml)
  await project.indexes.pluginMethod.ensureScanned(fqcn, project.psr4Map);

  const parentClass = project.indexes.pluginMethod.getParent(fqcn) ?? null;
  const interfaces = project.indexes.pluginMethod.getInterfaces(fqcn);
  const ancestors = project.indexes.pluginMethod.getAncestors(fqcn);

  const classFile = resolveClassFile(fqcn, project.psr4Map);
  const mod = classFile ? findModuleForFile(classFile, project.modules) : undefined;

  return {
    fqcn,
    classFile: classFile ? relPath(classFile, root) : null,
    module: mod ? mod.name : null,
    parentClass,
    interfaces,
    ancestors,
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
  ['magento_search_symbols', handleSearchSymbols],
  ['magento_get_class_hierarchy', handleGetClassHierarchy],
  ['magento_get_db_schema', handleGetDbSchema],
  ['magento_rescan_project', handleRescanProject],
]);
