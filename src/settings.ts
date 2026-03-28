/**
 * LSP server settings, read from initializationOptions.
 *
 * Editors configure this differently:
 *   VS Code:  settings.json  "magento2-lsp.templateDir": "..."
 *   Neovim:   lspconfig      settings = { ["magento2-lsp"] = { templateDir = "..." } }
 *   Zed:      settings.json  "lsp": { "magento2-lsp": { "settings": { "templateDir": "..." } } }
 */

export interface Magento2LspSettings {
  /** Absolute or project-relative path to custom code action templates. */
  templateDir?: string;
}

let currentSettings: Magento2LspSettings = {};

export function getSettings(): Magento2LspSettings {
  return currentSettings;
}

export function updateSettings(settings: unknown): void {
  if (settings && typeof settings === 'object') {
    const s = settings as Record<string, unknown>;
    currentSettings = {
      templateDir: typeof s.templateDir === 'string' ? s.templateDir : undefined,
    };
  }
}
