/**
 * In-memory index of ACL resource references from UI component XML files.
 *
 * Provides lookups for:
 *   - ACL resource ID -> all UI component files referencing that resource
 *   - file -> all references in that file (for efficient per-file removal on change)
 *   - position-based lookup (for determining what the cursor is on)
 */

import { UiComponentAclReference } from '../indexer/types';
import { removeFromMap, findReferenceAtPosition } from '../utils/indexHelpers';

export class UiComponentAclIndex {
  /** ACL resource ID -> all UI component references using that resource. */
  private resourceToRefs = new Map<string, UiComponentAclReference[]>();
  /** File path -> all references in that file. */
  private fileToRefs = new Map<string, UiComponentAclReference[]>();

  /** Add all references from a single UI component XML file to the index. */
  addFile(file: string, refs: UiComponentAclReference[]): void {
    this.fileToRefs.set(file, refs);

    for (const ref of refs) {
      const existing = this.resourceToRefs.get(ref.value) ?? [];
      existing.push(ref);
      this.resourceToRefs.set(ref.value, existing);
    }
  }

  /** Replace all data for a file in one operation (remove old + add new). */
  replaceFile(file: string, refs: UiComponentAclReference[]): void {
    this.removeFile(file);
    this.addFile(file, refs);
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

  /** Get all UI component references for a given ACL resource ID. */
  getRefsForResource(resourceId: string): UiComponentAclReference[] {
    return this.resourceToRefs.get(resourceId) ?? [];
  }

  /** Find which reference the cursor is on at a given position. */
  getReferenceAtPosition(
    file: string,
    line: number,
    col: number,
  ): UiComponentAclReference | undefined {
    return findReferenceAtPosition(this.fileToRefs.get(file), line, col);
  }

  /** Number of UI component files currently indexed. */
  getFileCount(): number {
    return this.fileToRefs.size;
  }

  /** Remove all data from the index. */
  clear(): void {
    this.resourceToRefs.clear();
    this.fileToRefs.clear();
  }
}
