import { describe, it, expect } from 'vitest';
import { buildCapabilities } from '../src/capabilities';

describe('buildCapabilities', () => {
  it('advertises codeLensProvider in "codeLens" mode', () => {
    const caps = buildCapabilities('codeLens');
    expect(caps.codeLensProvider).toEqual({ resolveProvider: false });
    expect(caps.inlayHintProvider).toBeUndefined();
  });

  it('advertises inlayHintProvider in "inlayHint" mode', () => {
    const caps = buildCapabilities('inlayHint');
    expect(caps.inlayHintProvider).toEqual({ resolveProvider: false });
    expect(caps.codeLensProvider).toBeUndefined();
  });

  it('always includes core providers regardless of hint mode', () => {
    for (const mode of ['codeLens', 'inlayHint'] as const) {
      const caps = buildCapabilities(mode);
      expect(caps.definitionProvider).toBe(true);
      expect(caps.referencesProvider).toBe(true);
      expect(caps.hoverProvider).toBe(true);
      expect(caps.documentSymbolProvider).toBe(true);
      expect(caps.workspaceSymbolProvider).toBe(true);
      expect(caps.codeActionProvider).toBeDefined();
      expect(caps.renameProvider).toBeDefined();
      expect(caps.completionProvider).toBeDefined();
    }
  });
});
