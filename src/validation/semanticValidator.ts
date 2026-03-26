/**
 * Semantic validation for Magento XML files.
 *
 * Catches errors that XSD schema validation cannot:
 *   - Broken class references (FQCNs that don't resolve to PHP files)
 *   - Broken template references (template IDs that don't resolve to .phtml files)
 *   - Duplicate plugin names for the same target type
 *   - Observer classes not implementing ObserverInterface
 *
 * Unlike XSD validation (which validates raw XML content), semantic validation needs
 * to parse the XML into structured references first. It parses the current editor buffer
 * content directly — it does NOT read from the project index, which may be stale during
 * editing. The project index is still used for project-wide lookups (virtual types, PSR-4).
 */

import * as path from 'path';
import * as fs from 'fs';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { DiIndex } from '../index/diIndex';
import { isObserverReference } from '../index/eventsIndex';
import { resolveClassFile } from '../indexer/phpClassLocator';
import { parseDiXml, DiXmlParseContext } from '../indexer/diXmlParser';
import { parseEventsXml, EventsXmlParseContext } from '../indexer/eventsXmlParser';
import { parseLayoutXml } from '../indexer/layoutXmlParser';
import { parseSystemXml } from '../indexer/systemXmlParser';
import { parseWebapiXml } from '../indexer/webapiXmlParser';
import { parseMenuXml } from '../indexer/menuXmlParser';
import { parseUiComponentAcl } from '../indexer/uiComponentAclParser';
import { extractPhpClass, extractPhpMethods } from '../utils/phpNamespace';
import { createPhpAclRegex } from '../utils/phpAclGrep';
import {
  deriveDiXmlContext,
  deriveEventsXmlContext,
  deriveSystemXmlContext,
  deriveWebapiXmlContext,
  deriveMenuXmlContext,
  deriveUiComponentAclContext,
} from '../project/moduleResolver';
import type { ProjectContext } from '../project/projectManager';
import type { DiReference, LayoutReference, Psr4Map, ModuleInfo } from '../indexer/types';

/**
 * Run semantic validation on a single XML file by parsing the current buffer content.
 *
 * @param filePath  Absolute path to the file being validated.
 * @param content   Current editor buffer content (may differ from what's on disk).
 * @param project   The project context containing indexes and PSR-4 mappings.
 * @param includeExpensiveChecks  When true, run checks that require reading PHP files
 *                                 (e.g., ObserverInterface check). Typically true on save,
 *                                 false on keystroke.
 */
export function validateSemantics(
  filePath: string,
  content: string,
  project: ProjectContext,
  includeExpensiveChecks: boolean,
): Diagnostic[] {
  if (!project.indexingComplete) return [];

  // Detect file type from path and parse accordingly
  const diContext = deriveDiXmlContext(filePath, project.root, project.modules);
  if (diContext) {
    return validateDiXml(content, diContext, project, includeExpensiveChecks);
  }

  const eventsContext = deriveEventsXmlContext(filePath, project.modules);
  if (eventsContext) {
    return validateEventsXml(content, eventsContext, project, includeExpensiveChecks);
  }

  if (isLayoutXml(filePath)) {
    return validateLayoutXml(content, filePath, project);
  }

  const webapiContext = deriveWebapiXmlContext(filePath, project.modules);
  if (webapiContext) {
    return validateWebapiXml(content, webapiContext, project, includeExpensiveChecks);
  }

  const systemConfigContext = deriveSystemXmlContext(filePath, project.modules);
  if (systemConfigContext) {
    return validateSystemConfigXml(content, systemConfigContext, project);
  }

  const menuContext = deriveMenuXmlContext(filePath, project.modules);
  if (menuContext) {
    return validateMenuXml(content, menuContext, project);
  }

  const uiContext = deriveUiComponentAclContext(filePath, project.modules);
  if (uiContext) {
    return validateUiComponentAcl(content, uiContext, project);
  }

  // PHP files: validate ACL resource references in ADMIN_RESOURCE and isAllowed() patterns
  if (filePath.endsWith('.php')) {
    return validatePhpAcl(content, project);
  }

  return [];
}

