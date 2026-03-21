/**
 * LSP server capability declarations.
 *
 * Tells the editor which LSP features this server supports.
 * Currently: definition (go to definition) and references (find references).
 *
 * TextDocumentSyncKind.Full means the editor sends the full file content on every change.
 * This is used for di.xml files so we can re-parse them immediately when edited.
 * For PHP files we don't need content sync — we read them from disk on demand.
 */

import {
  ServerCapabilities,
  TextDocumentSyncKind,
} from 'vscode-languageserver';

export const SERVER_CAPABILITIES: ServerCapabilities = {
  textDocumentSync: TextDocumentSyncKind.Full,
  definitionProvider: true,
  referencesProvider: true,
};
