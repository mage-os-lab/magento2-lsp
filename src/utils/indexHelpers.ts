/**
 * Generic helpers for in-memory index classes (EventsIndex, LayoutIndex, etc.).
 *
 * The index classes maintain Map<string, T[]> data structures for fast lookups
 * by key (FQCN, event name, template ID, etc.). They all need the same operations:
 *
 *   - Remove all entries for a given file from a map (when a file is re-indexed)
 *   - Find a reference at a specific cursor position (for "what's under the cursor")
 *
 * These generic helpers avoid duplicating the same logic in every index class.
 */

/**
 * Remove all entries belonging to a specific file from a Map<string, T[]>.
 *
 * Filters the array at the given key to exclude entries where `entry.file === file`.
 * If the filtered array is empty, the key is deleted entirely to avoid accumulating
 * empty arrays in the map over time.
 *
 * This is the standard cleanup operation when a file is modified or deleted:
 * the index first removes all old entries for that file, then re-adds the fresh
 * parse results.
 */
export function removeFromMap<T extends { file: string }>(
  map: Map<string, T[]>,
  key: string,
  file: string,
): void {
  const existing = map.get(key);
  if (!existing) return;
  const filtered = existing.filter((r) => r.file !== file);
  if (filtered.length > 0) {
    map.set(key, filtered);
  } else {
    map.delete(key);
  }
}

/**
 * Find a reference at a specific line/column position within a file's references.
 *
 * Used by LSP handlers to determine what the user's cursor is on in an XML file.
 * The comparison checks that the cursor line matches and the cursor column falls
 * within the reference's [column, endColumn) range (half-open interval — the
 * endColumn is exclusive, matching LSP Range semantics).
 */
export function findReferenceAtPosition<
  T extends { line: number; column: number; endColumn: number },
>(
  refs: T[] | undefined,
  line: number,
  col: number,
): T | undefined {
  if (!refs) return undefined;
  return refs.find(
    (r) => r.line === line && col >= r.column && col < r.endColumn,
  );
}
