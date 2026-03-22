/**
 * LSP "textDocument/definition" handler.
 *
 * Handles "go to definition" requests from XML files (di.xml, events.xml).
 * PHP definition is left to Intelephense.
 *
 * From di.xml:
 *   - VirtualType reference -> <virtualType> declaration in di.xml
 *   - Preference "for" attribute -> effective implementation PHP class
 *   - Any other class reference -> PHP source file via PSR-4
 *
 * From events.xml:
 *   - Observer instance attribute -> PHP observer class file
 */

import {
  DefinitionParams,
  Location,
  Range,
} from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { ProjectContext } from '../project/projectManager';
import { locatePhpClass } from '../indexer/phpClassLocator';
import { isObserverReference } from '../index/eventsIndex';
import { realpath } from '../utils/realpath';

export function handleDefinition(
  params: DefinitionParams,
  getProject: (uri: string) => ProjectContext | undefined,
): Location | Location[] | null {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);

  // This LSP only provides definitions from XML files.
  if (!filePath.endsWith('.xml')) {
    return null;
  }

  const project = getProject(filePath);
  if (!project) return null;

  // --- Try events.xml first ---
  const eventsRef = project.eventsIndex.getReferenceAtPosition(
    filePath,
    params.position.line,
    params.position.character,
  );
  if (eventsRef) {
    if (isObserverReference(eventsRef)) {
      // Observer instance -> jump to PHP class
      const loc = locatePhpClass(eventsRef.fqcn, project.psr4Map);
      if (loc) {
        return Location.create(
          URI.file(loc.file).toString(),
          Range.create(loc.line, loc.column, loc.line, loc.column),
        );
      }
    }
    // Event name -> no single "definition" to jump to (use references instead)
    return null;
  }

  // --- Try di.xml ---
  const ref = project.index.getReferenceAtPosition(
    filePath,
    params.position.line,
    params.position.character,
  );
  if (!ref) return null;

  // VirtualType -> XML declaration
  const vt = project.index.getEffectiveVirtualType(ref.fqcn);
  if (vt) {
    return Location.create(
      URI.file(vt.file).toString(),
      Range.create(vt.line, vt.column, vt.line, vt.column + vt.name.length),
    );
  }

  // Preference interface -> effective implementation
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

  // Default: FQCN -> PHP file
  const loc = locatePhpClass(ref.fqcn, project.psr4Map);
  if (loc) {
    return Location.create(
      URI.file(loc.file).toString(),
      Range.create(loc.line, loc.column, loc.line, loc.column),
    );
  }

  return null;
}
