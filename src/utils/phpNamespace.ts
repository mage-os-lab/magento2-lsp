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
  /** FQCN of the parent class (extends), if any. */
  parentClass?: string;
  /** FQCNs of implemented interfaces. */
  interfaces: string[];
  /** Map from short name/alias to FQCN, from `use` statements. */
  useImports: Map<string, string>;
}

/** Matches: namespace Vendor\Package\SubPackage; or namespace Vendor\Package { */
const NAMESPACE_RE = /^\s*namespace\s+([\w\\]+)\s*[;{]/;

/** Matches class declarations with optional modifiers: abstract class Foo, final class Bar, etc. */
const CLASS_RE = /^\s*(?:abstract\s+|final\s+|readonly\s+)*(?:class|interface|trait|enum)\s+(\w+)/;

/** Extracts just the keyword (class/interface/trait/enum) to determine the declaration kind. */
const KIND_RE = /\b(class|interface|trait|enum)\s+/;

/** Represents a public method declaration found in a PHP class. */
export interface PhpMethodInfo {
  name: string;
  /** 0-based line of the method declaration. */
  line: number;
  /** 0-based column where the method name starts. */
  column: number;
  /** 0-based column where the method name ends. */
  endColumn: number;
  /** Raw return type from PHP declaration (e.g., "Product", "self"). Nullable ? is stripped. */
  returnType?: string;
}

/**
 * Matches public method declarations.
 * Handles: public function foo(, public static function bar(
 * Does NOT match protected/private methods — Magento only intercepts public methods.
 */
const METHOD_RE = /^\s*public\s+(?:static\s+)?function\s+(\w+)\s*\(/;

/**
 * Extract all public method declarations from a PHP file.
 * Used to find which methods exist in a class (for code lens)
 * and which methods a plugin class declares (to determine intercepted methods).
 */
export function extractPhpMethods(content: string): PhpMethodInfo[] {
  const lines = content.split('\n');
  const methods: PhpMethodInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = METHOD_RE.exec(lines[i]);
    if (match) {
      const name = match[1];
      // Find column of method name: skip past "public [static] function "
      const nameIndex = lines[i].indexOf(name, match.index + match[0].indexOf('function') + 9);
      const returnType = extractMethodReturnType(lines, i);
      methods.push({
        name,
        line: i,
        column: nameIndex,
        endColumn: nameIndex + name.length,
        returnType,
      });
    }
  }

  return methods;
}

/** Matches ): ?TypeName or ): TypeName after the closing paren of a method signature. */
const RETURN_TYPE_RE = /\)\s*:\s*\??\s*([\w\\]+)/;

/**
 * Extract the return type from a method declaration, handling multi-line signatures.
 * Scans forward from the method line to find the closing `)`, then looks for `: Type`.
 */
