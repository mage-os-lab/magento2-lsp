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

export function buildPsr4Map(magentoRoot: string): Psr4Map {
  const map: Psr4Map = [];

  // --- Source 1: vendor/composer/installed.json ---
  const installedJsonPath = path.join(
    magentoRoot,
    'vendor',
    'composer',
    'installed.json',
  );

  try {
    const content = fs.readFileSync(installedJsonPath, 'utf-8');
    const data = JSON.parse(content);
    // Composer v2 wraps in "packages"; v1 is a top-level array
    const packages = data.packages ?? data;

    for (const pkg of packages) {
      const installPath = pkg['install-path'];
      if (!installPath) continue;

      // install-path is relative to vendor/composer/
      const absBasePath = path.resolve(
        magentoRoot,
        'vendor',
        'composer',
        installPath,
      );

      // PSR-4 can map a prefix to one or more directories
      const psr4 = pkg.autoload?.['psr-4'];
      if (psr4 && typeof psr4 === 'object') {
        for (const [prefix, dirs] of Object.entries(psr4)) {
          const dirList = Array.isArray(dirs) ? dirs : [dirs];
          for (const dir of dirList) {
            const fullPath = path.join(absBasePath, dir as string);
            map.push({ prefix: normalizePrefix(prefix), path: fullPath });
          }
        }
      }
    }
  } catch {
    // installed.json not found or invalid — vendor packages won't be resolvable
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
          path: modulePath + path.sep,
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

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
