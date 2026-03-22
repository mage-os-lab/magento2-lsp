/**
 * Resolve active Magento modules and discover their di.xml files.
 *
 * Magento's module list lives in app/etc/config.php as a PHP array:
 *   'modules' => ['Magento_Store' => 1, 'Magento_Catalog' => 1, ...]
 *
 * The order in this array determines config merge priority — modules listed later override
 * earlier ones. We parse this with a regex (the format is highly regular) rather than
 * executing PHP.
 *
 * Each module name (e.g., 'Magento_Store') needs to be mapped to its filesystem path.
 * Two locations are checked:
 *   1. app/code/Vendor/Module (local project modules)
 *   2. vendor/ packages (via vendor/composer/installed.json + registration.php)
 */

import * as fs from 'fs';
import * as path from 'path';
import { ModuleInfo } from '../indexer/types';
import { realpath } from '../utils/realpath';

/** Matches 'Vendor_Module' => 1 entries in config.php. */
const MODULE_ENTRY_RE = /['"](\w+_\w+)['"]\s*=>\s*1/g;

/**
 * Parse app/etc/config.php and return all active modules with their filesystem paths.
 * The `order` field reflects position in config.php (0-based), used for merge priority.
 */
export function resolveActiveModules(magentoRoot: string): ModuleInfo[] {
  const configPath = path.join(magentoRoot, 'app', 'etc', 'config.php');
  const content = fs.readFileSync(configPath, 'utf-8');

  const modules: ModuleInfo[] = [];
  let match: RegExpExecArray | null;
  let order = 0;

  while ((match = MODULE_ENTRY_RE.exec(content)) !== null) {
    const moduleName = match[1];
    const modulePath = resolveModulePath(magentoRoot, moduleName);
    if (modulePath) {
      modules.push({ name: moduleName, path: modulePath, order });
    }
    // Increment order even for unresolved modules to maintain correct relative ordering
    order++;
  }

  return modules;
}

/**
 * Map a module name to its filesystem path.
 * Checks app/code first (local modules), then falls back to vendor/ packages.
 */
function resolveModulePath(
  magentoRoot: string,
  moduleName: string,
): string | undefined {
  // Convention: Vendor_Module -> app/code/Vendor/Module
  const [vendor, module] = moduleName.split('_');
  if (vendor && module) {
    const appCodePath = path.join(magentoRoot, 'app', 'code', vendor, module);
    if (isDirectory(appCodePath)) {
      return realpath(appCodePath);
    }
  }

  // Fall back to vendor packages via installed.json
  return resolveFromInstalledJson(magentoRoot, moduleName);
}

/**
 * Find a module's path by scanning vendor/composer/installed.json for magento2-module packages,
 * then checking each package's registration.php to see if it registers the target module name.
 *
 * This is necessary because Composer package names don't always map predictably to Magento
 * module names (e.g., package "magento/module-store" registers module "Magento_Store").
 */
function resolveFromInstalledJson(
  magentoRoot: string,
  moduleName: string,
): string | undefined {
  const installedJsonPath = path.join(
    magentoRoot,
    'vendor',
    'composer',
    'installed.json',
  );

  try {
    const content = fs.readFileSync(installedJsonPath, 'utf-8');
    const data = JSON.parse(content);
    // Composer v2 wraps packages in a "packages" key; v1 uses the top-level array directly
    const packages = data.packages ?? data;

    for (const pkg of packages) {
      if (pkg.type !== 'magento2-module') continue;

      const installPath = pkg['install-path'];
      if (!installPath) continue;

      // install-path is relative to vendor/composer/ — resolve symlinks for consistency
      const absPath = realpath(path.resolve(
        magentoRoot,
        'vendor',
        'composer',
        installPath,
      ));

      // Find registration.php — it may be at the package root or in a subdirectory
      // (e.g., src/registration.php). Check autoload.files entries first, then fall back
      // to the package root. The module root is the directory containing registration.php,
      // because it uses __DIR__ to register itself.
      const regCandidates: string[] = [];

      // Check autoload.files entries (e.g., ["src/registration.php"])
      const autoloadFiles = pkg.autoload?.files;
      if (Array.isArray(autoloadFiles)) {
        for (const f of autoloadFiles) {
          if (typeof f === 'string' && f.endsWith('registration.php')) {
            regCandidates.push(path.join(absPath, f));
          }
        }
      }

      // Also check the package root as fallback
      regCandidates.push(path.join(absPath, 'registration.php'));

      for (const registrationPath of regCandidates) {
        try {
          const regContent = fs.readFileSync(registrationPath, 'utf-8');
          if (regContent.includes(`'${moduleName}'`)) {
            // Module root is the directory of registration.php (it uses __DIR__)
            return realpath(path.dirname(registrationPath));
          }
        } catch {
          // Not found at this candidate — try next
        }
      }
    }
  } catch {
    // installed.json not found or invalid JSON
  }

  return undefined;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * All DI scope areas in Magento 2.
 * Each area can have its own di.xml that overrides the global config for that scope.
 */
export const DI_AREAS = [
  'global',
  'frontend',
  'adminhtml',
  'webapi_rest',
  'webapi_soap',
  'graphql',
  'crontab',
] as const;

/**
 * Discover all files with a given name under etc/ for a module.
 * Checks etc/{filename} (global) and etc/{area}/{filename} for each area.
 */
export function discoverModuleXmlFiles(
  modulePath: string,
  filename: string,
): { file: string; area: string }[] {
  const results: { file: string; area: string }[] = [];

  // Global: {module}/etc/{filename}
  const globalFile = path.join(modulePath, 'etc', filename);
  if (fileExists(globalFile)) {
    results.push({ file: globalFile, area: 'global' });
  }

  // Area-specific: {module}/etc/frontend/{filename}, etc/adminhtml/{filename}, etc.
  for (const area of DI_AREAS) {
    if (area === 'global') continue;
    const areaFile = path.join(modulePath, 'etc', area, filename);
    if (fileExists(areaFile)) {
      results.push({ file: areaFile, area });
    }
  }

  return results;
}

/**
 * Discover all di.xml files for a given module.
 * Checks etc/di.xml (global) and etc/{area}/di.xml for each area.
 */
export function discoverDiXmlFiles(
  modulePath: string,
): { file: string; area: string }[] {
  return discoverModuleXmlFiles(modulePath, 'di.xml');
}

/**
 * Discover all events.xml files for a given module.
 * Checks etc/events.xml (global) and etc/{area}/events.xml for each area.
 */
export function discoverEventsXmlFiles(
  modulePath: string,
): { file: string; area: string }[] {
  return discoverModuleXmlFiles(modulePath, 'events.xml');
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
