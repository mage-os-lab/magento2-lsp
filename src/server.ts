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
import { buildCapabilities } from './capabilities';
import { ProjectManager, ProjectContext } from './project/projectManager';
import { handleDefinition } from './handlers/definition';
import { handleReferences } from './handlers/references';
import { handleCodeLens } from './handlers/codeLens';
import { handleHover } from './handlers/hover';
import { handleDocumentSymbol } from './handlers/documentSymbol';
import { handleWorkspaceSymbol } from './handlers/workspaceSymbol';
import { handlePrepareRename, handleRename } from './handlers/rename';
import { handleCompletion } from './handlers/completion';
import { handleCodeAction, handleCodeActionResolve, type CreateFileActionData, type AddInterfaceActionData } from './handlers/codeAction';
import { handleInlayHint } from './handlers/inlayHint';
import { updateSettings, setClientName, getEffectiveHintMode } from './settings';
import { UnifiedFileWatcher, createXmlWatcherHandler } from './watcher/fileWatcher';
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
  deriveLayoutXmlContext,
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
import { deriveClassEntry } from './indexer/phpClassScanner';
import { deriveTemplateEntry } from './indexer/templateScanner';
import { ModuleInfo } from './indexer/types';
import { realpath } from './utils/realpath';
import { validateXmlFile, isXmllintAvailable, invalidateCatalogCache } from './validation/xsdValidator';
import { validateSemantics } from './validation/semanticValidator';
import * as fs from 'fs';
import * as path from 'path';

const connection = createConnection(ProposedFeatures.all);
const projectManager = new ProjectManager();
const watchers: { close(): void }[] = [];
/** Per-project unified watcher, for adding patterns at runtime (e.g., after code action creates a file in a new directory). */
const projectWatchers = new Map<string, UnifiedFileWatcher>();
let xmllintEnabled = false;

/**
 * Cache of open document contents, keyed by document URI.
 *
 * Kept in sync with the editor via onDidOpen/onChange/onClose notifications.
 * This allows completion (and other features) to work on unsaved edits rather
 * than stale on-disk content.
 */
const documentContents = new Map<string, string>();

/**
 * Retrieve the cached content for an open document.
 *
 * @param uri - The document URI (as sent by the editor).
 * @returns The latest document text, or undefined if the document is not open / not cached.
 */
function getDocumentText(uri: string): string | undefined {
  return documentContents.get(uri);
}

function log(msg: string): void {
  process.stderr.write(`[magento2-lsp] ${msg}\n`);
}

// --- LSP lifecycle ---

connection.onInitialize((params: InitializeParams): InitializeResult => {
  log('onInitialize');
  setClientName(params.clientInfo?.name);
  if (params.initializationOptions) {
    updateSettings(params.initializationOptions);
  }
  const hintMode = getEffectiveHintMode();
  log(`hintMode: ${hintMode} (client: ${params.clientInfo?.name ?? 'unknown'})`);
  return { capabilities: buildCapabilities(hintMode) };
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
  log(`onDefinition: ${filePath} line=${params.position.line} col=${params.position.character} project=${project?.root ?? 'NONE'} indexedFiles=${project?.indexes.di.getFileCount() ?? 0}`);
  if (project) {
    const ref = project.indexes.di.getReferenceAtPosition(filePath, params.position.line, params.position.character);
    log(`  ref at position: ${ref ? `${ref.kind} ${ref.fqcn} col=${ref.column}-${ref.endColumn}` : 'NONE'}`);
  }
  return handleDefinition(params, () => project, getDocumentText, token);
});

connection.onReferences(async (params, token) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  const project = projectManager.getProjectForFile(filePath);

  // Show progress for system.xml field references (grep can take a moment)
  if (project && filePath.endsWith('.xml')) {
    const sysRef = project.indexes.systemConfig.getReferenceAtPosition(
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
        const result = await handleReferences(params, () => project, getDocumentText, token);
        connection.sendProgress(WorkDoneProgress.type, progressToken, { kind: 'end' });
        return result;
      } catch {
        // Client may not support progress — fall through to normal handling
      }
    }
  }

  return handleReferences(params, () => project, getDocumentText, token);
});

