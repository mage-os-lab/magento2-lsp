/**
 * Resolve Magento XML URNs to filesystem paths.
 *
 * Magento XML files reference XSD schemas via URNs like:
 *   urn:magento:framework:ObjectManager/etc/config.xsd
 *   urn:magento:module:Magento_Catalog:etc/catalog_attributes.xsd
 *   urn:magento:framework-message-queue:etc/publisher.xsd
 *
 * This module resolves these URNs to absolute filesystem paths using the same
 * rules as Magento's PHP UrnResolver (vendor/magento/framework/Config/Dom/UrnResolver.php).
 */

import * as path from 'path';
import * as fs from 'fs';
import { ModuleInfo } from '../indexer/types';

/**
 * URN patterns — order matters (module must be checked before the framework fallback).
 *
 * Module:    urn:magento:module:Vendor_Module:path/to/file.xsd
 * Framework: urn:magento:framework:path/to/file.xsd
 *            urn:magento:framework-amqp:path/to/file.xsd
 * Setup:     urn:magento:setup:path/to/file.xsd
 */
const MODULE_URN_RE = /^urn:magento:module:(\w+_\w+):(.+)$/;
const FRAMEWORK_URN_RE = /^urn:magento:(framework[A-Za-z-]*):(.+)$/;
const SETUP_URN_RE = /^urn:magento:(setup[A-Za-z-]*):(.+)$/;

/**
 * Resolve a Magento URN to an absolute filesystem path.
 *
 * Returns undefined if the URN format is unrecognized or the resolved file doesn't exist.
 */
export function resolveXmlUrn(
  urn: string,
  magentoRoot: string,
  modules: ModuleInfo[],
): string | undefined {
  let match: RegExpExecArray | null;

  // Module URN: urn:magento:module:Vendor_Module:relative/path
  match = MODULE_URN_RE.exec(urn);
  if (match) {
    const moduleName = match[1];
    const relativePath = match[2];
    const mod = modules.find((m) => m.name === moduleName);
    if (!mod) return undefined;
    const resolved = path.join(mod.path, relativePath);
    return fileExists(resolved) ? resolved : undefined;
  }

  // Framework URN: urn:magento:framework[-*]:relative/path
  match = FRAMEWORK_URN_RE.exec(urn);
  if (match) {
    const packageName = match[1];
    const relativePath = match[2];
    const resolved = path.join(magentoRoot, 'vendor', 'magento', packageName, relativePath);
    return fileExists(resolved) ? resolved : undefined;
  }

  // Setup URN: urn:magento:setup[-*]:relative/path
  match = SETUP_URN_RE.exec(urn);
  if (match) {
    const packageName = match[1];
    const relativePath = match[2];
    const resolved = path.join(magentoRoot, 'vendor', 'magento', packageName, relativePath);
    return fileExists(resolved) ? resolved : undefined;
  }

  return undefined;
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
