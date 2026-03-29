import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { URI } from 'vscode-uri';
import { CompletionItemKind, CompletionList } from 'vscode-languageserver';
import { handleCompletion } from '../../src/handlers/completion';
import { ProjectManager, ProjectContext } from '../../src/project/projectManager';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('handleCompletion', () => {
  let project: ProjectContext;

  beforeAll(async () => {
    const pm = new ProjectManager();
    project = (await pm.ensureProject(FIXTURE_ROOT))!;
  });

  // --- Helpers ----------------------------------------------------------------

  /**
   * Return the project for any file path — all test files belong to a single
   * fixture project so the path argument is ignored.
   */
  function getProject(_uri: string): ProjectContext | undefined {
    return project;
  }

  /**
   * Read a fixture file from disk (simulates the server's document cache for real files).
   */
  function getDocumentText(uri: string): string | undefined {
    const filePath = URI.parse(uri).fsPath;
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return undefined;
    }
  }

  /**
   * Core helper for all completion tests.
   *
   * Provides a synthetic document `content` at `filePath`. The handler will see
   * this content via the custom `getText` callback instead of reading from disk.
   * The cursor is placed at the given 0-based (line, col) position.
   *
   * @param filePath - Absolute path that determines the file type (di.xml, events.xml, etc.).
   * @param content  - Synthetic XML or PHP document text.
   * @param line     - 0-based line number of the cursor.
   * @param col      - 0-based column number of the cursor.
   * @returns The CompletionList or null.
   */
  function completionAt(
    filePath: string,
    content: string,
    line: number,
    col: number,
  ): CompletionList | null {
    const uri = URI.file(filePath).toString();
    const params = {
      textDocument: { uri },
      position: { line, character: col },
    };
    // Override getDocumentText to return the synthetic content for this URI
    const getText = (u: string) => (u === uri ? content : undefined);
    return handleCompletion(params, getProject, getText);
  }

  /**
   * Count the column where `needle` starts in `line`.
   * Throws if `needle` is not found.
   */
  function colOf(line: string, needle: string): number {
    const idx = line.indexOf(needle);
    if (idx === -1) throw new Error(`"${needle}" not found in: ${line}`);
    return idx;
  }

  // ─── 1. Basic behaviour tests ──────────────────────────────────────────────

  describe('basic behaviour', () => {
    it('returns null for unsupported file types (.txt)', () => {
      const txtPath = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/README.txt');
      const result = completionAt(txtPath, 'hello world', 0, 5);
      expect(result).toBeNull();
    });

    it('returns null for unsupported file types (.json)', () => {
      const jsonPath = path.join(FIXTURE_ROOT, 'composer.json');
      const result = completionAt(jsonPath, '{"name": "test"}', 0, 10);
      expect(result).toBeNull();
    });

    it('returns null when no project is found', () => {
      const diXmlPath = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
      const uri = URI.file(diXmlPath).toString();
      const params = {
        textDocument: { uri },
        position: { line: 0, character: 0 },
      };
      // Pass a getProject that always returns undefined
      const noProject = () => undefined;
      const result = handleCompletion(params, noProject, getDocumentText);
      expect(result).toBeNull();
    });

    it('returns null for cursor positions outside completable contexts (XML declaration)', () => {
      const diXmlPath = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
      const xml = `<?xml version="1.0"?>
<config>
</config>`;
      // Cursor on the XML declaration line, col 5 — not inside any attribute value
      const result = completionAt(diXmlPath, xml, 0, 5);
      expect(result).toBeNull();
    });

    it('returns null when cursor is on an element name (not in attribute value or text)', () => {
      const diXmlPath = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
      const xml = `<?xml version="1.0"?>
<config>
    <preference for="" type=""/>
</config>`;
      // Cursor on "preference" tag name itself, not in an attribute
      const line2 = '    <preference for="" type=""/>';
      const col = colOf(line2, 'preference');
      const result = completionAt(diXmlPath, xml, 2, col);
      expect(result).toBeNull();
    });

    it('returns null inside an XML comment', () => {
      const diXmlPath = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
      const xml = `<?xml version="1.0"?>
<config>
    <!-- <preference for="" type=""/> -->
</config>`;
      // Cursor inside the comment where for="" would be
      const result = completionAt(diXmlPath, xml, 2, 30);
      expect(result).toBeNull();
    });

    it('returns null for an empty XML document', () => {
      const diXmlPath = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
      const result = completionAt(diXmlPath, '', 0, 0);
      expect(result).toBeNull();
    });

    it('returns null for acl.xml (definition file, not a reference context)', () => {
      const aclPath = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/acl.xml');
      const xml = `<?xml version="1.0"?>
<config>
    <acl>
        <resources>
            <resource id="" title="Test"/>
        </resources>
    </acl>
</config>`;
      const line4 = '            <resource id="" title="Test"/>';
      const col = colOf(line4, 'id="') + 4; // inside the id="" attribute
      const result = completionAt(aclPath, xml, 4, col);
      expect(result).toBeNull();
    });
  });

  // ─── 2. di.xml completion tests ────────────────────────────────────────────

  describe('di.xml completions', () => {
    // Use a path within the project that looks like a di.xml file
    const diXmlPath = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');

    it('completes FQCNs for preference for= attribute', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <preference for="" type="Test\\Foo\\Model\\Foo"/>
</config>`;
      // Cursor inside for="" — right after the opening quote
      const line2 = '    <preference for="" type="Test\\Foo\\Model\\Foo"/>';
      const col = colOf(line2, 'for="') + 5; // position inside the empty quotes
      const result = completionAt(diXmlPath, xml, 2, col);

      expect(result).not.toBeNull();
      expect(result!.isIncomplete).toBe(true);
      expect(result!.items.length).toBeGreaterThan(0);
      // All items should be Class kind (FQCNs)
      expect(result!.items[0].kind).toBe(CompletionItemKind.Class);
      // Each item should have a textEdit that replaces the full attribute value
      const textEdit = result!.items[0].textEdit!;
      expect(textEdit).toBeDefined();
      expect('range' in textEdit).toBe(true);
      if ('range' in textEdit) {
        expect(textEdit.range.start.line).toBe(2);
        expect(textEdit.range.end.line).toBe(2);
        expect(textEdit.newText).toBe(result!.items[0].label);
      }
    });

    it('completes FQCNs for preference type= attribute', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <preference for="Test\\Foo\\Api\\FooInterface" type=""/>
</config>`;
      const line2 = '    <preference for="Test\\Foo\\Api\\FooInterface" type=""/>';
      const col = colOf(line2, 'type="') + 6;
      const result = completionAt(diXmlPath, xml, 2, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Class);
    });

    it('filters completions by partial text in preference for= attribute', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <preference for="Test\\Foo" type=""/>
</config>`;
      const line2 = '    <preference for="Test\\Foo" type=""/>';
      // Place cursor at the end of "Test\\Foo" (right before closing quote)
      const col = colOf(line2, 'Test\\Foo"') + 'Test\\Foo'.length;
      const result = completionAt(diXmlPath, xml, 2, col);

      expect(result).not.toBeNull();
      // All results should contain "Test\Foo" (case-insensitive substring match)
      for (const item of result!.items) {
        expect(item.label.toLowerCase()).toContain('test\\foo');
      }
    });

    it('completes FQCNs for type name= attribute', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <type name="">
    </type>
</config>`;
      const line2 = '    <type name="">';
      const col = colOf(line2, 'name="') + 6;
      const result = completionAt(diXmlPath, xml, 2, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Class);
    });

    it('completes FQCNs for plugin type= attribute', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <type name="Some\\Class">
        <plugin name="test" type=""/>
    </type>
</config>`;
      const line3 = '        <plugin name="test" type=""/>';
      const col = colOf(line3, 'type="') + 6;
      const result = completionAt(diXmlPath, xml, 3, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Class);
    });

    it('completes FQCNs for virtualType type= attribute', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <virtualType name="MyVirtual" type=""/>
</config>`;
      const line2 = '    <virtualType name="MyVirtual" type=""/>';
      const col = colOf(line2, 'type="') + 6;
      const result = completionAt(diXmlPath, xml, 2, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Class);
    });

    it('completes FQCNs and virtual types for argument xsi:type="object" text content', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <type name="Some\\Class">
        <arguments>
            <argument name="dep" xsi:type="object"></argument>
        </arguments>
    </type>
</config>`;
      const line4 = '            <argument name="dep" xsi:type="object"></argument>';
      // Cursor inside text content, right before </argument>
      const col = colOf(line4, '</argument>');
      const result = completionAt(diXmlPath, xml, 4, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      // Should include both real classes and virtual types
      expect(result!.items[0].kind).toBe(CompletionItemKind.Class);
    });

    it('does not complete for unsupported attributes in di.xml', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <plugin name="" type="Some\\Class"/>
</config>`;
      // Cursor inside plugin name="" — not a completable attribute
      const line2 = '    <plugin name="" type="Some\\Class"/>';
      const col = colOf(line2, 'name="') + 6;
      const result = completionAt(diXmlPath, xml, 2, col);

      expect(result).toBeNull();
    });
  });

  // ─── 3. events.xml completion tests ────────────────────────────────────────

  describe('events.xml completions', () => {
    const eventsXmlPath = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/events.xml');

    it('completes event names for event name= attribute', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <event name="">
        <observer name="test" instance="Test\\Observer"/>
    </event>
</config>`;
      const line2 = '    <event name="">';
      const col = colOf(line2, 'name="') + 6;
      const result = completionAt(eventsXmlPath, xml, 2, col);

      expect(result).not.toBeNull();
      expect(result!.items[0].kind).toBe(CompletionItemKind.Event);
      // The fixture defines test_foo_save_after and test_foo_load_after
      const labels = result!.items.map((i) => i.label);
      expect(labels).toContain('test_foo_save_after');
      expect(labels).toContain('test_foo_load_after');
    });

    it('filters event names by partial text', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <event name="test_foo_save">
        <observer name="test" instance="Test\\Observer"/>
    </event>
</config>`;
      const line2 = '    <event name="test_foo_save">';
      const col = colOf(line2, 'test_foo_save"') + 'test_foo_save'.length;
      const result = completionAt(eventsXmlPath, xml, 2, col);

      expect(result).not.toBeNull();
      // Should only include events matching "test_foo_save"
      for (const item of result!.items) {
        expect(item.label.toLowerCase()).toContain('test_foo_save');
      }
    });

    it('completes FQCNs for observer instance= attribute', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <event name="test_event">
        <observer name="test" instance=""/>
    </event>
</config>`;
      const line3 = '        <observer name="test" instance=""/>';
      const col = colOf(line3, 'instance="') + 10;
      const result = completionAt(eventsXmlPath, xml, 3, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Class);
    });
  });

  // ─── 4. Layout XML completion tests ────────────────────────────────────────

  describe('layout XML completions', () => {
    const layoutXmlPath = path.join(
      FIXTURE_ROOT,
      'vendor/test/module-foo/view/frontend/layout/test_foo_index.xml',
    );

    it('completes FQCNs for block class= attribute', () => {
      const xml = `<?xml version="1.0"?>
<page>
    <body>
        <block class="" name="test.block"/>
    </body>
</page>`;
      const line3 = '        <block class="" name="test.block"/>';
      const col = colOf(line3, 'class="') + 7;
      const result = completionAt(layoutXmlPath, xml, 3, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Class);
    });

    it('completes template IDs for block template= attribute', () => {
      const xml = `<?xml version="1.0"?>
<page>
    <body>
        <block class="Magento\\Block" name="test" template=""/>
    </body>
</page>`;
      const line3 = '        <block class="Magento\\Block" name="test" template=""/>';
      const col = colOf(line3, 'template="') + 10;
      const result = completionAt(layoutXmlPath, xml, 3, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.File);
    });

    it('completes handle names for update handle= attribute', () => {
      const xml = `<?xml version="1.0"?>
<page>
    <body>
        <update handle=""/>
    </body>
</page>`;
      const line3 = '        <update handle=""/>';
      const col = colOf(line3, 'handle="') + 8;
      const result = completionAt(layoutXmlPath, xml, 3, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Reference);
    });

    it('completes block names for referenceBlock name= attribute', () => {
      const xml = `<?xml version="1.0"?>
<page>
    <body>
        <referenceBlock name=""/>
    </body>
</page>`;
      const line3 = '        <referenceBlock name=""/>';
      const col = colOf(line3, 'name="') + 6;
      const result = completionAt(layoutXmlPath, xml, 3, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Reference);
    });

    it('completes container names for referenceContainer name= attribute', () => {
      const xml = `<?xml version="1.0"?>
<page>
    <body>
        <referenceContainer name=""/>
    </body>
</page>`;
      const line3 = '        <referenceContainer name=""/>';
      const col = colOf(line3, 'name="') + 6;
      const result = completionAt(layoutXmlPath, xml, 3, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Reference);
    });

    it('completes block/container names for move element= attribute', () => {
      const xml = `<?xml version="1.0"?>
<page>
    <body>
        <move element="" destination="some.container"/>
    </body>
</page>`;
      const line3 = '        <move element="" destination="some.container"/>';
      const col = colOf(line3, 'element="') + 9;
      const result = completionAt(layoutXmlPath, xml, 3, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Reference);
    });

    it('completes container names for move destination= attribute', () => {
      const xml = `<?xml version="1.0"?>
<page>
    <body>
        <move element="foo.block" destination=""/>
    </body>
</page>`;
      const line3 = '        <move element="foo.block" destination=""/>';
      const col = colOf(line3, 'destination="') + 13;
      const result = completionAt(layoutXmlPath, xml, 3, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Reference);
    });

    it('completes FQCNs for argument xsi:type="object" in layout XML', () => {
      const xml = `<?xml version="1.0"?>
<page>
    <body>
        <block class="Test\\Block" name="test">
            <arguments>
                <argument name="viewModel" xsi:type="object"></argument>
            </arguments>
        </block>
    </body>
</page>`;
      const line5 = '                <argument name="viewModel" xsi:type="object"></argument>';
      const col = colOf(line5, '</argument>');
      const result = completionAt(layoutXmlPath, xml, 5, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Class);
    });
  });

  // ─── 5. webapi.xml completion tests ────────────────────────────────────────

  describe('webapi.xml completions', () => {
    const webapiXmlPath = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/webapi.xml');

    it('completes service classes for service class= attribute', () => {
      const xml = `<?xml version="1.0"?>
<routes>
    <route url="/V1/test" method="GET">
        <service class="" method="getList"/>
    </route>
</routes>`;
      const line3 = '        <service class="" method="getList"/>';
      const col = colOf(line3, 'class="') + 7;
      const result = completionAt(webapiXmlPath, xml, 3, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Class);
    });

    it('completes ACL resource IDs for resource ref= attribute', () => {
      const xml = `<?xml version="1.0"?>
<routes>
    <route url="/V1/test" method="GET">
        <service class="Test\\Api" method="get"/>
        <resources>
            <resource ref=""/>
        </resources>
    </route>
</routes>`;
      const line5 = '            <resource ref=""/>';
      const col = colOf(line5, 'ref="') + 5;
      const result = completionAt(webapiXmlPath, xml, 5, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Constant);
      // Should include ACL IDs from the fixture
      const labels = result!.items.map((i) => i.label);
      expect(labels).toContain('Magento_Backend::admin');
    });
  });

  // ─── 6. system.xml completion tests ────────────────────────────────────────

  describe('system.xml completions', () => {
    const systemXmlPath = path.join(
      FIXTURE_ROOT,
      'vendor/test/module-foo/etc/adminhtml/system.xml',
    );

    it('completes FQCNs for source_model text content', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <system>
        <section id="test">
            <group id="general">
                <field id="enabled" type="select">
                    <source_model></source_model>
                </field>
            </group>
        </section>
    </system>
</config>`;
      const line6 = '                    <source_model></source_model>';
      const col = colOf(line6, '</source_model>');
      const result = completionAt(systemXmlPath, xml, 6, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Class);
    });

    it('completes FQCNs for backend_model text content', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <system>
        <section id="test">
            <group id="general">
                <field id="value" type="text">
                    <backend_model></backend_model>
                </field>
            </group>
        </section>
    </system>
</config>`;
      const line6 = '                    <backend_model></backend_model>';
      const col = colOf(line6, '</backend_model>');
      const result = completionAt(systemXmlPath, xml, 6, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Class);
    });

    it('completes ACL resource IDs for resource text content', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <system>
        <section id="test">
            <resource></resource>
        </section>
    </system>
</config>`;
      const line4 = '            <resource></resource>';
      const col = colOf(line4, '</resource>');
      const result = completionAt(systemXmlPath, xml, 4, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Constant);
    });
  });

  // ─── 7. db_schema.xml completion tests ─────────────────────────────────────

  describe('db_schema.xml completions', () => {
    const dbSchemaPath = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/db_schema.xml');

    it('completes table names for constraint referenceTable= attribute', () => {
      const xml = `<?xml version="1.0"?>
<schema>
    <table name="my_table">
        <constraint xsi:type="foreign" referenceId="FK1"
                    table="my_table" column="parent_id"
                    referenceTable="" referenceColumn="entity_id"/>
    </table>
</schema>`;
      const line5 = '                    referenceTable="" referenceColumn="entity_id"/>';
      const col = colOf(line5, 'referenceTable="') + 16;
      const result = completionAt(dbSchemaPath, xml, 5, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Field);
      // Should include table names from the fixture db_schema.xml
      const labels = result!.items.map((i) => i.label);
      expect(labels).toContain('test_entity');
    });

    it('completes column names for constraint referenceColumn= with known referenceTable', () => {
      const xml = `<?xml version="1.0"?>
<schema>
    <table name="my_table">
        <constraint xsi:type="foreign" referenceId="FK1"
                    table="my_table" column="parent_id"
                    referenceTable="test_entity" referenceColumn=""/>
    </table>
</schema>`;
      const line5 = '                    referenceTable="test_entity" referenceColumn=""/>';
      const col = colOf(line5, 'referenceColumn="') + 17;
      const result = completionAt(dbSchemaPath, xml, 5, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Field);
      // Should include columns from the test_entity table
      const labels = result!.items.map((i) => i.label);
      expect(labels).toContain('entity_id');
      expect(labels).toContain('name');
    });

    it('returns null for referenceColumn= when referenceTable is not specified', () => {
      const xml = `<?xml version="1.0"?>
<schema>
    <table name="my_table">
        <constraint xsi:type="foreign" referenceId="FK1"
                    table="my_table" column="parent_id"
                    referenceColumn=""/>
    </table>
</schema>`;
      const line5 = '                    referenceColumn=""/>';
      const col = colOf(line5, 'referenceColumn="') + 17;
      const result = completionAt(dbSchemaPath, xml, 5, col);

      // No referenceTable on this element, so no column completions
      expect(result).toBeNull();
    });
  });

  // ─── 8. menu.xml completion tests ──────────────────────────────────────────

  describe('menu.xml completions', () => {
    const menuXmlPath = path.join(
      FIXTURE_ROOT,
      'vendor/test/module-foo/etc/adminhtml/menu.xml',
    );

    it('completes ACL resource IDs for add resource= attribute', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <menu>
        <add id="Test::items" title="Items" resource=""/>
    </menu>
</config>`;
      const line3 = '        <add id="Test::items" title="Items" resource=""/>';
      const col = colOf(line3, 'resource="') + 10;
      const result = completionAt(menuXmlPath, xml, 3, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Constant);
      // Should contain ACL IDs from the fixture
      const labels = result!.items.map((i) => i.label);
      expect(labels).toContain('Test_ModuleFoo::items');
    });
  });

  // ─── 9. UI component XML completion tests ─────────────────────────────────

  describe('UI component XML completions', () => {
    const uiCompPath = path.join(
      FIXTURE_ROOT,
      'vendor/test/module-foo/view/adminhtml/ui_component/foo_listing.xml',
    );

    it('completes ACL resource IDs for aclResource text content', () => {
      const xml = `<?xml version="1.0"?>
<listing>
    <dataSource name="my_data_source">
        <aclResource></aclResource>
    </dataSource>
</listing>`;
      const line3 = '        <aclResource></aclResource>';
      const col = colOf(line3, '</aclResource>');
      const result = completionAt(uiCompPath, xml, 3, col);

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.items[0].kind).toBe(CompletionItemKind.Constant);
      const labels = result!.items.map((i) => i.label);
      expect(labels).toContain('Magento_Backend::admin');
    });

    it('filters ACL resource IDs by partial text', () => {
      const xml = `<?xml version="1.0"?>
<listing>
    <dataSource name="my_data_source">
        <aclResource>Test_Module</aclResource>
    </dataSource>
</listing>`;
      const line3 = '        <aclResource>Test_Module</aclResource>';
      // Cursor at end of "Test_Module"
      const col = colOf(line3, '</aclResource>');
      const result = completionAt(uiCompPath, xml, 3, col);

      expect(result).not.toBeNull();
      for (const item of result!.items) {
        expect(item.label.toLowerCase()).toContain('test_module');
      }
    });
  });

  // ─── 10. PHP completion tests ──────────────────────────────────────────────

  describe('PHP completions', () => {
    // Use a PHP file path within the fixture project
    const phpPath = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/Foo.php');

    it('completes event names inside dispatch() call', () => {
      const php = `<?php
class MyObserver {
    public function execute() {
        $this->eventManager->dispatch('');
    }
}`;
      const line3 = "        $this->eventManager->dispatch('');";
      // Cursor inside the single-quoted string, after the opening quote
      const col = colOf(line3, "dispatch('") + 10;
      const result = completionAt(phpPath, php, 3, col);

      expect(result).not.toBeNull();
      expect(result!.items[0].kind).toBe(CompletionItemKind.Event);
      const labels = result!.items.map((i) => i.label);
      expect(labels).toContain('test_foo_save_after');
    });

    it('filters dispatch() event names by partial text', () => {
      const php = `<?php
class MyObserver {
    public function execute() {
        $this->eventManager->dispatch('test_foo_save');
    }
}`;
      const line3 = "        $this->eventManager->dispatch('test_foo_save');";
      const col = colOf(line3, "test_foo_save'") + 'test_foo_save'.length;
      const result = completionAt(phpPath, php, 3, col);

      expect(result).not.toBeNull();
      for (const item of result!.items) {
        expect(item.label.toLowerCase()).toContain('test_foo_save');
      }
    });

    it('completes config paths inside getValue() call', () => {
      const php = `<?php
class MyHelper {
    public function getConfig() {
        return $this->scopeConfig->getValue('');
    }
}`;
      const line3 = "        return $this->scopeConfig->getValue('');";
      const col = colOf(line3, "getValue('") + 10;
      const result = completionAt(phpPath, php, 3, col);

      expect(result).not.toBeNull();
      expect(result!.items[0].kind).toBe(CompletionItemKind.Value);
    });

    it('completes config paths inside isSetFlag() call', () => {
      const php = `<?php
class MyHelper {
    public function isEnabled() {
        return $this->scopeConfig->isSetFlag('');
    }
}`;
      const line3 = "        return $this->scopeConfig->isSetFlag('');";
      const col = colOf(line3, "isSetFlag('") + 11;
      const result = completionAt(phpPath, php, 3, col);

      expect(result).not.toBeNull();
      expect(result!.items[0].kind).toBe(CompletionItemKind.Value);
    });

    it('completes ACL resource IDs inside isAllowed() call', () => {
      const php = `<?php
class MyController {
    public function execute() {
        $this->_authorization->isAllowed('');
    }
}`;
      const line3 = "        $this->_authorization->isAllowed('');";
      const col = colOf(line3, "isAllowed('") + 11;
      const result = completionAt(phpPath, php, 3, col);

      expect(result).not.toBeNull();
      expect(result!.items[0].kind).toBe(CompletionItemKind.Constant);
      const labels = result!.items.map((i) => i.label);
      expect(labels).toContain('Magento_Backend::admin');
    });

    it('completes ACL resource IDs for ADMIN_RESOURCE constant', () => {
      const php = `<?php
class MyController {
    const ADMIN_RESOURCE = '';
}`;
      const line2 = "    const ADMIN_RESOURCE = '';";
      const col = colOf(line2, "= '") + 3;
      const result = completionAt(phpPath, php, 2, col);

      expect(result).not.toBeNull();
      expect(result!.items[0].kind).toBe(CompletionItemKind.Constant);
      const labels = result!.items.map((i) => i.label);
      expect(labels).toContain('Test_ModuleFoo::items');
    });

    it('returns null for PHP code not in a recognized pattern', () => {
      const php = `<?php
class MyClass {
    public function execute() {
        $name = 'hello';
    }
}`;
      const line3 = "        $name = 'hello';";
      const col = colOf(line3, "'hello") + 3;
      const result = completionAt(phpPath, php, 3, col);

      expect(result).toBeNull();
    });

    it('returns null for empty PHP file', () => {
      const result = completionAt(phpPath, '', 0, 0);
      expect(result).toBeNull();
    });
  });

  // ─── 11. Edge case tests ───────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns null for an unrecognized XML file (not a Magento config file)', () => {
      const unknownXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/module_config.xsd');
      const xml = `<?xml version="1.0"?>
<xs:schema>
    <xs:element name="" type=""/>
</xs:schema>`;
      const line2 = '    <xs:element name="" type=""/>';
      const col = colOf(line2, 'name="') + 6;
      // .xsd files are XML but not a recognized Magento config type
      const result = completionAt(unknownXml, xml, 2, col);
      expect(result).toBeNull();
    });

    it('textEdit range covers the full current value for replacement', () => {
      const diXmlPath = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
      const xml = `<?xml version="1.0"?>
<config>
    <preference for="Test\\Foo" type=""/>
</config>`;
      const line2 = '    <preference for="Test\\Foo" type=""/>';
      const col = colOf(line2, 'Test\\Foo"') + 'Test\\Foo'.length;
      const result = completionAt(diXmlPath, xml, 2, col);

      expect(result).not.toBeNull();
      const firstItem = result!.items[0];
      expect(firstItem.textEdit).toBeDefined();
      // The textEdit should be a replace edit with the item's label as newText
      expect('range' in firstItem.textEdit!).toBe(true);
      if ('range' in firstItem.textEdit!) {
        const range = firstItem.textEdit!.range;
        // Range should start at the opening quote+1 and end at closing quote
        const valueStart = colOf(line2, 'for="') + 5;
        const valueEnd = colOf(line2, '" type');
        expect(range.start.line).toBe(2);
        expect(range.start.character).toBe(valueStart);
        expect(range.end.character).toBe(valueEnd);
      }
    });

    it('returns isIncomplete: true to allow re-filtering on further typing', () => {
      const diXmlPath = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
      const xml = `<?xml version="1.0"?>
<config>
    <type name="">
    </type>
</config>`;
      const line2 = '    <type name="">';
      const col = colOf(line2, 'name="') + 6;
      const result = completionAt(diXmlPath, xml, 2, col);

      expect(result).not.toBeNull();
      expect(result!.isIncomplete).toBe(true);
    });
  });
});
