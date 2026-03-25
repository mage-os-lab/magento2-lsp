/**
 * Parser for Magento 2 menu.xml files.
 *
 * Extracts ACL resource references from admin menu item declarations.
 * Each `<add>` element's `resource` attribute is an ACL resource ID that
 * controls whether the menu item is visible to the current admin user.
 *
 * menu.xml structure:
 *   <config>
 *     <menu>
 *       <add id="Magento_Customer::customer_manage" title="All Customers"
 *            resource="Magento_Customer::manage" action="customer/index/"
 *            parent="Magento_Customer::customer" module="Magento_Customer"/>
 *     </menu>
 *   </config>
 *
 * menu.xml only lives at etc/adminhtml/menu.xml (no area variants).
 */

import * as sax from 'sax';
import { MenuReference } from './types';
import { findAttributeValuePosition } from '../utils/xmlPositionUtil';
import { getAttr, installErrorHandler } from '../utils/saxHelpers';

/** Context needed to parse a menu.xml file. */
export interface MenuXmlParseContext {
  file: string;
  module: string;
}

/** Result of parsing a menu.xml file. */
export interface MenuXmlParseResult {
  references: MenuReference[];
}

/**
 * Parse a menu.xml file and extract all ACL resource references from menu items.
 *
 * @param xmlContent  The raw XML content of the menu.xml file.
 * @param context     File path and module name for annotating parsed references.
 * @returns           An object containing all extracted MenuReference entries.
 */
export function parseMenuXml(
  xmlContent: string,
  context: MenuXmlParseContext,
): MenuXmlParseResult {
  const references: MenuReference[] = [];
  const lines = xmlContent.split('\n');

  const parser = sax.parser(true, { position: true, trim: false });

  let insideMenu = false;
  let currentTagStartLine = 0;

  parser.onopentagstart = () => {
    currentTagStartLine = parser.line ?? 0;
  };

  parser.onopentag = (tag) => {
    const tagLine = parser.line ?? 0;
    const tagStartLine = currentTagStartLine;
    const tagName = tag.name.toLowerCase();

    if (tagName === 'menu') {
      insideMenu = true;
      return;
    }

    if (tagName === 'add' && insideMenu) {
      const resource = getAttr(tag, 'resource');
      if (resource) {
        const id = getAttr(tag, 'id') ?? '';
        const title = getAttr(tag, 'title') ?? '';

        // Track the position of the resource attribute value (the navigation target)
        const pos = findAttributeValuePosition(lines, tagLine, 'resource', tagStartLine);
        if (pos) {
          references.push({
            value: resource,
            menuItemId: id,
            menuItemTitle: title,
            file: context.file,
            line: pos.line,
            column: pos.column,
            endColumn: pos.endColumn,
            module: context.module,
          });
        }
      }
    }
  };

  parser.onclosetag = (tagName) => {
    if (tagName.toLowerCase() === 'menu') {
      insideMenu = false;
    }
  };

  installErrorHandler(parser);

  parser.write(xmlContent).close();

  return { references };
}
