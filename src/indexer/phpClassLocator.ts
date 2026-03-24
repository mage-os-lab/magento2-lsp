/**
 * Resolve a PHP FQCN to its source file on disk using PSR-4 autoload mappings.
 *
 * PSR-4 resolution works by:
 *   1. Finding the longest matching namespace prefix in the PSR-4 map
 *   2. Stripping the prefix from the FQCN to get the relative path
 *   3. Converting namespace separators (\) to directory separators (/)
 *   4. Appending .php
 *   5. Joining with the base directory from the PSR-4 mapping
 *
 * Example: FQCN "Magento\Store\Model\StoreManager" with prefix "Magento\Store\" -> "/path/to/module/"
 *   -> relative: "Model\StoreManager" -> "Model/StoreManager.php"
 *   -> full: "/path/to/module/Model/StoreManager.php"
 *
 * The locatePhpClass function also scans the resolved file to find the exact line
 * of the class/interface declaration, so the LSP can jump to the right line.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Psr4Map } from './types';
import { extractPhpMethods } from '../utils/phpNamespace';

export interface PhpClassLocation {
  file: string;
  /** 0-based line of the class/interface/trait/enum declaration. */
  line: number;
  /** 0-based column where the class name starts. */
  column: number;
}

/** Matches class declarations, capturing everything before the class name as group 1. */
const CLASS_DECL_RE = /^(\s*(?:abstract\s+|final\s+|readonly\s+)*(?:class|interface|trait|enum)\s+)(\w+)/;

/**
 * Resolve a FQCN to its PHP file and find the class declaration line.
 * Returns undefined if the class file doesn't exist on disk.
 */
export function locatePhpClass(
  fqcn: string,
  psr4Map: Psr4Map,
): PhpClassLocation | undefined {
  const filePath = resolveClassFile(fqcn, psr4Map);
  if (!filePath) return undefined;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Find the class/interface/trait/enum declaration line
    for (let i = 0; i < lines.length; i++) {
      const match = CLASS_DECL_RE.exec(lines[i]);
      if (match) {
        return {
          file: filePath,
          line: i,
          column: match[1].length, // Column right after "class " / "interface " etc.
        };
      }
    }

    // File exists but no declaration found (unusual) — return start of file
    return { file: filePath, line: 0, column: 0 };
  } catch {
    return undefined;
  }
}

/**
 * Resolve a FQCN + method name to the method's location in the PHP source file.
 * Falls back to the class declaration if the method is not found.
 */
export function locatePhpMethod(
  fqcn: string,
  methodName: string,
  psr4Map: Psr4Map,
): PhpClassLocation | undefined {
  const filePath = resolveClassFile(fqcn, psr4Map);
  if (!filePath) return undefined;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const methods = extractPhpMethods(content);
    const method = methods.find(m => m.name === methodName);
    if (method) {
      return { file: filePath, line: method.line, column: method.column };
    }
    return locatePhpClass(fqcn, psr4Map);
  } catch {
    return undefined;
  }
}

/**
 * Resolve a FQCN to a filesystem path using PSR-4 mappings.
 * The psr4Map must be sorted by prefix length descending (longest first) so
 * that the first match is the most specific one.
 */
export function resolveClassFile(
  fqcn: string,
  psr4Map: Psr4Map,
): string | undefined {
  for (const entry of psr4Map) {
    // Check if the FQCN starts with this namespace prefix.
    // The second condition handles edge cases where the FQCN is exactly the prefix minus
    // the trailing backslash (e.g., FQCN "Vendor\Module" with prefix "Vendor\Module\").
    if (fqcn.startsWith(entry.prefix) || (fqcn + '\\').startsWith(entry.prefix)) {
      const relativePart = fqcn.slice(entry.prefix.length);
      const relPath = relativePart.replace(/\\/g, path.sep) + '.php';
      const fullPath = path.join(entry.path, relPath);

      if (fileExists(fullPath)) {
        return fullPath;
      }
    }
  }

  return undefined;
}

/**
 * Reverse PSR-4 lookup: resolve a PHP file path to its FQCN.
 * Returns undefined if the file doesn't match any PSR-4 entry.
 */
export function resolveFileToFqcn(filePath: string, psr4Map: Psr4Map): string | undefined {
  const normalized = path.resolve(filePath);
  if (!normalized.endsWith('.php')) return undefined;
  // Find the most specific (longest path) matching PSR-4 entry
  let best: { path: string; prefix: string } | undefined;
  for (const entry of psr4Map) {
    if (normalized.startsWith(entry.path) && (!best || entry.path.length > best.path.length)) {
      best = entry;
    }
  }
  if (!best) return undefined;
  const base = best.path.endsWith(path.sep) ? best.path : best.path + path.sep;
  const relative = normalized.slice(base.length);
  const withoutExt = relative.slice(0, -4);
  return best.prefix + withoutExt.split(path.sep).join('\\');
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
