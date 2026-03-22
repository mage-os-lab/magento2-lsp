/**
 * LSP "textDocument/references" handler.
 *
 * Returns all di.xml locations that reference a given PHP class or method,
 * plus plugin PHP method locations for bidirectional plugin navigation.
 *
 * Works from four contexts:
 *
 *   1. From a di.xml file: determines which FQCN the cursor is on, then returns all
 *      di.xml locations referencing that FQCN.
 *
 *   2. From a PHP class declaration: cursor on `class Foo` returns all di.xml references
 *      to that class.
 *
 *   3. From a PHP method declaration on an intercepted method: returns the di.xml plugin
 *      declarations AND the plugin PHP method locations (beforeSave, afterSave, etc.)
 *      so you can jump directly to the plugin code.
 *
 *   4. From a plugin PHP method (e.g., `beforeSave`): returns the target class method
 *      it intercepts (save on the target class) plus the di.xml plugin declaration.
 */

import {
  ReferenceParams,
  Location,
  Range,
} from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { ProjectContext } from '../project/projectManager';
import { extractPhpClass, extractPhpMethods } from '../utils/phpNamespace';
import { locatePhpClass } from '../indexer/phpClassLocator';
import { isObserverReference } from '../index/eventsIndex';
import { realpath } from '../utils/realpath';
import * as fs from 'fs';

export function handleReferences(
  params: ReferenceParams,
  getProject: (uri: string) => ProjectContext | undefined,
): Location[] | null {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  const project = getProject(filePath);
  if (!project) return null;

  if (filePath.endsWith('.xml')) {
    return handleXmlReferences(filePath, params, project);
  }

  if (filePath.endsWith('.php')) {
    return handlePhpReferences(filePath, params, project);
  }

  return null;
}

/**
 * Handle references from an XML file (di.xml or events.xml).
 * Checks events.xml first, then falls back to di.xml.
 */
function handleXmlReferences(
  filePath: string,
  params: ReferenceParams,
  project: ProjectContext,
): Location[] | null {
  const { line, character } = params.position;

  // --- Try events.xml ---
  const eventsRef = project.eventsIndex.getReferenceAtPosition(filePath, line, character);
  if (eventsRef) {
    if (isObserverReference(eventsRef)) {
      // Cursor on an observer instance FQCN -> all events.xml locations for this class
      const observers = project.eventsIndex.getObserversForFqcn(eventsRef.fqcn);
      return refsToLocations(observers);
    } else {
      // Cursor on an event name -> all observers for this event (across all modules/areas)
      const observers = project.eventsIndex.getObserversForEvent(eventsRef.eventName);
      return refsToLocations(observers);
    }
  }

  // --- Try di.xml ---
  const ref = project.index.getReferenceAtPosition(filePath, line, character);
  if (!ref) return null;
  return refsToLocations(project.index.getReferencesForFqcn(ref.fqcn));
}

/**
 * Handle references from a PHP file. Checks in order:
 *   1. Cursor on class declaration -> all di.xml + events.xml class refs
 *   2. Cursor on a method name in a plugin class -> target method + di.xml declaration
 *   3. Cursor on a method name in a target class -> di.xml plugin refs + plugin PHP methods
 *   4. Cursor on execute() in an observer class -> events.xml declaration
 */
