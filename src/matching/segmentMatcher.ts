/**
 * Segment-boundary matcher for PHP class names and template IDs.
 *
 * This is the default SymbolMatcher implementation. It matches the user's query
 * against pre-segmented index entries by treating the query as a series of
 * segment prefixes. For example, "CatModProd" matches "Magento\Catalog\Model\Product"
 * because "Cat" is a prefix of "Catalog", "Mod" of "Model", and "Prod" of "Product".
 *
 * Key features:
 * - CamelCase splitting: "ViewModel" query chunks match within a single namespace
 *   segment (e.g. "view" + "model" both match within "ViewModel").
 * - Explicit backslash terminators: typing "View\" forces the match to complete
 *   the current namespace segment, so it won't match "ViewModel".
 * - Template matching: splits query at "::" for module vs path matching, and
 *   splits path queries at /, -, _ boundaries.
 * - Leading backslash in queries is stripped.
 *
 * This matcher can be swapped out for a fuzzy matcher via the SymbolMatcher interface.
 */

import { ClassEntry, SymbolMatcher, TemplateEntry } from './types';

/**
 * Split a query string at camelCase boundaries for matching.
 *
 * Unlike splitCamelCase (used for entry segmentation), this function splits
 * at EVERY uppercase letter. This is because in a query like "HTVLLogo",
 * each uppercase letter is intended as a separate segment prefix:
 * H→Hyva, T→Theme, V→ViewModel, L→Logo, Logo→LogoPathResolver.
 *
 * Standard camelCase splitting would group "HTVL" as an acronym, but in
 * query context each letter is a separate shorthand.
 *
 * @param str - A query string (no namespace separators).
 * @returns Array of lowercase segments.
 */
function splitQueryCamelCase(str: string): string[] {
  if (str.length === 0) return [];

  const segments: string[] = [];
  let current = '';

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const isUpper = ch >= 'A' && ch <= 'Z';

    if (isUpper && current.length > 0) {
      // Every uppercase letter starts a new segment in query context
      segments.push(current.toLowerCase());
      current = ch;
    } else {
      current += ch;
    }
  }

  if (current.length > 0) {
    segments.push(current.toLowerCase());
  }

  return segments;
}

/**
 * A parsed query chunk with an optional "terminated" flag.
 * Terminated means the user typed an explicit separator after this chunk,
 * which forces the matcher to advance past the current entry segment.
 */
interface QueryChunk {
  /** Lowercase text to match as a prefix. */
  text: string;
  /** If true, the entry segment must be fully consumed (explicit \ or / after this chunk). */
  terminated: boolean;
  /** If true, advance to the next outer segment without requiring full consumption. */
  advance?: boolean;
}

// ─── Query parsing ─────────────────────────────────────────────────────────

/**
 * Parse a class query into ordered chunks for matching.
 *
 * 1. Strip leading backslash.
 * 2. Split at explicit backslashes. A trailing backslash on a part sets "terminated".
 * 3. Split each part at camelCase boundaries.
 *
 * @example
 * parseClassQuery("CatModProd")
 * // → [{ text: "cat", terminated: false }, { text: "mod", terminated: false }, { text: "prod", terminated: false }]
 *
 * @example
 * parseClassQuery("View\\")
 * // → [{ text: "view", terminated: true }]
 *
 * @example
 * parseClassQuery("Magento\\Catalog\\Model\\Pro")
 * // → [{ text: "magento", t: true }, { text: "catalog", t: true }, { text: "model", t: true }, { text: "pro", t: false }]
 */
function parseClassQuery(query: string): QueryChunk[] {
  // Strip leading backslash
  let q = query.startsWith('\\') ? query.slice(1) : query;
  if (q.length === 0) return [];

  const chunks: QueryChunk[] = [];

  // Split at explicit backslashes
  const nsParts = q.split('\\');

  for (let i = 0; i < nsParts.length; i++) {
    const part = nsParts[i];
    // A trailing empty string from "View\" means the previous part is terminated
    // The last non-empty part before an empty string is terminated
    const isLastPart = i === nsParts.length - 1;

    if (part.length === 0) {
      // This is a trailing backslash — mark the previous chunk as terminated
      if (chunks.length > 0) {
        chunks[chunks.length - 1].terminated = true;
      }
      continue;
    }

    // Split this part at camelCase boundaries
    const camelParts = splitQueryCamelCase(part);

    for (let j = 0; j < camelParts.length; j++) {
      const text = camelParts[j];
      if (text.length === 0) continue;

      chunks.push({
        text,
        // The last camelCase chunk of a non-last namespace part is terminated
        // (the backslash between namespace parts forces segment advancement)
        terminated: !isLastPart && j === camelParts.length - 1,
      });
    }
  }

  return chunks;
}

