/**
 * Theme discovery and template resolution with fallback hierarchy.
 *
 * Magento 2 themes form a fallback chain via the `<parent>` element in theme.xml.
 * When resolving a template like `Magento_Catalog::product/view.phtml`, the system
 * checks directories in this order:
 *   1. Current theme override: {themeRoot}/Magento_Catalog/templates/product/view.phtml
 *   2. Parent theme override (repeat for each ancestor in the chain)
 *   3. Module area-specific: {modulePath}/view/frontend/templates/product/view.phtml
 *   4. Module base area: {modulePath}/view/base/templates/product/view.phtml
 *
 * Themes are discovered from:
 *   - vendor/ packages with type "magento2-theme" in installed.json
 *   - app/design/{area}/ directories
 *
 * This class also supports reverse navigation:
 *   - findOverrides(): given a template ID, find all theme files overriding it
 *     (used by code lens to show "overridden in N themes" and by references handler)
 *   - getOriginalModuleTemplate(): given a theme override file path, find the
 *     original module template (used by "go to definition" from a theme override)
 */

import * as fs from 'fs';
import * as path from 'path';
import { ModuleInfo } from '../indexer/types';
import { realpath } from '../utils/realpath';
import { fileExists, isDirectory } from '../utils/fsHelpers';
import { readComposerPackages } from '../utils/composerPackages';

export interface ThemeInfo {
  /** Full theme code: "frontend/Hyva/default", "adminhtml/Magento/backend". */
  code: string;
  /** Short code without area prefix: "Hyva/default". */
  shortCode: string;
  /** Area: "frontend" or "adminhtml". */
  area: string;
  /** Absolute filesystem path to theme root. */
  path: string;
  /** Parent theme short code from theme.xml <parent> element (e.g., "Magento/blank"). */
  parentCode?: string;
}

/** Matches: ComponentRegistrar::register(ComponentRegistrar::THEME, 'frontend/Vendor/name', __DIR__) */
const THEME_REG_RE = /THEME\s*,\s*'((?:frontend|adminhtml)\/[\w]+\/[\w]+)'/;

/** Matches: <parent>Vendor/name</parent> */
const PARENT_RE = /<parent>([\w]+\/[\w]+)<\/parent>/;

export class ThemeResolver {
  private themes = new Map<string, ThemeInfo>();
  /** Maps absolute theme path to ThemeInfo for reverse lookups. */
  private pathToTheme = new Map<string, ThemeInfo>();

  /**
   * Discover all themes from vendor/ packages and app/design/ directories.
   */
  discover(magentoRoot: string): void {
    this.themes.clear();
    this.pathToTheme.clear();

    // Source 1: vendor packages with type "magento2-theme"
    this.discoverFromInstalledJson(magentoRoot);

    // Source 2: app/design directories
    for (const area of ['frontend', 'adminhtml']) {
      this.discoverFromAppDesign(magentoRoot, area);
    }
  }

  /** Get the fallback chain for a theme (current -> parent -> ... -> root). */
  getFallbackChain(themeCode: string): ThemeInfo[] {
    const chain: ThemeInfo[] = [];
    let current = this.themes.get(themeCode);
    const visited = new Set<string>();

    while (current && !visited.has(current.code)) {
      visited.add(current.code);
      chain.push(current);
      if (current.parentCode) {
        current = this.themes.get(`${current.area}/${current.parentCode}`);
      } else {
        break;
      }
    }

    return chain;
  }

  /** Determine which theme (if any) a file belongs to, by matching its path. */
  getThemeForFile(filePath: string): ThemeInfo | undefined {
    // Check if the file path starts with any theme's root path
    for (const [themePath, theme] of this.pathToTheme) {
      if (filePath.startsWith(themePath + path.sep) || filePath.startsWith(themePath + '/')) {
        return theme;
      }
    }
    return undefined;
  }

