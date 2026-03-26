/**
 * Parser for Magento 2 routes.xml files.
 *
 * Extracts route definitions mapping URL frontNames to modules.
 *
 * routes.xml structure:
 *   <config>
 *     <router id="standard">
 *       <route id="catalog" frontName="catalog">
 *         <module name="Magento_Catalog"/>
 *         <module name="Magento_CatalogSearch" before="Magento_Catalog"/>
 *       </route>
 *     </router>
 *   </config>
 *
 * routes.xml lives at etc/frontend/routes.xml or etc/adminhtml/routes.xml.
 */

import * as sax from 'sax';
import { RoutesReference } from './types';
import { findAttributeValuePosition } from '../utils/xmlPositionUtil';
import { getAttr, installErrorHandler } from '../utils/saxHelpers';

/** Context needed to parse a routes.xml file. */
export interface RoutesXmlParseContext {
  file: string;
  module: string;
  area: string;
}

/** Result of parsing a routes.xml file. */
export interface RoutesXmlParseResult {
  references: RoutesReference[];
}

/**
 * Parse a routes.xml file and extract all route/module references.
 *
 * @param xmlContent  The raw XML content of the routes.xml file.
 * @param context     File path, module name, and area for annotating parsed references.
 * @returns           An object containing all extracted RoutesReference entries.
 */
export function parseRoutesXml(
  xmlContent: string,
  context: RoutesXmlParseContext,
): RoutesXmlParseResult {
  const references: RoutesReference[] = [];
  const lines = xmlContent.split('\n');

  const parser = sax.parser(true, { position: true, trim: false });

  let currentRouterType = '';
  let currentRouteId = '';
  let currentFrontName = '';
  let currentTagStartLine = 0;

  parser.onopentagstart = () => {
    currentTagStartLine = parser.line ?? 0;
  };

  parser.onopentag = (tag) => {
    const tagLine = parser.line ?? 0;
    const tagStartLine = currentTagStartLine;
    const tagName = tag.name.toLowerCase();

    if (tagName === 'router') {
      currentRouterType = getAttr(tag, 'id') ?? '';
      return;
    }

    if (tagName === 'route') {
      currentRouteId = getAttr(tag, 'id') ?? '';
      currentFrontName = getAttr(tag, 'frontName') ?? '';

      // Emit route-id reference
      if (currentRouteId) {
        const idPos = findAttributeValuePosition(lines, tagLine, 'id', tagStartLine);
        if (idPos) {
          references.push({
            kind: 'route-id',
            value: currentRouteId,
            routerType: currentRouterType,
            frontName: currentFrontName,
            routeId: currentRouteId,
            area: context.area,
            file: context.file,
            line: idPos.line,
            column: idPos.column,
            endColumn: idPos.endColumn,
            module: context.module,
          });
        }
      }

      // Emit route-frontname reference
      if (currentFrontName) {
        const fnPos = findAttributeValuePosition(lines, tagLine, 'frontName', tagStartLine);
        if (fnPos) {
          references.push({
            kind: 'route-frontname',
            value: currentFrontName,
            routerType: currentRouterType,
            frontName: currentFrontName,
            routeId: currentRouteId,
            area: context.area,
            file: context.file,
            line: fnPos.line,
            column: fnPos.column,
            endColumn: fnPos.endColumn,
            module: context.module,
          });
        }
      }
      return;
    }

    if (tagName === 'module' && currentRouteId) {
      const moduleName = getAttr(tag, 'name');
      if (moduleName) {
        const pos = findAttributeValuePosition(lines, tagLine, 'name', tagStartLine);
        if (pos) {
          const before = getAttr(tag, 'before');
          const after = getAttr(tag, 'after');
          const ref: RoutesReference = {
            kind: 'route-module',
            value: moduleName,
            routerType: currentRouterType,
            frontName: currentFrontName,
            routeId: currentRouteId,
            area: context.area,
            file: context.file,
            line: pos.line,
            column: pos.column,
            endColumn: pos.endColumn,
            module: context.module,
          };
          if (before) ref.before = before;
          if (after) ref.after = after;
          references.push(ref);
        }
      }
    }
  };

  parser.onclosetag = (tagName) => {
    const name = tagName.toLowerCase();
    if (name === 'route') {
      currentRouteId = '';
      currentFrontName = '';
    } else if (name === 'router') {
      currentRouterType = '';
    }
  };

  installErrorHandler(parser);

  parser.write(xmlContent).close();

  return { references };
}
