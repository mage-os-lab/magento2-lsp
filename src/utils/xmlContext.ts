/**
 * Determines the XML context at a given cursor position for providing completions.
 *
 * This utility analyzes raw XML text to figure out whether the cursor is inside an
 * attribute value (e.g., `<preference for="Ven|dor\Module">`) or inside text content
 * (e.g., `<argument xsi:type="object">Ven|dor\Module</argument>`). It extracts the
 * element name, attribute name, xsi:type, parent element, partial text already typed,
 * and the range of the value being edited — all the information a completion provider
 * needs to offer and insert suggestions.
 *
 * The approach uses line-based scanning with regex rather than full XML parsing, which
 * keeps it fast and tolerant of partially-typed (invalid) XML that is common during editing.
 */

/** The kind of XML position the cursor is in. */
export type XmlContextKind = 'attribute-value' | 'text-content';

/**
 * Describes the XML context at a cursor position, providing all the information
 * a completion provider needs to determine what to suggest and how to insert it.
 */
export interface XmlContext {
  /** Whether the cursor is inside an attribute value or element text content. */
  kind: XmlContextKind;
  /** The element name, e.g. "preference", "block", "argument". */
  elementName: string;
  /** The attribute name when kind is 'attribute-value', e.g. "for", "class", "template". */
  attributeName?: string;
  /** xsi:type value on the element if present (e.g. "object", "string"). */
  xsiType?: string;
  /** Parent element name for additional context (e.g. "type" when inside an argument). */
  parentElementName?: string;
  /** The partial text already typed (for filtering completions). */
  partialValue: string;
  /** The range of the current value (for TextEdit replacement). All values are 0-based. */
  valueRange: { line: number; startCol: number; endCol: number };
}

/**
 * Analyze the XML text and determine the context at the given cursor position.
 *
 * Returns an {@link XmlContext} if the cursor is inside an attribute value or element
 * text content, or `undefined` if the cursor is in a non-completable position (tag name,
 * attribute name, comment, CDATA, outside of tags, etc.).
 *
 * @param text - The full XML document text.
 * @param line - 0-based line number of the cursor.
 * @param col  - 0-based column number of the cursor.
 * @returns The XML context at the cursor, or undefined if not in a completable position.
 */
export function getXmlContextAtPosition(
  text: string,
  line: number,
  col: number,
): XmlContext | undefined {
  const lines = text.split('\n');
  if (line < 0 || line >= lines.length) return undefined;

  // Check if cursor is inside a comment or CDATA section
  if (isInsideCommentOrCdata(lines, line, col)) return undefined;

  // Try attribute value detection first
  const attrCtx = detectAttributeValue(lines, line, col);
  if (attrCtx) return attrCtx;

  // Try text content detection
  const textCtx = detectTextContent(lines, line, col);
  if (textCtx) return textCtx;

  return undefined;
}

/**
 * Check whether the cursor position falls inside an XML comment (`<!-- -->`)
 * or a CDATA section (`<![CDATA[ ]]>`).
 *
 * Uses a simple linear scan of the text up to the cursor position, tracking
 * whether we are currently inside a comment or CDATA block.
 *
 * @param lines - All lines of the XML document.
 * @param cursorLine - 0-based cursor line.
 * @param cursorCol - 0-based cursor column.
 * @returns True if the cursor is inside a comment or CDATA section.
 */
function isInsideCommentOrCdata(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): boolean {
  // Build text up to cursor position and scan for comment/CDATA boundaries
  let inComment = false;
  let inCdata = false;

  for (let i = 0; i <= cursorLine; i++) {
    const lineText = lines[i];
    const endCol = i === cursorLine ? cursorCol : lineText.length;

    for (let j = 0; j < endCol; j++) {
      if (inComment) {
        // Check for end of comment: -->
        if (lineText[j] === '-' && lineText.substring(j, j + 3) === '-->') {
          inComment = false;
          j += 2; // skip past -->
        }
      } else if (inCdata) {
        // Check for end of CDATA: ]]>
        if (lineText[j] === ']' && lineText.substring(j, j + 3) === ']]>') {
          inCdata = false;
          j += 2; // skip past ]]>
        }
      } else {
        // Check for start of comment: <!--
        if (lineText[j] === '<' && lineText.substring(j, j + 4) === '<!--') {
          inComment = true;
          j += 3; // skip past <!--
        }
        // Check for start of CDATA: <![CDATA[
        else if (lineText[j] === '<' && lineText.substring(j, j + 9) === '<![CDATA[') {
          inCdata = true;
          j += 8; // skip past <![CDATA[
        }
      }
    }
  }

  return inComment || inCdata;
}

