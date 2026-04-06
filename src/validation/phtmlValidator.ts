/**
 * Hyvä CSP registration validator for .phtml template files.
 *
 * In Hyvä Theme projects, every inline <script> block must be followed by a
 * Content Security Policy (CSP) registration call. Without it, the browser
 * blocks the script at runtime.
 *
 * The required call depends on the template's area:
 *
 *   Frontend area (Hyvä-only templates):
 *     </script>
 *     <?php $hyvaCsp->registerInlineScript(); ?>
 *
 *   Base area (shared between Hyvä and Luma):
 *     </script>
 *     <?php if (isset($hyvaCsp)) $hyvaCsp->registerInlineScript(); ?>
 *
 * The isset() guard is needed in base-area templates because they may also
 * render under non-Hyvä themes where $hyvaCsp is not available.
 *
 * This validator produces a Warning diagnostic on every </script> tag that
 * is not immediately followed (whitespace-only separation) by the correct
 * CSP registration call.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { DIAG_MISSING_CSP_REGISTRATION, DIAG_MISSING_CSP_TYPE_HINT } from './diagnosticCodes';
import { readComposerPackages } from '../utils/composerPackages';
import type { ThemeInfo } from '../project/themeResolver';
import type { ProjectContext } from '../project/projectManager';

// --- CSP registration patterns ---

/** The PHP tag required after </script> in frontend-area Hyvä templates. */
export const FRONTEND_CSP_TAG = '<?php $hyvaCsp->registerInlineScript(); ?>';

/** The PHP tag required after </script> in base-area templates (with isset guard). */
export const BASE_CSP_TAG = '<?php if (isset($hyvaCsp)) $hyvaCsp->registerInlineScript(); ?>';

// --- Hyvä module dependency cache ---

/**
 * Cache of module paths that depend on hyva-themes/magento2-theme-module.
 * Keyed by Magento project root to avoid re-scanning installed.json on every validation.
 */
const hyvaModulePathsCache = new Map<string, Set<string>>();

/**
 * Validate a .phtml template for missing Hyvä CSP registration calls.
 *
 * Checks whether the template is in a Hyvä context (theme, compat module, or
 * module with a Hyvä dependency), determines the correct CSP tag based on area,
 * and warns on every </script> not followed by the expected registration call.
 *
 * @param filePath  Absolute path to the .phtml file being validated.
 * @param content   Current editor buffer content.
 * @param project   The project context containing theme resolver and indexes.
 * @returns Array of Warning diagnostics for missing CSP registrations.
 */
export function validatePhtml(
  filePath: string,
  content: string,
  project: ProjectContext,
): Diagnostic[] {
  const cspArea = determineCspArea(filePath, project);
  if (!cspArea) return [];

  const diagnostics = findMissingCspRegistrations(content, cspArea);
  diagnostics.push(...findMissingCspTypeHints(content, cspArea));
  return diagnostics;
}

// --- Area detection ---

/**
 * The area context for CSP validation.
 * - 'frontend': template is Hyvä-only, use direct $hyvaCsp call.
 * - 'base': template is shared with non-Hyvä themes, use isset() guard.
 */
export type CspArea = 'frontend' | 'base';

/**
 * Determine whether this template needs CSP validation and which area variant.
 *
 * Detection order (first match wins):
 *   1. File is inside a Hyvä theme directory → 'frontend'
 *   2. File is inside a Hyvä compatibility module → 'frontend'
 *   3. File is in a module that requires hyva-themes/magento2-theme-module:
 *      - view/frontend/templates/ → 'frontend'
 *      - view/base/templates/ → 'base'
 *   4. File is in view/base/templates/ and the project has any Hyvä theme → 'base'
 *   5. Otherwise → undefined (not a Hyvä context, skip validation)
 *
 * @returns The CSP area variant, or undefined if the file is not in a Hyvä context.
 */
