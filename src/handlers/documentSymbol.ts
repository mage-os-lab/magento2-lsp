/**
 * LSP "textDocument/documentSymbol" handler.
 *
 * Provides an outline/breadcrumb view of Magento XML config files. Re-parses
 * the current editor buffer on each request so the outline reflects unsaved changes.
 *
 * Supports all Magento XML file types:
 *   - di.xml: preferences, types, plugins, virtual types
 *   - events.xml: events with nested observers
 *   - layout XML: blocks, templates, handles
 *   - system.xml: section > group > field hierarchy
 *   - webapi.xml: service classes, methods, and ACL resources per route
 *   - acl.xml: hierarchical ACL resource tree
 *   - menu.xml: menu items with ACL resources
 *   - UI component XML: ACL resource references
 */

import {
  CancellationToken,
  DocumentSymbol,
  DocumentSymbolParams,
  Range,
  SymbolKind,
} from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { ProjectContext } from '../project/projectManager';
import { parseDiXml, DiXmlParseContext } from '../indexer/diXmlParser';
import { parseEventsXml, EventsXmlParseContext } from '../indexer/eventsXmlParser';
import { parseSystemXml, SystemXmlParseContext } from '../indexer/systemXmlParser';
import { parseWebapiXml, WebapiXmlParseContext } from '../indexer/webapiXmlParser';
import { parseAclXml, AclXmlParseContext } from '../indexer/aclXmlParser';
import { parseMenuXml, MenuXmlParseContext } from '../indexer/menuXmlParser';
import { parseRoutesXml, RoutesXmlParseContext } from '../indexer/routesXmlParser';
import { parseUiComponentAcl, UiComponentAclParseContext } from '../indexer/uiComponentAclParser';
import { DbSchemaXmlParseContext } from '../indexer/dbSchemaXmlParser';
import {
  deriveDiXmlContext,
  deriveEventsXmlContext,
  deriveLayoutXmlContext,
  deriveSystemXmlContext,
  deriveWebapiXmlContext,
  deriveAclXmlContext,
  deriveMenuXmlContext,
  deriveRoutesXmlContext,
  deriveDbSchemaXmlContext,
  deriveUiComponentAclContext,
} from '../project/moduleResolver';
import { realpath } from '../utils/realpath';
import { findAttributeValuePosition } from '../utils/xmlPositionUtil';
import { getAttr, installErrorHandler } from '../utils/saxHelpers';
import type { AclResource, RoutesReference, SystemConfigReference } from '../indexer/types';
import * as sax from 'sax';
import * as fs from 'fs';

export function handleDocumentSymbol(
  params: DocumentSymbolParams,
  getProject: (uri: string) => ProjectContext | undefined,
  _token?: CancellationToken,
): DocumentSymbol[] | null {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  if (!filePath.endsWith('.xml')) return null;

  const project = getProject(filePath);
  if (!project) return null;

  // Read the current buffer content from disk (the LSP uses Full sync for XML,
  // but document symbols are requested on demand so we read the latest content).
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  // Dispatch to the appropriate symbol builder based on file type.
  // Uses the same derive*Context() pattern as semanticValidator.ts.
  const diContext = deriveDiXmlContext(filePath, project.root, project.modules);
  if (diContext) return buildDiSymbols(content, diContext);

  const eventsContext = deriveEventsXmlContext(filePath, project.modules);
  if (eventsContext) return buildEventsSymbols(content, eventsContext);

  const layoutContext = deriveLayoutXmlContext(filePath);
  if (layoutContext) return buildLayoutSymbols(content, filePath);

  const systemContext = deriveSystemXmlContext(filePath, project.modules);
  if (systemContext) return buildSystemSymbols(content, systemContext);

  const webapiContext = deriveWebapiXmlContext(filePath, project.modules);
  if (webapiContext) return buildWebapiSymbols(content, webapiContext);

  const aclContext = deriveAclXmlContext(filePath, project.modules);
  if (aclContext) return buildAclSymbols(content, aclContext);

  const routesContext = deriveRoutesXmlContext(filePath, project.modules);
  if (routesContext) return buildRoutesSymbols(content, routesContext);

  const dbSchemaContext = deriveDbSchemaXmlContext(filePath, project.modules);
  if (dbSchemaContext) return buildDbSchemaSymbols(content, dbSchemaContext);

  const menuContext = deriveMenuXmlContext(filePath, project.modules);
  if (menuContext) return buildMenuSymbols(content, menuContext);

  const uiContext = deriveUiComponentAclContext(filePath, project.modules);
  if (uiContext) return buildUiComponentSymbols(content, uiContext);

  return null;
}

// --- Helper ---

/**
 * Create a DocumentSymbol with the same range for both range and selectionRange,
 * since parsers only track attribute/text value positions, not full element spans.
 */
