/**
 * LSP server entry point.
 *
 * This is the main module that wires everything together:
 *   - Creates the LSP connection (stdio transport)
 *   - Registers handler callbacks for definition and references requests
 *   - Lazily initializes projects when files are opened (via onDidOpenTextDocument)
 *   - Sets up file watchers for each project to keep the index current
 *   - Reports indexing progress to the editor via the LSP work done progress protocol
 *
 * The server communicates with the editor over stdin/stdout (--stdio mode), which is the
 * standard transport for LSP servers launched by editors like Neovim, VS Code, and Zed.
 *
 * Projects are initialized lazily rather than eagerly because the server doesn't know
 * which Magento project(s) the user will work with until they open a file.
 */

import {
  createConnection,
  CancellationToken,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  WorkDoneProgress,
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { SERVER_CAPABILITIES } from './capabilities';
import { ProjectManager, ProjectContext } from './project/projectManager';
import { handleDefinition } from './handlers/definition';
import { handleReferences } from './handlers/references';
import { handleCodeLens } from './handlers/codeLens';
import { handleHover } from './handlers/hover';
import { handleDocumentSymbol } from './handlers/documentSymbol';
import { handleWorkspaceSymbol } from './handlers/workspaceSymbol';
import { handlePrepareRename, handleRename } from './handlers/rename';
import { FileWatcher, createXmlWatcher } from './watcher/fileWatcher';
import { CacheSectionKey } from './cache/indexCache';
import {
  discoverDiXmlFiles,
  discoverEventsXmlFiles,
  discoverWebapiXmlFiles,
  discoverAclXmlFiles,
  discoverMenuXmlFiles,
  discoverRoutesXmlFiles,
  discoverDbSchemaXmlFiles,
  discoverUiComponentAclFiles,
  deriveDiXmlContext,
  deriveEventsXmlContext,
  deriveSystemXmlContext,
  deriveWebapiXmlContext,
  deriveAclXmlContext,
  deriveMenuXmlContext,
  deriveRoutesXmlContext,
  deriveDbSchemaXmlContext,
  deriveUiComponentAclContext,
} from './project/moduleResolver';
import { parseDiXml, DiXmlParseContext } from './indexer/diXmlParser';
import { parseEventsXml } from './indexer/eventsXmlParser';
import { parseLayoutXml } from './indexer/layoutXmlParser';
import { parseSystemXml } from './indexer/systemXmlParser';
import { parseWebapiXml } from './indexer/webapiXmlParser';
import { parseAclXml } from './indexer/aclXmlParser';
import { parseMenuXml } from './indexer/menuXmlParser';
import { parseRoutesXml } from './indexer/routesXmlParser';
import { parseDbSchemaXml } from './indexer/dbSchemaXmlParser';
import { parseUiComponentAcl } from './indexer/uiComponentAclParser';
import { resolveFileToFqcn } from './indexer/phpClassLocator';
import { ModuleInfo } from './indexer/types';
import { realpath } from './utils/realpath';
import { validateXmlFile, isXmllintAvailable, invalidateCatalogCache } from './validation/xsdValidator';
import { validateSemantics } from './validation/semanticValidator';
import * as fs from 'fs';
import * as path from 'path';

const connection = createConnection(ProposedFeatures.all);
const projectManager = new ProjectManager();
const watchers: FileWatcher[] = [];
let xmllintEnabled = false;

function log(msg: string): void {
  process.stderr.write(`[magento2-lsp] ${msg}\n`);
}

// --- LSP lifecycle ---

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  log('onInitialize');
  return { capabilities: SERVER_CAPABILITIES };
});

connection.onInitialized(async () => {
  // Detect xmllint availability for XSD validation
  xmllintEnabled = await isXmllintAvailable();
  log(`xmllint available: ${xmllintEnabled}`);
});

// --- LSP feature handlers ---

