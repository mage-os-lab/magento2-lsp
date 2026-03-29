/**
 * LSP server settings, read from initializationOptions.
 *
 * Editors configure this differently:
 *   VS Code:  settings.json  "magento2-lsp.templateDir": "..."
 *   Neovim:   lspconfig      settings = { ["magento2-lsp"] = { templateDir = "..." } }
 *   Zed:      settings.json  "lsp": { "magento2-lsp": { "settings": { "templateDir": "..." } } }
 */

/** How display-only indicators (plugin counts, observer targets, etc.) are delivered. */
export type HintMode = 'codeLens' | 'inlayHint';

/** Which matching strategy to use for symbol completion. */
export type CompletionMatcherType = 'segment' | 'fuzzy';

export interface Magento2LspSettings {
  /** Absolute or project-relative path to custom code action templates. */
  templateDir?: string;

  /**
   * How to deliver display-only code indicators.
   *
   * - `'codeLens'` (default for most editors): use `textDocument/codeLens` — the
   *   traditional approach, shown as a separate line above the code.
   * - `'inlayHint'` (default for Zed): use `textDocument/inlayHint` — shown inline
   *   after the symbol. Used as default for Zed because it does not support code lenses.
   *
   * Resolution order:
   *   1. `initializationOptions.hintMode`
   *   2. `MAGENTO_LSP_HINT_MODE` environment variable
   *   3. Editor-specific default: `'inlayHint'` for Zed, `'codeLens'` for all others
   */
  hintMode?: HintMode;

  /**
   * Which matching strategy to use for symbol (class/template) completion.
   *
   * - `'segment'` (default): segment-boundary matching — treats the query as a series
   *   of segment prefixes. Fast and precise.
   * - `'fuzzy'`: hybrid fuzzy matching — subsequence matching with contiguity and
   *   boundary bonuses. More forgiving but slightly slower.
   *
   * Resolution order:
   *   1. `initializationOptions.completionMatcher`
   *   2. `MAGENTO_LSP_COMPLETION_MATCHER` environment variable
   *   3. Default: `'fuzzy'`
   */
  completionMatcher?: CompletionMatcherType;
}

const VALID_HINT_MODES: readonly string[] = ['codeLens', 'inlayHint'];
const VALID_COMPLETION_MATCHERS: readonly string[] = ['segment', 'fuzzy'];

let currentSettings: Magento2LspSettings = {};

/** Editor name from InitializeParams.clientInfo.name, set during onInitialize. */
let clientName: string | undefined;

export function getSettings(): Magento2LspSettings {
  return currentSettings;
}

export function updateSettings(settings: unknown): void {
  if (settings && typeof settings === 'object') {
    const s = settings as Record<string, unknown>;
    currentSettings = {
      templateDir: typeof s.templateDir === 'string' ? s.templateDir : undefined,
      hintMode: typeof s.hintMode === 'string' && VALID_HINT_MODES.includes(s.hintMode)
        ? (s.hintMode as HintMode)
        : undefined,
      completionMatcher: typeof s.completionMatcher === 'string' && VALID_COMPLETION_MATCHERS.includes(s.completionMatcher)
        ? (s.completionMatcher as CompletionMatcherType)
        : undefined,
    };
  }
}

/** Store the client (editor) name so we can pick an appropriate default hint mode. */
export function setClientName(name: string | undefined): void {
  clientName = name;
}

/** Returns the stored client name (mainly for testing). */
export function getClientName(): string | undefined {
  return clientName;
}

/**
 * Returns the effective hint mode, resolving the three-tier fallback:
 *   initializationOptions.hintMode > MAGENTO_LSP_HINT_MODE env var > editor-specific default
 *
 * The default is `'inlayHint'` for Zed (which doesn't support code lenses) and
 * `'codeLens'` for all other editors.
 */
export function getEffectiveHintMode(): HintMode {
  if (currentSettings.hintMode) return currentSettings.hintMode;

  const envValue = process.env.MAGENTO_LSP_HINT_MODE;
  if (envValue && VALID_HINT_MODES.includes(envValue)) return envValue as HintMode;

  // Zed doesn't support textDocument/codeLens, so default to inlayHint for it.
  return clientName?.toLowerCase() === 'zed' ? 'inlayHint' : 'codeLens';
}

/**
 * Returns the effective completion matcher, resolving the three-tier fallback:
 *   initializationOptions.completionMatcher > MAGENTO_LSP_COMPLETION_MATCHER env var > 'segment'
 */
export function getEffectiveCompletionMatcher(): CompletionMatcherType {
  if (currentSettings.completionMatcher) return currentSettings.completionMatcher;

  const envValue = process.env.MAGENTO_LSP_COMPLETION_MATCHER;
  if (envValue && VALID_COMPLETION_MATCHERS.includes(envValue)) return envValue as CompletionMatcherType;

  return 'fuzzy';
}
