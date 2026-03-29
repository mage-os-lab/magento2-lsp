/**
 * LSP "textDocument/completion" handler.
 *
 * Provides auto-completion for Magento XML config files and PHP files.
 * Completions are context-aware: the handler detects the current XML element
 * and attribute (or text content) at the cursor position, determines the file
 * type (di.xml, events.xml, layout, etc.), and returns matching candidates
 * from the project's indexes.
 *
 * Supported completion contexts:
 *   - di.xml: FQCNs for preference for/type, type name, plugin type, virtualType type, object arguments
 *   - events.xml: event names, observer FQCNs
 *   - Layout XML: block classes, templates, handles, block/container names, object arguments
 *   - webapi.xml: service classes, ACL resource IDs
 *   - system.xml: model FQCNs, ACL resource IDs
 *   - menu.xml: ACL resource IDs
 *   - UI component XML: ACL resource IDs
 *   - db_schema.xml: table names, column names
 *   - PHP: event names in dispatch(), config paths in getValue()/isSetFlag(), ACL in isAllowed()
 */

import {
  CancellationToken,
  CompletionParams,
  CompletionList,
  CompletionItem,
  CompletionItemKind,
  Range,
  TextEdit,
} from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { ProjectContext } from '../project/projectManager';
import { getXmlContextAtPosition, XmlContext } from '../utils/xmlContext';
import { realpath } from '../utils/realpath';
import { readFileSafe } from '../utils/fsHelpers';

// ─── File type detection ────────────────────────────────────────────────────

/** Recognized Magento XML file types for completion purposes. */
type MagentoXmlFileType =
  | 'di'
  | 'events'
  | 'layout'
  | 'webapi'
  | 'system'
  | 'acl'
  | 'menu'
  | 'db_schema'
  | 'ui_component';

/**
 * Determine the Magento XML file type from a file path.
 *
 * Checks the path for characteristic substrings (e.g. `/di.xml`, `/layout/`, `/ui_component/`).
 * Returns undefined for unrecognized XML files.
 *
 * @param filePath - Absolute file path to classify.
 * @returns The recognized file type, or undefined.
 */
function detectXmlFileType(filePath: string): MagentoXmlFileType | undefined {
  // Check specific file names first (more specific wins)
  if (filePath.endsWith('/di.xml')) return 'di';
  if (filePath.endsWith('/events.xml')) return 'events';
  if (filePath.endsWith('/webapi.xml')) return 'webapi';
  if (filePath.endsWith('/system.xml') || filePath.includes('/etc/adminhtml/system/')) return 'system';
  if (filePath.endsWith('/acl.xml')) return 'acl';
  if (filePath.endsWith('/menu.xml')) return 'menu';
  if (filePath.endsWith('/db_schema.xml')) return 'db_schema';
  // Directory-based detection
  if (filePath.includes('/ui_component/') && filePath.endsWith('.xml')) return 'ui_component';
  if ((filePath.includes('/layout/') || filePath.includes('/page_layout/')) && filePath.endsWith('.xml')) return 'layout';
  return undefined;
}

// ─── Completion candidate resolution ────────────────────────────────────────

/**
 * Result of resolving completion candidates: the list of possible values and the
 * CompletionItemKind to tag each item with.
 *
 * For FQCN and template completions, the `source` field is set to 'symbolIndex'
 * to route through the segment-boundary matcher instead of the substring filter.
 */
interface CompletionCandidates {
  /** Iterable of candidate strings (FQCNs, event names, table names, etc.). */
  candidates: Iterable<string>;
  /** LSP CompletionItemKind for all candidates in this set. */
  kind: CompletionItemKind;
  /** When set, use the symbol index matcher instead of substring filtering. */
  source?: 'symbolIndex';
  /** Symbol type for symbol index routing: 'class' or 'template'. */
  symbolType?: 'class' | 'template';
  /**
   * Extra candidates to merge in (e.g. virtual type names alongside class matches).
   * These are still filtered with substring matching.
   */
  extraCandidates?: Iterable<string>;
}

/**
 * Chain multiple iterables into a single iterable.
 *
 * Used to merge candidates from different sources (e.g. FQCNs + virtual type names).
 */
function* chain<T>(...iterables: Iterable<T>[]): Iterable<T> {
  for (const iter of iterables) {
    yield* iter;
  }
}

