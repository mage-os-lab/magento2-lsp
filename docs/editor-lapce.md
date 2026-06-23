# Lapce Setup

The Lapce plugin (volt) is maintained in a separate repository:
**[ProxiBlue/lapce-plugin-magento2-lsp](https://github.com/ProxiBlue/lapce-plugin-magento2-lsp)**

## Step 1 - Install the language server

```bash
npm install -g @mage-os/magento2-lsp
```

## Step 2 - Install the Lapce plugin

Open Lapce → Plugins panel (left sidebar) → search for **"Magento 2 LSP"** and click Install.

For manual install (GitHub release or from source), see the [plugin repository README](https://github.com/ProxiBlue/lapce-plugin-magento2-lsp#install).

The plugin activates automatically inside Magento 2 workspaces (detected via `app/etc/di.xml` or `app/etc/config.php`) and attaches to `*.php` and `*.xml` files. It is designed to run **alongside** a general PHP LSP (e.g. [lapce-php-intelephense](https://plugins.lapce.dev/plugins/dajoha/lapce-php-intelephense)) — Lapce supports multiple language servers per file.

## Settings

Edit Lapce's `settings.toml`:

```toml
[lapce-plugin-magento2-lsp]
"lsp.serverPath" = "/absolute/path/to/magento2-lsp"

[lapce-plugin-magento2-lsp.initialization-options]
templateDir = ".magento2-lsp/templates"
hintMode = "codeLens"
```

| Setting | Type | Description |
|---------|------|-------------|
| `lsp.serverPath` | `string` | Optional. Absolute path to the `magento2-lsp` binary. Defaults to `/usr/local/bin/magento2-lsp`. |
| `templateDir` | `string` | Optional. Path to a directory with custom code action templates (absolute, or relative to the project root). Overrides `MAGENTO_LSP_TEMPLATES_DIR` env var and built-in defaults. See [Code Actions](features.md#code-actions-quick-fixes) for template file details. |
| `hintMode` | `string` | Optional. `"codeLens"` (default) uses traditional code lenses for plugin/observer/webapi indicators; `"inlayHint"` delivers them as inlay hints inline after the symbol. Overrides `MAGENTO_LSP_HINT_MODE` env var. |

Lapce supports both code lenses and inlay hints. Inlay hints must be enabled in Lapce settings (`editor.inlay-hints = true`) to be visible.