/**
 * Detect whether the cursor is inside an attribute value.
 *
 * Scans the tag region around the cursor line to find all `attr="value"` or `attr='value'`
 * regions and checks if the cursor column falls between the quotes. For multi-line tags,
 * also checks preceding lines to find the opening `<elementName`.
 *
 * @param lines - All lines of the XML document.
 * @param cursorLine - 0-based cursor line.
 * @param cursorCol - 0-based cursor column.
 * @returns An XmlContext if the cursor is inside an attribute value, or undefined.
 */
function detectAttributeValue(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): XmlContext | undefined {
  const lineText = lines[cursorLine];

  // Find which attribute value region (if any) the cursor is in on this line.
  // We scan for patterns like: attrName="value" or attrName='value'
  // The cursor must be strictly between the quotes (or at the positions of the quotes
  // in the case of empty values).
  const attrRegion = findAttributeRegionAtCol(lineText, cursorCol);
  if (!attrRegion) return undefined;

  const { attributeName, valueStart, valueEnd, closingQuoteFound } = attrRegion;

  // Calculate partial value (text from opening quote to cursor)
  const partialValue = lineText.substring(valueStart, cursorCol);

  // Calculate the full value range
  const endCol = closingQuoteFound ? valueEnd : lineText.length;

  // Find the element name by scanning backward
  const elemInfo = findEnclosingElementTag(lines, cursorLine, cursorCol);
  if (!elemInfo) return undefined;

  // Extract xsi:type from the tag if present
  const xsiType = extractXsiTypeFromTag(lines, elemInfo.tagStartLine, cursorLine);

  // Find parent element
  const parentElementName = findParentElement(lines, elemInfo.tagStartLine);

  return {
    kind: 'attribute-value',
    elementName: elemInfo.elementName,
    attributeName,
    xsiType,
    parentElementName,
    partialValue,
    valueRange: { line: cursorLine, startCol: valueStart, endCol },
  };
}

/**
 * Information about an attribute value region found on a single line.
 */
interface AttributeRegion {
  /** The attribute name (e.g. "for", "class"). */
  attributeName: string;
  /** 0-based column of the first character after the opening quote. */
  valueStart: number;
  /** 0-based column of the last character before the closing quote (exclusive). */
  valueEnd: number;
  /** Whether a closing quote was found on this line. */
  closingQuoteFound: boolean;
}

/**
 * Find the attribute value region that contains the given column on a line.
 *
 * Scans the line for all `name="value"` and `name='value'` patterns using regex,
 * and returns the one whose value span includes the cursor column.
 *
 * @param lineText - The text of the line to scan.
 * @param col - 0-based cursor column.
 * @returns The matching attribute region, or undefined if cursor is not in any attribute value.
 */
