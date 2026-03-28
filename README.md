# magento2-lsp

Magento 2 tooling for editors and AI agents. This package includes two servers that share the same index and understanding of Magento's configuration system:

- **LSP server** - for your editor. Go-to-definition, find-references, diagnostics, and code lenses across XML and PHP.
- **MCP server** - for AI coding agents. Exposes merged Magento configuration that agents can't get by reading individual files.

Both are installed from the same repo but configured separately - the LSP in your editor, the MCP in your AI agent. They can be used together or independently.

## Rationale

Agents write the code, but you still review it - and jumping between XML and PHP with a keystroke beats grepping through config files. AI agents need the opposite: not navigation, but the *merged* result of Magento's multi-module configuration that no single file contains.

## LSP Server

Works alongside Intelephense or Phpactor - this LSP handles the Magento-specific connections that generic PHP tooling can't see.

- **Auto-complete as you type.** Context-aware completions for FQCNs, event names, config paths, ACL resource IDs, template identifiers, layout handles, block/container names, and DB table/column names across XML config files and PHP.

- **Navigate XML config like code.** Go-to-definition and find-references work across `di.xml`, `events.xml`, `system.xml`, and layout XML - linking them to the PHP classes, templates, and config paths they reference.

- **Trace the plugin chain.** See which plugins intercept a method, jump from a `beforeSave` plugin to the method it wraps, and see plugin counts directly in your editor via code lenses.

- **Follow config paths.** Jump from `scopeConfig->getValue('payment/account/active')` in PHP straight to the `<field>` declaration in `system.xml`, and find all PHP files using a config path.

- **Catch errors as you type.** Broken class references, missing templates, duplicate plugin names, and invalid model classes are flagged with diagnostics - no need to wait for a deploy to find out.

- **Understand template overrides.** Navigate between module templates, theme overrides, and Hyvä compatibility module overrides. Code lenses show override counts and sources at a glance.

- **Rename across config.** Rename a class, template, ACL resource, config path, or block/container name and have all XML references (and related PHP string literals) updated in one go. This covers the Magento-specific references that a PHP LSP can't see — actual PHP class names and files are left to Intelephense or Phpactor.

- **Resolve magic methods.** When Intelephense can't follow a method call because it goes through a DI preference or `__call` magic, this LSP resolves it to the concrete implementation.

For the complete feature list, see [docs/features.md](docs/features.md).

## MCP Server

Exposes the Magento 2 intelligence of the LSP server to AI coding agents. It doesn't add bloated tools, just what provides genuine value to current coding models.
See [docs/mcp.md](docs/mcp.md) for design rationale, tool descriptions, and installation instructions.

## Requirements

- Node.js >= 20

## Installation

```bash
git clone https://github.com/mage-os-lab/magento2-lsp.git
cd magento2-lsp
npm install
npm run build
```

Then add the `bin/` directory to your `$PATH`, or reference the binaries directly in your editor/agent config.

> npm registry publishing is planned for a future release.

## LSP Setup (Editor)

- [Neovim](docs/editor-neovim.md)
- [Zed](docs/editor-zed.md)
- [VS Code / Cursor](docs/editor-vscode.md)
- **Other editors** - any editor with LSP support can use this server: `magento2-lsp --stdio`
  Ask your LLM of choice for installation instructions. If it requires some special wrapper like VS Code or Zed do, please open an issue and let me know what is needed.

## MCP Setup (AI Agent)

See [docs/mcp.md](docs/mcp.md) for setup instructions covering Claude Code and other MCP-compatible agents.


## How It Works

On first file open, the LSP detects the Magento root, reads `app/etc/config.php` for active modules, and indexes all XML configuration files. Parse results are cached to `.magento2-lsp-cache.json` (add to `.gitignore`) for fast restarts. File watchers keep the index current as you edit.

Multiple Magento projects can be open simultaneously - each gets its own isolated index.

## Credits

Many thanks to [Hyvä](https://hyva.io) for sponsoring the development of this tool!

## License

Copyright (c) 2025 Vinai Kopp. Released under the [MIT License](LICENSE).

## Development

```bash
npm install
npm test           # run tests once
npm run test:watch # run tests in watch mode
npm run build      # compile TypeScript
```
