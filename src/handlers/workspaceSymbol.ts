/**
 * LSP "workspace/symbol" handler.
 *
 * Returns matching symbols from the DI, events, and virtualType indexes
 * when the user performs a workspace symbol search (e.g., Ctrl+T in VS Code,
 * :Telescope lsp_workspace_symbols in Neovim).
 *
 * Searches across all initialized projects and returns up to MAX_RESULTS matches.
 */

import {
  CancellationToken,
  Location,
  Range,
  SymbolInformation,
  SymbolKind,
  WorkspaceSymbolParams,
} from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { ProjectContext } from '../project/projectManager';

const MAX_RESULTS = 100;
const MIN_QUERY_LENGTH = 2;

export function handleWorkspaceSymbol(
  params: WorkspaceSymbolParams,
  getProjects: () => ProjectContext[],
  token?: CancellationToken,
): SymbolInformation[] | null {
  const query = params.query.toLowerCase();
  if (query.length < MIN_QUERY_LENGTH) return null;

  const results: SymbolInformation[] = [];

  for (const project of getProjects()) {
    if (token?.isCancellationRequested) break;

    // Search DI-configured FQCNs
    for (const fqcn of project.index.getAllFqcns()) {
      if (results.length >= MAX_RESULTS) break;
      if (token?.isCancellationRequested) break;
      if (!fqcn.toLowerCase().includes(query)) continue;

      const refs = project.index.getReferencesForFqcn(fqcn);
      if (refs.length > 0) {
        results.push(
          SymbolInformation.create(
            fqcn,
            SymbolKind.Class,
            Range.create(refs[0].line, refs[0].column, refs[0].line, refs[0].endColumn),
            URI.file(refs[0].file).toString(),
          ),
        );
      }
    }

    // Search virtual types
    for (const name of project.index.getAllVirtualTypeNames()) {
      if (results.length >= MAX_RESULTS) break;
      if (token?.isCancellationRequested) break;
      if (!name.toLowerCase().includes(query)) continue;

      const decls = project.index.getAllVirtualTypeDecls(name);
      if (decls.length > 0) {
        results.push(
          SymbolInformation.create(
            name,
            SymbolKind.Class,
            Range.create(decls[0].line, decls[0].column, decls[0].line, decls[0].column + name.length),
            URI.file(decls[0].file).toString(),
            'VirtualType',
          ),
        );
      }
    }

    // Search event names
    for (const eventName of project.eventsIndex.getAllEventNames()) {
      if (results.length >= MAX_RESULTS) break;
      if (token?.isCancellationRequested) break;
      if (!eventName.toLowerCase().includes(query)) continue;

      const refs = project.eventsIndex.getEventNameRefs(eventName);
      if (refs.length > 0) {
        results.push(
          SymbolInformation.create(
            eventName,
            SymbolKind.Event,
            Range.create(refs[0].line, refs[0].column, refs[0].line, refs[0].endColumn),
            URI.file(refs[0].file).toString(),
          ),
        );
      }
    }
  }

  return results.length > 0 ? results : null;
}
