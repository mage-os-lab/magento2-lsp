/**
 * LSP "textDocument/prepareRename" and "textDocument/rename" handlers.
 *
 * Supports renaming four kinds of Magento symbols across all XML config files
 * and PHP files project-wide:
 *
 *   1. FQCN (class/interface) — renames across di.xml, events.xml, layout XML,
 *      system.xml (model classes), and webapi.xml (service classes).
 *
 *   2. Template identifier — renames the Module_Name::path/to/file.phtml string
 *      across all layout XML files that reference it.
 *
 *   3. ACL resource ID — renames across acl.xml definitions, webapi.xml resource refs,
 *      menu.xml resource attrs, system.xml section resources, UI component aclResource
 *      elements, and PHP constants/isAllowed() calls.
 *
 *   4. Config field ID — renames a system.xml field ID and updates PHP
 *      scopeConfig->getValue('section/group/field') calls to match.
 *
 * The handler reuses the same index query methods used by the references handler,
 * converting each reference's position into a TextEdit that replaces the old value
 * with the user-supplied new name.
 *
 * Architecture:
 *   - getRenameContext() is the shared dispatch that determines what symbol the cursor
 *     is on and whether it supports rename. Used by both prepareRename and rename.
 *   - collectRefs*() functions gather all references for each symbol kind.
 *   - buildWorkspaceEdit() converts references into a WorkspaceEdit.
 */

import {
  CancellationToken,
  PrepareRenameParams,
  Range,
  RenameParams,
  TextEdit,
  WorkspaceEdit,
} from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { ProjectContext } from '../project/projectManager';
import { extractPhpClass } from '../utils/phpNamespace';
import { isObserverReference } from '../index/eventsIndex';
import { realpath } from '../utils/realpath';
import { createScopeConfigRegex, grepConfigPathInPhp, grepConfigPathsInPhp } from '../utils/configPathGrep';
import { createPhpAclRegex, grepAclResourceInPhp } from '../utils/phpAclGrep';
import { resolveSourceFqcn, generatedVariants } from '../utils/generatedClassResolver';
import { isAreaCompatible } from '../utils/areaScope';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Which kind of Magento symbol the cursor is on.
 * Determines which indexes are queried to collect references for the rename.
 */
type RenameSymbolKind = 'fqcn' | 'template' | 'acl-resource' | 'config-segment' | 'block-name';

/**
 * Result of identifying a renameable symbol at the cursor position.
 * Returned by getRenameContext() and consumed by both prepareRename and rename.
 */
interface RenameContext {
  kind: RenameSymbolKind;
  /** The current text shown as placeholder (FQCN, template ID, ACL ID, or config segment name). */
  currentValue: string;
  /** The exact range of the symbol value in the source file (for prepareRename). */
  range: Range;
  /**
   * For block-name renames: the file where the rename was initiated.
   * Used to determine the area scope — a rename in a frontend file should only
   * affect frontend + base layout files, not adminhtml files.
   */
  sourceFile?: string;
  /**
   * For config-segment renames: the full config path up to and including this segment.
   * E.g., for field "active" in path "catalog/review/active", this is "catalog/review/active".
   * For group "review" in path "catalog/review", this is "catalog/review".
   */
  configPath?: string;
  /**
   * For config-segment renames: which segment level is being renamed.
   * Determines how to find descendant paths and how to update PHP references.
   */
  configSegmentKind?: 'section-id' | 'group-id' | 'field-id';
}

/** Minimal reference position — the common shape across all index reference types. */
interface RefPosition {
  file: string;
  line: number;
  column: number;
  endColumn: number;
}

/**
 * A single text replacement in a rename operation.
 * Each edit carries its own newText because generated class references (e.g.
 * Foo\Bar\Proxy, FooFactory) need a suffix-aware replacement that differs
 * from the base FQCN rename.
 */
interface RenameEdit extends RefPosition {
  newText: string;
}

// Generated class handling is centralised in generatedClassResolver.ts.

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handle textDocument/prepareRename.
 *
 * Validates that the cursor is on a renameable symbol and returns the exact range
 * and current value as placeholder text. Returns null if rename is not supported
 * at this position (the client will show "cannot rename this element").
 */
