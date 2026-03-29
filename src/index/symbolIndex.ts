/**
 * In-memory index for PHP classes and .phtml templates.
 *
 * Stores pre-segmented entries for fast matching during completion.
 * PHP classes are stored as a flat array; templates are partitioned by area
 * so that completions can be scoped to the editing context.
 *
 * The index supports:
 *   - Bulk loading (setClasses/setTemplates) for initial scan and cache load
 *   - Single-entry updates (addClass/removeClass/addTemplate/removeTemplate)
 *     for live file watcher updates
 *   - Querying with a SymbolMatcher interface for segment-boundary matching
 */

import { ClassEntry, TemplateEntry, SymbolMatcher } from '../matching/types';

/**
 * Main index for PHP class and template completion.
 *
 * Classes are stored in a flat array and linearly scanned during matching.
 * At 50k entries with ~5 segments each, this takes ~5ms per query — well
 * within the acceptable latency budget for completion.
 *
 * Templates are partitioned by area (frontend, adminhtml, base) so that
 * area-scoped queries only scan relevant entries. Base-area templates
 * are included in both frontend and adminhtml queries.
 */
export class SymbolIndex {
  /** All PHP class entries as a flat array for linear scan. */
  private classes: ClassEntry[] = [];

  /** Templates partitioned by area for efficient scoped queries. */
  private templatesByArea = new Map<string, TemplateEntry[]>();

  /**
   * Reverse lookup: file path → FQCN for PHP classes.
   * Enables O(1) removal when a file is deleted or renamed.
   */
  private fileToFqcn = new Map<string, string>();

  /**
   * Reverse lookup: file path → template value for .phtml files.
   * Enables O(1) identification for removal on file delete.
   */
  private fileToTemplateValue = new Map<string, string>();

  // ─── Bulk loading ──────────────────────────────────────────────────────

  /**
   * Replace the entire class index.
   * Used during initial scan or when loading from cache.
   */
  setClasses(entries: ClassEntry[]): void {
    this.classes = entries;
    this.fileToFqcn.clear();
    // Note: fileToFqcn is not populated during bulk load since we don't
    // have file paths for cached entries. It's only used for watcher updates.
  }

  /**
   * Replace the entire template index.
   * Partitions entries by area for efficient scoped queries.
   */
  setTemplates(entries: TemplateEntry[]): void {
    this.templatesByArea.clear();
    this.fileToTemplateValue.clear();

    for (const entry of entries) {
      this.addTemplateToArea(entry);
    }
  }

  // ─── Single-entry updates (for file watchers) ─────────────────────────

  /**
   * Add a single PHP class to the index.
   * @param entry - The ClassEntry with pre-computed segments.
   * @param filePath - The absolute path to the .php file (for removal tracking).
   */
  addClass(entry: ClassEntry, filePath: string): void {
    // Remove any existing entry for this file first (handles renames)
    this.removeClass(filePath);

    this.classes.push(entry);
    this.fileToFqcn.set(filePath, entry.value);
  }

  /**
   * Remove a PHP class by its file path.
   */
  removeClass(filePath: string): void {
    const fqcn = this.fileToFqcn.get(filePath);
    if (!fqcn) return;

    this.fileToFqcn.delete(filePath);
    const idx = this.classes.findIndex(e => e.value === fqcn);
    if (idx !== -1) {
      // Swap with last element and pop for O(1) removal
      this.classes[idx] = this.classes[this.classes.length - 1];
      this.classes.pop();
    }
  }

  /**
   * Add a single template to the index.
   */
  addTemplate(entry: TemplateEntry): void {
    // Remove existing entry for this file first (handles renames)
    this.removeTemplate(entry.filePath);

    this.addTemplateToArea(entry);
  }

