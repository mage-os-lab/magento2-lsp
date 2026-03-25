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
  CancellationToken,
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
import { reverseResolveTemplateId } from '../utils/templateId';
import { createScopeConfigRegex, grepConfigPathInPhp } from '../utils/configPathGrep';
import * as fs from 'fs';

export async function handleReferences(
  params: ReferenceParams,
  getProject: (uri: string) => ProjectContext | undefined,
  token?: CancellationToken,
): Promise<Location[] | null> {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  const project = getProject(filePath);
  if (!project) return null;

  if (filePath.endsWith('.xml')) {
    return handleXmlReferences(filePath, params, project);
  }

  if (filePath.endsWith('.php')) {
    return handlePhpReferences(filePath, params, project, token);
  }

  if (filePath.endsWith('.phtml')) {
    return handlePhtmlReferences(filePath, project);
  }

  return null;
}

/**
 * Handle references from an XML file (di.xml, events.xml, or layout XML).
 * Tries layout XML, then events.xml, then di.xml.
 */
async function handleXmlReferences(
  filePath: string,
  params: ReferenceParams,
  project: ProjectContext,
): Promise<Location[] | null> {
  const { line, character } = params.position;

  // --- Try layout XML ---
  const layoutRef = project.layoutIndex.getReferenceAtPosition(filePath, line, character);
  if (layoutRef) {
    if (layoutRef.kind === 'block-template' || layoutRef.kind === 'refblock-template') {
      // Template identifier -> find all layout files using this template
      const templateId = layoutRef.resolvedTemplateId ?? layoutRef.value;
      return refsToLocations(project.layoutIndex.getReferencesForTemplate(templateId));
    }
    // block-class or argument-object -> find all layout + di.xml refs for this FQCN
    const layoutRefs = project.layoutIndex.getReferencesForFqcn(layoutRef.value);
    const diRefs = project.index.getReferencesForFqcn(layoutRef.value);
    return refsToLocations([...layoutRefs, ...diRefs]);
  }

  // --- Try system.xml ---
  const sysRef = project.systemConfigIndex.getReferenceAtPosition(filePath, line, character);
  if (sysRef) {
    if (sysRef.fqcn) {
      // source/backend/frontend model -> all refs for that FQCN (system.xml + di.xml)
      const sysRefs = project.systemConfigIndex.getRefsForFqcn(sysRef.fqcn);
      const diRefs = project.index.getReferencesForFqcn(sysRef.fqcn);
      return refsToLocations([...sysRefs, ...diRefs]);
    }
    // section/group/field -> XML declarations + PHP usages of this config path
    const pathRefs = project.systemConfigIndex.getRefsForPath(sysRef.configPath)
      .filter((r) => r.kind === sysRef.kind);
    const phpUsages = sysRef.kind === 'field-id'
      ? await grepConfigPathInPhp(sysRef.configPath, project.root, project.psr4Map)
      : [];
    return refsToLocations([...pathRefs, ...phpUsages]);
  }

  // --- Try events.xml ---
  const eventsRef = project.eventsIndex.getReferenceAtPosition(filePath, line, character);
  if (eventsRef) {
    if (isObserverReference(eventsRef)) {
      const observers = project.eventsIndex.getObserversForFqcn(eventsRef.fqcn);
      return refsToLocations(observers);
    } else {
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
async function handlePhpReferences(
  filePath: string,
  params: ReferenceParams,
  project: ProjectContext,
  token?: CancellationToken,
): Promise<Location[] | null> {
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
    // Include di.xml, events.xml, layout XML, and system.xml refs for this class,
    // plus inherited di.xml refs from ancestor classes/interfaces.
    const allRefs: { file: string; line: number; column: number; endColumn: number }[] = [
      ...project.index.getReferencesForFqcn(classInfo.fqcn),
      ...project.eventsIndex.getObserversForFqcn(classInfo.fqcn),
      ...project.layoutIndex.getReferencesForFqcn(classInfo.fqcn),
      ...project.systemConfigIndex.getRefsForFqcn(classInfo.fqcn),
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
        if (token?.isCancellationRequested) return null;
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

  // --- Config path detection: scopeConfig->getValue('section/group/field') ---
  const lines = content.split('\n');
  const currentLine = lines[line];
  if (currentLine) {
    const configRefs = await findPhpConfigPathRefs(currentLine, character, project);
    if (configRefs) return configRefs;
  }

  return null;
}

/**
 * Check if cursor is on a config path string in a scopeConfig call.
 * Returns system.xml field declarations + PHP usages of that config path.
 */
async function findPhpConfigPathRefs(
  line: string,
  character: number,
  project: ProjectContext,
): Promise<Location[] | null> {
  const re = createScopeConfigRegex();
  let match;
  while ((match = re.exec(line)) !== null) {
    const configPath = match[1];
    const pathStart = match.index + match[0].indexOf(configPath);
    const pathEnd = pathStart + configPath.length;

    if (character >= pathStart && character <= pathEnd) {
      const fieldRefs = project.systemConfigIndex.getRefsForPath(configPath)
        .filter((r) => r.kind === 'field-id');
      const phpUsages = await grepConfigPathInPhp(configPath, project.root, project.psr4Map);
      return refsToLocations([...fieldRefs, ...phpUsages]);
    }
  }
  return null;
}

/**
 * Handle references from a .phtml template file.
 *
 * Collects four kinds of related locations:
 *   1. Layout XML files that reference this template (via layoutIndex)
 *   2. Theme override files — all themes that override this template
 *   3. Hyvä compat module override files — compat modules that override this template
 *   4. The original module template (if the current file is a theme/compat override)
 *
 * This means grr on a module template shows layout XML usages + all overrides,
 * and grr on an override shows layout XML usages + the original + sibling overrides.
 *
 * Template paths can be:
 *   - In a module: {modulePath}/view/frontend/templates/product/view.phtml
 *     -> Template ID: Module_Name::product/view.phtml
 *   - In a theme override: {themePath}/Module_Name/templates/product/view.phtml
 *     -> Template ID: Module_Name::product/view.phtml
 *   - In a compat module: {compatPath}/view/frontend/templates/[Orig_Module/]product/view.phtml
 *     -> Template ID: Orig_Module::product/view.phtml
 */
function handlePhtmlReferences(
  filePath: string,
  project: ProjectContext,
): Location[] | null {
  const templateId = reverseResolveTemplateId(
    filePath,
    project.modules,
    project.themeResolver,
    project.compatModuleIndex,
  );
  if (!templateId) return null;

  const locations: Location[] = [];

  // 1. Layout XML files that use this template
  const layoutRefs = project.layoutIndex.getReferencesForTemplate(templateId);
  for (const r of layoutRefs) {
    locations.push(
      Location.create(
        URI.file(r.file).toString(),
        Range.create(r.line, r.column, r.line, r.endColumn),
      ),
    );
  }

  // 2. Theme override files for this template
  const area = project.themeResolver.getAreaForFile(filePath) ?? 'frontend';
  const themeOverrides = project.themeResolver.findOverrides(templateId, area);
  for (const { filePath: overridePath } of themeOverrides) {
    if (overridePath === filePath) continue;
    locations.push(
      Location.create(
        URI.file(overridePath).toString(),
        Range.create(0, 0, 0, 0),
      ),
    );
  }

  // 3. Hyvä compat module override files for this template
  const compatOverrides = project.compatModuleIndex.findOverrides(templateId);
  for (const { filePath: overridePath } of compatOverrides) {
    if (overridePath === filePath) continue;
    locations.push(
      Location.create(
        URI.file(overridePath).toString(),
        Range.create(0, 0, 0, 0),
      ),
    );
  }

  // 4. If the current file is a theme override, include the original module template
  const themeOriginal = project.themeResolver.getOriginalModuleTemplate(filePath, project.modules);
  if (themeOriginal) {
    locations.push(
      Location.create(
        URI.file(themeOriginal).toString(),
        Range.create(0, 0, 0, 0),
      ),
    );
  }

  // 5. If the current file is a compat module override, include the original module template
  const compatOriginal = project.compatModuleIndex.getOriginalModuleTemplate(filePath, project.modules);
  if (compatOriginal) {
    locations.push(
      Location.create(
        URI.file(compatOriginal).toString(),
        Range.create(0, 0, 0, 0),
      ),
    );
  }

  return locations.length > 0 ? locations : null;
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
