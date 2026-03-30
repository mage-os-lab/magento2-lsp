/**
 * LSP "textDocument/codeLens" handler.
 *
 * Shows inline indicators on PHP class/method declarations and .phtml templates:
 *
 * PHP files:
 *   - On target class declaration: "N plugins" if the class has any plugins
 *   - On each intercepted method: "N plugins"
 *   - On plugin before/after/around methods: "→ Target\Class::methodName"
 *   - On observer execute() method: "→ event_name"
 *
 * .phtml template files:
 *   - On module templates: "overridden in N themes" if any theme overrides exist
 *     (e.g., on vendor/magento/module-catalog/view/frontend/templates/product/view.phtml
 *      when a theme has Magento_Catalog/templates/product/view.phtml)
 *   - On theme override templates: "overrides Module_Name::path/to/template.phtml"
 *     (e.g., on app/design/frontend/Hyva/default/Magento_Catalog/templates/product/view.phtml)
 *
 * Code lenses are display-only (no command). The user can navigate to related
 * locations via grr (find references) or gd (go to definition) on the same line.
 */

import {
  CancellationToken,
  CodeLens,
  CodeLensParams,
  Command,
  Range,
} from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { ProjectContext } from '../project/projectManager';
import { extractPhpClass, extractPhpMethods } from '../utils/phpNamespace';
import { resolveVariableTypes } from '../utils/phpTypeResolver';
import { realpath } from '../utils/realpath';
import {
  reverseResolveThemeOverrideTemplateId,
  reverseResolveModuleTemplateId,
} from '../utils/templateId';
import { resolveConcreteType, CALL_RE } from '../utils/diPreference';
import * as fs from 'fs';

/**
 * Empty command ID for display-only code lenses.
 * Code lenses are informational — the user can use "find references" (grr) on the
 * same line to navigate to related locations.
 */
const NO_COMMAND = '';

export function handleCodeLens(
  params: CodeLensParams,
  getProject: (uri: string) => ProjectContext | undefined,
  token?: CancellationToken,
): CodeLens[] | null {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);

  if (filePath.endsWith('.phtml')) {
    return handlePhtmlCodeLens(filePath, getProject);
  }

  if (filePath.endsWith('.php')) {
    return handlePhpCodeLens(filePath, getProject, token);
  }

  return null;
}

// ---------------------------------------------------------------------------
// .phtml template code lenses
// ---------------------------------------------------------------------------

/**
 * Show override information on .phtml template files.
 *
 * For a module template (lives under {modulePath}/view/{area}/templates/...):
 *   → Shows "overridden in N themes" if any theme has an override file.
 *   → Shows "overridden in Hyvä compat module X" for each compat module override.
 *
 * For a theme override template (lives under {themePath}/{Module_Name}/templates/...):
 *   → Shows "overrides Module_Name::path/to/template.phtml" pointing back to the original.
 *
 * For a Hyvä compat module override template:
 *   → Shows "Hyvä compat override: Module_Name::path/to/template.phtml"
 *
 * All lenses appear on line 0 (top of the file). The user can navigate with
 * grr (find references) to see all related files.
 */
