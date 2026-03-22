# magento2-lsp

Language Server for navigating Magento 2 XML configuration and PHP classes. Works alongside Intelephense — this LSP handles Magento-specific navigation that Intelephense can't provide.

## Features

### di.xml Navigation

- **Go to Definition** from `di.xml`: jump from a class name to the PHP file, or from a virtualType reference to its `<virtualType>` declaration
- **Go to Definition** from a preference `for` attribute: jump directly to the effective implementation class (after config merging)
- **Find References** from `di.xml`: find all `di.xml` locations referencing a class (preferences, plugins, type declarations, constructor arguments, virtualTypes)
- **Find References** from PHP: cursor on a class/interface declaration shows all `di.xml` references, including those inherited from parent classes and interfaces

### Plugin (Interceptor) Navigation

- **Find References** from an intercepted method (e.g., `save()`): shows the plugin PHP methods (`beforeSave`, `afterSave`, etc.) and their `di.xml` `<plugin>` declarations
- **Find References** from a plugin method (e.g., `beforeSave`): shows the target class method it intercepts and the `di.xml` declaration
- **Code Lens** on target class declaration: shows `N plugins` count
- **Code Lens** on intercepted methods: shows `N plugins` count
- **Code Lens** on plugin `before`/`after`/`around` methods: shows `→ Target\Class::methodName`
- **Plugin inheritance**: plugins declared on an interface or parent class are correctly shown on all implementing/extending classes

### events.xml Navigation

- **Go to Definition** from observer `instance` attribute in `events.xml`: jump to the PHP observer class
- **Find References** from an event name in `events.xml`: shows all observers registered for that event across all modules and areas
- **Find References** from an observer `instance` in `events.xml`: shows all registrations for that observer class
- **Find References** from a PHP observer class declaration: includes `events.xml` registrations
- **Find References** from observer `execute()` method: shows the `events.xml` declarations
- **Code Lens** on observer `execute()` method: shows `→ event_name`


## Requirements

- Node.js >= 20

## Installation

```bash
npm install -g magento2-lsp
```

## Editor Setup

### Neovim

Add to the `servers` table in your LSP config (e.g., `init.lua`):

```lua
['magento2-lsp'] = {
  cmd = { 'magento2-lsp', '--stdio' },
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

To auto-refresh code lenses (plugin/observer indicators), add this in your `LspAttach` callback:

```lua
if client and client:supports_method('textDocument/codeLens', event.buf) then
  vim.api.nvim_create_autocmd({ 'BufEnter', 'CursorHold', 'InsertLeave' }, {
    buffer = event.buf,
    group = vim.api.nvim_create_augroup('lsp-codelens', { clear = false }),
    callback = function() vim.lsp.codelens.refresh({ bufnr = event.buf }) end,
  })
end
```

The LSP only activates when a Magento root is found (directory containing `app/etc/di.xml`).

### VS Code and Zed

A VS Code extension or Zed wrapper is not yet available. Contributions welcome.

### Other Editors

Any editor with LSP support can use this server. Start it with:

```bash
magento2-lsp --stdio
```

## How It Works

1. Detects the Magento project root by walking up from the opened file looking for `app/etc/di.xml`
2. Reads `app/etc/config.php` to determine active modules and their load order
3. Discovers all `di.xml` and `events.xml` files from active modules (vendor and app/code)
4. Parses each XML file and builds in-memory indexes mapping PHP class names to their XML locations
5. Builds a class hierarchy (extends/implements) to resolve inherited plugins
6. Builds a plugin method index by reading plugin PHP files for `before`/`after`/`around` methods
7. Caches the DI index to `.magento2-lsp-cache.json` in the project root (add to `.gitignore`)
8. Watches XML files for changes and re-indexes automatically

Multiple Magento projects can be open simultaneously — each gets its own isolated index.

## Development

```bash
npm install
npm test           # run tests once
npm run test:watch # run tests in watch mode
npm run build      # compile TypeScript
npm run watch      # compile in watch mode
```
