/**
 * Utilities for detecting and searching ACL resource strings in PHP files.
 *
 * Provides:
 *   - A regex factory for matching PHP ACL resource patterns:
 *     - `const ADMIN_RESOURCE = 'Vendor_Module::resource'` (admin controller constant)
 *     - `->isAllowed('Vendor_Module::resource')` (authorization check)
 *   - An on-demand grep for finding all PHP usages of a given ACL resource ID
 *
 * The grep is async and done on demand rather than pre-indexed, since scanning
 * all PHP files for ACL resource strings during startup would be too slow.
 * This mirrors the approach used by configPathGrep.ts for config path strings.
 */

import { exec } from 'child_process';
import { Psr4Map } from '../indexer/types';

/**
 * Create a regex matching PHP ACL resource patterns.
 * Captures the ACL resource ID (e.g., 'Magento_Customer::manage') in group 1.
 *
 * Matches two patterns:
 *   1. const ADMIN_RESOURCE = 'Vendor_Module::resource_name'
 *   2. ->isAllowed('Vendor_Module::resource_name')
 *
 * Returns a fresh regex each call to avoid the shared /g lastIndex footgun —
 * callers can use it with exec() or matchAll() without worrying about stale state.
 */
export function createPhpAclRegex(): RegExp {
  return /(?:const\s+ADMIN_RESOURCE\s*=\s*['"]|->isAllowed\s*\(\s*['"])([A-Za-z0-9_]+::[A-Za-z0-9_]+)['"]/g;
}

export interface PhpAclRef {
  file: string;
  line: number;
  column: number;
  endColumn: number;
}

/**
 * Search PHP files in the project for occurrences of an ACL resource ID string literal.
 * Uses `grep` for speed. Returns position references suitable for LSP Location conversion.
 *
 * Searches all PSR-4 directories in the project, looking for the exact resource ID
 * string (e.g., 'Magento_Customer::manage') in .php files.
 */
export async function grepAclResourceInPhp(
  resourceId: string,
  projectRoot: string,
  psr4Map: Psr4Map,
): Promise<PhpAclRef[]> {
  // Build search directories from PSR-4 map
  const searchDirs = new Set<string>();
  for (const entry of psr4Map) {
    searchDirs.add(entry.path);
  }

  const results: PhpAclRef[] = [];

  // Shell-escape the resource ID for safe use in the grep command
  const escaped = resourceId.replace(/'/g, "'\\''");

  const promises = [...searchDirs].map((dir) =>
    new Promise<void>((resolve) => {
      exec(
        `grep -rn --include='*.php' -F '${escaped}' '${dir}' 2>/dev/null || true`,
        { encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (!err && stdout) {
            for (const line of stdout.split('\n')) {
              if (!line) continue;
              // Format: /path/to/file.php:42:    const ADMIN_RESOURCE = 'Magento_Customer::manage';
              const match = line.match(/^(.+?):(\d+):(.*)$/);
              if (!match) continue;

              const [, file, lineNumStr, content] = match;
              const lineNum = parseInt(lineNumStr, 10) - 1; // Convert to 0-based
              const col = content.indexOf(resourceId);
              if (col === -1) continue;

              results.push({
                file,
                line: lineNum,
                column: col,
                endColumn: col + resourceId.length,
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
