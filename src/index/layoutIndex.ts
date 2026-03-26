/**
 * In-memory index of references from layout and page_layout XML files.
 *
 * Provides lookups for:
 *   - FQCN -> all layout XML references (block classes + argument objects)
 *   - templateId -> all layout XML references using that template
 *   - handle name -> all layout XML files defining that handle
 *   - block/container name -> declarations and references for navigation
 *   - file + position -> which reference the cursor is on
 */

import * as path from 'path';
import { LayoutReference } from '../indexer/types';
import { removeFromMap, findReferenceAtPosition } from '../utils/indexHelpers';

export class LayoutIndex {
  /** FQCN -> all layout refs for that class (block-class + argument-object). */
  private fqcnToRefs = new Map<string, LayoutReference[]>();
  /** Resolved template ID -> all layout refs using that template. */
  private templateToRefs = new Map<string, LayoutReference[]>();
  /** File path -> all references in that file. */
  private fileToRefs = new Map<string, LayoutReference[]>();
  /** Handle name -> all layout files defining that handle (derived from filename). */
  private handleToFiles = new Map<string, Set<string>>();
  /** Block/container name -> declaration and reference refs for navigation. */
  private nameToRefs = new Map<string, LayoutReference[]>();

  addFile(file: string, refs: LayoutReference[]): void {
    this.fileToRefs.set(file, refs);

    // Index the file by its handle name (filename without .xml)
    const handle = extractHandleFromPath(file);
    if (handle) {
      const existing = this.handleToFiles.get(handle) ?? new Set();
      existing.add(file);
      this.handleToFiles.set(handle, existing);
    }

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
      } else if (
        ref.kind === 'block-name' || ref.kind === 'container-name'
        || ref.kind === 'reference-block' || ref.kind === 'reference-container'
      ) {
        const existing = this.nameToRefs.get(ref.value) ?? [];
        existing.push(ref);
        this.nameToRefs.set(ref.value, existing);
      }
    }
  }

  removeFile(file: string): void {
    const refs = this.fileToRefs.get(file);
    if (!refs) return;

    // Remove from handle map
    const handle = extractHandleFromPath(file);
    if (handle) {
      const files = this.handleToFiles.get(handle);
      if (files) {
        files.delete(file);
        if (files.size === 0) {
          this.handleToFiles.delete(handle);
        }
      }
    }

    for (const ref of refs) {
      if (ref.kind === 'block-class' || ref.kind === 'argument-object') {
        removeFromMap(this.fqcnToRefs, ref.value, file);
      } else if (ref.kind === 'block-template' || ref.kind === 'refblock-template') {
        const key = ref.resolvedTemplateId ?? ref.value;
        removeFromMap(this.templateToRefs, key, file);
      } else if (
        ref.kind === 'block-name' || ref.kind === 'container-name'
        || ref.kind === 'reference-block' || ref.kind === 'reference-container'
      ) {
        removeFromMap(this.nameToRefs, ref.value, file);
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

  /** Get all layout XML files that define a given handle name. */
  getFilesForHandle(handle: string): string[] {
    const files = this.handleToFiles.get(handle);
    return files ? Array.from(files) : [];
  }

  /** Get all layout XML references for a given block or container name. */
  getRefsForName(name: string): LayoutReference[] {
    return this.nameToRefs.get(name) ?? [];
  }

  /** Find which reference the cursor is on in a layout XML file. */
  getReferenceAtPosition(
    file: string,
    line: number,
    col: number,
  ): LayoutReference | undefined {
    return findReferenceAtPosition(this.fileToRefs.get(file), line, col);
  }

  /** Return all references in a single file (for per-file validation). */
  getRefsForFile(file: string): LayoutReference[] {
    return this.fileToRefs.get(file) ?? [];
  }

  getFileCount(): number {
    return this.fileToRefs.size;
  }

  clear(): void {
    this.fqcnToRefs.clear();
    this.templateToRefs.clear();
    this.fileToRefs.clear();
    this.handleToFiles.clear();
    this.nameToRefs.clear();
  }

}

/**
 * Extract the layout handle name from a file path.
 * Returns the filename without .xml if the parent directory is layout or page_layout.
 */
function extractHandleFromPath(filePath: string): string | undefined {
  const dir = path.basename(path.dirname(filePath));
  if (dir !== 'layout' && dir !== 'page_layout') return undefined;
  const filename = path.basename(filePath);
  if (!filename.endsWith('.xml')) return undefined;
  return filename.slice(0, -4);
}
