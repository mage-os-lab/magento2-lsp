import { describe, it, expect } from 'vitest';
import { parseAclXml, AclXmlParseContext } from '../../src/indexer/aclXmlParser';

const defaultContext: AclXmlParseContext = {
  file: '/vendor/test/module-foo/etc/acl.xml',
  module: 'Test_Foo',
};

describe('parseAclXml', () => {
  it('extracts a flat resource', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <acl>
        <resources>
            <resource id="Magento_Backend::admin" title="Magento Admin"/>
        </resources>
    </acl>
</config>`;
    const result = parseAclXml(xml, defaultContext);

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].id).toBe('Magento_Backend::admin');
    expect(result.resources[0].title).toBe('Magento Admin');
    expect(result.resources[0].parentId).toBeUndefined();
    expect(result.resources[0].hierarchyPath).toEqual(['Magento_Backend::admin']);
    expect(result.resources[0].module).toBe('Test_Foo');
    expect(result.resources[0].file).toBe('/vendor/test/module-foo/etc/acl.xml');
  });

  it('extracts nested resources with correct hierarchy', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <acl>
        <resources>
            <resource id="Magento_Backend::admin" title="Magento Admin">
                <resource id="Magento_Customer::customer" title="Customers">
                    <resource id="Magento_Customer::manage" title="All Customers"/>
                </resource>
            </resource>
        </resources>
    </acl>
</config>`;
    const result = parseAclXml(xml, defaultContext);

    expect(result.resources).toHaveLength(3);

    const admin = result.resources[0];
    expect(admin.id).toBe('Magento_Backend::admin');
    expect(admin.parentId).toBeUndefined();
    expect(admin.hierarchyPath).toEqual(['Magento_Backend::admin']);

    const customer = result.resources[1];
    expect(customer.id).toBe('Magento_Customer::customer');
    expect(customer.parentId).toBe('Magento_Backend::admin');
    expect(customer.hierarchyPath).toEqual([
      'Magento_Backend::admin',
      'Magento_Customer::customer',
    ]);

    const manage = result.resources[2];
    expect(manage.id).toBe('Magento_Customer::manage');
    expect(manage.parentId).toBe('Magento_Customer::customer');
    expect(manage.hierarchyPath).toEqual([
      'Magento_Backend::admin',
      'Magento_Customer::customer',
      'Magento_Customer::manage',
    ]);
  });

  it('extracts sortOrder when present', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <acl>
        <resources>
            <resource id="Magento_Backend::admin" title="Admin">
                <resource id="Magento_Customer::customer" title="Customers" sortOrder="40"/>
                <resource id="Magento_Sales::sales" title="Sales" sortOrder="20"/>
            </resource>
        </resources>
    </acl>
</config>`;
    const result = parseAclXml(xml, defaultContext);

    const customer = result.resources.find((r) => r.id === 'Magento_Customer::customer');
    expect(customer!.sortOrder).toBe(40);

    const sales = result.resources.find((r) => r.id === 'Magento_Sales::sales');
    expect(sales!.sortOrder).toBe(20);

    const admin = result.resources.find((r) => r.id === 'Magento_Backend::admin');
    expect(admin!.sortOrder).toBeUndefined();
  });

  it('tracks accurate column positions for resource id', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <acl>
        <resources>
            <resource id="Magento_Customer::manage" title="All Customers"/>
        </resources>
    </acl>
</config>`;
    const result = parseAclXml(xml, defaultContext);
    const res = result.resources[0];
    const line = xml.split('\n')[4];
    const col = line.indexOf('Magento_Customer::manage');
    expect(res.column).toBe(col);
    expect(res.endColumn).toBe(col + 'Magento_Customer::manage'.length);
  });

  it('handles multiple sibling resources', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <acl>
        <resources>
            <resource id="Magento_Backend::admin" title="Admin">
                <resource id="A::one" title="One"/>
                <resource id="B::two" title="Two"/>
                <resource id="C::three" title="Three"/>
            </resource>
        </resources>
    </acl>
</config>`;
    const result = parseAclXml(xml, defaultContext);

    expect(result.resources).toHaveLength(4);
    // All siblings should have the same parent
    for (const res of result.resources.slice(1)) {
      expect(res.parentId).toBe('Magento_Backend::admin');
      expect(res.hierarchyPath).toHaveLength(2);
    }
  });

  it('ignores resource elements outside the resources container', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <resource id="Outside::resources" title="Should be ignored"/>
    <acl>
        <resources>
            <resource id="Magento_Backend::admin" title="Admin"/>
        </resources>
    </acl>
</config>`;
    const result = parseAclXml(xml, defaultContext);

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].id).toBe('Magento_Backend::admin');
  });

  it('handles malformed XML gracefully', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <acl>
        <resources>
            <resource id="Magento_Backend::admin" title="Admin">
                <resource id="Magento_Customer::manage" title="Manage">
    <!-- missing closing tags -->`;
    const result = parseAclXml(xml, defaultContext);
    // Should return partial results without throwing
    expect(result.resources.length).toBeGreaterThan(0);
  });

  it('handles resource without title', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <acl>
        <resources>
            <resource id="Magento_Backend::admin"/>
        </resources>
    </acl>
</config>`;
    const result = parseAclXml(xml, defaultContext);

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].title).toBe('');
  });

  it('handles multiline resource tag', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <acl>
        <resources>
            <resource
                id="Magento_Customer::manage"
                title="All Customers"
                sortOrder="10"/>
        </resources>
    </acl>
</config>`;
    const result = parseAclXml(xml, defaultContext);

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].id).toBe('Magento_Customer::manage');
    expect(result.resources[0].title).toBe('All Customers');
    expect(result.resources[0].sortOrder).toBe(10);
  });

  it('propagates context to all resources', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <acl>
        <resources>
            <resource id="A::one" title="One">
                <resource id="B::two" title="Two"/>
            </resource>
        </resources>
    </acl>
</config>`;
    const ctx: AclXmlParseContext = {
      file: '/test/acl.xml',
      module: 'My_Module',
    };
    const result = parseAclXml(xml, ctx);
    for (const res of result.resources) {
      expect(res.file).toBe('/test/acl.xml');
      expect(res.module).toBe('My_Module');
    }
  });

  it('returns empty result for empty resources', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <acl>
        <resources/>
    </acl>
</config>`;
    const result = parseAclXml(xml, defaultContext);
    expect(result.resources).toHaveLength(0);
  });
});