connection.onDefinition((params, token) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  const project = projectManager.getProjectForFile(filePath);
  log(`onDefinition: ${filePath} line=${params.position.line} col=${params.position.character} project=${project?.root ?? 'NONE'} indexedFiles=${project?.index.getFileCount() ?? 0}`);
  if (project) {
    const ref = project.index.getReferenceAtPosition(filePath, params.position.line, params.position.character);
    log(`  ref at position: ${ref ? `${ref.kind} ${ref.fqcn} col=${ref.column}-${ref.endColumn}` : 'NONE'}`);
  }
  return handleDefinition(params, () => project, token);
});

connection.onReferences(async (params, token) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  const project = projectManager.getProjectForFile(filePath);

  // Show progress for system.xml field references (grep can take a moment)
  if (project && filePath.endsWith('.xml')) {
    const sysRef = project.systemConfigIndex.getReferenceAtPosition(
      filePath, params.position.line, params.position.character,
    );
    if (sysRef && !sysRef.fqcn) {
      const progressToken = `config-refs-${Date.now()}`;
      try {
        await connection.sendRequest('window/workDoneProgress/create', { token: progressToken });
        connection.sendProgress(WorkDoneProgress.type, progressToken, {
          kind: 'begin',
          title: 'Searching PHP files',
          message: sysRef.configPath,
        });
        const result = await handleReferences(params, () => project, token);
        connection.sendProgress(WorkDoneProgress.type, progressToken, { kind: 'end' });
        return result;
      } catch {
        // Client may not support progress — fall through to normal handling
      }
    }
  }

  return handleReferences(params, () => project, token);
});

connection.onCodeLens((params, token) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  return handleCodeLens(params, () => projectManager.getProjectForFile(filePath), token);
});

connection.onHover((params, token) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  const project = projectManager.getProjectForFile(filePath);
  if (project) {
    const sysRef = project.systemConfigIndex.getReferenceAtPosition(filePath, params.position.line, params.position.character);
    log(`onHover: ${filePath} line=${params.position.line} col=${params.position.character} sysConfigFiles=${project.systemConfigIndex.getFileCount()} sysRef=${sysRef ? `${sysRef.kind} ${sysRef.configPath} col=${sysRef.column}-${sysRef.endColumn}` : 'NONE'}`);
  }
  return handleHover(params, () => project, token);
});

connection.onDocumentSymbol((params, token) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  return handleDocumentSymbol(params, () => projectManager.getProjectForFile(filePath), token);
});

connection.onWorkspaceSymbol((params, token) => {
  return handleWorkspaceSymbol(params, () => projectManager.getAllProjects(), token);
});

connection.onPrepareRename((params) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  return handlePrepareRename(params, () => projectManager.getProjectForFile(filePath));
});

connection.onRenameRequest(async (params, token) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  return handleRename(params, () => projectManager.getProjectForFile(filePath), token);
});

// --- Lazy project initialization ---

/**
 * When a file is opened, check if we've already initialized its Magento project.
 * If not, detect the project root, index all di.xml files, and set up a file watcher.
 *
 * Progress is reported to the editor via the LSP window/workDoneProgress protocol,
 * which typically shows as a progress bar or spinner in the editor's status line.
 */
connection.onDidOpenTextDocument(async (params) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  log(`onDidOpenTextDocument: ${filePath}`);
  const existing = projectManager.getProjectForFile(filePath);
  if (existing) {
    log(`  project already initialized: ${existing.root} (${existing.index.getFileCount()} files)`);
    // Validate on open if it's an XML file
    if (filePath.endsWith('.xml')) {
      validateAndPublish(params.textDocument.uri, params.textDocument.text, existing, 300, true);
    }
    return;
  }
  log('  initializing new project...');

  // Create a unique progress token for this indexing session
  const token = `magento-di-indexing-${Date.now()}`;

  try {
    await connection.sendRequest('window/workDoneProgress/create', { token });
  } catch {
    // Client may not support work done progress — that's fine, we just won't show it
  }

  const project = await projectManager.ensureProject(filePath, {
    onBegin(total: number) {
      try {
        connection.sendProgress(
          WorkDoneProgress.type,
          token,
          {
            kind: 'begin',
            title: 'Indexing Magento DI',
            percentage: 0,
          },
        );
      } catch {
        // Ignore progress reporting errors
      }
    },
    onProgress(current: number, total: number, file: string) {
      try {
        connection.sendProgress(
          WorkDoneProgress.type,
          token,
          {
            kind: 'report',
            message: `${current}/${total} di.xml files`,
            percentage: Math.round((current / total) * 100),
          },
        );
      } catch {
        // Ignore progress reporting errors
      }
    },
    onEnd() {
      try {
        connection.sendProgress(
          WorkDoneProgress.type,
          token,
          { kind: 'end', message: 'Done' },
        );
      } catch {
        // Ignore progress reporting errors
      }
    },
  });

  log(`  project initialized: ${project?.root ?? 'NONE'} (${project?.index.getFileCount() ?? 0} files)`);

  // --- Set up file watchers for automatic re-indexing ---

  if (project) {
    setupFileWatchers(project);

    // Validate on initial open if it's an XML file
    if (filePath.endsWith('.xml')) {
      validateAndPublish(params.textDocument.uri, params.textDocument.text, project, 300, true);
    }
  }
});

