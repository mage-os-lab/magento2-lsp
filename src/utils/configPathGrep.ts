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

/**
 * Search PHP files for multiple config path strings in batched grep calls.
 * Combines paths into single grep invocations (using multiple -e flags) to reduce
 * process spawning overhead. Processes batches with a configurable concurrency limit.
 *
 * Returns a Map from config path -> matching references.
 */
export async function grepConfigPathsInPhp(
  configPaths: string[],
  projectRoot: string,
  psr4Map: Psr4Map,
  concurrency: number = 4,
): Promise<Map<string, PhpConfigPathRef[]>> {
  const searchDirs = new Set<string>();
  for (const entry of psr4Map) {
    searchDirs.add(entry.path);
  }
  const dirs = [...searchDirs];

  const results = new Map<string, PhpConfigPathRef[]>();
  for (const p of configPaths) results.set(p, []);

  if (configPaths.length === 0) return results;

  // Process in chunks of `concurrency` paths per grep call
  for (let i = 0; i < configPaths.length; i += concurrency) {
    const batch = configPaths.slice(i, i + concurrency);
    const args = ['-rn', '--include=*.php', '-F'];
    for (const p of batch) {
      args.push('-e', p);
    }

    const dirPromises = dirs.map((dir) =>
      new Promise<void>((resolve) => {
        execFile(
          'grep',
          [...args, dir],
          { encoding: 'utf-8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
          (err, stdout) => {
            if (stdout) {
              for (const line of stdout.split('\n')) {
                if (!line) continue;
                const match = line.match(/^(.+?):(\d+):(.*)$/);
                if (!match) continue;

                const [, file, lineNumStr, content] = match;
                const lineNum = parseInt(lineNumStr, 10) - 1;
                // Determine which path(s) in the batch matched this line
                for (const configPath of batch) {
                  const col = content.indexOf(configPath);
                  if (col !== -1) {
                    results.get(configPath)!.push({
                      file,
                      line: lineNum,
                      column: col,
                      endColumn: col + configPath.length,
                    });
                  }
                }
              }
            }
            resolve();
          },
        );
      }),
    );
    await Promise.all(dirPromises);
  }

  return results;
}