function makeSymbol(
  name: string,
  detail: string | undefined,
  kind: SymbolKind,
  line: number,
  column: number,
  endColumn: number,
  children?: DocumentSymbol[],
): DocumentSymbol {
  const range = Range.create(line, column, line, endColumn);
  return DocumentSymbol.create(name, detail, kind, range, range, children);
}

/**
 * Expand a symbol's range to strictly encompass all its children's ranges.
 * Keeps selectionRange narrow (the attribute text) while making range span
 * the full subtree — required by clients like Aerial that use range containment
 * to determine the symbol hierarchy.
 *
 * The parent's range.start is pushed to column 0 of its line (or one line before
 * the first child if they share the same line) so it strictly contains children.
 */
function expandRangeToChildren(symbol: DocumentSymbol): void {
  if (!symbol.children || symbol.children.length === 0) return;
  for (const child of symbol.children) {
    expandRangeToChildren(child);
  }
  const firstChild = symbol.children[0];
  const lastChild = symbol.children[symbol.children.length - 1];

  // Ensure start is strictly before the first child's start
  let startLine = symbol.range.start.line;
  let startChar = symbol.range.start.character;
  if (startLine === firstChild.range.start.line && startChar >= firstChild.range.start.character) {
    // Same line and can't be before the child — move up one line
    startLine = Math.max(0, startLine - 1);
    startChar = 0;
  }

  // Ensure end is at or past the last child's end
  let endLine = lastChild.range.end.line;
  let endChar = lastChild.range.end.character;
  if (endLine < symbol.range.end.line
    || (endLine === symbol.range.end.line && endChar < symbol.range.end.character)) {
    endLine = symbol.range.end.line;
    endChar = symbol.range.end.character;
  }

  symbol.range = Range.create(startLine, startChar, endLine, endChar);
}

// --- di.xml symbols ---

/**
 * Build document symbols for a di.xml file.
 *
 * Shows preferences (interface → implementation), type declarations with
 * nested plugins, and virtual types. Flat list with plugins grouped under
 * their parent type where possible.
 */
function buildDiSymbols(content: string, context: DiXmlParseContext): DocumentSymbol[] | null {
  const { references, virtualTypes } = parseDiXml(content, context);
  const symbols: DocumentSymbol[] = [];

  // Group plugin refs by their parent type for nesting
  const pluginsByParent = new Map<string, DocumentSymbol[]>();
  for (const ref of references) {
    if (ref.kind === 'plugin-type' && ref.parentTypeFqcn) {
      const pluginSymbol = makeSymbol(
        ref.pluginName || ref.fqcn,
        ref.parentTypeFqcn,
        SymbolKind.Method,
        ref.line, ref.column, ref.endColumn,
      );
      const existing = pluginsByParent.get(ref.parentTypeFqcn) ?? [];
      existing.push(pluginSymbol);
      pluginsByParent.set(ref.parentTypeFqcn, existing);
    }
  }

  for (const ref of references) {
    switch (ref.kind) {
      case 'preference-for':
        // Show "Interface → Implementation" as a single preference symbol
        symbols.push(makeSymbol(
          `${ref.fqcn} → ${ref.pairedFqcn || '?'}`,
          'Preference',
          SymbolKind.Interface,
          ref.line, ref.column, ref.endColumn,
        ));
        break;
      case 'type-name': {
        // Type with nested plugins as children.
        // Use Interface kind for FQCNs ending in "Interface" (Magento naming convention).
        const children = pluginsByParent.get(ref.fqcn);
        symbols.push(makeSymbol(
          ref.fqcn,
          'Type',
          ref.fqcn.endsWith('Interface') ? SymbolKind.Interface : SymbolKind.Class,
          ref.line, ref.column, ref.endColumn,
          children,
        ));
        break;
      }
      case 'plugin-type':
        // Plugins without a parent type (shouldn't happen, but handle gracefully)
        if (!ref.parentTypeFqcn) {
          symbols.push(makeSymbol(
            ref.pluginName || ref.fqcn,
            'Plugin',
            SymbolKind.Method,
            ref.line, ref.column, ref.endColumn,
          ));
        }
        // Plugins with a parent are nested under their type-name above
        break;
      // Skip preference-type (already shown as part of preference-for),
      // virtualtype-type (shown as part of virtualtype-name below),
      // and argument-object (too noisy for the outline).
    }
  }

  // Virtual types — use TypeParameter to distinguish from regular Class symbols
  for (const vt of virtualTypes) {
    symbols.push(makeSymbol(
      vt.name,
      `VirtualType → ${vt.parentType}`,
      SymbolKind.TypeParameter,
      vt.line, vt.column, vt.column + vt.name.length,
    ));
  }

  return symbols.length > 0 ? symbols : null;
}

// --- events.xml symbols ---

