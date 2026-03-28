# Neovim Setup

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

## Settings

To configure the server (e.g., custom code action templates), add `init_options` to the server config:

```lua
['magento2-lsp'] = {
  cmd = { 'magento2-lsp', '--stdio' },
  filetypes = { 'php', 'xml' },
  root_dir = function(bufnr, on_dir)
    -- ... (same as above)
  end,
  init_options = {
    templateDir = '.magento2-lsp/templates',
  },
},
```

Available settings:

| Setting | Type | Description |
|---------|------|-------------|
| `templateDir` | `string` | Optional. Path to a directory with custom code action templates (absolute, or relative to the project root). Overrides `MAGENTO_LSP_TEMPLATES_DIR` env var and built-in defaults. When omitted, the env var or built-in templates are used. See [Code Actions](features.md#code-actions-quick-fixes) for template file details. |
