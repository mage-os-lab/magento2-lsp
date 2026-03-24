/**
 * Parser for Magento 2 di.xml files.
 *
 * This is the core of the LSP — it extracts every PHP class reference from a di.xml file
 * along with its exact line/column position. The parser uses a SAX (streaming) approach
 * via the `sax` library, which gives us line numbers for each XML event.
 *
 * However, SAX only reports the position of the opening tag, not individual attributes.
 * To get precise column positions for attribute values (where the FQCN strings live),
 * we do a secondary scan on the raw XML lines using xmlPositionUtil.
 *
 * The parser handles these di.xml elements:
 *   - <preference for="Interface" type="Implementation" />
 *   - <type name="ClassName">
 *   - <plugin name="..." type="PluginClass" />
 *   - <argument xsi:type="object">ClassName</argument>
 *   - <item xsi:type="object">ClassName</item>
 *   - <virtualType name="VTypeName" type="ParentClass">
 *
 * Arguments and items with xsi:type other than "object" (e.g., "string", "array", "number")
 * are ignored because they don't contain class references.
 */

import * as sax from 'sax';
import { DiReference, ReferenceKind, VirtualTypeDecl } from './types';
import { normalizeFqcn } from '../utils/fqcnNormalize';
import {
  findAttributeValuePosition,
  findTextContentPosition,
} from '../utils/xmlPositionUtil';

/** Metadata about the di.xml file being parsed — propagated into every DiReference. */
export interface DiXmlParseContext {
  file: string;
  area: string;
  module: string;
  moduleOrder: number;
}

export interface DiXmlParseResult {
  references: DiReference[];
  virtualTypes: VirtualTypeDecl[];
}

/**
 * Tracks state for <argument>/<item> elements with xsi:type="object".
 * We need to collect the text content between the opening and closing tags,
 * which arrives via ontext/oncdata events before the onclosetag event.
 */
interface PendingArgument {
  tagLine: number;
  xsiType: string;
}

/**
 * Parse a di.xml file and extract all PHP class references with precise positions.
 *
 * @param xmlContent - The raw XML string.
 * @param context    - File metadata (path, area, module, load order).
 * @returns All references and virtualType declarations found in the file.
 */
export function parseDiXml(
  xmlContent: string,
  context: DiXmlParseContext,
): DiXmlParseResult {
  const references: DiReference[] = [];
  const virtualTypes: VirtualTypeDecl[] = [];
  const lines = xmlContent.split('\n');

  // strict=true for well-formed XML; position=true to get line numbers from the parser
  const parser = sax.parser(true, { position: true, trim: false });

  // State for collecting text content inside <argument xsi:type="object"> elements.
  // Set when we enter such an element, cleared when we leave it.
  let pendingArgument: PendingArgument | undefined;
  let argumentText = '';

  // Tracks the FQCN of the current <type> or <virtualType> element for proper
  // nesting context on child <plugin> elements.
  let currentTypeFqcn: string | undefined;
  let currentTagStartLine = 0;

  parser.onopentagstart = () => {
    currentTagStartLine = parser.line ?? 0;
  };

  parser.onopentag = (tag) => {
    const tagLine = (parser.line ?? 0);
    const tagStartLine = currentTagStartLine;
    const tagName = tag.name.toLowerCase();

    if (tagName === 'preference') {
      handlePreference(tag, tagLine, tagStartLine, lines, context, references);
    } else if (tagName === 'type') {
      handleType(tag, tagLine, tagStartLine, lines, context, references);
      currentTypeFqcn = extractTagNameFqcn(tag);
    } else if (tagName === 'virtualtype') {
      handleVirtualType(tag, tagLine, tagStartLine, lines, context, references, virtualTypes);
      currentTypeFqcn = extractTagNameFqcn(tag);
    } else if (tagName === 'plugin') {
      handlePlugin(tag, tagLine, tagStartLine, lines, context, references, currentTypeFqcn);
    } else if (tagName === 'argument' || tagName === 'item') {
      // Only <argument>/<item> elements with xsi:type="object" contain class references.
      // Others (string, array, number, const, init_parameter) are not PHP classes.
      const xsiType = getXsiType(tag);
      if (xsiType === 'object') {
        pendingArgument = { tagLine, xsiType };
        argumentText = '';
      }
    }
  };

  // Accumulate text content — the FQCN is the text between <argument> and </argument>
  parser.ontext = (text) => {
    if (pendingArgument) {
      argumentText += text;
    }
  };

  // CDATA sections (rare in di.xml, but handle for completeness)
  parser.oncdata = (cdata) => {
    if (pendingArgument) {
      argumentText += cdata;
    }
  };

  parser.onclosetag = (tagName) => {
    const name = tagName.toLowerCase();
    if (name === 'type' || name === 'virtualtype') {
      currentTypeFqcn = undefined;
    }
    if ((name === 'argument' || name === 'item') && pendingArgument) {
      handleArgumentObject(
        argumentText,
        pendingArgument.tagLine,
        lines,
        context,
        references,
      );
      pendingArgument = undefined;
      argumentText = '';
    }
  };

  parser.onerror = () => {
    // On parse errors (malformed XML), reset the error and continue.
    // This gives us best-effort results — we get references from the valid portion.
    parser.error = null as unknown as Error;
    parser.resume();
  };

  parser.write(xmlContent).close();

  return { references, virtualTypes };
}

