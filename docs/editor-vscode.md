# VS Code / Cursor Setup

A minimal extension is included in `editors/vscode/`. It works with VS Code, Cursor, and other VS Code-based editors.

## Step 1 — Build the extension

```bash
cd editors/vscode
npm install
npm run build
```

## Step 2 — Install it

```bash
# Install the vsce tool if you don't have it
npm install -g @vscode/vsce

# Package and install
vsce package
code --install-extension magento2-lsp-0.0.1.vsix
```

Or during development, open the `editors/vscode/` folder in VS Code and press `F5` to launch an Extension Development Host.

## Step 3 — Configure (optional)

By default the extension finds `magento2-lsp` on your `$PATH`. To use a custom path, add to your VS Code settings:

```json
{
  "magento2-lsp.binary.path": "/absolute/path/to/magento2-lsp"
}
```
