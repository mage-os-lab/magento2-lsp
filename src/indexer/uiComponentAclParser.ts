/**
 * Lightweight parser for ACL resource references in Magento 2 UI component XML files.
 *
 * Only extracts `<aclResource>` text elements — everything else in these
 * (often large) UI component files is ignored. The `<aclResource>` element
 * controls access to admin data grids and forms.
 *
 * UI component structure (only relevant part shown):
 *   <listing>
 *     <dataSource name="customer_listing_data_source">
 *       <aclResource>Magento_Customer::manage</aclResource>
 *       ...
 *     </dataSource>
 *   </listing>
 *
 * Files live at view/adminhtml/ui_component/*.xml.
 */

import * as sax from 'sax';
import { UiComponentAclReference } from './types';
import { findTextContentPosition } from '../utils/xmlPositionUtil';
import { installErrorHandler } from '../utils/saxHelpers';

/** Context needed to parse a UI component XML file. */
export interface UiComponentAclParseContext {
  file: string;
  module: string;
}

/** Result of parsing a UI component XML file for ACL references. */
export interface UiComponentAclParseResult {
  references: UiComponentAclReference[];
}

/**
 * Parse a UI component XML file and extract `<aclResource>` text elements.
 *
 * @param xmlContent  The raw XML content of the UI component file.
 * @param context     File path and module name for annotating parsed references.
 * @returns           An object containing all extracted UiComponentAclReference entries.
 */
export function parseUiComponentAcl(
  xmlContent: string,
  context: UiComponentAclParseContext,
): UiComponentAclParseResult {
  const references: UiComponentAclReference[] = [];
  const lines = xmlContent.split('\n');

  const parser = sax.parser(true, { position: true, trim: false });

  let collectingAclResource = false;
  let collectedText = '';
  let tagStartLine = 0;

  parser.onopentagstart = () => {
    tagStartLine = parser.line ?? 0;
  };

  parser.onopentag = (tag) => {
    // Case-insensitive match for <aclResource>
    if (tag.name === 'aclResource' || tag.name === 'aclresource') {
      collectingAclResource = true;
      collectedText = '';
    }
  };

  parser.ontext = (text) => {
    if (collectingAclResource) {
      collectedText += text;
    }
  };

  parser.oncdata = (cdata) => {
    if (collectingAclResource) {
      collectedText += cdata;
    }
  };

  parser.onclosetag = (tagName) => {
    if (collectingAclResource && (tagName === 'aclResource' || tagName === 'aclresource')) {
      const trimmed = collectedText.trim();
      if (trimmed) {
        const pos = findTextContentPosition(lines, tagStartLine, trimmed);
        if (pos) {
          references.push({
            value: trimmed,
            file: context.file,
            line: pos.line,
            column: pos.column,
            endColumn: pos.endColumn,
            module: context.module,
          });
        }
      }
      collectingAclResource = false;
      collectedText = '';
    }
  };

  installErrorHandler(parser);

  parser.write(xmlContent).close();

  return { references };
}
