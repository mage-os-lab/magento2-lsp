/**
 * Area-scoping helpers for Magento layout XML.
 *
 * Magento layout XML names (block/container names) are scoped by area:
 *   - `frontend` and `adminhtml` are independent scopes
 *   - `base` is a shared fallback that applies to both frontend and adminhtml
 *
 * When renaming or finding references for a layout name, results must be
 * filtered so that a rename in a frontend file only affects frontend + base
 * files (not adminhtml), and vice versa. A rename in a base file affects
 * all three areas.
 */

/**
 * Check whether a reference's area is compatible with the source file's area.
 *
 * Compatibility rules:
 *   - `base` is compatible with every area (it's the universal fallback)
 *   - Same area is always compatible
 *   - Unknown area (undefined) is treated as compatible (safe fallback)
 *   - Different non-base areas are NOT compatible (e.g., frontend ≠ adminhtml)
 */
export function isAreaCompatible(
  sourceArea: string | undefined,
  refArea: string | undefined,
): boolean {
  if (sourceArea === 'base' || refArea === 'base') return true;
  if (!sourceArea || !refArea) return true;
  return sourceArea === refArea;
}
