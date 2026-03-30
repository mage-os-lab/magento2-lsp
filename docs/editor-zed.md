# Zed Setup

Zed requires an extension to register custom language servers. A minimal extension is included in `editors/zed/`.

## Step 1 - Install the extension

Start by cloning the repository.

Zed compiles the extension from source, so [Rust](https://rustup.rs/) must be installed and `~/.cargo/bin` must be in your `$PATH`. If you don't want to add it to your PATH permanently, you can start Zed once from a terminal with Rust available:

```bash
source ~/.cargo/env && open -a Zed
```

Rust is only needed for this installation step - not for day-to-day use.

1. Open Zed's Command Palette (`Cmd+Shift+P`)
2. Run **"zed: install dev extension"**
3. Select the `editors/zed/` directory from this repository

## Step 2 - Configure Zed settings

Open your Zed settings with `Cmd+,` and add:

```json
{
  "lsp": {
    "magento2-lsp": {
      "binary": {
        "path": "/absolute/path/to/magento2-lsp",
        "arguments": ["--stdio"]
      }
    }
  },
  "languages": {
    "PHP": {
      "language_servers": ["magento2-lsp", "..."]
    },
    "XML": {
      "language_servers": ["magento2-lsp", "..."]
    }
  }
}
```

Replace `/absolute/path/to/magento2-lsp` with the path to the `magento2-lsp` binary (e.g. the result of `which magento2-lsp`, or a path into this repo like `/path/to/magento2-lsp/bin/magento2-lsp`). If `magento2-lsp` is already on your `$PATH`, the `lsp` section can be omitted - the extension will find it automatically.

The `"..."` keeps any other default servers enabled.

Go-to-definition, find-references, hover, and workspace symbol search all work out of the box. Plugin/observer/webapi indicators are delivered as **inlay hints** by default, which Zed supports natively.

## Inlay Hints

Zed does not enable [inlay hints](https://zed.dev/docs/reference/all-settings#inlay-hints) by default.

This can be configured globally or per language.
Per-language configuration is recommended so other languages are not affected:

```json
"languages": {
  "PHP": {
    "inlay_hints": {
      "enabled": true
    }
  }
}
```

## Settings

To configure server settings (e.g., custom code action templates), add `initialization_options` to the LSP config:

```json
{
  "lsp": {
    "magento2-lsp": {
      "binary": {
        "path": "/absolute/path/to/magento2-lsp",
        "arguments": ["--stdio"]
      },
      "initialization_options": {
        "templateDir": ".magento2-lsp/templates",
        "hintMode": "inlayHint"
      }
    }
  }
}
```

| Setting | Type | Description |
|---------|------|-------------|
| `templateDir` | `string` | Optional. Path to a directory with custom code action templates (absolute, or relative to the project root). Overrides `MAGENTO_LSP_TEMPLATES_DIR` env var and built-in defaults. When omitted, the env var or built-in templates are used. See [Code Actions](features.md#code-actions-quick-fixes) for template file details. |
| `hintMode` | `string` | Optional. Defaults to `"inlayHint"` for Zed (since Zed does not support code lenses — [zed-industries/zed#11565](https://github.com/zed-industries/zed/issues/11565)). Can be set to `"codeLens"` for other editors. Overrides `MAGENTO_LSP_HINT_MODE` env var. |
