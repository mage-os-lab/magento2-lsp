import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { ProjectManager, ProjectContext } from '../../src/project/projectManager';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('LayoutIndex', () => {
  let project: ProjectContext;

  beforeAll(async () => {
    const pm = new ProjectManager();
    project = (await pm.ensureProject(FIXTURE_ROOT))!;
  });

  it('indexes layout XML files', () => {
    expect(project.layoutIndex.getFileCount()).toBeGreaterThanOrEqual(1);
  });

  it('finds block class references', () => {
    const refs = project.layoutIndex.getReferencesForFqcn('Test\\Foo\\Block\\FooList');
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe('block-class');
  });

  it('finds template references', () => {
    const refs = project.layoutIndex.getReferencesForTemplate('Test_Foo::product/list.phtml');
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe('block-template');
  });

  it('finds argument-object references (ViewModels)', () => {
    const refs = project.layoutIndex.getReferencesForFqcn('Test\\Foo\\ViewModel\\FooViewModel');
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe('argument-object');
  });

  it('finds reference at cursor position', () => {
    const refs = project.layoutIndex.getReferencesForFqcn('Test\\Foo\\Block\\FooList');
    const ref = refs[0];
    const found = project.layoutIndex.getReferenceAtPosition(ref.file, ref.line, ref.column);
    expect(found).toBeDefined();
    expect(found!.value).toBe('Test\\Foo\\Block\\FooList');
  });

  it('discovers themes', () => {
    const themes = project.themeResolver.getAllThemes();
    expect(themes.length).toBeGreaterThanOrEqual(2);
    const codes = themes.map((t) => t.code);
    expect(codes).toContain('frontend/Test/child');
    expect(codes).toContain('frontend/Test/parent');
  });
});
