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
import { createPhpAclRegex, grepAclResourceInPhp } from '../utils/phpAclGrep';
import { isAreaCompatible } from '../utils/areaScope';
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
      // Template identifier -> find all layout files using this template,
      // scoped by area (a template in frontend only shows frontend + base refs)
      const templateId = layoutRef.resolvedTemplateId ?? layoutRef.value;
      const allTemplateRefs = project.layoutIndex.getReferencesForTemplate(templateId);
      const sourceArea = project.themeResolver.getAreaForFile(filePath);
      const filteredTemplateRefs = allTemplateRefs.filter((ref) =>
        isAreaCompatible(sourceArea, project.themeResolver.getAreaForFile(ref.file)),
      );
      return refsToLocations(filteredTemplateRefs);
    }
    // block/container name or reference -> find all declarations and references for this name,
    // scoped by area (a name in frontend only shows frontend + base refs, not adminhtml)
    if (
      layoutRef.kind === 'block-name' || layoutRef.kind === 'container-name'
      || layoutRef.kind === 'reference-block' || layoutRef.kind === 'reference-container'
    ) {
      const allRefs = project.layoutIndex.getRefsForName(layoutRef.value);
      const sourceArea = project.themeResolver.getAreaForFile(filePath);
      const filtered = allRefs.filter((ref) =>
        isAreaCompatible(sourceArea, project.themeResolver.getAreaForFile(ref.file)),
      );
      return refsToLocations(filtered);
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
    // section-resource -> all system.xml + acl.xml refs for that ACL resource
    if (sysRef.kind === 'section-resource' && sysRef.aclResourceId) {
      const sysRefs = project.systemConfigIndex.getRefsForAclResource(sysRef.aclResourceId);
      const aclDefs = project.aclIndex.getAllResources(sysRef.aclResourceId);
      return refsToLocations([...sysRefs, ...aclDefs]);
    }
    // section/group/field -> XML declarations + PHP usages of this config path
    const pathRefs = project.systemConfigIndex.getRefsForPath(sysRef.configPath)
      .filter((r) => r.kind === sysRef.kind);
    const phpUsages = sysRef.kind === 'field-id'
      ? await grepConfigPathInPhp(sysRef.configPath, project.root, project.psr4Map)
      : [];
    return refsToLocations([...pathRefs, ...phpUsages]);
  }

  // --- Try webapi.xml ---
  const webapiRef = project.webapiIndex.getReferenceAtPosition(filePath, line, character);
  if (webapiRef) {
    if (webapiRef.kind === 'service-class') {
      const webapiRefs = project.webapiIndex.getRefsForFqcn(webapiRef.value);
      const diRefs = project.index.getReferencesForFqcn(webapiRef.value);
      return refsToLocations([...webapiRefs, ...diRefs]);
    }
    if (webapiRef.kind === 'service-method' && webapiRef.fqcn && webapiRef.methodName) {
      return refsToLocations(project.webapiIndex.getRefsForMethod(webapiRef.fqcn, webapiRef.methodName));
    }
    if (webapiRef.kind === 'resource-ref') {
      // Include both webapi.xml usages and the acl.xml definition(s)
      const webapiRefs = project.webapiIndex.getRefsForResource(webapiRef.value);
      const aclDefs = project.aclIndex.getAllResources(webapiRef.value);
      return refsToLocations([...webapiRefs, ...aclDefs]);
    }
  }

  // --- Try acl.xml ---
  const aclResource = project.aclIndex.getResourceAtPosition(filePath, line, character);
  if (aclResource) {
    // From an acl.xml resource definition, find all references across XML types and PHP files
    const webapiRefs = project.webapiIndex.getRefsForResource(aclResource.id);
    const systemRefs = project.systemConfigIndex.getRefsForAclResource(aclResource.id);
    const menuRefs = project.menuIndex.getRefsForResource(aclResource.id);
    const uiRefs = project.uiComponentAclIndex.getRefsForResource(aclResource.id);
    const phpUsages = await grepAclResourceInPhp(aclResource.id, project.root, project.psr4Map);
    return refsToLocations([...webapiRefs, ...systemRefs, ...menuRefs, ...uiRefs, ...phpUsages]);
  }

  // --- Try menu.xml ---
  const menuRef = project.menuIndex.getReferenceAtPosition(filePath, line, character);
  if (menuRef) {
    const menuRefs = project.menuIndex.getRefsForResource(menuRef.value);
    const aclDefs = project.aclIndex.getAllResources(menuRef.value);
    return refsToLocations([...menuRefs, ...aclDefs]);
  }

  // --- Try UI component aclResource ---
  const uiAclRef = project.uiComponentAclIndex.getReferenceAtPosition(filePath, line, character);
  if (uiAclRef) {
    const uiRefs = project.uiComponentAclIndex.getRefsForResource(uiAclRef.value);
    const aclDefs = project.aclIndex.getAllResources(uiAclRef.value);
    return refsToLocations([...uiRefs, ...aclDefs]);
  }

  // --- Try db_schema.xml ---
  const dbSchemaRef = project.dbSchemaIndex.getReferenceAtPosition(filePath, line, character);
  if (dbSchemaRef) {
    if (dbSchemaRef.kind === 'table-name' || dbSchemaRef.kind === 'fk-ref-table') {
      // Show all refs for this table across all modules
      const tableName = dbSchemaRef.value;
      return refsToLocations(project.dbSchemaIndex.getRefsForTable(tableName));
    }
    if (dbSchemaRef.kind === 'column-name') {
      // Show all column-name refs with same name on same table across modules
      const cols = project.dbSchemaIndex.getColumnsForTable(dbSchemaRef.tableName)
        .filter((r) => r.value === dbSchemaRef.value);
      return refsToLocations(cols);
    }
    if (dbSchemaRef.kind === 'fk-ref-column') {
      // Show all refs for the referenced table
      const tableName = dbSchemaRef.fkRefTable ?? dbSchemaRef.tableName;
      return refsToLocations(project.dbSchemaIndex.getRefsForTable(tableName));
    }
    return null;
  }

  // --- Try routes.xml ---
  const routesRef = project.routesIndex.getReferenceAtPosition(filePath, line, character);
  if (routesRef) {
    if (routesRef.kind === 'route-module') {
      // Show all declarations for the route this module is part of
      return refsToLocations(project.routesIndex.getRefsForRouteId(routesRef.routeId));
    } else {
      // route-frontname or route-id: show same-kind refs from OTHER files only,
      // since same-file refs are already visible and clients filter same-line results
      const allRefs = project.routesIndex.getRefsForRouteId(routesRef.routeId);
      const otherFileRefs = allRefs.filter((r) => r.file !== filePath);
      return refsToLocations(otherFileRefs);
    }
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
    // Include di.xml, events.xml, layout XML, system.xml, webapi.xml, and plugin method refs,
    // plus inherited di.xml/webapi refs from ancestor classes/interfaces.
    const allRefs: { file: string; line: number; column: number; endColumn: number }[] = [
      ...project.index.getReferencesForFqcn(classInfo.fqcn),
      ...project.eventsIndex.getObserversForFqcn(classInfo.fqcn),
      ...project.layoutIndex.getReferencesForFqcn(classInfo.fqcn),
      ...project.systemConfigIndex.getRefsForFqcn(classInfo.fqcn),
      ...project.webapiIndex.getRefsForFqcn(classInfo.fqcn).filter((r) => r.kind === 'service-class'),
    ];
    for (const ancestor of project.pluginMethodIndex.getAncestors(classInfo.fqcn)) {
      allRefs.push(...project.index.getReferencesForFqcn(ancestor));
      allRefs.push(...project.webapiIndex.getRefsForFqcn(ancestor).filter((r) => r.kind === 'service-class'));
    }
    // Include plugin PHP method locations (before/after/around methods)
    const interceptedMethods = project.pluginMethodIndex.getInterceptedMethods(classInfo.fqcn);
    if (interceptedMethods) {
      const seen = new Set<string>();
      for (const interceptions of interceptedMethods.values()) {
        for (const p of interceptions) {
          const key = `${p.pluginMethodFile}:${p.pluginMethodLine}`;
          if (!seen.has(key)) {
            seen.add(key);
            allRefs.push({
              file: p.pluginMethodFile,
              line: p.pluginMethodLine,
              column: p.pluginMethodColumn,
              endColumn: p.pluginMethodEndColumn,
            });
          }
        }
      }
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

      // Accumulate all method-level references (observers, webapi, plugins)
      // instead of returning early from each — a method can have multiple kinds.
      const locations: Location[] = [];

      // --- Observer execute() method -> events.xml declarations ---
      if (method.name === 'execute') {
        const observerRefs = project.eventsIndex.getObserversForFqcn(classInfo.fqcn);
        if (observerRefs.length > 0) {
          const locs = refsToLocations(observerRefs);
          if (locs) locations.push(...locs);
        }
      }

      // --- Service interface method -> webapi.xml routes ---
      const webapiMethodRefs: { file: string; line: number; column: number; endColumn: number }[] = [
        ...project.webapiIndex.getRefsForMethod(classInfo.fqcn, method.name),
      ];
      for (const iface of classInfo.interfaces) {
        webapiMethodRefs.push(...project.webapiIndex.getRefsForMethod(iface, method.name));
      }
      if (webapiMethodRefs.length > 0) {
        const locs = refsToLocations(webapiMethodRefs);
        if (locs) locations.push(...locs);
      }

      // --- Plugins: di.xml declarations + plugin PHP methods ---
      const plugins = project.pluginMethodIndex.getPluginsForMethod(
        classInfo.fqcn,
        method.name,
      );

      if (plugins.length > 0) {
        const seen = new Set<string>();
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

    // --- ACL resource detection: const ADMIN_RESOURCE = '...' or ->isAllowed('...') ---
    const aclRefs = await findPhpAclRefs(currentLine, character, project);
    if (aclRefs) return aclRefs;
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

    // Use <= to give a slightly generous hit area (one char past the token)
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
 * Check if cursor is on an ACL resource ID in a PHP file.
 * Matches `const ADMIN_RESOURCE = '...'` and `->isAllowed('...')` patterns.
 *
 * Returns all references to that ACL resource across:
 *   - acl.xml definitions (the declaration sites)
 *   - webapi.xml, system.xml, menu.xml, and UI component XML references
 *   - PHP usages found by grepping PSR-4 directories
 */
async function findPhpAclRefs(
  line: string,
  character: number,
  project: ProjectContext,
): Promise<Location[] | null> {
  const re = createPhpAclRegex();
  let match;
  while ((match = re.exec(line)) !== null) {
    const aclId = match[1];
    const idStart = match.index + match[0].indexOf(aclId);
    const idEnd = idStart + aclId.length;

    // Use <= to give a slightly generous hit area (one char past the token)
    if (character >= idStart && character <= idEnd) {
      // Collect references from all sources: acl.xml definitions + all XML indexes + PHP grep
      const aclDefs = project.aclIndex.getAllResources(aclId);
      const webapiRefs = project.webapiIndex.getRefsForResource(aclId);
      const systemRefs = project.systemConfigIndex.getRefsForAclResource(aclId);
      const menuRefs = project.menuIndex.getRefsForResource(aclId);
      const uiRefs = project.uiComponentAclIndex.getRefsForResource(aclId);
      const phpUsages = await grepAclResourceInPhp(aclId, project.root, project.psr4Map);
      return refsToLocations([
        ...aclDefs, ...webapiRefs, ...systemRefs, ...menuRefs, ...uiRefs, ...phpUsages,
      ]);
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

  // 1. Layout XML files that use this template, scoped by area
  const area = project.themeResolver.getAreaForFile(filePath) ?? 'frontend';
  const layoutRefs = project.layoutIndex.getReferencesForTemplate(templateId);
  for (const r of layoutRefs) {
    if (!isAreaCompatible(area, project.themeResolver.getAreaForFile(r.file))) continue;
    locations.push(
      Location.create(
        URI.file(r.file).toString(),
        Range.create(r.line, r.column, r.line, r.endColumn),
      ),
    );
  }

  // 2. Theme override files for this template
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
