# magento2-lsp

Language Server for Magento 2 that makes XML configuration navigable. Jump between PHP classes and their `di.xml` wiring, trace plugins to their targets, follow config paths from PHP to `system.xml`, and catch broken references before they hit production.

Works alongside Intelephense — this LSP handles the Magento-specific connections that generic PHP tooling can't see.

## What it does

**Navigate XML config like code.** Go-to-definition and find-references work across `di.xml`, `events.xml`, `system.xml`, and layout XML — linking them to the PHP classes, templates, and config paths they reference.

**Trace the plugin chain.** See which plugins intercept a method, jump from a `beforeSave` plugin to the method it wraps, and see plugin counts directly in your editor via code lenses.

**Follow config paths.** Jump from `scopeConfig->getValue('payment/account/active')` in PHP straight to the `<field>` declaration in `system.xml`, and find all PHP files using a config path.

**Catch errors as you type.** Broken class references, missing templates, duplicate plugin names, and invalid model classes are flagged with diagnostics — no need to wait for a deploy to find out.

**Understand template overrides.** Navigate between module templates, theme overrides, and Hyvä compatibility module overrides. Code lenses show override counts and sources at a glance.

**Resolve magic methods.** When Intelephense can't follow a method call because it goes through a DI preference or `__call` magic, this LSP resolves it to the concrete implementation.

For the complete feature list, see [docs/features.md](docs/features.md).

## MCP Server for AI Coding Agents

An MCP server exposes the same Magento 2 intelligence to AI coding agents. See [docs/mcp.md](docs/mcp.md) for design rationale and tool descriptions.

## Requirements

- Node.js >= 20

## Installation

```bash
git clone https://github.com/mage-os/magento2-lsp.git
cd magento2-lsp
npm install
npm run build
```

Then add the `bin/` directory to your `$PATH`, or reference `bin/magento2-lsp` directly in your editor config.

> npm registry publishing is planned for a future release.

## Editor Setup

- [Neovim](docs/editor-neovim.md)
- [Zed](docs/editor-zed.md)
- [VS Code / Cursor](docs/editor-vscode.md)
- **Other editors** — any editor with LSP support can use this server: `magento2-lsp --stdio`  
  Ask your LLM of choice for installation instructions. if it requires some special wrapper like VS Code or Zed do, please open an issue and let me know what is needed.


## How It Works

On first file open, the LSP detects the Magento root, reads `app/etc/config.php` for active modules, and indexes all XML configuration files. Parse results are cached to `.magento2-lsp-cache.json` (add to `.gitignore`) for fast restarts. File watchers keep the index current as you edit.

Multiple Magento projects can be open simultaneously — each gets its own isolated index.

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
npm run watch      # compile in watch mode
```
