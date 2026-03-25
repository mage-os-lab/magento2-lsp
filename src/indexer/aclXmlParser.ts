/**
 * Parser for Magento 2 acl.xml files.
 *
 * Extracts ACL resource definitions with precise line/column positions from the
 * hierarchical resource tree. Each resource carries its full ancestry path so
 * handlers can display breadcrumb-style hierarchy information.
 *
 * acl.xml structure:
 *   <config>
 *     <acl>
 *       <resources>
 *         <resource id="Magento_Backend::admin" title="Magento Admin">
 *           <resource id="Magento_Customer::customer" title="Customers" sortOrder="40">
 *             <resource id="Magento_Customer::manage" title="All Customers" sortOrder="10"/>
 *           </resource>
 *         </resource>
 *       </resources>
 *     </acl>
 *   </config>
 *
 * Unlike di.xml or events.xml, acl.xml has no area scoping — it only lives
 * at etc/acl.xml (never under etc/frontend/ or etc/adminhtml/).
 */

import * as sax from 'sax';
import { AclResource } from './types';
import { findAttributeValuePosition } from '../utils/xmlPositionUtil';
import { getAttr, installErrorHandler } from '../utils/saxHelpers';

/** Context needed to parse an acl.xml file (file path and owning module). */
export interface AclXmlParseContext {
  file: string;
  module: string;
}

/** Result of parsing an acl.xml file. */
export interface AclXmlParseResult {
  resources: AclResource[];
}

/**
 * Parse an acl.xml file and extract all ACL resource definitions.
 *
 * Uses a SAX streaming parser to walk the `<resource>` elements nested under
 * `<config><acl><resources>`. A stack tracks the current position in the
 * resource hierarchy so each resource knows its full ancestry path.
 *
 * @param xmlContent  The raw XML content of the acl.xml file.
 * @param context     File path and module name for annotating parsed resources.
 * @returns           An object containing all extracted AclResource definitions.
 */
export function parseAclXml(
  xmlContent: string,
  context: AclXmlParseContext,
): AclXmlParseResult {
  const resources: AclResource[] = [];
  const lines = xmlContent.split('\n');

  const parser = sax.parser(true, { position: true, trim: false });

  // Stack of resource IDs tracking the current nesting depth.
  // When we encounter a nested <resource>, the parent's ID is on top of the stack,
  // letting us build the full hierarchy path for each resource.
  const idStack: string[] = [];

  // Track whether we're inside the <resources> container element.
  // We ignore <resource> elements that appear outside this container.
  let insideResources = false;

  let currentTagStartLine = 0;

  parser.onopentagstart = () => {
    currentTagStartLine = parser.line ?? 0;
  };

  parser.onopentag = (tag) => {
    const tagLine = parser.line ?? 0;
    const tagStartLine = currentTagStartLine;
    const tagName = tag.name.toLowerCase();

    if (tagName === 'resources') {
      insideResources = true;
      return;
    }

    if (tagName === 'resource' && insideResources) {
      const id = getAttr(tag, 'id');
      const title = getAttr(tag, 'title') ?? '';
      const sortOrderStr = getAttr(tag, 'sortOrder');
      const sortOrder = sortOrderStr ? parseInt(sortOrderStr, 10) : undefined;

      if (id) {
        const parentId = idStack.length > 0 ? idStack[idStack.length - 1] : undefined;
        const hierarchyPath = [...idStack, id];

        // Position is tracked on the `id` attribute value because that's the
        // navigation target for go-to-definition from webapi.xml resource refs.
        const pos = findAttributeValuePosition(lines, tagLine, 'id', tagStartLine);
        if (pos) {
          resources.push({
            id,
            title,
            parentId,
            hierarchyPath,
            sortOrder: sortOrder !== undefined && !isNaN(sortOrder) ? sortOrder : undefined,
            file: context.file,
            line: pos.line,
            column: pos.column,
            endColumn: pos.endColumn,
            module: context.module,
          });
        }

        // Push onto stack so nested <resource> elements know their parent
        idStack.push(id);
      }
    }
  };

  parser.onclosetag = (tagName) => {
    const lower = tagName.toLowerCase();
    if (lower === 'resources') {
      insideResources = false;
      return;
    }
    if (lower === 'resource' && insideResources) {
      idStack.pop();
    }
  };

  installErrorHandler(parser);

  parser.write(xmlContent).close();

  return { resources };
}