function extractMethodReturnType(lines: string[], startLine: number): string | undefined {
  let depth = 0;
  for (let i = startLine; i < Math.min(startLine + 20, lines.length); i++) {
    const line = lines[i];
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '(') depth++;
      if (line[c] === ')') {
        depth--;
        if (depth <= 0) {
          // Found the closing paren — check for return type in the rest of this line
          // and the next line (in case ): Type is split across lines)
          const rest = line.substring(c);
          const match = RETURN_TYPE_RE.exec(rest);
          if (match) return match[1];
          // Check next line
          if (i + 1 < lines.length) {
            const combined = rest + ' ' + lines[i + 1];
            const match2 = RETURN_TYPE_RE.exec(combined);
            if (match2) return match2[1];
          }
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * Map a plugin method name to the original method it intercepts.
 * Magento convention: beforeSave -> save, afterGetName -> getName, aroundLoad -> load.
 * Returns undefined if the method doesn't follow the before/after/around convention.
 */
export function getInterceptedMethodName(pluginMethodName: string): { prefix: 'before' | 'after' | 'around'; methodName: string } | undefined {
  for (const prefix of ['before', 'after', 'around'] as const) {
    if (pluginMethodName.startsWith(prefix) && pluginMethodName.length > prefix.length) {
      // The intercepted method name has its first letter lowercased:
      // beforeSave -> Save -> save, afterGetName -> GetName -> getName
      const rest = pluginMethodName.slice(prefix.length);
      const methodName = rest[0].toLowerCase() + rest.slice(1);
      return { prefix, methodName };
    }
  }
  return undefined;
}

/** Matches: use Vendor\Package\ClassName; or use Vendor\Package\ClassName as Alias; */
const USE_RE = /^\s*use\s+([\w\\]+?)(?:\s+as\s+(\w+))?\s*;/;

export function extractPhpClass(content: string): PhpClassInfo | undefined {
  const lines = content.split('\n');
  let namespace = '';
  // Map from short name (or alias) to FQCN, built from `use` statements
  const useImports = new Map<string, string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track the most recent namespace declaration
    const nsMatch = NAMESPACE_RE.exec(line);
    if (nsMatch) {
      namespace = nsMatch[1];
      continue;
    }

    // Track `use` imports for resolving short names in extends/implements
    const useMatch = USE_RE.exec(line);
    if (useMatch) {
      const fullName = useMatch[1];
      const alias = useMatch[2];
      // Key is the alias if present, otherwise the last segment of the FQCN
      const shortName = alias ?? fullName.split('\\').pop()!;
      useImports.set(shortName, fullName);
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

      // Parse extends and implements — may span multiple lines until `{`
      const { parentClass, interfaces } = extractInheritance(
        lines,
        i,
        namespace,
        useImports,
      );

      return {
        namespace,
        name: className,
        fqcn,
        kind,
        line: i,
        column: nameIndex,
        endColumn: nameIndex + className.length,
        parentClass,
        interfaces,
        useImports,
      };
    }
  }

  return undefined;
}

/**
 * Extract `extends` and `implements` from a class declaration that may span multiple lines.
 * Collects everything from the class declaration line up to the opening `{`.
 *
 * Resolves short class names to FQCNs using the `use` imports and current namespace.
 */
function extractInheritance(
  lines: string[],
  classLine: number,
  namespace: string,
  useImports: Map<string, string>,
): { parentClass?: string; interfaces: string[] } {
  // Collect the full declaration text from the class line until we find `{`
  let declaration = '';
  for (let i = classLine; i < Math.min(classLine + 20, lines.length); i++) {
    declaration += ' ' + lines[i];
    if (lines[i].includes('{')) break;
  }

  let parentClass: string | undefined;
  const interfaces: string[] = [];

  // Extract `extends ClassName`
  const extendsMatch = /\bextends\s+([\w\\]+)/.exec(declaration);
  if (extendsMatch) {
    parentClass = resolveClassName(extendsMatch[1], namespace, useImports);
  }

  // Extract `implements Interface1, Interface2, ...`
  const implementsMatch = /\bimplements\s+(.+?)(?:\{|$)/.exec(declaration);
  if (implementsMatch) {
    const implementsList = implementsMatch[1];
    // Split by comma, trim each, resolve to FQCN
    const names = implementsList.split(',').map((s) => s.trim()).filter(Boolean);
    for (const name of names) {
      // Clean up: the name might have trailing `{` or whitespace
      const cleaned = name.replace(/\s*\{.*/, '').trim();
      if (cleaned && /^[\w\\]+$/.test(cleaned)) {
        interfaces.push(resolveClassName(cleaned, namespace, useImports));
      }
    }
  }

  return { parentClass, interfaces };
}

/**
 * Resolve a class name reference to a FQCN.
 *
 * Handles three forms:
 *   1. Fully qualified with leading backslash: \Magento\Foo\Bar -> Magento\Foo\Bar
 *   2. Short name matching a `use` import: ProductInterface -> Magento\Catalog\Api\Data\ProductInterface
 *   3. Unqualified name: assumed to be in the current namespace
 */
export function resolveClassName(
  name: string,
  namespace: string,
  useImports: Map<string, string>,
): string {
  // Fully qualified
  if (name.startsWith('\\')) {
    return name.slice(1);
  }

  // Check use imports — the first segment of the name might be an import
  const firstSegment = name.split('\\')[0];
  const imported = useImports.get(firstSegment);
  if (imported) {
    if (name.includes('\\')) {
      // Partial qualification: use Foo\Bar; ... extends Bar\Baz -> Foo\Bar\Baz
      return imported + name.slice(firstSegment.length);
    }
    return imported;
  }

  // Unqualified — resolve relative to current namespace
  if (namespace) {
    return `${namespace}\\${name}`;
  }
  return name;
}

// ---------------------------------------------------------------------------
// Magic method detection
// ---------------------------------------------------------------------------

export interface MagicMethodInfo {
  /** True if the class declares a public __call method. */
  hasCall: boolean;
  /** Method names declared via @method PHPDoc annotations on the class. */
  docMethods: string[];
  /** All physically declared public method names. */
  declaredMethods: string[];
  /** Method name → raw return type from PHP declaration. Only for methods with declared return types. */
  methodReturnTypes: Map<string, string>;
}

/** Matches @method annotations in PHPDoc blocks. */
const DOC_METHOD_RE = /@method\s+(?:static\s+)?(?:[\w\\|$]+\s+)?(\w+)\s*\(/;

// ---------------------------------------------------------------------------
// Combined single-pass extraction (for MagicMethodIndex performance)
// ---------------------------------------------------------------------------

export interface ClassWithMagicInfo {
  classInfo: PhpClassInfo | undefined;
  magicInfo: MagicMethodInfo;
}

/**
 * Extract both class info and magic method info in a single pass over the file.
 *
 * This avoids the 3x content.split('\n') overhead of calling extractPhpClass(),
 * extractPhpMethods(), and extractMagicMethodInfo() separately.
 */
export function extractClassWithMagicInfo(content: string): ClassWithMagicInfo {
  const lines = content.split('\n');
  let namespace = '';
  const useImports = new Map<string, string>();
  let classInfo: PhpClassInfo | undefined;

  const methods: PhpMethodInfo[] = [];
  const docMethods: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track namespace
    if (!classInfo) {
      const nsMatch = NAMESPACE_RE.exec(line);
      if (nsMatch) {
        namespace = nsMatch[1];
        continue;
      }

      // Track use imports
      const useMatch = USE_RE.exec(line);
      if (useMatch) {
        const fullName = useMatch[1];
        const alias = useMatch[2];
        const shortName = alias ?? fullName.split('\\').pop()!;
        useImports.set(shortName, fullName);
        continue;
      }

      // @method annotations (only before class declaration)
      const docMatch = DOC_METHOD_RE.exec(line);
      if (docMatch) {
        docMethods.push(docMatch[1]);
        continue;
      }

      // Class declaration
      const classMatch = CLASS_RE.exec(line);
      if (classMatch) {
        const className = classMatch[1];
        const kindMatch = KIND_RE.exec(line);
        const kind = (kindMatch?.[1] ?? 'class') as PhpClassInfo['kind'];
        const fqcn = namespace ? `${namespace}\\${className}` : className;
        const nameIndex = line.indexOf(className, line.indexOf(kind) + kind.length);
        const { parentClass, interfaces } = extractInheritance(lines, i, namespace, useImports);

        classInfo = {
          namespace, name: className, fqcn, kind,
          line: i, column: nameIndex, endColumn: nameIndex + className.length,
          parentClass, interfaces, useImports,
        };
      }
    }

    // Public methods (scan entire file, including after class declaration)
    const methodMatch = METHOD_RE.exec(line);
    if (methodMatch) {
      const name = methodMatch[1];
      const nameIndex = line.indexOf(name, methodMatch.index + methodMatch[0].indexOf('function') + 9);
      const returnType = extractMethodReturnType(lines, i);
      methods.push({ name, line: i, column: nameIndex, endColumn: nameIndex + name.length, returnType });
    }
  }

  const declaredMethods = methods.map((m) => m.name);
  const methodReturnTypes = new Map<string, string>();
  for (const m of methods) {
    if (m.returnType) methodReturnTypes.set(m.name, m.returnType);
  }
  return {
    classInfo,
    magicInfo: {
      hasCall: declaredMethods.includes('__call'),
      docMethods,
      declaredMethods,
      methodReturnTypes,
    },
  };
}