  /**
   * Determine the area for a file based on its path.
   * Checks if the file is in a theme (use theme's area) or a module view directory.
   */
  getAreaForFile(filePath: string): string | undefined {
    const theme = this.getThemeForFile(filePath);
    if (theme) return theme.area;

    // Check for module view/area paths
    const viewMatch = /\/view\/(frontend|adminhtml|base)\//.exec(filePath);
    if (viewMatch) return viewMatch[1];

    return undefined;
  }

  /**
   * Resolve a template identifier to file paths, ordered by fallback priority.
   *
   * @param templateId  Full identifier: "Magento_Catalog::product/view.phtml"
   * @param area        "frontend" or "adminhtml"
   * @param themeCode   Theme context (full code), if the requesting file is in a theme
   * @param modules     Active modules for resolving Module_Name to filesystem path
   * @returns Ordered list of existing file paths (best match first)
   */
  resolveTemplate(
    templateId: string,
    area: string,
    themeCode: string | undefined,
    modules: ModuleInfo[],
  ): string[] {
    const parts = templateId.split('::');
    if (parts.length !== 2) return [];

    const [moduleName, templatePath] = parts;
    const results: string[] = [];

    // Walk the theme fallback chain
    if (themeCode) {
      const chain = this.getFallbackChain(themeCode);
      for (const theme of chain) {
        const candidate = path.join(theme.path, moduleName, 'templates', templatePath);
        if (fileExists(candidate)) {
          results.push(candidate);
        }
      }
    }

    // Module area-specific templates
    const moduleInfo = modules.find((m) => m.name === moduleName);
    if (moduleInfo) {
      const areaCandidate = path.join(moduleInfo.path, 'view', area, 'templates', templatePath);
      if (fileExists(areaCandidate)) {
        results.push(areaCandidate);
      }

      // Module base area fallback
      const baseCandidate = path.join(moduleInfo.path, 'view', 'base', 'templates', templatePath);
      if (fileExists(baseCandidate)) {
        results.push(baseCandidate);
      }
    }

    // If no match in the fallback chain, try all themes (any match is better than none)
    if (results.length === 0) {
      for (const theme of this.themes.values()) {
        if (theme.area !== area) continue;
        const candidate = path.join(theme.path, moduleName, 'templates', templatePath);
        if (fileExists(candidate)) {
          results.push(candidate);
        }
      }
    }

    return results;
  }

  /**
   * Find all theme files that override a given module template.
   *
   * Searches all known themes in the given area for override files at
   * {themePath}/{ModuleName}/templates/{templatePath}.
   *
   * @param templateId  Full identifier: "Magento_Catalog::product/view.phtml"
   * @param area        "frontend" or "adminhtml"
   * @returns Array of { theme, filePath } for each override found
   */
  findOverrides(
    templateId: string,
    area: string,
  ): { theme: ThemeInfo; filePath: string }[] {
    const parts = templateId.split('::');
    if (parts.length !== 2) return [];

    const [moduleName, templatePath] = parts;
    const results: { theme: ThemeInfo; filePath: string }[] = [];

    for (const theme of this.themes.values()) {
      if (theme.area !== area) continue;
      const candidate = path.join(theme.path, moduleName, 'templates', templatePath);
      if (fileExists(candidate)) {
        results.push({ theme, filePath: candidate });
      }
    }

    return results;
  }

  /**
   * Reverse-resolve a theme override .phtml file to the original module template path.
   *
   * Given a file like {themePath}/Module_Name/templates/path/to/file.phtml,
   * finds the corresponding module template at {modulePath}/view/{area}/templates/path/to/file.phtml
   * or {modulePath}/view/base/templates/path/to/file.phtml.
   *
   * @returns The absolute path to the original module template, or undefined if not found
   */
  getOriginalModuleTemplate(
    filePath: string,
    modules: ModuleInfo[],
  ): string | undefined {
    const theme = this.getThemeForFile(filePath);
    if (!theme) return undefined;

    const relToTheme = filePath.substring(theme.path.length + 1);
    // relToTheme: "Module_Name/templates/path/to/file.phtml"
    const parts = relToTheme.split('/');
    if (parts.length < 3 || parts[1] !== 'templates') return undefined;

    const moduleName = parts[0];
    const templatePath = parts.slice(2).join('/');

    const moduleInfo = modules.find((m) => m.name === moduleName);
    if (!moduleInfo) return undefined;

    // Check area-specific first
    const areaCandidate = path.join(moduleInfo.path, 'view', theme.area, 'templates', templatePath);
    if (fileExists(areaCandidate)) return areaCandidate;

    // Then base
    const baseCandidate = path.join(moduleInfo.path, 'view', 'base', 'templates', templatePath);
    if (fileExists(baseCandidate)) return baseCandidate;

    return undefined;
  }

