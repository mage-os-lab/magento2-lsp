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

### Layout XML Navigation

- **Go to Definition** from a `class` attribute on `<block>` elements: jump to the PHP class file
- **Go to Definition** from `<argument xsi:type="object">` values (ViewModels, etc.): jump to the PHP class file
- **Go to Definition** from a `template` attribute on `<block>` or `<referenceBlock>`: jump to the `.phtml` file, resolved through the theme fallback hierarchy
- **Go to Definition** from `<update handle="..."/>`: jump to the layout XML files that define that handle (including Hyvä `hyva_` prefixed variants), filtered by area and theme fallback chain
- **Find References** from a class name in layout XML: shows all layout XML and `di.xml` locations referencing that class
- **Find References** from a template identifier in layout XML: shows all layout XML files using that template
- **Find References** from a PHP class declaration: includes layout XML references (block classes and object arguments)
- **Find References** from a `.phtml` template file: shows all layout XML files that reference the template
- **Template resolution** follows Magento's full fallback chain: current theme → parent themes → module area-specific (`view/frontend/templates/`) → module base (`view/base/templates/`)
- **Short template paths** (e.g., `product/view.phtml` without a module prefix) are automatically resolved using the enclosing block's class to infer the module name

### Template Override Navigation

- **Code Lens** on module templates (e.g., `vendor/magento/module-catalog/view/frontend/templates/category/products.phtml`): shows `overridden in N themes` when theme overrides exist
- **Code Lens** on theme override templates (e.g., `app/design/frontend/Hyva/default/Magento_Catalog/templates/category/products.phtml`): shows `overrides Magento_Catalog::category/products.phtml`
- **Go to Definition** from a theme override template: jump to the original module template
- **Find References** from a module template: shows layout XML usages and all theme override files
- **Find References** from a theme override template: shows layout XML usages, the original module template, and other theme overrides

### PHP Navigation (Magic Methods)

- **Go to Definition** from a method call on a typed variable: when the method isn't declared on the variable's type but exists on the concrete class (resolved via DI preference), jumps to the method on the concrete class. For example, `$this->storage->getData()` where `StorageInterface` has no `getData()` but the DI preference `Storage extends DataObject` does.
- **Go to Definition** for methods resolved via `__call` or `@method` PHPDoc annotations
- **Code Lens** on magic method calls: shows `→ ClassName::methodName` (or `→ ClassName::__call` for `__call`-dispatched methods)
- Walks ancestor chains (parent classes, interfaces, traits) and resolves return types through method call chains

### system.xml / Config Path Navigation

- **Go to Definition** from `source_model`, `backend_model`, or `frontend_model` in `system.xml`: jump to the PHP class
- **Go to Definition** from PHP `scopeConfig->getValue('section/group/field')` or `isSetFlag(...)`: jump to the `<field>` declaration in `system.xml`
- **Find References** from a `<field>` in `system.xml`: shows all system.xml declarations for that config path across modules, plus all PHP files referencing the config path string
- **Find References** from a `source_model`/`backend_model`/`frontend_model` FQCN in `system.xml`: shows all system.xml and di.xml references to that class
- **Find References** from a PHP class declaration: includes system.xml model references
- **Find References** from a PHP config path string: shows system.xml field declarations and PHP usages
- **Hover** on `<section>`, `<group>`, `<field>` IDs: shows the config path, label, and module name
- **Hover** on model FQCNs: shows the model type, parent config path, and class name
- **Include partials** (e.g., `etc/adminhtml/system/*.xml`) are parsed and indexed — hover indicates partial paths with `…/` prefix
- **Nested groups** are fully supported (config paths can have 4+ segments)
- **Semantic validation**: error diagnostics for broken `source_model`, `backend_model`, and `frontend_model` class references

### Semantic Diagnostics

- **Broken class references** in `di.xml`, `events.xml`, and layout XML: error when a FQCN doesn't resolve to a PHP file via PSR-4 (virtual types, generated classes like `\Proxy` and `Factory`, and uninstalled vendor namespaces are excluded)
- **Broken template references** in layout XML: warning when a `Module_Name::path/to/template.phtml` identifier doesn't resolve to any `.phtml` file through module or theme paths
- **Duplicate plugin names**: warning when a `<plugin name="...">` duplicates a name already declared for the same target type, either in the same file or across modules
- **Missing ObserverInterface**: warning when an observer `instance` class exists but doesn't implement `Magento\Framework\Event\ObserverInterface`
- **Broken model references** in `system.xml`: error when a `source_model`, `backend_model`, or `frontend_model` FQCN doesn't resolve to a PHP file

Diagnostics update on every keystroke (debounced). Expensive checks (duplicate plugins, ObserverInterface) also run on file open and save.

### XSD Validation and URN Navigation

- **XML Validation** against declared XSD schemas: diagnostics are published on file open, save, and edit (requires `xmllint` on `$PATH`)
- **Go to Definition** from XSD URN references in XML and XSD files: jump to the resolved `.xsd` file (e.g., `urn:magento:framework:ObjectManager/etc/config.xsd` → the actual XSD file)

### Hover Information

