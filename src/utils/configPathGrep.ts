/**
 * Utilities for detecting and searching config path strings in PHP files.
 *
 * Provides:
 *   - A regex factory for matching scopeConfig->getValue('path') calls in PHP code
 *   - An on-demand grep for finding all PHP usages of a given config path
 *
 * The grep is async and done on demand rather than pre-indexed, since scanning
 * all PHP files for config path strings during startup would be too slow.
 */

import { execFile } from 'child_process';
import { Psr4Map } from '../indexer/types';

/**
 * Create a regex matching scopeConfig->getValue('config/path') and isSetFlag('config/path').
 * Captures the config path string (e.g., 'catalog/review/active') in group 1.
 *
 * Returns a fresh regex each call to avoid the shared /g lastIndex footgun —
 * callers can use it with exec() or matchAll() without worrying about stale state.
 */
export function createScopeConfigRegex(): RegExp {
  return /(?:scopeConfig|_scopeConfig)->(?:getValue|isSetFlag)\s*\(\s*['"]([a-zA-Z0-9_]+(?:\/[a-zA-Z0-9_]+)+)['"]/g;
}

export interface PhpConfigPathRef {
  file: string;
  line: number;
  column: number;
  endColumn: number;
}

/**
 * Search PHP files in the project for occurrences of a config path string literal.
 * Uses `grep` for speed. Returns position references suitable for LSP Location conversion.
 */
export async function grepConfigPathInPhp(
  configPath: string,
  projectRoot: string,
  psr4Map: Psr4Map,
): Promise<PhpConfigPathRef[]> {
  // Build search directories from PSR-4 map
  const searchDirs = new Set<string>();
  for (const entry of psr4Map) {
    searchDirs.add(entry.path);
  }

  const results: PhpConfigPathRef[] = [];

  const promises = [...searchDirs].map((dir) =>
    new Promise<void>((resolve) => {
      execFile(
        'grep',
        ['-rn', '--include=*.php', '-F', configPath, dir],
        { encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (stdout) {
            for (const line of stdout.split('\n')) {
              if (!line) continue;
              // Format: /path/to/file.php:42:    $this->scopeConfig->getValue('catalog/review/active')
              const match = line.match(/^(.+?):(\d+):(.*)$/);
              if (!match) continue;

              const [, file, lineNumStr, content] = match;
              const lineNum = parseInt(lineNumStr, 10) - 1; // Convert to 0-based
              const col = content.indexOf(configPath);
              if (col === -1) continue;

              results.push({
                file,
                line: lineNum,
                column: col,
                endColumn: col + configPath.length,
              });
            }
          }
          resolve();
        },
      );
    }),
  );

  await Promise.all(promises);
  return results;
}