export function handlePrepareRename(
  params: PrepareRenameParams,
  getProject: (uri: string) => ProjectContext | undefined,
): { range: Range; placeholder: string } | null {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  const project = getProject(filePath);
  if (!project) return null;

  const ctx = getRenameContext(filePath, params.position.line, params.position.character, project);
  if (!ctx) return null;

  return { range: ctx.range, placeholder: ctx.currentValue };
}

/**
 * Handle textDocument/rename.
 *
 * Collects all references to the symbol at the cursor position and returns a
 * WorkspaceEdit that replaces every occurrence with the new name.
 *
 * For ACL resources and config paths, this involves an async grep of PHP files,
 * so the function is async.
 */
export async function handleRename(
  params: RenameParams,
  getProject: (uri: string) => ProjectContext | undefined,
  _token?: CancellationToken,
): Promise<WorkspaceEdit | null> {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  const project = getProject(filePath);
  if (!project) return null;

  const ctx = getRenameContext(filePath, params.position.line, params.position.character, project);
  if (!ctx) return null;

  const edits = await collectEdits(ctx, params.newName, project);
  if (edits.length === 0) return null;

  return buildWorkspaceEdit(edits);
}

// ---------------------------------------------------------------------------
// Dispatch: determine what symbol the cursor is on
// ---------------------------------------------------------------------------

/**
 * Determine which renameable symbol (if any) the cursor is on.
 *
 * Tries each index in the same priority order as the references handler.
 * Returns null for symbols that don't support rename (event names, route IDs,
 * db_schema elements, block/container names, etc.).
 */
function getRenameContext(
  filePath: string,
  line: number,
  character: number,
  project: ProjectContext,
): RenameContext | null {
  if (filePath.endsWith('.xml')) {
    return getXmlRenameContext(filePath, line, character, project);
  }
  if (filePath.endsWith('.php')) {
    return getPhpRenameContext(filePath, line, character, project);
  }
  return null;
}

/**
 * Check XML files for renameable symbols.
 * Tries indexes in priority order; returns null for non-renameable XML elements.
 */
