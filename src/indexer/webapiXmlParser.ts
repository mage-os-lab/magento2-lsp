/**
 * Parser for Magento 2 webapi.xml files.
 *
 * Extracts REST API route references with precise line/column positions:
 *   - Service class FQCNs (<service class="..."/>)
 *   - Service method names (<service method="..."/>)
 *   - ACL resource identifiers (<resource ref="..."/>)
 *
 * Each reference carries the parent route's URL and HTTP method as context.
 *
 * webapi.xml structure:
 *   <routes>
 *     <route url="/V1/customers/:customerId" method="GET">
 *       <service class="Magento\Customer\Api\CustomerRepositoryInterface" method="getById"/>
 *       <resources>
 *         <resource ref="Magento_Customer::manage"/>
 *       </resources>
 *     </route>
 *   </routes>
 */

import * as sax from 'sax';
import { WebapiReference } from './types';
import { normalizeFqcn } from '../utils/fqcnNormalize';
import { findAttributeValuePosition } from '../utils/xmlPositionUtil';
import { getAttr, installErrorHandler } from '../utils/saxHelpers';

export interface WebapiXmlParseContext {
  file: string;
  module: string;
}

export interface WebapiXmlParseResult {
  references: WebapiReference[];
}

interface RouteContext {
  url: string;
  httpMethod: string;
}

export function parseWebapiXml(
  xmlContent: string,
  context: WebapiXmlParseContext,
): WebapiXmlParseResult {
  const references: WebapiReference[] = [];
  const lines = xmlContent.split('\n');

  const parser = sax.parser(true, { position: true, trim: false });

  let currentRoute: RouteContext | undefined;
  let currentTagStartLine = 0;

  parser.onopentagstart = () => {
    currentTagStartLine = parser.line ?? 0;
  };

  parser.onopentag = (tag) => {
    const tagLine = parser.line ?? 0;
    const tagStartLine = currentTagStartLine;
    const tagName = tag.name.toLowerCase();

    if (tagName === 'route') {
      const url = getAttr(tag, 'url') ?? '';
      const method = getAttr(tag, 'method') ?? '';
      currentRoute = { url, httpMethod: method.toUpperCase() };
      return;
    }

    if (!currentRoute) return;

    if (tagName === 'service') {
      const serviceClass = getAttr(tag, 'class');
      const serviceMethod = getAttr(tag, 'method');

      if (serviceClass) {
        const fqcn = normalizeFqcn(serviceClass);
        const pos = findAttributeValuePosition(lines, tagLine, 'class', tagStartLine);
        if (pos) {
          references.push({
            kind: 'service-class',
            value: fqcn,
            fqcn,
            methodName: serviceMethod,
            routeUrl: currentRoute.url,
            httpMethod: currentRoute.httpMethod,
            file: context.file,
            line: pos.line,
            column: pos.column,
            endColumn: pos.endColumn,
            module: context.module,
          });
        }
      }

      if (serviceMethod && serviceClass) {
        const fqcn = normalizeFqcn(serviceClass);
        const pos = findAttributeValuePosition(lines, tagLine, 'method', tagStartLine);
        if (pos) {
          references.push({
            kind: 'service-method',
            value: serviceMethod,
            fqcn,
            methodName: serviceMethod,
            routeUrl: currentRoute.url,
            httpMethod: currentRoute.httpMethod,
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

    if (tagName === 'resource') {
      const ref = getAttr(tag, 'ref');
      if (ref) {
        const pos = findAttributeValuePosition(lines, tagLine, 'ref', tagStartLine);
        if (pos) {
          references.push({
            kind: 'resource-ref',
            value: ref,
            routeUrl: currentRoute.url,
            httpMethod: currentRoute.httpMethod,
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
    if (tagName.toLowerCase() === 'route') {
      currentRoute = undefined;
    }
  };

  installErrorHandler(parser);

  parser.write(xmlContent).close();

  return { references };
}