/**
 * Parse a template query into module chunks and path chunks.
 *
 * Splits at "::" first. The module part (if present) is split at "_" and
 * camelCase boundaries. The path part is split at "/", "-", "_".
 *
 * If no "::" is present, the entire query is treated as path-only.
 */
function parseTemplateQuery(query: string): { moduleChunks: QueryChunk[]; pathChunks: QueryChunk[] } {
  const sepIdx = query.indexOf('::');

  if (sepIdx === -1) {
    // No module part — entire query is path
    return {
      moduleChunks: [],
      pathChunks: parseTemplatePathQuery(query),
    };
  }

  const modulePart = query.slice(0, sepIdx);
  const pathPart = query.slice(sepIdx + 2);

  return {
    moduleChunks: parseModuleQuery(modulePart),
    pathChunks: parseTemplatePathQuery(pathPart),
  };
}

/**
 * Parse a module name query (the part before ::).
 * Splits at "_" then camelCase within each part.
 * The last camelCase chunk of each underscore part (except the final part)
 * is marked as terminated to force advancing past that module segment.
 */
function parseModuleQuery(query: string): QueryChunk[] {
  if (query.length === 0) return [];

  const chunks: QueryChunk[] = [];
  const underscoreParts = query.split('_');

  for (let i = 0; i < underscoreParts.length; i++) {
    const part = underscoreParts[i];
    if (part.length === 0) continue;

    const isLastPart = i === underscoreParts.length - 1;
    const camelParts = splitQueryCamelCase(part);

    for (let j = 0; j < camelParts.length; j++) {
      const text = camelParts[j];
      if (text.length === 0) continue;

      chunks.push({
        text,
        terminated: false,
        advance: !isLastPart && j === camelParts.length - 1,
      });
    }
  }

  return chunks;
}

/**
 * Parse a template path query (the part after ::, or the whole query if no ::).
 * Splits at "/", "-", "_" boundaries.
 */
function parseTemplatePathQuery(query: string): QueryChunk[] {
  if (query.length === 0) return [];

  const chunks: QueryChunk[] = [];
  const parts = query.split(/[/\-_]/);

  for (let i = 0; i < parts.length; i++) {
    const text = parts[i].toLowerCase();
    if (text.length === 0) {
      // Trailing separator — mark previous chunk as terminated
      if (chunks.length > 0) {
        chunks[chunks.length - 1].terminated = true;
      }
      continue;
    }

    const isLastPart = i === parts.length - 1;
    chunks.push({
      text,
      // Non-last parts are terminated (the separator between them forces advancement)
      terminated: !isLastPart,
    });
  }

  return chunks;
}

// ─── Matching logic ────────────────────────────────────────────────────────

/**
 * Match query chunks against nested entry segments (for classes and module names).
 *
 * Entry segments are organized as: outer array = namespace/module parts,
 * inner array = camelCase words within each part.
 *
 * Each query chunk matches as a prefix within an inner segment. Multiple
 * consecutive chunks can match within the SAME inner segment by consuming
 * consecutive portions. For example, query chunks ["h","t","t","p"] match
 * within inner segment "http" by consuming h→t→t→p in sequence.
 *
 * When a chunk doesn't match the remainder of the current inner segment,
 * we advance to the next inner segment (or the next outer segment).
 *
 * A "terminated" chunk forces the matcher to advance to the next outer segment
 * and requires that all inner segments of the current outer segment were consumed.
 *
 * @param chunks - Parsed query chunks in order.
 * @param segments - Entry's pre-computed segments (e.g. [["view", "model"], ["logo"]]).
 * @returns Total matched character count (score), or 0 if no match.
 */
