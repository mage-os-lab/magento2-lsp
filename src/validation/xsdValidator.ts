/**
 * Validate Magento XML files against their declared XSD schema using xmllint.
 *
 * Workflow:
 *   1. Extract the xsi:noNamespaceSchemaLocation URN from the XML file
 *   2. Resolve the URN to an XSD file path
 *   3. Generate an XML catalog for URN resolution in included XSD files
 *   4. Run xmllint --schema with the catalog to validate
 *   5. Parse xmllint stderr into LSP Diagnostic objects
 *
 * If xmllint is not installed, validation is silently skipped.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver';
import { ModuleInfo } from '../indexer/types';
import { resolveXmlUrn } from '../utils/xmlUrnResolver';
import { generateXsdCatalog } from './xsdCatalogGenerator';

const execFileAsync = promisify(execFile);

/** Matches the xsi:noNamespaceSchemaLocation URN in XML content. */
const SCHEMA_URN_RE = /xsi:noNamespaceSchemaLocation="(urn:magento:[^"]+)"/;

/**
 * Parse xmllint stderr output into Diagnostic objects.
 *
 * xmllint error format examples:
 *   /path/to/file.xml:3: element foo: Schemas validity error : Element 'foo': ...
 *   /path/to/file.xml:10: parser error : ...
 *   file.xml fails to validate
 */
export function parseXmllintErrors(stderr: string, xmlFilePath: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = stderr.split('\n');

  for (const line of lines) {
    // Match lines like: /path/file.xml:LINE: ...error message...
    const match = /^(.+?):(\d+):\s*(.+)$/.exec(line);
    if (!match) continue;

    const filePart = match[1];
    const lineNum = parseInt(match[2], 10) - 1; // xmllint is 1-based, LSP is 0-based
    const message = match[3].trim();

    // Only include errors for the file being validated (not included XSD errors)
    if (!filePart.endsWith(path.basename(xmlFilePath))) continue;

    // Skip "fails to validate" summary line
    if (message.includes('fails to validate')) continue;

    diagnostics.push({
      range: Range.create(Math.max(0, lineNum), 0, Math.max(0, lineNum), 1000),
      severity: DiagnosticSeverity.Error,
      source: 'magento2-lsp (xsd)',
      message: cleanXmllintMessage(message),
    });
  }

  return diagnostics;
}

/**
 * Clean up xmllint error messages for better readability.
 */
function cleanXmllintMessage(message: string): string {
  // Remove "element foo: Schemas validity error : " prefix
  return message
    .replace(/^element \S+:\s*Schemas validity error\s*:\s*/i, '')
    .replace(/^parser error\s*:\s*/i, '');
}

/**
 * Extract the XSD URN from an XML file's xsi:noNamespaceSchemaLocation attribute.
 */
export function extractSchemaUrn(xmlContent: string): string | undefined {
  const match = SCHEMA_URN_RE.exec(xmlContent);
  return match?.[1];
}

/** Cached catalog file paths per project root + root XSD path. */
const catalogCache = new Map<string, string>();

/**
 * Validate an XML file against its declared XSD schema.
 *
 * Returns an array of diagnostics (empty if valid or if validation cannot run).
 */
export async function validateXmlFile(
  xmlFilePath: string,
  xmlContent: string,
  magentoRoot: string,
  modules: ModuleInfo[],
): Promise<Diagnostic[]> {
  const urn = extractSchemaUrn(xmlContent);
  if (!urn) return [];

  const xsdPath = resolveXmlUrn(urn, magentoRoot, modules);
  if (!xsdPath) return [];

  // Generate or reuse catalog — keyed by root + XSD so different schemas get their own catalog
  const catalogKey = `${magentoRoot}:${xsdPath}`;
  let catalogPath = catalogCache.get(catalogKey);
  if (!catalogPath || !fileExists(catalogPath)) {
    const catalogContent = generateXsdCatalog(xsdPath, magentoRoot, modules);
    catalogPath = path.join(os.tmpdir(), `magento2-lsp-catalog-${hashString(catalogKey)}.xml`);
    fs.writeFileSync(catalogPath, catalogContent, 'utf-8');
    catalogCache.set(catalogKey, catalogPath);
  }

  // If content differs from disk (unsaved changes), write to a temp file for xmllint.
  let fileToValidate = xmlFilePath;
  let tempFile: string | undefined;
  try {
    const diskContent = await fs.promises.readFile(xmlFilePath, 'utf-8');
    if (diskContent !== xmlContent) {
      tempFile = path.join(os.tmpdir(), `magento2-lsp-validate-${hashString(xmlFilePath)}-${path.basename(xmlFilePath)}`);
      fs.writeFileSync(tempFile, xmlContent, 'utf-8');
      fileToValidate = tempFile;
    }
  } catch {
    // File doesn't exist on disk yet — write content to temp
    tempFile = path.join(os.tmpdir(), `magento2-lsp-validate-${hashString(xmlFilePath)}-${path.basename(xmlFilePath)}`);
    fs.writeFileSync(tempFile, xmlContent, 'utf-8');
    fileToValidate = tempFile;
  }

  try {
    await execFileAsync('xmllint', [
      '--noout',
      '--schema', xsdPath,
      '--catalogs',
      fileToValidate,
    ], {
      env: { ...process.env, XML_CATALOG_FILES: catalogPath },
      timeout: 10000,
    });
    // Exit code 0 = valid
    return [];
  } catch (err: unknown) {
    const error = err as { stderr?: string; code?: string; killed?: boolean };

    // If xmllint was killed or not found, skip
    if (error.killed || error.code === 'ENOENT') return [];

    // Parse validation errors from stderr
    if (error.stderr) {
      return parseXmllintErrors(error.stderr, fileToValidate);
    }
    return [];
  } finally {
    // Clean up temp file
    if (tempFile) {
      try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
    }
  }
}

/** Simple string hash for creating deterministic temp file names. */
function hashString(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

let xmllintAvailable: boolean | undefined;

/**
 * Check if xmllint is available on the system.
 * Result is cached after first check.
 */
export async function isXmllintAvailable(): Promise<boolean> {
  if (xmllintAvailable !== undefined) return xmllintAvailable;
  try {
    await execFileAsync('xmllint', ['--version']);
    xmllintAvailable = true;
  } catch (err: unknown) {
    const error = err as { code?: string; stderr?: string };
    // xmllint --version exits with 0 on some systems but writes to stderr
    // ENOENT means the binary doesn't exist
    if (error.code === 'ENOENT') {
      xmllintAvailable = false;
    } else {
      // xmllint exists but wrote version to stderr (normal behavior)
      xmllintAvailable = true;
    }
  }
  return xmllintAvailable;
}

/**
 * Invalidate the catalog cache for a project (e.g., after reindexing).
 */
export function invalidateCatalogCache(magentoRoot: string): void {
  for (const [key, filePath] of catalogCache) {
    if (key.startsWith(magentoRoot + ':')) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignore cleanup errors
      }
      catalogCache.delete(key);
    }
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
