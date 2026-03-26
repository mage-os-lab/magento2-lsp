/**
 * In-memory index of all system.xml config path and model references.
 *
 * Provides lookups for:
 *   - configPath -> all SystemConfigReferences (for "go to definition" from PHP config paths)
 *   - fqcn -> all model references (for "find references" from a PHP class used as source/backend/frontend model)
 *   - file -> all references in that file (for efficient per-file removal on change)
 *   - position-based lookup (for determining what the cursor is on in system.xml)
 */

import { SystemConfigReference } from '../indexer/types';
import { removeFromMap, findReferenceAtPosition } from '../utils/indexHelpers';

export class SystemConfigIndex {
  /** Config path -> all references with that path (field declarations + model refs across modules). */
  private pathToRefs = new Map<string, SystemConfigReference[]>();
  /** FQCN -> all source/backend/frontend model references for that class. */
  private fqcnToRefs = new Map<string, SystemConfigReference[]>();
  /** ACL resource ID -> all section-resource references (for ACL navigation). */
  private aclResourceToRefs = new Map<string, SystemConfigReference[]>();
  /** File path -> all references in that file. */
  private fileToRefs = new Map<string, SystemConfigReference[]>();

  addFile(file: string, refs: SystemConfigReference[]): void {
    this.fileToRefs.set(file, refs);

    for (const ref of refs) {
      const byPath = this.pathToRefs.get(ref.configPath) ?? [];
      byPath.push(ref);
      this.pathToRefs.set(ref.configPath, byPath);

      if (ref.fqcn) {
        const byFqcn = this.fqcnToRefs.get(ref.fqcn) ?? [];
        byFqcn.push(ref);
        this.fqcnToRefs.set(ref.fqcn, byFqcn);
      }

      if (ref.aclResourceId) {
        const byAcl = this.aclResourceToRefs.get(ref.aclResourceId) ?? [];
        byAcl.push(ref);
        this.aclResourceToRefs.set(ref.aclResourceId, byAcl);
      }
    }
  }

  removeFile(file: string): void {
    const refs = this.fileToRefs.get(file);
    if (!refs) return;

    for (const ref of refs) {
      removeFromMap(this.pathToRefs, ref.configPath, file);
      if (ref.fqcn) {
        removeFromMap(this.fqcnToRefs, ref.fqcn, file);
      }
      if (ref.aclResourceId) {
        removeFromMap(this.aclResourceToRefs, ref.aclResourceId, file);
      }
    }

    this.fileToRefs.delete(file);
  }

  /** Get all references for a given config path (e.g., "payment/account/active"). */
  getRefsForPath(configPath: string): SystemConfigReference[] {
    return this.pathToRefs.get(configPath) ?? [];
  }

  /** Get all model references (source/backend/frontend) for a given PHP class. */
  getRefsForFqcn(fqcn: string): SystemConfigReference[] {
    return this.fqcnToRefs.get(fqcn) ?? [];
  }

  /** Get all section-resource references for a given ACL resource ID. */
  getRefsForAclResource(resourceId: string): SystemConfigReference[] {
    return this.aclResourceToRefs.get(resourceId) ?? [];
  }

  /** Find which reference the cursor is on at a given position in a system.xml file. */
  getReferenceAtPosition(
    file: string,
    line: number,
    col: number,
  ): SystemConfigReference | undefined {
    return findReferenceAtPosition(this.fileToRefs.get(file), line, col);
  }

  /** Return all references in a single file (for per-file validation). */
  getRefsForFile(file: string): SystemConfigReference[] {
    return this.fileToRefs.get(file) ?? [];
  }

  /**
   * Get all references whose config path starts with the given prefix.
   * Used by rename to find all descendant fields when renaming a section or group.
   *
   * For example, prefix "customer/startup" matches:
   *   - "customer/startup" (the group itself)
   *   - "customer/startup/redirect_dashboard" (a field under the group)
   *   - "customer/startup/redirect_dashboard" model refs (source/backend/frontend)
   */
  getRefsForPathPrefix(prefix: string): SystemConfigReference[] {
    const results: SystemConfigReference[] = [];
    const prefixWithSlash = prefix + '/';
    for (const [path, refs] of this.pathToRefs) {
      if (path === prefix || path.startsWith(prefixWithSlash)) {
        results.push(...refs);
      }
    }
    return results;
  }

  /** Iterate all known config paths in the index. */
  getAllConfigPaths(): IterableIterator<string> {
    return this.pathToRefs.keys();
  }

  /** Number of system.xml files currently indexed. */
  getFileCount(): number {
    return this.fileToRefs.size;
  }

  clear(): void {
    this.pathToRefs.clear();
    this.fqcnToRefs.clear();
    this.aclResourceToRefs.clear();
    this.fileToRefs.clear();
  }
}
