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

  it('finds references from di.xml cursor position', async () => {
    const diXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
    // Find a reference to Test\Foo\Model\Foo on the type-name line
    const refs = project.index.getReferencesForFqcn('Test\\Foo\\Model\\Foo');
    const typeNameRef = refs.find(
      (r) => r.kind === 'type-name' && r.file === diXml,
    );
    expect(typeNameRef).toBeDefined();

    const result = await handleReferences(
      makeParams(diXml, typeNameRef!.line, typeNameRef!.column),
      getProject,
    );
    expect(result).not.toBeNull();
    // Test\Foo\Model\Foo should appear as preference-type, type-name, and virtualtype-type
    expect(result!.length).toBeGreaterThanOrEqual(2);
  });

  it('finds references from PHP class declaration', async () => {
    const phpFile = path.join(
      FIXTURE_ROOT,
      'vendor/test/module-foo/Model/Foo.php',
    );
    // Line 6 (0-based): "class Foo implements FooInterface" — class name at col 6
    const result = await handleReferences(makeParams(phpFile, 6, 6), getProject);
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThanOrEqual(1);

    // All results should be di.xml locations
    for (const loc of result!) {
      expect(URI.parse(loc.uri).fsPath).toMatch(/\.xml$/);
    }
  });

  it('returns null from PHP when cursor is not on class name', async () => {
    const phpFile = path.join(
      FIXTURE_ROOT,
      'vendor/test/module-foo/Model/Foo.php',
    );
    // Line 0: "<?php" — not a class declaration
    const result = await handleReferences(makeParams(phpFile, 0, 0), getProject);
    expect(result).toBeNull();
  });

  it('finds references for interface from PHP declaration', async () => {
    const phpFile = path.join(
      FIXTURE_ROOT,
      'vendor/test/module-foo/Api/FooInterface.php',
    );
    // Line 4: "interface FooInterface" — name starts at column 10
    const result = await handleReferences(makeParams(phpFile, 4, 10), getProject);
    expect(result).not.toBeNull();
    // Should find at least the preference-for reference
    expect(result!.length).toBeGreaterThanOrEqual(1);
  });

  it('returns null for unknown file types', async () => {
    const result = await handleReferences(
      makeParams('/some/file.txt', 0, 0),
      getProject,
    );
    expect(result).toBeNull();
  });

  it('finds plugin method + di.xml from intercepted method name', async () => {
    const phpFile = path.join(
      FIXTURE_ROOT,
      'vendor/test/module-foo/Model/Foo.php',
    );
    // Line 8 (0-based): "    public function save(): void {}" — "save" starts at col 20
    const result = await handleReferences(makeParams(phpFile, 8, 20), getProject);
    expect(result).not.toBeNull();
    // Should include both the plugin PHP method (beforeSave) and the di.xml declaration
    expect(result!).toHaveLength(2);
    const paths = result!.map((r) => URI.parse(r.uri).fsPath);
    expect(paths.some((p) => p.endsWith('FooPlugin.php'))).toBe(true);
    expect(paths.some((p) => p.endsWith('di.xml'))).toBe(true);
  });

  it('navigates from plugin method to target method + di.xml', async () => {
    const pluginFile = path.join(
      FIXTURE_ROOT,
      'app/code/Custom/Bar/Plugin/FooPlugin.php',
    );
    // Line 6: "    public function beforeSave($subject): void {}"
    // "beforeSave" starts at col 20
    const result = await handleReferences(makeParams(pluginFile, 6, 20), getProject);
    expect(result).not.toBeNull();
    // Should include the target method (save on FooInterface) and the di.xml declaration
    expect(result!).toHaveLength(2);
    const paths = result!.map((r) => URI.parse(r.uri).fsPath);
    // The plugin is declared on the interface, so the target is the interface
    expect(paths.some((p) => p.endsWith('FooInterface.php'))).toBe(true);
    expect(paths.some((p) => p.endsWith('di.xml'))).toBe(true);
  });

  it('returns null for non-intercepted method name', async () => {
    const phpFile = path.join(
      FIXTURE_ROOT,
      'vendor/test/module-foo/Model/Foo.php',
    );
    // Line 11 (0-based): "    public function delete(): void {}" — "delete" starts at col 20
    const result = await handleReferences(makeParams(phpFile, 11, 20), getProject);
    expect(result).toBeNull();
  });
});
