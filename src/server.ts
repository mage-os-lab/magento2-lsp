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
import { handleWorkspaceSymbol } from './handlers/workspaceSymbol';
import { FileWatcher } from './watcher/fileWatcher';
import { discoverDiXmlFiles, discoverEventsXmlFiles } from './project/moduleResolver';
import { parseDiXml, DiXmlParseContext } from './indexer/diXmlParser';
import { parseEventsXml, EventsXmlParseContext } from './indexer/eventsXmlParser';
import { parseLayoutXml } from './indexer/layoutXmlParser';
import { realpath } from './utils/realpath';
import { validateXmlFile, isXmllintAvailable, invalidateCatalogCache } from './validation/xsdValidator';
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

connection.onReferences((params, token) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  return handleReferences(params, () => projectManager.getProjectForFile(filePath), token);
});

connection.onCodeLens((params, token) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  return handleCodeLens(params, () => projectManager.getProjectForFile(filePath), token);
});

connection.onHover((params, token) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  return handleHover(params, () => projectManager.getProjectForFile(filePath), token);
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
    if (xmllintEnabled && filePath.endsWith('.xml')) {
      validateAndPublish(params.textDocument.uri, params.textDocument.text, existing);
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
    if (xmllintEnabled && filePath.endsWith('.xml')) {
      validateAndPublish(params.textDocument.uri, params.textDocument.text, project);
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
): void {
  const existing = validationTimers.get(uri);
  if (existing) clearTimeout(existing);

  validationTimers.set(uri, setTimeout(async () => {
    validationTimers.delete(uri);
    try {
      const filePath = realpath(URI.parse(uri).fsPath);
      const diagnostics = await validateXmlFile(filePath, content, project.root, project.modules);
      connection.sendDiagnostics({ uri, diagnostics });
    } catch {
      // Don't let validation errors break the LSP
    }
  }, delayMs));
}

connection.onDidChangeTextDocument((params) => {
  if (!xmllintEnabled) return;
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  if (!filePath.endsWith('.xml')) return;
  const project = projectManager.getProjectForFile(filePath);
  if (!project) return;

  // contentChanges with Full sync contains the entire document as a single change
  const content = params.contentChanges[0]?.text;
  if (content !== undefined) {
    validateAndPublish(params.textDocument.uri, content, project, 1500);
  }
});

connection.onDidSaveTextDocument((params) => {
  if (!xmllintEnabled) return;
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  if (!filePath.endsWith('.xml')) return;
  const project = projectManager.getProjectForFile(filePath);
  if (!project) return;

  // Re-read file content on save
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    validateAndPublish(params.textDocument.uri, content, project);
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
    for (const mod of project.modules) {
      if (file.startsWith(mod.path)) {
        const relPath = path.relative(mod.path, file);
        const parts = relPath.split(path.sep);
        if (parts[0] === 'etc' && parts[parts.length - 1] === 'di.xml') {
          const area = parts.length === 2 ? 'global' : parts[1];
          const ctx: DiXmlParseContext = { file, area, module: mod.name, moduleOrder: mod.order };
          diContextMap.set(file, ctx);
          return ctx;
        }
      }
    }
    return undefined;
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

  const diWatcher = new FileWatcher({
    onFileChange(filePath) {
      const context = getDiContext(filePath);
      if (!context) return;
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const stat = fs.statSync(filePath);
        const result = parseDiXml(content, context);
        project.index.removeFile(filePath);
        project.index.addFile(filePath, result.references, result.virtualTypes);
        project.cache.setDiEntry(filePath, stat.mtimeMs, result.references, result.virtualTypes);
        project.cache.save();
        schedulePluginRebuild();
      } catch {
        // File might be temporarily unreadable during write
      }
    },
    onFileRemove(filePath) {
      project.index.removeFile(filePath);
      project.cache.removeEntry(filePath);
      project.cache.save();
      schedulePluginRebuild();
    },
  });
  diWatcher.watch(diWatchPatterns);
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
    for (const mod of project.modules) {
      if (file.startsWith(mod.path)) {
        const relPath = path.relative(mod.path, file);
        const parts = relPath.split(path.sep);
        if (parts[0] === 'etc' && parts[parts.length - 1] === 'events.xml') {
          const area = parts.length === 2 ? 'global' : parts[1];
          const ctx: EventsXmlParseContext = { file, area, module: mod.name };
          eventsContextMap.set(file, ctx);
          return ctx;
        }
      }
    }
    return undefined;
  }

  const eventsWatcher = new FileWatcher({
    onFileChange(filePath) {
      const context = getEventsContext(filePath);
      if (!context) return;
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const stat = fs.statSync(filePath);
        const result = parseEventsXml(content, context);
        project.eventsIndex.removeFile(filePath);
        project.eventsIndex.addFile(filePath, result.events, result.observers);
        project.cache.setEventsEntry(filePath, stat.mtimeMs, result.events, result.observers);
        project.cache.save();
      } catch {
        // File might be temporarily unreadable during write
      }
    },
    onFileRemove(filePath) {
      project.eventsIndex.removeFile(filePath);
      project.cache.removeEventsEntry(filePath);
      project.cache.save();
    },
  });
  eventsWatcher.watch(eventsWatchPatterns);
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

  const layoutWatcher = new FileWatcher({
    onFileChange(filePath) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const stat = fs.statSync(filePath);
        const result = parseLayoutXml(content, filePath);
        project.layoutIndex.removeFile(filePath);
        project.layoutIndex.addFile(filePath, result.references);
        project.cache.setLayoutEntry(filePath, stat.mtimeMs, result.references);
        project.cache.save();
      } catch {
        // File might be temporarily unreadable during write
      }
    },
    onFileRemove(filePath) {
      project.layoutIndex.removeFile(filePath);
      project.cache.removeLayoutEntry(filePath);
      project.cache.save();
    },
  });
  layoutWatcher.watch(layoutWatchPatterns);
  watchers.push(layoutWatcher);
}

// --- Shutdown ---

connection.onShutdown(() => {
  for (const w of watchers) {
    w.close();
  }
});

// Start listening on stdin/stdout
connection.listen();
