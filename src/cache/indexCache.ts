/**
 * Disk-based cache for parsed XML index data.
 *
 * Stores parse results for all Magento XML file types, keyed by file path with
 * modification time (mtimeMs) for cache invalidation. On warm startup, only
 * files whose mtime has changed need to be re-parsed.
 *
 * The cache is stored as JSON at {magentoRoot}/.magento2-lsp-cache.json.
 * It includes a version number so the cache is automatically invalidated when
 * the data format changes (bump CACHE_VERSION to force a full re-index).
 *
 * Cache operations are best-effort: if the cache can't be read or written,
 * the LSP continues working normally — it just re-parses everything.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DiReference, VirtualTypeDecl, EventReference, ObserverReference, LayoutReference, SystemConfigReference, WebapiReference, AclResource, MenuReference, UiComponentAclReference, RoutesReference, DbSchemaReference } from '../indexer/types';

/** Bump this when entry formats change to invalidate old caches. */
const CACHE_VERSION = 12;
const CACHE_FILENAME = '.magento2-lsp-cache.json';

/** Cached parse results for a single di.xml file. */
export interface DiCacheEntry {
  mtimeMs: number;
  references: DiReference[];
  virtualTypes: VirtualTypeDecl[];
}

/** Cached parse results for a single events.xml file. */
export interface EventsCacheEntry {
  mtimeMs: number;
  events: EventReference[];
  observers: ObserverReference[];
}

/** Cached parse results for a single layout/page_layout XML file. */
export interface LayoutCacheEntry {
  mtimeMs: number;
  references: LayoutReference[];
}

/** Cached parse results for a single system.xml (or include partial) file. */
export interface SystemConfigCacheEntry {
  mtimeMs: number;
  references: SystemConfigReference[];
}

/** Cached parse results for a single webapi.xml file. */
export interface WebapiCacheEntry {
  mtimeMs: number;
  references: WebapiReference[];
}

/** Cached parse results for a single acl.xml file. */
export interface AclCacheEntry {
  mtimeMs: number;
  resources: AclResource[];
}

/** Cached parse results for a single menu.xml file. */
export interface MenuCacheEntry {
  mtimeMs: number;
  references: MenuReference[];
}

/** Cached parse results for a single routes.xml file. */
export interface RoutesCacheEntry {
  mtimeMs: number;
  references: RoutesReference[];
}

/** Cached parse results for a single db_schema.xml file. */
export interface DbSchemaCacheEntry {
  mtimeMs: number;
  references: DbSchemaReference[];
}

/** Cached parse results for a single UI component XML file (aclResource only). */
export interface UiComponentAclCacheEntry {
  mtimeMs: number;
  references: UiComponentAclReference[];
}

/** Top-level structure of the cache file on disk. */
export interface CacheFile {
  version: number;
  diFiles: Record<string, DiCacheEntry>;
  eventsFiles: Record<string, EventsCacheEntry>;
  layoutFiles: Record<string, LayoutCacheEntry>;
  systemConfigFiles: Record<string, SystemConfigCacheEntry>;
  webapiFiles: Record<string, WebapiCacheEntry>;
  aclFiles: Record<string, AclCacheEntry>;
  menuFiles: Record<string, MenuCacheEntry>;
  uiComponentAclFiles: Record<string, UiComponentAclCacheEntry>;
  routesFiles: Record<string, RoutesCacheEntry>;
  dbSchemaFiles: Record<string, DbSchemaCacheEntry>;
}

/** Keys of CacheFile that hold per-file data sections (everything except 'version'). */
export type CacheSectionKey = Exclude<keyof CacheFile, 'version'>;

const SECTION_KEYS: CacheSectionKey[] = [
  'diFiles', 'eventsFiles', 'layoutFiles', 'systemConfigFiles',
  'webapiFiles', 'aclFiles', 'menuFiles', 'uiComponentAclFiles',
  'routesFiles', 'dbSchemaFiles',
];

function createEmptyData(): CacheFile {
  return {
    version: CACHE_VERSION,
    diFiles: {}, eventsFiles: {}, layoutFiles: {}, systemConfigFiles: {},
    webapiFiles: {}, aclFiles: {}, menuFiles: {}, uiComponentAclFiles: {},
    routesFiles: {}, dbSchemaFiles: {},
  };
}

export class IndexCache {
  private cachePath: string;
  private data: CacheFile;

  constructor(magentoRoot: string) {
    this.cachePath = path.join(magentoRoot, CACHE_FILENAME);
    this.data = createEmptyData();
  }

  /**
   * Load the cache from disk. Returns true if a valid cache was loaded,
   * false if the file doesn't exist, is corrupted, or has a version mismatch.
   */
  load(): boolean {
    try {
      const raw = fs.readFileSync(this.cachePath, 'utf-8');
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed.version !== CACHE_VERSION) {
        this.data = createEmptyData();
        return false;
      }
      // Ensure all sections exist (forward-compat for caches without new sections)
      for (const key of SECTION_KEYS) {
        (parsed as unknown as Record<string, unknown>)[key] ??= {};
      }
      this.data = parsed;
      return true;
    } catch {
      this.data = createEmptyData();
      return false;
    }
  }

  /** Write the cache to disk. Fails silently — the cache is optional. */
  save(): void {
    try {
      fs.writeFileSync(this.cachePath, JSON.stringify(this.data), 'utf-8');
    } catch {
      // Silently fail — cache is a performance optimization, not required
    }
  }

  // --- Generic section accessors ---

  /** Return a cached entry if its mtime matches, otherwise undefined. */
  getEntry<T extends { mtimeMs: number }>(section: CacheSectionKey, filePath: string, currentMtimeMs: number): T | undefined {
    const sectionData = this.data[section] as unknown as Record<string, T>;
    const entry = sectionData[filePath];
    return entry && entry.mtimeMs === currentMtimeMs ? entry : undefined;
  }

  /** Store a cache entry for a file in the given section. */
  setEntry(section: CacheSectionKey, filePath: string, entry: Record<string, unknown> & { mtimeMs: number }): void {
    (this.data[section] as unknown as Record<string, unknown>)[filePath] = entry;
  }

  /** Remove cached entries for files not in the given set. */
  pruneEntries(section: CacheSectionKey, existingFiles: Set<string>): void {
    const sectionData = this.data[section] as unknown as Record<string, unknown>;
    for (const filePath of Object.keys(sectionData)) {
      if (!existingFiles.has(filePath)) {
        delete sectionData[filePath];
      }
    }
  }

  /** Remove a single entry from a cache section. */
  removeFromSection(section: CacheSectionKey, filePath: string): void {
    delete (this.data[section] as unknown as Record<string, unknown>)[filePath];
  }

  // --- DI-specific convenience methods (used by tests) ---

  getDiEntry(filePath: string, currentMtimeMs: number): DiCacheEntry | undefined {
    return this.getEntry<DiCacheEntry>('diFiles', filePath, currentMtimeMs);
  }

  setDiEntry(filePath: string, mtimeMs: number, refs: DiReference[], virtualTypes: VirtualTypeDecl[]): void {
    this.setEntry('diFiles', filePath, { mtimeMs, references: refs, virtualTypes });
  }

  pruneDiFiles(existingFiles: Set<string>): void {
    this.pruneEntries('diFiles', existingFiles);
  }

  /** Remove a single di.xml entry from the cache. */
  removeEntry(filePath: string): void {
    this.removeFromSection('diFiles', filePath);
  }

  /** List all di.xml file paths that have cached entries. */
  getCachedFilePaths(): string[] {
    return Object.keys(this.data.diFiles);
  }
}