// --- File type detection from path ---

function isLayoutXml(filePath: string): boolean {
  if (!filePath.endsWith('.xml')) return false;
  const dir = path.basename(path.dirname(filePath));
  return dir === 'layout' || dir === 'page_layout';
}

// --- di.xml validation ---

function validateDiXml(
  content: string,
  context: DiXmlParseContext,
  project: ProjectContext,
  includeExpensiveChecks: boolean,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { references, virtualTypes } = parseDiXml(content, context);

  // Build a local set of virtual type names declared in this file,
  // so we don't flag them as broken class references.
  const localVirtualTypeNames = new Set(virtualTypes.map((vt) => vt.name));

  for (const ref of references) {
    if (!isClassReferenceKind(ref.kind)) continue;
    // virtualtype-name is a declaration, not a reference to a PHP class
    if (ref.kind === 'virtualtype-name') continue;

    if (!classOrVirtualTypeExists(ref.fqcn, project.psr4Map, project.index, localVirtualTypeNames)) {
      diagnostics.push(makeDiagnostic(
        ref.line, ref.column, ref.endColumn,
        `Class "${ref.fqcn}" not found`,
        DiagnosticSeverity.Error,
      ));
    }
  }

  // Duplicate plugin names (check within this file AND against the project index)
  if (includeExpensiveChecks) {
    diagnostics.push(...findDuplicatePluginNames(references, context.file, project.index));
  }

  return diagnostics;
}

function findDuplicatePluginNames(
  refs: DiReference[],
  currentFile: string,
  diIndex: DiIndex,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const pluginRefs = refs.filter(
    (r): r is DiReference & { pluginName: string; parentTypeFqcn: string } =>
      r.kind === 'plugin-type' && !!r.pluginName && !!r.parentTypeFqcn,
  );

  // 1. Check for duplicates within this file
  const localGroups = new Map<string, typeof pluginRefs>();
  for (const ref of pluginRefs) {
    const key = `${ref.parentTypeFqcn}:${ref.pluginName}`;
    const group = localGroups.get(key) ?? [];
    group.push(ref);
    localGroups.set(key, group);
  }
  for (const [, group] of localGroups) {
    if (group.length <= 1) continue;
    for (const ref of group) {
      diagnostics.push(makeDiagnostic(
        ref.line, ref.column, ref.endColumn,
        `Duplicate plugin name "${ref.pluginName}" for ${ref.parentTypeFqcn}`,
        DiagnosticSeverity.Warning,
      ));
    }
  }

  // 2. Check against the project-wide index (plugins declared in other files)
  for (const ref of pluginRefs) {
    const key = `${ref.parentTypeFqcn}:${ref.pluginName}`;
    // Skip if already flagged as a local duplicate
    if ((localGroups.get(key)?.length ?? 0) > 1) continue;

    // Search the project index for a plugin with the same name + target in a different file
    for (const { targetFqcn, pluginRef } of diIndex.getAllPluginRefsWithTargets()) {
      if (
        pluginRef.file !== currentFile &&
        pluginRef.pluginName === ref.pluginName &&
        targetFqcn === ref.parentTypeFqcn
      ) {
        diagnostics.push(makeDiagnostic(
          ref.line, ref.column, ref.endColumn,
          `Plugin name "${ref.pluginName}" already declared for ${ref.parentTypeFqcn} in ${path.basename(path.dirname(path.dirname(pluginRef.file)))}`,
          DiagnosticSeverity.Warning,
        ));
        break; // One match is enough to flag it
      }
    }
  }

  return diagnostics;
}

// --- events.xml validation ---

