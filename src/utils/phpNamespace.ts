/**
 * Minimal PHP file parser to extract the namespace and class/interface declaration.
 *
 * This is intentionally simple — it uses line-by-line regex matching rather than a full
 * PHP AST parser. It only needs to find:
 *   1. The `namespace Vendor\Package;` line
 *   2. The `class ClassName` / `interface Name` / `trait Name` / `enum Name` line
 *
 * This is sufficient because the LSP only uses this to determine the FQCN when the user's
 * cursor is on the class declaration line in a PHP file (for "find references" from PHP).
 * Full PHP intelligence (type hints, use imports, etc.) is left to Intelephense.
 */

export interface PhpClassInfo {
  namespace: string;
  name: string;
  /** Fully-qualified class name: namespace + name. */
  fqcn: string;
  kind: 'class' | 'interface' | 'trait' | 'enum';
  /** 0-based line of the declaration. */
  line: number;
  /** 0-based column where the class name starts. */
  column: number;
  /** 0-based column where the class name ends. */
  endColumn: number;
}

/** Matches: namespace Vendor\Package\SubPackage; or namespace Vendor\Package { */
const NAMESPACE_RE = /^\s*namespace\s+([\w\\]+)\s*[;{]/;

/** Matches class declarations with optional modifiers: abstract class Foo, final class Bar, etc. */
const CLASS_RE = /^\s*(?:abstract\s+|final\s+|readonly\s+)*(?:class|interface|trait|enum)\s+(\w+)/;

/** Extracts just the keyword (class/interface/trait/enum) to determine the declaration kind. */
const KIND_RE = /\b(class|interface|trait|enum)\s+/;

export function extractPhpClass(content: string): PhpClassInfo | undefined {
  const lines = content.split('\n');
  let namespace = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track the most recent namespace declaration
    const nsMatch = NAMESPACE_RE.exec(line);
    if (nsMatch) {
      namespace = nsMatch[1];
      continue;
    }

    // Look for a class/interface/trait/enum declaration
    const classMatch = CLASS_RE.exec(line);
    if (classMatch) {
      const className = classMatch[1];
      const kindMatch = KIND_RE.exec(line);
      const kind = (kindMatch?.[1] ?? 'class') as PhpClassInfo['kind'];
      const fqcn = namespace ? `${namespace}\\${className}` : className;

      // Find the exact column of the class name (after the keyword)
      const nameIndex = line.indexOf(className, line.indexOf(kind) + kind.length);
      return {
        namespace,
        name: className,
        fqcn,
        kind,
        line: i,
        column: nameIndex,
        endColumn: nameIndex + className.length,
      };
    }
  }

  return undefined;
}