/**
 * Determine the completion candidates for a given XML context.
 *
 * Maps the combination of (fileType, elementName, attributeName, xsi:type) to the
 * appropriate index query and CompletionItemKind. Returns undefined when no completion
 * is applicable for the given context.
 *
 * @param project - The project context containing all indexes.
 * @param fileType - The detected Magento XML file type.
 * @param context - The XML context at the cursor position.
 * @param documentText - The full document text (needed for db_schema referenceColumn lookup).
 * @returns Candidates and their kind, or undefined if no completions apply.
 */
function getCompletionCandidates(
  project: ProjectContext,
  fileType: MagentoXmlFileType,
  context: XmlContext,
  documentText: string,
): CompletionCandidates | undefined {
  const { elementName, attributeName, kind: ctxKind, xsiType } = context;
  const isAttr = ctxKind === 'attribute-value';
  const isText = ctxKind === 'text-content';

  switch (fileType) {
    // ── di.xml ──────────────────────────────────────────────────────────
    case 'di': {
      if (isAttr) {
        // <preference for="..." type="...">
        if (elementName === 'preference' && (attributeName === 'for' || attributeName === 'type')) {
          return { candidates: [], kind: CompletionItemKind.Class, source: 'symbolIndex', symbolType: 'class' };
        }
        // <type name="...">
        if (elementName === 'type' && attributeName === 'name') {
          return { candidates: [], kind: CompletionItemKind.Class, source: 'symbolIndex', symbolType: 'class' };
        }
        // <plugin type="...">
        if (elementName === 'plugin' && attributeName === 'type') {
          return { candidates: [], kind: CompletionItemKind.Class, source: 'symbolIndex', symbolType: 'class' };
        }
        // <virtualType type="...">
        if (elementName === 'virtualType' && attributeName === 'type') {
          return { candidates: [], kind: CompletionItemKind.Class, source: 'symbolIndex', symbolType: 'class' };
        }
      }
      // <argument xsi:type="object">FQCN</argument>
      if (isText && elementName === 'argument' && xsiType === 'object') {
        return {
          candidates: [],
          kind: CompletionItemKind.Class,
          source: 'symbolIndex',
          symbolType: 'class',
          extraCandidates: project.indexes.di.getAllVirtualTypeNames(),
        };
      }
      return undefined;
    }

    // ── events.xml ──────────────────────────────────────────────────────
    case 'events': {
      if (isAttr) {
        // <event name="...">
        if (elementName === 'event' && attributeName === 'name') {
          return { candidates: project.indexes.events.getAllEventNames(), kind: CompletionItemKind.Event };
        }
        // <observer instance="...">
        if (elementName === 'observer' && attributeName === 'instance') {
          return { candidates: [], kind: CompletionItemKind.Class, source: 'symbolIndex', symbolType: 'class' };
        }
      }
      return undefined;
    }

    // ── Layout XML ──────────────────────────────────────────────────────
    case 'layout': {
      if (isAttr) {
        // <block class="...">
        if (elementName === 'block' && attributeName === 'class') {
          return { candidates: [], kind: CompletionItemKind.Class, source: 'symbolIndex', symbolType: 'class' };
        }
        // <block template="..."> or <referenceBlock template="...">
        if ((elementName === 'block' || elementName === 'referenceBlock') && attributeName === 'template') {
          return { candidates: [], kind: CompletionItemKind.File, source: 'symbolIndex', symbolType: 'template' };
        }
        // <update handle="...">
        if (elementName === 'update' && attributeName === 'handle') {
          return { candidates: project.indexes.layout.getAllHandles(), kind: CompletionItemKind.Reference };
        }
        // <referenceBlock name="...">
        if (elementName === 'referenceBlock' && attributeName === 'name') {
          return { candidates: project.indexes.layout.getAllBlockNames(), kind: CompletionItemKind.Reference };
        }
        // <referenceContainer name="...">
        if (elementName === 'referenceContainer' && attributeName === 'name') {
          return { candidates: project.indexes.layout.getAllContainerNames(), kind: CompletionItemKind.Reference };
        }
        // <move element="..."> — could be a block or container
        if (elementName === 'move' && attributeName === 'element') {
          return {
            candidates: chain(project.indexes.layout.getAllBlockNames(), project.indexes.layout.getAllContainerNames()),
            kind: CompletionItemKind.Reference,
          };
        }
        // <move destination="..."> — target is always a container
        if (elementName === 'move' && attributeName === 'destination') {
          return { candidates: project.indexes.layout.getAllContainerNames(), kind: CompletionItemKind.Reference };
        }
      }
      // <argument xsi:type="object">FQCN</argument> in layout XML
      if (isText && elementName === 'argument' && xsiType === 'object') {
        return {
          candidates: [],
          kind: CompletionItemKind.Class,
          source: 'symbolIndex',
          symbolType: 'class',
          extraCandidates: project.indexes.di.getAllVirtualTypeNames(),
        };
      }
      return undefined;
    }

    // ── webapi.xml ──────────────────────────────────────────────────────
    case 'webapi': {
      if (isAttr) {
        // <service class="...">
        if (elementName === 'service' && attributeName === 'class') {
          return { candidates: [], kind: CompletionItemKind.Class, source: 'symbolIndex', symbolType: 'class' };
        }
        // <resource ref="...">
        if (elementName === 'resource' && attributeName === 'ref') {
          return { candidates: project.indexes.acl.getAllResourceIds(), kind: CompletionItemKind.Constant };
        }
      }
      return undefined;
    }

    // ── system.xml ──────────────────────────────────────────────────────
    case 'system': {
      // <source_model>FQCN</source_model>, <backend_model>FQCN</backend_model>, <frontend_model>FQCN</frontend_model>
      if (isText && (elementName === 'source_model' || elementName === 'backend_model' || elementName === 'frontend_model')) {
        return {
          candidates: [],
          kind: CompletionItemKind.Class,
          source: 'symbolIndex',
          symbolType: 'class',
        };
      }
      // <resource>ACL_ID</resource>
      if (isText && elementName === 'resource') {
        return { candidates: project.indexes.acl.getAllResourceIds(), kind: CompletionItemKind.Constant };
      }
      return undefined;
    }

    // ── menu.xml ────────────────────────────────────────────────────────
    case 'menu': {
      if (isAttr) {
        // <add resource="...">
        if (elementName === 'add' && attributeName === 'resource') {
          return { candidates: project.indexes.acl.getAllResourceIds(), kind: CompletionItemKind.Constant };
        }
      }
      return undefined;
    }

    // ── UI component XML ────────────────────────────────────────────────
    case 'ui_component': {
      // <aclResource>ACL_ID</aclResource>
      if (isText && elementName === 'aclResource') {
        return { candidates: project.indexes.acl.getAllResourceIds(), kind: CompletionItemKind.Constant };
      }
      return undefined;
    }

    // ── db_schema.xml ───────────────────────────────────────────────────
    case 'db_schema': {
      if (isAttr) {
        // <constraint ... referenceTable="...">
        if (elementName === 'constraint' && attributeName === 'referenceTable') {
          return { candidates: project.indexes.dbSchema.getAllTableNames(), kind: CompletionItemKind.Field };
        }
        // <constraint ... referenceColumn="..."> — columns from the referenceTable on the same element
        if (elementName === 'constraint' && attributeName === 'referenceColumn') {
          const refTable = extractReferenceTableFromContext(documentText, context);
          if (refTable) {
            const columns = project.indexes.dbSchema.getColumnsForTable(refTable)
              .map((c) => c.value);
            return { candidates: columns, kind: CompletionItemKind.Field };
          }
          return undefined;
        }
      }
      return undefined;
    }

    // acl.xml: definitions, not references — no completions
    case 'acl':
      return undefined;

    default:
      return undefined;
  }
}

