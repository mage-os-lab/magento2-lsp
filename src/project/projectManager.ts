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
  discoverWebapiXmlFiles,
  discoverAclXmlFiles,
  discoverMenuXmlFiles,
  discoverUiComponentAclFiles,
  discoverRoutesXmlFiles,
  discoverDbSchemaXmlFiles,
} from './moduleResolver';
import { buildPsr4Map } from './composerAutoload';
import { ThemeResolver } from './themeResolver';
import { DiIndex } from '../index/diIndex';
import { EventsIndex } from '../index/eventsIndex';
import { LayoutIndex } from '../index/layoutIndex';
import { IndexCache, CacheSectionKey } from '../cache/indexCache';
import { parseDiXml } from '../indexer/diXmlParser';
import { parseEventsXml } from '../indexer/eventsXmlParser';
import { parseLayoutXml } from '../indexer/layoutXmlParser';
import { PluginMethodIndex } from '../index/pluginMethodIndex';
import { MagicMethodIndex } from '../index/magicMethodIndex';
import { CompatModuleIndex } from '../index/compatModuleIndex';
import { SystemConfigIndex } from '../index/systemConfigIndex';
import { WebapiIndex } from '../index/webapiIndex';
import { AclIndex } from '../index/aclIndex';
import { MenuIndex } from '../index/menuIndex';
import { UiComponentAclIndex } from '../index/uiComponentAclIndex';
import { RoutesIndex } from '../index/routesIndex';
import { DbSchemaIndex } from '../index/dbSchemaIndex';
import { parseCompatModuleRegistrations } from '../indexer/compatModuleParser';
import { parseSystemXml } from '../indexer/systemXmlParser';
import { parseWebapiXml } from '../indexer/webapiXmlParser';
import { parseAclXml } from '../indexer/aclXmlParser';
import { parseMenuXml } from '../indexer/menuXmlParser';
import { parseUiComponentAcl } from '../indexer/uiComponentAclParser';
import { parseRoutesXml } from '../indexer/routesXmlParser';
import { parseDbSchemaXml } from '../indexer/dbSchemaXmlParser';
import { ModuleInfo, Psr4Map } from '../indexer/types';
import { fileExists } from '../utils/fsHelpers';
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
  /** Lazy index for resolving magic method calls (__call, @method). */
  magicMethodIndex: MagicMethodIndex;
  /** In-memory events/observer index for this project. */
  eventsIndex: EventsIndex;
  /** In-memory layout XML index (block classes, templates, argument objects). */
  layoutIndex: LayoutIndex;
  /** Theme discovery and template fallback resolution. */
  themeResolver: ThemeResolver;
  /** Hyvä compatibility module registrations (automatic template overrides). */
  compatModuleIndex: CompatModuleIndex;
  /** In-memory system.xml config path index for this project. */
  systemConfigIndex: SystemConfigIndex;
  /** In-memory webapi.xml route/service index for this project. */
  webapiIndex: WebapiIndex;
  /** In-memory acl.xml resource definition index for this project. */
  aclIndex: AclIndex;
  /** In-memory menu.xml ACL resource reference index for this project. */
  menuIndex: MenuIndex;
  /** In-memory UI component ACL resource reference index for this project. */
  uiComponentAclIndex: UiComponentAclIndex;
  /** In-memory routes.xml route/module index for this project. */
  routesIndex: RoutesIndex;
  /** In-memory db_schema.xml table/column/FK index for this project. */
  dbSchemaIndex: DbSchemaIndex;
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

/**
 * Generic helper for the "stat → cache check → parse → index update → cache set" loop.
 *
 * Each XML index type follows the same lifecycle during project initialization:
 *   1. Check if the file has a valid cache entry (matching mtimeMs)
 *   2. If cached, feed the cached result directly to the index
 *   3. If not cached, read + parse the file, feed result to index, and update the cache
 *   4. After all files, prune stale cache entries
 *
 * The caller prepares the file list (with parse contexts) and provides callbacks for
 * how to add results to the specific index type.
 */
function indexXmlFiles<TCtx, TResult>(
  files: { file: string; context: TCtx }[],
  cache: IndexCache,
  section: CacheSectionKey,
  parse: (content: string, ctx: TCtx) => TResult,
  addToIndex: (file: string, result: TResult) => void,
): void {
  for (const { file, context } of files) {
    try {
      const stat = fs.statSync(file);
      const cached = cache.getEntry<TResult & { mtimeMs: number }>(section, file, stat.mtimeMs);
      if (cached) {
        addToIndex(file, cached);
      } else {
        const content = fs.readFileSync(file, 'utf-8');
        const result = parse(content, context);
        addToIndex(file, result);
        cache.setEntry(section, file, { mtimeMs: stat.mtimeMs, ...result as Record<string, unknown> });
      }
    } catch {
      // Skip unreadable files
    }
  }
  cache.pruneEntries(section, new Set(files.map((f) => f.file)));
}

