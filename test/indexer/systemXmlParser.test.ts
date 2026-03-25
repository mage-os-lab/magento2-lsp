import { describe, it, expect } from 'vitest';
import { parseSystemXml, SystemXmlParseContext } from '../../src/indexer/systemXmlParser';

const defaultContext: SystemXmlParseContext = {
  file: '/vendor/test/module-foo/etc/adminhtml/system.xml',
  module: 'Test_Foo',
};

describe('parseSystemXml', () => {
  it('extracts section, group, and field IDs with correct config paths', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <system>
        <section id="payment">
            <group id="account">
                <field id="active">
                </field>
            </group>
        </section>
    </system>
</config>`;
    const result = parseSystemXml(xml, defaultContext);
    const section = result.references.find((r) => r.kind === 'section-id');
    const group = result.references.find((r) => r.kind === 'group-id');
    const field = result.references.find((r) => r.kind === 'field-id');

    expect(section).toBeDefined();
    expect(section!.configPath).toBe('payment');

    expect(group).toBeDefined();
    expect(group!.configPath).toBe('payment/account');

    expect(field).toBeDefined();
    expect(field!.configPath).toBe('payment/account/active');
  });

  it('handles nested groups producing 4+ segment paths', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <system>
        <section id="hyva_themes_checkout">
            <group id="general">
                <group id="mobile">
                    <field id="enable">
                    </field>
                </group>
            </group>
        </section>
    </system>
</config>`;
    const result = parseSystemXml(xml, defaultContext);
    const field = result.references.find((r) => r.kind === 'field-id');
    expect(field).toBeDefined();
    expect(field!.configPath).toBe('hyva_themes_checkout/general/mobile/enable');

    const nestedGroup = result.references.filter((r) => r.kind === 'group-id');
    expect(nestedGroup).toHaveLength(2);
    expect(nestedGroup[0].configPath).toBe('hyva_themes_checkout/general');
    expect(nestedGroup[1].configPath).toBe('hyva_themes_checkout/general/mobile');
  });

  it('extracts source_model FQCN', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <system>
        <section id="payment">
            <group id="account">
                <field id="active">
                    <source_model>Magento\\Config\\Model\\Config\\Source\\Yesno</source_model>
                </field>
            </group>
        </section>
    </system>
</config>`;
    const result = parseSystemXml(xml, defaultContext);
    const sourceModel = result.references.find((r) => r.kind === 'source-model');
    expect(sourceModel).toBeDefined();
    expect(sourceModel!.fqcn).toBe('Magento\\Config\\Model\\Config\\Source\\Yesno');
    expect(sourceModel!.configPath).toBe('payment/account/active');
  });

  it('extracts backend_model FQCN', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <system>
        <section id="payment">
            <group id="account">
                <field id="active">
                    <backend_model>Magento\\Config\\Model\\Config\\Backend\\Encrypted</backend_model>
                </field>
            </group>
        </section>
    </system>
</config>`;
    const result = parseSystemXml(xml, defaultContext);
    const backendModel = result.references.find((r) => r.kind === 'backend-model');
    expect(backendModel).toBeDefined();
    expect(backendModel!.fqcn).toBe('Magento\\Config\\Model\\Config\\Backend\\Encrypted');
    expect(backendModel!.configPath).toBe('payment/account/active');
  });

  it('extracts frontend_model FQCN', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <system>
        <section id="dev">
            <group id="debug">
                <field id="profiler">
                    <frontend_model>Magento\\Config\\Block\\System\\Config\\Form\\Field\\Heading</frontend_model>
                </field>
            </group>
        </section>
    </system>
</config>`;
    const result = parseSystemXml(xml, defaultContext);
    const frontendModel = result.references.find((r) => r.kind === 'frontend-model');
    expect(frontendModel).toBeDefined();
    expect(frontendModel!.fqcn).toBe('Magento\\Config\\Block\\System\\Config\\Form\\Field\\Heading');
    expect(frontendModel!.configPath).toBe('dev/debug/profiler');
  });

  it('captures label text', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <system>
        <section id="payment">
            <label>Payment Methods</label>
            <group id="account">
                <label>Account Settings</label>
                <field id="active">
                    <label>Enabled</label>
                </field>
            </group>
        </section>
    </system>
</config>`;
    const result = parseSystemXml(xml, defaultContext);
    const section = result.references.find((r) => r.kind === 'section-id');
    const group = result.references.find((r) => r.kind === 'group-id');
    const field = result.references.find((r) => r.kind === 'field-id');

    expect(section!.label).toBe('Payment Methods');
    expect(group!.label).toBe('Account Settings');
    expect(field!.label).toBe('Enabled');
  });

  it('handles include partial files (no <config><system> wrapper)', () => {
    const xml = `<?xml version="1.0"?>
<include xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:noNamespaceSchemaLocation="urn:magento:module:Magento_Config:etc/system_include.xsd">
    <group id="order_comment">
        <label>Order Comment</label>
        <field id="enable">
            <label>Enable</label>
            <source_model>Magento\\Config\\Model\\Config\\Source\\Yesno</source_model>
        </field>
    </group>
</include>`;
    const result = parseSystemXml(xml, defaultContext);
    const group = result.references.find((r) => r.kind === 'group-id');
    const field = result.references.find((r) => r.kind === 'field-id');
    const sourceModel = result.references.find((r) => r.kind === 'source-model');

    expect(group).toBeDefined();
    expect(group!.configPath).toBe('order_comment');
    expect(group!.label).toBe('Order Comment');

    expect(field).toBeDefined();
    expect(field!.configPath).toBe('order_comment/enable');

    expect(sourceModel).toBeDefined();
    expect(sourceModel!.fqcn).toBe('Magento\\Config\\Model\\Config\\Source\\Yesno');
  });

  it('normalizes leading backslash on model FQCNs', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <system>
        <section id="s">
            <group id="g">
                <field id="f">
                    <source_model>\\Vendor\\Module\\Model\\Source</source_model>
                </field>
            </group>
        </section>
    </system>
</config>`;
    const result = parseSystemXml(xml, defaultContext);
    const sourceModel = result.references.find((r) => r.kind === 'source-model');
    expect(sourceModel!.fqcn).toBe('Vendor\\Module\\Model\\Source');
  });

  it('tracks accurate column positions for id attributes', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <system>
        <section id="payment">
        </section>
    </system>
</config>`;
    const result = parseSystemXml(xml, defaultContext);
    const section = result.references[0];
    const line = xml.split('\n')[3];
    const col = line.indexOf('payment');
    expect(section.column).toBe(col);
    expect(section.endColumn).toBe(col + 'payment'.length);
  });

  it('tracks accurate column positions for model text content', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <system>
        <section id="s">
            <group id="g">
                <field id="f">
                    <source_model>Foo\\Bar</source_model>
                </field>
            </group>
        </section>
    </system>
</config>`;
    const result = parseSystemXml(xml, defaultContext);
    const sourceModel = result.references.find((r) => r.kind === 'source-model');
    const line = xml.split('\n')[6];
    const col = line.indexOf('Foo\\Bar');
    expect(sourceModel!.column).toBe(col);
    expect(sourceModel!.endColumn).toBe(col + 'Foo\\Bar'.length);
  });

  it('propagates context to all references', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <system>
        <section id="s">
            <group id="g">
                <field id="f">
                    <source_model>Vendor\\Model</source_model>
                </field>
            </group>
        </section>
    </system>
</config>`;
    const ctx: SystemXmlParseContext = {
      file: '/test/system.xml',
      module: 'My_Module',
    };
    const result = parseSystemXml(xml, ctx);
    for (const ref of result.references) {
      expect(ref.file).toBe('/test/system.xml');
      expect(ref.module).toBe('My_Module');
    }
  });

  it('handles multiple sections and fields', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <system>
        <section id="payment">
            <group id="account">
                <field id="active"></field>
                <field id="title"></field>
            </group>
        </section>
        <section id="customer">
            <group id="address">
                <field id="format"></field>
            </group>
        </section>
    </system>
</config>`;
    const result = parseSystemXml(xml, defaultContext);
    const fields = result.references.filter((r) => r.kind === 'field-id');
    expect(fields).toHaveLength(3);
    expect(fields[0].configPath).toBe('payment/account/active');
    expect(fields[1].configPath).toBe('payment/account/title');
    expect(fields[2].configPath).toBe('customer/address/format');
  });

  it('handles malformed XML gracefully', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <system>
        <section id="payment">
            <group id="account">
                <field id="active">
                    <source_model>Vendor\\Model</source_model>
                <!-- missing closing tags -->`;
    const result = parseSystemXml(xml, defaultContext);
    // Should return partial results without throwing
    expect(result.references.length).toBeGreaterThan(0);
    const field = result.references.find((r) => r.kind === 'field-id');
    expect(field!.configPath).toBe('payment/account/active');
  });

  it('extracts resource element inside a section as section-resource', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <system>
        <section id="newsletter">
            <label>Newsletter</label>
            <resource>Magento_Newsletter::newsletter</resource>
            <group id="general">
                <field id="active">
                    <label>Enabled</label>
                </field>
            </group>
        </section>
    </system>
</config>`;
    const result = parseSystemXml(xml, defaultContext);

    const resourceRef = result.references.find((r) => r.kind === 'section-resource');
    expect(resourceRef).toBeDefined();
    expect(resourceRef!.aclResourceId).toBe('Magento_Newsletter::newsletter');
    expect(resourceRef!.configPath).toBe('newsletter');
  });

  it('tracks accurate column positions for section resource', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <system>
        <section id="newsletter">
            <resource>Magento_Newsletter::newsletter</resource>
        </section>
    </system>
</config>`;
    const result = parseSystemXml(xml, defaultContext);
    const ref = result.references.find((r) => r.kind === 'section-resource');
    const line = xml.split('\n')[4];
    const col = line.indexOf('Magento_Newsletter::newsletter');
    expect(ref!.column).toBe(col);
    expect(ref!.endColumn).toBe(col + 'Magento_Newsletter::newsletter'.length);
  });

  it('ignores resource elements outside a section', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <system>
        <resource>Should_Be::ignored</resource>
        <section id="test">
            <resource>Should_Be::included</resource>
        </section>
    </system>
</config>`;
    const result = parseSystemXml(xml, defaultContext);
    const resourceRefs = result.references.filter((r) => r.kind === 'section-resource');
    expect(resourceRefs).toHaveLength(1);
    expect(resourceRefs[0].aclResourceId).toBe('Should_Be::included');
  });
});
