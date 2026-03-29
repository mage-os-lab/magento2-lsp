/**
 * Type definitions for the symbol matching system.
 *
 * The matcher interface is designed to be swappable — the default implementation
 * uses segment-boundary matching, but it could be replaced with fuzzy matching
 * or any other strategy without changing the index or completion code.
 */

/**
 * A pre-segmented PHP class entry stored in the symbol index.
 *
 * Segments are computed once at scan time (via segmentizeFqcn) so that the
 * matcher doesn't need to split/lowercase on every keystroke.
 */
export interface ClassEntry {
  /** The full FQCN, e.g. "Magento\\Catalog\\Model\\Product". */
  value: string;
  /**
   * Pre-computed lowercase segments grouped by namespace part.
   * Each namespace part is split at camelCase boundaries.
   *
   * Example for "Hyva\\Theme\\ViewModel":
   *   [["hyva"], ["theme"], ["view", "model"]]
   */
  segments: string[][];
  /**
   * Bitmask of characters present in the lowercase FQCN.
   * Used by the fuzzy matcher for cheap pre-filtering:
   * if (entryMask & queryMask) !== queryMask, the entry can't match.
   * Bits 0-25 = a-z.
   */
  charMask: number;
}

/**
 * A pre-segmented template entry stored in the symbol index.
 *
 * Template IDs follow the Magento format "Module_Name::path/to/template.phtml".
 * The module and path parts are pre-segmented separately for efficient matching.
 */
export interface TemplateEntry {
  /** The full template ID, e.g. "Magento_Catalog::product/view.phtml". */
  value: string;
  /** The area this template belongs to: "frontend", "adminhtml", or "base". */
  area: string;
  /** Absolute path to the .phtml file on disk. */
  filePath: string;
  /**
   * Pre-computed module name segments.
   * "Magento_Catalog" → [["magento"], ["catalog"]]
   */
  moduleSegments: string[][];
  /**
   * Pre-computed path segments split at /, -, _ boundaries.
   * "product/view.phtml" → ["product", "view.phtml"]
   */
  pathSegments: string[];
  /**
   * Bitmask of characters present in the lowercase template ID.
   * Used by the fuzzy matcher for cheap pre-filtering.
   * Bits 0-25 = a-z.
   */
  charMask: number;
}

/**
 * Interface for matching a user's query against indexed symbols.
 *
 * Implementations must return a score > 0 for matches and 0 for non-matches.
 * Higher scores indicate better matches. This interface can be swapped to
 * provide different matching strategies (e.g. fuzzy matching).
 */
export interface SymbolMatcher {
  /**
   * Match a query string against a PHP class entry.
   *
   * @param query - The user's typed input (may contain backslashes, camelCase, etc.)
   * @param entry - A pre-segmented class entry from the index.
   * @returns A score > 0 if the query matches, 0 otherwise. Higher = better match.
   */
  matchClass(query: string, entry: ClassEntry): number;

  /**
   * Match a query string against a template entry.
   *
   * @param query - The user's typed input (may contain ::, /, -, etc.)
   * @param entry - A pre-segmented template entry from the index.
   * @returns A score > 0 if the query matches, 0 otherwise. Higher = better match.
   */
  matchTemplate(query: string, entry: TemplateEntry): number;
}
