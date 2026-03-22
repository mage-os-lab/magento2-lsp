/**
 * LSP "textDocument/codeLens" handler.
 *
 * Shows plugin indicators on PHP class and method declarations:
 *   - On target class declaration: "N plugins" if the class has any plugins
 *   - On each intercepted method: "N plugins"
 *   - On plugin before/after/around methods: "→ Target\Class::methodName"
 *
 * The code lens command triggers "find references" to show the related locations.
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

  if (!filePath.endsWith('.php')) {
    return null;
  }

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
