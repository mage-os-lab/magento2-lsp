/**
 * Parser for Magento 2 db_schema.xml files.
 *
 * Extracts table, column, and foreign key references for LSP navigation.
 *
 * db_schema.xml structure:
 *   <schema>
 *     <table name="review" resource="default" engine="innodb" comment="Review base info">
 *       <column xsi:type="bigint" name="review_id" unsigned="true" nullable="false"
 *               identity="true" comment="Review ID"/>
 *       <constraint xsi:type="primary" referenceId="PRIMARY">
 *         <column name="review_id"/>
 *       </constraint>
 *       <constraint xsi:type="foreign" referenceId="FK_REVIEW_ENTITY"
 *                   table="review" column="entity_id"
 *                   referenceTable="review_entity" referenceColumn="entity_id"
 *                   onDelete="CASCADE"/>
 *       <constraint xsi:type="unique" referenceId="UNQ_CODE">
 *         <column name="code"/>
 *       </constraint>
 *       <index referenceId="IDX_STATUS" indexType="btree">
 *         <column name="status"/>
 *       </index>
 *     </table>
 *   </schema>
 *
 * db_schema.xml lives at etc/db_schema.xml (always global scope — no area variants).
 * Multiple modules can contribute columns, constraints, and indexes to the same table.
 */

import * as sax from 'sax';
import { DbSchemaReference } from './types';
import { findAttributeValuePosition } from '../utils/xmlPositionUtil';
import { getAttr, getXsiType, installErrorHandler } from '../utils/saxHelpers';

/** Context needed to parse a db_schema.xml file. */
export interface DbSchemaXmlParseContext {
  file: string;
  module: string;
}

/** Result of parsing a db_schema.xml file. */
export interface DbSchemaXmlParseResult {
  references: DbSchemaReference[];
}

/**
 * Parse a db_schema.xml file and extract all table/column/FK references.
 *
 * @param xmlContent  The raw XML content of the db_schema.xml file.
 * @param context     File path and module name for annotating parsed references.
 * @returns           An object containing all extracted DbSchemaReference entries.
 */
