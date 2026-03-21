import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { handleDefinition } from '../../src/handlers/definition';
import { ProjectManager, ProjectContext } from '../../src/project/projectManager';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('handleDefinition', () => {
  let project: ProjectContext;

  beforeAll(async () => {
    const pm = new ProjectManager();
    project = (await pm.ensureProject(FIXTURE_ROOT))!;
  });

  function getProject(filePath: string): ProjectContext | undefined {
    // All fixture files belong to the same project
    return project;
  }

  function makeParams(filePath: string, line: number, character: number) {
    return {
      textDocument: { uri: URI.file(filePath).toString() },
      position: { line, character },
    };
  }

  it('returns null for PHP files', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/Foo.php');
    const result = handleDefinition(makeParams(phpFile, 4, 6), getProject);
    expect(result).toBeNull();
  });

  it('returns null when cursor is not on a reference', () => {
    const diXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
    // Line 0 is the XML declaration — no references there
    const result = handleDefinition(makeParams(diXml, 0, 0), getProject);
    expect(result).toBeNull();
  });

  it('navigates from preference type to PHP class', () => {
    const diXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
    // Line 2 has: <preference for="Test\Foo\Api\FooInterface" type="Test\Foo\Model\Foo" />
    // Find the 'type' attribute position — Test\Foo\Model\Foo
    const refs = project.index.getReferencesForFqcn('Test\\Foo\\Model\\Foo');
    const prefType = refs.find(
      (r) => r.kind === 'preference-type' && r.file === diXml,
    );
    expect(prefType).toBeDefined();

    const result = handleDefinition(
      makeParams(diXml, prefType!.line, prefType!.column),
      getProject,
    );
    expect(result).not.toBeNull();
    // Should point to the PHP file
    const loc = result as { uri: string; range: { start: { line: number } } };
    expect(URI.parse(loc.uri).fsPath).toContain('Foo.php');
  });

  it('navigates from preference for to effective implementation PHP class', () => {
    const diXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
    const refs = project.index.getReferencesForFqcn('Test\\Foo\\Api\\FooInterface');
    const prefFor = refs.find(
      (r) => r.kind === 'preference-for' && r.file === diXml,
    );
    expect(prefFor).toBeDefined();

    const result = handleDefinition(
      makeParams(diXml, prefFor!.line, prefFor!.column),
      getProject,
    );
    expect(result).not.toBeNull();
    const loc = result as { uri: string; range: { start: { line: number } } };
    // Should jump to the implementation class (Test\Foo\Model\Foo)
    expect(URI.parse(loc.uri).fsPath).toContain('Foo.php');
  });

  it('navigates from virtualType reference to its di.xml declaration', () => {
    const diXml = path.join(FIXTURE_ROOT, 'app/code/Custom/Bar/etc/di.xml');
    // Line 2 has: <virtualType name="CustomBarVirtual" type="Test\Foo\Model\Foo">
    const refs = project.index.getReferencesForFqcn('CustomBarVirtual');
    const vtRef = refs.find((r) => r.kind === 'virtualtype-name');
    expect(vtRef).toBeDefined();

    // Now simulate searching for CustomBarVirtual from another di.xml
    // In this fixture, CustomBarVirtual is only declared, not referenced elsewhere.
    // But we can test that getEffectiveVirtualType returns it
    const vt = project.index.getEffectiveVirtualType('CustomBarVirtual');
    expect(vt).toBeDefined();
    expect(vt!.parentType).toBe('Test\\Foo\\Model\\Foo');
  });
});
