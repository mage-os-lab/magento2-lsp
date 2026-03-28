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

  describe('UI component XML — listing', () => {
    let result: ReturnType<typeof callHandler>;

    beforeAll(() => {
      result = callHandler(path.join(MODULE_FOO, 'view/adminhtml/ui_component/foo_listing.xml'));
    });

    it('returns a listing root symbol', () => {
      expect(result).not.toBeNull();
      expect(result!.length).toBe(1);
      expect(result![0].name).toBe('listing');
      expect(result![0].kind).toBe(SymbolKind.Namespace);
    });

    it('listing contains dataSource, toolbar, and columns as children', () => {
      const root = result![0];
      const childNames = root.children!.map((c) => c.name);
      expect(childNames).toContain('foo_listing_data_source');
      expect(childNames).toContain('listing_top');
      expect(childNames).toContain('foo_listing_columns');
    });

    it('dataSource is Object kind with aclResource and dataProvider children', () => {
      const ds = result![0].children!.find((c) => c.name === 'foo_listing_data_source')!;
      expect(ds.kind).toBe(SymbolKind.Object);
      // aclResource: name is the element name, detail is the text value
      const acl = ds.children!.find((c) => c.name === 'ACL Resource')!;
      expect(acl.kind).toBe(SymbolKind.Key);
      expect(acl.detail).toBe('Test_ModuleFoo::items');
      // dataProvider is Class with short class name as detail
      const dp = ds.children!.find((c) => c.kind === SymbolKind.Class)!;
      expect(dp.detail).toBe('DataProvider');
    });

    it('toolbar contains bookmark, filters, massaction, paging, and export children', () => {
      const toolbar = result![0].children!.find((c) => c.name === 'listing_top')!;
      expect(toolbar.kind).toBe(SymbolKind.Namespace);
      expect(toolbar.detail).toBe('toolbar');
      const childNames = toolbar.children!.map((c) => c.name);
      expect(childNames).toContain('bookmarks');
      expect(childNames).toContain('listing_filters');
      expect(childNames).toContain('fulltext');
      expect(childNames).toContain('listing_massaction');
      expect(childNames).toContain('listing_paging');
      expect(childNames).toContain('export_button');
    });

    it('massaction is Enum kind and contains action children', () => {
      const toolbar = result![0].children!.find((c) => c.name === 'listing_top')!;
      const massaction = toolbar.children!.find((c) => c.name === 'listing_massaction')!;
      expect(massaction.kind).toBe(SymbolKind.Enum);
      expect(massaction.children).toHaveLength(2);
      expect(massaction.children![0].name).toBe('delete');
      expect(massaction.children![0].kind).toBe(SymbolKind.Function);
      expect(massaction.children![1].name).toBe('status');
    });

    it('exportButton is Function kind', () => {
      const toolbar = result![0].children!.find((c) => c.name === 'listing_top')!;
      const exp = toolbar.children!.find((c) => c.name === 'export_button')!;
      expect(exp.kind).toBe(SymbolKind.Function);
      expect(exp.detail).toBe('export');
    });

    it('columns is Array kind with column children', () => {
      const cols = result![0].children!.find((c) => c.name === 'foo_listing_columns')!;
      expect(cols.kind).toBe(SymbolKind.Array);
      expect(cols.children!.length).toBe(5);
    });

    it('column shows xsi:type as detail', () => {
      const cols = result![0].children!.find((c) => c.name === 'foo_listing_columns')!;
      const entityId = cols.children!.find((c) => c.name === 'entity_id')!;
      expect(entityId.kind).toBe(SymbolKind.Field);
      expect(entityId.detail).toBe('number');
    });

    it('selectColumn shows selectColumn as detail', () => {
      const cols = result![0].children!.find((c) => c.name === 'foo_listing_columns')!;
      const ids = cols.children!.find((c) => c.name === 'ids')!;
      expect(ids.kind).toBe(SymbolKind.Field);
      expect(ids.detail).toBe('selectColumn');
    });

    it('actionsColumn shows short class name as detail', () => {
      const cols = result![0].children!.find((c) => c.name === 'foo_listing_columns')!;
      const actions = cols.children!.find((c) => c.name === 'actions')!;
      expect(actions.kind).toBe(SymbolKind.Field);
      expect(actions.detail).toBe('Actions');
    });

    it('column settings contains label, sorting, and other text-content children', () => {
      const cols = result![0].children!.find((c) => c.name === 'foo_listing_columns')!;
      const entityId = cols.children!.find((c) => c.name === 'entity_id')!;
      const settings = entityId.children!.find((c) => c.name === 'settings')!;
      expect(settings.kind).toBe(SymbolKind.Namespace);
      const childNames = settings.children!.map((c) => c.name);
      expect(childNames).toContain('label');
      expect(childNames).toContain('sorting');
      const label = settings.children!.find((c) => c.name === 'label')!;
      expect(label.detail).toBe('ID');
      expect(label.kind).toBe(SymbolKind.String);
    });
  });

  describe('UI component XML — form', () => {
    let result: ReturnType<typeof callHandler>;

    beforeAll(() => {
      result = callHandler(path.join(MODULE_FOO, 'view/adminhtml/ui_component/foo_form.xml'));
    });

    it('returns a form root symbol', () => {
      expect(result).not.toBeNull();
      expect(result!.length).toBe(1);
      expect(result![0].name).toBe('form');
      expect(result![0].kind).toBe(SymbolKind.Namespace);
    });

    it('form contains dataSource and fieldsets as children', () => {
      const root = result![0];
      const childNames = root.children!.map((c) => c.name);
      expect(childNames).toContain('foo_form_data_source');
      expect(childNames).toContain('general');
      expect(childNames).toContain('content');
    });

    it('fieldset contains field children with formElement as detail', () => {
      const general = result![0].children!.find((c) => c.name === 'general')!;
      expect(general.kind).toBe(SymbolKind.Namespace);
      const title = general.children!.find((c) => c.name === 'title')!;
      expect(title.kind).toBe(SymbolKind.Field);
      expect(title.detail).toBe('input');
      const status = general.children!.find((c) => c.name === 'status')!;
      expect(status.detail).toBe('select');
    });

    it('container nests button children', () => {
      const general = result![0].children!.find((c) => c.name === 'general')!;
      const container = general.children!.find((c) => c.name === 'button_container')!;
      expect(container.kind).toBe(SymbolKind.Namespace);
      expect(container.children).toHaveLength(2);
      expect(container.children![0].name).toBe('save_button');
      expect(container.children![0].kind).toBe(SymbolKind.Function);
    });

    it('dataProvider shows short class name as detail', () => {
      const ds = result![0].children!.find((c) => c.name === 'foo_form_data_source')!;
      const dp = ds.children!.find((c) => c.kind === SymbolKind.Class)!;
      expect(dp.detail).toBe('DataProvider');
    });

    it('second fieldset has settings and field children', () => {
      const content = result![0].children!.find((c) => c.name === 'content')!;
      const childNames = content.children!.map((c) => c.name);
      expect(childNames).toContain('settings');
      expect(childNames).toContain('description');
      const desc = content.children!.find((c) => c.name === 'description')!;
      expect(desc.detail).toBe('textarea');
    });

    it('settings contains label as String child with text value as detail', () => {
      const content = result![0].children!.find((c) => c.name === 'content')!;
      const settings = content.children!.find((c) => c.name === 'settings')!;
      expect(settings.kind).toBe(SymbolKind.Namespace);
      const label = settings.children!.find((c) => c.name === 'label')!;
      expect(label.detail).toBe('Content');
      expect(label.kind).toBe(SymbolKind.String);
    });
  });
});
