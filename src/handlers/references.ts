/**
 * LSP "textDocument/references" handler.
 *
 * Returns all di.xml locations that reference a given PHP class. Works from two contexts:
 *
 *   1. From a di.xml file: determines which FQCN the cursor is on, then returns all
 *      di.xml locations referencing that FQCN (across all files and areas).
 *
 *   2. From a PHP file: only responds when the cursor is on the class/interface declaration
 *      line (e.g., "class StoreManager"). Composes the FQCN from namespace + class name
 *      and returns all di.xml references. This intentionally does NOT handle cursors on
 *      type hints, use imports, or other class usages — that would require full PHP parsing
 *      and is beyond the scope of this DI-focused LSP.
 *
 * Unlike "go to definition", references always returns ALL declarations (no config merging
 * filtering). The user wants to see every place a class is mentioned in DI config.
 */

import {
  ReferenceParams,
  Location,
  Range,
} from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { ProjectContext } from '../project/projectManager';
import { extractPhpClass } from '../utils/phpNamespace';
import * as fs from 'fs';

export function handleReferences(
  params: ReferenceParams,
  getProject: (uri: string) => ProjectContext | undefined,
): Location[] | null {
  const filePath = URI.parse(params.textDocument.uri).fsPath;
  const project = getProject(filePath);
  if (!project) return null;

  let fqcn: string | undefined;

  if (filePath.endsWith('.xml')) {
    // In di.xml: find the reference at cursor position and use its FQCN
    const ref = project.index.getReferenceAtPosition(
      filePath,
      params.position.line,
      params.position.character,
    );
    if (!ref) return null;
    fqcn = ref.fqcn;
  } else if (filePath.endsWith('.php')) {
    // In PHP: only respond if the cursor is on the class declaration name
    fqcn = getFqcnFromPhpDeclaration(filePath, params.position.line, params.position.character);
  }

  if (!fqcn) return null;

  // Return ALL references — no config merging filtering for "find references"
  const refs = project.index.getReferencesForFqcn(fqcn);
  if (refs.length === 0) return null;

  return refs.map((r) =>
    Location.create(
      URI.file(r.file).toString(),
      Range.create(r.line, r.column, r.line, r.endColumn),
    ),
  );
}

/**
 * Check if the cursor is on a class/interface declaration in a PHP file and return its FQCN.
 *
 * Only matches when the cursor is exactly on the class name token in lines like:
 *   "class StoreManager"  or  "interface StoreManagerInterface"
 *
 * Returns undefined if the cursor is anywhere else in the file (namespace line,
 * method body, use imports, etc.).
 */
function getFqcnFromPhpDeclaration(
  filePath: string,
  line: number,
  character: number,
): string | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const classInfo = extractPhpClass(content);

    if (!classInfo) return undefined;

    // Verify the cursor is within the class name token bounds
    if (
      line === classInfo.line &&
      character >= classInfo.column &&
      character < classInfo.endColumn
    ) {
      return classInfo.fqcn;
    }

    return undefined;
  } catch {
    return undefined;
  }
}
