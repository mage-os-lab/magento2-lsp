import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { ProjectManager } from '../../src/project/projectManager';
import {
  handleGetDiConfig,
  handleGetPluginsForMethod,
  handleGetEventObservers,
  handleGetTemplateOverrides,
  handleGetClassContext,
  handleGetModuleOverview,
  handleResolveClass,
  handleSearchSymbols,
  handleGetClassHierarchy,
  handleGetDbSchema,
  handleRescanProject,
} from '../../src/mcp/tools';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');
// Any file inside the fixture project — handlers auto-detect the root from this
const FIXTURE_FILE = path.join(FIXTURE_ROOT, 'app', 'etc', 'di.xml');

describe('MCP tools', () => {
  const pm = new ProjectManager();

  // Warm the project cache once so individual tests don't each trigger indexing
  beforeAll(async () => {
    await pm.ensureProject(FIXTURE_FILE);
  });

  // -----------------------------------------------------------------------
  // magento_get_di_config
  // -----------------------------------------------------------------------

  describe('magento_get_di_config', () => {
    it('returns effective preference for an interface', async () => {
      const result = await handleGetDiConfig(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'Test\\Foo\\Api\\FooInterface',
      });
      expect(result.fqcn).toBe('Test\\Foo\\Api\\FooInterface');
      expect(result.preference).not.toBeNull();
      expect(result.preference!.implementation).toBe('Test\\Foo\\Model\\Foo');
    });

    it('returns plugins declared on a class', async () => {
      const result = await handleGetDiConfig(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'Test\\Foo\\Api\\FooInterface',
      });
      expect(result.plugins.length).toBeGreaterThanOrEqual(1);
      const barPlugin = result.plugins.find(
        (p) => p.pluginClass === 'Custom\\Bar\\Plugin\\FooPlugin',
      );
      expect(barPlugin).toBeDefined();
      expect(barPlugin!.methods).toContain('beforeSave');
    });

    it('returns argument object injections', async () => {
      const result = await handleGetDiConfig(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'Custom\\Bar\\Model\\Bar',
      });
      expect(result.argumentInjections.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty results for unknown FQCN without error', async () => {
      const result = await handleGetDiConfig(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'NonExistent\\Class\\Name',
      });
      expect(result.preference).toBeNull();
      expect(result.plugins).toEqual([]);
      expect(result.argumentInjections).toEqual([]);
      expect(result.layoutReferences).toEqual([]);
    });

    it('returns relative file paths', async () => {
      const result = await handleGetDiConfig(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'Test\\Foo\\Api\\FooInterface',
      });
      expect(result.preference!.declaredIn).not.toContain(FIXTURE_ROOT);
      expect(result.preference!.declaredIn).toContain('di.xml');
    });

    it('resolves class file path', async () => {
      const result = await handleGetDiConfig(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'Test\\Foo\\Model\\Foo',
      });
      expect(result.classFile).not.toBeNull();
      expect(result.classFile).toContain('Foo.php');
    });
  });

  // -----------------------------------------------------------------------
  // magento_get_plugins_for_method
  // -----------------------------------------------------------------------

  describe('magento_get_plugins_for_method', () => {
    it('returns plugins for an intercepted method', async () => {
      // The plugin is declared on FooInterface, Foo implements FooInterface
      const result = await handleGetPluginsForMethod(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'Test\\Foo\\Model\\Foo',
        method: 'save',
      });
      expect(result.targetClass).toBe('Test\\Foo\\Model\\Foo');
      expect(result.targetMethod).toBe('save');
      expect(result.plugins.length).toBeGreaterThanOrEqual(1);

      const beforeSave = result.plugins.find((p) => p.prefix === 'before');
      expect(beforeSave).toBeDefined();
      expect(beforeSave!.pluginClass).toBe('Custom\\Bar\\Plugin\\FooPlugin');
      expect(beforeSave!.pluginMethod).toBe('beforeSave');
      expect(beforeSave!.pluginFile).toContain('FooPlugin.php');
    });

    it('marks inherited plugins correctly', async () => {
      // Plugin is declared on FooInterface, queried on Foo (implementation)
      const result = await handleGetPluginsForMethod(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'Test\\Foo\\Model\\Foo',
        method: 'save',
      });
      const plugin = result.plugins[0];
      expect(plugin.inherited).toBe(true);
    });

    it('returns direct plugins as not inherited', async () => {
      // Plugin is declared on FooInterface, queried on FooInterface directly
      const result = await handleGetPluginsForMethod(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'Test\\Foo\\Api\\FooInterface',
        method: 'save',
      });
      if (result.plugins.length > 0) {
        const plugin = result.plugins[0];
        expect(plugin.inherited).toBe(false);
      }
    });

    it('returns empty array for a method with no plugins', async () => {
      const result = await handleGetPluginsForMethod(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'Test\\Foo\\Model\\Foo',
        method: 'delete',
      });
      expect(result.plugins).toEqual([]);
    });

    it('finds around plugin on load method', async () => {
      const result = await handleGetPluginsForMethod(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'Test\\Foo\\Model\\Foo',
        method: 'load',
      });
      const aroundLoad = result.plugins.find((p) => p.prefix === 'around');
      expect(aroundLoad).toBeDefined();
      expect(aroundLoad!.pluginMethod).toBe('aroundLoad');
    });
  });

  // -----------------------------------------------------------------------
  // magento_get_event_observers
  // -----------------------------------------------------------------------

  describe('magento_get_event_observers', () => {
    it('returns observers for an event name', async () => {
      const result = await handleGetEventObservers(pm, {
        filePath: FIXTURE_FILE,
        eventName: 'test_foo_save_after',
      });
      expect('observers' in result).toBe(true);
      const observers = (result as { observers: unknown[] }).observers;
      expect(observers).toHaveLength(1);
      expect((observers[0] as { observerClass: string }).observerClass).toBe(
        'Test\\Foo\\Observer\\FooSaveObserver',
      );
    });

    it('returns multiple observers for an event', async () => {
      const result = await handleGetEventObservers(pm, {
        filePath: FIXTURE_FILE,
        eventName: 'test_foo_load_after',
      });
      const observers = (result as { observers: unknown[] }).observers;
      expect(observers).toHaveLength(2);
    });

    it('returns events for an observer class', async () => {
      const result = await handleGetEventObservers(pm, {
        filePath: FIXTURE_FILE,
        observerClass: 'Test\\Foo\\Observer\\FooSaveObserver',
      });
      expect('events' in result).toBe(true);
      const events = (result as { events: { eventName: string }[] }).events;
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].eventName).toBe('test_foo_save_after');
    });

    it('returns empty observers for unknown event', async () => {
      const result = await handleGetEventObservers(pm, {
        filePath: FIXTURE_FILE,
        eventName: 'nonexistent_event',
      });
      const observers = (result as { observers: unknown[] }).observers;
      expect(observers).toEqual([]);
    });

    it('returns error when no parameters provided', async () => {
      const result = await handleGetEventObservers(pm, { filePath: FIXTURE_FILE });
      expect('error' in result).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // magento_get_template_overrides
  // -----------------------------------------------------------------------

  describe('magento_get_template_overrides', () => {
    it('finds theme overrides for a template', async () => {
      const result = await handleGetTemplateOverrides(pm, {
        filePath: FIXTURE_FILE,
        templateId: 'Test_Foo::product/list.phtml',
        area: 'frontend',
      });
      expect(result.templateId).toBe('Test_Foo::product/list.phtml');
      expect(result.moduleTemplate).not.toBeNull();
      expect(result.moduleTemplate).toContain('list.phtml');
      // Both parent and child themes override this template
      expect(result.themeOverrides.length).toBe(2);
    });

    it('finds layout XML usages for a template', async () => {
      const result = await handleGetTemplateOverrides(pm, {
        filePath: FIXTURE_FILE,
        templateId: 'Test_Foo::product/list.phtml',
        area: 'frontend',
      });
      expect(result.layoutUsages.length).toBeGreaterThanOrEqual(1);
      expect(result.layoutUsages[0].file).toContain('test_foo_index.xml');
    });

    it('returns empty results for unknown template', async () => {
      const result = await handleGetTemplateOverrides(pm, {
        filePath: FIXTURE_FILE,
        templateId: 'NonExistent_Module::nonexistent.phtml',
      });
      expect(result.moduleTemplate).toBeNull();
      expect(result.themeOverrides).toEqual([]);
      expect(result.layoutUsages).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // magento_get_class_context
  // -----------------------------------------------------------------------

  describe('magento_get_class_context', () => {
    it('resolves FQCN and returns full context for a class file', async () => {
      const fooFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/Foo.php');
      const result = await handleGetClassContext(pm, { filePath: fooFile });
      expect(result).not.toHaveProperty('error');
      expect(result.fqcn).toBe('Test\\Foo\\Model\\Foo');
      expect(result.module).toBe('Test_Foo');
    });

    it('returns plugins grouped by method', async () => {
      const fooFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/Foo.php');
      const result = await handleGetClassContext(pm, { filePath: fooFile });
      // Foo inherits plugins from FooInterface
      expect(Object.keys(result.pluginsByMethod!).length).toBeGreaterThan(0);
      expect(result.pluginsByMethod!['save']).toBeDefined();
      expect(result.pluginsByMethod!['save'][0].pluginClass).toBe('Custom\\Bar\\Plugin\\FooPlugin');
    });

    it('returns observer registrations for an observer class', async () => {
      const observerFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Observer/FooSaveObserver.php');
      const result = await handleGetClassContext(pm, { filePath: observerFile });
      expect(result.fqcn).toBe('Test\\Foo\\Observer\\FooSaveObserver');
      expect(result.events!.length).toBeGreaterThanOrEqual(1);
      expect(result.events![0].eventName).toBe('test_foo_save_after');
    });

    it('identifies a plugin class and its targets', async () => {
      const pluginFile = path.join(FIXTURE_ROOT, 'app/code/Custom/Bar/Plugin/FooPlugin.php');
      const result = await handleGetClassContext(pm, { filePath: pluginFile });
      expect(result.isPlugin).toBe(true);
      expect(result.pluginTargets).toContain('Test\\Foo\\Api\\FooInterface');
    });

    it('returns error for non-PHP file', async () => {
      const result = await handleGetClassContext(pm, { filePath: FIXTURE_FILE });
      expect(result).toHaveProperty('error');
    });
  });

  // -----------------------------------------------------------------------
  // magento_get_module_overview
  // -----------------------------------------------------------------------

  describe('magento_get_module_overview', () => {
    it('returns overview for a module by name', async () => {
      const result = await handleGetModuleOverview(pm, {
        filePath: FIXTURE_FILE,
        moduleName: 'Custom_Bar',
      });
      expect(result).not.toHaveProperty('error');
      expect(result.moduleName).toBe('Custom_Bar');
      // Custom_Bar declares a virtualType in its di.xml
      expect(result.virtualTypes!.length).toBeGreaterThanOrEqual(1);
    });

    it('detects module from file path', async () => {
      const barFile = path.join(FIXTURE_ROOT, 'app/code/Custom/Bar/Model/Bar.php');
      const result = await handleGetModuleOverview(pm, { filePath: barFile });
      expect(result.moduleName).toBe('Custom_Bar');
    });

    it('returns preferences declared by a module', async () => {
      const result = await handleGetModuleOverview(pm, {
        filePath: FIXTURE_FILE,
        moduleName: 'Test_Foo',
      });
      expect(result.preferences!.length).toBeGreaterThanOrEqual(1);
      const fooPref = result.preferences!.find(
        (p: { interface: string }) => p.interface === 'Test\\Foo\\Api\\FooInterface',
      );
      expect(fooPref).toBeDefined();
      expect(fooPref!.implementation).toBe('Test\\Foo\\Model\\Foo');
    });

    it('returns observers declared by a module', async () => {
      const result = await handleGetModuleOverview(pm, {
        filePath: FIXTURE_FILE,
        moduleName: 'Test_Foo',
      });
      expect(result.observers!.length).toBeGreaterThanOrEqual(1);
      expect(result.observers![0].observerClass).toBe('Test\\Foo\\Observer\\FooSaveObserver');
    });

    it('returns error for unknown module', async () => {
      const result = await handleGetModuleOverview(pm, {
        filePath: FIXTURE_FILE,
        moduleName: 'NonExistent_Module',
      });
      expect(result).toHaveProperty('error');
    });

    it('returns routes declared by a module', async () => {
      const result = await handleGetModuleOverview(pm, {
        filePath: FIXTURE_FILE,
        moduleName: 'Test_Foo',
      }) as any;
      expect(result.routes).toBeDefined();
      expect(result.routes.length).toBeGreaterThanOrEqual(1);
      expect(result.routes[0].frontName).toBe('testfoo');
      expect(result.routes[0].routerType).toBe('standard');
    });

    it('returns db tables declared by a module', async () => {
      const result = await handleGetModuleOverview(pm, {
        filePath: FIXTURE_FILE,
        moduleName: 'Test_Foo',
      }) as any;
      expect(result.dbTables).toBeDefined();
      expect(result.dbTables).toContain('test_entity');
      expect(result.dbTables).toContain('test_related');
    });

    it('returns ACL resources declared by a module', async () => {
      const result = await handleGetModuleOverview(pm, {
        filePath: FIXTURE_FILE,
        moduleName: 'Test_Foo',
      }) as any;
      expect(result.aclResources).toBeDefined();
      expect(result.aclResources.length).toBeGreaterThanOrEqual(1);
      const itemsResource = result.aclResources.find(
        (r: any) => r.id === 'Test_ModuleFoo::items',
      );
      expect(itemsResource).toBeDefined();
      expect(itemsResource.title).toBe('Items');
    });

    it('returns webapi endpoints declared by a module', async () => {
      const result = await handleGetModuleOverview(pm, {
        filePath: FIXTURE_FILE,
        moduleName: 'Test_Foo',
      }) as any;
      // Test_Foo's webapi.xml declares REST routes
      expect(result.webapiEndpoints).toBeDefined();
      // For small modules the full array is returned
      if (Array.isArray(result.webapiEndpoints)) {
        expect(result.webapiEndpoints.length).toBeGreaterThanOrEqual(1);
        expect(result.webapiEndpoints[0]).toHaveProperty('url');
        expect(result.webapiEndpoints[0]).toHaveProperty('httpMethod');
      }
    });

    it('returns full arrays for small modules (below summary threshold)', async () => {
      // Custom_Bar is a small module — should return full arrays, not counts
      const result = await handleGetModuleOverview(pm, {
        filePath: FIXTURE_FILE,
        moduleName: 'Custom_Bar',
      }) as any;
      expect(Array.isArray(result.preferences)).toBe(true);
      expect(Array.isArray(result.plugins)).toBe(true);
      expect(Array.isArray(result.virtualTypes)).toBe(true);
      expect(Array.isArray(result.observers)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Input validation
  // -----------------------------------------------------------------------

  describe('input validation', () => {
    it('rejects missing parameters object', async () => {
      await expect(handleGetDiConfig(pm, undefined)).rejects.toThrow('Missing parameters object');
    });

    it('rejects missing required string parameter', async () => {
      await expect(handleGetDiConfig(pm, { filePath: FIXTURE_FILE })).rejects.toThrow(
        'Missing or invalid required parameter: fqcn',
      );
    });

    it('rejects non-string required parameter', async () => {
      await expect(
        handleGetDiConfig(pm, { filePath: FIXTURE_FILE, fqcn: 123 }),
      ).rejects.toThrow('Missing or invalid required parameter: fqcn');
    });

    it('rejects empty string required parameter', async () => {
      await expect(
        handleGetDiConfig(pm, { filePath: FIXTURE_FILE, fqcn: '  ' }),
      ).rejects.toThrow('Missing or invalid required parameter: fqcn');
    });
  });

  // -----------------------------------------------------------------------
  // magento_resolve_class
  // -----------------------------------------------------------------------

  describe('magento_resolve_class', () => {
    it('resolves a PHP file to its FQCN', async () => {
      const fooFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/Foo.php');
      const result = await handleResolveClass(pm, { filePath: FIXTURE_FILE, phpFile: fooFile });
      expect(result).not.toHaveProperty('error');
      expect(result.resolvedFqcn).toBe('Test\\Foo\\Model\\Foo');
      expect(result.module).toBe('Test_Foo');
    });

    it('resolves a FQCN to its file path', async () => {
      const result = await handleResolveClass(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'Test\\Foo\\Model\\Foo',
      });
      expect(result).not.toHaveProperty('error');
      expect(result.resolvedFile).toContain('Foo.php');
      expect(result.module).toBe('Test_Foo');
    });

    it('returns both directions when both params provided', async () => {
      const fooFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/Foo.php');
      const result = await handleResolveClass(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'Test\\Foo\\Model\\Foo',
        phpFile: fooFile,
      });
      expect(result.resolvedFqcn).toBe('Test\\Foo\\Model\\Foo');
      expect(result.resolvedFile).toContain('Foo.php');
    });

    it('returns null for unknown FQCN', async () => {
      const result = await handleResolveClass(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'NonExistent\\Class\\Name',
      });
      expect(result.resolvedFile).toBeNull();
    });

    it('returns error when neither fqcn nor phpFile provided', async () => {
      const result = await handleResolveClass(pm, { filePath: FIXTURE_FILE });
      expect(result).toHaveProperty('error');
    });
  });

  // -----------------------------------------------------------------------
  // magento_search_symbols
  // -----------------------------------------------------------------------

  describe('magento_search_symbols', () => {
    it('matches DI-configured FQCNs with class file path', async () => {
      const result = await handleSearchSymbols(pm, {
        filePath: FIXTURE_FILE,
        query: 'FooInterface',
      }) as { resultCount: number; results: { name: string; kind: string; file: string; classFile?: string }[] };
      expect(result.resultCount).toBeGreaterThanOrEqual(1);
      const match = result.results.find((r) => r.name === 'Test\\Foo\\Api\\FooInterface');
      expect(match).toBeDefined();
      expect(match!.kind).toBe('class');
      expect(match!.classFile).toContain('FooInterface.php');
    });

    it('matches virtual types', async () => {
      const result = await handleSearchSymbols(pm, {
        filePath: FIXTURE_FILE,
        query: 'CustomBar',
      }) as { results: { name: string; kind: string }[] };
      const match = result.results.find((r) => r.kind === 'virtualType');
      expect(match).toBeDefined();
      expect(match!.name).toBe('CustomBarVirtual');
    });

    it('matches event names', async () => {
      const result = await handleSearchSymbols(pm, {
        filePath: FIXTURE_FILE,
        query: 'test_foo',
      }) as { results: { name: string; kind: string }[] };
      const events = result.results.filter((r) => r.kind === 'event');
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it('is case-insensitive', async () => {
      const result = await handleSearchSymbols(pm, {
        filePath: FIXTURE_FILE,
        query: 'foointerface',
      }) as { results: { name: string }[] };
      const match = result.results.find((r) => r.name === 'Test\\Foo\\Api\\FooInterface');
      expect(match).toBeDefined();
    });

    it('rejects queries shorter than 2 characters', async () => {
      const result = await handleSearchSymbols(pm, {
        filePath: FIXTURE_FILE,
        query: 'F',
      }) as { error: string };
      expect(result.error).toBeDefined();
    });

    it('returns empty results for no matches', async () => {
      const result = await handleSearchSymbols(pm, {
        filePath: FIXTURE_FILE,
        query: 'ZzNonExistentZz',
      }) as { resultCount: number; results: unknown[] };
      expect(result.resultCount).toBe(0);
      expect(result.results).toEqual([]);
    });

    it('matches database table names', async () => {
      const result = await handleSearchSymbols(pm, {
        filePath: FIXTURE_FILE,
        query: 'test_entity',
      }) as { results: { name: string; kind: string }[] };
      const tables = result.results.filter((r) => r.kind === 'table');
      expect(tables.length).toBeGreaterThanOrEqual(1);
      expect(tables.find((t) => t.name === 'test_entity')).toBeDefined();
    });

    it('matches ACL resource IDs', async () => {
      const result = await handleSearchSymbols(pm, {
        filePath: FIXTURE_FILE,
        query: 'ModuleFoo::items',
      }) as { results: { name: string; kind: string }[] };
      const acl = result.results.filter((r) => r.kind === 'aclResource');
      expect(acl.length).toBeGreaterThanOrEqual(1);
      expect(acl.find((a) => a.name === 'Test_ModuleFoo::items')).toBeDefined();
    });

    it('matches route frontNames', async () => {
      const result = await handleSearchSymbols(pm, {
        filePath: FIXTURE_FILE,
        query: 'testfoo',
      }) as { results: { name: string; kind: string }[] };
      const routes = result.results.filter((r) => r.kind === 'route');
      expect(routes.length).toBeGreaterThanOrEqual(1);
      expect(routes[0].name).toBe('testfoo');
    });
  });

  // -----------------------------------------------------------------------
  // magento_get_class_hierarchy
  // -----------------------------------------------------------------------

  describe('magento_get_class_hierarchy', () => {
    it('returns interfaces for a class that implements an interface', async () => {
      const result = await handleGetClassHierarchy(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'Test\\Foo\\Model\\Foo',
      }) as { parentClass: string | null; interfaces: string[]; ancestors: string[] };
      expect(result.parentClass).toBeNull();
      expect(result.interfaces).toContain('Test\\Foo\\Api\\FooInterface');
    });

    it('returns parent class and interfaces for a class with both', async () => {
      const result = await handleGetClassHierarchy(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'Test\\Foo\\Model\\Storage',
      }) as { parentClass: string | null; interfaces: string[]; ancestors: string[] };
      expect(result.parentClass).toBe('Test\\Foo\\Model\\DataObject');
      expect(result.interfaces).toContain('Test\\Foo\\Api\\StorageInterface');
    });

    it('returns full ancestor chain', async () => {
      const result = await handleGetClassHierarchy(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'Test\\Foo\\Model\\Storage',
      }) as { ancestors: string[] };
      expect(result.ancestors).toContain('Test\\Foo\\Model\\DataObject');
      expect(result.ancestors).toContain('Test\\Foo\\Api\\StorageInterface');
    });

    it('returns classFile and module', async () => {
      const result = await handleGetClassHierarchy(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'Test\\Foo\\Model\\Foo',
      }) as { classFile: string | null; module: string | null };
      expect(result.classFile).toContain('Foo.php');
      expect(result.module).toBe('Test_Foo');
    });

    it('returns empty results for unknown FQCN', async () => {
      const result = await handleGetClassHierarchy(pm, {
        filePath: FIXTURE_FILE,
        fqcn: 'NonExistent\\Class\\Name',
      }) as { parentClass: string | null; interfaces: string[]; ancestors: string[]; classFile: string | null };
      expect(result.parentClass).toBeNull();
      expect(result.interfaces).toEqual([]);
      expect(result.ancestors).toEqual([]);
      expect(result.classFile).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // magento_get_db_schema
  // -----------------------------------------------------------------------

  describe('magento_get_db_schema', () => {
    it('returns merged table schema with columns from multiple modules', async () => {
      const result = await handleGetDbSchema(pm, {
        filePath: FIXTURE_FILE,
        tableName: 'test_entity',
      }) as any;
      expect(result.tableName).toBe('test_entity');
      expect(result.comment).toBe('Test Entity Table');
      expect(result.resource).toBe('default');
      expect(result.engine).toBe('innodb');

      // Columns from Test_Foo: entity_id, name, store_id
      // Column from Custom_Bar: custom_attribute
      expect(result.columns.length).toBeGreaterThanOrEqual(4);
      const colNames = result.columns.map((c: any) => c.name);
      expect(colNames).toContain('entity_id');
      expect(colNames).toContain('name');
      expect(colNames).toContain('store_id');
      expect(colNames).toContain('custom_attribute');
    });

    it('returns column metadata', async () => {
      const result = await handleGetDbSchema(pm, {
        filePath: FIXTURE_FILE,
        tableName: 'test_entity',
      }) as any;
      const entityId = result.columns.find((c: any) => c.name === 'entity_id');
      expect(entityId).toBeDefined();
      expect(entityId.type).toBe('int');
      expect(entityId.identity).toBe(true);
      expect(entityId.nullable).toBe(false);
      expect(entityId.unsigned).toBe(true);
      expect(entityId.comment).toBe('Entity ID');
    });

    it('returns foreign key constraints', async () => {
      const result = await handleGetDbSchema(pm, {
        filePath: FIXTURE_FILE,
        tableName: 'test_entity',
      }) as any;
      expect(result.foreignKeys.length).toBeGreaterThanOrEqual(1);
      const storeFk = result.foreignKeys.find(
        (fk: any) => fk.referenceTable === 'store',
      );
      expect(storeFk).toBeDefined();
      expect(storeFk.column).toBe('store_id');
      expect(storeFk.referenceColumn).toBe('store_id');
      expect(storeFk.onDelete).toBe('CASCADE');
    });

    it('returns declaring modules', async () => {
      const result = await handleGetDbSchema(pm, {
        filePath: FIXTURE_FILE,
        tableName: 'test_entity',
      }) as any;
      const moduleNames = result.declaredIn.map((d: any) => d.module);
      expect(moduleNames).toContain('Test_Foo');
      expect(moduleNames).toContain('Custom_Bar');
    });

    it('returns error for unknown table', async () => {
      const result = await handleGetDbSchema(pm, {
        filePath: FIXTURE_FILE,
        tableName: 'nonexistent_table',
      }) as any;
      expect(result.error).toBeDefined();
      expect(result.tableName).toBe('nonexistent_table');
    });

    it('rejects missing tableName parameter', async () => {
      await expect(
        handleGetDbSchema(pm, { filePath: FIXTURE_FILE }),
      ).rejects.toThrow('Missing or invalid required parameter: tableName');
    });
  });

  // -----------------------------------------------------------------------
  // magento_rescan_project
  // -----------------------------------------------------------------------

  describe('magento_rescan_project', () => {
    it('rebuilds the project and returns a summary', async () => {
      const result = await handleRescanProject(pm, { filePath: FIXTURE_FILE }) as {
        projectRoot: string;
        moduleCount: number;
        diXmlFiles: number;
        eventsXmlFiles: number;
        layoutXmlFiles: number;
        themes: number;
      };
      expect(result.moduleCount).toBeGreaterThan(0);
      expect(result.diXmlFiles).toBeGreaterThan(0);
      expect(result.eventsXmlFiles).toBeGreaterThan(0);
    });
  });
});