function handlePhpReferences(
  filePath: string,
  params: ReferenceParams,
  project: ProjectContext,
): Location[] | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const classInfo = extractPhpClass(content);
  if (!classInfo) return null;

  const { line, character } = params.position;

  // Check if cursor is on the class name declaration
  if (
    line === classInfo.line &&
    character >= classInfo.column &&
    character < classInfo.endColumn
  ) {
    // Include di.xml refs for this class AND all ancestor classes/interfaces,
    // plus events.xml observer registrations for this class.
    const allRefs: { file: string; line: number; column: number; endColumn: number }[] = [
      ...project.index.getReferencesForFqcn(classInfo.fqcn),
      ...project.eventsIndex.getObserversForFqcn(classInfo.fqcn),
    ];
    for (const ancestor of project.pluginMethodIndex.getAncestors(classInfo.fqcn)) {
      allRefs.push(...project.index.getReferencesForFqcn(ancestor));
    }
    return refsToLocations(allRefs);
  }

  // Check if cursor is on a method name
  const methods = extractPhpMethods(content);
  for (const method of methods) {
    if (
      line === method.line &&
      character >= method.column &&
      character < method.endColumn
    ) {
      // --- Case A: This is a plugin class and the method is a before/after/around method ---
      // Navigate to the intercepted method on the target class + the di.xml declaration.
      const reverseEntry = project.pluginMethodIndex.getReverseEntry(
        classInfo.fqcn,
        method.name,
      );
      if (reverseEntry) {
        const locations: Location[] = [];

        // Add the target class method location
        const targetLoc = locatePhpClass(reverseEntry.targetFqcn, project.psr4Map);
        if (targetLoc) {
          // Find the specific method in the target class file
          try {
            const targetContent = fs.readFileSync(targetLoc.file, 'utf-8');
            const targetMethods = extractPhpMethods(targetContent);
            const targetMethod = targetMethods.find(
              (m) => m.name === reverseEntry.targetMethodName,
            );
            if (targetMethod) {
              locations.push(
                Location.create(
                  URI.file(targetLoc.file).toString(),
                  Range.create(
                    targetMethod.line,
                    targetMethod.column,
                    targetMethod.line,
                    targetMethod.endColumn,
                  ),
                ),
              );
            }
          } catch {
            // Target file unreadable
          }
        }

        // Add the di.xml plugin declaration
        locations.push(
          Location.create(
            URI.file(reverseEntry.diRef.file).toString(),
            Range.create(
              reverseEntry.diRef.line,
              reverseEntry.diRef.column,
              reverseEntry.diRef.line,
              reverseEntry.diRef.endColumn,
            ),
          ),
        );

        return locations.length > 0 ? locations : null;
      }

      // --- Case B: Observer execute() method -> events.xml declarations ---
      if (method.name === 'execute') {
        const observerRefs = project.eventsIndex.getObserversForFqcn(classInfo.fqcn);
        if (observerRefs.length > 0) {
          return refsToLocations(observerRefs);
        }
      }

      // --- Case C: This is a target class and the method is intercepted by plugins ---
      // Navigate to the di.xml declarations + the plugin PHP methods.
      const plugins = project.pluginMethodIndex.getPluginsForMethod(
        classInfo.fqcn,
        method.name,
      );
      if (plugins.length === 0) return null;

      const seen = new Set<string>();
      const locations: Location[] = [];

      for (const p of plugins) {
        // Add the plugin PHP method location (e.g., beforeSave in the plugin class)
        const methodKey = `${p.pluginMethodFile}:${p.pluginMethodLine}`;
        if (!seen.has(methodKey)) {
          seen.add(methodKey);
          locations.push(
            Location.create(
              URI.file(p.pluginMethodFile).toString(),
              Range.create(
                p.pluginMethodLine,
                p.pluginMethodColumn,
                p.pluginMethodLine,
                p.pluginMethodEndColumn,
              ),
            ),
          );
        }

        // Add the di.xml plugin declaration (deduplicated)
        const diKey = `${p.diRef.file}:${p.diRef.line}:${p.diRef.column}`;
        if (!seen.has(diKey)) {
          seen.add(diKey);
          locations.push(
            Location.create(
              URI.file(p.diRef.file).toString(),
              Range.create(p.diRef.line, p.diRef.column, p.diRef.line, p.diRef.endColumn),
            ),
          );
        }
      }

      return locations.length > 0 ? locations : null;
    }
  }

  return null;
}

/** Convert a list of references to LSP Locations, returning null if empty. */
function refsToLocations(refs: { file: string; line: number; column: number; endColumn: number }[]): Location[] | null {
  if (refs.length === 0) return null;
  return refs.map((r) =>
    Location.create(
      URI.file(r.file).toString(),
      Range.create(r.line, r.column, r.line, r.endColumn),
    ),
  );
}