function handlePhtmlCodeLens(
  filePath: string,
  getProject: (uri: string) => ProjectContext | undefined,
): CodeLens[] | null {
  const project = getProject(filePath);
  if (!project) return null;

  const lenses: CodeLens[] = [];

  // Step 1: Determine what kind of .phtml file this is and resolve its template ID.
  // The template ID (e.g., "Magento_Catalog::product/image.phtml") is needed for
  // looking up compat module overrides regardless of file type.
  let templateId: string | undefined;

  const theme = project.themeResolver.getThemeForFile(filePath);
  const compatInfo = project.indexes.compatModule.getCompatModuleForFile(filePath);

  if (theme) {
    // File is a theme override — show "overrides Module::path" lens
    templateId = reverseResolveThemeOverrideTemplateId(filePath, { path: theme.path });
    if (templateId) {
      const original = project.themeResolver.getOriginalModuleTemplate(filePath, project.modules);
      if (original) {
        lenses.push({
          range: Range.create(0, 0, 0, 0),
          command: Command.create(`Overrides ${templateId}`, NO_COMMAND),
        });
      }
    }
  } else if (compatInfo) {
    // File is a Hyvä compat module override — show "Hyvä compat override: ..." lens
    templateId = compatInfo.templateId;
    const original = project.indexes.compatModule.getOriginalModuleTemplate(filePath, project.modules);
    if (original) {
      lenses.push({
        range: Range.create(0, 0, 0, 0),
        command: Command.create(`Hyvä compat override: ${templateId}`, NO_COMMAND),
      });
    }
  } else {
    // File is a module template — show theme override counts
    templateId = reverseResolveModuleTemplateId(filePath, project.modules);
    if (templateId) {
      const area = project.themeResolver.getAreaForFile(filePath) ?? 'frontend';
      const themeOverrides = project.themeResolver.findOverrides(templateId, area);
      if (themeOverrides.length > 0) {
        const count = themeOverrides.length;
        lenses.push({
          range: Range.create(0, 0, 0, 0),
          command: Command.create(`Overridden in ${count} theme${count === 1 ? '' : 's'}`, NO_COMMAND),
        });
      }
    }
  }

  // Step 2: Regardless of file type, show compat module overrides for this template.
  // This way, opening a theme override that is also overridden by a compat module
  // will show both the "overrides ..." lens and the "overridden in Hyvä compat module ..." lens.
  if (templateId) {
    const compatOverrides = project.indexes.compatModule.findOverrides(templateId);
    for (const override of compatOverrides) {
      // Don't show "overridden by compat module X" if the current file IS that compat override
      if (override.filePath === filePath) continue;
      lenses.push({
        range: Range.create(0, 0, 0, 0),
        command: Command.create(`Overridden in Hyvä compat module ${override.compatModule}`, NO_COMMAND),
      });
    }
  }

  return lenses.length > 0 ? lenses : null;
}

// ---------------------------------------------------------------------------
// PHP class code lenses (plugins, observers)
// ---------------------------------------------------------------------------

function handlePhpCodeLens(
  filePath: string,
  getProject: (uri: string) => ProjectContext | undefined,
  token?: CancellationToken,
): CodeLens[] | null {
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

  const lenses: CodeLens[] = [];
  const methods = extractPhpMethods(content);
  const isPluginClass = project.indexes.pluginMethod.isPluginClass(classInfo.fqcn);
  const hasPlugins = project.indexes.pluginMethod.hasPlugins(classInfo.fqcn);
  const isObserver = project.indexes.events.getObserversForFqcn(classInfo.fqcn).length > 0;

  // --- Target class: show "N plugins" on class and intercepted methods ---
  if (hasPlugins) {
    const totalPlugins = project.indexes.pluginMethod.getTotalPluginCount(classInfo.fqcn);
    if (totalPlugins > 0) {
      lenses.push({
        range: Range.create(classInfo.line, classInfo.column, classInfo.line, classInfo.endColumn),
        command: Command.create(`${totalPlugins} plugin${totalPlugins === 1 ? '' : 's'}`, NO_COMMAND),
      });
    }

    const interceptedMethods = project.indexes.pluginMethod.getInterceptedMethods(classInfo.fqcn);
    if (interceptedMethods) {
      for (const method of methods) {
        const interceptions = interceptedMethods.get(method.name);
        if (interceptions && interceptions.length > 0) {
          const uniquePlugins = new Set(interceptions.map((i) => `${i.diRef.file}:${i.diRef.line}`));
          const count = uniquePlugins.size;
          lenses.push({
            range: Range.create(method.line, method.column, method.line, method.endColumn),
            command: Command.create(`${count} plugin${count === 1 ? '' : 's'}`, NO_COMMAND),
          });
        }
      }
    }
  }

  // --- Plugin class: show "→ Target\Class::method" on before/after/around methods ---
  if (isPluginClass) {
    for (const method of methods) {
      const reverseEntry = project.indexes.pluginMethod.getReverseEntry(
        classInfo.fqcn,
        method.name,
      );
      if (reverseEntry) {
        lenses.push({
          range: Range.create(method.line, method.column, method.line, method.endColumn),
          command: Command.create(`→ ${reverseEntry.targetFqcn}::${reverseEntry.targetMethodName}`, NO_COMMAND),
        });
      }
    }
  }

  // --- Observer class: show "→ event_name" on execute() method ---
  if (isObserver) {
    const executeMethod = methods.find((m) => m.name === 'execute');
    if (executeMethod) {
      const obsRefs = project.indexes.events.getObserversForFqcn(classInfo.fqcn);
      const eventNames = [...new Set(obsRefs.map((r) => r.eventName))];
      for (const eventName of eventNames) {
        lenses.push({
          range: Range.create(executeMethod.line, executeMethod.column, executeMethod.line, executeMethod.endColumn),
          command: Command.create(`→ ${eventName}`, NO_COMMAND),
        });
      }
    }
  }

  // --- Service interface: show "GET /V1/..." on methods referenced in webapi.xml ---
  // Check both direct class and implemented interfaces
  const webapiClassRefs = [
    ...project.indexes.webapi.getRefsForFqcn(classInfo.fqcn),
    ...classInfo.interfaces.flatMap((iface) => project.indexes.webapi.getRefsForFqcn(iface)),
  ];
  if (webapiClassRefs.length > 0) {
    for (const method of methods) {
      const methodRefs = webapiClassRefs.filter(
        (r) => r.kind === 'service-method' && r.methodName === method.name,
      );
      for (const route of methodRefs) {
        lenses.push({
          range: Range.create(method.line, method.column, method.line, method.endColumn),
          command: Command.create(`${route.httpMethod} ${route.routeUrl}`, NO_COMMAND),
        });
      }
    }
  }

  // --- Magic method calls: show "→ ClassName::method" or "→ ClassName::__call" ---
  const magicLenses = computeMagicMethodLenses(content, classInfo, project, token);
  lenses.push(...magicLenses);

  return lenses.length > 0 ? lenses : null;
}

