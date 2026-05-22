# Run via Docker (no Node on host)

If you don't want Node.js, npm, or any LSP/MCP dependencies installed on your host machine, you can run both servers from a Docker container. The same image serves the LSP (for editors) and the MCP server (for AI agents).

## Step 1 - Build the image

From the repository root:

```bash
docker build -t magento2-lsp:latest .
```

Re-run after pulling new source.

## Step 2 - Run the servers

The container talks LSP/MCP over stdio. Your editor or AI agent launches `docker run` and pipes JSON-RPC through it.

> **Important:** mount your Magento project at the **same absolute path** inside the container as on the host. The LSP returns absolute paths to your editor, and they must point at files your editor can also open.

The smallest working invocation:

```bash
docker run --rm -i \
  -v "$HOME/Workspace":"$HOME/Workspace" \
  -w "$HOME/Workspace" \
  magento2-lsp:latest \
  /opt/magento2-lsp/dist/server.js --stdio
```

Replace `$HOME/Workspace` with whatever parent directory holds your Magento project(s). Mounting a parent directory (rather than a single project) lets the same container serve multiple Magento checkouts - the LSP and MCP both auto-detect each project root by looking for `app/etc/di.xml`.

For the MCP server, swap `server.js` for `mcpServer.js`:

```bash
docker run --rm -i \
  -v "$HOME/Workspace":"$HOME/Workspace" \
  -w "$HOME/Workspace" \
  magento2-lsp:latest \
  /opt/magento2-lsp/dist/mcpServer.js
```

## Step 3 - Wire it into your editor / agent

### Neovim

Replace the `cmd` in your `magento2-lsp` server config:

```lua
['magento2-lsp'] = {
  cmd = {
    'docker', 'run', '--rm', '-i',
    '-v', '/Volumes/CaseSensitive/Workspace:/Volumes/CaseSensitive/Workspace',
    '-w', '/Volumes/CaseSensitive/Workspace',
    'magento2-lsp:latest',
    '/opt/magento2-lsp/dist/server.js', '--stdio',
  },
  filetypes = { 'php', 'xml', 'xsd' },
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

### VS Code / Cursor

Both extensions look for `magento2-lsp` on `$PATH`. Create a wrapper script anywhere on `$PATH`, for example `/usr/local/bin/magento2-lsp`:

```bash
#!/usr/bin/env bash
exec docker run --rm -i \
  -v "$HOME/Workspace":"$HOME/Workspace" \
  -w "$HOME/Workspace" \
  magento2-lsp:latest \
  /opt/magento2-lsp/dist/server.js "$@"
```

`chmod +x` it. The extension will pick it up. Override via the `magento2-lsp.binary.path` setting if you place it elsewhere.

### Zed

Same wrapper script as above. Point Zed at it:

```json
{
  "lsp": {
    "magento2-lsp": {
      "binary": {
        "path": "/usr/local/bin/magento2-lsp",
        "arguments": ["--stdio"]
      }
    }
  }
}
```

### Claude Code (MCP)

Create a matching wrapper for the MCP, e.g. `/usr/local/bin/magento2-lsp-mcp`:

```bash
#!/usr/bin/env bash
exec docker run --rm -i \
  -v "$HOME/Workspace":"$HOME/Workspace" \
  -w "$HOME/Workspace" \
  magento2-lsp:latest \
  /opt/magento2-lsp/dist/mcpServer.js "$@"
```

Then register it as usual:

```bash
claude mcp add magento2-lsp-mcp magento2-lsp-mcp
```

## Notes

- **File sharing on macOS:** the mounted directory must be in Docker Desktop's *Settings → Resources → File sharing* list. `/Users` and `/Volumes` are shared by default in recent versions.
- **Startup latency:** each editor session pays a one-time `docker run` cold-start (~1-2s). The container then lives as long as the editor session.
- **Cache:** the LSP writes `.magento2-lsp-cache.json` into each Magento project root, so the mount must be writable. Add this file to your project's `.gitignore`.
- **Rebuilding:** after `git pull`ing this repository, rerun `docker build -t magento2-lsp:latest .` to pick up new code.