export class ProjectManager {
  /** Keyed by Magento root path. */
  private projects = new Map<string, ProjectContext>();
  /** In-flight initialization promises, keyed by root path. Prevents duplicate indexing. */
  private initializing = new Map<string, Promise<ProjectContext>>();
  /** Cache: directory path → detected Magento root (null = no root found). */
  private rootCache = new Map<string, string | null>();

  /**
   * Cached wrapper around detectMagentoRoot. Once a directory is resolved, the result
   * is cached for that directory and all intermediate ancestors up to the root.
   * This avoids repeated fs.accessSync walks on every LSP request.
   */
  private cachedDetectRoot(dir: string): string | undefined {
    const cached = this.rootCache.get(dir);
    if (cached !== undefined) return cached ?? undefined;

    const root = detectMagentoRoot(dir);
    if (root) {
      // Cache the queried dir and every intermediate directory up to the root
      let current = dir;
      while (current !== root && current !== path.dirname(current)) {
        this.rootCache.set(current, root);
        current = path.dirname(current);
      }
      this.rootCache.set(root, root);
    } else {
      this.rootCache.set(dir, null);
    }
    return root;
  }

  /**
   * Look up the project for a given file. Returns undefined if the file is not within
   * any known Magento project, or if the project hasn't been initialized yet.
   * This is a synchronous lookup — it does NOT trigger initialization.
   */
  getProjectForFile(filePath: string): ProjectContext | undefined {
    const root = this.cachedDetectRoot(path.dirname(filePath));
    if (!root) return undefined;
    return this.projects.get(root);
  }

  /**
   * Ensure a project is initialized for the given file path.
   * If this is the first time we've seen this Magento root, performs full initialization
   * (discover modules, parse di.xml files, build index). Otherwise returns the existing context.
   *
   * If initialization is already in progress for this root (e.g., triggered by opening
   * another file from the same project), the existing promise is returned to avoid
   * duplicate indexing passes.
   */
  async ensureProject(
    filePath: string,
    progress?: ProgressCallback,
  ): Promise<ProjectContext | undefined> {
    let isDir: boolean;
    try {
      isDir = fs.statSync(filePath).isDirectory();
    } catch {
      return undefined;
    }
    const root = this.cachedDetectRoot(isDir ? filePath : path.dirname(filePath));
    if (!root) return undefined;

    const existing = this.projects.get(root);
    if (existing) return existing;

    const inflight = this.initializing.get(root);
    if (inflight) return inflight;

    const promise = this.initializeProject(root, progress);
    this.initializing.set(root, promise);
    try {
      const project = await promise;
      this.projects.set(root, project);
      return project;
    } finally {
      this.initializing.delete(root);
    }
  }