- **Hover** on class names in `di.xml`: shows effective DI config summary (preferences, plugins, virtual types)
- **Hover** on event names in `events.xml`: shows observer count and registrations
- **Hover** on observer `instance` in `events.xml`: shows which events the observer handles
- **Hover** on class and template references in layout XML: shows block class info and template resolution paths
- **Hover** on `system.xml` elements: shows config path, label, module, and model class info

### Workspace Symbol Search

- **Workspace Symbol** search (e.g., `Ctrl+T` in VS Code, `:Telescope lsp_workspace_symbols` in Neovim): find DI preferences, plugins, virtual types, and event observers across all indexed projects

### Hyvä Compatibility Module Override Navigation

Supports [automatic template overrides](https://docs.hyva.io/hyva-themes/compatibility-modules/technical-deep-dive.html#automatic-template-overrides) from Hyvä compatibility modules (requires `hyva-themes/magento2-compat-module-fallback`). Compat module registrations are discovered from `etc/frontend/di.xml` files.

- **Code Lens** on module templates: shows `overridden in Hyvä compat module Hyva_Catalog` when a compat module provides an override (shown as a separate lens alongside theme override lenses)
- **Code Lens** on compat module override templates: shows `Hyvä compat override: Magento_Catalog::category/products.phtml`
- **Go to Definition** from a compat module override template: jump to the original module template
- **Find References** from a module template: includes compat module override files alongside theme overrides
- **Find References** from a compat module override: shows the original module template, layout XML usages, and other overrides


## MCP Server for AI Coding Agents

This project also includes an MCP (Model Context Protocol) server that exposes the same Magento 2 intelligence to AI coding agents. See [README_MCP.md](README_MCP.md) for details.

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

### Zed

Zed requires an extension to register custom language servers. A minimal extension is included in `editors/zed/`.

**Step 1 — Install the extension:**

Zed compiles the extension from source, so [Rust](https://rustup.rs/) must be installed and `~/.cargo/bin` must be in your `$PATH`. If you don't want to add it to your PATH permanently, you can start Zed once from a terminal with Rust available:

```bash
source ~/.cargo/env && open -a Zed
```

Rust is only needed for this installation step — not for day-to-day use.

1. Open Zed's Command Palette (`Cmd+Shift+P`)
2. Run **"zed: install dev extension"**
3. Select the `editors/zed/` directory from this repository

**Step 2 — Configure Zed settings:**

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

Replace `/absolute/path/to/magento2-lsp` with the path to the `magento2-lsp` binary (e.g. the result of `which magento2-lsp`, or a path into this repo like `/path/to/magento2-lsp/bin/magento2-lsp`). If `magento2-lsp` is already on your `$PATH`, the `lsp` section can be omitted — the extension will find it automatically.

The `"..."` keeps any other default servers enabled.

Go-to-definition, find-references, hover, and workspace symbol search all work out of the box. Code lenses are [not yet supported by Zed](https://github.com/zed-industries/zed/issues/11565).

### VS Code / Cursor

A minimal extension is included in `editors/vscode/`. It works with VS Code, Cursor, and other VS Code-based editors.

**Step 1 — Build the extension:**

```bash
cd editors/vscode
npm install
npm run build
```

**Step 2 — Install it:**

```bash
# Install the vsce tool if you don't have it
npm install -g @vscode/vsce

# Package and install
vsce package
code --install-extension magento2-lsp-0.0.1.vsix
```

Or during development, open the `editors/vscode/` folder in VS Code and press `F5` to launch an Extension Development Host.

**Step 3 — Configure (optional):**

By default the extension finds `magento2-lsp` on your `$PATH`. To use a custom path, add to your VS Code settings:

```json
{
  "magento2-lsp.binary.path": "/absolute/path/to/magento2-lsp"
}
```

### Other Editors

Any editor with LSP support can use this server. Start it with:

```bash
magento2-lsp --stdio
```

## How It Works

1. Detects the Magento project root by walking up from the opened file looking for `app/etc/di.xml`
2. Reads `app/etc/config.php` to determine active modules and their load order
3. Discovers all `di.xml`, `events.xml`, `system.xml` (including include partials), and layout XML files from active modules (vendor and app/code)
4. Discovers themes from `vendor/` packages and `app/design/` directories, resolving parent theme fallback chains
5. Parses each XML file and builds in-memory indexes mapping PHP class names, templates, events, and config paths to their XML locations
6. Scans `etc/frontend/di.xml` files for Hyvä compatibility module registrations (`CompatModuleRegistry` arguments)
7. Builds a class hierarchy (extends/implements) to resolve inherited plugins
8. Builds a plugin method index by reading plugin PHP files for `before`/`after`/`around` methods
9. Caches the DI index to `.magento2-lsp-cache.json` in the project root (add to `.gitignore`)
10. Watches XML files for changes and re-indexes automatically

Multiple Magento projects can be open simultaneously — each gets its own isolated index.

## Development

```bash
npm install
npm test           # run tests once
npm run test:watch # run tests in watch mode
npm run build      # compile TypeScript
npm run watch      # compile in watch mode
```