function getXmlRenameContext(
  filePath: string,
  line: number,
  character: number,
  project: ProjectContext,
): RenameContext | null {
  // --- Layout XML: block-class, block-template, argument-object ---
  const layoutRef = project.indexes.layout.getReferenceAtPosition(filePath, line, character);
  if (layoutRef) {
    if (layoutRef.kind === 'block-class' || layoutRef.kind === 'argument-object') {
      return {
        kind: 'fqcn',
        currentValue: resolveSourceFqcn(layoutRef.value) ?? layoutRef.value,
        range: refToRange(layoutRef),
      };
    }
    if (layoutRef.kind === 'block-template' || layoutRef.kind === 'refblock-template') {
      const templateId = layoutRef.resolvedTemplateId ?? layoutRef.value;
      return {
        kind: 'template',
        currentValue: templateId,
        range: refToRange(layoutRef),
        sourceFile: filePath,
      };
    }
    if (
      layoutRef.kind === 'block-name' || layoutRef.kind === 'container-name'
      || layoutRef.kind === 'reference-block' || layoutRef.kind === 'reference-container'
      || layoutRef.kind === 'before-after'
      || layoutRef.kind === 'move-element' || layoutRef.kind === 'move-destination'
    ) {
      return {
        kind: 'block-name',
        currentValue: layoutRef.value,
        range: refToRange(layoutRef),
        sourceFile: filePath,
      };
    }

    // as="alias" — only renameable if the alias matches a known block/container name.
    // Alias-only renames would require tracking the full layout hierarchy, which the
    // LSP does not support.
    if (layoutRef.kind === 'block-alias') {
      const nameRefs = project.indexes.layout.getRefsForName(layoutRef.value);
      const isKnownName = nameRefs.some(
        (r) => r.kind === 'block-name' || r.kind === 'container-name',
      );
      if (isKnownName) {
        return {
          kind: 'block-name',
          currentValue: layoutRef.value,
          range: refToRange(layoutRef),
          sourceFile: filePath,
        };
      }
      return null;
    }
    return null;
  }

  // --- system.xml: models (FQCN), ACL resources, and config path segments ---
  const sysRef = project.indexes.systemConfig.getReferenceAtPosition(filePath, line, character);
  if (sysRef) {
    if (sysRef.fqcn) {
      return {
        kind: 'fqcn',
        currentValue: resolveSourceFqcn(sysRef.fqcn) ?? sysRef.fqcn,
        range: refToRange(sysRef),
      };
    }
    if (sysRef.kind === 'section-resource' && sysRef.aclResourceId) {
      return {
        kind: 'acl-resource',
        currentValue: sysRef.aclResourceId,
        range: refToRange(sysRef),
      };
    }
    if (sysRef.kind === 'section-id' || sysRef.kind === 'group-id' || sysRef.kind === 'field-id') {
      // Extract just the segment name from the config path.
      // configPath is "section" for section-id, "section/group" for group-id,
      // "section/group/field" for field-id. The segment name is the last part.
      const segments = sysRef.configPath.split('/');
      const segmentName = segments[segments.length - 1];
      return {
        kind: 'config-segment',
        currentValue: segmentName,
        range: refToRange(sysRef),
        configPath: sysRef.configPath,
        configSegmentKind: sysRef.kind,
      };
    }
    return null;
  }

  // --- webapi.xml: service class (FQCN), resource ref (ACL) ---
  const webapiRef = project.indexes.webapi.getReferenceAtPosition(filePath, line, character);
  if (webapiRef) {
    if (webapiRef.kind === 'service-class') {
      return {
        kind: 'fqcn',
        currentValue: webapiRef.value,
        range: refToRange(webapiRef),
      };
    }
    if (webapiRef.kind === 'resource-ref') {
      return {
        kind: 'acl-resource',
        currentValue: webapiRef.value,
        range: refToRange(webapiRef),
      };
    }
    // service-method rename is not supported (would need to rename the PHP method too)
    return null;
  }

  // --- acl.xml: resource definitions ---
  const aclResource = project.indexes.acl.getResourceAtPosition(filePath, line, character);
  if (aclResource) {
    return {
      kind: 'acl-resource',
      currentValue: aclResource.id,
      range: refToRange(aclResource),
    };
  }

  // --- menu.xml: ACL resource attribute ---
  const menuRef = project.indexes.menu.getReferenceAtPosition(filePath, line, character);
  if (menuRef) {
    return {
      kind: 'acl-resource',
      currentValue: menuRef.value,
      range: refToRange(menuRef),
    };
  }

  // --- UI component aclResource ---
  const uiAclRef = project.indexes.uiComponentAcl.getReferenceAtPosition(filePath, line, character);
  if (uiAclRef) {
    return {
      kind: 'acl-resource',
      currentValue: uiAclRef.value,
      range: refToRange(uiAclRef),
    };
  }

  // --- events.xml: observer class (FQCN) ---
  const eventsRef = project.indexes.events.getReferenceAtPosition(filePath, line, character);
  if (eventsRef) {
    // Only observer FQCN references are renameable; event names are not
    if (isObserverReference(eventsRef)) {
      return {
        kind: 'fqcn',
        currentValue: resolveSourceFqcn(eventsRef.fqcn) ?? eventsRef.fqcn,
        range: refToRange(eventsRef),
      };
    }
    return null;
  }

  // --- di.xml: all class references ---
  const diRef = project.indexes.di.getReferenceAtPosition(filePath, line, character);
  if (diRef) {
    // If the cursor is on a generated class (e.g. Foo\Proxy, FooFactory), resolve
    // to the base FQCN so the user renames the real class and generated variants
    // are updated automatically with their suffixes preserved.
    return {
      kind: 'fqcn',
      currentValue: resolveSourceFqcn(diRef.fqcn) ?? diRef.fqcn,
      range: refToRange(diRef),
    };
  }

  return null;
}

/**
 * Check PHP files for renameable symbols.
 * Supports: class declaration (FQCN), config path string, ACL resource string.
 */
