/**
 * Scan the filesystem to discover all PHP classes and derive their FQCNs
 * using PSR-4 autoload mappings.
 *
 * This scanner walks directories registered in the PSR-4 map, finds .php files,
 * and converts file paths to FQCNs without opening the files. This is possible
 * because PSR-4 mandates a 1:1 mapping between namespace structure and directory
 * structure.
 *
 * Exclusions:
 *   - generated/code/ — Magento's generated proxies, factories, etc.
 *   - setup/ — Magento setup scripts (not useful for DI completion)
 */

import * as fs from 'fs';
import * as path from 'path';
import { Psr4Map } from './types';
import { resolveFileToFqcn } from './phpClassLocator';
import { computeCharMask, segmentizeFqcn } from '../matching/segmentation';
import { ClassEntry } from '../matching/types';
import { yieldToEventLoop } from '../utils/async';

/**
 * Path patterns to exclude from scanning.
 * These directories contain generated or non-relevant PHP files.
 */
const EXCLUDED_PATTERNS = [
  '/generated/code/',
  '/setup/',
];

/**
 * Check if a file path should be excluded from scanning.
 */
function isExcluded(filePath: string): boolean {
  return EXCLUDED_PATTERNS.some(pattern => filePath.includes(pattern));
}

/**
 * Recursively collect all .php file paths under a directory.
 *
 * Uses readdirSync with withFileTypes for performance (avoids extra stat calls).
 * Skips excluded directories early to avoid walking large irrelevant trees.
 *
 * @param dir - Directory to walk.
 * @param results - Accumulator array for file paths.
 */
function collectPhpFiles(dir: string, results: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // Directory doesn't exist or isn't readable
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip excluded directories before recursing into them
      if (!isExcluded(fullPath + '/')) {
        collectPhpFiles(fullPath, results);
      }
    } else if (entry.name.endsWith('.php')) {
      results.push(fullPath);
    }
  }
}

/**
 * Scan all PSR-4 directories and build ClassEntry objects for each .php file found.
 *
 * This is the synchronous version, suitable for use in tests or when the event
 * loop doesn't need to be kept responsive.
 *
 * @param psr4Map - The PSR-4 namespace-to-directory mappings.
 * @returns Array of ClassEntry objects with pre-computed segments.
 */
export function scanPhpClasses(psr4Map: Psr4Map): ClassEntry[] {
  const entries: ClassEntry[] = [];
  const seenPaths = new Set<string>();

  for (const psr4Entry of psr4Map) {
    // Skip excluded base directories
    if (isExcluded(psr4Entry.path + '/')) continue;

    const phpFiles: string[] = [];
    collectPhpFiles(psr4Entry.path, phpFiles);

    for (const filePath of phpFiles) {
      // Avoid duplicate entries when PSR-4 paths overlap
      if (seenPaths.has(filePath)) continue;
      seenPaths.add(filePath);

      const fqcn = resolveFileToFqcn(filePath, psr4Map);
      if (fqcn) {
        entries.push({
          value: fqcn,
          segments: segmentizeFqcn(fqcn),
          charMask: computeCharMask(fqcn),
        });
      }
    }
  }

  return entries;
}

/**
 * Async version of scanPhpClasses that yields to the event loop periodically.
 *
 * Used during project initialization to keep the LSP server responsive while
 * scanning potentially tens of thousands of PHP files.
 *
 * @param psr4Map - The PSR-4 namespace-to-directory mappings.
 * @returns Promise resolving to an array of ClassEntry objects.
 */
export async function scanPhpClassesAsync(psr4Map: Psr4Map): Promise<ClassEntry[]> {
  const entries: ClassEntry[] = [];
  const seenPaths = new Set<string>();
  let fileCount = 0;

  for (const psr4Entry of psr4Map) {
    if (isExcluded(psr4Entry.path + '/')) continue;

    const phpFiles: string[] = [];
    collectPhpFiles(psr4Entry.path, phpFiles);

    for (const filePath of phpFiles) {
      if (seenPaths.has(filePath)) continue;
      seenPaths.add(filePath);

      const fqcn = resolveFileToFqcn(filePath, psr4Map);
      if (fqcn) {
        entries.push({
          value: fqcn,
          segments: segmentizeFqcn(fqcn),
          charMask: computeCharMask(fqcn),
        });
      }

      // Yield every 50 files to let the event loop process incoming LSP requests
      fileCount++;
      if (fileCount % 50 === 0) {
        await yieldToEventLoop();
      }
    }
  }

  return entries;
}

/**
 * Derive a ClassEntry for a single PHP file.
 *
 * Used by file watchers when a new .php file is created or modified.
 *
 * @param filePath - Absolute path to the .php file.
 * @param psr4Map - The PSR-4 namespace-to-directory mappings.
 * @returns A ClassEntry, or undefined if the file doesn't match any PSR-4 prefix
 *          or is in an excluded directory.
 */
export function deriveClassEntry(filePath: string, psr4Map: Psr4Map): ClassEntry | undefined {
  if (isExcluded(filePath)) return undefined;

  const fqcn = resolveFileToFqcn(filePath, psr4Map);
  if (!fqcn) return undefined;

  return {
    value: fqcn,
    segments: segmentizeFqcn(fqcn),
    charMask: computeCharMask(fqcn),
  };
}