/**
 * Handle <preference for="InterfaceFqcn" type="ImplementationFqcn" />.
 * Emits two references: one for the 'for' attribute (the interface) and one for 'type'
 * (the implementation). The pairedFqcn field links them so the definition handler can
 * navigate from interface to implementation.
 */
function handlePreference(
  tag: sax.Tag | sax.QualifiedTag,
  tagLine: number,
  tagStartLine: number,
  lines: string[],
  context: DiXmlParseContext,
  references: DiReference[],
): void {
  const forAttr = tag.attributes['for'] ?? tag.attributes['FOR'];
  const typeAttr = tag.attributes['type'] ?? tag.attributes['TYPE'];

  // sax may return attributes as strings or as {value, ...} objects depending on mode
  const forValue = typeof forAttr === 'string' ? forAttr : forAttr?.value;
  const typeValue = typeof typeAttr === 'string' ? typeAttr : typeAttr?.value;

  if (forValue) {
    const normalizedFor = normalizeFqcn(forValue);
    const normalizedType = typeValue ? normalizeFqcn(typeValue) : undefined;
    const pos = findAttributeValuePosition(lines, tagLine, 'for', tagStartLine);
    if (pos) {
      references.push({
        fqcn: normalizedFor,
        kind: 'preference-for',
        file: context.file,
        line: pos.line,
        column: pos.column,
        endColumn: pos.endColumn,
        area: context.area,
        module: context.module,
        moduleOrder: context.moduleOrder,
        pairedFqcn: normalizedType,
      });
    }
  }

  if (typeValue) {
    const normalizedType = normalizeFqcn(typeValue);
    const normalizedFor = forValue ? normalizeFqcn(forValue) : undefined;
    const pos = findAttributeValuePosition(lines, tagLine, 'type', tagStartLine);
    if (pos) {
      references.push({
        fqcn: normalizedType,
        kind: 'preference-type',
        file: context.file,
        line: pos.line,
        column: pos.column,
        endColumn: pos.endColumn,
        area: context.area,
        module: context.module,
        moduleOrder: context.moduleOrder,
        pairedFqcn: normalizedFor,
      });
    }
  }
}

/** Handle <type name="ClassName">. The name attribute is the PHP FQCN being configured. */
function handleType(
  tag: sax.Tag | sax.QualifiedTag,
  tagLine: number,
  tagStartLine: number,
  lines: string[],
  context: DiXmlParseContext,
  references: DiReference[],
): void {
  const nameAttr = tag.attributes['name'] ?? tag.attributes['NAME'];
  const nameValue = typeof nameAttr === 'string' ? nameAttr : nameAttr?.value;

  if (nameValue) {
    const normalized = normalizeFqcn(nameValue);
    const pos = findAttributeValuePosition(lines, tagLine, 'name', tagStartLine);
    if (pos) {
      references.push({
        fqcn: normalized,
        kind: 'type-name',
        file: context.file,
        line: pos.line,
        column: pos.column,
        endColumn: pos.endColumn,
        area: context.area,
        module: context.module,
        moduleOrder: context.moduleOrder,
      });
    }
  }
}

/**
 * Handle <virtualType name="VTypeName" type="ParentClass">.
 *
 * Emits references for both attributes, plus a VirtualTypeDecl so the index can track
 * virtualType names separately (for "go to definition" on virtualType references).
 */