function getPhpRenameContext(
  filePath: string,
  line: number,
  character: number,
  project: ProjectContext,
): RenameContext | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  // --- Class declaration: cursor on "class Foo" ---
  const classInfo = extractPhpClass(content);
  if (
    classInfo &&
    line === classInfo.line &&
    character >= classInfo.column &&
    character < classInfo.endColumn
  ) {
    return {
      kind: 'fqcn',
      currentValue: classInfo.fqcn,
      range: Range.create(classInfo.line, classInfo.column, classInfo.line, classInfo.endColumn),
    };
  }

  // --- Config path string: scopeConfig->getValue('section/group/field') ---
  const lines = content.split('\n');
  const currentLine = lines[line];
  if (currentLine) {
    const configCtx = matchConfigPath(currentLine, line, character);
    if (configCtx) return configCtx;

    const aclCtx = matchAclResource(currentLine, line, character);
    if (aclCtx) return aclCtx;
  }

  return null;
}

/**
 * Check if the cursor is on a config path string in a scopeConfig call.
 * Returns a RenameContext for config-segment, or null if no match.
 *
 * PHP config paths are always full paths (e.g., "section/group/field"), so the
 * rename placeholder shows the full path and the replacement is also a full path.
 * The segment kind is inferred as field-id since PHP getValue() calls reference
 * the full path down to the field level.
 */
function matchConfigPath(
  lineText: string,
  line: number,
  character: number,
): RenameContext | null {
  const re = createScopeConfigRegex();
  let match;
  while ((match = re.exec(lineText)) !== null) {
    const configPath = match[1];
    const pathStart = match.index + match[0].indexOf(configPath);
    const pathEnd = pathStart + configPath.length;
    if (character >= pathStart && character <= pathEnd) {
      // In PHP, show the full config path as placeholder — the user replaces
      // the entire path string (e.g., "catalog/review/active" -> "catalog/review/enabled")
      return {
        kind: 'config-segment',
        currentValue: configPath,
        range: Range.create(line, pathStart, line, pathEnd),
        configPath,
        configSegmentKind: 'field-id',
      };
    }
  }
  return null;
}

/**
 * Check if the cursor is on an ACL resource string in PHP
 * (const ADMIN_RESOURCE = '...' or ->isAllowed('...')).
 * Returns a RenameContext for acl-resource, or null if no match.
 */