function findAttributeRegionAtCol(lineText: string, col: number): AttributeRegion | undefined {
  // Match attribute patterns: name="value" or name='value'
  // Also handles cases where the closing quote hasn't been typed yet
  const attrPattern = /([\w:.-]+)\s*=\s*(['"])/g;
  let match;

  while ((match = attrPattern.exec(lineText)) !== null) {
    const attributeName = match[1];
    const quoteChar = match[2];
    // valueStart is the column right after the opening quote
    const valueStart = match.index + match[0].length;

    // Find the closing quote
    const closingQuotePos = lineText.indexOf(quoteChar, valueStart);

    if (closingQuotePos !== -1) {
      // Closing quote found — cursor must be between opening and closing quotes (inclusive of boundaries)
      if (col >= valueStart && col <= closingQuotePos) {
        return {
          attributeName,
          valueStart,
          valueEnd: closingQuotePos,
          closingQuoteFound: true,
        };
      }
    } else {
      // No closing quote — cursor must be at or after the opening quote
      if (col >= valueStart) {
        return {
          attributeName,
          valueStart,
          valueEnd: lineText.length,
          closingQuoteFound: false,
        };
      }
    }
  }

  return undefined;
}

/**
 * Information about the opening tag that encloses the cursor position.
 */
interface EnclosingTag {
  /** The element name (e.g. "preference", "block"). */
  elementName: string;
  /** The 0-based line where the `<elementName` was found. */
  tagStartLine: number;
}

/**
 * Find the opening tag (`<elementName ...`) that encloses the cursor position.
 *
 * Scans backward from the cursor line looking for an unclosed `<elementName` that
 * hasn't been terminated by a `>` before the cursor. This handles multi-line tags
 * where attributes span several lines.
 *
 * @param lines - All lines of the XML document.
 * @param cursorLine - 0-based cursor line.
 * @param cursorCol - 0-based cursor column.
 * @returns The enclosing tag info, or undefined if not found.
 */
function findEnclosingElementTag(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): EnclosingTag | undefined {
  // Scan backward from cursor line to find the `<elementName` that contains this attribute.
  // We look for the nearest `<name` that hasn't been closed by `>` before the cursor.
  for (let i = cursorLine; i >= Math.max(0, cursorLine - 20); i--) {
    const lineText = lines[i];
    // Find all `<elementName` occurrences on this line (not `</` or `<!--` or `<?`)
    const tagOpenPattern = /<([a-zA-Z][\w:.-]*)/g;
    let tagMatch;
    let lastValidMatch: RegExpExecArray | null = null;

    while ((tagMatch = tagOpenPattern.exec(lineText)) !== null) {
      const tagStartCol = tagMatch.index;

      // Skip comments and processing instructions
      if (lineText.substring(tagStartCol, tagStartCol + 4) === '<!--') continue;
      if (lineText.substring(tagStartCol, tagStartCol + 2) === '<?') continue;

      // For the cursor line, the tag must start before the cursor
      if (i === cursorLine && tagStartCol >= cursorCol) continue;

      // Check that the tag is not closed (no `>`) between the tag start and the cursor
      const searchFrom = tagStartCol + tagMatch[0].length;
      if (i === cursorLine) {
        // On cursor line: check there's no `>` between tag start and cursor
        const textBetween = lineText.substring(searchFrom, cursorCol);
        // Only disqualify if a > is found that's not inside a quoted attribute value
        if (hasUnquotedClosingAngle(lineText, searchFrom, cursorCol)) continue;
        lastValidMatch = tagMatch;
      } else {
        // On a previous line: check there's no `>` after the tag on the rest of that line
        // (the tag would be fully closed on that line)
        if (hasUnquotedClosingAngle(lineText, searchFrom, lineText.length)) continue;
        lastValidMatch = tagMatch;
      }
    }

    if (lastValidMatch) {
      return {
        elementName: lastValidMatch[1],
        tagStartLine: i,
      };
    }
  }

  return undefined;
}

/**
 * Check whether there is a `>` character between two columns that is not inside
 * a quoted attribute value.
 *
 * This is needed to determine whether an opening tag has been closed. A `>` inside
 * an attribute value like `attr="a>b"` should not count as closing the tag.
 *
 * @param lineText - The full line text.
 * @param startCol - 0-based start column (inclusive).
 * @param endCol - 0-based end column (exclusive).
 * @returns True if an unquoted `>` is found in the range.
 */
function hasUnquotedClosingAngle(lineText: string, startCol: number, endCol: number): boolean {
  let inQuote: string | null = null;
  for (let j = startCol; j < endCol; j++) {
    const ch = lineText[j];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === '>') {
      return true;
    }
  }
  return false;
}

/**
 * Extract the `xsi:type` attribute value from a tag spanning from `tagStartLine`
 * through `tagEndLine`.
 *
 * @param lines - All lines of the XML document.
 * @param tagStartLine - 0-based line where the tag opens.
 * @param tagEndLine - 0-based line up to which to search.
 * @returns The xsi:type value (e.g. "object", "string"), or undefined if not found.
 */
function extractXsiTypeFromTag(
  lines: string[],
  tagStartLine: number,
  tagEndLine: number,
): string | undefined {
  for (let i = tagStartLine; i <= tagEndLine; i++) {
    const match = /xsi:type\s*=\s*(['"])(.*?)\1/.exec(lines[i]);
    if (match) return match[2];
  }
  return undefined;
}

/**
 * Detect whether the cursor is inside element text content (between `>` and `</`).
 *
 * Looks for patterns where the cursor is after the closing `>` of an opening tag and
 * before the `</` of the closing tag. The opening tag may be on the same line or a
 * preceding line.
 *
 * @param lines - All lines of the XML document.
 * @param cursorLine - 0-based cursor line.
 * @param cursorCol - 0-based cursor column.
 * @returns An XmlContext if the cursor is in text content, or undefined.
 */
function detectTextContent(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): XmlContext | undefined {
  const lineText = lines[cursorLine];

  // First, ensure we're not inside a tag (between < and >)
  if (isInsideTag(lineText, cursorCol)) return undefined;

  // Find the enclosing element by scanning backward for an unclosed opening tag.
  // An "unclosed" tag is one that has a `>` (so the tag is complete) but whose matching
  // `</tagName>` has not yet appeared before the cursor.
  const enclosing = findEnclosingTextElement(lines, cursorLine, cursorCol);
  if (!enclosing) return undefined;

  const { elementName, contentStartLine, contentStartCol } = enclosing;

  // Determine the text content range and partial value
  // Find where the closing tag starts (could be on cursor line or after)
  const closingTagStart = findClosingTagOnLine(lineText, elementName, cursorCol);

  // Build partial value: from content start to cursor
  let partialValue = '';
  if (contentStartLine === cursorLine) {
    partialValue = lineText.substring(contentStartCol, cursorCol);
  } else {
    // Multi-line: concatenate from content start to cursor
    partialValue = lines[contentStartLine].substring(contentStartCol);
    for (let i = contentStartLine + 1; i < cursorLine; i++) {
      partialValue += '\n' + lines[i];
    }
    partialValue += '\n' + lineText.substring(0, cursorCol);
  }
  // Trim leading/trailing whitespace from partial for filtering purposes
  partialValue = partialValue.trim();

  // Calculate the value range on the cursor line
  const rangeStartCol = contentStartLine === cursorLine ? contentStartCol : 0;
  const rangeEndCol = closingTagStart !== undefined ? closingTagStart : lineText.length;

  // Extract xsi:type from the opening tag
  const xsiType = extractXsiTypeFromTag(lines, enclosing.tagStartLine, enclosing.tagEndLine);

  // Find parent element
  const parentElementName = findParentElement(lines, enclosing.tagStartLine);

  return {
    kind: 'text-content',
    elementName,
    xsiType,
    parentElementName,
    partialValue,
    valueRange: { line: cursorLine, startCol: rangeStartCol, endCol: rangeEndCol },
  };
}

/**
 * Check whether the cursor column falls inside an XML tag (between `<` and `>`),
 * excluding positions that are inside text content.
 *
 * This is a simple heuristic: scan the line from the left, tracking quote state and
 * angle brackets. If the cursor is between an unmatched `<` and its closing `>`, it's
 * inside a tag.
 *
 * @param lineText - The line text.
 * @param col - 0-based cursor column.
 * @returns True if the cursor appears to be inside a tag on this line.
 */
function isInsideTag(lineText: string, col: number): boolean {
  let inTag = false;
  let inQuote: string | null = null;

  for (let j = 0; j < col; j++) {
    const ch = lineText[j];
    if (inTag && inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (inTag) {
      if (ch === '"' || ch === "'") {
        inQuote = ch;
      } else if (ch === '>') {
        inTag = false;
      }
    } else {
      if (ch === '<') {
        inTag = true;
      }
    }
  }

  return inTag;
}

/**
 * Information about the element whose text content the cursor is inside.
 */
interface EnclosingTextElement {
  /** The element name. */
  elementName: string;
  /** 0-based line where the opening tag starts (`<elementName`). */
  tagStartLine: number;
  /** 0-based line where the opening tag's `>` is found. */
  tagEndLine: number;
  /** 0-based line where text content begins (after the `>`). */
  contentStartLine: number;
  /** 0-based column where text content begins (after the `>`). */
  contentStartCol: number;
}

/**
 * Find the innermost element whose text content contains the cursor.
 *
 * Scans backward from the cursor to find the nearest opening tag that has been
 * closed with `>` (not `/>`) and whose matching closing tag hasn't appeared
 * before the cursor.
 *
 * @param lines - All lines of the XML document.
 * @param cursorLine - 0-based cursor line.
 * @param cursorCol - 0-based cursor column.
 * @returns Info about the enclosing element, or undefined.
 */
function findEnclosingTextElement(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): EnclosingTextElement | undefined {
  // Build a flat representation of tag events by scanning backward.
  // We look for the most recent `>` (non-self-closing) that opens a text region
  // containing the cursor.

  // Scan backward to find the nearest `>` that ends an opening tag
  for (let i = cursorLine; i >= Math.max(0, cursorLine - 50); i--) {
    const lineText = lines[i];
    const searchEndCol = (i === cursorLine) ? cursorCol : lineText.length;

    // Look for `>` characters on this line (scanning right-to-left up to cursor)
    for (let j = searchEndCol - 1; j >= 0; j--) {
      if (lineText[j] !== '>') continue;

      // Skip if this is end of a self-closing tag />
      if (j > 0 && lineText[j - 1] === '/') continue;

      // Skip if this is end of a comment -->
      if (j >= 2 && lineText.substring(j - 2, j + 1) === '-->') continue;

      // Skip if this is end of a CDATA ]]>
      if (j >= 2 && lineText.substring(j - 2, j + 1) === ']]>') continue;

      // Skip if this is end of a processing instruction ?>
      if (j > 0 && lineText[j - 1] === '?') continue;

      // Skip if this is a closing tag </foo>
      // Scan backward to check if there's a `</` before this `>`
      if (isClosingTag(lineText, j)) continue;

      // This `>` ends an opening tag. Find which element it belongs to.
      const elemName = findElementNameForClosingAngle(lines, i, j);
      if (!elemName) continue;

      // Now check if the cursor is actually in this element's text content
      // (i.e., the closing tag </elemName> hasn't appeared between `>` and cursor)
      const contentStartLine = i;
      const contentStartCol = j + 1;

      // Check that no closing tag for this element appears between content start and cursor
      if (hasClosingTagBetween(lines, elemName.name, contentStartLine, contentStartCol, cursorLine, cursorCol)) {
        continue;
      }

      return {
        elementName: elemName.name,
        tagStartLine: elemName.tagStartLine,
        tagEndLine: i,
        contentStartLine,
        contentStartCol,
      };
    }
  }

  return undefined;
}

/**
 * Check whether the `>` at position `j` on the given line is part of a closing tag (`</foo>`).
 *
 * Scans backward from `j` on the same line looking for `</`.
 *
 * @param lineText - The line text.
 * @param j - 0-based column of the `>`.
 * @returns True if this `>` closes a `</...>` tag.
 */
function isClosingTag(lineText: string, j: number): boolean {
  // Scan backward from j looking for `<` — if we find `</` before any other `<`, it's a closing tag
  for (let k = j - 1; k >= 0; k--) {
    if (lineText[k] === '<') {
      return k + 1 < lineText.length && lineText[k + 1] === '/';
    }
  }
  return false;
}

/**
 * Find the element name for an opening tag whose closing `>` is at the given position.
 *
 * Scans backward through lines to find the `<elementName` that corresponds to
 * the `>` at (angleLine, angleCol).
 *
 * @param lines - All lines of the XML document.
 * @param angleLine - 0-based line of the `>`.
 * @param angleCol - 0-based column of the `>`.
 * @returns The element name and tag start line, or undefined.
 */
function findElementNameForClosingAngle(
  lines: string[],
  angleLine: number,
  angleCol: number,
): { name: string; tagStartLine: number } | undefined {
  // Scan backward from the `>` position to find the `<elementName`
  for (let i = angleLine; i >= Math.max(0, angleLine - 20); i--) {
    const lineText = lines[i];
    // Find all `<elementName` patterns on this line
    const tagPattern = /<([a-zA-Z][\w:.-]*)/g;
    let lastMatch: RegExpExecArray | null = null;
    let m;

    while ((m = tagPattern.exec(lineText)) !== null) {
      // Skip comments
      if (lineText.substring(m.index, m.index + 4) === '<!--') continue;
      if (lineText.substring(m.index, m.index + 2) === '<?') continue;

      // On the angle line, the tag must open before the angle
      if (i === angleLine && m.index >= angleCol) continue;

      lastMatch = m;
    }

    if (lastMatch) {
      // Verify this tag is actually the one closed by our `>`, i.e., there's no other
      // unquoted `>` between this tag and our angle position
      const searchStart = lastMatch.index + lastMatch[0].length;
      if (i === angleLine) {
        // Check no earlier `>` on this line between tag and our `>`
        if (!hasUnquotedClosingAngle(lineText, searchStart, angleCol)) {
          return { name: lastMatch[1], tagStartLine: i };
        }
      } else {
        // The tag is on a previous line; check the rest of that line has no `>`
        if (!hasUnquotedClosingAngle(lineText, searchStart, lineText.length)) {
          return { name: lastMatch[1], tagStartLine: i };
        }
      }
    }
  }

  return undefined;
}

/**
 * Check whether a `</elementName>` closing tag appears between two positions in the text.
 *
 * @param lines - All lines of the XML document.
 * @param elementName - The element name to look for.
 * @param startLine - 0-based start line (inclusive).
 * @param startCol - 0-based start column on startLine.
 * @param endLine - 0-based end line (inclusive).
 * @param endCol - 0-based end column on endLine (exclusive).
 * @returns True if a closing tag for the element is found in the range.
 */
function hasClosingTagBetween(
  lines: string[],
  elementName: string,
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
): boolean {
  const closingPattern = new RegExp(`</${escapeRegex(elementName)}\\s*>`);

  for (let i = startLine; i <= endLine; i++) {
    const lineText = lines[i];
    const searchFrom = (i === startLine) ? startCol : 0;
    const searchTo = (i === endLine) ? endCol : lineText.length;
    const segment = lineText.substring(searchFrom, searchTo);

    if (closingPattern.test(segment)) return true;
  }

  return false;
}

/**
 * Find the column where a closing tag `</elementName` starts on the given line,
 * if it appears after the cursor column.
 *
 * Used to determine the end of the text content value range.
 *
 * @param lineText - The line text.
 * @param elementName - The element name to look for.
 * @param afterCol - Only find closing tags at or after this column.
 * @returns The column where `</` starts, or undefined if not found.
 */
function findClosingTagOnLine(
  lineText: string,
  elementName: string,
  _afterCol: number,
): number | undefined {
  const pattern = new RegExp(`</${escapeRegex(elementName)}\\s*>`);
  const match = pattern.exec(lineText);
  // Return the closing tag position if found on this line.
  // The caller (findEnclosingTextElement) already ensures the cursor is before any closing tag
  // via hasClosingTagBetween, so we don't need to filter by column here.
  return match ? match.index : undefined;
}

/**
 * Find the parent element of the tag starting at `tagStartLine`.
 *
 * Scans backward from just before the opening tag, using a depth counter to skip
 * over closed child elements and find the nearest unclosed ancestor.
 *
 * @param lines - All lines of the XML document.
 * @param tagStartLine - 0-based line where the current element's `<tagName` is.
 * @returns The parent element name, or undefined if at root level.
 */
function findParentElement(lines: string[], tagStartLine: number): string | undefined {
  // Scan backward from the line before the current element's opening tag.
  // Use a depth counter: `</tag>` decreases depth, `<tag` (not self-closing, not closing) increases.
  // The first element found at depth 0 is the parent.
  let depth = 0;

  for (let i = tagStartLine - 1; i >= Math.max(0, tagStartLine - 100); i--) {
    const lineText = lines[i];

    // Find all tag events on this line, collect them and process in reverse order
    const events = collectTagEvents(lineText);

    // Process in reverse order (right to left) since we're scanning backward
    for (let e = events.length - 1; e >= 0; e--) {
      const evt = events[e];
      if (evt.type === 'close') {
        // </tag> — increase depth (we need to skip over this closed element)
        depth++;
      } else if (evt.type === 'self-close') {
        // <tag .../> — doesn't affect depth
      } else if (evt.type === 'open') {
        // <tag ...> — decrease depth
        if (depth === 0) {
          // Found the parent element
          return evt.name;
        }
        depth--;
      }
    }
  }

  return undefined;
}

/**
 * A tag event found on a single line: an opening tag, a closing tag, or a self-closing tag.
 */
interface TagEvent {
  type: 'open' | 'close' | 'self-close';
  name: string;
  col: number;
}

/**
 * Collect all tag events (open, close, self-close) on a single line, in left-to-right order.
 *
 * Skips comments (`<!--`) and processing instructions (`<?`).
 *
 * @param lineText - The line text to scan.
 * @returns Array of tag events in the order they appear on the line.
 */
function collectTagEvents(lineText: string): TagEvent[] {
  const events: TagEvent[] = [];

  // Find closing tags: </tagName>
  const closePattern = /<\/([a-zA-Z][\w:.-]*)\s*>/g;
  let m;
  while ((m = closePattern.exec(lineText)) !== null) {
    events.push({ type: 'close', name: m[1], col: m.index });
  }

  // Find opening/self-closing tags: <tagName ... > or <tagName ... />
  // Instead of a single complex regex, find all `<tagName` occurrences and then
  // determine whether the tag is self-closing by checking for `/>` at the end.
  const openPattern = /<([a-zA-Z][\w:.-]*)\b/g;
  while ((m = openPattern.exec(lineText)) !== null) {
    // Skip if this is actually a closing tag (starts with </)
    if (lineText[m.index + 1] === '/') continue;
    // Skip comments
    if (lineText.substring(m.index, m.index + 4) === '<!--') continue;
    // Skip processing instructions
    if (lineText.substring(m.index, m.index + 2) === '<?') continue;

    // Find the closing > for this tag (respecting quotes)
    const closeAngle = findUnquotedChar(lineText, '>', m.index + m[0].length);
    if (closeAngle === -1) continue; // tag not closed on this line — skip

    // Check if it's self-closing: character before > is /
    const isSelfClose = closeAngle > 0 && lineText[closeAngle - 1] === '/';
    events.push({
      type: isSelfClose ? 'self-close' : 'open',
      name: m[1],
      col: m.index,
    });
  }

  // Sort by column position
  events.sort((a, b) => a.col - b.col);

  return events;
}

/**
 * Find the first occurrence of a character that is not inside a quoted string.
 *
 * @param lineText - The line text to search.
 * @param char - The character to find.
 * @param startCol - 0-based column to start searching from.
 * @returns The 0-based column of the character, or -1 if not found.
 */
function findUnquotedChar(lineText: string, char: string, startCol: number): number {
  let inQuote: string | null = null;
  for (let j = startCol; j < lineText.length; j++) {
    const ch = lineText[j];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === char) {
      return j;
    }
  }
  return -1;
}

/** Escape special regex characters so element names can be used in a RegExp safely. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
