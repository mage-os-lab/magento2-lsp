/**
 * In-memory index of references from layout and page_layout XML files.
 *
 * Provides lookups for:
 *   - FQCN -> all layout XML references (block classes + argument objects)
 *   - templateId -> all layout XML references using that template
 *   - file + position -> which reference the cursor is on
 */

import { LayoutReference } from '../indexer/types';

export class LayoutIndex {
  /** FQCN -> all layout refs for that class (block-class + argument-object). */
  private fqcnToRefs = new Map<string, LayoutReference[]>();
  /** Resolved template ID -> all layout refs using that template. */
  private templateToRefs = new Map<string, LayoutReference[]>();
  /** File path -> all references in that file. */
  private fileToRefs = new Map<string, LayoutReference[]>();

  addFile(file: string, refs: LayoutReference[]): void {
    this.fileToRefs.set(file, refs);

    for (const ref of refs) {
      if (ref.kind === 'block-class' || ref.kind === 'argument-object') {
        const existing = this.fqcnToRefs.get(ref.value) ?? [];
        existing.push(ref);
        this.fqcnToRefs.set(ref.value, existing);
      } else if (ref.kind === 'block-template' || ref.kind === 'refblock-template') {
        const key = ref.resolvedTemplateId ?? ref.value;
        const existing = this.templateToRefs.get(key) ?? [];
        existing.push(ref);
        this.templateToRefs.set(key, existing);
      }
    }
  }

  removeFile(file: string): void {
    const refs = this.fileToRefs.get(file);
    if (!refs) return;

    for (const ref of refs) {
      if (ref.kind === 'block-class' || ref.kind === 'argument-object') {
        this.removeFromList(this.fqcnToRefs, ref.value, file);
      } else if (ref.kind === 'block-template' || ref.kind === 'refblock-template') {
        const key = ref.resolvedTemplateId ?? ref.value;
        this.removeFromList(this.templateToRefs, key, file);
      }
    }

    this.fileToRefs.delete(file);
  }

  /** Get all layout XML references for a given PHP class. */
  getReferencesForFqcn(fqcn: string): LayoutReference[] {
    return this.fqcnToRefs.get(fqcn) ?? [];
  }

  /** Get all layout XML references for a given template identifier. */
  getReferencesForTemplate(templateId: string): LayoutReference[] {
    return this.templateToRefs.get(templateId) ?? [];
  }

  /** Find which reference the cursor is on in a layout XML file. */
  getReferenceAtPosition(
    file: string,
    line: number,
    col: number,
  ): LayoutReference | undefined {
    const refs = this.fileToRefs.get(file);
    if (!refs) return undefined;
    return refs.find(
      (r) => r.line === line && col >= r.column && col < r.endColumn,
    );
  }

  getFileCount(): number {
    return this.fileToRefs.size;
  }

  clear(): void {
    this.fqcnToRefs.clear();
    this.templateToRefs.clear();
    this.fileToRefs.clear();
  }

  private removeFromList(
    map: Map<string, LayoutReference[]>,
    key: string,
    file: string,
  ): void {
    const existing = map.get(key);
    if (!existing) return;
    const filtered = existing.filter((r) => r.file !== file);
    if (filtered.length > 0) {
      map.set(key, filtered);
    } else {
      map.delete(key);
    }
  }
}
