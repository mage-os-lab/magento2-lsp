/**
 * In-memory index of all db_schema.xml table/column/FK references.
 *
 * Provides lookups for:
 *   - table name -> all references for that table (cross-module table declarations and extensions)
 *   - table name -> table-name refs only (for go-to-definition from FK referenceTable)
 *   - table name -> column-name refs only (for FK referenceColumn validation)
 *   - file -> all references in that file (for efficient per-file removal on change)
 *   - position-based lookup (for determining what the cursor is on in db_schema.xml)
 */

import { DbSchemaReference } from '../indexer/types';
import { removeFromMap, findReferenceAtPosition } from '../utils/indexHelpers';

export class DbSchemaIndex {
  /** File path -> all references in that file. */
  private fileToRefs = new Map<string, DbSchemaReference[]>();
  /** Table name -> all references with that tableName (any kind). */
  private tableNameToRefs = new Map<string, DbSchemaReference[]>();

  /** Add all references from a single db_schema.xml file to the index. */
  addFile(file: string, refs: DbSchemaReference[]): void {
    this.fileToRefs.set(file, refs);

    for (const ref of refs) {
      // Index by the ref's tableName (every ref carries the parent table context)
      const byTable = this.tableNameToRefs.get(ref.tableName) ?? [];
      byTable.push(ref);
      this.tableNameToRefs.set(ref.tableName, byTable);

      // For fk-ref-table refs, also index by the referenced table name (ref.value)
      // so that getRefsForTable('referenced_table') includes the FK references
      if (ref.kind === 'fk-ref-table' && ref.value !== ref.tableName) {
        const byRefTable = this.tableNameToRefs.get(ref.value) ?? [];
        byRefTable.push(ref);
        this.tableNameToRefs.set(ref.value, byRefTable);
      }
    }
  }

  /** Remove all references from a single file. */
  removeFile(file: string): void {
    const refs = this.fileToRefs.get(file);
    if (!refs) return;

    for (const ref of refs) {
      removeFromMap(this.tableNameToRefs, ref.tableName, file);
      if (ref.kind === 'fk-ref-table' && ref.value !== ref.tableName) {
        removeFromMap(this.tableNameToRefs, ref.value, file);
      }
    }

    this.fileToRefs.delete(file);
  }

  /**
   * Get all table-name refs for a given table name (the table declarations).
   * Returns refs from all modules that declare or extend this table.
   */
  getTableDefs(tableName: string): DbSchemaReference[] {
    return (this.tableNameToRefs.get(tableName) ?? [])
      .filter((r) => r.kind === 'table-name' && r.value === tableName);
  }

  /**
   * Get ALL references (any kind) associated with a table name.
   * Includes table-name, column-name, fk-ref-table, and fk-ref-column refs.
   */
  getRefsForTable(tableName: string): DbSchemaReference[] {
    return this.tableNameToRefs.get(tableName) ?? [];
  }

  /**
   * Get all column-name refs for a given table across all files.
   * Used for FK referenceColumn validation.
   */
  getColumnsForTable(tableName: string): DbSchemaReference[] {
    return (this.tableNameToRefs.get(tableName) ?? [])
      .filter((r) => r.kind === 'column-name');
  }

  /** Get all known table names across all indexed files. */
  getAllTableNames(): string[] {
    const names = new Set<string>();
    for (const refs of this.fileToRefs.values()) {
      for (const ref of refs) {
        if (ref.kind === 'table-name') {
          names.add(ref.value);
        }
      }
    }
    return [...names];
  }

  /** Find which reference the cursor is on at a given position in a db_schema.xml file. */
  getReferenceAtPosition(
    file: string,
    line: number,
    col: number,
  ): DbSchemaReference | undefined {
    return findReferenceAtPosition(this.fileToRefs.get(file), line, col);
  }

  /** Get all references in a specific file. */
  getRefsForFile(file: string): DbSchemaReference[] {
    return this.fileToRefs.get(file) ?? [];
  }

  /** Number of db_schema.xml files currently indexed. */
  getFileCount(): number {
    return this.fileToRefs.size;
  }

  /** Remove all data from the index. */
  clear(): void {
    this.fileToRefs.clear();
    this.tableNameToRefs.clear();
  }
}
