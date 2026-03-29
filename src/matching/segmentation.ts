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
