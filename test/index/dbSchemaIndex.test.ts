import { describe, it, expect, beforeEach } from 'vitest';
import { DbSchemaIndex } from '../../src/index/dbSchemaIndex';
import { DbSchemaReference } from '../../src/indexer/types';

function makeRef(overrides: Partial<DbSchemaReference> = {}): DbSchemaReference {
  return {
    kind: 'table-name',
    value: 'test_table',
    tableName: 'test_table',
    file: '/vendor/test/module-foo/etc/db_schema.xml',
    line: 3,
    column: 17,
    endColumn: 27,
    module: 'Test_Foo',
    ...overrides,
  };
}

describe('DbSchemaIndex', () => {
  let index: DbSchemaIndex;

  beforeEach(() => {
    index = new DbSchemaIndex();
  });

  it('adds and retrieves refs by file', () => {
    const refs = [makeRef()];
    index.addFile('/foo/etc/db_schema.xml', refs);

    expect(index.getRefsForFile('/foo/etc/db_schema.xml')).toEqual(refs);
    expect(index.getFileCount()).toBe(1);
  });

  it('returns empty arrays for unknown lookups', () => {
    expect(index.getRefsForFile('/unknown')).toEqual([]);
    expect(index.getTableDefs('nonexistent')).toEqual([]);
    expect(index.getRefsForTable('nonexistent')).toEqual([]);
    expect(index.getColumnsForTable('nonexistent')).toEqual([]);
  });

  it('getTableDefs returns only table-name refs for a given table', () => {
    const file = '/foo/etc/db_schema.xml';
    const refs: DbSchemaReference[] = [
      makeRef({ kind: 'table-name', value: 'review', tableName: 'review' }),
      makeRef({ kind: 'column-name', value: 'review_id', tableName: 'review' }),
      makeRef({ kind: 'fk-ref-table', value: 'store', tableName: 'review' }),
    ];
    index.addFile(file, refs);

    const defs = index.getTableDefs('review');
    expect(defs).toHaveLength(1);
    expect(defs[0].kind).toBe('table-name');
    expect(defs[0].value).toBe('review');
  });

  it('getRefsForTable returns all ref kinds for a table', () => {
    const file = '/foo/etc/db_schema.xml';
    const refs: DbSchemaReference[] = [
      makeRef({ kind: 'table-name', value: 'review', tableName: 'review' }),
      makeRef({ kind: 'column-name', value: 'review_id', tableName: 'review' }),
      makeRef({ kind: 'column-name', value: 'status', tableName: 'review' }),
    ];
    index.addFile(file, refs);

    const allRefs = index.getRefsForTable('review');
    expect(allRefs).toHaveLength(3);
  });

  it('getColumnsForTable returns only column-name refs', () => {
    const file = '/foo/etc/db_schema.xml';
    const refs: DbSchemaReference[] = [
      makeRef({ kind: 'table-name', value: 'review', tableName: 'review' }),
      makeRef({ kind: 'column-name', value: 'review_id', tableName: 'review' }),
      makeRef({ kind: 'column-name', value: 'status', tableName: 'review' }),
      makeRef({ kind: 'fk-ref-table', value: 'store', tableName: 'review' }),
    ];
    index.addFile(file, refs);

    const cols = index.getColumnsForTable('review');
    expect(cols).toHaveLength(2);
    expect(cols.every(c => c.kind === 'column-name')).toBe(true);
  });

  it('aggregates cross-module table definitions', () => {
    const fileA = '/vendor/module-a/etc/db_schema.xml';
    const fileB = '/vendor/module-b/etc/db_schema.xml';

    index.addFile(fileA, [
      makeRef({
        kind: 'table-name', value: 'catalog_product',
        tableName: 'catalog_product', file: fileA, module: 'Module_A',
      }),
      makeRef({
        kind: 'column-name', value: 'entity_id',
        tableName: 'catalog_product', file: fileA, module: 'Module_A',
      }),
    ]);

    index.addFile(fileB, [
      makeRef({
        kind: 'table-name', value: 'catalog_product',
        tableName: 'catalog_product', file: fileB, module: 'Module_B',
      }),
      makeRef({
        kind: 'column-name', value: 'search_weight',
        tableName: 'catalog_product', file: fileB, module: 'Module_B',
      }),
    ]);

    // Both modules' table defs should be returned
    const defs = index.getTableDefs('catalog_product');
    expect(defs).toHaveLength(2);
    expect(defs.map(d => d.module).sort()).toEqual(['Module_A', 'Module_B']);

    // All columns across modules
    const cols = index.getColumnsForTable('catalog_product');
    expect(cols).toHaveLength(2);
  });

  it('indexes fk-ref-table refs under the referenced table name', () => {
    const file = '/foo/etc/db_schema.xml';
    const refs: DbSchemaReference[] = [
      makeRef({ kind: 'table-name', value: 'review', tableName: 'review' }),
      makeRef({
        kind: 'fk-ref-table', value: 'store', tableName: 'review',
        fkRefTable: 'store', fkRefColumn: 'store_id',
      }),
    ];
    index.addFile(file, refs);

    // The FK ref should appear under the 'store' table too
    const storeRefs = index.getRefsForTable('store');
    expect(storeRefs).toHaveLength(1);
    expect(storeRefs[0].kind).toBe('fk-ref-table');
    expect(storeRefs[0].value).toBe('store');
  });

  it('getReferenceAtPosition finds the correct ref', () => {
    const file = '/foo/etc/db_schema.xml';
    const refs: DbSchemaReference[] = [
      makeRef({
        kind: 'table-name', value: 'review', tableName: 'review',
        file, line: 3, column: 17, endColumn: 23,
      }),
      makeRef({
        kind: 'column-name', value: 'entity_id', tableName: 'review',
        file, line: 4, column: 30, endColumn: 39,
      }),
    ];
    index.addFile(file, refs);

    // Hit on table name
    const tableHit = index.getReferenceAtPosition(file, 3, 20);
    expect(tableHit).toBeDefined();
    expect(tableHit!.kind).toBe('table-name');

    // Hit on column name
    const colHit = index.getReferenceAtPosition(file, 4, 35);
    expect(colHit).toBeDefined();
    expect(colHit!.kind).toBe('column-name');

    // Miss
    const miss = index.getReferenceAtPosition(file, 0, 0);
    expect(miss).toBeUndefined();
  });

  it('removeFile cleans up all maps', () => {
    const file = '/foo/etc/db_schema.xml';
    const refs: DbSchemaReference[] = [
      makeRef({ kind: 'table-name', value: 'review', tableName: 'review', file }),
      makeRef({ kind: 'column-name', value: 'entity_id', tableName: 'review', file }),
      makeRef({
        kind: 'fk-ref-table', value: 'store', tableName: 'review', file,
      }),
    ];
    index.addFile(file, refs);

    expect(index.getFileCount()).toBe(1);
    expect(index.getRefsForTable('review').length).toBeGreaterThan(0);
    expect(index.getRefsForTable('store').length).toBeGreaterThan(0);

    index.removeFile(file);

    expect(index.getFileCount()).toBe(0);
    expect(index.getRefsForFile(file)).toEqual([]);
    expect(index.getRefsForTable('review')).toEqual([]);
    expect(index.getRefsForTable('store')).toEqual([]);
  });

  it('removeFile is a no-op for unknown files', () => {
    index.removeFile('/unknown');
    expect(index.getFileCount()).toBe(0);
  });

  it('getAllTableNames returns unique table names', () => {
    index.addFile('/a/etc/db_schema.xml', [
      makeRef({ kind: 'table-name', value: 'table_a', tableName: 'table_a' }),
    ]);
    index.addFile('/b/etc/db_schema.xml', [
      makeRef({ kind: 'table-name', value: 'table_a', tableName: 'table_a' }),
      makeRef({ kind: 'table-name', value: 'table_b', tableName: 'table_b' }),
    ]);

    const names = index.getAllTableNames().sort();
    expect(names).toEqual(['table_a', 'table_b']);
  });

  it('clear removes all data', () => {
    index.addFile('/a/etc/db_schema.xml', [
      makeRef({ kind: 'table-name', value: 'review', tableName: 'review' }),
    ]);

    index.clear();

    expect(index.getFileCount()).toBe(0);
    expect(index.getRefsForTable('review')).toEqual([]);
    expect(index.getAllTableNames()).toEqual([]);
  });
});
