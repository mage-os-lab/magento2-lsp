use zed_extension_api::{self as zed, Extension, Result};

struct Magento2LspExtension;

impl Extension for Magento2LspExtension {
    fn new() -> Self {
        Magento2LspExtension
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let path = worktree
            .which("magento2-lsp")
            .ok_or_else(|| "magento2-lsp not found in PATH. Either install it globally (npm install -g magento2-lsp) or set lsp.magento2-lsp.binary.path in your Zed settings.".to_string())?;

        Ok(zed::Command {
            command: path,
            args: vec!["--stdio".to_string()],
            env: vec![],
        })
    }
}

zed::register_extension!(Magento2LspExtension);
