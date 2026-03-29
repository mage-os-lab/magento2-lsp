/**
 * Hybrid fuzzy matcher for PHP class names and template IDs.
 *
 * This is an alternative SymbolMatcher implementation that uses subsequence
 * matching with bonuses for contiguity, segment boundaries, and prefix
 * positions. It's more forgiving than the segment matcher — "cpd" matches
 * "Catalog\Product\Data" — but slightly slower because it scans more of
 * each entry string.
 *
 * Each entry carries a pre-computed charMask (bitmask of characters present).
 * Before running the full subsequence scan, we check that the entry contains
 * all characters in the query. This eliminates ~90% of non-matches cheaply.
 */

import { computeCharMask } from './segmentation';
import { ClassEntry, SymbolMatcher, TemplateEntry } from './types';

// ─── Scoring constants ────────────────────────────────────────────────────

/** Base score per matched character. */
const SCORE_MATCH = 1;

/** Bonus when the matched character is contiguous with the previous match. */
const SCORE_CONTIGUOUS = 5;

/** Bonus when the match is at the very start of the string. */
const SCORE_START_OF_STRING = 8;

/** Bonus when the match is at a segment boundary (start of a camelCase word, after separator). */
const SCORE_BOUNDARY = 7;

/** Bonus when the match starts a camelCase word (not the first segment). */
const SCORE_CAMEL_CASE = 6;

// ─── Boundary detection ──────────────────────────────────────────────────

/** Characters that act as segment separators in FQCNs and template IDs. */
const SEPARATORS = new Set(['\\', '/', '_', '-', ':']);

/**
 * Check if position `i` in `str` is a segment boundary.
 *
 * A position is a boundary if:
 * - It's the start of the string (index 0)
 * - The preceding character is a separator (\, /, _, -, :)
 * - It's a camelCase transition (lowercase→uppercase)
 */
function isAnyBoundary(str: string, i: number): boolean {
  if (i === 0) return true;
  const prev = str[i - 1];
  if (SEPARATORS.has(prev)) return true;
  // camelCase boundary: previous char is lowercase, current is uppercase
  const prevCode = str.charCodeAt(i - 1);
  const currCode = str.charCodeAt(i);
  if (prevCode >= 97 && prevCode <= 122 && currCode >= 65 && currCode <= 90) return true;
  return false;
}

/**
 * Check if position `i` is a camelCase transition (but not after a separator).
 * Used to give a slightly lower bonus than a full separator boundary.
 */
function isCamelBoundary(str: string, i: number): boolean {
  if (i === 0) return false;
  const prev = str[i - 1];
  if (SEPARATORS.has(prev)) return false;
  const prevCode = str.charCodeAt(i - 1);
  const currCode = str.charCodeAt(i);
  return prevCode >= 97 && prevCode <= 122 && currCode >= 65 && currCode <= 90;
}

// ─── Subsequence check ──────────────────────────────────────────────────

/**
 * Check if query[qStart..] is a case-insensitive subsequence of target[tStart..].
 * Used to verify that jumping to a boundary match doesn't strand remaining query chars.
 */
function isSubsequenceFrom(query: string, qStart: number, target: string, tStart: number): boolean {
  let qi = qStart;
  for (let ti = tStart; ti < target.length && qi < query.length; ti++) {
    const tc = target.charCodeAt(ti);
    const tcLower = tc >= 65 && tc <= 90 ? tc + 32 : tc;
    if (tcLower === query.charCodeAt(qi)) qi++;
  }
  return qi >= query.length;
}

// ─── Core fuzzy scoring ──────────────────────────────────────────────────

/**
 * Score a query against a target string using fuzzy subsequence matching.
 *
 * Returns 0 if the query is not a subsequence of the target.
 * Otherwise returns a positive score with bonuses for:
 * - Contiguous character runs
 * - Matches at segment boundaries
 * - Matches at the start of the string
 *
 * The algorithm does a single forward pass through the target, greedily
 * preferring boundary matches. When a query character matches at a boundary
 * position, it's always taken. Otherwise, the first available position is used.
 *
 * @param query - Lowercase query string (already normalized by caller).
 * @param target - The full value string to match against.
 * @returns Score > 0 for a match, 0 for no match.
 */
