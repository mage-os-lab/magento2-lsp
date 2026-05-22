# Cursor Setup

## Step 1 - Install the language server

```bash
npm install -g @mage-os/magento2-lsp
```

Or run it from Docker without installing Node - see [docker.md](docker.md).

## Step 2 - Install the extension

1. Open the Extensions panel (`Cmd+Shift+X`)
2. Search for **"Magento 2 LSP"**
3. Click Install

## Step 3 - Configure (optional)

By default the extension finds `magento2-lsp` on your `$PATH`. To use a custom path, open Cursor settings and add:

```json
{
  "magento2-lsp.binary.path": "/absolute/path/to/magento2-lsp"
}
```

## Settings

| Setting | Type | Description |
|---------|------|-------------|
| `templateDir` | `string` | Optional. Path to a directory with custom code action templates (absolute, or relative to the project root). Overrides `MAGENTO_LSP_TEMPLATES_DIR` env var and built-in defaults. When omitted, the env var or built-in templates are used. See [Code Actions](features.md#code-actions-quick-fixes) for template file details. |
| `hintMode` | `string` | Optional. `"codeLens"` (default) uses traditional code lenses; `"inlayHint"` delivers indicators as inlay hints inline after the symbol. Overrides `MAGENTO_LSP_HINT_MODE` env var. |
