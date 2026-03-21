/**
 * LSP "textDocument/definition" handler.
 *
 * Handles "go to definition" requests from the editor. Only responds to requests
 * from di.xml files — PHP definition is left to Intelephense.
 *
 * Navigation behavior depends on what the cursor is on:
 *
 *   1. VirtualType reference: jumps to the <virtualType> declaration in di.xml
 *      (virtualTypes don't have PHP files — they only exist in XML config)
 *
 *   2. Preference "for" attribute (an interface): jumps to the PHP file of the
 *      effective implementation class (after config merging), so you can quickly
 *      navigate from interface to its actual implementation
 *
 *   3. Any other class reference (type name, plugin class, argument object):
 *      resolves the FQCN to its PHP source file via PSR-4
 */

import {
  DefinitionParams,
  Location,
  Range,
} from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { ProjectContext } from '../project/projectManager';
import { locatePhpClass } from '../indexer/phpClassLocator';

export function handleDefinition(
  params: DefinitionParams,
  getProject: (uri: string) => ProjectContext | undefined,
): Location | Location[] | null {
  const filePath = URI.parse(params.textDocument.uri).fsPath;

  // This LSP only provides definitions from XML files.
  // PHP -> PHP definition is handled by Intelephense.
  if (!filePath.endsWith('.xml')) {
    return null;
  }

  const project = getProject(filePath);
  if (!project) return null;

  // Find which DI reference (if any) the cursor is positioned on
  const ref = project.index.getReferenceAtPosition(
    filePath,
    params.position.line,
    params.position.character,
  );
  if (!ref) return null;

  // --- Priority 1: VirtualType ---
  // If the FQCN is a known virtualType name, navigate to its XML declaration.
  // VirtualTypes have no PHP file, so this is their only "definition".
  const vt = project.index.getEffectiveVirtualType(ref.fqcn);
  if (vt) {
    return Location.create(
      URI.file(vt.file).toString(),
      Range.create(vt.line, vt.column, vt.line, vt.column + vt.name.length),
    );
  }

  // --- Priority 2: Preference interface -> implementation ---
  // When the cursor is on the "for" attribute of a preference (the interface),
  // jump to the PHP class of the effective implementation (after config merging).
  if (ref.kind === 'preference-for') {
    const effectiveType = project.index.getEffectivePreferenceType(
      ref.fqcn,
      ref.area,
    );
    if (effectiveType) {
      const loc = locatePhpClass(effectiveType.fqcn, project.psr4Map);
      if (loc) {
        return Location.create(
          URI.file(loc.file).toString(),
          Range.create(loc.line, loc.column, loc.line, loc.column),
        );
      }
      // If the PHP file doesn't exist, fall back to the di.xml location
      return Location.create(
        URI.file(effectiveType.file).toString(),
        Range.create(
          effectiveType.line,
          effectiveType.column,
          effectiveType.line,
          effectiveType.endColumn,
        ),
      );
    }
  }

  // --- Default: Resolve FQCN to PHP file via PSR-4 ---
  const loc = locatePhpClass(ref.fqcn, project.psr4Map);
  if (loc) {
    return Location.create(
      URI.file(loc.file).toString(),
      Range.create(loc.line, loc.column, loc.line, loc.column),
    );
  }

  return null;
}
