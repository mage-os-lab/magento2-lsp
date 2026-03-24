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
import { fileExists, isDirectory } from '../utils/fsHelpers';
import { readComposerPackages } from '../utils/composerPackages';

/** Matches 'Vendor_Module' => 1 entries in config.php. */
const MODULE_ENTRY_RE = /['"](\w+_\w+)['"]\s*=>\s*1/g;

/**
 * Parse app/etc/config.php and return all active modules with their filesystem paths.
 * The `order` field reflects position in config.php (0-based), used for merge priority.
 */
export function resolveActiveModules(magentoRoot: string): ModuleInfo[] {
  const configPath = path.join(magentoRoot, 'app', 'etc', 'config.php');
  const content = fs.readFileSync(configPath, 'utf-8');

  // Build a complete module-name -> path map ONCE, then look up each module by name
  const modulePathMap = buildModulePathMap(magentoRoot);

  const modules: ModuleInfo[] = [];
  let match: RegExpExecArray | null;
  let order = 0;

  while ((match = MODULE_ENTRY_RE.exec(content)) !== null) {
    const moduleName = match[1];
    const modulePath = modulePathMap.get(moduleName);
    if (modulePath) {
      modules.push({ name: moduleName, path: modulePath, order });
    }
    order++;
  }

  return modules;
}

/**
 * Build a map from module name to filesystem path by scanning all sources once:
 *   1. app/code/Vendor/Module directories
 *   2. vendor/ packages via installed.json + registration.php
 *
 * This is called once instead of per-module, avoiding repeated installed.json reads
 * and recursive directory scans.
 */
function buildModulePathMap(magentoRoot: string): Map<string, string> {
  const map = new Map<string, string>();

  // --- Source 1: app/code convention (Vendor_Module -> app/code/Vendor/Module) ---
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
        // Read registration.php to get the actual module name
        const regPath = path.join(modulePath, 'registration.php');
        const moduleName = extractModuleNameFromRegistration(regPath);
        if (moduleName) {
          map.set(moduleName, realpath(modulePath));
        } else {
          // Fallback: derive from directory structure
          map.set(`${vendor}_${module}`, realpath(modulePath));
        }
      }
    }
  } catch {
    // app/code doesn't exist
  }

  // --- Source 2: vendor packages via installed.json ---
  for (const pkg of readComposerPackages(magentoRoot)) {
    if (pkg.type !== 'magento2-module') continue;

    // Collect registration.php candidates
    const regCandidates: string[] = [];

    // Check autoload.files entries
    const autoload = pkg.raw.autoload as Record<string, unknown> | undefined;
    const autoloadFiles = autoload?.files;
    if (Array.isArray(autoloadFiles)) {
      for (const f of autoloadFiles) {
        if (typeof f === 'string' && f.endsWith('registration.php')) {
          regCandidates.push(path.join(pkg.absPath, f));
        }
      }
    }

    // Package root
    regCandidates.push(path.join(pkg.absPath, 'registration.php'));

    // Nested modules (e.g., multi-module packages)
    findRegistrationFiles(pkg.absPath, 3, regCandidates);

    // Read each registration.php and extract the module name
    for (const registrationPath of regCandidates) {
      const moduleName = extractModuleNameFromRegistration(registrationPath);
      if (moduleName && !map.has(moduleName)) {
        map.set(moduleName, realpath(path.dirname(registrationPath)));
      }
    }
  }

  return map;
}

/** Extract the Magento module name from a registration.php file (e.g., 'Magento_Store'). */
function extractModuleNameFromRegistration(registrationPath: string): string | undefined {
  try {
    const content = fs.readFileSync(registrationPath, 'utf-8');
    // Match: ComponentRegistrar::register(..., 'Vendor_Module', ...)
    const match = /['"](\w+_\w+)['"]/.exec(content);
    return match?.[1];
  } catch {
    return undefined;
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

/**
 * Recursively search for registration.php files in subdirectories.
 *
 * Some Composer packages bundle multiple Magento modules in subdirectories
 * (e.g., vendor/mollie/magento2-hyva-compatibility/src/Mollie_HyvaCompatibility/registration.php).
 * These aren't listed in autoload.files, so we need to find them by scanning.
 *
 * Skips vendor/, node_modules/, and Test/ directories to avoid false matches.
 * Appends found paths to the candidates array (avoids duplicates with existing entries).
 */
function findRegistrationFiles(dir: string, maxDepth: number, candidates: string[]): void {
  if (maxDepth <= 0) return;
  const candidateSet = new Set(candidates);

  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      // Skip directories that would cause false matches or slow scanning
      if (entry === 'vendor' || entry === 'node_modules' || entry === 'Test' || entry === 'test') continue;
      const fullPath = path.join(dir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && entry === 'registration.php' && !candidateSet.has(fullPath)) {
          candidates.push(fullPath);
        } else if (stat.isDirectory()) {
          findRegistrationFiles(fullPath, maxDepth - 1, candidates);
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  } catch {
    // Directory unreadable
  }
}