connection.onCodeLens((params, token) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  return handleCodeLens(params, () => projectManager.getProjectForFile(filePath), token);
});

connection.languages.inlayHint.on((params, token) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  return handleInlayHint(params, () => projectManager.getProjectForFile(filePath), token);
});

connection.onHover((params, token) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  const project = projectManager.getProjectForFile(filePath);
  if (project) {
    const sysRef = project.indexes.systemConfig.getReferenceAtPosition(filePath, params.position.line, params.position.character);
    log(`onHover: ${filePath} line=${params.position.line} col=${params.position.character} sysConfigFiles=${project.indexes.systemConfig.getFileCount()} sysRef=${sysRef ? `${sysRef.kind} ${sysRef.configPath} col=${sysRef.column}-${sysRef.endColumn}` : 'NONE'}`);
  }
  return handleHover(params, () => project, getDocumentText, token);
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

connection.onCompletion((params, token) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  return handleCompletion(
    params,
    () => projectManager.getProjectForFile(filePath),
    getDocumentText,
    token,
  );
});

connection.onCodeAction((params, token) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  return handleCodeAction(
    params,
    () => projectManager.getProjectForFile(filePath),
    getDocumentText,
    token,
  );
});

connection.onCodeActionResolve((action) => {
  const resolved = handleCodeActionResolve(action, (filePath) => projectManager.getProjectForFile(filePath));

  // After resolve, re-index and re-validate the source document so
  // diagnostics clear and go-to-definition works immediately.
  const data = resolved.data as CreateFileActionData | AddInterfaceActionData | undefined;
  const sourceUri = data?.sourceUri;
  if (sourceUri) {
    const sourceFilePath = realpath(URI.parse(sourceUri).fsPath);
    const project = projectManager.getProjectForFile(sourceFilePath);
    if (project) {
      // For file creation: ensure the watcher covers the new directory
      if (data.type === 'create-file') {
        const watcher = projectWatchers.get(project.root);
        if (watcher) {
          watcher.add([path.join(path.dirname(data.targetPath), '*')]);
        }
      }

      const content = documentContents.get(sourceUri)
        ?? (fs.existsSync(sourceFilePath) ? fs.readFileSync(sourceFilePath, 'utf-8') : undefined);
      if (content !== undefined) {
        if (sourceFilePath.endsWith('.xml')) {
          indexSingleXmlFile(sourceFilePath, content, project);
        }
        validateAndPublish(sourceUri, content, project, 0, true);
      }
    }
  }

  return resolved;
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
  documentContents.set(params.textDocument.uri, params.textDocument.text);
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  log(`onDidOpenTextDocument: ${filePath}`);
  const existing = projectManager.getProjectForFile(filePath);
  if (existing) {
    log(`  project already initialized: ${existing.root} (${existing.indexes.di.getFileCount()} files)`);
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
    onBegin() {
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

  log(`  project initialized: ${project?.root ?? 'NONE'} (${project?.indexes.di.getFileCount() ?? 0} files)`);

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
    } catch (err) {
      log(`Validation error for ${uri}: ${err}`);
    }
  }, delayMs));
}

connection.onDidChangeTextDocument((params) => {
  // contentChanges with Full sync contains the entire document as a single change
  const content = params.contentChanges[0]?.text;
  if (content !== undefined) {
    documentContents.set(params.textDocument.uri, content);
  }

  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  if (!filePath.endsWith('.xml') && !filePath.endsWith('.php')) return;
  const project = projectManager.getProjectForFile(filePath);
  if (!project) return;

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

    // Index the file if it's a recognized XML type. This catches files that the
    // file watcher missed (e.g., new files in directories that didn't exist at
    // watch time) and ensures go-to-definition works immediately after save.
    if (filePath.endsWith('.xml')) {
      indexSingleXmlFile(filePath, content, project);
    }
  } catch {
    // File unreadable
  }
});

