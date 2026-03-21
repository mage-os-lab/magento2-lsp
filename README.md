# magento-di-lsp

Language Server for navigating between PHP classes and Magento 2 `di.xml` declarations. Works alongside Intelephense — this LSP only handles DI-specific navigation.

## Features

- **Go to Definition** from `di.xml`: jump from a class name to the PHP file, or from a virtualType reference to its `<virtualType>` declaration
- **Find References** from `di.xml`: find all `di.xml` locations referencing a class (preferences, plugins, type declarations, constructor arguments, virtualTypes)
- **Find References** from PHP: place cursor on a class/interface declaration and find all `di.xml` references to it

Supports all DI scopes: global, frontend, adminhtml, webapi_rest, webapi_soap, graphql, crontab.

Handles config merging: when multiple modules declare the same preference or plugin, the effective one is determined by module load order (`config.php`) and scope (scoped overrides global).

## Requirements

- Node.js >= 20
- A Magento 2 project with `app/etc/di.xml` and `app/etc/config.php`

## Installation

```bash
npm install -g magento-di-lsp
```

Or install from the repository:

```bash
git clone <repo-url> magento-di-lsp
cd magento-di-lsp
npm install
npm run build
npm install -g .
```

## Editor Setup

### Neovim

Add to the `servers` table in your LSP config (e.g., `init.lua`):

```lua
['magento-di-lsp'] = {
  cmd = { 'magento-di-lsp', '--stdio' },
  filetypes = { 'php', 'xml' },
  root_dir = function(bufnr, on_dir)
    local path = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(bufnr), ':p:h')
    while path and path ~= '/' do
      if vim.uv.fs_stat(path .. '/app/etc/di.xml') then
        on_dir(path)
        return
      end
      path = vim.fn.fnamemodify(path, ':h')
    end
  end,
},
```

Then register it with `vim.lsp.config()` and `vim.lsp.enable()` as you do for other servers.

The LSP only activates when a Magento root is found (directory containing `app/etc/di.xml`).

### VS Code

A VS Code extension wrapper is not yet available. Contributions welcome.

### Other Editors

Any editor with LSP support can use this server. Start it with:

```bash
magento-di-lsp --stdio
```

## How It Works

1. Detects the Magento project root by walking up from the opened file looking for `app/etc/di.xml`
2. Reads `app/etc/config.php` to determine active modules and their load order
3. Discovers all `di.xml` files from active modules (vendor and app/code)
4. Parses each `di.xml` and builds an in-memory index mapping PHP class names to their `di.xml` locations
5. Caches the index to `.magento-di-lsp-cache.json` in the project root (add to `.gitignore`)
6. Watches `di.xml` files for changes and re-indexes automatically

Multiple Magento projects can be open simultaneously — each gets its own isolated index.

## Development

```bash
npm install
npm test           # run tests once
npm run test:watch # run tests in watch mode
npm run build      # compile TypeScript
npm run watch      # compile in watch mode
```