// --- XSD validation ---

/** Debounce timers for validation, keyed by file URI. */
const validationTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Validate an XML file against its XSD schema and publish diagnostics.
 * Debounced to avoid spawning xmllint too frequently during rapid edits.
 *
 * @param delayMs Debounce delay — shorter for save (immediate feedback),
 *                longer for keystroke changes (avoid excessive spawns).
 */
function validateAndPublish(
  uri: string,
  content: string,
  project: ProjectContext,
  delayMs: number = 300,
  includeExpensiveChecks: boolean = false,
): void {
  const existing = validationTimers.get(uri);
  if (existing) clearTimeout(existing);

  validationTimers.set(uri, setTimeout(async () => {
    validationTimers.delete(uri);
    try {
      const filePath = realpath(URI.parse(uri).fsPath);

      // XSD diagnostics (requires xmllint, XML files only)
      const xsdDiags = xmllintEnabled && filePath.endsWith('.xml')
        ? await validateXmlFile(filePath, content, project.root, project.modules)
        : [];

      // Semantic diagnostics (always available)
      const semanticDiags = validateSemantics(filePath, content, project, includeExpensiveChecks);

      connection.sendDiagnostics({ uri, diagnostics: [...xsdDiags, ...semanticDiags] });
    } catch {
      // Don't let validation errors break the LSP
    }
  }, delayMs));
}

connection.onDidChangeTextDocument((params) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  if (!filePath.endsWith('.xml') && !filePath.endsWith('.php')) return;
  const project = projectManager.getProjectForFile(filePath);
  if (!project) return;

  // contentChanges with Full sync contains the entire document as a single change
  const content = params.contentChanges[0]?.text;
  if (content !== undefined) {
    validateAndPublish(params.textDocument.uri, content, project, 1500);
  }
});

connection.onDidSaveTextDocument((params) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  if (!filePath.endsWith('.xml') && !filePath.endsWith('.php')) return;
  const project = projectManager.getProjectForFile(filePath);
  if (!project) return;

  // Re-read file content on save
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    validateAndPublish(params.textDocument.uri, content, project, 0, true);
  } catch {
    // File unreadable
  }
});

connection.onDidCloseTextDocument((params) => {
  // Clear diagnostics when file is closed
  connection.sendDiagnostics({ uri: params.textDocument.uri, diagnostics: [] });
  // Cancel any pending validation
  const timer = validationTimers.get(params.textDocument.uri);
  if (timer) {
    clearTimeout(timer);
    validationTimers.delete(params.textDocument.uri);
  }
});

// --- File watcher setup ---

/**
 * Configuration for a generic XML file watcher.
 * Captures the per-XML-type differences (discovery, context, parsing, index ops)
 * while standardizing the watcher lifecycle.
 */
interface TypedWatcherConfig<TCtx, TResult> {
  /** Cache section key for this XML type. */
  section: CacheSectionKey;
  /** Build watch patterns and seed the context map from the project's modules. */
  buildWatchTargets: () => { patterns: string[]; contextMap: Map<string, TCtx> };
  /** Resolve context for a file not in the initial context map (newly created files). */
  deriveContext: (file: string) => TCtx | undefined;
  /** Parse file content with its context. */
  parse: (content: string, ctx: TCtx) => TResult;
  /** Add parsed data to the index (called after removeFromIndex). */
  addToIndex: (file: string, result: TResult) => void;
  /** Remove a file's data from the index. */
  removeFromIndex: (file: string) => void;
  /** Optional callback after each change (e.g., rebuild plugin index). */
  afterChange?: () => void;
}

