import { ExtensionContext, workspace } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export async function activate(context: ExtensionContext) {
  const config = workspace.getConfiguration('magento2-lsp');
  const binaryPath = config.get<string>('binary.path', 'magento2-lsp');

  const serverOptions: ServerOptions = {
    command: binaryPath,
    args: ['--stdio'],
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'php' },
      { scheme: 'file', language: 'xml' },
      { scheme: 'file', language: 'xsd' },
    ],
  };

  client = new LanguageClient(
    'magento2-lsp',
    'Magento 2 LSP',
    serverOptions,
    clientOptions,
  );

  await client.start();
}

export async function deactivate() {
  await client?.stop();
}
