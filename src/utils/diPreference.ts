/**
 * DI preference resolution helpers for PHP type resolution.
 *
 * When Magento code declares a variable typed as an interface (e.g., StorageInterface),
 * the actual runtime class is determined by di.xml `<preference>` declarations.
 * Preferences are area-scoped, so a frontend preference overrides global, etc.
 *
 * This module provides:
 *   - A standard area fallback order for resolving preferences
 *   - The CALL_RE regex for matching PHP method calls in source code
 *
 * Both the "go to definition" and "code lens" handlers need to resolve interfaces
 * to their concrete implementations using the same fallback logic.
 */

/**
 * Minimal interface for the DiIndex preference lookup.
 * Avoids importing the full DiIndex type into handler-level utilities.
 */
interface PreferenceLookup {
  getEffectivePreferenceType(
    fqcn: string,
    area: string,
  ): { fqcn: string } | undefined;
}

/**
 * Resolve an interface/abstract FQCN to its concrete implementation via DI preferences.
 *
 * Checks preferences in area priority order: frontend → adminhtml → global.
 * This matches Magento's runtime behaviour where area-specific preferences override
 * global ones. We check frontend first because most LSP navigation happens in
 * frontend context (themes, blocks, templates).
 *
 * Returns the original FQCN if no preference is declared.
 */
export function resolveConcreteType(
  fqcn: string,
  index: PreferenceLookup,
): string {
  const prefRef =
    index.getEffectivePreferenceType(fqcn, 'frontend') ??
    index.getEffectivePreferenceType(fqcn, 'adminhtml') ??
    index.getEffectivePreferenceType(fqcn, 'global');
  return prefRef ? prefRef.fqcn : fqcn;
}

/**
 * Regex matching PHP method calls on object expressions.
 *
 * Captures:
 *   Group 1: the object expression — "$var", "$this->prop", "$this->a->b"
 *   Group 2: the method name being called
 *
 * Examples:
 *   "$this->storage->getData("  → ["$this->storage", "getData"]
 *   "$product->getName("        → ["$product", "getName"]
 *
 * The `g` flag enables iterative matching via CALL_RE.exec() in a while loop.
 * Callers must reset `CALL_RE.lastIndex = 0` before scanning each new line.
 */
export const CALL_RE = /(\$[\w]+(?:->[\w]+)*)->([\w]+)\s*\(/g;
