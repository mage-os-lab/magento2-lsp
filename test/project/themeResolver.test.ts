import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { ThemeResolver } from '../../src/project/themeResolver';
import { resolveActiveModules } from '../../src/project/moduleResolver';
import { ModuleInfo } from '../../src/indexer/types';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('ThemeResolver', () => {
  let resolver: ThemeResolver;
  let modules: ModuleInfo[];

  beforeAll(() => {
    resolver = new ThemeResolver();
    resolver.discover(FIXTURE_ROOT);
    modules = resolveActiveModules(FIXTURE_ROOT);
  });

  describe('discovery', () => {
    it('discovers themes from app/design', () => {
      const themes = resolver.getAllThemes();
      const codes = themes.map((t) => t.code);
      expect(codes).toContain('frontend/Test/child');
      expect(codes).toContain('frontend/Test/parent');
    });

    it('discovers vendor theme with hyphenated name', () => {
      const themes = resolver.getAllThemes();
      const codes = themes.map((t) => t.code);
      expect(codes).toContain('frontend/Test/my-theme');
    });

    it('parses parent from theme.xml for hyphenated vendor theme', () => {
      const themes = resolver.getAllThemes();
      const theme = themes.find((t) => t.code === 'frontend/Test/my-theme');
      expect(theme).toBeDefined();
      expect(theme!.parentCode).toBe('Test/parent');
    });

    it('parses theme area correctly', () => {
      const themes = resolver.getAllThemes();
      const child = themes.find((t) => t.code === 'frontend/Test/child');
      expect(child).toBeDefined();
      expect(child!.area).toBe('frontend');
    });

    it('parses parent from theme.xml', () => {
      const themes = resolver.getAllThemes();
      const child = themes.find((t) => t.code === 'frontend/Test/child');
      expect(child!.parentCode).toBe('Test/parent');
    });

    it('root theme has no parent', () => {
      const themes = resolver.getAllThemes();
      const parent = themes.find((t) => t.code === 'frontend/Test/parent');
      expect(parent!.parentCode).toBeUndefined();
    });
  });

  describe('fallback chain', () => {
    it('builds chain from child to parent', () => {
      const chain = resolver.getFallbackChain('frontend/Test/child');
      expect(chain).toHaveLength(2);
      expect(chain[0].code).toBe('frontend/Test/child');
      expect(chain[1].code).toBe('frontend/Test/parent');
    });

    it('root theme has a chain of length 1', () => {
      const chain = resolver.getFallbackChain('frontend/Test/parent');
      expect(chain).toHaveLength(1);
      expect(chain[0].code).toBe('frontend/Test/parent');
    });

    it('builds chain for hyphenated vendor theme', () => {
      const chain = resolver.getFallbackChain('frontend/Test/my-theme');
      expect(chain).toHaveLength(2);
      expect(chain[0].code).toBe('frontend/Test/my-theme');
      expect(chain[1].code).toBe('frontend/Test/parent');
    });

    it('returns empty chain for unknown theme', () => {
      const chain = resolver.getFallbackChain('frontend/Unknown/theme');
      expect(chain).toHaveLength(0);
    });
  });

  describe('getThemeForFile', () => {
    it('identifies which theme a file belongs to', () => {
      const childThemePath = path.join(
        FIXTURE_ROOT,
        'app/design/frontend/Test/child/Magento_Catalog/templates/product/view.phtml',
      );
      const theme = resolver.getThemeForFile(childThemePath);
      expect(theme).toBeDefined();
      expect(theme!.code).toBe('frontend/Test/child');
    });

    it('returns undefined for module files', () => {
      const moduleFile = path.join(
        FIXTURE_ROOT,
        'vendor/test/module-foo/view/frontend/templates/product/list.phtml',
      );
      expect(resolver.getThemeForFile(moduleFile)).toBeUndefined();
    });
  });

  describe('getAreaForFile', () => {
    it('returns area from theme', () => {
      const file = path.join(
        FIXTURE_ROOT,
        'app/design/frontend/Test/child/Magento_Catalog/layout/foo.xml',
      );
      expect(resolver.getAreaForFile(file)).toBe('frontend');
    });

    it('returns area from module view path', () => {
      const file = path.join(
        FIXTURE_ROOT,
        'vendor/test/module-foo/view/frontend/layout/foo.xml',
      );
      expect(resolver.getAreaForFile(file)).toBe('frontend');
    });
  });

  describe('resolveTemplate', () => {
    it('finds template in child theme first', () => {
      // Test_Foo module doesn't have Magento_Catalog, but the child theme does
      // Use a fake module name that the child theme overrides
      const results = resolver.resolveTemplate(
        'Magento_Catalog::product/view.phtml',
        'frontend',
        'frontend/Test/child',
        modules,
      );
      expect(results.length).toBeGreaterThanOrEqual(1);
      // First result should be from the child theme
      expect(results[0]).toContain(path.join('Test', 'child'));
    });

    it('finds template in module when not in any theme', () => {
      const results = resolver.resolveTemplate(
        'Test_Foo::product/list.phtml',
        'frontend',
        undefined,
        modules,
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toContain(path.join('view', 'frontend', 'templates', 'product', 'list.phtml'));
    });

    it('returns empty for non-existent template', () => {
      const results = resolver.resolveTemplate(
        'Test_Foo::nonexistent.phtml',
        'frontend',
        'frontend/Test/child',
        modules,
      );
      expect(results).toHaveLength(0);
    });
  });
});