connection.onDidCloseTextDocument((params) => {
  documentContents.delete(params.textDocument.uri);
  // Clear diagnostics when file is closed
  connection.sendDiagnostics({ uri: params.textDocument.uri, diagnostics: [] });
  // Cancel any pending validation
  const timer = validationTimers.get(params.textDocument.uri);
  if (timer) {
    clearTimeout(timer);
    validationTimers.delete(params.textDocument.uri);
  }
});

/**
 * Parse and index a single XML file on save. This supplements the file watcher
 * by handling files in directories that didn't exist when the watcher started.
 * Uses replaceFile so it's safe to call repeatedly for the same file.
 * Also updates the disk cache and triggers plugin rebuild for di.xml changes.
 */
function indexSingleXmlFile(filePath: string, content: string, project: ProjectContext): void {
  try {
    const mtimeMs = fs.statSync(filePath).mtimeMs;

    const diCtx = deriveDiXmlContext(filePath, project.root, project.modules);
    if (diCtx) {
      const result = parseDiXml(content, diCtx);
      project.indexes.di.replaceFile(filePath, result.references, result.virtualTypes);
      project.cache.setDiEntry(filePath, mtimeMs, result.references, result.virtualTypes);
      project.cache.save();
      project.indexes.pluginMethod.rebuildForFile(filePath, project.indexes.di, project.psr4Map);
      return;
    }

    const eventsCtx = deriveEventsXmlContext(filePath, project.modules);
    if (eventsCtx) {
      const result = parseEventsXml(content, eventsCtx);
      project.indexes.events.replaceFile(filePath, result.events, result.observers);
      project.cache.setEntry('eventsFiles', filePath, { mtimeMs, ...result });
      project.cache.save();
      return;
    }

    if (deriveLayoutXmlContext(filePath)) {
      const result = parseLayoutXml(content, filePath);
      project.indexes.layout.replaceFile(filePath, result.references);
      project.cache.setEntry('layoutFiles', filePath, { mtimeMs, ...result });
      project.cache.save();
      return;
    }

    const sysCtx = deriveSystemXmlContext(filePath, project.modules);
    if (sysCtx) {
      const result = parseSystemXml(content, sysCtx);
      project.indexes.systemConfig.replaceFile(filePath, result.references);
      project.cache.setEntry('systemConfigFiles', filePath, { mtimeMs, ...result });
      project.cache.save();
      return;
    }

    const webapiCtx = deriveWebapiXmlContext(filePath, project.modules);
    if (webapiCtx) {
      const result = parseWebapiXml(content, webapiCtx);
      project.indexes.webapi.replaceFile(filePath, result.references);
      project.cache.setEntry('webapiFiles', filePath, { mtimeMs, ...result });
      project.cache.save();
      return;
    }

    const aclCtx = deriveAclXmlContext(filePath, project.modules);
    if (aclCtx) {
      const result = parseAclXml(content, aclCtx);
      project.indexes.acl.replaceFile(filePath, result.resources);
      project.cache.setEntry('aclFiles', filePath, { mtimeMs, ...result });
      project.cache.save();
      return;
    }

    const menuCtx = deriveMenuXmlContext(filePath, project.modules);
    if (menuCtx) {
      const result = parseMenuXml(content, menuCtx);
      project.indexes.menu.replaceFile(filePath, result.references);
      project.cache.setEntry('menuFiles', filePath, { mtimeMs, ...result });
      project.cache.save();
      return;
    }

    const routesCtx = deriveRoutesXmlContext(filePath, project.modules);
    if (routesCtx) {
      const result = parseRoutesXml(content, routesCtx);
      project.indexes.routes.replaceFile(filePath, result.references);
      project.cache.setEntry('routesFiles', filePath, { mtimeMs, ...result });
      project.cache.save();
      return;
    }

    const dbCtx = deriveDbSchemaXmlContext(filePath, project.modules);
    if (dbCtx) {
      const result = parseDbSchemaXml(content, dbCtx);
      project.indexes.dbSchema.replaceFile(filePath, result.references);
      project.cache.setEntry('dbSchemaFiles', filePath, { mtimeMs, ...result });
      project.cache.save();
      return;
    }

    const uiCtx = deriveUiComponentAclContext(filePath, project.modules);
    if (uiCtx) {
      const result = parseUiComponentAcl(content, uiCtx);
      project.indexes.uiComponentAcl.replaceFile(filePath, result.references);
      project.cache.setEntry('uiComponentAclFiles', filePath, { mtimeMs, ...result });
      project.cache.save();
      return;
    }
  } catch (err) {
    log(`Indexing error for ${filePath}: ${err}`);
  }
}

