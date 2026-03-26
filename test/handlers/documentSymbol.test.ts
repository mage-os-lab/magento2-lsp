import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { SymbolKind } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { handleDocumentSymbol } from '../../src/handlers/documentSymbol';
import { ProjectManager, ProjectContext } from '../../src/project/projectManager';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');
const MODULE_FOO = path.join(FIXTURE_ROOT, 'vendor/test/module-foo');

describe('handleDocumentSymbol', () => {
  let project: ProjectContext;

  beforeAll(async () => {
    const pm = new ProjectManager();
    project = (await pm.ensureProject(FIXTURE_ROOT))!;
  });

  function getProject(): ProjectContext | undefined {
    return project;
  }

  function callHandler(filePath: string) {
    return handleDocumentSymbol(
      { textDocument: { uri: URI.file(filePath).toString() } },
      getProject,
    );
  }

  // --- Non-XML files return null ---

  it('returns null for PHP files', () => {
    const result = callHandler(path.join(MODULE_FOO, 'Model/Foo.php'));
    expect(result).toBeNull();
  });

  // --- di.xml ---

  describe('di.xml', () => {
    it('returns symbols for preferences, types, and arguments', () => {
      const result = callHandler(path.join(MODULE_FOO, 'etc/di.xml'));
      expect(result).not.toBeNull();
      expect(result!.length).toBeGreaterThan(0);
    });

    it('includes preference symbols with interface → implementation name', () => {
      const result = callHandler(path.join(MODULE_FOO, 'etc/di.xml'))!;
      const prefs = result.filter((s) => s.kind === SymbolKind.Interface);
      expect(prefs.length).toBe(2);
      // Should show "Interface → Implementation" format
      expect(prefs[0].name).toContain('→');
      expect(prefs[0].detail).toBe('Preference');
    });

    it('includes type symbols', () => {
      const result = callHandler(path.join(MODULE_FOO, 'etc/di.xml'))!;
      const types = result.filter((s) => s.kind === SymbolKind.Class && s.detail === 'Type');
      expect(types.length).toBeGreaterThanOrEqual(1);
      expect(types[0].name).toBe('Test\\Foo\\Model\\Foo');
    });

    it('uses Interface kind for type names ending in Interface', () => {
      // etc/frontend/di.xml has <type name="Test\Foo\Api\FooInterface">
      const result = callHandler(path.join(MODULE_FOO, 'etc/frontend/di.xml'))!;
      const iface = result.find((s) => s.name === 'Test\\Foo\\Api\\FooInterface');
      expect(iface).toBeDefined();
      expect(iface!.kind).toBe(SymbolKind.Interface);
      expect(iface!.detail).toBe('Type');
    });
  });

  // --- events.xml ---

  describe('events.xml', () => {
    it('returns event symbols with nested observers', () => {
      const result = callHandler(path.join(MODULE_FOO, 'etc/events.xml'));
      expect(result).not.toBeNull();

      // Should have 2 events
      const events = result!.filter((s) => s.kind === SymbolKind.Event);
      expect(events.length).toBe(2);
    });

    it('nests observers under their event', () => {
      const result = callHandler(path.join(MODULE_FOO, 'etc/events.xml'))!;
      const secondEvent = result.find((s) => s.name === 'test_foo_load_after');
      expect(secondEvent).toBeDefined();
      // test_foo_load_after has 2 observers
      expect(secondEvent!.children).toHaveLength(2);
      expect(secondEvent!.children![0].kind).toBe(SymbolKind.Class);
    });

    it('uses observer FQCN as name and observer name as detail', () => {
      const result = callHandler(path.join(MODULE_FOO, 'etc/events.xml'))!;
      const firstEvent = result.find((s) => s.name === 'test_foo_save_after');
      expect(firstEvent!.children).toHaveLength(1);
      expect(firstEvent!.children![0].name).toBe('Test\\Foo\\Observer\\FooSaveObserver');
      expect(firstEvent!.children![0].detail).toBe('foo_save_observer');
    });
  });

  // --- layout XML ---

  describe('layout XML', () => {
    it('returns hierarchical symbols with body as root', () => {
      const result = callHandler(path.join(MODULE_FOO, 'view/frontend/layout/test_foo_index.xml'));
      expect(result).not.toBeNull();

      // Root should be <body>
      const body = result!.find((s) => s.name === 'body');
      expect(body).toBeDefined();
      expect(body!.kind).toBe(SymbolKind.Namespace);
    });

    it('nests blocks under body with class as detail', () => {
      const result = callHandler(path.join(MODULE_FOO, 'view/frontend/layout/test_foo_index.xml'))!;
      const body = result.find((s) => s.name === 'body')!;

      // <block name="foo.list" class="Test\Foo\Block\FooList"> nested under body
      expect(body.children).toBeDefined();
      const block = body.children!.find((s) => s.name === 'foo.list');
      expect(block).toBeDefined();
      expect(block!.kind).toBe(SymbolKind.Class);
      // Detail shows short class name
      expect(block!.detail).toBe('FooList');
    });
  });

  // --- webapi.xml ---

  describe('webapi.xml', () => {
    it('returns symbols for service classes, methods, and resources', () => {
      const result = callHandler(path.join(MODULE_FOO, 'etc/webapi.xml'));
      expect(result).not.toBeNull();

      // Should have service-class, service-method, and resource-ref symbols
      const interfaces = result!.filter((s) => s.kind === SymbolKind.Interface);
      const methods = result!.filter((s) => s.kind === SymbolKind.Method);
      const resources = result!.filter((s) => s.kind === SymbolKind.Key);
      expect(interfaces.length).toBeGreaterThan(0);
      expect(methods.length).toBeGreaterThan(0);
      expect(resources.length).toBeGreaterThan(0);
    });

    it('includes route context in detail', () => {
      const result = callHandler(path.join(MODULE_FOO, 'etc/webapi.xml'))!;
      const firstInterface = result.find((s) => s.kind === SymbolKind.Interface);
      expect(firstInterface!.detail).toContain('GET');
      expect(firstInterface!.detail).toContain('/V1/test/items');
    });
  });

  // --- acl.xml ---

  describe('acl.xml', () => {
    it('returns hierarchical resource tree', () => {
      const result = callHandler(path.join(MODULE_FOO, 'etc/acl.xml'));
      expect(result).not.toBeNull();

      // Root should be Magento_Backend::admin (title: "Magento Admin")
      expect(result!.length).toBe(1);
      expect(result![0].name).toBe('Magento Admin');
    });

    it('nests child resources under parents', () => {
      const result = callHandler(path.join(MODULE_FOO, 'etc/acl.xml'))!;

      // Magento Admin > Items > (View Items, Manage Items)
      const admin = result[0];
      expect(admin.children).toHaveLength(1); // Items
      const items = admin.children![0];
      expect(items.name).toBe('Items');
      expect(items.children).toHaveLength(2); // View Items, Manage Items
    });

    it('shows title as name and ID as detail when title exists', () => {
      const result = callHandler(path.join(MODULE_FOO, 'etc/acl.xml'))!;
      const admin = result[0];
      expect(admin.name).toBe('Magento Admin');
      expect(admin.detail).toBe('Magento_Backend::admin');
    });
  });

  // --- menu.xml ---

  describe('menu.xml', () => {
    it('returns menu item symbols', () => {
      const result = callHandler(path.join(MODULE_FOO, 'etc/adminhtml/menu.xml'));
      expect(result).not.toBeNull();
      expect(result!.length).toBe(2);
    });

    it('uses menu item title as name and ACL resource as detail', () => {
      const result = callHandler(path.join(MODULE_FOO, 'etc/adminhtml/menu.xml'))!;
      expect(result[0].name).toBe('Foo Items');
      expect(result[0].detail).toContain('Test_ModuleFoo::items');
    });
  });

  // --- UI component XML ---

  describe('UI component XML', () => {
    it('returns ACL resource symbols', () => {
      const result = callHandler(path.join(MODULE_FOO, 'view/adminhtml/ui_component/foo_listing.xml'));
      expect(result).not.toBeNull();
      const aclSymbols = result!.filter((s) => s.detail === 'ACL Resource');
      expect(aclSymbols.length).toBeGreaterThanOrEqual(1);
    });
  });
});