/**
 * Build document symbols for an events.xml file.
 *
 * Events are top-level symbols with their observers nested as children,
 * giving a natural tree: event_name > ObserverClass.
 */
function buildEventsSymbols(content: string, context: EventsXmlParseContext): DocumentSymbol[] | null {
  const { events, observers } = parseEventsXml(content, context);

  // Group observers by event name
  const observersByEvent = new Map<string, DocumentSymbol[]>();
  for (const obs of observers) {
    const obsSymbol = makeSymbol(
      obs.fqcn,
      obs.observerName,
      SymbolKind.Class,
      obs.line, obs.column, obs.endColumn,
    );
    const existing = observersByEvent.get(obs.eventName) ?? [];
    existing.push(obsSymbol);
    observersByEvent.set(obs.eventName, existing);
  }

  // Build event symbols with observer children
  const symbols: DocumentSymbol[] = [];
  for (const event of events) {
    const children = observersByEvent.get(event.eventName);
    symbols.push(makeSymbol(
      event.eventName,
      undefined,
      SymbolKind.Event,
      event.line, event.column, event.endColumn,
      children,
    ));
  }

  return symbols.length > 0 ? symbols : null;
}

// --- layout XML symbols ---

/**
 * Structural element types tracked for the layout outline tree.
 * Elements not in this set are transparent — their children bubble up
 * to the nearest tracked ancestor.
 */
const LAYOUT_STRUCTURAL_TAGS = new Set([
  'body', 'head', 'block', 'container', 'referenceblock', 'referencecontainer',
]);

/**
 * Build hierarchical document symbols for a layout XML file.
 *
 * Uses a lightweight SAX parse (separate from the index parser) to reconstruct
 * the XML nesting structure. Tracked elements (body, block, container,
 * referenceBlock, referenceContainer) become tree nodes; everything else
 * (page, arguments, items, actions) is transparent.
 *
 * <update handle="..."> is added as a leaf to the nearest tracked ancestor.
 */
function buildLayoutSymbols(content: string, _file: string): DocumentSymbol[] | null {
  const lines = content.split('\n');
  const parser = sax.parser(true, { position: true, trim: false });

  // Stack of tracked ancestor symbols. Children are attached to the top of the stack.
  // rootChildren collects top-level symbols (children of <page> or file root).
  const rootChildren: DocumentSymbol[] = [];
  const stack: DocumentSymbol[] = [];
  // Parallel boolean stack: true if this depth is a tracked structural element.
  const isTracked: boolean[] = [];

  let currentTagStartLine = 0;

  parser.onopentagstart = () => {
    currentTagStartLine = parser.line ?? 0;
  };

  parser.onopentag = (tag) => {
    const tagLine = parser.line ?? 0;
    const tagName = tag.name.toLowerCase();

    // Handle <update handle="..."> as a leaf symbol (no children)
    if (tagName === 'update') {
      const handleAttr = getAttr(tag, 'handle');
      if (handleAttr) {
        const pos = findAttributeValuePosition(lines, tagLine, 'handle', currentTagStartLine);
        if (pos) {
          const sym = makeSymbol(handleAttr, 'Handle update', SymbolKind.Key, pos.line, pos.column, pos.endColumn);
          attachToParent(stack, rootChildren, sym);
        }
      }
      isTracked.push(false);
      return;
    }

    if (!LAYOUT_STRUCTURAL_TAGS.has(tagName)) {
      isTracked.push(false);
      return;
    }

    // Build a DocumentSymbol for this structural element
    const sym = buildLayoutElementSymbol(tag, tagName, tagLine, currentTagStartLine, lines);
    if (!sym) {
      // Structural tag without a name attribute — treat as transparent
      isTracked.push(false);
      return;
    }

    attachToParent(stack, rootChildren, sym);
    stack.push(sym);
    isTracked.push(true);
  };

  parser.onclosetag = () => {
    const tracked = isTracked.pop();
    if (tracked) {
      stack.pop();
    }
  };

  installErrorHandler(parser);
  parser.write(content).close();

  return rootChildren.length > 0 ? rootChildren : null;
}

/** Attach a symbol as a child of the nearest tracked ancestor, or to the root list. */
function attachToParent(
  stack: DocumentSymbol[],
  rootChildren: DocumentSymbol[],
  sym: DocumentSymbol,
): void {
  if (stack.length > 0) {
    const parent = stack[stack.length - 1];
    if (!parent.children) parent.children = [];
    parent.children.push(sym);
  } else {
    rootChildren.push(sym);
  }
}

/**
 * Create a DocumentSymbol for a structural layout element.
 * Returns undefined if the element has no name attribute (e.g., bare <body>
 * still gets a symbol with name "body").
 */