// --- File watcher setup ---

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

/**
 * Build a resolveContext function that checks a pre-seeded context map first,
 * then falls back to a derive function for newly created files.
 */
function makeContextResolver<TCtx>(
  contextMap: Map<string, TCtx>,
  derive: (file: string) => TCtx | undefined,
): (file: string) => TCtx | undefined {
  return (file: string) => {
    const existing = contextMap.get(file);
    if (existing) return existing;
    const derived = derive(file);
    if (derived) contextMap.set(file, derived);
    return derived;
  };
}

/**
 * Create a typed XML watcher handler and its patterns from a standardized config.
 * Returns the handler (for the unified watcher) and the patterns to watch.
 */
function buildTypedHandler<TCtx, TResult>(
  project: ProjectContext,
  config: {
    section: CacheSectionKey;
    buildWatchTargets: () => { patterns: string[]; contextMap: Map<string, TCtx> };
    deriveContext: (file: string) => TCtx | undefined;
    parse: (content: string, ctx: TCtx) => TResult;
    replaceInIndex: (file: string, result: TResult) => void;
    removeFromIndex: (file: string) => void;
    afterChange?: (file: string) => void;
  },
  matches: (filePath: string) => boolean,
  saveCache: () => void,
): { patterns: string[]; handler: import('./watcher/fileWatcher').WatcherHandler } {
  const { patterns, contextMap } = config.buildWatchTargets();

  return {
    patterns,
    handler: createXmlWatcherHandler(
      {
        resolveContext: makeContextResolver(contextMap, config.deriveContext),
        parse: config.parse,
        onParsed(file, mtimeMs, result) {
          config.replaceInIndex(file, result);
          project.cache.setEntry(config.section, file, { mtimeMs, ...result as Record<string, unknown> });
        },
        onRemoved(file) {
          config.removeFromIndex(file);
          project.cache.removeFromSection(config.section, file);
        },
        saveCache,
        afterChange: config.afterChange,
      },
      matches,
    ),
  };
}

/**
 * Set up a single unified file watcher for all XML types and PHP files.
 * Uses one chokidar instance instead of 11, reducing OS file descriptor usage.
 */
