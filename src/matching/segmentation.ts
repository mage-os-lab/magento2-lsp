/**
 * Segmentation utilities for splitting PHP class names and template IDs into
 * lowercase segments at scan time. These pre-computed segments enable fast
 * matching during completion without re-splitting on every keystroke.
 *
 * Two types of identifiers are segmented:
 *
 * 1. PHP FQCNs like "Magento\Catalog\Model\Product" are split at namespace
 *    separators (\) and then at camelCase boundaries within each part.
 *
 * 2. Template IDs like "Magento_Catalog::product/view.phtml" are split at ::
 *    into a module part (segmented at _ and camelCase) and a path part
 *    (segmented at /, -, _).
 */

/**
 * Compute a bitmask of characters present in a string.
 *
 * Maps a-z to bits 0-25 and 0-9 to bits 26-35. Characters outside
 * these ranges are ignored. The input is lowercased before processing.
 *
 * Used for cheap pre-filtering in the fuzzy matcher: if the entry's
 * mask doesn't contain all bits from the query's mask, the entry
 * can't possibly match.
 *
 * @param str - Any string (FQCN, template ID, etc.).
 * @returns A 32-bit integer bitmask. Uses only bits 0-35, but since JS
 *   bitwise ops work on 32-bit signed ints, we use bitwise OR which
 *   wraps correctly for bits 0-31. Digits 6-9 (bits 32-35) overflow
 *   and alias with letters a-d (e.g. `1 << 32 === 1 << 0`), so
 *   queries containing those digits won't be rejected by the bitmask
 *   pre-filter even when they should be. Acceptable because digits
 *   are very rare in PHP class names and template IDs.
 */
export function computeCharMask(str: string): number {
  let mask = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 97 && code <= 122) {
      // a-z → bits 0-25
      mask |= 1 << (code - 97);
    } else if (code >= 65 && code <= 90) {
      // A-Z → bits 0-25 (same as lowercase)
      mask |= 1 << (code - 65);
    } else if (code >= 48 && code <= 57) {
      // 0-9 → bits 26-35 (bits 32+ overflow in 32-bit int, acceptable)
      mask |= 1 << (code - 48 + 26);
    }
  }
  return mask;
}

/**
 * Split a string at camelCase boundaries into lowercase parts.
 *
 * Rules:
 * - A transition from lowercase to uppercase starts a new segment.
 *   e.g. "viewModel" → ["view", "model"]
 * - A run of uppercase letters followed by a lowercase letter: the last
 *   uppercase groups with the lowercase.
 *   e.g. "HTMLParser" → ["html", "parser"]
 * - A single uppercase letter followed by lowercase starts a new segment.
 *   e.g. "Product" → ["product"]
 * - Numbers are kept with preceding letters.
 *   e.g. "Base64Encoder" → ["base64", "encoder"]
 *
 * @param str - A single identifier part (no namespace separators).
 * @returns Array of lowercase segments. Returns [""] for empty input.
 */