/**
 * Detect method calls on typed variables where the method doesn't exist on the
 * declared type but is available on the concrete class (via DI preference resolution)
 * or via __call/@method magic.
 *
 * For each such call, produces a code lens:
 *   - "→ ClassName::methodName" if the method is physically declared on the concrete class
 *   - "→ ClassName::__call" if the method is handled by __call or @method
 */
function computeMagicMethodLenses(
  content: string,
  classInfo: { fqcn: string; namespace: string; useImports: Map<string, string> },
  project: ProjectContext,
  token?: CancellationToken,
): CodeLens[] {
  const lenses: CodeLens[] = [];
  const lines = content.split('\n');
  const typeMap = resolveVariableTypes(content, classInfo as any, (fqcn, method) =>
    project.indexes.magicMethod.resolveMethodReturnType(fqcn, method, project.psr4Map),
  );

  // Pre-resolve DI preferences for each unique type (avoids repeated lookups)
  const concreteTypeCache = new Map<string, string>();
  function getConcreteType(fqcn: string): string {
    if (concreteTypeCache.has(fqcn)) return concreteTypeCache.get(fqcn)!;
    const concrete = resolveConcreteType(fqcn, project.indexes.di);
    concreteTypeCache.set(fqcn, concrete);
    return concrete;
  }

  for (let i = 0; i < lines.length; i++) {
    if (token?.isCancellationRequested) return lenses;
    const line = lines[i];
    let match;
    CALL_RE.lastIndex = 0;

    while ((match = CALL_RE.exec(line)) !== null) {
      const objectExpr = match[1]; // e.g., "$this->storage" or "$product"
      const methodName = match[2]; // e.g., "getData"

      // Skip __construct, __call, etc.
      if (methodName.startsWith('__')) continue;

      // Resolve the object expression to a FQCN
      const originalFqcn = typeMap.get(objectExpr);
      if (!originalFqcn) continue;

      // Check if the method is declared on the original type — if so, no lens needed.
      // resolveMethod returns 'declared' when the method physically exists.
      const originalResolution = project.indexes.magicMethod.resolveMethod(
        originalFqcn, methodName, project.psr4Map,
      );
      if (originalResolution?.kind === 'declared') continue;

      // Try DI preference resolution: interface → concrete class
      const concreteFqcn = getConcreteType(originalFqcn);

      // Resolve the method on the concrete class (skip if same as original — already checked)
      const resolution = concreteFqcn !== originalFqcn
        ? project.indexes.magicMethod.resolveMethod(concreteFqcn, methodName, project.psr4Map)
        : originalResolution;
      if (!resolution) continue;

      // Build the label
      const shortClass = resolution.className.split('\\').pop() ?? resolution.className;
      const label =
        resolution.kind === 'declared'
          ? `→ ${shortClass}::${resolution.methodName}`
          : `→ ${shortClass}::__call`;

      // Position the lens on the method name in the call
      const methodStart = match.index + match[1].length + 2; // +2 for "->"
      const methodEnd = methodStart + methodName.length;

      lenses.push({
        range: Range.create(i, methodStart, i, methodEnd),
        command: Command.create(label, NO_COMMAND),
      });
    }
  }

  return lenses;
}