function setupFileWatchers(project: ProjectContext): void {
  const unified = new UnifiedFileWatcher();
  const allPatterns: string[] = [];

  // Debounced cache save — avoids a cascade of full JSON rewrites during
  // bulk file changes (e.g., git checkout). The cache is only needed for
  // warm startup, so a 2-second delay is fine.
  let cacheSaveTimer: ReturnType<typeof setTimeout> | undefined;
  function debouncedCacheSave(): void {
    if (cacheSaveTimer) clearTimeout(cacheSaveTimer);
    cacheSaveTimer = setTimeout(() => project.cache.save(), 2000);
  }

  // --- di.xml handler (special: includes root di.xml + plugin rebuild) ---
  const diTargets = buildModuleWatchTargets<DiXmlParseContext>(
    project.modules,
    discoverDiXmlFiles,
    (f, mod) => ({ file: f.file as string, area: f.area as string, module: mod.name, moduleOrder: mod.order }),
    (mod) => [path.join(mod.path, 'etc', '**', 'di.xml')],
  );
  const rootDiXml = path.join(project.root, 'app', 'etc', 'di.xml');
  diTargets.patterns.push(rootDiXml);
  diTargets.contextMap.set(rootDiXml, { file: rootDiXml, area: 'global', module: '__root__', moduleOrder: -1 });

  let pluginRebuildTimer: ReturnType<typeof setTimeout> | undefined;
  const changedDiFiles = new Set<string>();
  function schedulePluginRebuild(file: string): void {
    changedDiFiles.add(file);
    if (pluginRebuildTimer) clearTimeout(pluginRebuildTimer);
    pluginRebuildTimer = setTimeout(async () => {
      const files = [...changedDiFiles];
      changedDiFiles.clear();
      for (const f of files) {
        await project.indexes.pluginMethod.rebuildForFile(f, project.indexes.di, project.psr4Map);
      }
    }, 500);
  }

  allPatterns.push(...diTargets.patterns);
  unified.addHandler(createXmlWatcherHandler(
    {
      resolveContext: makeContextResolver(diTargets.contextMap,
        (file) => deriveDiXmlContext(file, project.root, project.modules)),
      parse: parseDiXml,
      onParsed(file, mtimeMs, result) {
        project.indexes.di.replaceFile(file, result.references, result.virtualTypes);
        project.cache.setDiEntry(file, mtimeMs, result.references, result.virtualTypes);
      },
      onRemoved(file) {
        project.indexes.di.removeFile(file);
        project.cache.removeEntry(file);
      },
      saveCache: debouncedCacheSave,
      afterChange: schedulePluginRebuild,
    },
    (fp) => fp.endsWith('/di.xml'),
  ));

  // --- events.xml handler ---
  const eventsH = buildTypedHandler(project, {
    section: 'eventsFiles',
    buildWatchTargets: () => buildModuleWatchTargets(
      project.modules, discoverEventsXmlFiles,
      (f, mod) => ({ file: f.file as string, area: f.area as string, module: mod.name }),
      (mod) => [path.join(mod.path, 'etc', '**', 'events.xml')],
    ),
    deriveContext: (file) => deriveEventsXmlContext(file, project.modules),
    parse: parseEventsXml,
    replaceInIndex: (file, r) => project.indexes.events.replaceFile(file, r.events, r.observers),
    removeFromIndex: (file) => project.indexes.events.removeFile(file),
  }, (fp) => fp.endsWith('/events.xml'), debouncedCacheSave);
  allPatterns.push(...eventsH.patterns);
  unified.addHandler(eventsH.handler);

  // --- webapi.xml handler ---
  const webapiH = buildTypedHandler(project, {
    section: 'webapiFiles',
    buildWatchTargets: () => buildModuleWatchTargets(
      project.modules, discoverWebapiXmlFiles,
      (f, mod) => ({ file: f.file as string, module: mod.name }),
      (mod) => [path.join(mod.path, 'etc', '**', 'webapi.xml')],
    ),
    deriveContext: (file) => deriveWebapiXmlContext(file, project.modules),
    parse: parseWebapiXml,
    replaceInIndex: (file, r) => project.indexes.webapi.replaceFile(file, r.references),
    removeFromIndex: (file) => project.indexes.webapi.removeFile(file),
  }, (fp) => fp.endsWith('/webapi.xml'), debouncedCacheSave);
  allPatterns.push(...webapiH.patterns);
  unified.addHandler(webapiH.handler);

  // --- acl.xml handler ---
  const aclH = buildTypedHandler(project, {
    section: 'aclFiles',
    buildWatchTargets: () => buildModuleWatchTargets(
      project.modules, discoverAclXmlFiles,
      (f, mod) => ({ file: f.file as string, module: mod.name }),
      (mod) => [path.join(mod.path, 'etc', 'acl.xml')],
    ),
    deriveContext: (file) => deriveAclXmlContext(file, project.modules),
    parse: parseAclXml,
    replaceInIndex: (file, r) => project.indexes.acl.replaceFile(file, r.resources),
    removeFromIndex: (file) => project.indexes.acl.removeFile(file),
  }, (fp) => fp.endsWith('/acl.xml'), debouncedCacheSave);
  allPatterns.push(...aclH.patterns);
  unified.addHandler(aclH.handler);

  // --- menu.xml handler ---
  const menuH = buildTypedHandler(project, {
    section: 'menuFiles',
    buildWatchTargets: () => buildModuleWatchTargets(
      project.modules, discoverMenuXmlFiles,
      (f, mod) => ({ file: f.file as string, module: mod.name }),
      (mod) => [path.join(mod.path, 'etc', 'adminhtml', 'menu.xml')],
    ),
    deriveContext: (file) => deriveMenuXmlContext(file, project.modules),
    parse: parseMenuXml,
    replaceInIndex: (file, r) => project.indexes.menu.replaceFile(file, r.references),
    removeFromIndex: (file) => project.indexes.menu.removeFile(file),
  }, (fp) => fp.endsWith('/menu.xml'), debouncedCacheSave);
  allPatterns.push(...menuH.patterns);
  unified.addHandler(menuH.handler);

  // --- routes.xml handler ---
  const routesH = buildTypedHandler(project, {
    section: 'routesFiles',
    buildWatchTargets: () => buildModuleWatchTargets(
      project.modules, discoverRoutesXmlFiles,
      (f, mod) => ({ file: f.file as string, module: mod.name, area: f.area as string }),
      (mod) => [path.join(mod.path, 'etc', '**', 'routes.xml')],
    ),
    deriveContext: (file) => deriveRoutesXmlContext(file, project.modules),
    parse: parseRoutesXml,
    replaceInIndex: (file, r) => project.indexes.routes.replaceFile(file, r.references),
    removeFromIndex: (file) => project.indexes.routes.removeFile(file),
  }, (fp) => fp.endsWith('/routes.xml'), debouncedCacheSave);
  allPatterns.push(...routesH.patterns);
  unified.addHandler(routesH.handler);

  // --- db_schema.xml handler ---
  const dbSchemaH = buildTypedHandler(project, {
    section: 'dbSchemaFiles',
    buildWatchTargets: () => buildModuleWatchTargets(
      project.modules, discoverDbSchemaXmlFiles,
      (f, mod) => ({ file: f.file as string, module: mod.name }),
      (mod) => [path.join(mod.path, 'etc', 'db_schema.xml')],
    ),
    deriveContext: (file) => deriveDbSchemaXmlContext(file, project.modules),
    parse: parseDbSchemaXml,
    replaceInIndex: (file, r) => project.indexes.dbSchema.replaceFile(file, r.references),
    removeFromIndex: (file) => project.indexes.dbSchema.removeFile(file),
  }, (fp) => fp.endsWith('/db_schema.xml'), debouncedCacheSave);
  allPatterns.push(...dbSchemaH.patterns);
  unified.addHandler(dbSchemaH.handler);

  // --- system.xml handler (must come after named XML types to avoid matching e.g. menu.xml) ---
  const systemH = buildTypedHandler(project, {
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
    replaceInIndex: (file, r) => project.indexes.systemConfig.replaceFile(file, r.references),
    removeFromIndex: (file) => project.indexes.systemConfig.removeFile(file),
  }, (fp) => fp.endsWith('/system.xml') || fp.includes('/etc/adminhtml/system/'), debouncedCacheSave);
  allPatterns.push(...systemH.patterns);
  unified.addHandler(systemH.handler);

  // --- UI component aclResource handler ---
  const uiAclH = buildTypedHandler(project, {
    section: 'uiComponentAclFiles',
    buildWatchTargets: () => buildModuleWatchTargets(
      project.modules, discoverUiComponentAclFiles,
      (f, mod) => ({ file: f.file as string, module: mod.name }),
      (mod) => [path.join(mod.path, 'view', 'adminhtml', 'ui_component', '*.xml')],
    ),
    deriveContext: (file) => deriveUiComponentAclContext(file, project.modules),
    parse: parseUiComponentAcl,
    replaceInIndex: (file, r) => project.indexes.uiComponentAcl.replaceFile(file, r.references),
    removeFromIndex: (file) => project.indexes.uiComponentAcl.removeFile(file),
  }, (fp) => fp.includes('/ui_component/') && fp.endsWith('.xml'), debouncedCacheSave);
  allPatterns.push(...uiAclH.patterns);
  unified.addHandler(uiAclH.handler);

  // --- layout XML handler (broad match — must come after named XML types) ---
  const layoutH = buildTypedHandler(project, {
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
    replaceInIndex: (file, r) => project.indexes.layout.replaceFile(file, r.references),
    removeFromIndex: (file) => project.indexes.layout.removeFile(file),
  }, (fp) => fp.endsWith('.xml') && (fp.includes('/layout/') || fp.includes('/page_layout/')), debouncedCacheSave);
  allPatterns.push(...layoutH.patterns);
  unified.addHandler(layoutH.handler);

  // --- .phtml template handler ---
  // Watch module template directories
  for (const mod of project.modules) {
    for (const area of ['frontend', 'adminhtml', 'base']) {
      allPatterns.push(path.join(mod.path, 'view', area, 'templates', '**', '*.phtml'));
    }
  }
  // Watch theme template directories
  for (const theme of project.themeResolver.getAllThemes()) {
    allPatterns.push(path.join(theme.path, '*', 'templates', '**', '*.phtml'));
  }
  unified.addHandler({
    matches: (fp) => fp.endsWith('.phtml'),
    onFileChange(filePath) {
      const entry = deriveTemplateEntry(filePath, project.modules, project.themeResolver);
      if (entry) {
        project.symbolIndex.removeTemplate(filePath);
        project.symbolIndex.addTemplate(entry);
      }
    },
    onFileRemove(filePath) {
      project.symbolIndex.removeTemplate(filePath);
    },
  });

  // --- PHP handler ---
  function invalidatePhpClass(filePath: string): void {
    const fqcn = resolveFileToFqcn(filePath, project.psr4Map);
    if (!fqcn) return;
    project.indexes.magicMethod.invalidateClass(fqcn);
    project.indexes.pluginMethod.invalidateHierarchy(fqcn);
  }

  for (const entry of project.psr4Map) {
    allPatterns.push(path.join(entry.path, '**', '*.php'));
  }
  unified.addHandler({
    matches: (fp) => fp.endsWith('.php'),
    onFileChange(filePath) {
      invalidatePhpClass(filePath);
      // Update symbol index with new/changed class
      const entry = deriveClassEntry(filePath, project.psr4Map);
      if (entry) {
        project.symbolIndex.addClass(entry, filePath);
      }
    },
    onFileRemove(filePath) {
      invalidatePhpClass(filePath);
      project.symbolIndex.removeClass(filePath);
    },
  });

  // Clear debounce timers when the watcher is closed during shutdown,
  // preventing callbacks from firing on a dead project context.
  unified.onClose(() => {
    if (cacheSaveTimer) { clearTimeout(cacheSaveTimer); cacheSaveTimer = undefined; }
    if (pluginRebuildTimer) { clearTimeout(pluginRebuildTimer); pluginRebuildTimer = undefined; }
  });

  // Start the single unified watcher
  unified.watch(allPatterns);
  watchers.push(unified);
  projectWatchers.set(project.root, unified);
}

// --- Shutdown ---

connection.onShutdown(() => {
  for (const w of watchers) {
    w.close();
  }
});

// Start listening on stdin/stdout
connection.listen();
