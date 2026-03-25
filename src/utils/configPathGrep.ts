/**
 * On-demand grep for config path strings in PHP files.
 *
 * Used by the references handler to find PHP usages of a system.xml config path
 * (e.g., scopeConfig->getValue('catalog/review/active')).
 *
 * This is an async search done on demand rather than pre-indexed, since
 * scanning all PHP files for config path strings during startup would be too slow.
 */

import { exec } from 'child_process';
import { Psr4Map } from '../indexer/types';

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

  // Shell-escape the config path for safe use in the grep command
  const escaped = configPath.replace(/'/g, "'\\''");

  const promises = [...searchDirs].map((dir) =>
    new Promise<void>((resolve) => {
      exec(
        `grep -rn --include='*.php' -F '${escaped}' '${dir}' 2>/dev/null || true`,
        { encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (!err && stdout) {
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
