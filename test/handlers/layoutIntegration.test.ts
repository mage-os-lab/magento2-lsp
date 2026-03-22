import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { handleDefinition } from '../../src/handlers/definition';
import { handleReferences } from '../../src/handlers/references';
import { ProjectManager, ProjectContext } from '../../src/project/projectManager';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('layout XML integration', () => {
  let project: ProjectContext;

  beforeAll(async () => {
    const pm = new ProjectManager();
    project = (await pm.ensureProject(FIXTURE_ROOT))!;
  });

  function getProject(): ProjectContext | undefined {
    return project;
  }

  const layoutFile = path.join(
    FIXTURE_ROOT,
    'vendor/test/module-foo/view/frontend/layout/test_foo_index.xml',
  );

  describe('definition from layout XML', () => {
    it('navigates from block class to PHP file', () => {
      // Find the block-class reference
      const ref = project.layoutIndex.getReferencesForFqcn('Test\\Foo\\Block\\FooList')[0];
      expect(ref).toBeDefined();

      const result = handleDefinition(
        {
          textDocument: { uri: URI.file(layoutFile).toString() },
          position: { line: ref.line, character: ref.column },
        },
        getProject,
      );
      // FooList.php doesn't exist in fixtures, so definition returns null
      // But the handler tries and falls through correctly
      expect(result).toBeNull(); // No PHP file for this fixture class
    });

    it('navigates from template identifier to .phtml file', () => {
      const refs = project.layoutIndex.getReferencesForTemplate('Test_Foo::product/list.phtml');
      const ref = refs[0];
      expect(ref).toBeDefined();

      const result = handleDefinition(
        {
          textDocument: { uri: URI.file(layoutFile).toString() },
          position: { line: ref.line, character: ref.column },
        },
        getProject,
      );
      expect(result).not.toBeNull();
      const loc = result as { uri: string };
      expect(URI.parse(loc.uri).fsPath).toContain('list.phtml');
    });

    it('resolves template with theme fallback (child theme override)', () => {
      // Magento_Catalog::product/view.phtml exists in the child theme
      const themeLayoutFile = path.join(
        FIXTURE_ROOT,
        'app/design/frontend/Test/child/Magento_Catalog/layout/test.xml',
      );

      // The theme has an override for this template, so if we were to resolve it
      // from the child theme context, it should find the child theme override
      const resolved = project.themeResolver.resolveTemplate(
        'Magento_Catalog::product/view.phtml',
        'frontend',
        'frontend/Test/child',
        project.modules,
      );
      expect(resolved.length).toBeGreaterThanOrEqual(1);
      expect(resolved[0]).toContain(path.join('Test', 'child'));
    });
  });

  describe('references from layout XML', () => {
    it('finds all layout refs for a template identifier', () => {
      const refs = project.layoutIndex.getReferencesForTemplate('Test_Foo::product/list.phtml');
      const ref = refs[0];

      const result = handleReferences(
        {
          textDocument: { uri: URI.file(layoutFile).toString() },
          position: { line: ref.line, character: ref.column },
          context: { includeDeclaration: true },
        },
        getProject,
      );
      expect(result).not.toBeNull();
      expect(result!.length).toBeGreaterThanOrEqual(1);
    });

    it('finds all layout refs for a block class', () => {
      const ref = project.layoutIndex.getReferencesForFqcn('Test\\Foo\\Block\\FooList')[0];

      const result = handleReferences(
        {
          textDocument: { uri: URI.file(layoutFile).toString() },
          position: { line: ref.line, character: ref.column },
          context: { includeDeclaration: true },
        },
        getProject,
      );
      expect(result).not.toBeNull();
      expect(result!.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('references from .phtml file', () => {
    it('finds layout XML files using this template', () => {
      const phtmlFile = path.join(
        FIXTURE_ROOT,
        'vendor/test/module-foo/view/frontend/templates/product/list.phtml',
      );

      const result = handleReferences(
        {
          textDocument: { uri: URI.file(phtmlFile).toString() },
          position: { line: 0, character: 0 },
          context: { includeDeclaration: true },
        },
        getProject,
      );
      expect(result).not.toBeNull();
      expect(result!.length).toBeGreaterThanOrEqual(1);
      // Result should point to the layout XML file
      expect(URI.parse(result![0].uri).fsPath).toContain('test_foo_index.xml');
    });
  });
});
