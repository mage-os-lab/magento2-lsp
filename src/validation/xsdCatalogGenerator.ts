/**
 * Generate an OASIS XML Catalog for resolving Magento URNs in XSD schemas.
 *
 * When validating an XML file against its XSD schema, the XSD may include other schemas
 * via URN-based schemaLocation attributes (e.g., urn:magento:framework:Data/etc/argument/types.xsd).
 * xmllint cannot resolve these URNs natively, but it supports XML Catalogs that map URIs to
 * local file paths. This module generates such a catalog by recursively scanning XSD files
 * for URN references and resolving each to an absolute path.
 */

import * as fs from 'fs';
import { ModuleInfo } from '../indexer/types';
import { resolveXmlUrn } from '../utils/xmlUrnResolver';

/** Matches URN references in schemaLocation attributes within XSD files. */
const SCHEMA_LOCATION_URN_RE = /schemaLocation="(urn:magento:[^"]+)"/g;

/**
 * Build an XML catalog string by starting from a root XSD file and recursively
 * discovering all URN references in xs:include and xs:redefine elements.
 *
 * Returns the catalog XML content as a string.
 */
export function generateXsdCatalog(
  rootXsdPath: string,
  magentoRoot: string,
  modules: ModuleInfo[],
): string {
  const urnMap = new Map<string, string>();
  const visited = new Set<string>();

  collectUrns(rootXsdPath, magentoRoot, modules, urnMap, visited);

  return buildCatalogXml(urnMap);
}

/**
 * Recursively scan an XSD file for URN-based schemaLocation attributes.
 * Adds each discovered URN and its resolved path to the map.
 */
function collectUrns(
  xsdPath: string,
  magentoRoot: string,
  modules: ModuleInfo[],
  urnMap: Map<string, string>,
  visited: Set<string>,
): void {
  if (visited.has(xsdPath)) return;
  visited.add(xsdPath);

  let content: string;
  try {
    content = fs.readFileSync(xsdPath, 'utf-8');
  } catch {
    return;
  }

  SCHEMA_LOCATION_URN_RE.lastIndex = 0;
  let match;
  while ((match = SCHEMA_LOCATION_URN_RE.exec(content)) !== null) {
    const urn = match[1];
    if (urnMap.has(urn)) continue;

    const resolved = resolveXmlUrn(urn, magentoRoot, modules);
    if (resolved) {
      urnMap.set(urn, resolved);
      // Recurse into the included XSD
      collectUrns(resolved, magentoRoot, modules, urnMap, visited);
    }
  }
}

/**
 * Build OASIS XML Catalog content from a URN-to-path mapping.
 */
function buildCatalogXml(urnMap: Map<string, string>): string {
  const entries = Array.from(urnMap.entries())
    .map(([urn, filePath]) =>
      `  <uri name="${escapeXmlAttr(urn)}" uri="file://${escapeXmlAttr(filePath)}"/>`,
    )
    .join('\n');

  return `<?xml version="1.0"?>
<catalog xmlns="urn:oasis:names:tc:entity:xmlns:xml:catalog">
${entries}
</catalog>
`;
}

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
