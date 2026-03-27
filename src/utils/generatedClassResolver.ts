/**
 * Magento 2 auto-generated class resolution.
 *
 * Magento generates wrapper classes at runtime for dependency injection, lazy
 * loading, interception (plugins), extension attributes, and more.  These
 * classes follow deterministic naming conventions — a suffix appended directly
 * to the class name (e.g. `FooFactory`) or as a sub-namespace (e.g.
 * `Foo\Proxy`).
 *
 * This module is the **single source of truth** for those naming conventions,
 * used by:
 *   - Rename handler:  when renaming a base FQCN, all generated variants must
 *     be found and renamed with the suffix preserved.
 *   - Validation:  a class reference like `FooFactory` should not be flagged as
 *     "class not found" if the base class `Foo` exists.
 *   - Magic-method index:  `FooFactory::create()` returns `Foo`.
 *
 * The 14 generator types are registered in Magento's `app/etc/di.xml` under
 * `Magento\Framework\Code\Generator`.  The entity-type name (ucfirst'd) is the
 * suffix.  Generator.php resolves source class → generated class by stripping
 * that suffix and rtrimming the backslash.
 *
 * Special cases — Extension attribute types:
 *   - `FooExtensionInterface` is generated from `FooInterface`
 *   - `FooExtension`          is generated from `FooInterface`
 *   - `FooExtensionInterfaceFactory` is a Factory for `FooExtensionInterface`,
 *     which itself is generated from `FooInterface`
 */

// ---------------------------------------------------------------------------
// Suffix definitions — ordered longest-first to avoid partial matches
// (e.g. "ExtensionInterfaceFactory" must be tried before "Factory").
// ---------------------------------------------------------------------------

/** A single generated class suffix and how to resolve the base FQCN. */
interface GeneratedSuffix {
  /** The literal string appended to the FQCN (including leading backslash for sub-namespaces). */
  readonly suffix: string;
  /**
   * Derive the source FQCN after the suffix has been stripped.
   * Most types simply return `stripped` unchanged; Extension types apply an
   * additional Interface transform.
   */
  readonly resolveBase: (stripped: string) => string;
}

/**
 * All 14 Magento generated class suffixes.
 *
 * Order matters: longer suffixes first so `endsWith` checks don't match a
 * shorter suffix prematurely (e.g. `ExtensionInterface` before `Extension`,
 * `\\ProxyDeferred` before `\\Proxy`).
 */
const GENERATED_SUFFIXES: readonly GeneratedSuffix[] = [
  // --- Extension-attribute chain (special base resolution) ---
  // ExtensionInterfaceFactory is a Factory for an ExtensionInterface, so
  // stripping the suffix gives us the ExtensionInterface FQCN — which itself
  // is generated.  resolveBase here only strips one level (the Factory part).
  // Callers that need the ultimate base should use resolveSourceFqcn() which
  // applies resolution recursively.
  { suffix: 'ExtensionInterfaceFactory', resolveBase: (s) => s + 'ExtensionInterface' },
  { suffix: 'ExtensionInterface',        resolveBase: (s) => s + 'Interface' },
  { suffix: 'Extension',                 resolveBase: (s) => s + 'Interface' },

  // --- Sub-namespace types (longest first) ---
  { suffix: '\\ProxyDeferred', resolveBase: identity },
  { suffix: '\\Interceptor',   resolveBase: identity },
  { suffix: '\\Proxy',         resolveBase: identity },
  { suffix: '\\Logger',        resolveBase: identity },

  // --- Simple suffix types ---
  { suffix: 'SearchResults', resolveBase: identity },
  { suffix: 'Repository',   resolveBase: identity },
  { suffix: 'Persistor',    resolveBase: identity },
  { suffix: 'Converter',    resolveBase: identity },
  { suffix: 'Factory',      resolveBase: identity },
  { suffix: 'Mapper',       resolveBase: identity },
  { suffix: 'Remote',       resolveBase: identity },
];

function identity(s: string): string { return s; }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Result of a single-level suffix strip. */
export interface GeneratedClassResolution {
  /** The suffix entry that matched. */
  suffix: string;
  /** The resolved source FQCN (after suffix-specific transform). */
  baseFqcn: string;
}

/**
 * Strip one generated suffix from `fqcn` and return the source FQCN.
 * Returns `undefined` if the FQCN doesn't end with any known suffix.
 *
 * This is a **single-level** strip.  For compound types like
 * `FooExtensionInterfaceFactory`, it strips `Factory` and returns
 * `FooExtensionInterface`.  Use {@link resolveSourceFqcn} for full recursive
 * resolution.
 *
 * @example
 *   stripGeneratedSuffix('Magento\\Catalog\\Model\\ProductFactory')
 *   // → { suffix: 'Factory', baseFqcn: 'Magento\\Catalog\\Model\\Product' }
 *
 *   stripGeneratedSuffix('Magento\\Catalog\\Model\\Product\\Proxy')
 *   // → { suffix: '\\Proxy', baseFqcn: 'Magento\\Catalog\\Model\\Product' }
 *
 *   stripGeneratedSuffix('Magento\\Catalog\\Api\\Data\\ProductExtensionInterface')
 *   // → { suffix: 'ExtensionInterface', baseFqcn: 'Magento\\Catalog\\Api\\Data\\ProductInterface' }
 */
