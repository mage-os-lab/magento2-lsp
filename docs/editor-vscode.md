# VS Code / Cursor Setup

A minimal extension is included in `editors/vscode/`. It works with VS Code, Cursor, and other VS Code-based editors.

## Step 1 - Build the extension

After cloning the repository:

```bash
cd editors/vscode
npm install
npm run build
```

## Step 2 - Install it

```bash
# Install the vsce tool if you don't have it
npm install -g @vscode/vsce

# Package and install
vsce package
code --install-extension magento2-lsp-0.0.1.vsix
```

Or during development, open the `editors/vscode/` folder in VS Code and press `F5` to launch an Extension Development Host.

## Step 3 - Configure (optional)

By default the extension finds `magento2-lsp` on your `$PATH`. To use a custom path, add to your VS Code settings:

```json
{
  "magento2-lsp.binary.path": "/absolute/path/to/magento2-lsp"
}
```

## Settings

Server settings are passed via `initializationOptions`. To configure them, the VS Code extension would need to forward settings — this is not yet wired in the extension. In the meantime, you can use environment variables: `MAGENTO_LSP_TEMPLATES_DIR` for custom code action templates, and `MAGENTO_LSP_HINT_MODE` to switch between inlay hints and code lenses.

| Setting | Type | Description |
|---------|------|-------------|
| `templateDir` | `string` | Optional. Path to a directory with custom code action templates (absolute, or relative to the project root). Overrides `MAGENTO_LSP_TEMPLATES_DIR` env var and built-in defaults. When omitted, the env var or built-in templates are used. See [Code Actions](features.md#code-actions-quick-fixes) for template file details. |
| `hintMode` | `string` | Optional. `"codeLens"` (default) uses traditional code lenses; `"inlayHint"` delivers indicators as inlay hints inline after the symbol. Overrides `MAGENTO_LSP_HINT_MODE` env var. |
