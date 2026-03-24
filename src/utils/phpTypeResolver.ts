/**
 * Basic PHP variable type resolution for magic method detection.
 *
 * Resolves variable expressions (e.g., `$this`, `$this->storage`, `$product`) to
 * fully-qualified class names by scanning common type sources in the file:
 *   - `$this` → current class FQCN
 *   - Constructor promoted properties → `$this->propName`
 *   - Constructor non-promoted parameters → `$paramName`
 *   - Method parameter type hints → `$paramName`
 *   - `@var` annotations → `$varName`
 *   - Typed property declarations → `$this->propName`
 *
 * This is intentionally simple (regex-based) and does not attempt full type inference.
 * It covers the most common Magento patterns where constructor injection is pervasive.
 */

import { PhpClassInfo, resolveClassName } from './phpNamespace';

/**
 * Resolve variable types in a PHP file.
 *
 * Returns a map from variable expression (e.g., `$this->storage`, `$product`) to FQCN.
 * The `$this` entry is always included when classInfo is provided.
 *
 * When `resolveMethodReturnType` is provided, a second pass detects assignments from
 * method calls (e.g., `$product = $this->factory->create()`) and resolves the return
 * type of the called method to determine the variable's type.
 */
export function resolveVariableTypes(
  content: string,
  classInfo: PhpClassInfo,
  resolveMethodReturnType?: (fqcn: string, methodName: string) => string | undefined,
): Map<string, string> {
  const types = new Map<string, string>();
  const lines = content.split('\n');
  const { namespace, useImports } = classInfo;

  // $this is always the current class
  types.set('$this', classInfo.fqcn);

  // Scan for typed property declarations: private Product $product;
  const PROPERTY_RE = /^\s*(?:private|protected|public)\s+(?:readonly\s+)?(\??)([\w\\]+)\s+\$(\w+)\s*[;=]/;

  // Scan for constructor promoted properties and regular parameters
  // Also scan method parameters and @var annotations
  let inConstructor = false;
  let braceDepth = 0;
  let inConstructorParams = false;
  let parenDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track @var annotations: /** @var Product $product */
    const varMatch = /@var\s+([\w\\]+)\s+\$(\w+)/.exec(line);
    if (varMatch) {
      const fqcn = resolveClassName(varMatch[1], namespace, useImports);
      types.set(`$${varMatch[2]}`, fqcn);
      continue;
    }

    // Track typed property declarations (non-constructor)
    const propMatch = PROPERTY_RE.exec(line);
    if (propMatch && !inConstructorParams) {
      const fqcn = resolveClassName(propMatch[2], namespace, useImports);
      types.set(`$this->${propMatch[3]}`, fqcn);
      continue;
    }

    // Detect constructor start
    if (/\bfunction\s+__construct\s*\(/.test(line)) {
      inConstructor = true;
      inConstructorParams = true;
      parenDepth = 0;
    }

    // Inside constructor parameter list — extract promoted and non-promoted params
    if (inConstructorParams) {
      // Count parentheses to know when the parameter list ends
      for (const ch of line) {
        if (ch === '(') parenDepth++;
        if (ch === ')') {
          parenDepth--;
          if (parenDepth <= 0) {
            inConstructorParams = false;
          }
        }
      }

      // Match promoted properties: private|protected|public [readonly] Type $name
      const promotedRe = /(?:private|protected|public)\s+(?:readonly\s+)?(\??)([\w\\]+)\s+\$(\w+)/g;
      let pm;
      while ((pm = promotedRe.exec(line)) !== null) {
        const fqcn = resolveClassName(pm[2], namespace, useImports);
        types.set(`$this->${pm[3]}`, fqcn);
        types.set(`$${pm[3]}`, fqcn);
      }

      // Match non-promoted parameters: Type $name (no visibility modifier)
      // Must not have private/protected/public prefix
      const paramRe = /(?<![a-zA-Z])([\w\\]+)\s+\$(\w+)/g;
      let prm;
      while ((prm = paramRe.exec(line)) !== null) {
        // Skip if this is a promoted property (already handled above)
        const prefix = line.substring(0, prm.index).trim();
        if (/(?:private|protected|public)(?:\s+readonly)?$/.test(prefix)) continue;
        // Skip PHP built-in types
        if (isBuiltinType(prm[1])) continue;
        const fqcn = resolveClassName(prm[1], namespace, useImports);
        types.set(`$${prm[2]}`, fqcn);
      }
    }

    // Track brace depth for constructor body scope (not used in MVP but available)
    if (inConstructor && !inConstructorParams) {
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        if (ch === '}') {
          braceDepth--;
          if (braceDepth <= 0) {
            inConstructor = false;
          }
        }
      }
    }

    // Method parameter types: public function execute(Product $product)
    if (!inConstructorParams && /\bfunction\s+\w+\s*\(/.test(line)) {
      // Extract parameter list (may span multiple lines, but handle single-line for MVP)
      const paramSection = extractParamSection(lines, i);
      const methodParamRe = /(?<![a-zA-Z])([\w\\]+)\s+\$(\w+)/g;
      let mpm;
      while ((mpm = methodParamRe.exec(paramSection)) !== null) {
        // Skip visibility modifiers (shouldn't appear in non-constructor methods, but be safe)
        const prefix = paramSection.substring(0, mpm.index).trim();
        if (/(?:private|protected|public)(?:\s+readonly)?$/.test(prefix)) continue;
        if (isBuiltinType(mpm[1])) continue;
        const fqcn = resolveClassName(mpm[1], namespace, useImports);
        types.set(`$${mpm[2]}`, fqcn);
      }
    }
  }

  // Second pass: resolve types from method-call assignments like $var = $expr->method()
  if (resolveMethodReturnType) {
    const ASSIGN_RE = /(\$\w+)\s*=\s*(\$[\w]+(?:->[\w]+)*)->([\w]+)\s*\(/g;
    for (let i = 0; i < lines.length; i++) {
      let match;
      ASSIGN_RE.lastIndex = 0;
      while ((match = ASSIGN_RE.exec(lines[i])) !== null) {
        const targetVar = match[1];
        const objectExpr = match[2];
        const methodName = match[3];

        // Skip if already resolved (e.g., from @var annotation)
        if (types.has(targetVar)) continue;

        const objectFqcn = types.get(objectExpr);
        if (!objectFqcn) continue;

        const returnFqcn = resolveMethodReturnType(objectFqcn, methodName);
        if (returnFqcn) {
          types.set(targetVar, returnFqcn);
        }
      }
    }
  }

  return types;
}

/**
 * Extract the parameter section of a function declaration, handling multi-line params.
 */
function extractParamSection(lines: string[], startLine: number): string {
  let result = '';
  let depth = 0;
  for (let i = startLine; i < Math.min(startLine + 20, lines.length); i++) {
    result += ' ' + lines[i];
    for (const ch of lines[i]) {
      if (ch === '(') depth++;
      if (ch === ')') {
        depth--;
        if (depth <= 0) return result;
      }
    }
  }
  return result;
}

const BUILTIN_TYPES = new Set([
  'int', 'float', 'string', 'bool', 'array', 'object', 'callable',
  'iterable', 'void', 'never', 'null', 'true', 'false', 'self',
  'static', 'parent', 'mixed',
]);

function isBuiltinType(name: string): boolean {
  return BUILTIN_TYPES.has(name.toLowerCase());
}