function handleVirtualType(
  tag: sax.Tag | sax.QualifiedTag,
  tagLine: number,
  tagStartLine: number,
  lines: string[],
  context: DiXmlParseContext,
  references: DiReference[],
  virtualTypeDecls: VirtualTypeDecl[],
): void {
  const nameAttr = tag.attributes['name'] ?? tag.attributes['NAME'];
  const typeAttr = tag.attributes['type'] ?? tag.attributes['TYPE'];

  const nameValue = typeof nameAttr === 'string' ? nameAttr : nameAttr?.value;
  const typeValue = typeof typeAttr === 'string' ? typeAttr : typeAttr?.value;

  if (nameValue) {
    const normalizedName = normalizeFqcn(nameValue);
    const pos = findAttributeValuePosition(lines, tagLine, 'name', tagStartLine);
    if (pos) {
      references.push({
        fqcn: normalizedName,
        kind: 'virtualtype-name',
        file: context.file,
        line: pos.line,
        column: pos.column,
        endColumn: pos.endColumn,
        area: context.area,
        module: context.module,
        moduleOrder: context.moduleOrder,
      });

      virtualTypeDecls.push({
        name: normalizedName,
        parentType: typeValue ? normalizeFqcn(typeValue) : '',
        file: context.file,
        line: pos.line,
        column: pos.column,
        area: context.area,
        module: context.module,
        moduleOrder: context.moduleOrder,
      });
    }
  }

  if (typeValue) {
    const normalized = normalizeFqcn(typeValue);
    const pos = findAttributeValuePosition(lines, tagLine, 'type', tagStartLine);
    if (pos) {
      references.push({
        fqcn: normalized,
        kind: 'virtualtype-type',
        file: context.file,
        line: pos.line,
        column: pos.column,
        endColumn: pos.endColumn,
        area: context.area,
        module: context.module,
        moduleOrder: context.moduleOrder,
      });
    }
  }
}

/**
 * Handle <plugin type="PluginClass" />.
 * Note: plugins without a type attribute (e.g., disabled="true" overrides) are skipped.
 */
function handlePlugin(
  tag: sax.Tag | sax.QualifiedTag,
  tagLine: number,
  tagStartLine: number,
  lines: string[],
  context: DiXmlParseContext,
  references: DiReference[],
  parentTypeFqcn: string | undefined,
): void {
  const typeAttr = tag.attributes['type'] ?? tag.attributes['TYPE'];
  const typeValue = typeof typeAttr === 'string' ? typeAttr : typeAttr?.value;

  if (typeValue) {
    const normalized = normalizeFqcn(typeValue);
    const pos = findAttributeValuePosition(lines, tagLine, 'type', tagStartLine);
    if (pos) {
      references.push({
        fqcn: normalized,
        kind: 'plugin-type',
        file: context.file,
        line: pos.line,
        column: pos.column,
        endColumn: pos.endColumn,
        area: context.area,
        module: context.module,
        moduleOrder: context.moduleOrder,
        parentTypeFqcn,
      });
    }
  }
}

/**
 * Handle the text content of <argument xsi:type="object">ClassName</argument>.
 * The FQCN is the trimmed text between the opening and closing tags.
 */
function handleArgumentObject(
  textContent: string,
  tagLine: number,
  lines: string[],
  context: DiXmlParseContext,
  references: DiReference[],
): void {
  const trimmed = textContent.trim();
  if (!trimmed) return;

  const normalized = normalizeFqcn(trimmed);
  const pos = findTextContentPosition(lines, tagLine, trimmed);
  if (pos) {
    references.push({
      fqcn: normalized,
      kind: 'argument-object',
      file: context.file,
      line: pos.line,
      column: pos.column,
      endColumn: pos.endColumn,
      area: context.area,
      module: context.module,
      moduleOrder: context.moduleOrder,
    });
  }
}

/**
 * Extract the xsi:type attribute value from a tag.
 * Handles case variations since XML attribute names are case-sensitive but
 * some Magento modules may use inconsistent casing.
 */
/** Extract and normalize the name attribute from a <type> or <virtualType> tag. */
function extractTagNameFqcn(tag: sax.Tag | sax.QualifiedTag): string | undefined {
  const nameAttr = tag.attributes['name'] ?? tag.attributes['NAME'];
  const nameValue = typeof nameAttr === 'string' ? nameAttr : nameAttr?.value;
  return nameValue ? normalizeFqcn(nameValue) : undefined;
}

function getXsiType(tag: sax.Tag | sax.QualifiedTag): string | undefined {
  const attr =
    tag.attributes['xsi:type'] ??
    tag.attributes['XSI:TYPE'] ??
    tag.attributes['xsi:Type'];
  if (!attr) return undefined;
  const value = typeof attr === 'string' ? attr : attr.value;
  return value?.toLowerCase();
}