/**
 * Create a file watcher for an XML type using a standardized lifecycle:
 *   1. Build patterns and seed context map from project modules
 *   2. On change: resolve context → read → parse → remove old + add new → update cache
 *   3. On remove: remove from index + cache
 */
function setupTypedWatcher<TCtx, TResult>(
  project: ProjectContext,
  config: TypedWatcherConfig<TCtx, TResult>,
): FileWatcher {
  const { patterns, contextMap } = config.buildWatchTargets();

  function resolveContext(file: string): TCtx | undefined {
    const existing = contextMap.get(file);
    if (existing) return existing;
    const derived = config.deriveContext(file);
    if (derived) contextMap.set(file, derived);
    return derived;
  }

  return createXmlWatcher({
    patterns,
    resolveContext,
    parse: config.parse,
    onParsed(file, mtimeMs, result) {
      config.removeFromIndex(file);
      config.addToIndex(file, result);
      project.cache.setEntry(config.section, file, { mtimeMs, ...result as Record<string, unknown> });
    },
    onRemoved(file) {
      config.removeFromIndex(file);
      project.cache.removeFromSection(config.section, file);
    },
    saveCache: () => project.cache.save(),
    afterChange: config.afterChange,
  });
}

/**
 * Helper to build watch patterns and a context map from module discovery.
 * Most XML types follow this pattern: discover existing files + add globs for new ones.
 */
function buildModuleWatchTargets<TCtx>(
  modules: ModuleInfo[],
  discoverFiles: (modPath: string) => { file: string; [k: string]: unknown }[],
  buildContext: (f: { file: string; [k: string]: unknown }, mod: ModuleInfo) => TCtx,
  extraPatterns: (mod: ModuleInfo) => string[],
): { patterns: string[]; contextMap: Map<string, TCtx> } {
  const patterns: string[] = [];
  const contextMap = new Map<string, TCtx>();

  for (const mod of modules) {
    const files = discoverFiles(mod.path);
    for (const f of files) {
      patterns.push(f.file);
      contextMap.set(f.file, buildContext(f, mod));
    }
    for (const p of extraPatterns(mod)) {
      patterns.push(p);
    }
  }

  return { patterns, contextMap };
}

