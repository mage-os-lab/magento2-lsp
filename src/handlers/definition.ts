/**
 * LSP "textDocument/definition" handler.
 *
 * Handles "go to definition" requests from XML files and .phtml templates.
 * PHP definition is left to Intelephense.
 *
 * From di.xml:
 *   - VirtualType reference -> <virtualType> declaration in di.xml
 *   - Preference "for" attribute -> effective implementation PHP class
 *   - Any other class reference -> PHP source file via PSR-4
 *
 * From events.xml:
 *   - Observer instance attribute -> PHP observer class file
 *
 * From layout XML:
 *   - Block class attribute -> PHP class file
 *   - Template attribute -> .phtml file (resolved via theme fallback)
 *   - Argument xsi:type="object" -> PHP class file
 *
 * From .phtml (theme override):
 *   - gd on a theme override template jumps to the original module template.
 *     e.g., app/design/frontend/Hyva/default/Magento_Catalog/templates/product/view.phtml
 *     -> vendor/magento/module-catalog/view/frontend/templates/product/view.phtml
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

  // Theme override .phtml -> original module template
  if (filePath.endsWith('.phtml')) {
    return handlePhtmlDefinition(filePath, getProject);
  }

  // This LSP only provides definitions from XML files (beyond .phtml above).
  if (!filePath.endsWith('.xml')) {
    return null;
  }

  const project = getProject(filePath);
  if (!project) return null;

  // --- Try layout XML ---
  const layoutRef = project.layoutIndex.getReferenceAtPosition(
    filePath,
    params.position.line,
    params.position.character,
  );
  if (layoutRef) {
    if (layoutRef.kind === 'block-template' || layoutRef.kind === 'refblock-template') {
      // Template identifier -> resolve to .phtml file via theme fallback
      const templateId = layoutRef.resolvedTemplateId ?? layoutRef.value;
      if (templateId.includes('::')) {
        const area = project.themeResolver.getAreaForFile(filePath) ?? 'frontend';
        const theme = project.themeResolver.getThemeForFile(filePath);
        const resolved = project.themeResolver.resolveTemplate(
          templateId,
          area,
          theme?.code,
          project.modules,
        );
        if (resolved.length > 0) {
          return Location.create(
            URI.file(resolved[0]).toString(),
            Range.create(0, 0, 0, 0),
          );
        }
      }
      return null;
    }
    // block-class or argument-object -> resolve to PHP file
    const loc = locatePhpClass(layoutRef.value, project.psr4Map);
    if (loc) {
      return Location.create(
        URI.file(loc.file).toString(),
        Range.create(loc.line, loc.column, loc.line, loc.column),
      );
    }
    return null;
  }

  // --- Try events.xml ---
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

/**
 * Handle "go to definition" from a .phtml template file.
 *
 * Only meaningful for theme override files: navigates from the override
 * back to the original module template. This is the natural "gd" direction —
 * from the override to the "definition" (the original).
 *
 * For module templates (non-overrides), returns null — there's no "definition"
 * to jump to (the file IS the definition). Use grr (find references) to see
 * theme overrides and layout XML usages instead.
 */
function handlePhtmlDefinition(
  filePath: string,
  getProject: (uri: string) => ProjectContext | undefined,
): Location | null {
  const project = getProject(filePath);
  if (!project) return null;

  // Only act when the file is inside a theme directory (i.e., it's a theme override)
  const theme = project.themeResolver.getThemeForFile(filePath);
  if (!theme) return null;

  const original = project.themeResolver.getOriginalModuleTemplate(
    filePath,
    project.modules,
  );
  if (!original) return null;

  return Location.create(
    URI.file(original).toString(),
    Range.create(0, 0, 0, 0),
  );
}