export function determineCspArea(
  filePath: string,
  project: ProjectContext,
): CspArea | undefined {
  // 1. Check if file is inside a Hyvä theme
  const theme = project.themeResolver.getThemeForFile(filePath);
  if (theme && isHyvaTheme(theme)) {
    return 'frontend';
  }

  // 2. Check if file is inside a Hyvä compatibility module
  const compatInfo = project.indexes.compatModule.getCompatModuleForFile(filePath);
  if (compatInfo) {
    return 'frontend';
  }

  // 3. Check if file is in a module that depends on hyva-themes/magento2-theme-module
  //    A single composer package can contain multiple Magento modules in subdirectories
  //    (e.g., hyva-themes/commerce-module-cms/ contains src/liveview-editor/ as a module).
  //    So we check if the module path is inside any Hyvä-dependent package path.
  const hyvaPackagePaths = getHyvaPackagePaths(project.root);
  const owningModulePath = findOwningModulePath(filePath, project.modules);
  if (owningModulePath && isInsideAnyPath(owningModulePath, hyvaPackagePaths)) {
    if (filePath.includes('/view/frontend/templates/')) return 'frontend';
    if (filePath.includes('/view/base/templates/')) return 'base';
  }

  // 4. Base-area templates get the isset() variant if the project has any Hyvä theme
  if (filePath.includes('/view/base/templates/') && projectHasHyvaTheme(project)) {
    return 'base';
  }

  return undefined;
}

// --- Hyvä detection helpers ---

/**
 * Check whether a theme is a Hyvä theme by looking for a web/tailwind/ directory.
 *
 * This is more reliable than checking the theme code for "Hyva" because child
 * themes can use arbitrary vendor/name codes. The web/tailwind/ directory is a
 * distinctive marker of Hyvä-based themes.
 */
function isHyvaTheme(theme: ThemeInfo): boolean {
  const tailwindDir = path.join(theme.path, 'web', 'tailwind');
  return fs.existsSync(tailwindDir);
}

/**
 * Check whether the project has at least one Hyvä theme or Hyvä compat module.
 */
function projectHasHyvaTheme(project: ProjectContext): boolean {
  // Check compat modules first (cheap — just a map size check)
  if (project.indexes.compatModule.hasEntries()) return true;

  // Check themes for a web/tailwind/ directory
  return project.themeResolver.getAllThemes().some(isHyvaTheme);
}

/**
 * Get the set of composer package paths that depend on hyva-themes/magento2-theme-module.
 *
 * Reads Composer's installed.json and collects paths of packages whose "require"
 * section includes hyva-themes/magento2-theme-module. The result is cached per
 * project root to avoid re-reading the file on every validation.
 *
 * Note: these are composer *package* paths, not Magento *module* paths. A single
 * package can contain multiple Magento modules in subdirectories, so callers must
 * use isInsideAnyPath() rather than exact set membership to match module paths.
 */
function getHyvaPackagePaths(magentoRoot: string): Set<string> {
  const cached = hyvaModulePathsCache.get(magentoRoot);
  if (cached) return cached;

  const paths = new Set<string>();
  for (const pkg of readComposerPackages(magentoRoot)) {
    const require = pkg.raw.require;
    if (require && typeof require === 'object' && 'hyva-themes/magento2-theme-module' in require) {
      paths.add(pkg.absPath);
    }
  }

  hyvaModulePathsCache.set(magentoRoot, paths);
  return paths;
}

/**
 * Check whether a path is inside any of the given parent paths.
 *
 * Used to match a Magento module path against composer package paths, since a
 * single composer package (e.g., hyva-themes/commerce-module-cms/) can contain
 * multiple Magento modules in subdirectories (e.g., src/liveview-editor/).
 */
function isInsideAnyPath(childPath: string, parentPaths: Set<string>): boolean {
  for (const parentPath of parentPaths) {
    if (childPath === parentPath || childPath.startsWith(parentPath + '/')) {
      return true;
    }
  }
  return false;
}

/**
 * Find the module path that owns a given file.
 *
 * A module "owns" a file if the file path starts with the module's root path.
 * Returns the first matching module path, or undefined if no module matches.
 */
function findOwningModulePath(
  filePath: string,
  modules: { path: string }[],
): string | undefined {
  for (const mod of modules) {
    if (filePath.startsWith(mod.path + '/')) {
      return mod.path;
    }
  }
  return undefined;
}

// --- Script tag scanning ---

/**
 * Find all </script> tags in the content that are not followed by the correct
 * CSP registration call, and return a Warning diagnostic for each.
 *
 * The expected CSP tag must appear immediately after </script>, separated only
 * by whitespace (spaces, tabs, newlines). Any other content between </script>
 * and the CSP tag counts as a violation.
 */
