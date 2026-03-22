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
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  WorkDoneProgressBegin,
  WorkDoneProgressReport,
  WorkDoneProgressEnd,
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { SERVER_CAPABILITIES } from './capabilities';
import { ProjectManager } from './project/projectManager';
import { handleDefinition } from './handlers/definition';
import { handleReferences } from './handlers/references';
import { handleCodeLens } from './handlers/codeLens';
import { FileWatcher } from './watcher/fileWatcher';
import { discoverDiXmlFiles } from './project/moduleResolver';
import { DiXmlParseContext } from './indexer/diXmlParser';
import { realpath } from './utils/realpath';
import * as path from 'path';

const connection = createConnection(ProposedFeatures.all);
const projectManager = new ProjectManager();
const watchers: FileWatcher[] = [];

function log(msg: string): void {
  process.stderr.write(`[magento2-lsp] ${msg}\n`);
}

// --- LSP lifecycle ---

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  log('onInitialize');
  return { capabilities: SERVER_CAPABILITIES };
});

connection.onInitialized(async () => {
  // No eager initialization — projects are set up lazily in onDidOpenTextDocument.
});

// --- LSP feature handlers ---

connection.onDefinition((params) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  const project = projectManager.getProjectForFile(filePath);
  log(`onDefinition: ${filePath} line=${params.position.line} col=${params.position.character} project=${project?.root ?? 'NONE'} indexedFiles=${project?.index.getFileCount() ?? 0}`);
  if (project) {
    const ref = project.index.getReferenceAtPosition(filePath, params.position.line, params.position.character);
    log(`  ref at position: ${ref ? `${ref.kind} ${ref.fqcn} col=${ref.column}-${ref.endColumn}` : 'NONE'}`);
  }
  return handleDefinition(params, () => project);
});

connection.onReferences((params) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  return handleReferences(params, () => projectManager.getProjectForFile(filePath));
});

connection.onCodeLens((params) => {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  return handleCodeLens(params, () => projectManager.getProjectForFile(filePath));
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
        connection.sendProgress<WorkDoneProgressBegin>(
          { method: 'progress' } as any,
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
        connection.sendProgress<WorkDoneProgressReport>(
          { method: 'progress' } as any,
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
        connection.sendProgress<WorkDoneProgressEnd>(
          { method: 'progress' } as any,
          token,
          { kind: 'end', message: 'Done' },
        );
      } catch {
        // Ignore progress reporting errors
      }
    },
  });

  log(`  project initialized: ${project?.root ?? 'NONE'} (${project?.index.getFileCount() ?? 0} files)`);

  // --- Set up file watcher for automatic re-indexing ---

  if (project) {
    const watchPatterns: string[] = [];
    // Maps known di.xml paths to their parse context (area, module, moduleOrder)
    const contextMap = new Map<string, DiXmlParseContext>();

    // Register all known di.xml files from active modules
    for (const mod of project.modules) {
      const files = discoverDiXmlFiles(mod.path);
      for (const f of files) {
        watchPatterns.push(f.file);
        contextMap.set(f.file, {
          file: f.file,
          area: f.area,
          module: mod.name,
          moduleOrder: mod.order,
        });
      }
    }

    // Watch the root app/etc/di.xml separately (not part of any module)
    const rootDiXml = path.join(project.root, 'app', 'etc', 'di.xml');
    watchPatterns.push(rootDiXml);
    contextMap.set(rootDiXml, {
      file: rootDiXml,
      area: 'global',
      module: '__root__',
      moduleOrder: -1,
    });

    // Also watch for new di.xml files that might be added to modules
    for (const mod of project.modules) {
      watchPatterns.push(path.join(mod.path, 'etc', '**', 'di.xml'));
    }

    const watcher = new FileWatcher({
      index: project.index,
      cache: project.cache,
      getContext: (file) => {
        // First check the pre-built map of known files
        const cached = contextMap.get(file);
        if (cached) return cached;

        // For newly added di.xml files, determine the context from the file path.
        // Path structure: {modulePath}/etc/di.xml (global) or {modulePath}/etc/{area}/di.xml
        for (const mod of project.modules) {
          if (file.startsWith(mod.path)) {
            const relPath = path.relative(mod.path, file);
            const parts = relPath.split(path.sep);
            if (parts[0] === 'etc' && parts[parts.length - 1] === 'di.xml') {
              const area = parts.length === 2 ? 'global' : parts[1];
              const ctx: DiXmlParseContext = {
                file,
                area,
                module: mod.name,
                moduleOrder: mod.order,
              };
              contextMap.set(file, ctx);
              return ctx;
            }
          }
        }
        return undefined;
      },
    });

    watcher.watch(watchPatterns);
    watchers.push(watcher);
  }
});

// --- Shutdown ---

connection.onShutdown(() => {
  for (const w of watchers) {
    w.close();
  }
});

// Start listening on stdin/stdout
connection.listen();
