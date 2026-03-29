/**
 * Scan the filesystem to discover all .phtml template files.
 *
 * Templates are found in two locations:
 *
 * 1. Module templates:
 *    {modulePath}/view/{area}/templates/path/to/template.phtml
 *    Area is determined from the directory name (frontend, adminhtml, base).
 *    Template ID format: "Module_Name::path/to/template.phtml"
 *
 * 2. Theme templates (overrides):
 *    {themePath}/{Module_Name}/templates/path/to/template.phtml
 *    Area comes from the theme's registered area (from registration.php).
 *    Module name comes from the directory name under the theme.
 *    Template ID format: "Module_Name::path/to/template.phtml"
 *
 * All templates are scoped by area so completions can be filtered based
 * on the editing context (frontend, adminhtml, or base).
 */

import * as fs from 'fs';
import * as path from 'path';
import { ModuleInfo } from './types';
import { ThemeInfo, ThemeResolver } from '../project/themeResolver';
import { segmentizeTemplateId } from '../matching/segmentation';
import { TemplateEntry } from '../matching/types';

/** The areas that modules can have templates in. */
const TEMPLATE_AREAS = ['frontend', 'adminhtml', 'base'];

/**
 * Recursively collect all .phtml file paths under a directory.
 *
 * @param dir - Directory to walk.
 * @param results - Accumulator array for file paths.
 */
function collectPhtmlFiles(dir: string, results: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // Directory doesn't exist or isn't readable
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectPhtmlFiles(fullPath, results);
    } else if (entry.name.endsWith('.phtml')) {
      results.push(fullPath);
    }
  }
}

/**
 * Build a TemplateEntry from a template's identifying parts.
 */
function buildTemplateEntry(
  moduleName: string,
  relativePath: string,
  area: string,
  filePath: string,
): TemplateEntry {
  const templateId = `${moduleName}::${relativePath}`;
  const seg = segmentizeTemplateId(templateId);
  return {
    value: templateId,
    area,
    filePath,
    moduleSegments: seg.moduleSegments,
    pathSegments: seg.pathSegments,
  };
}

/**
 * Scan all module template directories and return TemplateEntry objects.
 *
 * Looks for templates at: {modulePath}/view/{area}/templates/
 * for each area in [frontend, adminhtml, base].
 *
 * @param modules - Active modules with their filesystem paths.
 * @returns Array of TemplateEntry objects for module templates.
 */
function scanModuleTemplates(modules: ModuleInfo[]): TemplateEntry[] {
  const entries: TemplateEntry[] = [];

  for (const mod of modules) {
    for (const area of TEMPLATE_AREAS) {
      const templatesDir = path.join(mod.path, 'view', area, 'templates');
      const phtmlFiles: string[] = [];
      collectPhtmlFiles(templatesDir, phtmlFiles);

      for (const filePath of phtmlFiles) {
        // Relative path from the templates/ directory
        const relativePath = path.relative(templatesDir, filePath);
        // Normalize path separators to forward slashes (for Windows compat)
        const normalizedPath = relativePath.split(path.sep).join('/');
        entries.push(buildTemplateEntry(mod.name, normalizedPath, area, filePath));
      }
    }
  }

  return entries;
}

/**
 * Scan all theme template directories and return TemplateEntry objects.
 *
 * Themes can override module templates by placing files at:
 *   {themePath}/{Module_Name}/templates/path/to/template.phtml
 *
 * The module name is derived from the directory name (e.g. "Magento_Catalog").
 * The area comes from the theme's registered area.
 *
 * @param themes - All discovered themes.
 * @returns Array of TemplateEntry objects for theme templates.
 */
function scanThemeTemplates(themes: ThemeInfo[]): TemplateEntry[] {
  const entries: TemplateEntry[] = [];

  for (const theme of themes) {
    // List subdirectories under the theme root — each should be a Module_Name
    let themeEntries: fs.Dirent[];
    try {
      themeEntries = fs.readdirSync(theme.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirEntry of themeEntries) {
      // Module override directories contain an underscore (e.g. "Magento_Catalog")
      if (!dirEntry.isDirectory() || !dirEntry.name.includes('_')) continue;

      const moduleName = dirEntry.name;
      const templatesDir = path.join(theme.path, moduleName, 'templates');
      const phtmlFiles: string[] = [];
      collectPhtmlFiles(templatesDir, phtmlFiles);

      for (const filePath of phtmlFiles) {
        const relativePath = path.relative(templatesDir, filePath);
        const normalizedPath = relativePath.split(path.sep).join('/');
        entries.push(buildTemplateEntry(moduleName, normalizedPath, theme.area, filePath));
      }
    }
  }

  return entries;
}

/**
 * Scan all module and theme directories for .phtml templates.
 *
 * This is the main entry point for template scanning. It combines module
 * templates and theme templates into a single array.
 *
 * @param modules - Active modules with their filesystem paths.
 * @param themes - All discovered themes.
 * @returns Array of all TemplateEntry objects.
 */
export function scanAllTemplates(modules: ModuleInfo[], themes: ThemeInfo[]): TemplateEntry[] {
  return [
    ...scanModuleTemplates(modules),
    ...scanThemeTemplates(themes),
  ];
}

/**
 * Derive a TemplateEntry for a single .phtml file.
 *
 * Used by file watchers when a new .phtml file is created or modified.
 * Determines whether the file is under a module's view/{area}/templates/
 * or a theme's {Module_Name}/templates/ directory.
 *
 * @param filePath - Absolute path to the .phtml file.
 * @param modules - Active modules for path matching.
 * @param themeResolver - Theme resolver for theme path matching.
 * @returns A TemplateEntry, or undefined if the file doesn't match any known location.
 */
export function deriveTemplateEntry(
  filePath: string,
  modules: ModuleInfo[],
  themeResolver: ThemeResolver,
): TemplateEntry | undefined {
  // Check if this file is under a theme
  const theme = themeResolver.getThemeForFile(filePath);
  if (theme) {
    return deriveThemeTemplateEntry(filePath, theme);
  }

  // Check if this file is under a module's view/{area}/templates/
  return deriveModuleTemplateEntry(filePath, modules);
}

/**
 * Derive a TemplateEntry for a file within a theme directory.
 */
function deriveThemeTemplateEntry(filePath: string, theme: ThemeInfo): TemplateEntry | undefined {
  const relToTheme = filePath.substring(theme.path.length + 1);
  // Expected format: Module_Name/templates/path/to/file.phtml
  const parts = relToTheme.split(path.sep);
  if (parts.length < 3 || parts[1] !== 'templates') return undefined;

  const moduleName = parts[0];
  if (!moduleName.includes('_')) return undefined;

  const templatePath = parts.slice(2).join('/');
  return buildTemplateEntry(moduleName, templatePath, theme.area, filePath);
}

/**
 * Derive a TemplateEntry for a file within a module's view directory.
 */
function deriveModuleTemplateEntry(filePath: string, modules: ModuleInfo[]): TemplateEntry | undefined {
  // Match against the view/{area}/templates/ pattern in the file path
  const viewMatch = /\/view\/(frontend|adminhtml|base)\/templates\/(.+)$/.exec(filePath);
  if (!viewMatch) return undefined;

  const area = viewMatch[1];
  const templateRelPath = viewMatch[2];

  // Find which module this file belongs to
  for (const mod of modules) {
    if (filePath.startsWith(mod.path + path.sep) || filePath.startsWith(mod.path + '/')) {
      return buildTemplateEntry(mod.name, templateRelPath, area, filePath);
    }
  }

  return undefined;
}
