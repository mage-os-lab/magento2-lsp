/**
 * Reverse-resolve .phtml file paths to Magento template identifiers.
 *
 * Magento templates are identified by strings like "Module_Name::path/to/file.phtml".
 * Given an absolute file path, these functions determine the template identifier by
 * checking which kind of location the file is in:
 *
 *   1. Theme override: {themePath}/{Module_Name}/templates/{path}
 *      → "Module_Name::path/to/file.phtml"
 *
 *   2. Hyvä compat module override: detected via CompatModuleIndex
 *      → "Orig_Module::path/to/file.phtml"
 *
 *   3. Module template: {modulePath}/view/{area}/templates/{path}
 *      → "Module_Name::path/to/file.phtml"
 *
 * This logic is used by both the code lens handler (to determine what a .phtml file
 * represents) and the references handler (to find related layout XML and overrides).
 */

import { ModuleInfo } from '../indexer/types';

/** Minimal interface for the theme info needed for template ID resolution. */
interface ThemePathInfo {
  path: string;
}

/** Minimal interface for the compat module index needed for template ID resolution. */
interface CompatModuleLookup {
  getCompatModuleForFile(
    filePath: string,
  ): { templateId: string } | undefined;
}

/**
 * Reverse-resolve a theme override file to its template identifier.
 *
 * Given a file like {themePath}/Module_Name/templates/path/to/file.phtml,
 * returns "Module_Name::path/to/file.phtml".
 *
 * Returns undefined if the file doesn't match the expected theme override layout
 * (i.e., doesn't have a "templates" directory at position [1] in the path relative
 * to the theme root).
 */
export function reverseResolveThemeOverrideTemplateId(
  filePath: string,
  theme: ThemePathInfo,
): string | undefined {
  const relToTheme = filePath.substring(theme.path.length + 1);
  const parts = relToTheme.split('/');
  if (parts.length < 3 || parts[1] !== 'templates') return undefined;
  const moduleName = parts[0];
  const templatePath = parts.slice(2).join('/');
  return `${moduleName}::${templatePath}`;
}

/**
 * Reverse-resolve a module template file to its template identifier.
 *
 * Given a file like {modulePath}/view/frontend/templates/path/to/file.phtml,
 * returns "Module_Name::path/to/file.phtml".
 *
 * Returns undefined if the file doesn't live under a /templates/ directory
 * within any known module.
 */
export function reverseResolveModuleTemplateId(
  filePath: string,
  modules: ModuleInfo[],
): string | undefined {
  for (const mod of modules) {
    // Use mod.path + '/' to avoid prefix collisions (e.g. Catalog vs CatalogRule)
    if (filePath.startsWith(mod.path + '/')) {
      const relToModule = filePath.substring(mod.path.length + 1);
      // relToModule: "view/frontend/templates/path/to/file.phtml"
      const templatesIdx = relToModule.indexOf('/templates/');
      if (templatesIdx !== -1) {
        const templatePath = relToModule.substring(
          templatesIdx + '/templates/'.length,
        );
        return `${mod.name}::${templatePath}`;
      }
    }
  }
  return undefined;
}

/** Minimal interface for the theme resolver needed for template ID resolution. */
interface ThemeResolverLookup {
  getThemeForFile(filePath: string): ThemePathInfo | undefined;
}

/**
 * Full reverse-resolution: determine the template identifier for any .phtml file.
 *
 * Tries three strategies in order:
 *   1. Theme override (file is under a theme's directory)
 *   2. Hyvä compat module override (file is in a compat module's templates directory)
 *   3. Module template (file is in a module's view/{area}/templates directory)
 *
 * Returns undefined if the file doesn't match any known template location.
 */
export function reverseResolveTemplateId(
  filePath: string,
  modules: ModuleInfo[],
  themeResolver: ThemeResolverLookup,
  compatModuleIndex: CompatModuleLookup,
): string | undefined {
  // 1. Check if the file is in a theme
  const theme = themeResolver.getThemeForFile(filePath);
  if (theme) {
    return reverseResolveThemeOverrideTemplateId(filePath, theme);
  }

  // 2. Check if the file is in a Hyvä compat module
  const compatInfo = compatModuleIndex.getCompatModuleForFile(filePath);
  if (compatInfo) {
    return compatInfo.templateId;
  }

  // 3. Check if the file is in a module
  return reverseResolveModuleTemplateId(filePath, modules);
}