function matchNestedSegments(chunks: QueryChunk[], segments: string[][]): number {
  if (chunks.length === 0) return 1; // Empty query matches everything
  if (segments.length === 0) return 0; // No segments to match against

  let score = 0;
  let chunkIdx = 0;

  // Walk through outer segments (namespace parts / module parts)
  for (let outerIdx = 0; outerIdx < segments.length && chunkIdx < chunks.length; outerIdx++) {
    const innerSegments = segments[outerIdx];

    // Track position within the current inner segment. This allows multiple
    // query chunks to match consecutively within one inner segment
    // (e.g. "h","t","t","p" all matching within "http").
    let innerIdx = 0;
    let innerPos = 0;

    while (chunkIdx < chunks.length && innerIdx < innerSegments.length) {
      const chunk = chunks[chunkIdx];
      const seg = innerSegments[innerIdx];
      const remaining = seg.slice(innerPos);

      if (remaining.startsWith(chunk.text)) {
        // Chunk matches at the current position within this inner segment
        score += chunk.text.length;
        innerPos += chunk.text.length;

        // Check if we've consumed the entire inner segment
        if (innerPos >= seg.length) {
          score += 1; // Bonus for fully consuming an inner segment
          innerIdx++;
          innerPos = 0;
        }

        chunkIdx++;

        // If terminated, the entire outer segment must be consumed
        if (chunk.terminated) {
          if (innerIdx < innerSegments.length) {
            return 0; // "View\" can't match "ViewModel" (inner has "model" left)
          }
          break; // Advance to next outer segment
        }

        // If advance, move to next outer segment without requiring full consumption
        if (chunk.advance) {
          break;
        }
      } else {
        // No match at current position — advance to next inner segment
        innerIdx++;
        innerPos = 0;
      }
    }

    // If we ran out of inner segments but still have chunks, those chunks
    // will be tried against the next outer segment (the for loop continues).
  }

  // All query chunks must have been consumed for a match
  return chunkIdx === chunks.length ? score : 0;
}

/**
 * Match path query chunks against flat path segments.
 *
 * Each query chunk must match as a prefix of a path segment, in order.
 * Terminated chunks require advancing to the next segment.
 *
 * @param chunks - Parsed path query chunks.
 * @param segments - Entry's pre-computed path segments (lowercase).
 * @returns Score > 0 if match, 0 otherwise.
 */
function matchPathSegments(chunks: QueryChunk[], segments: string[]): number {
  if (chunks.length === 0) return 1; // Empty path query matches everything
  if (segments.length === 0) return 0;

  let score = 0;
  let chunkIdx = 0;

  for (let segIdx = 0; segIdx < segments.length && chunkIdx < chunks.length; segIdx++) {
    const chunk = chunks[chunkIdx];
    const seg = segments[segIdx];

    if (seg.startsWith(chunk.text)) {
      score += chunk.text.length;
      if (chunk.text.length === seg.length) {
        score += 1;
      }
      chunkIdx++;
    }
  }

  return chunkIdx === chunks.length ? score : 0;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Create a segment-boundary matcher.
 *
 * This is the default matching strategy. It treats user input as a series
 * of segment prefixes, matching against pre-segmented index entries.
 *
 * @returns A SymbolMatcher instance using segment-boundary matching.
 */
export function createSegmentMatcher(): SymbolMatcher {
  return {
    matchClass(query: string, entry: ClassEntry): number {
      const chunks = parseClassQuery(query);
      return matchNestedSegments(chunks, entry.segments);
    },

    matchTemplate(query: string, entry: TemplateEntry): number {
      const { moduleChunks, pathChunks } = parseTemplateQuery(query);

      // If a module filter was provided, it must match
      if (moduleChunks.length > 0) {
        const moduleScore = matchNestedSegments(moduleChunks, entry.moduleSegments);
        if (moduleScore === 0) return 0;

        // Path part is optional when module filter is provided
        if (pathChunks.length === 0) return moduleScore;

        const pathScore = matchPathSegments(pathChunks, entry.pathSegments);
        if (pathScore === 0) return 0;

        return moduleScore + pathScore;
      }

      // No module filter — match against path only
      return matchPathSegments(pathChunks, entry.pathSegments);
    },
  };
}
