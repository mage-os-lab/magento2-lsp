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
import { ProjectManager } from './project/projectManager';
import { handleDefinition } from './handlers/definition';
import { handleReferences } from './handlers/references';
import { handleCodeLens } from './handlers/codeLens';
import { handleHover } from './handlers/hover';
import { handleDocumentSymbol } from './handlers/documentSymbol';
import { handleWorkspaceSymbol } from './handlers/workspaceSymbol';
import { FileWatcher, createXmlWatcher } from './watcher/fileWatcher';
import {
  discoverDiXmlFiles,
  discoverEventsXmlFiles,
  discoverWebapiXmlFiles,
  discoverAclXmlFiles,
  discoverMenuXmlFiles,
  discoverRoutesXmlFiles,
  discoverUiComponentAclFiles,
  deriveDiXmlContext,
  deriveEventsXmlContext,
  deriveSystemXmlContext,
  deriveWebapiXmlContext,
  deriveAclXmlContext,
  deriveMenuXmlContext,
  deriveRoutesXmlContext,
  deriveUiComponentAclContext,
} from './project/moduleResolver';
import { parseDiXml, DiXmlParseContext } from './indexer/diXmlParser';
import { parseEventsXml, EventsXmlParseContext } from './indexer/eventsXmlParser';
import { parseLayoutXml } from './indexer/layoutXmlParser';
import { parseSystemXml, SystemXmlParseContext } from './indexer/systemXmlParser';
import { parseWebapiXml, WebapiXmlParseContext } from './indexer/webapiXmlParser';
import { parseAclXml, AclXmlParseContext } from './indexer/aclXmlParser';
import { parseMenuXml, MenuXmlParseContext } from './indexer/menuXmlParser';
import { parseRoutesXml, RoutesXmlParseContext } from './indexer/routesXmlParser';
import { parseUiComponentAcl, UiComponentAclParseContext } from './indexer/uiComponentAclParser';
import { resolveFileToFqcn } from './indexer/phpClassLocator';
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
  project: import('./project/projectManager').ProjectContext,
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

