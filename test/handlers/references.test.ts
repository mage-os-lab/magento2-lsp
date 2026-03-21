import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { handleReferences } from '../../src/handlers/references';
import { ProjectManager, ProjectContext } from '../../src/project/projectManager';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('handleReferences', () => {
  let project: ProjectContext;

  beforeAll(async () => {
    const pm = new ProjectManager();
    project = (await pm.ensureProject(FIXTURE_ROOT))!;
  });

  function getProject(): ProjectContext | undefined {
    return project;
  }

  function makeParams(filePath: string, line: number, character: number) {
    return {
      textDocument: { uri: URI.file(filePath).toString() },
      position: { line, character },
      context: { includeDeclaration: true },
    };
  }

  it('finds references from di.xml cursor position', () => {
    const diXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
    // Find a reference to Test\Foo\Model\Foo on the type-name line
    const refs = project.index.getReferencesForFqcn('Test\\Foo\\Model\\Foo');
    const typeNameRef = refs.find(
      (r) => r.kind === 'type-name' && r.file === diXml,
    );
    expect(typeNameRef).toBeDefined();

    const result = handleReferences(
      makeParams(diXml, typeNameRef!.line, typeNameRef!.column),
      getProject,
    );
    expect(result).not.toBeNull();
    // Test\Foo\Model\Foo should appear as preference-type, type-name, and virtualtype-type
    expect(result!.length).toBeGreaterThanOrEqual(2);
  });

  it('finds references from PHP class declaration', () => {
    const phpFile = path.join(
      FIXTURE_ROOT,
      'vendor/test/module-foo/Model/Foo.php',
    );
    // Line 4: "class Foo"  — class name starts at column 6
    const result = handleReferences(makeParams(phpFile, 4, 6), getProject);
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThanOrEqual(1);

    // All results should be di.xml locations
    for (const loc of result!) {
      expect(URI.parse(loc.uri).fsPath).toMatch(/\.xml$/);
    }
  });

  it('returns null from PHP when cursor is not on class name', () => {
    const phpFile = path.join(
      FIXTURE_ROOT,
      'vendor/test/module-foo/Model/Foo.php',
    );
    // Line 0: "<?php" — not a class declaration
    const result = handleReferences(makeParams(phpFile, 0, 0), getProject);
    expect(result).toBeNull();
  });

  it('finds references for interface from PHP declaration', () => {
    const phpFile = path.join(
      FIXTURE_ROOT,
      'vendor/test/module-foo/Api/FooInterface.php',
    );
    // Line 4: "interface FooInterface" — name starts at column 10
    const result = handleReferences(makeParams(phpFile, 4, 10), getProject);
    expect(result).not.toBeNull();
    // Should find at least the preference-for reference
    expect(result!.length).toBeGreaterThanOrEqual(1);
  });

  it('returns null for unknown file types', () => {
    const result = handleReferences(
      makeParams('/some/file.txt', 0, 0),
      getProject,
    );
    expect(result).toBeNull();
  });
});