export function parseDbSchemaXml(
  xmlContent: string,
  context: DbSchemaXmlParseContext,
): DbSchemaXmlParseResult {
  const references: DbSchemaReference[] = [];
  const lines = xmlContent.split('\n');

  const parser = sax.parser(true, { position: true, trim: false });

  // State tracking during parsing
  let currentTableName = '';
  let currentTableComment = '';
  let currentTableResource = '';
  let currentTableEngine = '';
  /** Nesting depth: 0 = outside table, 1 = inside table, 2+ = inside constraint/index */
  let depth = 0;
  /** Whether we're inside a <constraint> or <index> element (to skip child <column> refs). */
  let insideConstraintOrIndex = false;
  let currentTagStartLine = 0;

  parser.onopentagstart = () => {
    currentTagStartLine = parser.line ?? 0;
  };

  parser.onopentag = (tag) => {
    const tagLine = parser.line ?? 0;
    const tagStartLine = currentTagStartLine;
    const tagName = tag.name.toLowerCase();

    if (tagName === 'table') {
      depth = 1;
      currentTableName = getAttr(tag, 'name') ?? '';
      currentTableComment = getAttr(tag, 'comment') ?? '';
      currentTableResource = getAttr(tag, 'resource') ?? '';
      currentTableEngine = getAttr(tag, 'engine') ?? '';

      if (currentTableName) {
        const pos = findAttributeValuePosition(lines, tagLine, 'name', tagStartLine);
        if (pos) {
          const disabled = getAttr(tag, 'disabled')?.toLowerCase() === 'true';
          references.push({
            kind: 'table-name',
            value: currentTableName,
            tableName: currentTableName,
            tableComment: currentTableComment || undefined,
            tableResource: currentTableResource || undefined,
            tableEngine: currentTableEngine || undefined,
            disabled: disabled || undefined,
            file: context.file,
            line: pos.line,
            column: pos.column,
            endColumn: pos.endColumn,
            module: context.module,
          });
        }
      }
      return;
    }

    if (!currentTableName) return;

    if (tagName === 'column' && depth === 1 && !insideConstraintOrIndex) {
      // Direct child of <table> — a column definition
      const colName = getAttr(tag, 'name');
      if (colName) {
        const pos = findAttributeValuePosition(lines, tagLine, 'name', tagStartLine);
        if (pos) {
          const disabled = getAttr(tag, 'disabled')?.toLowerCase() === 'true';
          references.push({
            kind: 'column-name',
            value: colName,
            tableName: currentTableName,
            columnType: getXsiType(tag),
            columnLength: getAttr(tag, 'length'),
            columnNullable: getAttr(tag, 'nullable'),
            columnIdentity: getAttr(tag, 'identity'),
            columnDefault: getAttr(tag, 'default'),
            columnComment: getAttr(tag, 'comment'),
            columnUnsigned: getAttr(tag, 'unsigned'),
            columnPrecision: getAttr(tag, 'precision'),
            columnScale: getAttr(tag, 'scale'),
            disabled: disabled || undefined,
            file: context.file,
            line: pos.line,
            column: pos.column,
            endColumn: pos.endColumn,
            module: context.module,
          });
        }
      }
      return;
    }

    if (tagName === 'constraint' && depth === 1) {
      depth = 2;
      insideConstraintOrIndex = true;
      const constraintType = getXsiType(tag);

      // Only emit FK reference targets — they are navigable cross-references
      if (constraintType === 'foreign') {
        const referenceId = getAttr(tag, 'referenceId') ?? '';
        const fkTable = getAttr(tag, 'table') ?? '';
        const fkColumn = getAttr(tag, 'column') ?? '';
        const fkRefTable = getAttr(tag, 'referenceTable') ?? '';
        const fkRefColumn = getAttr(tag, 'referenceColumn') ?? '';
        const fkOnDelete = getAttr(tag, 'onDelete') ?? '';

        // Emit fk-ref-table reference (navigable to the referenced table)
        if (fkRefTable) {
          const refTablePos = findAttributeValuePosition(
            lines, tagLine, 'referenceTable', tagStartLine,
          );
          if (refTablePos) {
            references.push({
              kind: 'fk-ref-table',
              value: fkRefTable,
              tableName: currentTableName,
              fkReferenceId: referenceId || undefined,
              fkTable: fkTable || undefined,
              fkColumn: fkColumn || undefined,
              fkRefTable: fkRefTable || undefined,
              fkRefColumn: fkRefColumn || undefined,
              fkOnDelete: fkOnDelete || undefined,
              file: context.file,
              line: refTablePos.line,
              column: refTablePos.column,
              endColumn: refTablePos.endColumn,
              module: context.module,
            });
          }
        }

        // Emit fk-ref-column reference (for validation and hover)
        if (fkRefColumn) {
          const refColPos = findAttributeValuePosition(
            lines, tagLine, 'referenceColumn', tagStartLine,
          );
          if (refColPos) {
            references.push({
              kind: 'fk-ref-column',
              value: fkRefColumn,
              tableName: currentTableName,
              fkReferenceId: referenceId || undefined,
              fkTable: fkTable || undefined,
              fkColumn: fkColumn || undefined,
              fkRefTable: fkRefTable || undefined,
              fkRefColumn: fkRefColumn || undefined,
              fkOnDelete: fkOnDelete || undefined,
              file: context.file,
              line: refColPos.line,
              column: refColPos.column,
              endColumn: refColPos.endColumn,
              module: context.module,
            });
          }
        }
      }
      return;
    }

    if (tagName === 'index' && depth === 1) {
      depth = 2;
      insideConstraintOrIndex = true;
      return;
    }
  };

  parser.onclosetag = (tagName) => {
    const name = tagName.toLowerCase();
    if (name === 'table') {
      currentTableName = '';
      currentTableComment = '';
      currentTableResource = '';
      currentTableEngine = '';
      depth = 0;
      insideConstraintOrIndex = false;
    } else if ((name === 'constraint' || name === 'index') && depth === 2) {
      depth = 1;
      insideConstraintOrIndex = false;
    }
  };

  installErrorHandler(parser);

  parser.write(xmlContent).close();

  return { references };
}