function fuzzyScore(query: string, target: string): number {
  const qLen = query.length;
  const tLen = target.length;

  if (qLen === 0) return 1; // Empty query matches everything
  if (qLen > tLen) return 0; // Query longer than target can't match

  // First pass: check if a subsequence match is even possible (fast bail-out).
  // We do this before the more expensive scoring pass.
  let qi = 0;
  for (let ti = 0; ti < tLen && qi < qLen; ti++) {
    const tc = target.charCodeAt(ti);
    const qc = query.charCodeAt(qi);
    // Case-insensitive comparison: lowercase both
    const tcLower = tc >= 65 && tc <= 90 ? tc + 32 : tc;
    if (tcLower === qc) qi++;
  }
  if (qi < qLen) return 0; // Not a subsequence

  // Second pass: greedy scoring with boundary preference.
  // For each query character, we look ahead for a boundary match before
  // settling for the first available match. When a non-boundary match is
  // found, we scan forward for a boundary position with the same character.
  // If one exists AND the remaining query is still a subsequence after it,
  // we skip to the boundary position. Otherwise we keep the first match.
  let score = 0;
  let prevMatchIdx = -2; // -2 so first match at 0 isn't "contiguous" with nothing
  qi = 0;
  let ti = 0;

  while (ti < tLen && qi < qLen) {
    const tc = target.charCodeAt(ti);
    const qc = query.charCodeAt(qi);
    const tcLower = tc >= 65 && tc <= 90 ? tc + 32 : tc;

    if (tcLower !== qc) {
      ti++;
      continue;
    }

    // This position matches. Check if it's already a boundary.
    let matchIdx = ti;

    if (ti !== 0 && !isCamelBoundary(target, ti) && !isAnyBoundary(target, ti)) {
      // Non-boundary match — look ahead for a boundary match of the same char,
      // but only use it if the remaining query chars are still matchable.
      for (let ahead = ti + 1; ahead < tLen; ahead++) {
        const ac = target.charCodeAt(ahead);
        const acLower = ac >= 65 && ac <= 90 ? ac + 32 : ac;
        if (acLower === qc && (isCamelBoundary(target, ahead) || isAnyBoundary(target, ahead))) {
          if (isSubsequenceFrom(query, qi + 1, target, ahead + 1)) {
            matchIdx = ahead;
          }
          break;
        }
      }
    }

    // Score the chosen position.
    score += SCORE_MATCH;

    if (matchIdx === prevMatchIdx + 1) {
      score += SCORE_CONTIGUOUS;
    }

    if (matchIdx === 0) {
      score += SCORE_START_OF_STRING;
    } else if (isCamelBoundary(target, matchIdx)) {
      score += SCORE_CAMEL_CASE;
    } else if (isAnyBoundary(target, matchIdx)) {
      score += SCORE_BOUNDARY;
    }

    prevMatchIdx = matchIdx;
    qi++;
    ti = matchIdx + 1;
  }

  return qi === qLen ? score : 0;
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Create a fuzzy matcher.
 *
 * This is an alternative matching strategy that uses subsequence matching
 * with contiguity and boundary bonuses. More forgiving than segment matching
 * but slightly slower.
 *
 * @returns A SymbolMatcher instance using fuzzy matching.
 */
export function createFuzzyMatcher(): SymbolMatcher {
  return {
    matchClass(query: string, entry: ClassEntry): number {
      const q = query.startsWith('\\') ? query.slice(1) : query;
      if (q.length === 0) return 1;

      const qLower = q.toLowerCase();
      const queryMask = computeCharMask(qLower);
      if ((entry.charMask & queryMask) !== queryMask) return 0;

      return fuzzyScore(qLower, entry.value);
    },

    matchTemplate(query: string, entry: TemplateEntry): number {
      if (query.length === 0) return 1;

      const qLower = query.toLowerCase();
      const queryMask = computeCharMask(qLower);
      if ((entry.charMask & queryMask) !== queryMask) return 0;

      return fuzzyScore(qLower, entry.value);
    },
  };
}
