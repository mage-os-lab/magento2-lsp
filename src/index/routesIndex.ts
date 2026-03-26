/**
 * In-memory index of all routes.xml route/module references.
 *
 * Provides lookups for:
 *   - frontName -> all references with that frontName (route merging across modules)
 *   - module name -> all route registrations for that module
 *   - route id -> all references for that route
 *   - file -> all references in that file (for efficient per-file removal on change)
 *   - position-based lookup (for determining what the cursor is on in routes.xml)
 */

import { RoutesReference } from '../indexer/types';
import { removeFromMap, findReferenceAtPosition } from '../utils/indexHelpers';

export class RoutesIndex {
  /** File path -> all references in that file. */
  private fileToRefs = new Map<string, RoutesReference[]>();
  /** frontName -> all references sharing that frontName. */
  private frontNameToRefs = new Map<string, RoutesReference[]>();
  /** Module name (Vendor_Module) -> all route-module references. */
  private moduleNameToRefs = new Map<string, RoutesReference[]>();
  /** Route id -> all references for that route. */
  private routeIdToRefs = new Map<string, RoutesReference[]>();

  /** Add all references from a single routes.xml file to the index. */
  addFile(file: string, refs: RoutesReference[]): void {
    this.fileToRefs.set(file, refs);

    for (const ref of refs) {
      if (ref.frontName) {
        const byFn = this.frontNameToRefs.get(ref.frontName) ?? [];
        byFn.push(ref);
        this.frontNameToRefs.set(ref.frontName, byFn);
      }

      if (ref.kind === 'route-module') {
        const byMod = this.moduleNameToRefs.get(ref.value) ?? [];
        byMod.push(ref);
        this.moduleNameToRefs.set(ref.value, byMod);
      }

      if (ref.routeId) {
        const byId = this.routeIdToRefs.get(ref.routeId) ?? [];
        byId.push(ref);
        this.routeIdToRefs.set(ref.routeId, byId);
      }
    }
  }

  /** Remove all references from a single file. */
  removeFile(file: string): void {
    const refs = this.fileToRefs.get(file);
    if (!refs) return;

    for (const ref of refs) {
      if (ref.frontName) {
        removeFromMap(this.frontNameToRefs, ref.frontName, file);
      }
      if (ref.kind === 'route-module') {
        removeFromMap(this.moduleNameToRefs, ref.value, file);
      }
      if (ref.routeId) {
        removeFromMap(this.routeIdToRefs, ref.routeId, file);
      }
    }

    this.fileToRefs.delete(file);
  }

  /** Get all references sharing a given frontName. */
  getRefsForFrontName(frontName: string): RoutesReference[] {
    return this.frontNameToRefs.get(frontName) ?? [];
  }

  /** Get all route-module references for a given module name. */
  getRefsForModuleName(moduleName: string): RoutesReference[] {
    return this.moduleNameToRefs.get(moduleName) ?? [];
  }

  /** Get all references for a given route id. */
  getRefsForRouteId(routeId: string): RoutesReference[] {
    return this.routeIdToRefs.get(routeId) ?? [];
  }

  /** Find which reference the cursor is on at a given position in a routes.xml file. */
  getReferenceAtPosition(
    file: string,
    line: number,
    col: number,
  ): RoutesReference | undefined {
    return findReferenceAtPosition(this.fileToRefs.get(file), line, col);
  }

  /** Get all references in a specific file. */
  getRefsForFile(file: string): RoutesReference[] {
    return this.fileToRefs.get(file) ?? [];
  }

  /** Return all known frontName values across the index. Used by MCP search. */
  getAllFrontNames(): string[] {
    return Array.from(this.frontNameToRefs.keys());
  }

  /** Get all route references declared by a given module. */
  getRefsByModule(moduleName: string): RoutesReference[] {
    return this.moduleNameToRefs.get(moduleName) ?? [];
  }

  /** Number of routes.xml files currently indexed. */
  getFileCount(): number {
    return this.fileToRefs.size;
  }

  /** Remove all data from the index. */
  clear(): void {
    this.fileToRefs.clear();
    this.frontNameToRefs.clear();
    this.moduleNameToRefs.clear();
    this.routeIdToRefs.clear();
  }
}
