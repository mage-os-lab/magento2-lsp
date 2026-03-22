/**
 * Manages per-project state for the LSP.
 *
 * A single LSP server instance can serve files from multiple Magento projects simultaneously
 * (e.g., different workspace folders or files opened from different project roots). Each
 * project gets its own isolated ProjectContext with its own index, cache, module list, etc.
 *
 * Projects are initialized lazily: the first time a file from a new Magento root is opened,
 * the ProjectManager detects the root, parses config.php, discovers all di.xml files,
 * and builds the index. Subsequent files from the same root reuse the existing context.
 */

import { detectMagentoRoot } from './detector';
import {
  resolveActiveModules,
  discoverDiXmlFiles,
  discoverEventsXmlFiles,
} from './moduleResolver';
import { buildPsr4Map } from './composerAutoload';
import { ThemeResolver } from './themeResolver';
import { DiIndex } from '../index/diIndex';
import { EventsIndex } from '../index/eventsIndex';
import { LayoutIndex } from '../index/layoutIndex';
import { IndexCache } from '../cache/indexCache';
import { parseDiXml } from '../indexer/diXmlParser';
import { parseEventsXml } from '../indexer/eventsXmlParser';
import { parseLayoutXml } from '../indexer/layoutXmlParser';
import { PluginMethodIndex } from '../index/pluginMethodIndex';
import { ModuleInfo, Psr4Map } from '../indexer/types';
import * as fs from 'fs';
import * as path from 'path';

/** All the state associated with a single Magento project. */
export interface ProjectContext {
  /** Absolute path to the Magento root directory. */
  root: string;
  /** Active modules from config.php, in load order. */
  modules: ModuleInfo[];
  /** PSR-4 namespace-to-path mappings for resolving FQCNs to PHP files. */
  psr4Map: Psr4Map;
  /** In-memory DI index for this project. */
  index: DiIndex;
  /** Maps target class methods to their plugin interceptions (for code lens + references). */
  pluginMethodIndex: PluginMethodIndex;
  /** In-memory events/observer index for this project. */
  eventsIndex: EventsIndex;
  /** In-memory layout XML index (block classes, templates, argument objects). */
  layoutIndex: LayoutIndex;
  /** Theme discovery and template fallback resolution. */
  themeResolver: ThemeResolver;
  /** Disk cache for this project's parse results. */
  cache: IndexCache;
  /** True once the initial indexing pass is complete. */
  indexingComplete: boolean;
}

/** Callback interface for reporting indexing progress to the LSP client (editor). */
export interface ProgressCallback {
  onBegin(total: number): void;
  onProgress(current: number, total: number, file: string): void;
  onEnd(): void;
}

export class ProjectManager {
  /** Keyed by Magento root path. */
  private projects = new Map<string, ProjectContext>();

  /**
   * Look up the project for a given file. Returns undefined if the file is not within
   * any known Magento project, or if the project hasn't been initialized yet.
   * This is a synchronous lookup — it does NOT trigger initialization.
   */
  getProjectForFile(filePath: string): ProjectContext | undefined {
    const root = detectMagentoRoot(path.dirname(filePath));
    if (!root) return undefined;
    return this.projects.get(root);
  }

  /**
   * Ensure a project is initialized for the given file path.
   * If this is the first time we've seen this Magento root, performs full initialization
   * (discover modules, parse di.xml files, build index). Otherwise returns the existing context.
   */
  async ensureProject(
    filePath: string,
    progress?: ProgressCallback,
  ): Promise<ProjectContext | undefined> {
    const root = detectMagentoRoot(
      fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath),
    );
    if (!root) return undefined;

    const existing = this.projects.get(root);
    if (existing) return existing;