function buildLayoutElementSymbol(
  tag: sax.Tag | sax.QualifiedTag,
  tagName: string,
  tagLine: number,
  tagStartLine: number,
  lines: string[],
): DocumentSymbol | undefined {
  const nameAttr = getAttr(tag, 'name');

  // <body> and <head> always get a symbol even without a name attribute
  if (tagName === 'body' || tagName === 'head') {
    if (nameAttr) {
      const pos = findAttributeValuePosition(lines, tagLine, 'name', tagStartLine);
      if (pos) return makeSymbol(nameAttr, tagName, SymbolKind.Namespace, pos.line, pos.column, pos.endColumn);
    }
    // Use the tag itself as the symbol — position at column 0 of the tag line
    return makeSymbol(tagName, undefined, SymbolKind.Namespace, tagStartLine, 0, tagName.length);
  }

  // All other tracked elements require a name attribute
  if (!nameAttr) return undefined;

  const pos = findAttributeValuePosition(lines, tagLine, 'name', tagStartLine);
  if (!pos) return undefined;

  switch (tagName) {
    case 'block': {
      const classAttr = getAttr(tag, 'class');
      // Use short class name (last segment) as detail for readability
      const shortClass = classAttr ? classAttr.split('\\').pop() : undefined;
      const kind = classAttr?.endsWith('Interface') ? SymbolKind.Interface : SymbolKind.Class;
      return makeSymbol(nameAttr, shortClass, kind, pos.line, pos.column, pos.endColumn);
    }
    case 'container': {
      const label = getAttr(tag, 'label');
      return makeSymbol(nameAttr, label || undefined, SymbolKind.Namespace, pos.line, pos.column, pos.endColumn);
    }
    case 'referenceblock':
      return makeSymbol(nameAttr, 'referenceBlock', SymbolKind.Object, pos.line, pos.column, pos.endColumn);
    case 'referencecontainer':
      return makeSymbol(nameAttr, 'referenceContainer', SymbolKind.Object, pos.line, pos.column, pos.endColumn);
    default:
      return undefined;
  }
}

// --- system.xml symbols ---

/**
 * Build document symbols for a system.xml file.
 *
 * Reconstructs the section > group > field hierarchy from the flat reference
 * list using configPath depth. Uses the ID as the symbol name and the label
 * (human-readable title) as the detail.
 */
function buildSystemSymbols(content: string, context: SystemXmlParseContext): DocumentSymbol[] | null {
  const { references } = parseSystemXml(content, context);

  // Separate structural refs (section/group/field) from model refs
  const structuralRefs = references.filter(
    (r) => r.kind === 'section-id' || r.kind === 'group-id' || r.kind === 'field-id',
  );
  const modelRefs = references.filter(
    (r) => r.kind === 'source-model' || r.kind === 'backend-model' || r.kind === 'frontend-model',
  );
  const resourceRefs = references.filter((r) => r.kind === 'section-resource');

  // Build model symbols keyed by their parent field's config path
  const modelsByPath = new Map<string, DocumentSymbol[]>();
  for (const ref of [...modelRefs, ...resourceRefs]) {
    const symbol = makeSymbol(
      ref.fqcn || ref.aclResourceId || ref.configPath,
      formatModelKind(ref.kind),
      ref.fqcn ? SymbolKind.Class : SymbolKind.Key,
      ref.line, ref.column, ref.endColumn,
    );
    const existing = modelsByPath.get(ref.configPath) ?? [];
    existing.push(symbol);
    modelsByPath.set(ref.configPath, existing);
  }

  // Build the section > group > field tree.
  // configPath segments tell us the depth: "section" (1), "section/group" (2), etc.
  const sectionSymbols: DocumentSymbol[] = [];
  const symbolsByPath = new Map<string, DocumentSymbol>();

  for (const ref of structuralRefs) {
    const models = modelsByPath.get(ref.configPath);
    const symbol = makeSymbol(
      ref.configPath,
      ref.label || undefined,
      ref.kind === 'section-id' ? SymbolKind.Module
        : ref.kind === 'group-id' ? SymbolKind.Namespace
        : SymbolKind.Property,
      ref.line, ref.column, ref.endColumn,
      models,
    );
    symbolsByPath.set(ref.configPath, symbol);

    // Find parent by trimming the last segment from configPath
    const parentPath = ref.configPath.includes('/')
      ? ref.configPath.slice(0, ref.configPath.lastIndexOf('/'))
      : undefined;
    const parentSymbol = parentPath ? symbolsByPath.get(parentPath) : undefined;

    if (parentSymbol) {
      // Nest under parent, preserving any existing children (models)
      if (!parentSymbol.children) parentSymbol.children = [];
      parentSymbol.children.push(symbol);
    } else {
      // Top-level section
      sectionSymbols.push(symbol);
    }
  }

  return sectionSymbols.length > 0 ? sectionSymbols : null;
}

