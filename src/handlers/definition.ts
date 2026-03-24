/**
 * LSP "textDocument/definition" handler.
 *
 * Handles "go to definition" requests from XML files, .phtml templates, and PHP files.
 *
 * From PHP files:
 *   - Magic method calls -> resolved method on the concrete class (via DI preference)
 *     e.g., $this->storage->getData() where StorageInterface has no getData()
 *     but the DI preference concrete class (Storage extends DataObject) does.
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
  CancellationToken,
  DefinitionParams,
  Location,
  Range,
} from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { ProjectContext } from '../project/projectManager';
import { locatePhpClass, locatePhpMethod } from '../indexer/phpClassLocator';
import { isObserverReference } from '../index/eventsIndex';
import { extractPhpClass } from '../utils/phpNamespace';
import { resolveVariableTypes } from '../utils/phpTypeResolver';
import { realpath } from '../utils/realpath';
import * as fs from 'fs';

export function handleDefinition(
  params: DefinitionParams,
  getProject: (uri: string) => ProjectContext | undefined,
  _token?: CancellationToken,
): Location | Location[] | null {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);

  // Theme override .phtml -> original module template
  if (filePath.endsWith('.phtml')) {
    return handlePhtmlDefinition(filePath, getProject);
  }

  // Magic method calls in PHP files -> resolved method on the concrete class
  if (filePath.endsWith('.php')) {
    return handlePhpDefinition(filePath, params, getProject);
  }

  // Beyond .phtml and .php above, only XML files are handled.
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
    if (layoutRef.kind === 'update-handle') {
      const handle = layoutRef.value;
      const area = project.themeResolver.getAreaForFile(filePath) ?? 'frontend';
      const theme = project.themeResolver.getThemeForFile(filePath);

      // Collect files for both handle and hyva_ variant
      let allFiles = [
        ...project.layoutIndex.getFilesForHandle(handle),
        ...project.layoutIndex.getFilesForHandle(`hyva_${handle}`),
      ];

      // Filter by area (include 'base' as it applies to all areas)
      allFiles = allFiles.filter((f) => {
        const fileArea = project.themeResolver.getAreaForFile(f);
        return fileArea === area || fileArea === 'base';
      });

      if (allFiles.length === 0) return null;

      // If in a theme context, prioritize theme fallback chain
      if (theme) {
        const chain = project.themeResolver.getFallbackChain(theme.code);
        const themeFiles = allFiles.filter((f) =>
          chain.some((t) => f.startsWith(t.path + '/')),
        );
        if (themeFiles.length > 0) {
          allFiles = themeFiles;
        }
      }

      return allFiles.map((f) =>
        Location.create(URI.file(f).toString(), Range.create(0, 0, 0, 0)),
      );
    }
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
 * Handle "go to definition" from a PHP file.
 *
 * Detects magic method calls — method calls on typed variables where the method
 * is not declared on the variable's type but is available on the concrete class
 * (via DI preference resolution) or via __call/@method magic.
 *
 * Returns null for regular method calls (declared on the original type) so that
 * Intelephense can handle them with its richer PHP understanding.
 */
function handlePhpDefinition(
  filePath: string,
  params: DefinitionParams,
  getProject: (uri: string) => ProjectContext | undefined,
): Location | null {
  const project = getProject(filePath);
  if (!project) return null;

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const classInfo = extractPhpClass(content);
  if (!classInfo) return null;

  const typeMap = resolveVariableTypes(content, classInfo, (fqcn, method) =>
    project.magicMethodIndex.resolveMethodReturnType(fqcn, method, project.psr4Map),
  );
  const lines = content.split('\n');
  const line = lines[params.position.line];
  if (!line) return null;

  // Match method calls: $var->method( or $this->prop->method(
  const CALL_RE = /(\$[\w]+(?:->[\w]+)*)->([\w]+)\s*\(/g;
  let match;
  while ((match = CALL_RE.exec(line)) !== null) {
    const methodStart = match.index + match[1].length + 2; // +2 for "->"
    const methodEnd = methodStart + match[2].length;

    if (params.position.character < methodStart || params.position.character > methodEnd) {
      continue;
    }

    const objectExpr = match[1];
    const methodName = match[2];
    if (methodName.startsWith('__')) return null;

    const originalFqcn = typeMap.get(objectExpr);
    if (!originalFqcn) return null;

    // If the method is declared on the original type, let Intelephense handle it.
    const originalResolution = project.magicMethodIndex.resolveMethod(
      originalFqcn, methodName, project.psr4Map,
    );
    if (originalResolution?.kind === 'declared') return null;

    // Resolve DI preference: interface → concrete class
    const prefRef =
      project.index.getEffectivePreferenceType(originalFqcn, 'frontend') ??
      project.index.getEffectivePreferenceType(originalFqcn, 'adminhtml') ??
      project.index.getEffectivePreferenceType(originalFqcn, 'global');
    const concreteFqcn = prefRef ? prefRef.fqcn : originalFqcn;

    const resolution = concreteFqcn !== originalFqcn
      ? project.magicMethodIndex.resolveMethod(concreteFqcn, methodName, project.psr4Map)
      : originalResolution;
    if (!resolution) return null;

    const loc = locatePhpMethod(resolution.className, resolution.methodName, project.psr4Map);
    if (!loc) return null;

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
 * Meaningful for override files (theme overrides and Hyvä compat module overrides):
 * navigates from the override back to the original module template. This is the
 * natural "gd" direction — from the override to the "definition" (the original).
 *
 * For module templates (non-overrides), returns null — there's no "definition"
 * to jump to (the file IS the definition). Use grr (find references) to see
 * overrides and layout XML usages instead.
 */
function handlePhtmlDefinition(
  filePath: string,
  getProject: (uri: string) => ProjectContext | undefined,
): Location | null {
  const project = getProject(filePath);
  if (!project) return null;

  // Check if the file is a theme override
  const theme = project.themeResolver.getThemeForFile(filePath);
  if (theme) {
    const original = project.themeResolver.getOriginalModuleTemplate(
      filePath,
      project.modules,
    );
    if (original) {
      return Location.create(
        URI.file(original).toString(),
        Range.create(0, 0, 0, 0),
      );
    }
    return null;
  }

  // Check if the file is a Hyvä compat module override
  const compatOriginal = project.compatModuleIndex.getOriginalModuleTemplate(
    filePath,
    project.modules,
  );
  if (compatOriginal) {
    return Location.create(
      URI.file(compatOriginal).toString(),
      Range.create(0, 0, 0, 0),
    );
  }

  return null;
}
