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
import { parseUiComponentAcl, UiComponentAclParseContext } from '../indexer/uiComponentAclParser';
import {
  deriveDiXmlContext,
  deriveEventsXmlContext,
  deriveLayoutXmlContext,
  deriveSystemXmlContext,
  deriveWebapiXmlContext,
  deriveAclXmlContext,
  deriveMenuXmlContext,
  deriveUiComponentAclContext,
} from '../project/moduleResolver';
import { realpath } from '../utils/realpath';
import { findAttributeValuePosition } from '../utils/xmlPositionUtil';
import { getAttr, installErrorHandler } from '../utils/saxHelpers';
import type { AclResource, SystemConfigReference } from '../indexer/types';
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
 * Build document symbols for a UI component XML file.
 *
 * Shows ACL resource references found in <aclResource> elements.
 */
function buildUiComponentSymbols(content: string, context: UiComponentAclParseContext): DocumentSymbol[] | null {
  const { references } = parseUiComponentAcl(content, context);
  const symbols: DocumentSymbol[] = [];

  for (const ref of references) {
    symbols.push(makeSymbol(
      ref.value,
      'ACL Resource',
      SymbolKind.Key,
      ref.line, ref.column, ref.endColumn,
    ));
  }

  return symbols.length > 0 ? symbols : null;
}
