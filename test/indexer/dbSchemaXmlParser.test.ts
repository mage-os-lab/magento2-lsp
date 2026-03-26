import { describe, it, expect } from 'vitest';
import { parseDbSchemaXml, DbSchemaXmlParseContext } from '../../src/indexer/dbSchemaXmlParser';

const defaultContext: DbSchemaXmlParseContext = {
  file: '/vendor/test/module-foo/etc/db_schema.xml',
  module: 'Test_Foo',
};

describe('parseDbSchemaXml', () => {
  it('extracts table-name references', () => {
    const xml = `<?xml version="1.0"?>
<schema xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:framework:Setup/Declaration/Schema/etc/schema.xsd">
    <table name="test_entity" resource="default" engine="innodb" comment="Test Entity Table">
    </table>
</schema>`;
    const result = parseDbSchemaXml(xml, defaultContext);

    expect(result.references).toHaveLength(1);
    const tableRef = result.references[0];
    expect(tableRef.kind).toBe('table-name');
    expect(tableRef.value).toBe('test_entity');
    expect(tableRef.tableName).toBe('test_entity');
    expect(tableRef.tableComment).toBe('Test Entity Table');
    expect(tableRef.tableResource).toBe('default');
    expect(tableRef.tableEngine).toBe('innodb');
  });

  it('extracts column-name references with type metadata', () => {
    const xml = `<?xml version="1.0"?>
<schema xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:framework:Setup/Declaration/Schema/etc/schema.xsd">
    <table name="test_entity" resource="default" engine="innodb" comment="Test Entity">
        <column xsi:type="int" name="entity_id" unsigned="true" nullable="false"
                identity="true" comment="Entity ID"/>
        <column xsi:type="varchar" name="name" nullable="true" length="255"
                comment="Name" default="unknown"/>
    </table>
</schema>`;
    const result = parseDbSchemaXml(xml, defaultContext);

    const columns = result.references.filter(r => r.kind === 'column-name');
    expect(columns).toHaveLength(2);

    const entityId = columns.find(c => c.value === 'entity_id')!;
    expect(entityId.tableName).toBe('test_entity');
    expect(entityId.columnType).toBe('int');
    expect(entityId.columnUnsigned).toBe('true');
    expect(entityId.columnNullable).toBe('false');
    expect(entityId.columnIdentity).toBe('true');
    expect(entityId.columnComment).toBe('Entity ID');

    const name = columns.find(c => c.value === 'name')!;
    expect(name.columnType).toBe('varchar');
    expect(name.columnLength).toBe('255');
    expect(name.columnNullable).toBe('true');
    expect(name.columnDefault).toBe('unknown');
  });

  it('extracts decimal column precision and scale', () => {
    const xml = `<?xml version="1.0"?>
<schema xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:framework:Setup/Declaration/Schema/etc/schema.xsd">
    <table name="test_entity" resource="default">
        <column xsi:type="decimal" name="price" precision="20" scale="4"
                unsigned="false" nullable="true" comment="Price"/>
    </table>
</schema>`;
    const result = parseDbSchemaXml(xml, defaultContext);

    const col = result.references.find(r => r.kind === 'column-name')!;
    expect(col.columnType).toBe('decimal');
    expect(col.columnPrecision).toBe('20');
    expect(col.columnScale).toBe('4');
  });

  it('extracts foreign key references (fk-ref-table and fk-ref-column)', () => {
    const xml = `<?xml version="1.0"?>
<schema xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:framework:Setup/Declaration/Schema/etc/schema.xsd">
    <table name="review" resource="default">
        <column xsi:type="smallint" name="entity_id" unsigned="true"/>
        <constraint xsi:type="foreign" referenceId="REVIEW_ENTITY_ID_REVIEW_ENTITY_ENTITY_ID"
                    table="review" column="entity_id"
                    referenceTable="review_entity" referenceColumn="entity_id" onDelete="CASCADE"/>
    </table>
</schema>`;
    const result = parseDbSchemaXml(xml, defaultContext);

    const fkRefTable = result.references.find(r => r.kind === 'fk-ref-table');
    expect(fkRefTable).toBeDefined();
    expect(fkRefTable!.value).toBe('review_entity');
    expect(fkRefTable!.tableName).toBe('review');
    expect(fkRefTable!.fkReferenceId).toBe('REVIEW_ENTITY_ID_REVIEW_ENTITY_ENTITY_ID');
    expect(fkRefTable!.fkTable).toBe('review');
    expect(fkRefTable!.fkColumn).toBe('entity_id');
    expect(fkRefTable!.fkRefTable).toBe('review_entity');
    expect(fkRefTable!.fkRefColumn).toBe('entity_id');
    expect(fkRefTable!.fkOnDelete).toBe('CASCADE');

    const fkRefCol = result.references.find(r => r.kind === 'fk-ref-column');
    expect(fkRefCol).toBeDefined();
    expect(fkRefCol!.value).toBe('entity_id');
    expect(fkRefCol!.fkRefTable).toBe('review_entity');
    expect(fkRefCol!.fkOnDelete).toBe('CASCADE');
  });

  it('does not emit column-name refs for columns inside constraints', () => {
    const xml = `<?xml version="1.0"?>
<schema xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:framework:Setup/Declaration/Schema/etc/schema.xsd">
    <table name="test_entity" resource="default">
        <column xsi:type="int" name="entity_id" unsigned="true" identity="true"/>
        <constraint xsi:type="primary" referenceId="PRIMARY">
            <column name="entity_id"/>
        </constraint>
        <constraint xsi:type="unique" referenceId="UNQ_CODE">
            <column name="entity_id"/>
        </constraint>
    </table>
</schema>`;
    const result = parseDbSchemaXml(xml, defaultContext);

    const columns = result.references.filter(r => r.kind === 'column-name');
    // Only the direct child <column> should be emitted, not ones inside constraints
    expect(columns).toHaveLength(1);
    expect(columns[0].value).toBe('entity_id');
  });

  it('does not emit column-name refs for columns inside indexes', () => {
    const xml = `<?xml version="1.0"?>
<schema xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:framework:Setup/Declaration/Schema/etc/schema.xsd">
    <table name="test_entity" resource="default">
        <column xsi:type="varchar" name="status" length="32"/>
        <index referenceId="IDX_STATUS" indexType="btree">
            <column name="status"/>
        </index>
    </table>
</schema>`;
    const result = parseDbSchemaXml(xml, defaultContext);

    const columns = result.references.filter(r => r.kind === 'column-name');
    expect(columns).toHaveLength(1);
    expect(columns[0].value).toBe('status');
  });

  it('handles multiple tables in one file', () => {
    const xml = `<?xml version="1.0"?>
<schema xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:framework:Setup/Declaration/Schema/etc/schema.xsd">
    <table name="review_entity" resource="default" comment="Review entities">
        <column xsi:type="smallint" name="entity_id" unsigned="true" identity="true"/>
    </table>
    <table name="review" resource="default" comment="Reviews">
        <column xsi:type="bigint" name="review_id" unsigned="true" identity="true"/>
        <column xsi:type="smallint" name="entity_id" unsigned="true"/>
    </table>
</schema>`;
    const result = parseDbSchemaXml(xml, defaultContext);

    const tables = result.references.filter(r => r.kind === 'table-name');
    expect(tables).toHaveLength(2);
    expect(tables[0].value).toBe('review_entity');
    expect(tables[1].value).toBe('review');

    // entity_id appears as column in both tables
    const columns = result.references.filter(r => r.kind === 'column-name');
    expect(columns).toHaveLength(3);
    expect(columns[0].tableName).toBe('review_entity');
    expect(columns[1].tableName).toBe('review');
    expect(columns[2].tableName).toBe('review');
  });

  it('captures disabled attribute on table and column', () => {
    const xml = `<?xml version="1.0"?>
<schema xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:framework:Setup/Declaration/Schema/etc/schema.xsd">
    <table name="deprecated_table" resource="default" disabled="true">
        <column xsi:type="int" name="old_column" disabled="true"/>
    </table>
</schema>`;
    const result = parseDbSchemaXml(xml, defaultContext);

    const table = result.references.find(r => r.kind === 'table-name')!;
    expect(table.disabled).toBe(true);

    const col = result.references.find(r => r.kind === 'column-name')!;
    expect(col.disabled).toBe(true);
  });

  it('tracks accurate column positions', () => {
    const xml = `<?xml version="1.0"?>
<schema xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:framework:Setup/Declaration/Schema/etc/schema.xsd">
    <table name="test_entity" resource="default">
        <column xsi:type="int" name="entity_id"/>
    </table>
</schema>`;
    const result = parseDbSchemaXml(xml, defaultContext);
    const xmlLines = xml.split('\n');

    const tableRef = result.references.find(r => r.kind === 'table-name')!;
    const tableLine = xmlLines[tableRef.line];
    expect(tableLine.substring(tableRef.column, tableRef.endColumn)).toBe('test_entity');

    const colRef = result.references.find(r => r.kind === 'column-name')!;
    const colLine = xmlLines[colRef.line];
    expect(colLine.substring(colRef.column, colRef.endColumn)).toBe('entity_id');
  });

  it('tracks accurate positions for FK referenceTable and referenceColumn', () => {
    const xml = `<?xml version="1.0"?>
<schema xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:framework:Setup/Declaration/Schema/etc/schema.xsd">
    <table name="review" resource="default">
        <constraint xsi:type="foreign" referenceId="FK_TEST"
                    table="review" column="entity_id"
                    referenceTable="review_entity" referenceColumn="entity_id" onDelete="CASCADE"/>
    </table>
</schema>`;
    const result = parseDbSchemaXml(xml, defaultContext);
    const xmlLines = xml.split('\n');

    const refTable = result.references.find(r => r.kind === 'fk-ref-table')!;
    const refTableLine = xmlLines[refTable.line];
    expect(refTableLine.substring(refTable.column, refTable.endColumn)).toBe('review_entity');

    const refCol = result.references.find(r => r.kind === 'fk-ref-column')!;
    const refColLine = xmlLines[refCol.line];
    expect(refColLine.substring(refCol.column, refCol.endColumn)).toBe('entity_id');
  });

  it('propagates context to all references', () => {
    const xml = `<?xml version="1.0"?>
<schema xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:framework:Setup/Declaration/Schema/etc/schema.xsd">
    <table name="test_entity" resource="default">
        <column xsi:type="int" name="entity_id"/>
    </table>
</schema>`;
    const result = parseDbSchemaXml(xml, defaultContext);

    for (const ref of result.references) {
      expect(ref.file).toBe(defaultContext.file);
      expect(ref.module).toBe(defaultContext.module);
    }
  });

  it('handles malformed XML gracefully', () => {
    const xml = `<?xml version="1.0"?>
<schema>
    <table name="test_entity" resource="default">
        <column xsi:type="int" name="entity_id"/>
    <!-- missing closing tags -->`;
    const result = parseDbSchemaXml(xml, defaultContext);
    expect(result.references.length).toBeGreaterThan(0);
  });

  it('handles multiline constraint tag', () => {
    const xml = `<?xml version="1.0"?>
<schema xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:framework:Setup/Declaration/Schema/etc/schema.xsd">
    <table name="review" resource="default">
        <constraint
            xsi:type="foreign"
            referenceId="FK_TEST"
            table="review"
            column="entity_id"
            referenceTable="review_entity"
            referenceColumn="entity_id"
            onDelete="CASCADE"/>
    </table>
</schema>`;
    const result = parseDbSchemaXml(xml, defaultContext);

    const refTable = result.references.find(r => r.kind === 'fk-ref-table');
    expect(refTable).toBeDefined();
    expect(refTable!.value).toBe('review_entity');
    expect(refTable!.fkOnDelete).toBe('CASCADE');
  });

  it('resets table context between tables', () => {
    const xml = `<?xml version="1.0"?>
<schema xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:framework:Setup/Declaration/Schema/etc/schema.xsd">
    <table name="first_table" resource="default">
        <column xsi:type="int" name="id" identity="true"/>
    </table>
    <table name="second_table" resource="sales">
        <column xsi:type="int" name="id" identity="true"/>
    </table>
</schema>`;
    const result = parseDbSchemaXml(xml, defaultContext);

    const columns = result.references.filter(r => r.kind === 'column-name');
    expect(columns).toHaveLength(2);
    expect(columns[0].tableName).toBe('first_table');
    expect(columns[1].tableName).toBe('second_table');
  });

  it('does not emit refs for non-foreign constraints', () => {
    const xml = `<?xml version="1.0"?>
<schema xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:framework:Setup/Declaration/Schema/etc/schema.xsd">
    <table name="test_entity" resource="default">
        <column xsi:type="int" name="entity_id" identity="true"/>
        <constraint xsi:type="primary" referenceId="PRIMARY">
            <column name="entity_id"/>
        </constraint>
    </table>
</schema>`;
    const result = parseDbSchemaXml(xml, defaultContext);

    const fkRefs = result.references.filter(
      r => r.kind === 'fk-ref-table' || r.kind === 'fk-ref-column',
    );
    expect(fkRefs).toHaveLength(0);
  });

  it('handles table with no columns or constraints', () => {
    const xml = `<?xml version="1.0"?>
<schema xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:framework:Setup/Declaration/Schema/etc/schema.xsd">
    <table name="empty_table" resource="default" comment="Empty"/>
</schema>`;
    const result = parseDbSchemaXml(xml, defaultContext);

    expect(result.references).toHaveLength(1);
    expect(result.references[0].kind).toBe('table-name');
    expect(result.references[0].value).toBe('empty_table');
  });
});