/**
 * Extract the `referenceTable` attribute value from the same XML element as the cursor.
 *
 * When completing `referenceColumn`, we need to know which table the FK points to so we
 * can offer that table's columns. This scans the line(s) around the cursor's value range
 * for a `referenceTable="tableName"` attribute.
 *
 * @param documentText - The full XML document text.
 * @param context - The XML context at the cursor position (for locating the element).
 * @returns The referenceTable value, or undefined if not found.
 */
function extractReferenceTableFromContext(documentText: string, context: XmlContext): string | undefined {
  const lines = documentText.split('\n');
  const cursorLine = context.valueRange.line;

  // Search within a reasonable range around the cursor line (the tag may span multiple lines)
  const startLine = Math.max(0, cursorLine - 10);
  const endLine = Math.min(lines.length - 1, cursorLine + 5);

  const refTableRe = /referenceTable\s*=\s*["']([^"']+)["']/;
  for (let i = startLine; i <= endLine; i++) {
    const match = refTableRe.exec(lines[i]);
    if (match) return match[1];
  }
  return undefined;
}

// ─── CompletionList builder ─────────────────────────────────────────────────

/** Maximum number of completion items to return in a single response. */
const MAX_COMPLETION_ITEMS = 100;

/**
 * Build a CompletionList from an iterable of candidate strings.
 *
 * Filters candidates against the partial text already typed (case-insensitive substring
 * match), limits results to {@link MAX_COMPLETION_ITEMS}, and creates TextEdit entries
 * that replace the entire current attribute value or text content.
 *
 * @param candidates - All possible completion values from the index.
 * @param partial - The partial text already typed (used for filtering).
 * @param kind - The CompletionItemKind to assign to each item.
 * @param valueRange - The range of the current value to be replaced by the completion.
 * @returns A CompletionList (always marked `isIncomplete: true` since results are capped).
 */
