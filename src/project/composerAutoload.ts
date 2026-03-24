/**
 * Build a PSR-4 namespace-to-directory map for resolving PHP FQCNs to file paths.
 *
 * PHP's PSR-4 standard maps namespace prefixes to directories:
 *   "Magento\\Store\\" -> "/path/to/vendor/magento/module-store/"
 *
 * Given FQCN "Magento\Store\Model\StoreManager", strip the prefix to get "Model\StoreManager",
 * convert backslashes to directory separators, append ".php" -> "Model/StoreManager.php",
 * and join with the base path.
 *
 * This module builds the map from two sources:
 *   1. vendor/composer/installed.json — contains PSR-4 autoload entries for all Composer packages.
 *   2. app/code/ directory scan — local modules follow the convention app/code/Vendor/Module
 *      mapping to the namespace Vendor\Module\.
 *
 * The resulting map is sorted by prefix length descending so that the phpClassLocator
 * can do longest-prefix matching (important when namespaces overlap).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Psr4Map } from '../indexer/types';
import { realpath } from '../utils/realpath';
import { isDirectory } from '../utils/fsHelpers';
import { readComposerPackages } from '../utils/composerPackages';

export function buildPsr4Map(magentoRoot: string): Psr4Map {
  const map: Psr4Map = [];

  // --- Source 1: vendor/composer/installed.json ---
  for (const pkg of readComposerPackages(magentoRoot)) {
    // PSR-4 can map a prefix to one or more directories
    const autoload = pkg.raw.autoload as Record<string, unknown> | undefined;
    const psr4 = autoload?.['psr-4'];
    if (psr4 && typeof psr4 === 'object') {
      for (const [prefix, dirs] of Object.entries(psr4 as Record<string, unknown>)) {
        const dirList = Array.isArray(dirs) ? dirs : [dirs];
        for (const dir of dirList) {
          const fullPath = realpath(path.join(pkg.absPath, dir as string));
          map.push({ prefix: normalizePrefix(prefix), path: fullPath });
        }
      }
    }
  }

  // --- Source 2: app/code convention ---
  // Local modules at app/code/Vendor/Module map to namespace Vendor\Module\
  const appCodePath = path.join(magentoRoot, 'app', 'code');
  try {
    const vendors = fs.readdirSync(appCodePath);
    for (const vendor of vendors) {
      const vendorPath = path.join(appCodePath, vendor);
      if (!isDirectory(vendorPath)) continue;

      const modules = fs.readdirSync(vendorPath);
      for (const module of modules) {
        const modulePath = path.join(vendorPath, module);
        if (!isDirectory(modulePath)) continue;

        map.push({
          prefix: `${vendor}\\${module}\\`,
          path: realpath(modulePath) + path.sep,
        });
      }
    }
  } catch {
    // app/code doesn't exist or isn't readable — no local modules
  }

  // Sort longest prefix first so phpClassLocator matches the most specific namespace
  map.sort((a, b) => b.prefix.length - a.prefix.length);

  return map;
}

/** Ensure the namespace prefix ends with a backslash (PSR-4 convention). */
function normalizePrefix(prefix: string): string {
  if (!prefix.endsWith('\\')) {
    return prefix + '\\';
  }
  return prefix;
}

