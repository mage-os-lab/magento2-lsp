import { describe, it, expect } from 'vitest';
import { parseMenuXml, MenuXmlParseContext } from '../../src/indexer/menuXmlParser';

const defaultContext: MenuXmlParseContext = {
  file: '/vendor/test/module-foo/etc/adminhtml/menu.xml',
  module: 'Test_Foo',
};

describe('parseMenuXml', () => {
  it('extracts resource attribute from a menu item', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <menu>
        <add id="Test_Foo::items" title="Items" resource="Test_Foo::items" sortOrder="30"/>
    </menu>
</config>`;
    const result = parseMenuXml(xml, defaultContext);

    expect(result.references).toHaveLength(1);
    expect(result.references[0].value).toBe('Test_Foo::items');
    expect(result.references[0].menuItemId).toBe('Test_Foo::items');
    expect(result.references[0].menuItemTitle).toBe('Items');
    expect(result.references[0].module).toBe('Test_Foo');
  });

  it('extracts multiple menu items', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <menu>
        <add id="A::parent" title="Parent" resource="A::parent_acl" sortOrder="10"/>
        <add id="A::child" title="Child" resource="A::child_acl" parent="A::parent" sortOrder="20"/>
    </menu>
</config>`;
    const result = parseMenuXml(xml, defaultContext);

    expect(result.references).toHaveLength(2);
    expect(result.references[0].value).toBe('A::parent_acl');
    expect(result.references[1].value).toBe('A::child_acl');
  });

  it('tracks accurate column positions for resource attribute', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <menu>
        <add id="Test_Foo::items" title="Items" resource="Test_Foo::items_acl" sortOrder="30"/>
    </menu>
</config>`;
    const result = parseMenuXml(xml, defaultContext);
    const ref = result.references[0];
    const line = xml.split('\n')[3];
    const col = line.indexOf('Test_Foo::items_acl');
    expect(ref.column).toBe(col);
    expect(ref.endColumn).toBe(col + 'Test_Foo::items_acl'.length);
  });

  it('ignores add elements outside menu', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <add id="Outside::menu" title="Outside" resource="Outside::resource"/>
    <menu>
        <add id="Inside::menu" title="Inside" resource="Inside::resource"/>
    </menu>
</config>`;
    const result = parseMenuXml(xml, defaultContext);

    expect(result.references).toHaveLength(1);
    expect(result.references[0].value).toBe('Inside::resource');
  });

  it('ignores add elements without resource attribute', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <menu>
        <add id="No::resource" title="No Resource"/>
    </menu>
</config>`;
    const result = parseMenuXml(xml, defaultContext);
    expect(result.references).toHaveLength(0);
  });

  it('handles malformed XML gracefully', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <menu>
        <add id="Test::item" title="Test" resource="Test::acl"/>
    <!-- missing closing tags -->`;
    const result = parseMenuXml(xml, defaultContext);
    expect(result.references.length).toBeGreaterThan(0);
  });

  it('propagates context to all references', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <menu>
        <add id="A::item" title="A" resource="A::acl"/>
    </menu>
</config>`;
    const ctx: MenuXmlParseContext = { file: '/test/menu.xml', module: 'My_Module' };
    const result = parseMenuXml(xml, ctx);
    expect(result.references[0].file).toBe('/test/menu.xml');
    expect(result.references[0].module).toBe('My_Module');
  });

  it('handles multiline add tag', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <menu>
        <add
            id="Test_Foo::items"
            title="Items"
            resource="Test_Foo::items_acl"
            sortOrder="30"/>
    </menu>
</config>`;
    const result = parseMenuXml(xml, defaultContext);
    expect(result.references).toHaveLength(1);
    expect(result.references[0].value).toBe('Test_Foo::items_acl');
  });
});
