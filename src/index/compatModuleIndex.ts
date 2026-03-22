/**
 * Index of Hyvä compatibility module registrations.
 *
 * Hyvä compat modules provide automatic template overrides without layout XML.
 * When a compat module is registered for an original module, its template directories
 * are injected into Magento's design fallback chain:
 *
 *   For Orig_Module::path/to/template.phtml, the fallback checks:
 *     1. {compatModulePath}/view/frontend/templates/Orig_Module/path/to/template.phtml  (namespaced)
 *     2. {compatModulePath}/view/frontend/templates/path/to/template.phtml               (direct)
 *     3. {origModulePath}/view/frontend/templates/path/to/template.phtml                 (original)
 *
 * The namespaced path takes priority and is used when a single compat module provides
 * overrides for multiple original modules (avoids filename collisions).
 *
 * This index stores the original_module → compat_module mappings parsed from di.xml
 * and provides methods to find override files and reverse-resolve them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ModuleInfo } from '../indexer/types';

export interface CompatModuleEntry {
  /** Magento module name of the compat module (e.g., "Hyva_Catalog"). */
  compatModuleName: string;
  /** Absolute filesystem path to the compat module root. */
  compatModulePath: string;
}

export interface CompatOverride {
  /** Name of the compat module providing the override. */
  compatModule: string;
  /** Absolute path to the override template file. */
  filePath: string;
}

export class CompatModuleIndex {
  /** Maps original module name → list of compat modules providing overrides. */
  private originalToCompat = new Map<string, CompatModuleEntry[]>();

  /**
   * Register a compat module mapping.
   *
   * @param originalModule  The module being overridden (e.g., "Magento_Catalog")
   * @param compatModuleName  The compat module name (e.g., "Hyva_Catalog")
   * @param compatModulePath  Absolute path to the compat module root directory
   */
  addMapping(
    originalModule: string,
    compatModuleName: string,
    compatModulePath: string,
  ): void {
    const existing = this.originalToCompat.get(originalModule) ?? [];
    // Avoid duplicate entries (same compat module registered multiple times)
    if (!existing.some((e) => e.compatModuleName === compatModuleName)) {
      existing.push({ compatModuleName, compatModulePath });
      this.originalToCompat.set(originalModule, existing);
    }
  }

  /**
   * Get all compat modules registered for a given original module.
   */
  getCompatModulesFor(originalModule: string): CompatModuleEntry[] {
    return this.originalToCompat.get(originalModule) ?? [];
  }

  /**
   * Find all compat module override files for a given template identifier.
   *
   * Checks both the namespaced path ({compatPath}/view/frontend/templates/{OrigModule}/...)
   * and the direct path ({compatPath}/view/frontend/templates/...) for each registered
   * compat module. The namespaced path is checked first (higher priority in Magento).
   *
   * @param templateId  Full template identifier, e.g. "Magento_Catalog::category/products.phtml"
   * @returns Array of overrides found, with compat module name and file path
   */
  findOverrides(templateId: string): CompatOverride[] {
    const parts = templateId.split('::');
    if (parts.length !== 2) return [];

    const [moduleName, templatePath] = parts;
    const entries = this.originalToCompat.get(moduleName);
    if (!entries) return [];

    const results: CompatOverride[] = [];

    for (const entry of entries) {
      // Priority 1: namespaced path — {compatPath}/view/frontend/templates/{OrigModule}/{templatePath}
      const namespacedCandidate = path.join(
        entry.compatModulePath,
        'view',
        'frontend',
        'templates',
        moduleName,
        templatePath,
      );
      if (fileExists(namespacedCandidate)) {
        results.push({
          compatModule: entry.compatModuleName,
          filePath: namespacedCandidate,
        });
        continue; // Namespaced path wins — don't check direct path for the same compat module
      }

      // Priority 2: direct path — {compatPath}/view/frontend/templates/{templatePath}
      const directCandidate = path.join(
        entry.compatModulePath,
        'view',
        'frontend',
        'templates',
        templatePath,
      );
      if (fileExists(directCandidate)) {
        results.push({
          compatModule: entry.compatModuleName,
          filePath: directCandidate,
        });
      }
    }

    return results;
  }

  /**
   * Check if a file is inside a compat module's templates directory and, if so,
   * determine which original module it overrides.
   *
   * Used to detect when the user is editing a compat module override template,
   * so we can show "Hyvä compat override: Orig_Module::template/path.phtml".
   *
   * @returns The compat module name, original module, and template ID, or undefined
   */
  getCompatModuleForFile(
    filePath: string,
  ): { compatModuleName: string; originalModule: string; templateId: string } | undefined {
    for (const [originalModule, entries] of this.originalToCompat) {
      for (const entry of entries) {
        const templatesDir = path.join(
          entry.compatModulePath,
          'view',
          'frontend',
          'templates',
        );

        if (!filePath.startsWith(templatesDir + '/') && !filePath.startsWith(templatesDir + path.sep)) {
          continue;
        }

        const relToTemplates = filePath.substring(templatesDir.length + 1);

        // Check namespaced path: templates/{OrigModule}/path/to/file.phtml
        const namespacedPrefix = originalModule + '/';
        if (relToTemplates.startsWith(namespacedPrefix)) {
          const templatePath = relToTemplates.substring(namespacedPrefix.length);
          return {
            compatModuleName: entry.compatModuleName,
            originalModule,
            templateId: `${originalModule}::${templatePath}`,
          };
        }

        // Check direct path: templates/path/to/file.phtml
        // Only match if the file actually exists at this path and is registered for this original module
        return {
          compatModuleName: entry.compatModuleName,
          originalModule,
          templateId: `${originalModule}::${relToTemplates}`,
        };
      }
    }

    return undefined;
  }

  /**
   * Reverse-resolve a compat module override file to the original module template.
   *
   * Given a file inside a compat module's templates directory, finds the corresponding
   * original module template at {modulePath}/view/frontend/templates/{path} or
   * {modulePath}/view/base/templates/{path}.
   */
  getOriginalModuleTemplate(
    filePath: string,
    modules: ModuleInfo[],
  ): string | undefined {
    const info = this.getCompatModuleForFile(filePath);
    if (!info) return undefined;

    const parts = info.templateId.split('::');
    if (parts.length !== 2) return undefined;

    const [moduleName, templatePath] = parts;
    const moduleInfo = modules.find((m) => m.name === moduleName);
    if (!moduleInfo) return undefined;

    // Check area-specific first (frontend), then base
    const frontendCandidate = path.join(
      moduleInfo.path,
      'view',
      'frontend',
      'templates',
      templatePath,
    );
    if (fileExists(frontendCandidate)) return frontendCandidate;

    const baseCandidate = path.join(
      moduleInfo.path,
      'view',
      'base',
      'templates',
      templatePath,
    );
    if (fileExists(baseCandidate)) return baseCandidate;

    return undefined;
  }

  /** Returns true if any compat modules are registered. */
  hasEntries(): boolean {
    return this.originalToCompat.size > 0;
  }

  clear(): void {
    this.originalToCompat.clear();
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