function matchAclResource(
  lineText: string,
  line: number,
  character: number,
): RenameContext | null {
  const re = createPhpAclRegex();
  let match;
  while ((match = re.exec(lineText)) !== null) {
    const aclId = match[1];
    const idStart = match.index + match[0].indexOf(aclId);
    const idEnd = idStart + aclId.length;
    if (character >= idStart && character <= idEnd) {
      return {
        kind: 'acl-resource',
        currentValue: aclId,
        range: Range.create(line, idStart, line, idEnd),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Edit collection: gather all references and compute per-ref replacement text
// ---------------------------------------------------------------------------

/**
 * Dispatch to the appropriate edit collector based on symbol kind.
 * Returns RenameEdit[] where each edit already has its newText computed.
 */
async function collectEdits(
  ctx: RenameContext,
  newName: string,
  project: ProjectContext,
): Promise<RenameEdit[]> {
  switch (ctx.kind) {
    case 'fqcn':
      return collectFqcnEdits(ctx.currentValue, newName, project);
    case 'template': {
      // Filter by area: a rename in frontend only affects frontend + base files
      const templateRefs = collectTemplateRefs(ctx.currentValue, project);
      const templateSourceArea = ctx.sourceFile
        ? project.themeResolver.getAreaForFile(ctx.sourceFile)
        : undefined;
      const filteredTemplateRefs = templateRefs.filter((ref) =>
        isAreaCompatible(templateSourceArea, project.themeResolver.getAreaForFile(ref.file)),
      );
      return refsToEdits(filteredTemplateRefs, newName);
    }
    case 'acl-resource':
      return refsToEdits(await collectAclRefs(ctx.currentValue, project), newName);
    case 'config-segment':
      return collectConfigSegmentEdits(ctx, newName, project);
    case 'block-name': {
      // Filter by area: a rename in frontend only affects frontend + base files
      const allRefs = project.indexes.layout.getRefsForName(ctx.currentValue);
      const sourceArea = ctx.sourceFile
        ? project.themeResolver.getAreaForFile(ctx.sourceFile)
        : undefined;
      const filtered = allRefs.filter((ref) =>
        isAreaCompatible(sourceArea, project.themeResolver.getAreaForFile(ref.file)),
      );
      return refsToEdits(filtered, newName);
    }
  }
}

/** Convert a flat list of RefPositions into RenameEdits with a single newText. */
function refsToEdits(refs: RefPosition[], newText: string): RenameEdit[] {
  return refs.map((ref) => ({ ...ref, newText }));
}

/**
 * Collect all XML references to a PHP class FQCN, including all Magento-generated
 * class variants (\Proxy, Factory, \Interceptor, ExtensionInterface, etc.).
 *
 * Magento auto-generates wrapper classes at runtime. In XML config, these appear
 * as e.g. `Magento\Catalog\Api\ProductRepositoryInterface\Proxy` or
 * `Magento\Catalog\Model\ProductFactory`. When the base class is renamed, these
 * generated references must also be updated, preserving the suffix.
 *
 * Example: renaming `Magento\Catalog\Model\Product` to `Magento\Catalog\Model\Item`
 *   - `Magento\Catalog\Model\Product`         → `Magento\Catalog\Model\Item`
 *   - `Magento\Catalog\Model\Product\Proxy`    → `Magento\Catalog\Model\Item\Proxy`
 *   - `Magento\Catalog\Model\ProductFactory`   → `Magento\Catalog\Model\ItemFactory`
 *
 * For Interface classes, Extension attribute variants are also included:
 *   - `ProductExtensionInterface`              → `ItemExtensionInterface`
 *   - `ProductExtension`                       → `ItemExtension`
 *   - `ProductExtensionInterfaceFactory`       → `ItemExtensionInterfaceFactory`
 */
function collectFqcnEdits(
  fqcn: string,
  newFqcn: string,
  project: ProjectContext,
): RenameEdit[] {
  const edits: RenameEdit[] = [];

  // Collect exact-match references for the base FQCN
  const baseRefs = queryAllFqcnIndexes(fqcn, project);
  edits.push(...baseRefs.map((ref) => ({ ...ref, newText: newFqcn })));

  // Collect references to all generated class variants
  for (const variant of generatedVariants(fqcn)) {
    const newGeneratedFqcn = variant.buildNewFqcn(newFqcn);
    const generatedRefs = queryAllFqcnIndexes(variant.generatedFqcn, project);
    edits.push(...generatedRefs.map((ref) => ({ ...ref, newText: newGeneratedFqcn })));
  }

  return edits;
}

/**
 * Query all five FQCN-bearing indexes for references to a single FQCN.
 * This is the shared query logic used for both exact and generated-suffix lookups.
 */
function queryAllFqcnIndexes(fqcn: string, project: ProjectContext): RefPosition[] {
  return [
    ...project.indexes.di.getReferencesForFqcn(fqcn),
    ...project.indexes.events.getObserversForFqcn(fqcn),
    ...project.indexes.layout.getReferencesForFqcn(fqcn),
    ...project.indexes.systemConfig.getRefsForFqcn(fqcn),
    ...project.indexes.webapi.getRefsForFqcn(fqcn).filter((r) => r.kind === 'service-class'),
  ];
}

/**
 * Collect all layout XML references to a template identifier.
 *
 * Template IDs have the format Module_Name::path/to/template.phtml.
 * All layout files referencing this template (via block-template or refblock-template
 * attributes) are included.
 */
function collectTemplateRefs(templateId: string, project: ProjectContext): RefPosition[] {
  return project.indexes.layout.getReferencesForTemplate(templateId);
}

/**
 * Collect all references to an ACL resource ID across all XML types and PHP files.
 *
 * Queries five XML indexes plus an async grep of PHP files for ADMIN_RESOURCE
 * constants and isAllowed() calls.
 */
async function collectAclRefs(aclId: string, project: ProjectContext): Promise<RefPosition[]> {
  const xmlRefs: RefPosition[] = [
    ...project.indexes.acl.getAllResources(aclId),
    ...project.indexes.webapi.getRefsForResource(aclId),
    ...project.indexes.systemConfig.getRefsForAclResource(aclId),
    ...project.indexes.menu.getRefsForResource(aclId),
    ...project.indexes.uiComponentAcl.getRefsForResource(aclId),
  ];
  const phpRefs = await grepAclResourceInPhp(aclId, project.root, project.psr4Map);
  return [...xmlRefs, ...phpRefs];
}

/**
 * Collect edits for renaming a system.xml config path segment (section, group, or field).
 *
 * The rename operates on a single segment name while updating all affected references:
 *
 *   - system.xml: only the segment's own id attribute is replaced (not the full path)
 *   - PHP files: the full config path is replaced with the path rewritten to use the new segment
 *
 * For section/group renames, all descendant config paths are affected. For example,
 * renaming group "startup" in path "customer/startup" also updates PHP references to
 * "customer/startup/redirect_dashboard" → "customer/new_name/redirect_dashboard".
 */
async function collectConfigSegmentEdits(
  ctx: RenameContext,
  newSegmentName: string,
  project: ProjectContext,
): Promise<RenameEdit[]> {
  const configPath = ctx.configPath!;
  const segmentKind = ctx.configSegmentKind!;
  const edits: RenameEdit[] = [];

  // --- system.xml edits: replace the segment id in same-kind declarations ---
  // For a field rename, find field-id refs AND depends-field refs (fields that
  // reference this field via <depends><field id="...">) with this exact path.
  // For a section/group rename, find descendants via prefix query.
  const sysRefs = segmentKind === 'field-id'
    ? project.indexes.systemConfig.getRefsForPath(configPath)
        .filter((r) => r.kind === 'field-id' || r.kind === 'depends-field')
    : project.indexes.systemConfig.getRefsForPathPrefix(configPath)
        .filter((r) => r.kind === segmentKind && r.configPath === configPath);

  for (const ref of sysRefs) {
    edits.push({ ...ref, newText: newSegmentName });
  }

  // --- PHP edits: replace full config path strings that contain this segment ---
  // Build the new config path by swapping the renamed segment.
  const segments = configPath.split('/');
  const newSegments = [...segments];
  newSegments[newSegments.length - 1] = newSegmentName;
  const newConfigPath = newSegments.join('/');

  if (segmentKind === 'field-id') {
    // For field rename, grep for the exact full config path
    const phpRefs = await grepConfigPathInPhp(configPath, project.root, project.psr4Map);
    edits.push(...phpRefs.map((ref) => ({ ...ref, newText: newConfigPath })));
  } else {
    // For section/group rename, find all descendant field paths and grep each one.
    // Collect unique full config paths that descend from the renamed segment.
    const descendantPaths = new Set<string>();
    const allDescendantRefs = project.indexes.systemConfig.getRefsForPathPrefix(configPath);
    for (const ref of allDescendantRefs) {
      if (ref.kind === 'field-id') {
        descendantPaths.add(ref.configPath);
      }
    }

    // Batch grep all descendant paths with concurrency limit
    const pathList = [...descendantPaths];
    const grepResults = await grepConfigPathsInPhp(pathList, project.root, project.psr4Map);

    const segmentIndex = segments.length - 1;
    for (const [descendantPath, phpRefs] of grepResults) {
      const parts = descendantPath.split('/');
      parts[segmentIndex] = newSegmentName;
      const newPath = parts.join('/');
      edits.push(...phpRefs.map((ref) => ({ ...ref, newText: newPath })));
    }
  }

  return edits;
}

// ---------------------------------------------------------------------------
// WorkspaceEdit construction
// ---------------------------------------------------------------------------

/**
 * Build a WorkspaceEdit from a list of RenameEdits.
 *
 * Uses the simple `changes` map format (uri -> TextEdit[]) which is supported by
 * all LSP clients. Each edit carries its own newText, which allows generated class
 * references to use suffix-aware replacement text.
 */
function buildWorkspaceEdit(edits: RenameEdit[]): WorkspaceEdit {
  const changes: { [uri: string]: TextEdit[] } = {};

  for (const edit of edits) {
    const uri = URI.file(edit.file).toString();
    const range = Range.create(edit.line, edit.column, edit.line, edit.endColumn);
    const textEdit = TextEdit.replace(range, edit.newText);

    if (changes[uri]) {
      changes[uri].push(textEdit);
    } else {
      changes[uri] = [textEdit];
    }
  }

  return { changes };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a reference with position fields to an LSP Range. */
function refToRange(ref: { line: number; column: number; endColumn: number }): Range {
  return Range.create(ref.line, ref.column, ref.line, ref.endColumn);
}