export function splitCamelCase(str: string): string[] {
  if (str.length === 0) return [''];

  const segments: string[] = [];
  let current = '';

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const isUpper = ch >= 'A' && ch <= 'Z';

    if (isUpper && current.length > 0) {
      // Look ahead: is this the start of a new camelCase word?
      const prevIsUpper = str[i - 1] >= 'A' && str[i - 1] <= 'Z';

      if (!prevIsUpper) {
        // Transition from lowercase/digit to uppercase → new segment
        // e.g. "view|Model", "base64|Encoder"
        segments.push(current.toLowerCase());
        current = ch;
      } else {
        // We're in a run of uppercase letters.
        // Check if the next char is lowercase — if so, this uppercase starts
        // a new segment (e.g. "HTM|L|Parser" → last L groups with "Parser").
        const nextIsLower = i + 1 < str.length
          && str[i + 1] >= 'a' && str[i + 1] <= 'z';
        if (nextIsLower) {
          segments.push(current.toLowerCase());
          current = ch;
        } else {
          current += ch;
        }
      }
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
 * Split a PHP FQCN into nested segments for matching.
 *
 * Each namespace part becomes an array of camelCase words (lowercase).
 * The outer array follows namespace order.
 *
 * @example
 * segmentizeFqcn("Magento\\Catalog\\Model\\Product")
 * // → [["magento"], ["catalog"], ["model"], ["product"]]
 *
 * @example
 * segmentizeFqcn("Hyva\\Theme\\ViewModel\\Logo\\LogoPathResolver")
 * // → [["hyva"], ["theme"], ["view", "model"], ["logo"], ["logo", "path", "resolver"]]
 *
 * @param fqcn - A fully-qualified PHP class name. Leading \ is stripped.
 * @returns Array of namespace parts, each split into lowercase camelCase segments.
 */
export function segmentizeFqcn(fqcn: string): string[][] {
  // Strip leading backslash if present
  const normalized = fqcn.startsWith('\\') ? fqcn.slice(1) : fqcn;

  if (normalized.length === 0) return [];

  const namespaceParts = normalized.split('\\');
  return namespaceParts.map(splitCamelCase);
}

/**
 * Result of segmenting a template ID.
 */
export interface TemplateSegments {
  /** Module name segments, e.g. [["magento"], ["catalog"]] for "Magento_Catalog". */
  moduleSegments: string[][];
  /** Path segments split at /, -, _ boundaries, e.g. ["product", "view.phtml"]. */
  pathSegments: string[];
}

/**
 * Split a Magento template ID into module and path segments for matching.
 *
 * Template IDs have the format "Module_Name::path/to/template.phtml".
 * The module part is split at "_" and then camelCase boundaries.
 * The path part is split at "/", "-", and "_" boundaries.
 *
 * @example
 * segmentizeTemplateId("Magento_Catalog::product/view.phtml")
 * // → { moduleSegments: [["magento"], ["catalog"]], pathSegments: ["product", "view.phtml"] }
 *
 * @example
 * segmentizeTemplateId("Hyva_BaseLayoutReset::catalog/product-attribute/example.phtml")
 * // → {
 * //     moduleSegments: [["hyva"], ["base", "layout", "reset"]],
 * //     pathSegments: ["catalog", "product", "attribute", "example.phtml"]
 * //   }
 *
 * @param templateId - A Magento template identifier in Module_Name::path format.
 * @returns The segmented module and path parts.
 */
export function segmentizeTemplateId(templateId: string): TemplateSegments {
  const separatorIndex = templateId.indexOf('::');

  if (separatorIndex === -1) {
    // No module prefix — treat entire string as path
    return {
      moduleSegments: [],
      pathSegments: splitTemplatePath(templateId),
    };
  }

  const modulePart = templateId.slice(0, separatorIndex);
  const pathPart = templateId.slice(separatorIndex + 2);

  return {
    moduleSegments: segmentizeModuleName(modulePart),
    pathSegments: splitTemplatePath(pathPart),
  };
}

/**
 * Split a Magento module name (e.g. "Magento_Catalog") into segments.
 *
 * First splits at "_", then applies camelCase splitting to each part.
 * All segments are lowercase.
 *
 * @param moduleName - Module name in Vendor_Module format.
 * @returns Array of segment groups, one per underscore-separated part.
 */
export function segmentizeModuleName(moduleName: string): string[][] {
  if (moduleName.length === 0) return [];
  const parts = moduleName.split('_');
  return parts.map(splitCamelCase);
}

/**
 * Split a template path at /, -, and _ boundaries into lowercase segments.
 *
 * @param pathStr - The path portion of a template ID (after ::).
 * @returns Array of lowercase path segments.
 */
function splitTemplatePath(pathStr: string): string[] {
  if (pathStr.length === 0) return [];
  return pathStr.split(/[/\-_]/).filter(s => s.length > 0).map(s => s.toLowerCase());
}