function setupFileWatchers(project: ProjectContext): void {
  // --- di.xml watcher (special: includes root di.xml + plugin rebuild) ---
  const diTargets = buildModuleWatchTargets<DiXmlParseContext>(
    project.modules,
    discoverDiXmlFiles,
    (f, mod) => ({ file: f.file as string, area: f.area as string, module: mod.name, moduleOrder: mod.order }),
    (mod) => [path.join(mod.path, 'etc', '**', 'di.xml')],
  );
  // Add root di.xml
  const rootDiXml = path.join(project.root, 'app', 'etc', 'di.xml');
  diTargets.patterns.push(rootDiXml);
  diTargets.contextMap.set(rootDiXml, { file: rootDiXml, area: 'global', module: '__root__', moduleOrder: -1 });

  let pluginRebuildTimer: ReturnType<typeof setTimeout> | undefined;
  function schedulePluginRebuild(): void {
    if (pluginRebuildTimer) clearTimeout(pluginRebuildTimer);
    pluginRebuildTimer = setTimeout(() => {
      project.pluginMethodIndex.build(project.index, project.psr4Map);
    }, 500);
  }

  watchers.push(createXmlWatcher({
    patterns: diTargets.patterns,
    resolveContext(file) {
      const existing = diTargets.contextMap.get(file);
      if (existing) return existing;
      const ctx = deriveDiXmlContext(file, project.root, project.modules);
      if (ctx) diTargets.contextMap.set(file, ctx);
      return ctx;
    },
    parse: parseDiXml,
    onParsed(file, mtimeMs, result) {
      project.index.removeFile(file);
      project.index.addFile(file, result.references, result.virtualTypes);
      project.cache.setDiEntry(file, mtimeMs, result.references, result.virtualTypes);
    },
    onRemoved(file) {
      project.index.removeFile(file);
      project.cache.removeEntry(file);
    },
    saveCache: () => project.cache.save(),
    afterChange: schedulePluginRebuild,
  }));

  // --- events.xml watcher ---
  watchers.push(setupTypedWatcher(project, {
    section: 'eventsFiles',
    buildWatchTargets: () => buildModuleWatchTargets(
      project.modules, discoverEventsXmlFiles,
      (f, mod) => ({ file: f.file as string, area: f.area as string, module: mod.name }),
      (mod) => [path.join(mod.path, 'etc', '**', 'events.xml')],
    ),
    deriveContext: (file) => deriveEventsXmlContext(file, project.modules),
    parse: parseEventsXml,
    addToIndex: (file, r) => project.eventsIndex.addFile(file, r.events, r.observers),
    removeFromIndex: (file) => project.eventsIndex.removeFile(file),
  }));

  // --- layout XML watcher ---
  watchers.push(setupTypedWatcher(project, {
    section: 'layoutFiles',
    buildWatchTargets: () => {
      const patterns: string[] = [];
      for (const mod of project.modules) {
        for (const subdir of ['layout', 'page_layout']) {
          for (const area of ['frontend', 'adminhtml', 'base']) {
            patterns.push(path.join(mod.path, 'view', area, subdir, '*.xml'));
          }
        }
      }
      for (const theme of project.themeResolver.getAllThemes()) {
        patterns.push(path.join(theme.path, '*', 'layout', '*.xml'));
        patterns.push(path.join(theme.path, '*', 'page_layout', '*.xml'));
      }
      return { patterns, contextMap: new Map<string, string>() };
    },
    deriveContext: (file) => file,
    parse: (content, filePath) => parseLayoutXml(content, filePath),
    addToIndex: (file, r) => project.layoutIndex.addFile(file, r.references),
    removeFromIndex: (file) => project.layoutIndex.removeFile(file),
  }));

  // --- system.xml watcher ---
  watchers.push(setupTypedWatcher(project, {
    section: 'systemConfigFiles',
    buildWatchTargets: () => {
      const patterns: string[] = [];
      const contextMap = new Map<string, { file: string; module: string }>();
      for (const mod of project.modules) {
        const mainFile = path.join(mod.path, 'etc', 'adminhtml', 'system.xml');
        patterns.push(mainFile);
        contextMap.set(mainFile, { file: mainFile, module: mod.name });
        patterns.push(path.join(mod.path, 'etc', 'adminhtml', 'system', '**', '*.xml'));
      }
      return { patterns, contextMap };
    },
    deriveContext: (file) => deriveSystemXmlContext(file, project.modules),
    parse: parseSystemXml,
    addToIndex: (file, r) => project.systemConfigIndex.addFile(file, r.references),
    removeFromIndex: (file) => project.systemConfigIndex.removeFile(file),
  }));

  // --- webapi.xml watcher ---
  watchers.push(setupTypedWatcher(project, {
    section: 'webapiFiles',
    buildWatchTargets: () => buildModuleWatchTargets(
      project.modules, discoverWebapiXmlFiles,
      (f, mod) => ({ file: f.file as string, module: mod.name }),
      (mod) => [path.join(mod.path, 'etc', '**', 'webapi.xml')],
    ),
    deriveContext: (file) => deriveWebapiXmlContext(file, project.modules),
    parse: parseWebapiXml,
    addToIndex: (file, r) => project.webapiIndex.addFile(file, r.references),
    removeFromIndex: (file) => project.webapiIndex.removeFile(file),
  }));

  // --- acl.xml watcher ---
  watchers.push(setupTypedWatcher(project, {
    section: 'aclFiles',
    buildWatchTargets: () => buildModuleWatchTargets(
      project.modules, discoverAclXmlFiles,
      (f, mod) => ({ file: f.file as string, module: mod.name }),
      (mod) => [path.join(mod.path, 'etc', 'acl.xml')],
    ),
    deriveContext: (file) => deriveAclXmlContext(file, project.modules),
    parse: parseAclXml,
    addToIndex: (file, r) => project.aclIndex.addFile(file, r.resources),
    removeFromIndex: (file) => project.aclIndex.removeFile(file),
  }));

  // --- menu.xml watcher ---
  watchers.push(setupTypedWatcher(project, {
    section: 'menuFiles',
    buildWatchTargets: () => buildModuleWatchTargets(
      project.modules, discoverMenuXmlFiles,
      (f, mod) => ({ file: f.file as string, module: mod.name }),
      (mod) => [path.join(mod.path, 'etc', 'adminhtml', 'menu.xml')],
    ),
    deriveContext: (file) => deriveMenuXmlContext(file, project.modules),
    parse: parseMenuXml,
    addToIndex: (file, r) => project.menuIndex.addFile(file, r.references),
    removeFromIndex: (file) => project.menuIndex.removeFile(file),
  }));

  // --- routes.xml watcher ---
  watchers.push(setupTypedWatcher(project, {
    section: 'routesFiles',
    buildWatchTargets: () => buildModuleWatchTargets(
      project.modules, discoverRoutesXmlFiles,
      (f, mod) => ({ file: f.file as string, module: mod.name, area: f.area as string }),
      (mod) => [path.join(mod.path, 'etc', '**', 'routes.xml')],
    ),
    deriveContext: (file) => deriveRoutesXmlContext(file, project.modules),
    parse: parseRoutesXml,
    addToIndex: (file, r) => project.routesIndex.addFile(file, r.references),
    removeFromIndex: (file) => project.routesIndex.removeFile(file),
  }));

  // --- db_schema.xml watcher ---
  watchers.push(setupTypedWatcher(project, {
    section: 'dbSchemaFiles',
    buildWatchTargets: () => buildModuleWatchTargets(
      project.modules, discoverDbSchemaXmlFiles,
      (f, mod) => ({ file: f.file as string, module: mod.name }),
      (mod) => [path.join(mod.path, 'etc', 'db_schema.xml')],
    ),
    deriveContext: (file) => deriveDbSchemaXmlContext(file, project.modules),
    parse: parseDbSchemaXml,
    addToIndex: (file, r) => project.dbSchemaIndex.addFile(file, r.references),
    removeFromIndex: (file) => project.dbSchemaIndex.removeFile(file),
  }));

  // --- UI component aclResource watcher ---
  watchers.push(setupTypedWatcher(project, {
    section: 'uiComponentAclFiles',
    buildWatchTargets: () => buildModuleWatchTargets(
      project.modules, discoverUiComponentAclFiles,
      (f, mod) => ({ file: f.file as string, module: mod.name }),
      (mod) => [path.join(mod.path, 'view', 'adminhtml', 'ui_component', '*.xml')],
    ),
    deriveContext: (file) => deriveUiComponentAclContext(file, project.modules),
    parse: parseUiComponentAcl,
    addToIndex: (file, r) => project.uiComponentAclIndex.addFile(file, r.references),
    removeFromIndex: (file) => project.uiComponentAclIndex.removeFile(file),
  }));

  // --- PHP file watcher ---
  // Invalidates MagicMethodIndex and ClassHierarchy caches when PHP files change.
  const phpWatchPatterns: string[] = [];
  for (const entry of project.psr4Map) {
    phpWatchPatterns.push(path.join(entry.path, '**', '*.php'));
  }

  function invalidatePhpClass(filePath: string): void {
    const fqcn = resolveFileToFqcn(filePath, project.psr4Map);
    if (!fqcn) return;
    project.magicMethodIndex.invalidateClass(fqcn);
    project.pluginMethodIndex.invalidateHierarchy(fqcn);
  }

  const phpWatcher = new FileWatcher({
    onFileChange: invalidatePhpClass,
    onFileRemove: invalidatePhpClass,
  });
  phpWatcher.watch(phpWatchPatterns);
  watchers.push(phpWatcher);
}

// --- Shutdown ---

connection.onShutdown(() => {
  for (const w of watchers) {
    w.close();
  }
});

// Start listening on stdin/stdout
connection.listen();
