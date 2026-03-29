import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { scanAllTemplates, deriveTemplateEntry } from '../../src/indexer/templateScanner';
import { resolveActiveModules } from '../../src/project/moduleResolver';
import { ThemeResolver } from '../../src/project/themeResolver';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('templateScanner', () => {
  const modules = resolveActiveModules(FIXTURE_ROOT);
  const themeResolver = new ThemeResolver();
  themeResolver.discover(FIXTURE_ROOT);
  const themes = themeResolver.getAllThemes();

  describe('scanAllTemplates', () => {
    it('discovers module templates', () => {
      const entries = scanAllTemplates(modules, themes);
      const ids = entries.map(e => e.value);
      expect(ids).toContain('Test_Foo::product/list.phtml');
    });

    it('discovers theme template overrides', () => {
      const entries = scanAllTemplates(modules, themes);
      // The child theme overrides Test_Foo::product/list.phtml
      const childOverrides = entries.filter(
        e => e.value === 'Test_Foo::product/list.phtml'
          && e.filePath.includes('Test/child'),
      );
      expect(childOverrides.length).toBe(1);
    });

    it('assigns correct area to module templates', () => {
      const entries = scanAllTemplates(modules, themes);
      const moduleTemplate = entries.find(
        e => e.value === 'Test_Foo::product/list.phtml'
          && e.filePath.includes('module-foo/view/frontend'),
      );
      expect(moduleTemplate).toBeDefined();
      expect(moduleTemplate!.area).toBe('frontend');
    });

    it('assigns correct area to theme templates from theme registration', () => {
      const entries = scanAllTemplates(modules, themes);
      // Theme templates get their area from the theme's registration
      const themeTemplate = entries.find(
        e => e.filePath.includes('app/design/frontend/'),
      );
      if (themeTemplate) {
        expect(themeTemplate.area).toBe('frontend');
      }
    });

    it('has pre-computed segments for each entry', () => {
      const entries = scanAllTemplates(modules, themes);
      for (const entry of entries) {
        expect(entry.moduleSegments.length).toBeGreaterThan(0);
        // Path segments should exist for non-empty paths
        if (entry.value.includes('::') && entry.value.split('::')[1].length > 0) {
          expect(entry.pathSegments.length).toBeGreaterThan(0);
        }
      }
    });

    it('stores absolute file paths', () => {
      const entries = scanAllTemplates(modules, themes);
      for (const entry of entries) {
        expect(path.isAbsolute(entry.filePath)).toBe(true);
        expect(entry.filePath.endsWith('.phtml')).toBe(true);
      }
    });
  });

  describe('deriveTemplateEntry', () => {
    it('derives entry for a module template', () => {
      const filePath = path.join(
        FIXTURE_ROOT,
        'vendor/test/module-foo/view/frontend/templates/product/list.phtml',
      );
      const entry = deriveTemplateEntry(filePath, modules, themeResolver);

      expect(entry).toBeDefined();
      expect(entry!.value).toBe('Test_Foo::product/list.phtml');
      expect(entry!.area).toBe('frontend');
    });

    it('derives entry for a theme template', () => {
      const filePath = path.join(
        FIXTURE_ROOT,
        'app/design/frontend/Test/child/Test_Foo/templates/product/list.phtml',
      );
      const entry = deriveTemplateEntry(filePath, modules, themeResolver);

      expect(entry).toBeDefined();
      expect(entry!.value).toBe('Test_Foo::product/list.phtml');
      expect(entry!.area).toBe('frontend');
    });

    it('returns undefined for files outside known locations', () => {
      const entry = deriveTemplateEntry('/random/path/template.phtml', modules, themeResolver);
      expect(entry).toBeUndefined();
    });
  });
});
