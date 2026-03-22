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
 * The code lens command triggers "find references" to show the related locations,
 * allowing the user to navigate to the overrides/original via grr (find references)
 * or gd (go to definition).
 */

import {
  CodeLens,
  CodeLensParams,
  Command,
  Range,
} from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { ProjectContext } from '../project/projectManager';
import { extractPhpClass, extractPhpMethods } from '../utils/phpNamespace';
import { realpath } from '../utils/realpath';
import * as fs from 'fs';

/** Custom command ID that the client uses to trigger "find references". */
export const SHOW_PLUGIN_REFERENCES_COMMAND = 'magento2-lsp.showPluginReferences';

export function handleCodeLens(
  params: CodeLensParams,
  getProject: (uri: string) => ProjectContext | undefined,
): CodeLens[] | null {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);

  if (filePath.endsWith('.phtml')) {
    return handlePhtmlCodeLens(filePath, params, getProject);
  }

  if (filePath.endsWith('.php')) {
    return handlePhpCodeLens(filePath, params, getProject);
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
 *
 * For a theme override template (lives under {themePath}/{Module_Name}/templates/...):
 *   → Shows "overrides Module_Name::path/to/template.phtml" pointing back to the original.
 *
 * Both lenses appear on line 0 (top of the file) and trigger "find references"
 * so the user can navigate with grr to see all related files.
 */
function handlePhtmlCodeLens(
  filePath: string,
  params: CodeLensParams,
  getProject: (uri: string) => ProjectContext | undefined,
): CodeLens[] | null {
  const project = getProject(filePath);
  if (!project) return null;

  const lenses: CodeLens[] = [];

  // Check if this file is a theme override (lives inside a theme directory).
  // If so, show a lens pointing back to the original module template.
  const theme = project.themeResolver.getThemeForFile(filePath);
  if (theme) {
    const templateId = reverseResolveThemeOverrideTemplateId(filePath, theme);
    if (templateId) {
      const original = project.themeResolver.getOriginalModuleTemplate(filePath, project.modules);
      if (original) {
        lenses.push({
          range: Range.create(0, 0, 0, 0),
          command: Command.create(
            `overrides ${templateId}`,
            SHOW_PLUGIN_REFERENCES_COMMAND,
            params.textDocument.uri,
            0,
            0,
          ),
        });
      }
    }
    return lenses.length > 0 ? lenses : null;
  }

  // Not in a theme — check if this is a module template with theme overrides.
  // Reverse-resolve the file path to a template ID (e.g., "Magento_Catalog::product/view.phtml")
  // then search all themes for override files.
  const templateId = reverseResolveModuleTemplateId(filePath, project);
  if (!templateId) return null;

  const area = project.themeResolver.getAreaForFile(filePath) ?? 'frontend';
  const overrides = project.themeResolver.findOverrides(templateId, area);
  if (overrides.length === 0) return null;

  const count = overrides.length;
  lenses.push({
    range: Range.create(0, 0, 0, 0),
    command: Command.create(
      `overridden in ${count} theme${count === 1 ? '' : 's'}`,
      SHOW_PLUGIN_REFERENCES_COMMAND,
      params.textDocument.uri,
      0,
      0,
    ),
  });

  return lenses;
}

/**
 * Reverse-resolve a theme override file to its template identifier.
 *
 * Given: {themePath}/Module_Name/templates/path/to/file.phtml
 * Returns: "Module_Name::path/to/file.phtml"
 */
function reverseResolveThemeOverrideTemplateId(
  filePath: string,
  theme: { path: string },
): string | undefined {
  const relToTheme = filePath.substring(theme.path.length + 1);
  const parts = relToTheme.split('/');
  if (parts.length < 3 || parts[1] !== 'templates') return undefined;
  const moduleName = parts[0];
  const templatePath = parts.slice(2).join('/');
  return `${moduleName}::${templatePath}`;
}

/**
 * Reverse-resolve a module template file to its template identifier.
 *
 * Given: {modulePath}/view/frontend/templates/path/to/file.phtml
 * Returns: "Module_Name::path/to/file.phtml"
 */
function reverseResolveModuleTemplateId(
  filePath: string,
  project: ProjectContext,
): string | undefined {
  for (const mod of project.modules) {
    if (filePath.startsWith(mod.path)) {
      const relToModule = filePath.substring(mod.path.length + 1);
      // relToModule: "view/frontend/templates/path/to/file.phtml"
      const templatesIdx = relToModule.indexOf('/templates/');
      if (templatesIdx !== -1) {
        const templatePath = relToModule.substring(templatesIdx + '/templates/'.length);
        return `${mod.name}::${templatePath}`;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// PHP class code lenses (plugins, observers)
// ---------------------------------------------------------------------------

function handlePhpCodeLens(
  filePath: string,
  params: CodeLensParams,
  getProject: (uri: string) => ProjectContext | undefined,
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
  const isPluginClass = project.pluginMethodIndex.isPluginClass(classInfo.fqcn);
  const hasPlugins = project.pluginMethodIndex.hasPlugins(classInfo.fqcn);
  const isObserver = project.eventsIndex.getObserversForFqcn(classInfo.fqcn).length > 0;

  if (!isPluginClass && !hasPlugins && !isObserver) {
    return null;
  }

  // --- Target class: show "N plugins" on class and intercepted methods ---
  if (hasPlugins) {
    const totalPlugins = project.pluginMethodIndex.getTotalPluginCount(classInfo.fqcn);
    if (totalPlugins > 0) {
      lenses.push({
        range: Range.create(classInfo.line, classInfo.column, classInfo.line, classInfo.endColumn),
        command: Command.create(
          `${totalPlugins} plugin${totalPlugins === 1 ? '' : 's'}`,
          SHOW_PLUGIN_REFERENCES_COMMAND,
          params.textDocument.uri,
          classInfo.line,
          classInfo.column,
        ),
      });
    }

    const interceptedMethods = project.pluginMethodIndex.getInterceptedMethods(classInfo.fqcn);
    if (interceptedMethods) {
      const methods = extractPhpMethods(content);
      for (const method of methods) {
        const interceptions = interceptedMethods.get(method.name);
        if (interceptions && interceptions.length > 0) {
          const uniquePlugins = new Set(interceptions.map((i) => `${i.diRef.file}:${i.diRef.line}`));
          const count = uniquePlugins.size;
          lenses.push({
            range: Range.create(method.line, method.column, method.line, method.endColumn),
            command: Command.create(
              `${count} plugin${count === 1 ? '' : 's'}`,
              SHOW_PLUGIN_REFERENCES_COMMAND,
              params.textDocument.uri,
              method.line,
              method.column,
            ),
          });
        }
      }
    }
  }

  // --- Plugin class: show "→ Target\Class::method" on before/after/around methods ---
  if (isPluginClass) {
    const methods = extractPhpMethods(content);
    for (const method of methods) {
      const reverseEntry = project.pluginMethodIndex.getReverseEntry(
        classInfo.fqcn,
        method.name,
      );
      if (reverseEntry) {
        lenses.push({
          range: Range.create(method.line, method.column, method.line, method.endColumn),
          command: Command.create(
            `→ ${reverseEntry.targetFqcn}::${reverseEntry.targetMethodName}`,
            SHOW_PLUGIN_REFERENCES_COMMAND,
            params.textDocument.uri,
            method.line,
            method.column,
          ),
        });
      }
    }
  }

  // --- Observer class: show "→ event_name" on execute() method ---
  if (isObserver) {
    const allMethods = extractPhpMethods(content);
    const executeMethod = allMethods.find((m) => m.name === 'execute');
    if (executeMethod) {
      const obsRefs = project.eventsIndex.getObserversForFqcn(classInfo.fqcn);
      const eventNames = [...new Set(obsRefs.map((r) => r.eventName))];
      for (const eventName of eventNames) {
        lenses.push({
          range: Range.create(executeMethod.line, executeMethod.column, executeMethod.line, executeMethod.endColumn),
          command: Command.create(
            `→ ${eventName}`,
            SHOW_PLUGIN_REFERENCES_COMMAND,
            params.textDocument.uri,
            executeMethod.line,
            executeMethod.column,
          ),
        });
      }
    }
  }

  return lenses.length > 0 ? lenses : null;
}
