/**
 * In-memory index of all webapi.xml route and service references.
 *
 * Provides lookups for:
 *   - fqcn -> all service references for that PHP class (for "find references" from PHP)
 *   - fqcn::method -> all service method references (for PHP method -> routes navigation)
 *   - resource ID -> all resource references (for ACL resource navigation)
 *   - file -> all references in that file (for efficient per-file removal on change)
 *   - position-based lookup (for determining what the cursor is on in webapi.xml)
 */

import { WebapiReference } from '../indexer/types';
import { removeFromMap, findReferenceAtPosition } from '../utils/indexHelpers';

export class WebapiIndex {
  /** Service class FQCN -> all references for that class. */
  private fqcnToRefs = new Map<string, WebapiReference[]>();
  /** "FQCN::method" composite key -> all service-method references. */
  private methodKeyToRefs = new Map<string, WebapiReference[]>();
  /** ACL resource ID -> all resource-ref references. */
  private resourceToRefs = new Map<string, WebapiReference[]>();
  /** File path -> all references in that file. */
  private fileToRefs = new Map<string, WebapiReference[]>();

  addFile(file: string, refs: WebapiReference[]): void {
    this.fileToRefs.set(file, refs);

    for (const ref of refs) {
      if (ref.fqcn) {
        const byFqcn = this.fqcnToRefs.get(ref.fqcn) ?? [];
        byFqcn.push(ref);
        this.fqcnToRefs.set(ref.fqcn, byFqcn);
      }

      if (ref.kind === 'service-method' && ref.fqcn && ref.methodName) {
        const key = `${ref.fqcn}::${ref.methodName}`;
        const byMethod = this.methodKeyToRefs.get(key) ?? [];
        byMethod.push(ref);
        this.methodKeyToRefs.set(key, byMethod);
      }

      if (ref.kind === 'resource-ref') {
        const byResource = this.resourceToRefs.get(ref.value) ?? [];
        byResource.push(ref);
        this.resourceToRefs.set(ref.value, byResource);
      }
    }
  }

  removeFile(file: string): void {
    const refs = this.fileToRefs.get(file);
    if (!refs) return;

    for (const ref of refs) {
      if (ref.fqcn) {
        removeFromMap(this.fqcnToRefs, ref.fqcn, file);
      }

      if (ref.kind === 'service-method' && ref.fqcn && ref.methodName) {
        const key = `${ref.fqcn}::${ref.methodName}`;
        removeFromMap(this.methodKeyToRefs, key, file);
      }

      if (ref.kind === 'resource-ref') {
        removeFromMap(this.resourceToRefs, ref.value, file);
      }
    }

    this.fileToRefs.delete(file);
  }

  /** Get all references (service-class + service-method) for a given PHP class. */
  getRefsForFqcn(fqcn: string): WebapiReference[] {
    return this.fqcnToRefs.get(fqcn) ?? [];
  }

  /** Get all service-method references for a specific class + method. */
  getRefsForMethod(fqcn: string, method: string): WebapiReference[] {
    return this.methodKeyToRefs.get(`${fqcn}::${method}`) ?? [];
  }

  /** Get all resource-ref references for a given ACL resource ID. */
  getRefsForResource(resourceId: string): WebapiReference[] {
    return this.resourceToRefs.get(resourceId) ?? [];
  }

  /** Find which reference the cursor is on at a given position in a webapi.xml file. */
  getReferenceAtPosition(
    file: string,
    line: number,
    col: number,
  ): WebapiReference | undefined {
    return findReferenceAtPosition(this.fileToRefs.get(file), line, col);
  }

  /** Return all references in a single file. */
  getRefsForFile(file: string): WebapiReference[] {
    return this.fileToRefs.get(file) ?? [];
  }

  /** Get all webapi references declared by a given module. */
  getRefsByModule(moduleName: string): WebapiReference[] {
    const result: WebapiReference[] = [];
    for (const refs of this.fileToRefs.values()) {
      for (const ref of refs) {
        if (ref.module === moduleName) {
          result.push(ref);
        }
      }
    }
    return result;
  }

  /** Number of webapi.xml files currently indexed. */
  getFileCount(): number {
    return this.fileToRefs.size;
  }

  clear(): void {
    this.fqcnToRefs.clear();
    this.methodKeyToRefs.clear();
    this.resourceToRefs.clear();
    this.fileToRefs.clear();
  }
}