function validateEventsXml(
  content: string,
  context: EventsXmlParseContext,
  project: ProjectContext,
  includeExpensiveChecks: boolean,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { events, observers } = parseEventsXml(content, context);
  const allRefs = [...events, ...observers];

  for (const ref of allRefs) {
    if (!isObserverReference(ref)) continue;

    const classFile = resolveClassFile(ref.fqcn, project.psr4Map);
    if (!classFile) {
      diagnostics.push(makeDiagnostic(
        ref.line, ref.column, ref.endColumn,
        `Observer class "${ref.fqcn}" not found`,
        DiagnosticSeverity.Error,
      ));
      continue;
    }

    // Check ObserverInterface implementation (expensive — reads PHP file)
    if (includeExpensiveChecks) {
      if (!implementsObserverInterface(classFile, ref.fqcn, project)) {
        diagnostics.push(makeDiagnostic(
          ref.line, ref.column, ref.endColumn,
          `"${ref.fqcn}" does not implement ObserverInterface`,
          DiagnosticSeverity.Warning,
        ));
      }
    }
  }

  return diagnostics;
}

const OBSERVER_INTERFACE = 'Magento\\Framework\\Event\\ObserverInterface';

function implementsObserverInterface(
  classFile: string,
  fqcn: string,
  project: ProjectContext,
): boolean {
  try {
    const content = fs.readFileSync(classFile, 'utf-8');
    const classInfo = extractPhpClass(content);
    if (!classInfo) return true; // Can't determine — don't warn

    // Direct implementation check
    if (classInfo.interfaces.includes(OBSERVER_INTERFACE)) return true;

    // Walk ancestors via class hierarchy
    const ancestors = project.pluginMethodIndex.getAncestors(fqcn);
    return ancestors.includes(OBSERVER_INTERFACE);
  } catch {
    return true; // Can't read file — don't warn
  }
}

// --- layout XML validation ---

function validateLayoutXml(
  content: string,
  filePath: string,
  project: ProjectContext,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { references } = parseLayoutXml(content, filePath);
  const area = inferAreaFromPath(filePath);

  for (const ref of references) {
    if (ref.kind === 'block-class' || ref.kind === 'argument-object') {
      if (!classOrVirtualTypeExists(ref.value, project.psr4Map, project.index, new Set())) {
        diagnostics.push(makeDiagnostic(
          ref.line, ref.column, ref.endColumn,
          `Class "${ref.value}" not found`,
          DiagnosticSeverity.Error,
        ));
      }
    } else if (ref.kind === 'block-template' || ref.kind === 'refblock-template') {
      const templateId = ref.resolvedTemplateId ?? ref.value;
      if (!templateId.includes('::')) continue; // Can't validate short paths without module context

      const resolved = project.themeResolver.resolveTemplate(
        templateId, area, undefined, project.modules,
      );
      if (resolved.length === 0) {
        diagnostics.push(makeDiagnostic(
          ref.line, ref.column, ref.endColumn,
          `Template "${templateId}" not found`,
          DiagnosticSeverity.Warning,
        ));
      }
    }
  }

  return diagnostics;
}

// --- system.xml validation ---

function validateSystemConfigXml(
  content: string,
  context: import('../indexer/systemXmlParser').SystemXmlParseContext,
  project: ProjectContext,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { references } = parseSystemXml(content, context);

  for (const ref of references) {
    if (ref.fqcn && (ref.kind === 'source-model' || ref.kind === 'backend-model' || ref.kind === 'frontend-model')) {
      if (!classOrVirtualTypeExists(ref.fqcn, project.psr4Map, project.index, new Set())) {
        const label = ref.kind === 'source-model' ? 'Source model'
          : ref.kind === 'backend-model' ? 'Backend model'
          : 'Frontend model';
        diagnostics.push(makeDiagnostic(
          ref.line, ref.column, ref.endColumn,
          `${label} class "${ref.fqcn}" not found`,
          DiagnosticSeverity.Error,
        ));
      }
    }

    if (ref.kind === 'section-resource' && ref.aclResourceId) {
      if (project.aclIndex.getAllResources(ref.aclResourceId).length === 0) {
        diagnostics.push(makeDiagnostic(
          ref.line, ref.column, ref.endColumn,
          `ACL resource "${ref.aclResourceId}" not defined in any acl.xml`,
          DiagnosticSeverity.Warning,
        ));
      }
    }
  }

  return diagnostics;
}