function buildCompletionList(
  candidates: Iterable<string>,
  partial: string,
  kind: CompletionItemKind,
  valueRange: { line: number; startCol: number; endCol: number },
): CompletionList {
  const items: CompletionItem[] = [];
  const lowerPartial = partial.toLowerCase();
  const range = Range.create(
    valueRange.line, valueRange.startCol,
    valueRange.line, valueRange.endCol,
  );

  for (const candidate of candidates) {
    // When user has typed something, filter by case-insensitive substring match
    if (lowerPartial.length > 0 && !candidate.toLowerCase().includes(lowerPartial)) {
      continue;
    }

    items.push({
      label: candidate,
      kind,
      textEdit: TextEdit.replace(range, candidate),
      filterText: candidate,
      sortText: candidate,
    });

    if (items.length >= MAX_COMPLETION_ITEMS) break;
  }

  return { isIncomplete: true, items };
}

// ─── PHP completion ─────────────────────────────────────────────────────────

/**
 * Handle completion requests inside PHP files.
 *
 * Detects whether the cursor is inside a string argument of a Magento API call and
 * offers appropriate completions:
 *   - `$eventManager->dispatch('partial|')` → event names
 *   - `$scopeConfig->getValue('partial|')` or `isSetFlag('partial|')` → config paths
 *   - `$this->_authorization->isAllowed('partial|')` → ACL resource IDs
 *   - `const ADMIN_RESOURCE = 'partial|'` → ACL resource IDs
 *
 * @param filePath - Absolute path to the PHP file.
 * @param line - 0-based cursor line.
 * @param col - 0-based cursor column.
 * @param text - Full document text.
 * @param project - The project context.
 * @returns CompletionList or null if no completions apply.
 */
