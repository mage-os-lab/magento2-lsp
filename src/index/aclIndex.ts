/**
 * In-memory index of all ACL resource definitions from acl.xml files.
 *
 * Provides lookups for:
 *   - resource ID -> all definitions of that resource across modules
 *   - file -> all resources defined in that file (for efficient per-file removal on change)
 *   - position-based lookup (for determining what the cursor is on in acl.xml)
 *
 * ACL resources are additive across modules: multiple modules can contribute
 * <resource> nodes to the same tree (e.g., Magento_Backend defines the root
 * "Magento_Backend::admin", and other modules add child resources under it).
 * This is why idToResources stores arrays — the same resource ID may appear
 * in multiple acl.xml files.
 */

import { AclResource } from '../indexer/types';
import { removeFromMap, findReferenceAtPosition } from '../utils/indexHelpers';

export class AclIndex {
  /**
   * ACL resource ID -> all definitions of that resource.
   * Stores arrays because the same resource can be defined in multiple modules'
   * acl.xml files (the ACL tree is merged across all modules at runtime).
   */
  private idToResources = new Map<string, AclResource[]>();

  /** File path -> all resources defined in that file (for per-file removal). */
  private fileToResources = new Map<string, AclResource[]>();

  /** Add all resources from a single acl.xml file to the index. */
  addFile(file: string, resources: AclResource[]): void {
    this.fileToResources.set(file, resources);

    for (const res of resources) {
      const existing = this.idToResources.get(res.id) ?? [];
      existing.push(res);
      this.idToResources.set(res.id, existing);
    }
  }

  /** Remove all resources from a single file (called before re-indexing a changed file). */
  removeFile(file: string): void {
    const resources = this.fileToResources.get(file);
    if (!resources) return;

    for (const res of resources) {
      removeFromMap(this.idToResources, res.id, file);
    }

    this.fileToResources.delete(file);
  }

  /**
   * Get the primary definition for a resource ID.
   * Returns undefined if the resource ID is not defined in any acl.xml file.
   *
   * When multiple modules define the same resource (which is common — modules nest
   * their own resources under shared parents like Magento_Backend::admin), prefers
   * the definition that has a title, since container-only definitions often omit it.
   */
  getResource(id: string): AclResource | undefined {
    const all = this.idToResources.get(id);
    if (!all || all.length === 0) return undefined;
    // Prefer the definition with a title (the "authoritative" one)
    return all.find((r) => r.title) ?? all[0];
  }

  /** Get all definitions for a resource ID across all acl.xml files. */
  getAllResources(id: string): AclResource[] {
    return this.idToResources.get(id) ?? [];
  }

  /**
   * Find which resource definition the cursor is on at a given position in an acl.xml file.
   * Used by LSP handlers to determine what the user is hovering over or requesting definition for.
   */
  getResourceAtPosition(
    file: string,
    line: number,
    col: number,
  ): AclResource | undefined {
    return findReferenceAtPosition(this.fileToResources.get(file), line, col);
  }

  /** Return all resource IDs known to the index. */
  getAllResourceIds(): string[] {
    return Array.from(this.idToResources.keys());
  }

  /** Return all resources in a single file. */
  getResourcesForFile(file: string): AclResource[] {
    return this.fileToResources.get(file) ?? [];
  }

  /** Number of acl.xml files currently indexed. */
  getFileCount(): number {
    return this.fileToResources.size;
  }

  /** Remove all data from the index. */
  clear(): void {
    this.idToResources.clear();
    this.fileToResources.clear();
  }
}
