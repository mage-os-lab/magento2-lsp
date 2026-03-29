# Segment Matching

The LSP uses a segment-boundary matching engine for PHP class and template auto-completion. This engine provides fast, intuitive matching without requiring you to type the full identifier.

## PHP Class Matching

PHP class queries are matched against pre-segmented FQCNs. The matcher splits both the query and the indexed class names at namespace separators (`\`) and camelCase boundaries.

### How It Works

1. The query is split at explicit `\` separators.
2. Each part is further split at camelCase boundaries (each uppercase letter starts a new segment).
3. Each query segment must match as a prefix of an entry segment, proceeding left-to-right.
4. Multiple query segments can match within the same namespace part by consuming consecutive portions of a camelCase word.

### Examples

| Query | Matches | Explanation |
|-------|---------|-------------|
| `CatModProd` | `Magento\Catalog\Model\Product` | `Cat`→Catalog, `Mod`→Model, `Prod`→Product |
| `HTVLLogo` | `Hyva\Theme\ViewModel\Logo\LogoPathResolver` | Single-letter prefixes: `H`→Hyva, `T`→Theme, `V`→ViewModel, `L`→Logo, `Logo`→LogoPathResolver |
| `HyvaThemeViewModel` | `Hyva\Theme\ViewModel\...` | `Hyva`→Hyva, `Theme`→Theme, `View`→view (within ViewModel), `Model`→model (within ViewModel) |
| `HTTP` | `Magento\Framework\HTTP\Client` | Consecutive matching: `H`→h, `T`→t, `T`→t, `P`→p within "http" |
| `Magento\Catalog\Model\Pro` | `Magento\Catalog\Model\Product` | Standard FQCN prefix typing |
| `\Magento\Catalog` | `Magento\Catalog\...` | Leading `\` is stripped |
| `Psr\Log` | `Psr\Log\LoggerInterface` | Matches non-Magento vendor classes too |

### Explicit Segment Termination

Typing a `\` after a query part forces that part to match a complete namespace segment. This is useful when a shorter name is a prefix of a longer one.

| Query | Matches | Does NOT Match |
|-------|---------|----------------|
| `View\` | `...\View\...` | `...\ViewModel\...` |
| `View` | Both `...\View\...` and `...\ViewModel\...` | — |

## Template Matching

Template queries use the format `Module::path`. The `::` separator splits the query into a module filter and a path filter.

### Module Matching

The module part (before `::`) uses the same camelCase segment matching as PHP classes, but with `_` as the primary separator (matching Magento's `Vendor_Module` format).

### Path Matching

The path part (after `::`) is split at `/`, `-`, and `_` boundaries. Each query part matches as a prefix of a path segment.

### Examples

| Query | Matches | Explanation |
|-------|---------|-------------|
| `list.phtml` | `*::*/list.phtml` | Path-only match across all modules in the current area |
| `Cat::` | `Magento_Catalog::*` | Module filter only: `Cat`→Catalog |
| `HyBa::` | `Hyva_BaseLayoutReset::*` | CamelCase module matching: `Hy`→Hyva, `Ba`→Base(LayoutReset) |
| `Cat::pro-attr` | `Magento_Catalog::catalog/product-attribute/example.phtml` | Module + path: `Cat`→Catalog, `pro`→product, `attr`→attribute |
| `product/view` | `*::product/view.phtml` | Path segments with `/` separator |
| `cart/item` | `Magento_Checkout::cart/item/default.phtml` | Matches nested path prefixes |

### Area Scoping

Template completions are scoped by the area of the file being edited:
- In **frontend** layout XML: only frontend and base templates are shown.
- In **adminhtml** layout XML: only adminhtml and base templates are shown.
- In **base** layout XML: only base templates are shown.

## Scope

The full symbol index includes:
- **All PHP classes** from `app/code/` and `vendor/` (derived from PSR-4 autoload mappings). Classes in `generated/code/` and `setup/` are excluded.
- **All .phtml templates** from module `view/{area}/templates/` directories and theme override directories (both `app/design/` and vendor themes).

The index is updated live as files are created, modified, or deleted.

## Matcher Interface

The segment-boundary matcher is behind a swappable `SymbolMatcher` interface. Alternative matching strategies (e.g., full fuzzy matching) can be plugged in without changing the index or completion infrastructure.
