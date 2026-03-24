/**
 * Parser for Magento 2 layout and page_layout XML files.
 *
 * Extracts navigable references:
 *   - Block PHP classes from `class` attributes on `<block>` elements
 *   - Template identifiers from `template` attributes on `<block>` and `<referenceBlock>`
 *   - PHP classes from `<argument xsi:type="object">` (ViewModels, etc.)
 *
 * Template identifiers can be:
 *   - Full: `Magento_Catalog::product/view.phtml` (module + :: + path)
 *   - Short: `product/view.phtml` (path only, module inferred from block class)
 *
 * When a template has no module prefix, the module is inferred from the enclosing
 * block's `class` attribute using Magento's convention: extract the namespace before
 * `\Block\` and convert backslashes to underscores.
 */

import * as sax from 'sax';
import { LayoutReference } from './types';
import { normalizeFqcn } from '../utils/fqcnNormalize';
import {
  findAttributeValuePosition,
  findTextContentPosition,
} from '../utils/xmlPositionUtil';
import { getAttr, getXsiType, installErrorHandler } from '../utils/saxHelpers';

export interface LayoutXmlParseResult {
  references: LayoutReference[];
}

/**
 * Extract the Magento module name from a block class FQCN.
 *
 * Follows Magento's convention: take the namespace before `\Block\` and
 * convert backslashes to underscores.
 *   Magento\Catalog\Block\Product\View -> Magento_Catalog
 *   Vendor\Module\Block\Foo -> Vendor_Module
 *
 * Returns empty string if the class doesn't follow the Block convention.
 */
export function extractModuleName(className: string): string {
  if (!className) return '';
  const blockIdx = className.indexOf('\\Block\\');
  if (blockIdx === -1) return '';
  const namespace = className.substring(0, blockIdx);
  return namespace.replace(/\\/g, '_');
}

export function parseLayoutXml(
  xmlContent: string,
  file: string,
): LayoutXmlParseResult {
  const references: LayoutReference[] = [];
  const lines = xmlContent.split('\n');

  const parser = sax.parser(true, { position: true, trim: false });

  // Stack of block class FQCNs for resolving short template paths.
  // When we enter a <block class="...">, push the class; on close, pop.
  const blockClassStack: string[] = [];
  let pendingArgument: { tagLine: number } | undefined;
  let argumentText = '';
  // Track the line where `<tagName` starts (before attributes are parsed).
  // SAX onopentag fires at the closing `>`, so parser.line there may be past
  // multi-line attributes. onopentagstart fires at `<tagName`.
  let currentTagStartLine = 0;

  parser.onopentagstart = () => {
    currentTagStartLine = parser.line ?? 0;
  };

  parser.onopentag = (tag) => {
    const tagLine = parser.line ?? 0;
    const tagName = tag.name.toLowerCase();

    if (tagName === 'block') {
      handleBlock(tag, tagLine, currentTagStartLine, lines, file, references, blockClassStack);
    } else if (tagName === 'referenceblock') {
      handleReferenceBlock(tag, tagLine, currentTagStartLine, lines, file, references, blockClassStack);
    } else if (tagName === 'update') {
      const handleAttr = getAttr(tag, 'handle');
      if (handleAttr) {
        const pos = findAttributeValuePosition(lines, tagLine, 'handle', currentTagStartLine);
        if (pos) {
          references.push({
            kind: 'update-handle',
            value: handleAttr,
            file,
            line: pos.line,
            column: pos.column,
            endColumn: pos.endColumn,
          });
        }
      }
    } else if (tagName === 'argument' || tagName === 'item') {
      const xsiType = getXsiType(tag);
      if (xsiType === 'object') {
        pendingArgument = { tagLine };
        argumentText = '';
      }
    }
  };

  parser.ontext = (text) => {
    if (pendingArgument) {
      argumentText += text;
    }
  };

  parser.oncdata = (cdata) => {
    if (pendingArgument) {
      argumentText += cdata;
    }
  };

  parser.onclosetag = (tagName) => {
    const name = tagName.toLowerCase();

    if (name === 'block') {
      blockClassStack.pop();
    } else if ((name === 'argument' || name === 'item') && pendingArgument) {
      const trimmed = argumentText.trim();
      if (trimmed) {
        const normalized = normalizeFqcn(trimmed);
        const pos = findTextContentPosition(lines, pendingArgument.tagLine, trimmed);
        if (pos) {
          references.push({
            kind: 'argument-object',
            value: normalized,
            file,
            line: pos.line,
            column: pos.column,
            endColumn: pos.endColumn,
          });
        }
      }
      pendingArgument = undefined;
      argumentText = '';
    }
  };

  installErrorHandler(parser);

  parser.write(xmlContent).close();

  return { references };
}

function handleBlock(
  tag: sax.Tag | sax.QualifiedTag,
  tagLine: number,
  tagStartLine: number,
  lines: string[],
  file: string,
  references: LayoutReference[],
  blockClassStack: string[],
): void {
  const classAttr = getAttr(tag, 'class');
  const templateAttr = getAttr(tag, 'template');

  // Track block class for short template resolution
  const blockClass = classAttr ? normalizeFqcn(classAttr) : '';
  blockClassStack.push(blockClass);

  // Block class reference
  if (classAttr) {
    const normalized = normalizeFqcn(classAttr);
    const pos = findAttributeValuePosition(lines, tagLine, 'class', tagStartLine);
    if (pos) {
      references.push({
        kind: 'block-class',
        value: normalized,
        file,
        line: pos.line,
        column: pos.column,
        endColumn: pos.endColumn,
      });
    }
  }

  // Template reference
  if (templateAttr) {
    const pos = findAttributeValuePosition(lines, tagLine, 'template', tagStartLine);
    if (pos) {
      const resolved = resolveTemplateId(templateAttr, blockClass);
      references.push({
        kind: 'block-template',
        value: templateAttr,
        resolvedTemplateId: resolved,
        file,
        line: pos.line,
        column: pos.column,
        endColumn: pos.endColumn,
      });
    }
  }
}

function handleReferenceBlock(
  tag: sax.Tag | sax.QualifiedTag,
  tagLine: number,
  tagStartLine: number,
  lines: string[],
  file: string,
  references: LayoutReference[],
  blockClassStack: string[],
): void {
  const templateAttr = getAttr(tag, 'template');

  if (templateAttr) {
    const pos = findAttributeValuePosition(lines, tagLine, 'template', tagStartLine);
    if (pos) {
      // For referenceBlock, use the nearest block class from the stack for short paths
      const parentClass = blockClassStack.length > 0
        ? blockClassStack[blockClassStack.length - 1]
        : '';
      const resolved = resolveTemplateId(templateAttr, parentClass);
      references.push({
        kind: 'refblock-template',
        value: templateAttr,
        resolvedTemplateId: resolved,
        file,
        line: pos.line,
        column: pos.column,
        endColumn: pos.endColumn,
      });
    }
  }
}

/**
 * Resolve a template identifier. If it already has a module prefix (contains ::),
 * return as-is. Otherwise, infer the module from the block class.
 */
function resolveTemplateId(templateAttr: string, blockClass: string): string {
  if (templateAttr.includes('::')) {
    return templateAttr;
  }
  // Short path — infer module from block class
  const moduleName = extractModuleName(blockClass);
  if (moduleName) {
    return `${moduleName}::${templateAttr}`;
  }
  // Can't resolve without a block class
  return templateAttr;
}

