/**
 * Three-tier template resolution for code generation.
 *
 * Resolution order (first match wins):
 *   1. Project-level: templateDir from LSP initializationOptions
 *   2. User-level: MAGENTO_LSP_TEMPLATES_DIR environment variable
 *   3. Built-in defaults: shipped with the LSP server package
 *
 * This lets developers:
 *   - Override globally via env var (set once in shell profile)
 *   - Override per-project via initializationOptions
 *   - Do nothing and get sensible defaults
 */

import * as fs from 'fs';
import * as path from 'path';

const BUILTIN_DIR = path.join(__dirname, '..', '..', 'src', 'templates');
// When running from dist/, the .tpl files are in src/templates/ relative to project root.
// When running from src/ directly (ts-node/vitest), __dirname is already src/templates/.
// We try both locations.
const BUILTIN_DIR_ALT = path.resolve(__dirname);

/**
 * Resolve a template file by name (e.g., "class.php.tpl").
 *
 * @param templateName  File name of the template (e.g., "class.php.tpl")
 * @param projectTemplateDir  Project-level template directory from initializationOptions (optional)
 * @returns The template content string, or undefined if not found anywhere.
 */
export function resolveTemplate(
  templateName: string,
  projectTemplateDir?: string,
): string | undefined {
  // 1. Project-level override
  if (projectTemplateDir) {
    const content = tryReadTemplate(projectTemplateDir, templateName);
    if (content !== undefined) return content;
  }

  // 2. User-level override via environment variable
  const envDir = process.env.MAGENTO_LSP_TEMPLATES_DIR;
  if (envDir) {
    const content = tryReadTemplate(envDir, templateName);
    if (content !== undefined) return content;
  }

  // 3. Built-in defaults
  const content = tryReadTemplate(BUILTIN_DIR, templateName);
  if (content !== undefined) return content;
  return tryReadTemplate(BUILTIN_DIR_ALT, templateName);
}

function tryReadTemplate(dir: string, name: string): string | undefined {
  try {
    const filePath = path.join(dir, name);
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}
