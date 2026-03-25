/**
 * Class hierarchy index for resolving plugin inheritance.
 *
 * In Magento, plugins declared on an interface or parent class also apply to all
 * implementing/extending classes. For example, a plugin on ProductRepositoryInterface
 * also intercepts methods on ProductRepository (which implements that interface).
 *
 * This index builds parent->children and child->ancestors mappings by scanning PHP files
 * for `extends` and `implements` clauses. It uses the PSR-4 map to find PHP files for
 * known classes.
 *
 * The hierarchy is built lazily/incrementally: we scan PHP files for classes that are
 * referenced in the DI index (as type-name targets or plugin targets).
 */

import * as fs from 'fs';
import { Psr4Map } from '../indexer/types';
import { resolveClassFile } from '../indexer/phpClassLocator';
import { extractPhpClass } from '../utils/phpNamespace';

export class ClassHierarchy {
  /** Map from child FQCN to its parent class FQCN (extends). */
  private parentMap = new Map<string, string>();
  /** Map from child FQCN to implemented interface FQCNs. */
  private interfacesMap = new Map<string, string[]>();
  /** Cache of already-scanned FQCNs to avoid re-reading files. */
  private scanned = new Set<string>();

  /**
   * Invalidate cached data for a class (e.g., when its PHP file changes).
   * Removes the class from scanned, parentMap, and interfacesMap so it will
   * be re-read on the next buildForClasses call.
   */
  invalidateClass(fqcn: string): void {
    this.scanned.delete(fqcn);
    this.parentMap.delete(fqcn);
    this.interfacesMap.delete(fqcn);
  }

  /**
   * Scan a set of FQCNs to discover their inheritance relationships.
   * Reads each class's PHP file to find extends/implements declarations.
   *
   * Also recursively scans parent classes and interfaces to build the full chain.
   */
  buildForClasses(fqcns: Iterable<string>, psr4Map: Psr4Map): void {
    const queue = [...fqcns];

    while (queue.length > 0) {
      const fqcn = queue.pop()!;
      if (this.scanned.has(fqcn)) continue;
      this.scanned.add(fqcn);

      const filePath = resolveClassFile(fqcn, psr4Map);
      if (!filePath) continue;

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const classInfo = extractPhpClass(content);
        if (!classInfo) continue;

        if (classInfo.parentClass) {
          this.parentMap.set(fqcn, classInfo.parentClass);
          // Recursively scan the parent
          if (!this.scanned.has(classInfo.parentClass)) {
            queue.push(classInfo.parentClass);
          }
        }

        if (classInfo.interfaces.length > 0) {
          this.interfacesMap.set(fqcn, classInfo.interfaces);
          // Recursively scan interfaces (they can extend other interfaces)
          for (const iface of classInfo.interfaces) {
            if (!this.scanned.has(iface)) {
              queue.push(iface);
            }
          }
        }
      } catch {
        // File unreadable — skip
      }
    }
  }

  /**
   * Get all ancestors of a class: parent classes and implemented interfaces,
   * walking up the full chain. Returns FQCNs in order from nearest to farthest.
   *
   * Example: for class C extends B implements I, where B extends A implements J:
   *   getAncestors('C') -> ['B', 'I', 'A', 'J']
   */
  getAncestors(fqcn: string): string[] {
    const ancestors: string[] = [];
    const visited = new Set<string>();
    const queue = [fqcn];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current !== fqcn && !visited.has(current)) {
        visited.add(current);
        ancestors.push(current);
      }

      const parent = this.parentMap.get(current);
      if (parent && !visited.has(parent)) {
        queue.push(parent);
      }

      const interfaces = this.interfacesMap.get(current);
      if (interfaces) {
        for (const iface of interfaces) {
          if (!visited.has(iface)) {
            queue.push(iface);
          }
        }
      }
    }

    return ancestors;
  }

  /** Get the direct parent class of an FQCN, or undefined if none / not scanned. */
  getParent(fqcn: string): string | undefined {
    return this.parentMap.get(fqcn);
  }

  /** Get the directly implemented interfaces of an FQCN, or empty array if none / not scanned. */
  getInterfaces(fqcn: string): string[] {
    return this.interfacesMap.get(fqcn) ?? [];
  }
}
