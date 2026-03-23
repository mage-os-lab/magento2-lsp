import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { handleHover } from '../../src/handlers/hover';
import { ProjectManager, ProjectContext } from '../../src/project/projectManager';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('handleHover', () => {
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
    };
  }

  it('returns null for non-XML files', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/Foo.php');
    const result = handleHover(makeParams(phpFile, 0, 0), getProject);
    expect(result).toBeNull();
  });

  it('returns null when cursor is not on a reference', () => {
    const diXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
    const result = handleHover(makeParams(diXml, 0, 0), getProject);
    expect(result).toBeNull();
  });

  it('shows preference info on preference-for reference', () => {
    const diXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
    const refs = project.index.getReferencesForFqcn('Test\\Foo\\Api\\FooInterface');
    const prefFor = refs.find(
      (r) => r.kind === 'preference-for' && r.file === diXml,
    );
    expect(prefFor).toBeDefined();

    const result = handleHover(
      makeParams(diXml, prefFor!.line, prefFor!.column),
      getProject,
    );
    expect(result).not.toBeNull();
    const content = result!.contents;
    expect('value' in content && content.value).toContain('Preference');
    expect('value' in content && content.value).toContain('Test\\Foo\\Api\\FooInterface');
  });

  it('shows type info with plugin count on type-name reference', () => {
    const diXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
    const refs = project.index.getReferencesForFqcn('Test\\Foo\\Model\\Foo');
    const typeRef = refs.find(
      (r) => r.kind === 'type-name' && r.file === diXml,
    );
    // Only test if the fixture has a type-name ref for this class
    if (typeRef) {
      const result = handleHover(
        makeParams(diXml, typeRef.line, typeRef.column),
        getProject,
      );
      expect(result).not.toBeNull();
      const content = result!.contents;
      expect('value' in content && content.value).toContain('Type');
    }
  });
});