// --- webapi.xml validation ---

function validateWebapiXml(
  content: string,
  context: import('../indexer/webapiXmlParser').WebapiXmlParseContext,
  project: ProjectContext,
  includeExpensiveChecks: boolean,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { references } = parseWebapiXml(content, context);

  for (const ref of references) {
    if (ref.kind === 'service-class') {
      if (!classOrVirtualTypeExists(ref.value, project.psr4Map, project.index, new Set())) {
        diagnostics.push(makeDiagnostic(
          ref.line, ref.column, ref.endColumn,
          `Service class "${ref.value}" not found`,
          DiagnosticSeverity.Error,
        ));
      }
    }

    // Warn when a resource-ref points to an ACL resource not defined in any acl.xml.
    // "self" and "anonymous" are special Magento built-in values, not ACL resource IDs.
    if (ref.kind === 'resource-ref' && ref.value !== 'self' && ref.value !== 'anonymous') {
      if (project.aclIndex.getAllResources(ref.value).length === 0) {
        diagnostics.push(makeDiagnostic(
          ref.line, ref.column, ref.endColumn,
          `ACL resource "${ref.value}" not defined in any acl.xml`,
          DiagnosticSeverity.Warning,
        ));
      }
    }

    if (ref.kind === 'service-method' && ref.fqcn && includeExpensiveChecks) {
      const classFile = resolveClassFile(ref.fqcn, project.psr4Map);
      if (classFile) {
        try {
          const phpContent = fs.readFileSync(classFile, 'utf-8');
          const methods = extractPhpMethods(phpContent);
          if (!methods.some((m) => m.name === ref.value)) {
            diagnostics.push(makeDiagnostic(
              ref.line, ref.column, ref.endColumn,
              `Method "${ref.value}" not found on "${ref.fqcn}"`,
              DiagnosticSeverity.Warning,
            ));
          }
        } catch {
          // Can't read PHP file — don't warn
        }
      }
    }
  }

  return diagnostics;
}

// --- menu.xml validation ---

function validateMenuXml(
  content: string,
  context: import('../indexer/menuXmlParser').MenuXmlParseContext,
  project: ProjectContext,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { references } = parseMenuXml(content, context);

  for (const ref of references) {
    if (project.aclIndex.getAllResources(ref.value).length === 0) {
      diagnostics.push(makeDiagnostic(
        ref.line, ref.column, ref.endColumn,
        `ACL resource "${ref.value}" not defined in any acl.xml`,
        DiagnosticSeverity.Warning,
      ));
    }
  }

  return diagnostics;
}

// --- UI component ACL validation ---

function validateUiComponentAcl(
  content: string,
  context: import('../indexer/uiComponentAclParser').UiComponentAclParseContext,
  project: ProjectContext,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { references } = parseUiComponentAcl(content, context);

  for (const ref of references) {
    if (project.aclIndex.getAllResources(ref.value).length === 0) {
      diagnostics.push(makeDiagnostic(
        ref.line, ref.column, ref.endColumn,
        `ACL resource "${ref.value}" not defined in any acl.xml`,
        DiagnosticSeverity.Warning,
      ));
    }
  }

  return diagnostics;
}

// --- PHP ACL validation ---

/**
 * Validate ACL resource references in PHP files.
 *
 * Scans the PHP content for `const ADMIN_RESOURCE = '...'` and `->isAllowed('...')`
 * patterns, and warns when the referenced ACL resource ID is not defined in any acl.xml.
 */
function validatePhpAcl(
  content: string,
  project: ProjectContext,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = content.split('\n');

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    const re = createPhpAclRegex();
    let match;
    while ((match = re.exec(line)) !== null) {
      const aclId = match[1];
      const idStart = match.index + match[0].indexOf(aclId);

      if (project.aclIndex.getAllResources(aclId).length === 0) {
        diagnostics.push(makeDiagnostic(
          lineNum, idStart, idStart + aclId.length,
          `ACL resource "${aclId}" not defined in any acl.xml`,
          DiagnosticSeverity.Warning,
        ));
      }
    }
  }

  return diagnostics;
}

