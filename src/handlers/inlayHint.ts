/**
 * LSP "textDocument/inlayHint" handler.
 *
 * Converts the display-only code lenses produced by `handleCodeLens` into inlay
 * hints. This is the default delivery mode because many editors (notably Zed)
 * support inlay hints but not code lenses.
 *
 * The conversion is straightforward:
 *   CodeLens { range, command.title }  →  InlayHint { position, label, paddingLeft }
 *
 * Hints are placed at `range.end` so they appear just after the symbol
 * (e.g., `function save() ·1 plugin·`).
 *
 * Only lenses within the requested `params.range` are returned — the LSP spec
 * requires this, and it lets editors request hints for the visible viewport only.
 */

import {
  CancellationToken,
  InlayHint,
  InlayHintParams,
} from 'vscode-languageserver';
import { ProjectContext } from '../project/projectManager';
import { handleCodeLens } from './codeLens';

/**
 * Convert code lenses to inlay hints, filtered to the requested range.
 */
export function handleInlayHint(
  params: InlayHintParams,
  getProject: (uri: string) => ProjectContext | undefined,
  token?: CancellationToken,
): InlayHint[] | null {
  // Reuse the code lens computation — same data, different presentation.
  const codeLensParams = { textDocument: params.textDocument };
  const lenses = handleCodeLens(codeLensParams, getProject, token);
  if (!lenses || lenses.length === 0) return null;

  const { start, end } = params.range;
  const hints: InlayHint[] = [];

  for (const lens of lenses) {
    // Skip lenses outside the requested range.
    const pos = lens.range.end;
    if (pos.line < start.line || pos.line > end.line) continue;
    if (pos.line === start.line && pos.character < start.character) continue;
    if (pos.line === end.line && pos.character > end.character) continue;

    const label = lens.command?.title;
    if (!label) continue;

    hints.push({
      position: pos,
      label,
      paddingLeft: true,
      tooltip: label,
    });
  }

  return hints.length > 0 ? hints : null;
}
