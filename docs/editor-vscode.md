# VS Code Setup

## Install the extension

Search "Magento 2 LSP" in the Extensions panel, or run:

```
code --install-extension mage-os.magento2-lsp
```

The extension requires the `magento2-lsp` binary on your `$PATH`. Install it with:

```bash
npm install -g @mage-os/magento2-lsp
```

Or run it from Docker without installing Node - see [docker.md](docker.md).

## Configure (optional)

To use a custom binary path instead of `$PATH` lookup, add to your VS Code settings:

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

<details>
<summary>Install extension from source</summary>

After cloning the repository:

```bash
cd editors/vscode
npm install
npm run build
```

Then either:
- Install the vsce tool (`npm install -g @vscode/vsce`), run `vsce package`, and `code --install-extension magento2-lsp-0.0.1.vsix`
- Or open the `editors/vscode/` folder in VS Code and press `F5` to launch an Extension Development Host

</details>
