/**
 * Disk-based cache for parsed XML index data.
 *
 * Stores parse results for di.xml, events.xml, and layout XML files, keyed by
 * file path with modification time (mtimeMs) for cache invalidation. On warm
 * startup, only files whose mtime has changed need to be re-parsed.
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
import { DiReference, VirtualTypeDecl, EventReference, ObserverReference, LayoutReference, SystemConfigReference } from '../indexer/types';

/** Bump this when entry formats change to invalidate old caches. */
const CACHE_VERSION = 5;
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

/** Top-level structure of the cache file on disk. */
export interface CacheFile {
  version: number;
  diFiles: Record<string, DiCacheEntry>;
  eventsFiles: Record<string, EventsCacheEntry>;
  layoutFiles: Record<string, LayoutCacheEntry>;
  systemConfigFiles: Record<string, SystemConfigCacheEntry>;
}

export class IndexCache {
  private cachePath: string;
  private data: CacheFile;

  constructor(magentoRoot: string) {
    this.cachePath = path.join(magentoRoot, CACHE_FILENAME);
    this.data = { version: CACHE_VERSION, diFiles: {}, eventsFiles: {}, layoutFiles: {}, systemConfigFiles: {} };
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
        this.data = { version: CACHE_VERSION, diFiles: {}, eventsFiles: {}, layoutFiles: {}, systemConfigFiles: {} };
        return false;
      }
      // Ensure all sections exist (forward-compat for caches without new sections)
      parsed.diFiles ??= {};
      parsed.eventsFiles ??= {};
      parsed.layoutFiles ??= {};
      parsed.systemConfigFiles ??= {};
      this.data = parsed;
      return true;
    } catch {
      this.data = { version: CACHE_VERSION, diFiles: {}, eventsFiles: {}, layoutFiles: {}, systemConfigFiles: {} };
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

  // --- di.xml ---

  getDiEntry(filePath: string, currentMtimeMs: number): DiCacheEntry | undefined {
    const entry = this.data.diFiles[filePath];
    return entry && entry.mtimeMs === currentMtimeMs ? entry : undefined;
  }

  setDiEntry(filePath: string, mtimeMs: number, refs: DiReference[], virtualTypes: VirtualTypeDecl[]): void {
    this.data.diFiles[filePath] = { mtimeMs, references: refs, virtualTypes };
  }

  // --- events.xml ---

  getEventsEntry(filePath: string, currentMtimeMs: number): EventsCacheEntry | undefined {
    const entry = this.data.eventsFiles[filePath];
    return entry && entry.mtimeMs === currentMtimeMs ? entry : undefined;
  }

  setEventsEntry(filePath: string, mtimeMs: number, events: EventReference[], observers: ObserverReference[]): void {
    this.data.eventsFiles[filePath] = { mtimeMs, events, observers };
  }

  // --- layout XML ---

  getLayoutEntry(filePath: string, currentMtimeMs: number): LayoutCacheEntry | undefined {
    const entry = this.data.layoutFiles[filePath];
    return entry && entry.mtimeMs === currentMtimeMs ? entry : undefined;
  }

  setLayoutEntry(filePath: string, mtimeMs: number, references: LayoutReference[]): void {
    this.data.layoutFiles[filePath] = { mtimeMs, references };
  }

  // --- Pruning ---

  /** Remove cache entries for files that no longer exist on disk. */
  pruneDiFiles(existingFiles: Set<string>): void {
    this.pruneSection(this.data.diFiles, existingFiles);
  }

  pruneEventsFiles(existingFiles: Set<string>): void {
    this.pruneSection(this.data.eventsFiles, existingFiles);
  }

  pruneLayoutFiles(existingFiles: Set<string>): void {
    this.pruneSection(this.data.layoutFiles, existingFiles);
  }

  private pruneSection(section: Record<string, unknown>, existingFiles: Set<string>): void {
    for (const filePath of Object.keys(section)) {
      if (!existingFiles.has(filePath)) {
        delete section[filePath];
      }
    }
  }

  /** Remove a single di.xml entry from the cache. */
  removeEntry(filePath: string): void {
    delete this.data.diFiles[filePath];
  }

  /** Remove a single events.xml entry from the cache. */
  removeEventsEntry(filePath: string): void {
    delete this.data.eventsFiles[filePath];
  }

  /** Remove a single layout XML entry from the cache. */
  removeLayoutEntry(filePath: string): void {
    delete this.data.layoutFiles[filePath];
  }

  // --- system.xml ---

  getSystemConfigEntry(filePath: string, currentMtimeMs: number): SystemConfigCacheEntry | undefined {
    const entry = this.data.systemConfigFiles[filePath];
    return entry && entry.mtimeMs === currentMtimeMs ? entry : undefined;
  }

  setSystemConfigEntry(filePath: string, mtimeMs: number, references: SystemConfigReference[]): void {
    this.data.systemConfigFiles[filePath] = { mtimeMs, references };
  }

  pruneSystemConfigFiles(existingFiles: Set<string>): void {
    this.pruneSection(this.data.systemConfigFiles, existingFiles);
  }

  /** Remove a single system.xml entry from the cache. */
  removeSystemConfigEntry(filePath: string): void {
    delete this.data.systemConfigFiles[filePath];
  }

  /** List all di.xml file paths that have cached entries. */
  getCachedFilePaths(): string[] {
    return Object.keys(this.data.diFiles);
  }
}