// --- helpers ---

function isClassReferenceKind(kind: string): boolean {
  return kind === 'preference-for'
    || kind === 'preference-type'
    || kind === 'type-name'
    || kind === 'plugin-type'
    || kind === 'argument-object'
    || kind === 'virtualtype-type'
    || kind === 'virtualtype-name';
}

function classOrVirtualTypeExists(
  fqcn: string,
  psr4Map: Psr4Map,
  diIndex: DiIndex,
  localVirtualTypeNames: Set<string>,
): boolean {
  // Unnamespaced classes (e.g., DateTime, stdClass) are PHP built-ins — skip them.
  if (!fqcn.includes('\\')) return true;
  if (resolveClassFile(fqcn, psr4Map)) return true;
  if (localVirtualTypeNames.has(fqcn)) return true;
  if (diIndex.getAllVirtualTypeDecls(fqcn).length > 0) return true;
  // Magento auto-generates Proxy and Factory classes at runtime.
  // Accept them if the base class exists.
  const baseFqcn = stripGeneratedSuffix(fqcn);
  if (baseFqcn && resolveClassFile(baseFqcn, psr4Map)) return true;
  // If the top-level namespace (vendor segment) isn't known in the PSR-4 map at all,
  // we can't tell whether the class exists (e.g., Adyen\ not installed, Magento\Setup\
  // lives in setup/src/). Don't flag what we can't verify.
  // But if the vendor IS known (e.g., Magento\, Hyva\), flag it — a typo in the
  // sub-namespace (Magento\Catlog\) should still be caught.
  if (!vendorKnownInPsr4(fqcn, psr4Map)) return true;
  return false;
}

/**
 * Check whether the top-level namespace (vendor segment) of a FQCN appears
 * in any PSR-4 entry. For example, "Magento\Catlog\Model\Foo" returns true
 * because there are PSR-4 entries starting with "Magento\".
 */
function vendorKnownInPsr4(fqcn: string, psr4Map: Psr4Map): boolean {
  const firstSep = fqcn.indexOf('\\');
  if (firstSep === -1) return false;
  const vendorPrefix = fqcn.slice(0, firstSep + 1); // e.g., "Magento\"
  return psr4Map.some((entry) => entry.prefix.startsWith(vendorPrefix));
}

/**
 * Strip Magento generated class suffixes (\Proxy, Factory, etc.).
 * Returns the base FQCN if the class looks generated, undefined otherwise.
 *
 * Examples:
 *   Magento\Framework\Session\SidResolver\Proxy -> Magento\Framework\Session\SidResolver
 *   Magento\Framework\Session\SidResolverFactory -> Magento\Framework\Session\SidResolver
 *   Magento\Catalog\Api\Data\ProductInterfaceFactory -> Magento\Catalog\Api\Data\ProductInterface
 */
function stripGeneratedSuffix(fqcn: string): string | undefined {
  // \Proxy is a sub-namespace: Vendor\Module\Class\Proxy
  if (fqcn.endsWith('\\Proxy')) {
    return fqcn.slice(0, -'\\Proxy'.length);
  }
  // Factory is appended directly: Vendor\Module\ClassFactory
  if (fqcn.endsWith('Factory')) {
    return fqcn.slice(0, -'Factory'.length);
  }
  return undefined;
}

function inferAreaFromPath(filePath: string): string {
  if (filePath.includes('/adminhtml/')) return 'adminhtml';
  if (filePath.includes('/frontend/')) return 'frontend';
  return 'frontend';
}

function makeDiagnostic(
  line: number,
  column: number,
  endColumn: number,
  message: string,
  severity: DiagnosticSeverity,
): Diagnostic {
  return {
    range: {
      start: { line, character: column },
      end: { line, character: endColumn },
    },
    severity,
    source: 'magento2-lsp',
    message,
  };
}
