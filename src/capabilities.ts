/**
 * LSP server capability declarations.
 *
 * Tells the editor which LSP features this server supports:
 * definition, references, hover, completion, document symbols, workspace symbol,
 * code lens or inlay hints (depending on hintMode), code actions, and rename.
 *
 * TextDocumentSyncKind.Full means the editor sends the full file content on every change.
 * This is used for di.xml files so we can re-parse them immediately when edited.
 * For PHP files we don't need content sync — we read them from disk on demand.
 */

import {
  CodeActionKind,
  ServerCapabilities,
  TextDocumentSyncKind,
} from 'vscode-languageserver';
import { HintMode } from './settings';

/**
 * Build server capabilities based on the configured hint mode.
 *
 * - `'codeLens'` (default for most editors): advertise codeLensProvider, no inlayHintProvider
 * - `'inlayHint'` (default for Zed): advertise inlayHintProvider, no codeLensProvider
 *
 * Note: when a future code lens requires a command (which inlay hints don't support),
 * this function should advertise both providers simultaneously.
 */
export function buildCapabilities(hintMode: HintMode): ServerCapabilities {
  return {
    textDocumentSync: TextDocumentSyncKind.Full,
    definitionProvider: true,
    referencesProvider: true,
    hoverProvider: true,
    documentSymbolProvider: true,
    workspaceSymbolProvider: true,
    ...(hintMode === 'codeLens'
      ? { codeLensProvider: { resolveProvider: false } }
      : { inlayHintProvider: { resolveProvider: false } }),
    codeActionProvider: {
      codeActionKinds: [CodeActionKind.QuickFix],
      resolveProvider: true,
    },
    renameProvider: {
      prepareProvider: true,
    },
    completionProvider: {
      triggerCharacters: ['"', "'", '\\', '/', ':'],
      resolveProvider: false,
    },
  };
}
