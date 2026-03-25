import { describe, it, expect } from 'vitest';
import { parseUiComponentAcl, UiComponentAclParseContext } from '../../src/indexer/uiComponentAclParser';

const defaultContext: UiComponentAclParseContext = {
  file: '/vendor/test/module-foo/view/adminhtml/ui_component/foo_listing.xml',
  module: 'Test_Foo',
};

describe('parseUiComponentAcl', () => {
  it('extracts aclResource text element', () => {
    const xml = `<?xml version="1.0"?>
<listing>
    <dataSource name="foo_listing_data_source">
        <aclResource>Test_Foo::items</aclResource>
    </dataSource>
</listing>`;
    const result = parseUiComponentAcl(xml, defaultContext);

    expect(result.references).toHaveLength(1);
    expect(result.references[0].value).toBe('Test_Foo::items');
    expect(result.references[0].module).toBe('Test_Foo');
  });

  it('tracks accurate column positions', () => {
    const xml = `<?xml version="1.0"?>
<listing>
    <dataSource name="foo_listing_data_source">
        <aclResource>Magento_Customer::manage</aclResource>
    </dataSource>
</listing>`;
    const result = parseUiComponentAcl(xml, defaultContext);
    const ref = result.references[0];
    const line = xml.split('\n')[3];
    const col = line.indexOf('Magento_Customer::manage');
    expect(ref.column).toBe(col);
    expect(ref.endColumn).toBe(col + 'Magento_Customer::manage'.length);
  });

  it('extracts multiple aclResource elements', () => {
    const xml = `<?xml version="1.0"?>
<listing>
    <dataSource name="first">
        <aclResource>A::one</aclResource>
    </dataSource>
    <dataSource name="second">
        <aclResource>B::two</aclResource>
    </dataSource>
</listing>`;
    const result = parseUiComponentAcl(xml, defaultContext);

    expect(result.references).toHaveLength(2);
    expect(result.references[0].value).toBe('A::one');
    expect(result.references[1].value).toBe('B::two');
  });

  it('ignores other elements in the UI component file', () => {
    const xml = `<?xml version="1.0"?>
<listing xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <argument name="data" xsi:type="array">
        <item name="js_config" xsi:type="array">
            <item name="provider" xsi:type="string">foo_listing.foo_listing_data_source</item>
        </item>
    </argument>
    <dataSource name="foo_listing_data_source">
        <aclResource>Test_Foo::items</aclResource>
        <dataProvider class="Magento\\Framework\\View\\Element\\UiComponent\\DataProvider\\DataProvider" name="foo_listing_data_source"/>
    </dataSource>
</listing>`;
    const result = parseUiComponentAcl(xml, defaultContext);

    expect(result.references).toHaveLength(1);
    expect(result.references[0].value).toBe('Test_Foo::items');
  });

  it('returns empty for files without aclResource', () => {
    const xml = `<?xml version="1.0"?>
<listing>
    <dataSource name="foo"/>
</listing>`;
    const result = parseUiComponentAcl(xml, defaultContext);
    expect(result.references).toHaveLength(0);
  });

  it('handles malformed XML gracefully', () => {
    const xml = `<?xml version="1.0"?>
<listing>
    <dataSource>
        <aclResource>Test_Foo::items</aclResource>
    <!-- missing closing tags -->`;
    const result = parseUiComponentAcl(xml, defaultContext);
    expect(result.references.length).toBeGreaterThan(0);
  });

  it('propagates context to all references', () => {
    const xml = `<?xml version="1.0"?>
<listing>
    <dataSource>
        <aclResource>A::acl</aclResource>
    </dataSource>
</listing>`;
    const ctx: UiComponentAclParseContext = { file: '/test/ui.xml', module: 'My_Module' };
    const result = parseUiComponentAcl(xml, ctx);
    expect(result.references[0].file).toBe('/test/ui.xml');
    expect(result.references[0].module).toBe('My_Module');
  });
});