  /**
   * Full project initialization:
   *   1. Parse config.php for active modules and their load order
   *   2. Build PSR-4 map from composer's installed.json + app/code
   *   3. Load the disk cache (if available)
   *   4. Discover and index all XML file types (using cache where possible)
   *   5. Save the updated cache
   */
  private async initializeProject(
    root: string,
    progress?: ProgressCallback,
  ): Promise<ProjectContext> {
    const t0 = Date.now();

    const modules = resolveActiveModules(root);
    const psr4Map = buildPsr4Map(root);

    const index = new DiIndex();
    const cache = new IndexCache(root);
    cache.load();

    // --- Index di.xml files (special: batch mode + progress reporting) ---
    const diXmlFiles: { file: string; context: { file: string; area: string; module: string; moduleOrder: number } }[] = [];

    const rootDiXml = path.join(root, 'app', 'etc', 'di.xml');
    if (fileExists(rootDiXml)) {
      diXmlFiles.push({ file: rootDiXml, context: { file: rootDiXml, area: 'global', module: '__root__', moduleOrder: -1 } });
    }

    for (const mod of modules) {
      for (const f of discoverDiXmlFiles(mod.path)) {
        diXmlFiles.push({ file: f.file, context: { file: f.file, area: f.area, module: mod.name, moduleOrder: mod.order } });
      }
    }

    progress?.onBegin(diXmlFiles.length);

    index.beginBatch();
    try {
      for (let i = 0; i < diXmlFiles.length; i++) {
        const { file, context } = diXmlFiles[i];
        progress?.onProgress(i + 1, diXmlFiles.length, file);
        try {
          const stat = fs.statSync(file);
          const cached = cache.getDiEntry(file, stat.mtimeMs);
          if (cached) {
            index.addFile(file, cached.references, cached.virtualTypes);
          } else {
            const content = fs.readFileSync(file, 'utf-8');
            const result = parseDiXml(content, context);
            index.addFile(file, result.references, result.virtualTypes);
            cache.setDiEntry(file, stat.mtimeMs, result.references, result.virtualTypes);
          }
        } catch {
          // Skip files that can't be read
        }
      }
    } finally {
      index.endBatch();
    }
    cache.pruneDiFiles(new Set(diXmlFiles.map((f) => f.file)));

    // --- Index events.xml files ---
    const eventsIndex = new EventsIndex();
    const eventsFiles: { file: string; context: { file: string; area: string; module: string } }[] = [];
    for (const mod of modules) {
      for (const f of discoverEventsXmlFiles(mod.path)) {
        eventsFiles.push({ file: f.file, context: { file: f.file, area: f.area, module: mod.name } });
      }
    }
    indexXmlFiles(eventsFiles, cache, 'eventsFiles', parseEventsXml,
      (file, r) => eventsIndex.addFile(file, r.events, r.observers));

    // --- Index system.xml files ---
    const systemConfigIndex = new SystemConfigIndex();
    const systemFiles: { file: string; context: { file: string; module: string } }[] = [];
    for (const mod of modules) {
      const mainFile = path.join(mod.path, 'etc', 'adminhtml', 'system.xml');
      const systemDir = path.join(mod.path, 'etc', 'adminhtml', 'system');
      const filesToIndex = [
        ...(fileExists(mainFile) ? [mainFile] : []),
        ...listXmlFilesRecursive(systemDir),
      ];
      for (const xmlFile of filesToIndex) {
        systemFiles.push({ file: xmlFile, context: { file: xmlFile, module: mod.name } });
      }
    }
    indexXmlFiles(systemFiles, cache, 'systemConfigFiles', parseSystemXml,
      (file, r) => systemConfigIndex.addFile(file, r.references));

    // --- Index webapi.xml files ---
    const webapiIndex = new WebapiIndex();
    const webapiFiles: { file: string; context: { file: string; module: string } }[] = [];
    for (const mod of modules) {
      for (const f of discoverWebapiXmlFiles(mod.path)) {
        webapiFiles.push({ file: f.file, context: { file: f.file, module: mod.name } });
      }
    }
    indexXmlFiles(webapiFiles, cache, 'webapiFiles', parseWebapiXml,
      (file, r) => webapiIndex.addFile(file, r.references));

    // --- Index acl.xml files ---
    const aclIndex = new AclIndex();
    const aclFiles: { file: string; context: { file: string; module: string } }[] = [];
    for (const mod of modules) {
      for (const f of discoverAclXmlFiles(mod.path)) {
        aclFiles.push({ file: f.file, context: { file: f.file, module: mod.name } });
      }
    }
    indexXmlFiles(aclFiles, cache, 'aclFiles', parseAclXml,
      (file, r) => aclIndex.addFile(file, r.resources));

    // --- Index menu.xml files ---
    const menuIndex = new MenuIndex();
    const menuFiles: { file: string; context: { file: string; module: string } }[] = [];
    for (const mod of modules) {
      for (const f of discoverMenuXmlFiles(mod.path)) {
        menuFiles.push({ file: f.file, context: { file: f.file, module: mod.name } });
      }
    }
    indexXmlFiles(menuFiles, cache, 'menuFiles', parseMenuXml,
      (file, r) => menuIndex.addFile(file, r.references));

    // --- Index UI component aclResource files ---
    const uiComponentAclIndex = new UiComponentAclIndex();
    const uiFiles: { file: string; context: { file: string; module: string } }[] = [];
    for (const mod of modules) {
      for (const f of discoverUiComponentAclFiles(mod.path)) {
        uiFiles.push({ file: f.file, context: { file: f.file, module: mod.name } });
      }
    }
    indexXmlFiles(uiFiles, cache, 'uiComponentAclFiles', parseUiComponentAcl,
      (file, r) => uiComponentAclIndex.addFile(file, r.references));

    // --- Index routes.xml files ---
    const routesIndex = new RoutesIndex();
    const routesFiles: { file: string; context: { file: string; module: string; area: string } }[] = [];
    for (const mod of modules) {
      for (const f of discoverRoutesXmlFiles(mod.path)) {
        routesFiles.push({ file: f.file, context: { file: f.file, module: mod.name, area: f.area } });
      }
    }
    indexXmlFiles(routesFiles, cache, 'routesFiles', parseRoutesXml,
      (file, r) => routesIndex.addFile(file, r.references));

    // --- Index db_schema.xml files ---
    const dbSchemaIndex = new DbSchemaIndex();
    const dbSchemaFiles: { file: string; context: { file: string; module: string } }[] = [];
    for (const mod of modules) {
      for (const f of discoverDbSchemaXmlFiles(mod.path)) {
        dbSchemaFiles.push({ file: f.file, context: { file: f.file, module: mod.name } });
      }
    }
    indexXmlFiles(dbSchemaFiles, cache, 'dbSchemaFiles', parseDbSchemaXml,
      (file, r) => dbSchemaIndex.addFile(file, r.references));

    // --- Discover themes and index layout XML files ---
    const themeResolver = new ThemeResolver();
    themeResolver.discover(root);

    const layoutIndex = new LayoutIndex();
    const layoutFiles: { file: string; context: string }[] = [];

    for (const mod of modules) {
      for (const subdir of ['layout', 'page_layout']) {
        for (const area of ['frontend', 'adminhtml', 'base']) {
          for (const xmlFile of listXmlFiles(path.join(mod.path, 'view', area, subdir))) {
            layoutFiles.push({ file: xmlFile, context: xmlFile });
          }
        }
      }
    }
    for (const theme of themeResolver.getAllThemes()) {
      try {
        const entries = fs.readdirSync(theme.path);
        for (const entry of entries) {
          if (!entry.includes('_')) continue;
          for (const subdir of ['layout', 'page_layout']) {
            for (const xmlFile of listXmlFiles(path.join(theme.path, entry, subdir))) {
              layoutFiles.push({ file: xmlFile, context: xmlFile });
            }
          }
        }
      } catch {
        // Theme dir unreadable
      }
    }
    indexXmlFiles(layoutFiles, cache, 'layoutFiles',
      (content, filePath) => parseLayoutXml(content, filePath),
      (file, r) => layoutIndex.addFile(file, r.references));

    // --- Discover Hyvä compat module registrations ---
    const compatModuleIndex = new CompatModuleIndex();
    for (const mod of modules) {
      const frontendDiXml = path.join(mod.path, 'etc', 'frontend', 'di.xml');
      try {
        const content = fs.readFileSync(frontendDiXml, 'utf-8');
        const mappings = parseCompatModuleRegistrations(content);
        for (const mapping of mappings) {
          const compatMod = modules.find((m) => m.name === mapping.compatModule);
          if (compatMod) {
            compatModuleIndex.addMapping(mapping.originalModule, mapping.compatModule, compatMod.path);
          }
        }
      } catch {
        // No frontend/di.xml or unreadable — skip
      }
    }

    // Build the plugin method index
    const pluginMethodIndex = new PluginMethodIndex();
    pluginMethodIndex.build(index, psr4Map);

    // Save cache once (covers all indexed XML types)
    cache.save();

    const totalFiles = diXmlFiles.length + eventsFiles.length + systemFiles.length
      + webapiFiles.length + aclFiles.length + menuFiles.length
      + uiFiles.length + routesFiles.length + dbSchemaFiles.length
      + layoutFiles.length;
    console.error(`[magento2-lsp] Indexed ${modules.length} modules, ${totalFiles} XML files in ${Date.now() - t0}ms`);

    progress?.onEnd();

    return {
      root,
      modules,
      psr4Map,
      index,
      pluginMethodIndex,
      magicMethodIndex: new MagicMethodIndex(),
      eventsIndex,
      layoutIndex,
      themeResolver,
      compatModuleIndex,
      systemConfigIndex,
      webapiIndex,
      aclIndex,
      menuIndex,
      uiComponentAclIndex,
      routesIndex,
      dbSchemaIndex,
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
    for (const [dir, cachedRoot] of this.rootCache) {
      if (cachedRoot === root) {
        this.rootCache.delete(dir);
      }
    }
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

/** List all .xml files in a directory recursively. Returns empty array if dir doesn't exist. */
function listXmlFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...listXmlFilesRecursive(fullPath));
      } else if (entry.name.endsWith('.xml')) {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist or is unreadable
  }
  return results;
}