    const project = await this.initializeProject(root, progress);
    this.projects.set(root, project);
    return project;
  }

  /**
   * Full project initialization:
   *   1. Parse config.php for active modules and their load order
   *   2. Build PSR-4 map from composer's installed.json + app/code
   *   3. Load the disk cache (if available)
   *   4. Discover all di.xml files from active modules
   *   5. Parse each file (or use cached results if mtime hasn't changed)
   *   6. Save the updated cache
   */
  private async initializeProject(
    root: string,
    progress?: ProgressCallback,
  ): Promise<ProjectContext> {
    const modules = resolveActiveModules(root);
    const psr4Map = buildPsr4Map(root);
    const index = new DiIndex();
    const cache = new IndexCache(root);
    cache.load();

    // Discover all di.xml files to index
    const diXmlFiles: { file: string; area: string; module: string; moduleOrder: number }[] = [];

    // The root app/etc/di.xml contains framework-level preferences.
    // It uses moduleOrder -1 because it's loaded before any module.
    const rootDiXml = path.join(root, 'app', 'etc', 'di.xml');
    if (fileExists(rootDiXml)) {
      diXmlFiles.push({ file: rootDiXml, area: 'global', module: '__root__', moduleOrder: -1 });
    }

    // Per-module di.xml files (global + area-scoped)
    for (const mod of modules) {
      const files = discoverDiXmlFiles(mod.path);
      for (const f of files) {
        diXmlFiles.push({
          file: f.file,
          area: f.area,
          module: mod.name,
          moduleOrder: mod.order,
        });
      }
    }

    const total = diXmlFiles.length;
    progress?.onBegin(total);

    // Index each file, using cached parse results when the file hasn't changed
    for (let i = 0; i < diXmlFiles.length; i++) {
      const { file, area, module: moduleName, moduleOrder } = diXmlFiles[i];
      progress?.onProgress(i + 1, total, file);

      try {
        const stat = fs.statSync(file);
        const cached = cache.getCachedEntry(file, stat.mtimeMs);

        if (cached) {
          // Cache hit — use stored parse results (much faster than re-parsing)
          index.addFile(file, cached.references, cached.virtualTypes);
        } else {
          // Cache miss — parse the file and update the cache
          const content = fs.readFileSync(file, 'utf-8');
          const result = parseDiXml(content, {
            file,
            area,
            module: moduleName,
            moduleOrder,
          });
          index.addFile(file, result.references, result.virtualTypes);
          cache.setCachedEntry(
            file,
            stat.mtimeMs,
            result.references,
            result.virtualTypes,
          );
        }
      } catch {
        // Skip files that can't be read (permissions, broken symlinks, etc.)
      }
    }

    // Remove cache entries for files that no longer exist (deleted modules, etc.)
    cache.pruneDeletedFiles(new Set(diXmlFiles.map((f) => f.file)));
    cache.save();

    // --- Index events.xml files ---
    const eventsIndex = new EventsIndex();
    for (const mod of modules) {
      const eventsFiles = discoverEventsXmlFiles(mod.path);
      for (const f of eventsFiles) {
        try {
          const content = fs.readFileSync(f.file, 'utf-8');
          const result = parseEventsXml(content, {
            file: f.file,
            area: f.area,
            module: mod.name,
          });
          eventsIndex.addFile(f.file, result.events, result.observers);
        } catch {
          // Skip unreadable files
        }
      }
    }

    // --- Discover themes and index layout XML files ---
    const themeResolver = new ThemeResolver();
    themeResolver.discover(root);

    const layoutIndex = new LayoutIndex();

    // Index module layout and page_layout files
    for (const mod of modules) {
      for (const subdir of ['layout', 'page_layout']) {
        for (const area of ['frontend', 'adminhtml', 'base']) {
          const dir = path.join(mod.path, 'view', area, subdir);
          for (const xmlFile of listXmlFiles(dir)) {
            try {
              const content = fs.readFileSync(xmlFile, 'utf-8');
              const result = parseLayoutXml(content, xmlFile);
              layoutIndex.addFile(xmlFile, result.references);
            } catch {
              // Skip unreadable files
            }
          }
        }
      }
    }

    // Index theme layout and page_layout files
    for (const theme of themeResolver.getAllThemes()) {
      try {
        const entries = fs.readdirSync(theme.path);
        for (const entry of entries) {
          // Theme directories are named after modules: Magento_Catalog, Hyva_Theme, etc.
          if (!entry.includes('_')) continue;
          for (const subdir of ['layout', 'page_layout']) {
            const dir = path.join(theme.path, entry, subdir);
            for (const xmlFile of listXmlFiles(dir)) {
              try {
                const content = fs.readFileSync(xmlFile, 'utf-8');
                const result = parseLayoutXml(content, xmlFile);
                layoutIndex.addFile(xmlFile, result.references);
              } catch {
                // Skip unreadable files
              }
            }
          }
        }
      } catch {
        // Theme dir unreadable
      }
    }

    // Build the plugin method index: maps target class methods to their plugin interceptions.
    const pluginMethodIndex = new PluginMethodIndex();
    pluginMethodIndex.build(index, psr4Map);

    progress?.onEnd();

    return {
      root,
      modules,
      psr4Map,
      index,
      pluginMethodIndex,
      eventsIndex,
      layoutIndex,
      themeResolver,
      cache,
      indexingComplete: true,
    };
  }

  getProject(root: string): ProjectContext | undefined {
    return this.projects.get(root);
  }

  getAllProjects(): ProjectContext[] {
    return Array.from(this.projects.values());
  }

  removeProject(root: string): void {
    this.projects.delete(root);
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** List all .xml files in a directory (non-recursive). Returns empty array if dir doesn't exist. */
function listXmlFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.xml'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}
