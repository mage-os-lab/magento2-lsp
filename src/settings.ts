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
}

const VALID_HINT_MODES: readonly string[] = ['codeLens', 'inlayHint'];

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
