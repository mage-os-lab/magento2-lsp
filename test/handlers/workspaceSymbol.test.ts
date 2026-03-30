import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { SymbolKind } from 'vscode-languageserver';
import { handleWorkspaceSymbol } from '../../src/handlers/workspaceSymbol';
import { ProjectManager, ProjectContext } from '../../src/project/projectManager';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('handleWorkspaceSymbol', () => {
  let project: ProjectContext;

  beforeAll(async () => {
    const pm = new ProjectManager();
    project = (await pm.ensureProject(FIXTURE_ROOT))!;
  });

  function getProjects(): ProjectContext[] {
    return [project];
  }

  it('returns null for queries shorter than 2 characters', () => {
    const result = handleWorkspaceSymbol({ query: 'F' }, getProjects);
    expect(result).toBeNull();
  });

  it('returns matching FQCNs from DI index', () => {
    const result = handleWorkspaceSymbol({ query: 'Foo' }, getProjects);
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
    // All results should contain "Foo" (case-insensitive)
    for (const sym of result!) {
      expect(sym.name.toLowerCase()).toContain('foo');
    }
  });

  it('returns results with correct symbol kinds', () => {
    const result = handleWorkspaceSymbol({ query: 'Foo' }, getProjects);
    expect(result).not.toBeNull();
    for (const sym of result!) {
      expect([SymbolKind.Class, SymbolKind.Event]).toContain(sym.kind);
    }
  });

  it('returns null for queries with no matches', () => {
    const result = handleWorkspaceSymbol(
      { query: 'ZzNonExistentClassNameZz' },
      getProjects,
    );
    expect(result).toBeNull();
  });

  it('returns empty result for empty project list', () => {
    const result = handleWorkspaceSymbol(
      { query: 'Foo' },
      () => [],
    );
    expect(result).toBeNull();
  });

  it('returns matching virtual types', () => {
    // Fixture has CustomBarVirtual in app/code/Custom/Bar/etc/di.xml
    const result = handleWorkspaceSymbol({ query: 'CustomBarVirtual' }, getProjects);
    expect(result).not.toBeNull();
    const vtResults = result!.filter((r) => r.name.toLowerCase().includes('virtual'));
    expect(vtResults.length).toBeGreaterThan(0);
    for (const sym of vtResults) {
      expect(sym.location).toBeDefined();
    }
  });

  it('returns matching event names', () => {
    const result = handleWorkspaceSymbol({ query: 'test_foo' }, getProjects);
    expect(result).not.toBeNull();
    // The fixture has events like test_foo_save_after
    const eventResults = result!.filter((r) => r.kind === SymbolKind.Event);
    expect(eventResults.length).toBeGreaterThan(0);
  });
});