function handlePhpCompletion(
  filePath: string,
  line: number,
  col: number,
  text: string,
  project: ProjectContext,
): CompletionList | null {
  const lines = text.split('\n');
  const cursorLine = lines[line];
  if (!cursorLine) return null;

  // The text from the start of the line up to (but not including) the cursor column
  const textToCursor = cursorLine.substring(0, col);

  // Pattern definitions: [regex, candidates-getter, CompletionItemKind]
  // Each regex matches from line start up to the cursor, capturing the partial string value.
  const patterns: Array<[RegExp, () => Iterable<string>, CompletionItemKind]> = [
    // ->dispatch('partial  (event names)
    [/dispatch\(\s*['"]([^'"]*)$/, () => project.indexes.events.getAllEventNames(), CompletionItemKind.Event],
    // ->getValue('partial  or  ->isSetFlag('partial  (config paths)
    [/(?:getValue|isSetFlag)\(\s*['"]([^'"]*)$/, () => project.indexes.systemConfig.getAllConfigPaths(), CompletionItemKind.Value],
    // ->isAllowed('partial  (ACL resource IDs)
    [/isAllowed\(\s*['"]([^'"]*)$/, () => project.indexes.acl.getAllResourceIds(), CompletionItemKind.Constant],
    // ADMIN_RESOURCE = 'partial  (ACL resource IDs)
    [/ADMIN_RESOURCE\s*=\s*['"]([^'"]*)$/, () => project.indexes.acl.getAllResourceIds(), CompletionItemKind.Constant],
  ];

  for (const [regex, getCandidates, kind] of patterns) {
    const match = regex.exec(textToCursor);
    if (!match) continue;

    const partial = match[1];
    // The value starts right after the opening quote
    const quoteCol = col - partial.length;
    // Find the closing quote (if present) to determine end of value range
    const closingQuoteIdx = cursorLine.indexOf(
      cursorLine[quoteCol - 1] === '"' ? '"' : "'",
      col,
    );
    const endCol = closingQuoteIdx !== -1 ? closingQuoteIdx : col;

    return buildCompletionList(
      getCandidates(),
      partial,
      kind,
      { line, startCol: quoteCol, endCol },
    );
  }

  return null;
}

// ─── Symbol index completion builder ────────────────────────────────────

/**
 * Build a CompletionList using the symbol index's segment-boundary matcher.
 *
 * Instead of iterating all candidates with substring matching, this delegates
 * to the SymbolIndex which uses the pre-segmented matcher for fast, ranked results.
 *
 * For class contexts with `extraCandidates` (e.g. virtual types alongside real classes),
 * the extra candidates are filtered with the old substring approach and merged in.
 *
 * @param project - The project context.
 * @param filePath - The file being edited (for area detection in template completions).
 * @param result - The completion candidates result with source='symbolIndex'.
 * @param partial - The partial text already typed.
 * @param valueRange - The range of the current value to replace.
 * @returns A CompletionList with matched and ranked results.
 */
function buildSymbolCompletionList(
  project: ProjectContext,
  filePath: string,
  result: CompletionCandidates,
  partial: string,
  valueRange: { line: number; startCol: number; endCol: number },
): CompletionList {
  const range = Range.create(
    valueRange.line, valueRange.startCol,
    valueRange.line, valueRange.endCol,
  );

  let matches: string[];

  if (result.symbolType === 'template') {
    // Determine area from file path for scoped template completions
    const area = project.themeResolver.getAreaForFile(filePath) ?? 'frontend';
    matches = project.symbolIndex.matchTemplates(
      partial, area, project.symbolMatcher, MAX_COMPLETION_ITEMS,
    );
  } else {
    matches = project.symbolIndex.matchClasses(
      partial, project.symbolMatcher, MAX_COMPLETION_ITEMS,
    );
  }

  const items: CompletionItem[] = matches.map((value, idx) => ({
    label: value,
    kind: result.kind,
    textEdit: TextEdit.replace(range, value),
    filterText: value,
    // Use index as sortText to preserve score-based ordering from the matcher
    sortText: String(idx).padStart(5, '0'),
  }));

  // Merge in extra candidates (e.g. virtual type names) using substring matching
  if (result.extraCandidates && items.length < MAX_COMPLETION_ITEMS) {
    const lowerPartial = partial.toLowerCase();
    const existingLabels = new Set(matches);
    let extraIdx = items.length;

    for (const candidate of result.extraCandidates) {
      if (items.length >= MAX_COMPLETION_ITEMS) break;
      if (existingLabels.has(candidate)) continue;
      if (lowerPartial.length > 0 && !candidate.toLowerCase().includes(lowerPartial)) continue;

      items.push({
        label: candidate,
        kind: result.kind,
        textEdit: TextEdit.replace(range, candidate),
        filterText: candidate,
        sortText: String(extraIdx++).padStart(5, '0'),
      });
    }
  }

  return { isIncomplete: true, items };
}

// ─── Main handler ───────────────────────────────────────────────────────────

/**
 * Handle a `textDocument/completion` request.
 *
 * Entry point called by the LSP server. Determines the file type, extracts the
 * cursor context, and delegates to either PHP or XML completion logic.
 *
 * @param params - The LSP CompletionParams from the client.
 * @param getProject - Callback to retrieve the project context for a given file path.
 * @param getDocumentText - Callback to retrieve cached document text for an open file URI.
 * @param _token - Cancellation token (currently unused, reserved for future async work).
 * @returns A CompletionList with matching candidates, or null if no completions apply.
 */
export function handleCompletion(
  params: CompletionParams,
  getProject: (uri: string) => ProjectContext | undefined,
  getDocumentText: (uri: string) => string | undefined,
  _token?: CancellationToken,
): CompletionList | null {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  const project = getProject(filePath);
  if (!project || !project.indexingComplete) return null;

  const { line, character: col } = params.position;

  // ── PHP files ─────────────────────────────────────────────────────────
  if (filePath.endsWith('.php')) {
    const text = getDocumentText(params.textDocument.uri) ?? readFileSafe(filePath);
    if (!text) return null;
    return handlePhpCompletion(filePath, line, col, text, project);
  }

  // ── XML files ─────────────────────────────────────────────────────────
  if (!filePath.endsWith('.xml')) return null;

  const fileType = detectXmlFileType(filePath);
  if (!fileType) return null;
  // acl.xml contains definitions, not references — no completions to offer
  if (fileType === 'acl') return null;

  const text = getDocumentText(params.textDocument.uri) ?? readFileSafe(filePath);
  if (!text) return null;

  const context = getXmlContextAtPosition(text, line, col);
  if (!context) return null;

  const result = getCompletionCandidates(project, fileType, context, text);
  if (!result) return null;

  // Route symbol index completions through the segment-boundary matcher
  if (result.source === 'symbolIndex') {
    return buildSymbolCompletionList(
      project,
      filePath,
      result,
      context.partialValue,
      context.valueRange,
    );
  }

  return buildCompletionList(
    result.candidates,
    context.partialValue,
    result.kind,
    context.valueRange,
  );
}

