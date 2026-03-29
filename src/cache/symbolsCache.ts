/**
 * Disk cache for the PHP class and template symbol indexes.
 *
 * Stores scanned results in a separate JSON file (.magento2-lsp-symbols-cache.json)
 * from the main XML config cache. This keeps the two concerns separate and avoids
 * bloating the XML cache file with potentially 50k+ class entries.
 *
 * Cache validity is checked using hashes:
 *   - Class cache: hash of the PSR-4 map (prefixes + paths). If composer
 *     install/update changes the dependency tree, the hash changes and
 *     triggers a full rescan.
 *   - Template cache: hash of module paths + theme paths. If modules or
 *     themes change, templates are rescanned.
 *
 * Only raw data is cached (FQCNs, template IDs, areas, paths). Pre-computed
 * segments are recomputed on load (~100ms for 50k entries) to keep the
 * cache file smaller.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Psr4Map } from '../indexer/types';

/** Current cache format version. Bump to invalidate all existing caches. */
const SYMBOLS_CACHE_VERSION = 1;

/** Cache file name, stored in the Magento root directory. */
const CACHE_FILENAME = '.magento2-lsp-symbols-cache.json';

/** Raw template data stored in the cache (without pre-computed segments). */
export interface CachedTemplate {
  value: string;
  area: string;
  filePath: string;
}

/** The on-disk cache format. */
interface CacheFile {
  version: number;
  classes?: {
    hash: string;
    fqcns: string[];
  };
  templates?: {
    hash: string;
    entries: CachedTemplate[];
  };
}

/**
 * Compute a stable hash string from an array of key-value pairs.
 * Used to detect when the PSR-4 map or module/theme list has changed.
 */
function computeHash(data: string): string {
  return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * Compute a hash of the PSR-4 map for class cache invalidation.
 * Captures all namespace prefixes and their directory paths.
 */
export function computePsr4Hash(psr4Map: Psr4Map): string {
  const parts = psr4Map.map(e => `${e.prefix}:${e.path}`);
  return computeHash(parts.join('\n'));
}

/**
 * Compute a hash of module and theme paths for template cache invalidation.
 * Captures the set of directories that might contain templates.
 */
export function computeTemplateSourceHash(
  modulePaths: string[],
  themePaths: string[],
): string {
  const parts = [...modulePaths, '---', ...themePaths];
  return computeHash(parts.join('\n'));
}

/**
 * Disk cache for PHP class and template indexes.
 *
 * Usage:
 *   const cache = new SymbolsCache(magentoRoot);
 *   cache.load();
 *   const classes = cache.getClasses(psr4Hash);
 *   if (!classes) { /* rescan and cache.setClasses(...) *\/ }
 */
export class SymbolsCache {
  private cachePath: string;
  private data: CacheFile = { version: SYMBOLS_CACHE_VERSION };

  constructor(magentoRoot: string) {
    this.cachePath = path.join(magentoRoot, CACHE_FILENAME);
  }

  /**
   * Load cache from disk. Returns true if loaded successfully.
   * Returns false if the file doesn't exist, is unreadable, or has a
   * mismatched version (which means the format has changed).
   */
  load(): boolean {
    try {
      const raw = fs.readFileSync(this.cachePath, 'utf-8');
      const parsed = JSON.parse(raw) as CacheFile;

      if (parsed.version !== SYMBOLS_CACHE_VERSION) {
        // Version mismatch — discard the cache
        this.data = { version: SYMBOLS_CACHE_VERSION };
        return false;
      }

      this.data = parsed;
      return true;
    } catch {
      // File doesn't exist or is corrupt — start fresh
      this.data = { version: SYMBOLS_CACHE_VERSION };
      return false;
    }
  }

  /**
   * Save cache to disk. Silently ignores write errors.
   */
  save(): void {
    try {
      fs.writeFileSync(this.cachePath, JSON.stringify(this.data), 'utf-8');
    } catch {
      // Cache save is best-effort — errors are non-fatal
    }
  }

  /**
   * Get cached PHP class FQCNs if the PSR-4 hash matches.
   * Returns undefined if there's no cached data or the hash doesn't match
   * (meaning the dependency tree has changed and a rescan is needed).
   */
  getClasses(psr4Hash: string): string[] | undefined {
    if (this.data.classes && this.data.classes.hash === psr4Hash) {
      return this.data.classes.fqcns;
    }
    return undefined;
  }

  /**
   * Store PHP class FQCNs in the cache with their PSR-4 hash.
   */
  setClasses(psr4Hash: string, fqcns: string[]): void {
    this.data.classes = { hash: psr4Hash, fqcns };
  }

  /**
   * Get cached template entries if the source hash matches.
   * Returns undefined if there's no cached data or the hash doesn't match.
   */
  getTemplates(sourceHash: string): CachedTemplate[] | undefined {
    if (this.data.templates && this.data.templates.hash === sourceHash) {
      return this.data.templates.entries;
    }
    return undefined;
  }

  /**
   * Store template entries in the cache with their source hash.
   */
  setTemplates(sourceHash: string, entries: CachedTemplate[]): void {
    this.data.templates = { hash: sourceHash, entries };
  }
}
