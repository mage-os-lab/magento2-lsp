import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { ProjectManager, ProjectContext } from '../../src/project/projectManager';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('PluginMethodIndex', () => {
  let project: ProjectContext;

  beforeAll(async () => {
    const pm = new ProjectManager();
    project = (await pm.ensureProject(FIXTURE_ROOT))!;
  });

  describe('direct plugins (on the interface)', () => {
    it('finds plugins declared directly on the interface', () => {
      const plugins = project.indexes.pluginMethod.getPluginsForMethod(
        'Test\\Foo\\Api\\FooInterface',
        'save',
      );
      expect(plugins).toHaveLength(1);
      expect(plugins[0].prefix).toBe('before');
      expect(plugins[0].pluginFqcn).toBe('Custom\\Bar\\Plugin\\FooPlugin');
    });
  });

  describe('inherited plugins (on implementing class)', () => {
    // The plugin is declared on Test\Foo\Api\FooInterface in di.xml.
    // Test\Foo\Model\Foo implements FooInterface, so it inherits the plugins.

    it('finds inherited plugins for save via interface', () => {
      const plugins = project.indexes.pluginMethod.getPluginsForMethod(
        'Test\\Foo\\Model\\Foo',
        'save',
      );
      expect(plugins).toHaveLength(1);
      expect(plugins[0].prefix).toBe('before');
      expect(plugins[0].pluginFqcn).toBe('Custom\\Bar\\Plugin\\FooPlugin');
    });

    it('finds inherited after plugin', () => {
      const plugins = project.indexes.pluginMethod.getPluginsForMethod(
        'Test\\Foo\\Model\\Foo',
        'getName',
      );
      expect(plugins).toHaveLength(1);
      expect(plugins[0].prefix).toBe('after');
    });

    it('finds inherited around plugin', () => {
      const plugins = project.indexes.pluginMethod.getPluginsForMethod(
        'Test\\Foo\\Model\\Foo',
        'load',
      );
      expect(plugins).toHaveLength(1);
      expect(plugins[0].prefix).toBe('around');
    });

    it('hasPlugins returns true for class with inherited plugins', () => {
      expect(
        project.indexes.pluginMethod.hasPlugins('Test\\Foo\\Model\\Foo'),
      ).toBe(true);
    });

    it('lists all intercepted methods including inherited', () => {
      const methods = project.indexes.pluginMethod.getInterceptedMethods(
        'Test\\Foo\\Model\\Foo',
      );
      expect(methods).toBeDefined();
      const names = Array.from(methods!.keys()).sort();
      expect(names).toEqual(['getName', 'load', 'save']);
    });

    it('reports correct total unique plugin count including inherited', () => {
      const count = project.indexes.pluginMethod.getTotalPluginCount(
        'Test\\Foo\\Model\\Foo',
      );
      expect(count).toBe(1);
    });
  });

  describe('non-intercepted', () => {
    it('returns empty for non-intercepted methods', () => {
      expect(
        project.indexes.pluginMethod.getPluginsForMethod('Test\\Foo\\Model\\Foo', 'nonExistent'),
      ).toHaveLength(0);
    });

    it('returns empty for classes without plugins', () => {
      expect(
        project.indexes.pluginMethod.getPluginsForMethod('Custom\\Bar\\Model\\Bar', 'save'),
      ).toHaveLength(0);
    });

    it('hasPlugins returns false for non-plugged class', () => {
      expect(
        project.indexes.pluginMethod.hasPlugins('Custom\\Bar\\Model\\Bar'),
      ).toBe(false);
    });
  });

  describe('plugin method locations', () => {
    it('includes plugin method file and position', () => {
      const plugins = project.indexes.pluginMethod.getPluginsForMethod(
        'Test\\Foo\\Api\\FooInterface',
        'save',
      );
      expect(plugins[0].pluginMethodFile).toContain('FooPlugin.php');
      expect(plugins[0].pluginMethodName).toBe('beforeSave');
      expect(plugins[0].pluginMethodLine).toBeGreaterThanOrEqual(0);
    });

    it('includes the di.xml reference', () => {
      const plugins = project.indexes.pluginMethod.getPluginsForMethod(
        'Test\\Foo\\Api\\FooInterface',
        'save',
      );
      expect(plugins[0].diRef.kind).toBe('plugin-type');
      expect(plugins[0].diRef.file).toContain('di.xml');
    });
  });

  describe('reverse lookup', () => {
    it('maps plugin method to target interface method', () => {
      const entry = project.indexes.pluginMethod.getReverseEntry(
        'Custom\\Bar\\Plugin\\FooPlugin',
        'beforeSave',
      );
      expect(entry).toBeDefined();
      // The plugin is declared on the interface, so the target is the interface
      expect(entry!.targetFqcn).toBe('Test\\Foo\\Api\\FooInterface');
      expect(entry!.targetMethodName).toBe('save');
    });

    it('maps afterGetName to getName', () => {
      const entry = project.indexes.pluginMethod.getReverseEntry(
        'Custom\\Bar\\Plugin\\FooPlugin',
        'afterGetName',
      );
      expect(entry).toBeDefined();
      expect(entry!.targetMethodName).toBe('getName');
    });

    it('returns undefined for non-plugin method', () => {
      expect(
        project.indexes.pluginMethod.getReverseEntry('Custom\\Bar\\Plugin\\FooPlugin', 'someMethod'),
      ).toBeUndefined();
    });
  });

  describe('plugin class detection', () => {
    it('isPluginClass returns true for known plugin class', () => {
      expect(
        project.indexes.pluginMethod.isPluginClass('Custom\\Bar\\Plugin\\FooPlugin'),
      ).toBe(true);
    });

    it('isPluginClass returns false for non-plugin class', () => {
      expect(
        project.indexes.pluginMethod.isPluginClass('Test\\Foo\\Model\\Foo'),
      ).toBe(false);
    });
  });
});