/** Format a system.xml model kind for display. */
function formatModelKind(kind: string): string {
  switch (kind) {
    case 'source-model': return 'Source model';
    case 'backend-model': return 'Backend model';
    case 'frontend-model': return 'Frontend model';
    case 'section-resource': return 'ACL resource';
    default: return kind;
  }
}

/** Extract the last segment from a slash-delimited path. */
function lastSegment(configPath: string): string {
  const idx = configPath.lastIndexOf('/');
  return idx >= 0 ? configPath.slice(idx + 1) : configPath;
}

// --- webapi.xml symbols ---

/**
 * Build document symbols for a webapi.xml file.
 *
 * Shows service classes, methods, and ACL resources. Each symbol includes
 * the HTTP method and route URL in its detail for context.
 */
function buildWebapiSymbols(content: string, context: WebapiXmlParseContext): DocumentSymbol[] | null {
  const { references } = parseWebapiXml(content, context);
  const symbols: DocumentSymbol[] = [];

  for (const ref of references) {
    const routeDetail = `${ref.httpMethod} ${ref.routeUrl}`;
    switch (ref.kind) {
      case 'service-class':
        symbols.push(makeSymbol(ref.value, routeDetail, SymbolKind.Interface, ref.line, ref.column, ref.endColumn));
        break;
      case 'service-method':
        symbols.push(makeSymbol(ref.value, routeDetail, SymbolKind.Method, ref.line, ref.column, ref.endColumn));
        break;
      case 'resource-ref':
        symbols.push(makeSymbol(ref.value, routeDetail, SymbolKind.Key, ref.line, ref.column, ref.endColumn));
        break;
    }
  }

  return symbols.length > 0 ? symbols : null;
}

// --- acl.xml symbols ---

/**
 * Build document symbols for an acl.xml file.
 *
 * Reconstructs the hierarchical resource tree using parentId links.
 * Each resource shows its title (or ID if no title) as the symbol name.
 */
function buildAclSymbols(content: string, context: AclXmlParseContext): DocumentSymbol[] | null {
  const { resources } = parseAclXml(content, context);
  if (resources.length === 0) return null;

  // Build a lookup from resource ID to its parsed data
  const resourceById = new Map<string, AclResource>();
  for (const res of resources) {
    resourceById.set(res.id, res);
  }

  // Build symbols indexed by ID, then wire up parent-child relationships
  const symbolById = new Map<string, DocumentSymbol>();
  for (const res of resources) {
    symbolById.set(res.id, makeSymbol(
      res.title || res.id,
      res.title ? res.id : undefined,
      SymbolKind.Key,
      res.line, res.column, res.endColumn,
    ));
  }

  // Wire children to parents
  const roots: DocumentSymbol[] = [];
  for (const res of resources) {
    const symbol = symbolById.get(res.id)!;
    if (res.parentId && symbolById.has(res.parentId)) {
      const parent = symbolById.get(res.parentId)!;
      if (!parent.children) parent.children = [];
      parent.children.push(symbol);
    } else {
      roots.push(symbol);
    }
  }

  return roots.length > 0 ? roots : null;
}

// --- menu.xml symbols ---

/**
 * Build document symbols for a menu.xml file.
 *
 * Shows menu items with their title (or ID) as the symbol name and
 * the ACL resource as the detail.
 */
// --- routes.xml symbols ---

/**
 * Build document symbols for a routes.xml file.
 *
 * Hierarchy: Router (standard/admin) > Route (frontName) > Module
 */
function buildRoutesSymbols(content: string, context: RoutesXmlParseContext): DocumentSymbol[] | null {
  const { references } = parseRoutesXml(content, context);
  if (references.length === 0) return null;

  // Group by routerType, then by routeId
  const routers = new Map<string, Map<string, RoutesReference[]>>();
  for (const ref of references) {
    let routes = routers.get(ref.routerType);
    if (!routes) {
      routes = new Map();
      routers.set(ref.routerType, routes);
    }
    let routeRefs = routes.get(ref.routeId);
    if (!routeRefs) {
      routeRefs = [];
      routes.set(ref.routeId, routeRefs);
    }
    routeRefs.push(ref);
  }

  const symbols: DocumentSymbol[] = [];
  for (const [routerType, routes] of routers) {
    // Find the first ref in this router for position
    const firstRef = [...routes.values()][0][0];
    const routerSymbol = makeSymbol(
      routerType,
      'router',
      SymbolKind.Namespace,
      firstRef.line, firstRef.column, firstRef.endColumn,
    );

    const routeSymbols: DocumentSymbol[] = [];
    for (const [routeId, refs] of routes) {
      const idRef = refs.find((r) => r.kind === 'route-id');
      const fnRef = refs.find((r) => r.kind === 'route-frontname');
      const anchor = idRef ?? fnRef ?? refs[0];
      const routeSymbol = makeSymbol(
        fnRef?.value ?? routeId,
        `id: ${routeId}`,
        SymbolKind.Key,
        anchor.line, anchor.column, anchor.endColumn,
      );

      const moduleSymbols: DocumentSymbol[] = [];
      for (const ref of refs.filter((r) => r.kind === 'route-module')) {
        const detail = ref.before ? `before: ${ref.before}` : ref.after ? `after: ${ref.after}` : undefined;
        moduleSymbols.push(makeSymbol(
          ref.value,
          detail,
          SymbolKind.Module,
          ref.line, ref.column, ref.endColumn,
        ));
      }
      if (moduleSymbols.length > 0) {
        routeSymbol.children = moduleSymbols;
      }
      routeSymbols.push(routeSymbol);
    }
    if (routeSymbols.length > 0) {
      routerSymbol.children = routeSymbols;
    }
    expandRangeToChildren(routerSymbol);
    symbols.push(routerSymbol);
  }

  return symbols;
}