  /**
   * Remove a template by its file path.
   */
  removeTemplate(filePath: string): void {
    const value = this.fileToTemplateValue.get(filePath);
    if (!value) return;

    this.fileToTemplateValue.delete(filePath);

    // Remove from all area partitions (a template's area might have changed)
    for (const [, areaTemplates] of this.templatesByArea) {
      const idx = areaTemplates.findIndex(e => e.filePath === filePath);
      if (idx !== -1) {
        // Swap with last and pop for O(1) removal
        areaTemplates[idx] = areaTemplates[areaTemplates.length - 1];
        areaTemplates.pop();
        break; // A file can only be in one area partition
      }
    }
  }

  // ─── Querying ──────────────────────────────────────────────────────────

  /**
   * Find PHP classes matching a query, ranked by score.
   *
   * @param query - The user's typed input.
   * @param matcher - The matching strategy to use.
   * @param limit - Maximum number of results to return.
   * @returns Array of matching FQCNs, sorted by match score descending.
   */
  matchClasses(query: string, matcher: SymbolMatcher, limit: number): string[] {
    const scored: Array<{ value: string; score: number }> = [];

    for (const entry of this.classes) {
      const score = matcher.matchClass(query, entry);
      if (score > 0) {
        scored.push({ value: entry.value, score });
      }
    }

    // Sort by score descending, then alphabetically for stable order
    scored.sort((a, b) => b.score - a.score || a.value.localeCompare(b.value));

    return scored.slice(0, limit).map(s => s.value);
  }

  /**
   * Find templates matching a query, scoped by area.
   *
   * Templates in the "base" area are included in both "frontend" and "adminhtml"
   * queries, since base templates are available in all areas.
   *
   * @param query - The user's typed input.
   * @param area - The area to scope to ("frontend", "adminhtml", or "base").
   * @param matcher - The matching strategy to use.
   * @param limit - Maximum number of results to return.
   * @returns Array of matching template IDs, sorted by match score descending.
   */
  matchTemplates(query: string, area: string, matcher: SymbolMatcher, limit: number): string[] {
    const scored: Array<{ value: string; score: number }> = [];

    // Get templates for the requested area
    const areaTemplates = this.templatesByArea.get(area) ?? [];
    for (const entry of areaTemplates) {
      const score = matcher.matchTemplate(query, entry);
      if (score > 0) {
        scored.push({ value: entry.value, score });
      }
    }

    // Also include "base" area templates (available in all areas)
    if (area !== 'base') {
      const baseTemplates = this.templatesByArea.get('base') ?? [];
      for (const entry of baseTemplates) {
        const score = matcher.matchTemplate(query, entry);
        if (score > 0) {
          scored.push({ value: entry.value, score });
        }
      }
    }

    scored.sort((a, b) => b.score - a.score || a.value.localeCompare(b.value));

    // Deduplicate: a template ID can appear multiple times (module + theme overrides)
    const seen = new Set<string>();
    const unique = scored.filter(s => {
      if (seen.has(s.value)) return false;
      seen.add(s.value);
      return true;
    });

    return unique.slice(0, limit).map(s => s.value);
  }

  // ─── Iteration ─────────────────────────────────────────────────────────

  /** Iterate over all class FQCNs (for MCP tools and other uses). */
  *getAllClassFqcns(): Iterable<string> {
    for (const entry of this.classes) {
      yield entry.value;
    }
  }

  /** Get the total number of indexed PHP classes. */
  getClassCount(): number {
    return this.classes.length;
  }

  /** Get the total number of indexed templates across all areas. */
  getTemplateCount(): number {
    let count = 0;
    for (const [, templates] of this.templatesByArea) {
      count += templates.length;
    }
    return count;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /** Add a template entry to its area partition and the reverse lookup map. */
  private addTemplateToArea(entry: TemplateEntry): void {
    let areaTemplates = this.templatesByArea.get(entry.area);
    if (!areaTemplates) {
      areaTemplates = [];
      this.templatesByArea.set(entry.area, areaTemplates);
    }
    areaTemplates.push(entry);
    this.fileToTemplateValue.set(entry.filePath, entry.value);
  }
}