function findMissingCspRegistrations(
  content: string,
  cspArea: CspArea,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const expectedTag = cspArea === 'frontend' ? FRONTEND_CSP_TAG : BASE_CSP_TAG;

  // Match all </script> tags (case-insensitive, as HTML tag names are case-insensitive)
  const closeScriptRe = /<\/script\s*>/gi;
  let match;

  while ((match = closeScriptRe.exec(content)) !== null) {
    const tagStart = match.index;
    const tagEnd = tagStart + match[0].length;

    // Check what follows the </script> tag after skipping whitespace
    const afterTag = content.substring(tagEnd);
    const stripped = afterTag.replace(/^[\s]*/, '');

    if (!stripped.startsWith(expectedTag)) {
      // Calculate the line and column of the </script> tag for the diagnostic
      const { line, column } = offsetToLineColumn(content, tagStart);
      const endColumn = column + match[0].length;

      diagnostics.push({
        range: {
          start: { line, character: column },
          end: { line, character: endColumn },
        },
        severity: DiagnosticSeverity.Warning,
        source: 'magento2-lsp',
        message: `Missing CSP registration: </script> must be followed by ${expectedTag}`,
        code: DIAG_MISSING_CSP_REGISTRATION,
        data: { cspArea },
      });
    }
  }

  return diagnostics;
}

/**
 * Check whether the file uses $hyvaCsp but is missing the `use` statement or
 * `@var` PHPDoc type hint. These are needed for IDE autocompletion and type
 * checking — the CSP registration works at runtime without them, but Hyvä
 * convention is to include both.
 *
 * Only emits a diagnostic when the file actually contains a registerInlineScript
 * call, so templates that don't use CSP at all are not affected.
 */
function findMissingCspTypeHints(
  content: string,
  cspArea: CspArea,
): Diagnostic[] {
  // Only check files that already have the CSP registration call
  if (!content.includes('$hyvaCsp->registerInlineScript()')) return [];

  const diagnostics: Diagnostic[] = [];
  const lines = content.split('\n');

  const hasUse = lines.some((l) => l.includes('Hyva\\Theme\\ViewModel\\HyvaCsp'));
  const hasVarDoc = lines.some((l) => l.includes('$hyvaCsp') && l.includes('@var'));

  if (!hasUse || !hasVarDoc) {
    // Place the diagnostic on the first registerInlineScript() occurrence
    const callRe = /\$hyvaCsp->registerInlineScript\(\)/;
    for (let i = 0; i < lines.length; i++) {
      const match = callRe.exec(lines[i]);
      if (match) {
        const parts: string[] = [];
        if (!hasUse) parts.push('use Hyva\\Theme\\ViewModel\\HyvaCsp');
        if (!hasVarDoc) parts.push('/** @var HyvaCsp $hyvaCsp */');
        diagnostics.push({
          range: {
            start: { line: i, character: match.index },
            end: { line: i, character: match.index + match[0].length },
          },
          severity: DiagnosticSeverity.Warning,
          source: 'magento2-lsp',
          message: `Incomplete CSP type hint: add ${parts.join(' and ')}`,
          code: DIAG_MISSING_CSP_TYPE_HINT,
          data: { cspArea },
        });
        break; // One diagnostic is enough — the code action fixes all at once
      }
    }
  }

  return diagnostics;
}

/**
 * Convert a 0-based character offset in a string to a line number and column.
 * Both line and column are 0-based (as required by the LSP Diagnostic range).
 */
function offsetToLineColumn(
  content: string,
  offset: number,
): { line: number; column: number } {
  let line = 0;
  let lastNewline = -1;

  for (let i = 0; i < offset; i++) {
    if (content[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }

  return { line, column: offset - lastNewline - 1 };
}

/**
 * Clear the cached Hyvä module paths for a project.
 * Called when the project is re-indexed or when installed.json changes.
 */
export function clearHyvaModulePathsCache(magentoRoot?: string): void {
  if (magentoRoot) {
    hyvaModulePathsCache.delete(magentoRoot);
  } else {
    hyvaModulePathsCache.clear();
  }
}