// --- db_schema.xml symbols ---

/**
 * Build document symbols for a db_schema.xml file.
 *
 * Uses a lightweight SAX parse to produce a hierarchical tree:
 *   Table (Struct) > Column (Field), Constraint (Key), Index (Key)
 *
 * This is separate from the parser (which only extracts navigable references) because
 * document symbols need all structural elements including constraints and indexes.
 */
function buildDbSchemaSymbols(content: string, _context: DbSchemaXmlParseContext): DocumentSymbol[] | null {
  const parser = sax.parser(true, { position: true, trim: false });
  const lines = content.split('\n');
  const symbols: DocumentSymbol[] = [];
  let currentTableSymbol: DocumentSymbol | null = null;
  let currentTagStartLine = 0;

  parser.onopentagstart = () => {
    currentTagStartLine = parser.line ?? 0;
  };

  parser.onopentag = (tag) => {
    const tagLine = parser.line ?? 0;
    const tagStartLine = currentTagStartLine;
    const tagName = tag.name.toLowerCase();

    if (tagName === 'table') {
      const name = getAttr(tag, 'name');
      if (!name) return;
      const pos = findAttributeValuePosition(lines, tagLine, 'name', tagStartLine);
      if (!pos) return;
      const comment = getAttr(tag, 'comment');
      const resource = getAttr(tag, 'resource');
      const detail = [comment, resource ? `resource: ${resource}` : ''].filter(Boolean).join(' — ');
      currentTableSymbol = makeSymbol(
        name,
        detail || undefined,
        SymbolKind.Struct,
        pos.line, pos.column, pos.endColumn,
      );
      currentTableSymbol.children = [];
      return;
    }

    if (!currentTableSymbol) return;

    if (tagName === 'column') {
      const name = getAttr(tag, 'name');
      if (!name) return;
      const pos = findAttributeValuePosition(lines, tagLine, 'name', tagStartLine);
      if (!pos) return;
      const xsiType = tag.attributes['xsi:type'] ?? tag.attributes['XSI:TYPE'] ?? tag.attributes['xsi:Type'];
      const typeStr = typeof xsiType === 'string' ? xsiType : xsiType?.value;
      currentTableSymbol.children!.push(makeSymbol(
        name,
        typeStr || undefined,
        SymbolKind.Field,
        pos.line, pos.column, pos.endColumn,
      ));
      return;
    }

    if (tagName === 'constraint') {
      const xsiType = tag.attributes['xsi:type'] ?? tag.attributes['XSI:TYPE'] ?? tag.attributes['xsi:Type'];
      const typeStr = (typeof xsiType === 'string' ? xsiType : xsiType?.value) ?? '';
      const referenceId = getAttr(tag, 'referenceId') ?? '';
      const pos = findAttributeValuePosition(lines, tagLine, 'referenceId', tagStartLine)
        ?? findAttributeValuePosition(lines, tagLine, 'xsi:type', tagStartLine);
      if (!pos) return;

      let detail: string;
      if (typeStr === 'foreign') {
        const refTable = getAttr(tag, 'referenceTable') ?? '';
        const refCol = getAttr(tag, 'referenceColumn') ?? '';
        const col = getAttr(tag, 'column') ?? '';
        detail = `${col} → ${refTable}.${refCol}`;
      } else {
        detail = typeStr;
      }

      currentTableSymbol.children!.push(makeSymbol(
        referenceId || typeStr,
        detail,
        SymbolKind.Key,
        pos.line, pos.column, pos.endColumn,
      ));
      return;
    }

    if (tagName === 'index') {
      const referenceId = getAttr(tag, 'referenceId') ?? '';
      const indexType = getAttr(tag, 'indexType') ?? 'btree';
      const pos = findAttributeValuePosition(lines, tagLine, 'referenceId', tagStartLine);
      if (!pos) return;
      currentTableSymbol.children!.push(makeSymbol(
        referenceId,
        `index (${indexType})`,
        SymbolKind.Key,
        pos.line, pos.column, pos.endColumn,
      ));
    }
  };

  parser.onclosetag = (tagName) => {
    if (tagName.toLowerCase() === 'table' && currentTableSymbol) {
      if (currentTableSymbol.children && currentTableSymbol.children.length === 0) {
        delete currentTableSymbol.children;
      }
      expandRangeToChildren(currentTableSymbol);
      symbols.push(currentTableSymbol);
      currentTableSymbol = null;
    }
  };

  installErrorHandler(parser);
  parser.write(content).close();

  return symbols.length > 0 ? symbols : null;
}

