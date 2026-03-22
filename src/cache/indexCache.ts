/**
 * Disk-based cache for the DI index.
 *
 * Parsing ~600 di.xml files on every LSP startup takes 2-3 seconds. This cache stores
 * the parse results (references + virtualTypes) keyed by file path, along with each
 * file's modification time (mtimeMs). On subsequent startups, only files whose mtime
 * has changed need to be re-parsed — bringing warm startup down to <100ms.
 *
 * The cache is stored as JSON at {magentoRoot}/.magento2-lsp-cache.json.
 * It includes a version number so the cache is automatically invalidated when the
 * data format changes (bump CACHE_VERSION to force a full re-index).
 *
 * Cache operations are best-effort: if the cache can't be read or written (e.g.,
 * permission issues), the LSP continues working normally — it just re-parses everything.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DiReference, VirtualTypeDecl } from '../indexer/types';

/** Bump this when the DiReference/VirtualTypeDecl format changes to invalidate old caches. */
const CACHE_VERSION = 1;
const CACHE_FILENAME = '.magento2-lsp-cache.json';

/** Cached parse results for a single di.xml file. */
export interface CacheFileEntry {
  /** File modification time at the time of parsing. Used to detect changes. */
  mtimeMs: number;
  references: DiReference[];
  virtualTypes: VirtualTypeDecl[];
}

/** Top-level structure of the cache file on disk. */
export interface CacheFile {
  version: number;
  /** Keyed by absolute di.xml file path. */
  files: Record<string, CacheFileEntry>;
}

export class IndexCache {
  private cachePath: string;
  private data: CacheFile;

  constructor(magentoRoot: string) {
    this.cachePath = path.join(magentoRoot, CACHE_FILENAME);
    this.data = { version: CACHE_VERSION, files: {} };
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
        // Version mismatch — discard the entire cache
        this.data = { version: CACHE_VERSION, files: {} };
        return false;
      }
      this.data = parsed;
      return true;
    } catch {
      this.data = { version: CACHE_VERSION, files: {} };
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

  /**
   * Get a cached entry if the file hasn't been modified since it was cached.
   * Returns undefined if the file isn't cached or its mtime has changed.
   */
  getCachedEntry(filePath: string, currentMtimeMs: number): CacheFileEntry | undefined {
    const entry = this.data.files[filePath];
    if (entry && entry.mtimeMs === currentMtimeMs) {
      return entry;
    }
    return undefined;
  }

  /** Store parse results for a file, along with its current mtime. */
  setCachedEntry(filePath: string, mtimeMs: number, refs: DiReference[], virtualTypes: VirtualTypeDecl[]): void {
    this.data.files[filePath] = { mtimeMs, references: refs, virtualTypes };
  }

  /** Remove a single file from the cache (e.g., when the file is deleted). */
  removeEntry(filePath: string): void {
    delete this.data.files[filePath];
  }

  /**
   * Remove cache entries for files that no longer exist on disk.
   * Called after indexing to clean up stale entries from deleted/moved files.
   */
  pruneDeletedFiles(existingFiles: Set<string>): void {
    for (const filePath of Object.keys(this.data.files)) {
      if (!existingFiles.has(filePath)) {
        delete this.data.files[filePath];
      }
    }
  }

  /** List all file paths that have cached entries. */
  getCachedFilePaths(): string[] {
    return Object.keys(this.data.files);
  }
}
