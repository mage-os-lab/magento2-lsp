/**
 * Lazy index for resolving magic method calls.
 *
 * Determines whether a method call on a given class is:
 *   - A physically declared method (returns where it's declared)
 *   - A magic method handled by __call (returns which class has __call)
 *   - A method declared via @method PHPDoc annotation
 *   - Not resolvable (returns undefined)
 *
 * The index is populated lazily: class info is loaded from disk on first access
 * and cached for subsequent lookups. Ancestor chains are walked by reading PHP
 * files via PSR-4 resolution, independent of the DI-focused ClassHierarchy.
 */

import * as fs from 'fs';
import { Psr4Map } from '../indexer/types';
import { resolveClassFile } from '../indexer/phpClassLocator';
import { extractClassWithMagicInfo, MagicMethodInfo, resolveClassName } from '../utils/phpNamespace';

const BUILTIN_TYPES = new Set([
  'int', 'float', 'string', 'bool', 'array', 'object', 'callable',
  'iterable', 'void', 'never', 'null', 'true', 'false', 'mixed',
]);

export interface MethodResolution {
  kind: 'declared' | 'magic';
  /** The class where the method was found (declared) or that has __call/@method. */
  className: string;
  /** For 'declared' kind, the method name. For 'magic', always '__call'. */
  methodName: string;
}

interface ClassEntry {
  info: MagicMethodInfo;
  parentClass?: string;
  interfaces: string[];
  namespace: string;
  useImports: Map<string, string>;
}

export class MagicMethodIndex {
  /** Per-class cache: FQCN -> parsed class entry (or null if not resolvable). */
  private classCache = new Map<string, ClassEntry | null>();
  /** Per-(class, method) resolution cache to avoid repeated ancestor walks. */
  private resolutionCache = new Map<string, MethodResolution | null>();

  /**
   * Invalidate cached data for a class (e.g., when its PHP file changes).
   * Clears the class entry and any resolution cache entries that involve this class.
   */
  invalidateClass(fqcn: string): void {
    this.classCache.delete(fqcn);

    // Clear resolution cache entries for this class (as subject or as resolved target).
    // Collect keys first to avoid mutation during iteration.
    const keysToDelete: string[] = [];
    for (const [key, value] of this.resolutionCache) {
      if (key.startsWith(fqcn + '::') || value?.className === fqcn) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.resolutionCache.delete(key);
    }
  }

  /**
   * Resolve a method call on a class.
   *
   * Walks the class and its ancestor chain to find where the method is handled.
   * Returns undefined if the method cannot be resolved (no declaration, no __call,
   * no @method, and class file not found).
   */
  resolveMethod(
    fqcn: string,
    methodName: string,
    psr4Map: Psr4Map,
  ): MethodResolution | undefined {
    const cacheKey = `${fqcn}::${methodName}`;
    if (this.resolutionCache.has(cacheKey)) {
      return this.resolutionCache.get(cacheKey) ?? undefined;
    }

    const visited = new Set<string>();
    const queue = [fqcn];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const entry = this.loadClassEntry(current, psr4Map);
      if (!entry) continue;

      // Check if the method is physically declared
      if (entry.info.declaredMethods.includes(methodName)) {
        const result: MethodResolution = { kind: 'declared', className: current, methodName };
        this.resolutionCache.set(cacheKey, result);
        return result;
      }

      // Check if the class has __call
      if (entry.info.hasCall) {
        const result: MethodResolution = { kind: 'magic', className: current, methodName: '__call' };
        this.resolutionCache.set(cacheKey, result);
        return result;
      }

      // Check if the method is in @method annotations
      if (entry.info.docMethods.includes(methodName)) {
        const result: MethodResolution = { kind: 'magic', className: current, methodName: '__call' };
        this.resolutionCache.set(cacheKey, result);
        return result;
      }

      // Queue ancestors
      if (entry.parentClass) queue.push(entry.parentClass);
      for (const iface of entry.interfaces) queue.push(iface);
    }

    this.resolutionCache.set(cacheKey, null);
    return undefined;
  }

  /**
   * Resolve the return type of a method call on a class to a FQCN.
   *
   * Finds where the method is declared (walking the ancestor chain), reads its
   * PHP return type declaration, and resolves it to a fully-qualified class name.
   * Returns undefined for builtin types, missing return types, or unresolvable methods.
   */
  resolveMethodReturnType(
    fqcn: string,
    methodName: string,
    psr4Map: Psr4Map,
  ): string | undefined {
    const resolution = this.resolveMethod(fqcn, methodName, psr4Map);

    // Magento auto-generated factory convention: {ClassName}Factory::create() returns {ClassName}.
    // These factory classes are generated at runtime and don't exist as source files,
    // so resolveMethod() won't find them.
    if (!resolution && methodName === 'create' && fqcn.endsWith('Factory')) {
      return fqcn.slice(0, -'Factory'.length);
    }

    if (!resolution) return undefined;

    // For declared methods, look up the return type on the declaring class.
    // For magic (__call), we can't determine the return type.
    if (resolution.kind !== 'declared') return undefined;

    const entry = this.loadClassEntry(resolution.className, psr4Map);
    if (!entry) return undefined;

    const rawType = entry.info.methodReturnTypes.get(resolution.methodName);
    if (!rawType) return undefined;

    // Filter out builtin types before resolving (avoids namespace-qualifying "string" etc.)
    if (BUILTIN_TYPES.has(rawType.toLowerCase())) return undefined;

    // Resolve self/static to the declaring class
    if (rawType === 'self' || rawType === 'static') return resolution.className;

    // Resolve the raw type to a FQCN using the declaring file's context
    return resolveClassName(rawType, entry.namespace, entry.useImports);
  }

  private loadClassEntry(fqcn: string, psr4Map: Psr4Map): ClassEntry | null {
    if (this.classCache.has(fqcn)) return this.classCache.get(fqcn)!;

    const filePath = resolveClassFile(fqcn, psr4Map);
    if (!filePath) {
      this.classCache.set(fqcn, null);
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const { classInfo, magicInfo } = extractClassWithMagicInfo(content);

      const entry: ClassEntry = {
        info: magicInfo,
        parentClass: classInfo?.parentClass,
        interfaces: classInfo?.interfaces ?? [],
        namespace: classInfo?.namespace ?? '',
        useImports: classInfo?.useImports ?? new Map(),
      };

      this.classCache.set(fqcn, entry);
      return entry;
    } catch {
      this.classCache.set(fqcn, null);
      return null;
    }
  }
}