// --- menu.xml symbols ---

function buildMenuSymbols(content: string, context: MenuXmlParseContext): DocumentSymbol[] | null {
  const { references } = parseMenuXml(content, context);
  const symbols: DocumentSymbol[] = [];

  for (const ref of references) {
    symbols.push(makeSymbol(
      ref.menuItemTitle || ref.menuItemId,
      `resource: ${ref.value}`,
      SymbolKind.Function,
      ref.line, ref.column, ref.endColumn,
    ));
  }

  return symbols.length > 0 ? symbols : null;
}

// --- UI component XML symbols ---

/**
 * Elements that form the structural tree in UI component XML files.
 * Each entry maps a lowercased tag name to its SymbolKind and optional detail text.
 *
 * Elements NOT in this set are transparent — their children bubble up to
 * the nearest tracked ancestor (same approach as buildLayoutSymbols).
 *
 * Kind rationale:
 *   Namespace  — structural containers (listing, form, toolbar, fieldset, container)
 *   Object     — configured data objects (dataSource)
 *   Class      — elements that reference a PHP class (dataProvider)
 *   Array      — ordered collections (columns)
 *   Field      — data fields (column, selectColumn, actionsColumn, field)
 *   Enum       — set of named choices (massaction)
 *   Function   — callable / clickable actions (action, button, exportButton)
 *   Constant   — simple named toolbar tools (bookmark, filters, paging, etc.)
 *   Key        — identifiers (aclResource)
 *   Property   — configuration leaf values (filter, dataType)
 *   String     — display text (label)
 */
const UI_COMPONENT_STRUCTURAL_TAGS: Record<string, { kind: SymbolKind; detail?: string }> = {
  // Top-level root elements
  listing:         { kind: SymbolKind.Namespace },
  form:            { kind: SymbolKind.Namespace },
  // Data layer
  datasource:      { kind: SymbolKind.Object },
  dataprovider:    { kind: SymbolKind.Class },
  // Listing toolbar and its children
  listingtoolbar:  { kind: SymbolKind.Namespace, detail: 'toolbar' },
  bookmark:        { kind: SymbolKind.Constant, detail: 'bookmark' },
  columnscontrols: { kind: SymbolKind.Constant, detail: 'columnsControls' },
  filters:         { kind: SymbolKind.Constant, detail: 'filters' },
  search:          { kind: SymbolKind.Constant, detail: 'search' },
  massaction:      { kind: SymbolKind.Enum, detail: 'massaction' },
  action:          { kind: SymbolKind.Function },
  paging:          { kind: SymbolKind.Constant, detail: 'paging' },
  exportbutton:    { kind: SymbolKind.Function, detail: 'export' },
  // Columns and settings
  columns:         { kind: SymbolKind.Array },
  column:          { kind: SymbolKind.Field },
  selectcolumn:    { kind: SymbolKind.Field, detail: 'selectColumn' },
  actionscolumn:   { kind: SymbolKind.Field },
  settings:        { kind: SymbolKind.Namespace },
  options:         { kind: SymbolKind.Class },
  // Form elements
  fieldset:        { kind: SymbolKind.Namespace },
  field:           { kind: SymbolKind.Field },
  container:       { kind: SymbolKind.Namespace },
  // Shared
  button:          { kind: SymbolKind.Function, detail: 'button' },
};

/**
 * Text-content leaf elements whose text becomes the symbol name.
 * These work like <aclResource> — text is collected between open/close tags
 * and emitted as a leaf symbol attached to the nearest tracked ancestor.
 */
const UI_COMPONENT_TEXT_TAGS: Record<string, { kind: SymbolKind; detail: string }> = {
  aclresource: { kind: SymbolKind.Key, detail: 'ACL Resource' },
  label:       { kind: SymbolKind.String, detail: 'label' },
  filter:      { kind: SymbolKind.Property, detail: 'filter' },
  datatype:    { kind: SymbolKind.Property, detail: 'dataType' },
  datascope:   { kind: SymbolKind.Property, detail: 'dataScope' },
  sorting:     { kind: SymbolKind.Property, detail: 'sorting' },
};

