/**
 * Utilities for finding the exact character position of attribute values and text content
 * within raw XML lines.
 *
 * The SAX parser (used in diXmlParser.ts) reports the line number of each XML tag, but does
 * not report the column offset of individual attribute values. Since the LSP needs precise
 * column ranges to support "go to definition" and "find references" at cursor position,
 * we do a secondary regex scan on the raw XML lines to pinpoint where each FQCN string
 * actually starts and ends.
 */

export interface AttributePosition {
  line: number;      // 0-based
  column: number;    // 0-based, start of attribute value (inside quotes)
  endColumn: number; // 0-based, end of attribute value (inside quotes)
}

/**
 * Find the position of an attribute's value within the raw XML source.
 *
 * Searches from `tagLine` forward (up to 5 lines) because XML attributes may be split
 * across multiple lines in formatted di.xml files.
 *
 * @param xmlLines - The full XML file split into lines.
 * @param tagLine  - The 0-based line where the SAX parser reported the opening tag.
 * @param attributeName - The attribute to find (e.g., 'for', 'type', 'name').
 * @returns Position of the value string (inside the quotes), or undefined if not found.
 */
export function findAttributeValuePosition(
  xmlLines: string[],
  tagLine: number,
  attributeName: string,
): AttributePosition | undefined {
  for (let i = tagLine; i < Math.min(tagLine + 5, xmlLines.length); i++) {
    const line = xmlLines[i];
    // Match: attributeName="value" or attributeName='value' (with optional whitespace around =)
    const re = new RegExp(`${escapeRegex(attributeName)}\\s*=\\s*(['"])(.*?)\\1`);
    const match = re.exec(line);
    if (match) {
      // Find where the value starts: skip past the opening quote character
      const quoteChar = match[1];
      const valueStart = match.index + match[0].indexOf(quoteChar) + 1;
      const valueEnd = valueStart + match[2].length;
      return {
        line: i,
        column: valueStart,
        endColumn: valueEnd,
      };
    }
  }
  return undefined;
}

export interface TextContentPosition {
  line: number;
  column: number;
  endColumn: number;
}

/**
 * Find the position of text content (e.g., FQCN inside <argument xsi:type="object">).
 *
 * The text may appear on the same line as the opening tag or on the next line.
 * Searches a small window (3 lines) from the tag start.
 *
 * @param xmlLines    - The full XML file split into lines.
 * @param startLine   - The 0-based line of the opening tag.
 * @param textContent - The text content to locate (may have leading/trailing whitespace).
 */
export function findTextContentPosition(
  xmlLines: string[],
  startLine: number,
  textContent: string,
): TextContentPosition | undefined {
  const trimmed = textContent.trim();
  if (!trimmed) return undefined;

  for (let i = startLine; i < Math.min(startLine + 3, xmlLines.length); i++) {
    const col = xmlLines[i].indexOf(trimmed);
    if (col !== -1) {
      return {
        line: i,
        column: col,
        endColumn: col + trimmed.length,
      };
    }
  }
  return undefined;
}

/** Escape special regex characters so attribute names can be used in a RegExp safely. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
