/**
 * In-memory index of all menu.xml ACL resource references.
 *
 * Provides lookups for:
 *   - ACL resource ID -> all menu items referencing that resource
 *   - file -> all references in that file (for efficient per-file removal on change)
 *   - position-based lookup (for determining what the cursor is on in menu.xml)
 */

import { MenuReference } from '../indexer/types';
import { removeFromMap, findReferenceAtPosition } from '../utils/indexHelpers';

export class MenuIndex {
  /** ACL resource ID -> all menu item references using that resource. */
  private resourceToRefs = new Map<string, MenuReference[]>();
  /** File path -> all references in that file. */
  private fileToRefs = new Map<string, MenuReference[]>();

  /** Add all references from a single menu.xml file to the index. */
  addFile(file: string, refs: MenuReference[]): void {
    this.fileToRefs.set(file, refs);

    for (const ref of refs) {
      const existing = this.resourceToRefs.get(ref.value) ?? [];
      existing.push(ref);
      this.resourceToRefs.set(ref.value, existing);
    }
  }

  /** Remove all references from a single file. */
  removeFile(file: string): void {
    const refs = this.fileToRefs.get(file);
    if (!refs) return;

    for (const ref of refs) {
      removeFromMap(this.resourceToRefs, ref.value, file);
    }

    this.fileToRefs.delete(file);
  }

  /** Get all menu item references for a given ACL resource ID. */
  getRefsForResource(resourceId: string): MenuReference[] {
    return this.resourceToRefs.get(resourceId) ?? [];
  }

  /** Find which reference the cursor is on at a given position in a menu.xml file. */
  getReferenceAtPosition(
    file: string,
    line: number,
    col: number,
  ): MenuReference | undefined {
    return findReferenceAtPosition(this.fileToRefs.get(file), line, col);
  }

  /** Number of menu.xml files currently indexed. */
  getFileCount(): number {
    return this.fileToRefs.size;
  }

  /** Remove all data from the index. */
  clear(): void {
    this.resourceToRefs.clear();
    this.fileToRefs.clear();
  }
}