/**
 * Build document symbols for a UI component XML file (listing or form).
 *
 * Uses a SAX parser with a stack-based approach (like buildLayoutSymbols) to
 * reconstruct the XML hierarchy. Tracked elements become tree nodes; everything
 * else is transparent. <aclResource> is special — its text content becomes a
 * Key symbol attached to the nearest tracked ancestor.
 */
function buildUiComponentSymbols(content: string, _context: UiComponentAclParseContext): DocumentSymbol[] | null {
  const lines = content.split('\n');
  const parser = sax.parser(true, { position: true, trim: false });

  const rootChildren: DocumentSymbol[] = [];
  const stack: DocumentSymbol[] = [];
  // Parallel boolean stack: true when this SAX depth is a tracked structural element.
  const isTracked: boolean[] = [];

  let currentTagStartLine = 0;
  // State for collecting text content of leaf elements (aclResource, label, filter, etc.)
  let collectingTextTag: { kind: SymbolKind; detail: string } | null = null;
  let collectedText = '';
  let collectedTextLine = 0;

  parser.onopentagstart = () => {
    currentTagStartLine = parser.line ?? 0;
  };

  parser.onopentag = (tag) => {
    const tagLine = parser.line ?? 0;
    const tagName = tag.name.toLowerCase();

    // Text-content leaf elements — collect text, don't push to structural stack
    const textEntry = UI_COMPONENT_TEXT_TAGS[tagName];
    if (textEntry) {
      collectingTextTag = textEntry;
      collectedText = '';
      collectedTextLine = currentTagStartLine;
      isTracked.push(false);
      return;
    }

    const entry = UI_COMPONENT_STRUCTURAL_TAGS[tagName];
    if (!entry) {
      isTracked.push(false);
      return;
    }

    // Elements without a name attribute use the tag name as the symbol name
    const nameAttr = getAttr(tag, 'name');

    // Compute detail from attributes where applicable
    let detail = entry.detail;
    if (tagName === 'datasource' || tagName === 'dataprovider' || tagName === 'actionscolumn' || tagName === 'options') {
      // Show short class name (last backslash segment) for class-bearing elements
      const classAttr = getAttr(tag, 'class');
      if (classAttr) detail = classAttr.split('\\').pop();
    } else if (tagName === 'column') {
      // Show xsi:type as the column data type
      const xsiType = tag.attributes['xsi:type'] ?? tag.attributes['XSI:TYPE'] ?? tag.attributes['xsi:Type'];
      const typeStr = typeof xsiType === 'string' ? xsiType : xsiType?.value;
      if (typeStr) detail = typeStr;
    } else if (tagName === 'field') {
      // Show formElement attribute (input, select, textarea, etc.)
      const formElement = getAttr(tag, 'formElement');
      if (formElement) detail = formElement;
    } else if (tagName === 'container') {
      // Show short component name if present
      const component = getAttr(tag, 'component');
      if (component) detail = component.split('/').pop();
    }

    // Build the symbol — root elements use the tag name, others use the name attribute
    const symbolName = nameAttr ?? tagName;
    let sym: DocumentSymbol;
    if (nameAttr) {
      const pos = findAttributeValuePosition(lines, tagLine, 'name', currentTagStartLine);
      if (!pos) {
        isTracked.push(false);
        return;
      }
      sym = makeSymbol(symbolName, detail, entry.kind, pos.line, pos.column, pos.endColumn);
    } else {
      // No name attribute — use tag name, position at tag start
      sym = makeSymbol(symbolName, detail, entry.kind, currentTagStartLine, 0, tagName.length);
    }

    attachToParent(stack, rootChildren, sym);
    stack.push(sym);
    isTracked.push(true);
  };

  parser.ontext = (text) => {
    if (collectingTextTag) {
      collectedText += text;
    }
  };

  parser.onclosetag = (tagName) => {
    // Emit collected text-content element as a leaf symbol.
    // The element name becomes the symbol name; the text value becomes the detail.
    if (collectingTextTag) {
      const value = collectedText.trim();
      if (value) {
        const lineText = lines[collectedTextLine] ?? '';
        const col = lineText.indexOf(value);
        const startCol = col >= 0 ? col : 0;
        const sym = makeSymbol(collectingTextTag.detail, value, collectingTextTag.kind, collectedTextLine, startCol, startCol + value.length);
        attachToParent(stack, rootChildren, sym);
      }
      collectingTextTag = null;
    }

    const tracked = isTracked.pop();
    if (tracked) {
      const sym = stack.pop();
      if (sym) expandRangeToChildren(sym);
    }
  };

  installErrorHandler(parser);
  parser.write(content).close();

  return rootChildren.length > 0 ? rootChildren : null;
}