function setupFileWatchers(project: import('./project/projectManager').ProjectContext): void {
  // --- di.xml watcher ---
  const diWatchPatterns: string[] = [];
  const diContextMap = new Map<string, DiXmlParseContext>();

  for (const mod of project.modules) {
    const files = discoverDiXmlFiles(mod.path);
    for (const f of files) {
      diWatchPatterns.push(f.file);
      diContextMap.set(f.file, {
        file: f.file,
        area: f.area,
        module: mod.name,
        moduleOrder: mod.order,
      });
    }
    // Also watch for new di.xml files
    diWatchPatterns.push(path.join(mod.path, 'etc', '**', 'di.xml'));
  }

  const rootDiXml = path.join(project.root, 'app', 'etc', 'di.xml');
  diWatchPatterns.push(rootDiXml);
  diContextMap.set(rootDiXml, {
    file: rootDiXml,
    area: 'global',
    module: '__root__',
    moduleOrder: -1,
  });

  function getDiContext(file: string): DiXmlParseContext | undefined {
    const cached = diContextMap.get(file);
    if (cached) return cached;
    const ctx = deriveDiXmlContext(file, project.root, project.modules);
    if (ctx) diContextMap.set(file, ctx);
    return ctx;
  }

  // Debounced rebuild of PluginMethodIndex after di.xml changes.
  // Avoids thrashing during rapid edits while keeping plugin data fresh.
  let pluginRebuildTimer: ReturnType<typeof setTimeout> | undefined;
  function schedulePluginRebuild(): void {
    if (pluginRebuildTimer) clearTimeout(pluginRebuildTimer);
    pluginRebuildTimer = setTimeout(() => {
      project.pluginMethodIndex.build(project.index, project.psr4Map);
    }, 500);
  }

  const diWatcher = createXmlWatcher({
    patterns: diWatchPatterns,
    resolveContext: getDiContext,
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
  });
  watchers.push(diWatcher);

  // --- events.xml watcher ---
  const eventsWatchPatterns: string[] = [];
  const eventsContextMap = new Map<string, EventsXmlParseContext>();

  for (const mod of project.modules) {
    const files = discoverEventsXmlFiles(mod.path);
    for (const f of files) {
      eventsWatchPatterns.push(f.file);
      eventsContextMap.set(f.file, { file: f.file, area: f.area, module: mod.name });
    }
    // Also watch for new events.xml files
    eventsWatchPatterns.push(path.join(mod.path, 'etc', '**', 'events.xml'));
  }

  function getEventsContext(file: string): EventsXmlParseContext | undefined {
    const cached = eventsContextMap.get(file);
    if (cached) return cached;
    const ctx = deriveEventsXmlContext(file, project.modules);
    if (ctx) eventsContextMap.set(file, ctx);
    return ctx;
  }

  const eventsWatcher = createXmlWatcher({
    patterns: eventsWatchPatterns,
    resolveContext: getEventsContext,
    parse: parseEventsXml,
    onParsed(file, mtimeMs, result) {
      project.eventsIndex.removeFile(file);
      project.eventsIndex.addFile(file, result.events, result.observers);
      project.cache.setEventsEntry(file, mtimeMs, result.events, result.observers);
    },
    onRemoved(file) {
      project.eventsIndex.removeFile(file);
      project.cache.removeEventsEntry(file);
    },
    saveCache: () => project.cache.save(),
  });
  watchers.push(eventsWatcher);

  // --- layout XML watcher ---
  const layoutWatchPatterns: string[] = [];

  for (const mod of project.modules) {
    for (const subdir of ['layout', 'page_layout']) {
      for (const area of ['frontend', 'adminhtml', 'base']) {
        layoutWatchPatterns.push(path.join(mod.path, 'view', area, subdir, '*.xml'));
      }
    }
  }
  for (const theme of project.themeResolver.getAllThemes()) {
    layoutWatchPatterns.push(path.join(theme.path, '*', 'layout', '*.xml'));
    layoutWatchPatterns.push(path.join(theme.path, '*', 'page_layout', '*.xml'));
  }

  const layoutWatcher = createXmlWatcher<string, { references: import('./indexer/types').LayoutReference[] }>({
    patterns: layoutWatchPatterns,
    resolveContext: (file) => file,
    parse: (content, filePath) => parseLayoutXml(content, filePath),
    onParsed(file, mtimeMs, result) {
      project.layoutIndex.removeFile(file);
      project.layoutIndex.addFile(file, result.references);
      project.cache.setLayoutEntry(file, mtimeMs, result.references);
    },
    onRemoved(file) {
      project.layoutIndex.removeFile(file);
      project.cache.removeLayoutEntry(file);
    },
    saveCache: () => project.cache.save(),
  });
  watchers.push(layoutWatcher);

  // --- system.xml watcher ---
  const systemConfigWatchPatterns: string[] = [];
  const systemConfigContextMap = new Map<string, SystemXmlParseContext>();

  for (const mod of project.modules) {
    const mainFile = path.join(mod.path, 'etc', 'adminhtml', 'system.xml');
    systemConfigWatchPatterns.push(mainFile);
    systemConfigContextMap.set(mainFile, { file: mainFile, module: mod.name });
    // Watch for include partials
    systemConfigWatchPatterns.push(path.join(mod.path, 'etc', 'adminhtml', 'system', '**', '*.xml'));
  }

  function getSystemConfigContext(file: string): SystemXmlParseContext | undefined {
    const cached = systemConfigContextMap.get(file);
    if (cached) return cached;
    const ctx = deriveSystemXmlContext(file, project.modules);
    if (ctx) systemConfigContextMap.set(file, ctx);
    return ctx;
  }

  const systemConfigWatcher = createXmlWatcher({
    patterns: systemConfigWatchPatterns,
    resolveContext: getSystemConfigContext,
    parse: parseSystemXml,
    onParsed(file, mtimeMs, result) {
      project.systemConfigIndex.removeFile(file);
      project.systemConfigIndex.addFile(file, result.references);
      project.cache.setSystemConfigEntry(file, mtimeMs, result.references);
    },
    onRemoved(file) {
      project.systemConfigIndex.removeFile(file);
      project.cache.removeSystemConfigEntry(file);
    },
    saveCache: () => project.cache.save(),
  });
  watchers.push(systemConfigWatcher);

  // --- webapi.xml watcher ---
  const webapiWatchPatterns: string[] = [];
  const webapiContextMap = new Map<string, WebapiXmlParseContext>();

  for (const mod of project.modules) {
    const files = discoverWebapiXmlFiles(mod.path);
    for (const f of files) {
      webapiWatchPatterns.push(f.file);
      webapiContextMap.set(f.file, { file: f.file, module: mod.name });
    }
    // Also watch for new webapi.xml files
    webapiWatchPatterns.push(path.join(mod.path, 'etc', '**', 'webapi.xml'));
  }

  function getWebapiContext(file: string): WebapiXmlParseContext | undefined {
    const cached = webapiContextMap.get(file);
    if (cached) return cached;
    const ctx = deriveWebapiXmlContext(file, project.modules);
    if (ctx) webapiContextMap.set(file, ctx);
    return ctx;
  }

  const webapiWatcher = createXmlWatcher({
    patterns: webapiWatchPatterns,
    resolveContext: getWebapiContext,
    parse: parseWebapiXml,
    onParsed(file, mtimeMs, result) {
      project.webapiIndex.removeFile(file);
      project.webapiIndex.addFile(file, result.references);
      project.cache.setWebapiEntry(file, mtimeMs, result.references);
    },
    onRemoved(file) {
      project.webapiIndex.removeFile(file);
      project.cache.removeWebapiEntry(file);
    },
    saveCache: () => project.cache.save(),
  });
  watchers.push(webapiWatcher);

  // --- acl.xml watcher ---
  const aclWatchPatterns: string[] = [];
  const aclContextMap = new Map<string, AclXmlParseContext>();

  for (const mod of project.modules) {
    const files = discoverAclXmlFiles(mod.path);
    for (const f of files) {
      aclWatchPatterns.push(f.file);
      aclContextMap.set(f.file, { file: f.file, module: mod.name });
    }
    // Also watch for new acl.xml files
    aclWatchPatterns.push(path.join(mod.path, 'etc', 'acl.xml'));
  }

  function getAclContext(file: string): AclXmlParseContext | undefined {
    const cached = aclContextMap.get(file);
    if (cached) return cached;
    const ctx = deriveAclXmlContext(file, project.modules);
    if (ctx) aclContextMap.set(file, ctx);
    return ctx;
  }

  const aclWatcher = createXmlWatcher({
    patterns: aclWatchPatterns,
    resolveContext: getAclContext,
    parse: parseAclXml,
    onParsed(file, mtimeMs, result) {
      project.aclIndex.removeFile(file);
      project.aclIndex.addFile(file, result.resources);
      project.cache.setAclEntry(file, mtimeMs, result.resources);
    },
    onRemoved(file) {
      project.aclIndex.removeFile(file);
      project.cache.removeAclEntry(file);
    },
    saveCache: () => project.cache.save(),
  });
  watchers.push(aclWatcher);

  // --- menu.xml watcher ---
  const menuWatchPatterns: string[] = [];
  const menuContextMap = new Map<string, MenuXmlParseContext>();

  for (const mod of project.modules) {
    const files = discoverMenuXmlFiles(mod.path);
    for (const f of files) {
      menuWatchPatterns.push(f.file);
      menuContextMap.set(f.file, { file: f.file, module: mod.name });
    }
    menuWatchPatterns.push(path.join(mod.path, 'etc', 'adminhtml', 'menu.xml'));
  }

  function getMenuContext(file: string): MenuXmlParseContext | undefined {
    const cached = menuContextMap.get(file);
    if (cached) return cached;
    const ctx = deriveMenuXmlContext(file, project.modules);
    if (ctx) menuContextMap.set(file, ctx);
    return ctx;
  }

  const menuWatcher = createXmlWatcher({
    patterns: menuWatchPatterns,
    resolveContext: getMenuContext,
    parse: parseMenuXml,
    onParsed(file, mtimeMs, result) {
      project.menuIndex.removeFile(file);
      project.menuIndex.addFile(file, result.references);
      project.cache.setMenuEntry(file, mtimeMs, result.references);
    },
    onRemoved(file) {
      project.menuIndex.removeFile(file);
      project.cache.removeMenuEntry(file);
    },
    saveCache: () => project.cache.save(),
  });
  watchers.push(menuWatcher);

  // --- routes.xml watcher ---
  const routesWatchPatterns: string[] = [];
  const routesContextMap = new Map<string, RoutesXmlParseContext>();

  for (const mod of project.modules) {
    const files = discoverRoutesXmlFiles(mod.path);
    for (const f of files) {
      routesWatchPatterns.push(f.file);
      routesContextMap.set(f.file, { file: f.file, module: mod.name, area: f.area });
    }
    routesWatchPatterns.push(path.join(mod.path, 'etc', '**', 'routes.xml'));
  }

  function getRoutesContext(file: string): RoutesXmlParseContext | undefined {
    const cached = routesContextMap.get(file);
    if (cached) return cached;
    const ctx = deriveRoutesXmlContext(file, project.modules);
    if (ctx) routesContextMap.set(file, ctx);
    return ctx;
  }

  const routesWatcher = createXmlWatcher({
    patterns: routesWatchPatterns,
    resolveContext: getRoutesContext,
    parse: parseRoutesXml,
    onParsed(file, mtimeMs, result) {
      project.routesIndex.removeFile(file);
      project.routesIndex.addFile(file, result.references);
      project.cache.setRoutesEntry(file, mtimeMs, result.references);
    },
    onRemoved(file) {
      project.routesIndex.removeFile(file);
      project.cache.removeRoutesEntry(file);
    },
    saveCache: () => project.cache.save(),
  });
  watchers.push(routesWatcher);

  // --- UI component aclResource watcher ---
  const uiComponentWatchPatterns: string[] = [];
  const uiComponentContextMap = new Map<string, UiComponentAclParseContext>();

  for (const mod of project.modules) {
    const files = discoverUiComponentAclFiles(mod.path);
    for (const f of files) {
      uiComponentWatchPatterns.push(f.file);
      uiComponentContextMap.set(f.file, { file: f.file, module: mod.name });
    }
    uiComponentWatchPatterns.push(path.join(mod.path, 'view', 'adminhtml', 'ui_component', '*.xml'));
  }

  function getUiComponentContext(file: string): UiComponentAclParseContext | undefined {
    const cached = uiComponentContextMap.get(file);
    if (cached) return cached;
    const ctx = deriveUiComponentAclContext(file, project.modules);
    if (ctx) uiComponentContextMap.set(file, ctx);
    return ctx;
  }

  const uiComponentWatcher = createXmlWatcher({
    patterns: uiComponentWatchPatterns,
    resolveContext: getUiComponentContext,
    parse: parseUiComponentAcl,
    onParsed(file, mtimeMs, result) {
      project.uiComponentAclIndex.removeFile(file);
      project.uiComponentAclIndex.addFile(file, result.references);
      project.cache.setUiComponentAclEntry(file, mtimeMs, result.references);
    },
    onRemoved(file) {
      project.uiComponentAclIndex.removeFile(file);
      project.cache.removeUiComponentAclEntry(file);
    },
    saveCache: () => project.cache.save(),
  });
  watchers.push(uiComponentWatcher);

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