  /** Get all known themes. */
  getAllThemes(): ThemeInfo[] {
    return Array.from(this.themes.values());
  }

  private discoverFromInstalledJson(magentoRoot: string): void {
    for (const pkg of readComposerPackages(magentoRoot)) {
      if (pkg.type !== 'magento2-theme') continue;

      // Find registration.php — check autoload.files first, then root
      const regCandidates: string[] = [];
      const autoload = pkg.raw.autoload as Record<string, unknown> | undefined;
      const autoloadFiles = autoload?.files;
      if (Array.isArray(autoloadFiles)) {
        for (const f of autoloadFiles) {
          if (typeof f === 'string' && f.endsWith('registration.php')) {
            regCandidates.push(path.join(pkg.absPath, f));
          }
        }
      }
      regCandidates.push(path.join(pkg.absPath, 'registration.php'));

      for (const regPath of regCandidates) {
        const theme = this.parseThemeRegistration(regPath);
        if (theme) {
          this.themes.set(theme.code, theme);
          this.pathToTheme.set(theme.path, theme);
          break;
        }
      }
    }
  }

  private discoverFromAppDesign(magentoRoot: string, area: string): void {
    const designPath = path.join(magentoRoot, 'app', 'design', area);

    try {
      const vendors = fs.readdirSync(designPath);
      for (const vendor of vendors) {
        const vendorPath = path.join(designPath, vendor);
        if (!isDirectory(vendorPath)) continue;

        const themes = fs.readdirSync(vendorPath);
        for (const themeName of themes) {
          const themePath = realpath(path.join(vendorPath, themeName));
          if (!isDirectory(themePath)) continue;

          const code = `${area}/${vendor}/${themeName}`;
          const shortCode = `${vendor}/${themeName}`;
          const parentCode = this.parseThemeXmlParent(themePath);

          const theme: ThemeInfo = { code, shortCode, area, path: themePath, parentCode };
          this.themes.set(code, theme);
          this.pathToTheme.set(themePath, theme);
        }
      }
    } catch {
      // app/design directory doesn't exist
    }
  }

  /**
   * Parse a registration.php file to extract theme info.
   * Returns the ThemeInfo with path set to the directory containing registration.php.
   */
  private parseThemeRegistration(regPath: string): ThemeInfo | undefined {
    try {
      const content = fs.readFileSync(regPath, 'utf-8');
      const match = THEME_REG_RE.exec(content);
      if (!match) return undefined;

      const code = match[1]; // e.g., "frontend/Hyva/default"
      const parts = code.split('/');
      if (parts.length !== 3) return undefined;

      const area = parts[0];
      const shortCode = `${parts[1]}/${parts[2]}`;
      // Theme root is the directory containing registration.php (__DIR__)
      const themePath = realpath(path.dirname(regPath));
      const parentCode = this.parseThemeXmlParent(themePath);

      return { code, shortCode, area, path: themePath, parentCode };
    } catch {
      return undefined;
    }
  }

  /** Parse theme.xml to find the <parent> element. */
  private parseThemeXmlParent(themePath: string): string | undefined {
    try {
      const themeXml = fs.readFileSync(path.join(themePath, 'theme.xml'), 'utf-8');
      const match = PARENT_RE.exec(themeXml);
      return match?.[1];
    } catch {
      return undefined;
    }
  }
}