export function stripGeneratedSuffix(fqcn: string): GeneratedClassResolution | undefined {
  for (const entry of GENERATED_SUFFIXES) {
    if (fqcn.endsWith(entry.suffix)) {
      const stripped = fqcn.slice(0, -entry.suffix.length);
      return { suffix: entry.suffix, baseFqcn: entry.resolveBase(stripped) };
    }
  }
  return undefined;
}

/**
 * Recursively strip generated suffixes until a non-generated FQCN remains.
 * Returns `undefined` if the input is not generated at all.
 *
 * Handles compound types:
 *   `FooExtensionInterfaceFactory` → `FooExtensionInterface` → `FooInterface`
 *
 * @example
 *   resolveSourceFqcn('Magento\\Catalog\\Api\\Data\\ProductExtensionInterfaceFactory')
 *   // → 'Magento\\Catalog\\Api\\Data\\ProductInterface'
 *
 *   resolveSourceFqcn('Magento\\Catalog\\Model\\Product')
 *   // → undefined (not generated)
 */
export function resolveSourceFqcn(fqcn: string): string | undefined {
  let current = fqcn;
  let resolved = false;
  // Guard against infinite loops (max depth matches the deepest known chain: 2)
  for (let i = 0; i < 5; i++) {
    const result = stripGeneratedSuffix(current);
    if (!result) break;
    current = result.baseFqcn;
    resolved = true;
  }
  return resolved ? current : undefined;
}

/** A generated variant of a base FQCN, with the mapping to compute a new name after rename. */
export interface GeneratedVariant {
  /** The full generated FQCN. */
  generatedFqcn: string;
  /** The suffix that was appended. */
  suffix: string;
  /** Compute the new generated FQCN after renaming the base. */
  buildNewFqcn: (newBaseFqcn: string) => string;
}

/**
 * Given a base FQCN, return all plausible generated variants.
 *
 * Used by the rename handler to find and rename all generated references
 * when the base class is renamed.  Most variants will have zero index hits
 * in practice — the caller queries each one and discards misses.
 *
 * Extension variants (ExtensionInterface, Extension, ExtensionInterfaceFactory)
 * are only generated when the base ends with `Interface`.
 *
 * @example
 *   // For a non-Interface class:
 *   generatedVariants('Magento\\Catalog\\Model\\Product')
 *   // → [ { generatedFqcn: 'Magento\\Catalog\\Model\\Product\\Proxy', ... },
 *   //     { generatedFqcn: 'Magento\\Catalog\\Model\\ProductFactory', ... },
 *   //     ... (all simple suffixes) ]
 *
 *   // For an Interface class:
 *   generatedVariants('Magento\\Catalog\\Api\\Data\\ProductInterface')
 *   // → [ ...simple suffixes...,
 *   //     { generatedFqcn: 'Magento\\Catalog\\Api\\Data\\ProductExtensionInterface', ... },
 *   //     { generatedFqcn: 'Magento\\Catalog\\Api\\Data\\ProductExtension', ... },
 *   //     { generatedFqcn: 'Magento\\Catalog\\Api\\Data\\ProductExtensionInterfaceFactory', ... } ]
 */
export function generatedVariants(baseFqcn: string): GeneratedVariant[] {
  const variants: GeneratedVariant[] = [];
  const isInterface = baseFqcn.endsWith('Interface');

  for (const entry of GENERATED_SUFFIXES) {
    // Extension types only apply to Interface classes
    if (isExtensionSuffix(entry.suffix) && !isInterface) continue;

    const generatedFqcn = buildGeneratedFqcn(baseFqcn, entry.suffix);
    variants.push({
      generatedFqcn,
      suffix: entry.suffix,
      buildNewFqcn: (newBase) => buildGeneratedFqcn(newBase, entry.suffix),
    });
  }

  return variants;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extension-attribute suffixes require special FQCN construction. */
function isExtensionSuffix(suffix: string): boolean {
  return suffix === 'ExtensionInterface'
    || suffix === 'Extension'
    || suffix === 'ExtensionInterfaceFactory';
}

/**
 * Construct a generated FQCN from a base FQCN and a suffix.
 *
 * For simple suffixes, this is just `base + suffix`.
 * For extension types, the `Interface` suffix on the base is replaced:
 *   ProductInterface + ExtensionInterface → ProductExtensionInterface
 *   ProductInterface + Extension          → ProductExtension
 *   ProductInterface + ExtensionInterfaceFactory → ProductExtensionInterfaceFactory
 */
function buildGeneratedFqcn(baseFqcn: string, suffix: string): string {
  if (isExtensionSuffix(suffix) && baseFqcn.endsWith('Interface')) {
    // Strip 'Interface' from base, then append the extension suffix
    const stem = baseFqcn.slice(0, -'Interface'.length);
    return stem + suffix;
  }
  return baseFqcn + suffix;
}
