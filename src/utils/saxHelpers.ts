/**
 * Shared helpers for SAX-based XML parsers.
 *
 * All four XML parsers in this project (di.xml, events.xml, layout XML, compat module)
 * use the `sax` library with the same configuration and the same patterns for error
 * recovery, case-insensitive attribute extraction, and xsi:type handling. This module
 * centralises those patterns so each parser can focus on its domain-specific logic.
 */

import * as sax from 'sax';

/**
 * Install a best-effort error handler on a SAX parser.
 *
 * Magento XML files are frequently malformed during editing (e.g., unclosed tags
 * while the user is typing). Rather than aborting the parse, we clear the error
 * and resume — this gives us partial results from the valid portion of the file.
 *
 * The `as unknown as Error` cast is required because sax's type declarations don't
 * allow setting `parser.error` to null, but the library checks for null internally.
 */
export function installErrorHandler(parser: sax.SAXParser): void {
  parser.onerror = () => {
    parser.error = null as unknown as Error;
    parser.resume();
  };
}

/**
 * Extract a case-insensitive attribute value from a SAX tag.
 *
 * XML attribute names are technically case-sensitive, but Magento modules occasionally
 * use inconsistent casing. This checks the lowercase name first, then uppercase.
 *
 * The sax library may return attribute values as plain strings or as `{value, ...}`
 * objects depending on the namespace mode — this handles both forms.
 *
 * Returns undefined if the attribute is missing or empty.
 */
export function getAttr(
  tag: sax.Tag | sax.QualifiedTag,
  name: string,
): string | undefined {
  const attr = tag.attributes[name] ?? tag.attributes[name.toUpperCase()];
  if (!attr) return undefined;
  const value = typeof attr === 'string' ? attr : attr.value;
  return value || undefined;
}

/**
 * Extract the xsi:type attribute value from a SAX tag, normalised to lowercase.
 *
 * The xsi:type attribute determines whether an <argument> or <item> contains a
 * class reference (xsi:type="object") or a scalar value (string, array, etc.).
 * Checks three common casing variants.
 */
export function getXsiType(
  tag: sax.Tag | sax.QualifiedTag,
): string | undefined {
  const attr =
    tag.attributes['xsi:type'] ??
    tag.attributes['XSI:TYPE'] ??
    tag.attributes['xsi:Type'];
  if (!attr) return undefined;
  const value = typeof attr === 'string' ? attr : attr.value;
  return value?.toLowerCase();
}
