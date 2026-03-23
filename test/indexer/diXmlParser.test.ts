import { describe, it, expect } from 'vitest';
import { parseDiXml, DiXmlParseContext } from '../../src/indexer/diXmlParser';

const defaultContext: DiXmlParseContext = {
  file: '/vendor/test/module-foo/etc/di.xml',
  area: 'global',
  module: 'Test_Foo',
  moduleOrder: 0,
};

function ctx(overrides?: Partial<DiXmlParseContext>): DiXmlParseContext {
  return { ...defaultContext, ...overrides };
}

describe('parseDiXml', () => {
  describe('preference', () => {
    it('extracts for and type attributes', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <preference for="Magento\\Store\\Api\\StoreManagerInterface" type="Magento\\Store\\Model\\StoreManager" />
</config>`;
      const result = parseDiXml(xml, ctx());
      expect(result.references).toHaveLength(2);

      const forRef = result.references.find((r) => r.kind === 'preference-for');
      expect(forRef).toBeDefined();
      expect(forRef!.fqcn).toBe('Magento\\Store\\Api\\StoreManagerInterface');
      expect(forRef!.pairedFqcn).toBe('Magento\\Store\\Model\\StoreManager');
      expect(forRef!.line).toBe(2);

      const typeRef = result.references.find((r) => r.kind === 'preference-type');
      expect(typeRef).toBeDefined();
      expect(typeRef!.fqcn).toBe('Magento\\Store\\Model\\StoreManager');
      expect(typeRef!.pairedFqcn).toBe('Magento\\Store\\Api\\StoreManagerInterface');
    });

    it('normalizes leading backslash in preference', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <preference for="\\Magento\\Framework\\Setup\\SchemaSetupInterface" type="\\Magento\\Setup\\Module\\Setup" />
</config>`;
      const result = parseDiXml(xml, ctx());
      const forRef = result.references.find((r) => r.kind === 'preference-for');
      expect(forRef!.fqcn).toBe('Magento\\Framework\\Setup\\SchemaSetupInterface');

      const typeRef = result.references.find((r) => r.kind === 'preference-type');
      expect(typeRef!.fqcn).toBe('Magento\\Setup\\Module\\Setup');
    });
  });

  describe('type', () => {
    it('extracts name attribute', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <type name="Magento\\Catalog\\Model\\Product">
    </type>
</config>`;
      const result = parseDiXml(xml, ctx());
      const typeRef = result.references.find((r) => r.kind === 'type-name');
      expect(typeRef).toBeDefined();
      expect(typeRef!.fqcn).toBe('Magento\\Catalog\\Model\\Product');
      expect(typeRef!.line).toBe(2);
    });
  });

  describe('plugin', () => {
    it('extracts plugin type attribute', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <type name="Magento\\Catalog\\Model\\Product\\Link">
        <plugin name="isInStockFilter" type="Magento\\CatalogInventory\\Model\\Plugin\\ProductLinks" />
    </type>
</config>`;
      const result = parseDiXml(xml, ctx());
      const pluginRef = result.references.find((r) => r.kind === 'plugin-type');
      expect(pluginRef).toBeDefined();
      expect(pluginRef!.fqcn).toBe('Magento\\CatalogInventory\\Model\\Plugin\\ProductLinks');
      expect(pluginRef!.line).toBe(3);
      expect(pluginRef!.parentTypeFqcn).toBe('Magento\\Catalog\\Model\\Product\\Link');
    });

    it('sets correct parentTypeFqcn for plugins in multiple type elements', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <type name="Vendor\\First\\Class">
        <plugin name="p1" type="Vendor\\Plugin\\First" />
    </type>
    <type name="Vendor\\Second\\Class">
        <plugin name="p2" type="Vendor\\Plugin\\Second" />
    </type>
</config>`;
      const result = parseDiXml(xml, ctx());
      const plugins = result.references.filter((r) => r.kind === 'plugin-type');
      expect(plugins).toHaveLength(2);
      expect(plugins[0].parentTypeFqcn).toBe('Vendor\\First\\Class');
      expect(plugins[1].parentTypeFqcn).toBe('Vendor\\Second\\Class');
    });

    it('sets parentTypeFqcn for plugins inside virtualType', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <virtualType name="MyVirtualType" type="Vendor\\Base\\Class">
        <plugin name="vPlugin" type="Vendor\\Plugin\\VPlugin" />
    </virtualType>
</config>`;
      const result = parseDiXml(xml, ctx());
      const pluginRef = result.references.find((r) => r.kind === 'plugin-type');
      expect(pluginRef).toBeDefined();
      expect(pluginRef!.parentTypeFqcn).toBe('MyVirtualType');
    });

    it('ignores plugin without type (disabled plugin)', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <type name="Magento\\Checkout\\Block\\LayoutProcessor">
        <plugin name="ProcessPaymentConfiguration" disabled="true"/>
    </type>
</config>`;
      const result = parseDiXml(xml, ctx());
      const pluginRefs = result.references.filter((r) => r.kind === 'plugin-type');
      expect(pluginRefs).toHaveLength(0);
    });
  });

  describe('argument with xsi:type="object"', () => {
    it('extracts class from argument text content', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <type name="Magento\\Vault\\Model\\Ui\\VaultConfigProvider">
        <arguments>
            <argument name="session" xsi:type="object">Magento\\Customer\\Model\\Session</argument>
        </arguments>
    </type>
</config>`;
      const result = parseDiXml(xml, ctx());
      const argRef = result.references.find((r) => r.kind === 'argument-object');
      expect(argRef).toBeDefined();
      expect(argRef!.fqcn).toBe('Magento\\Customer\\Model\\Session');
      expect(argRef!.line).toBe(4);
    });

    it('ignores argument with xsi:type="string"', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <type name="Magento\\Store\\Model\\Store">
        <arguments>
            <argument name="currencyInstalled" xsi:type="string">system/currency/installed</argument>
        </arguments>
    </type>
</config>`;
      const result = parseDiXml(xml, ctx());
      const argRefs = result.references.filter((r) => r.kind === 'argument-object');
      expect(argRefs).toHaveLength(0);
    });

    it('ignores argument with xsi:type="array"', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <type name="Magento\\Vault\\Model\\PaymentTokenFactory">
        <arguments>
            <argument name="tokenTypes" xsi:type="array">
                <item name="account" xsi:type="string">some_value</item>
            </argument>
        </arguments>
    </type>
</config>`;
      const result = parseDiXml(xml, ctx());
      const argRefs = result.references.filter((r) => r.kind === 'argument-object');
      expect(argRefs).toHaveLength(0);
    });

    it('extracts class from item with xsi:type="object"', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <type name="Magento\\Framework\\RequireJs\\Config">
        <arguments>
            <argument name="files" xsi:type="array">
                <item name="base" xsi:type="object">Magento\\Framework\\View\\File\\Collector\\Base</item>
            </argument>
        </arguments>
    </type>
</config>`;
      const result = parseDiXml(xml, ctx());
      const argRef = result.references.find((r) => r.kind === 'argument-object');
      expect(argRef).toBeDefined();
      expect(argRef!.fqcn).toBe('Magento\\Framework\\View\\File\\Collector\\Base');
    });
  });

  describe('virtualType', () => {
    it('extracts name and type attributes', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <virtualType name="VaultPaymentDefaultValueHandler" type="Magento\\Payment\\Gateway\\Config\\ConfigValueHandler">
    </virtualType>
</config>`;
      const result = parseDiXml(xml, ctx());

      const nameRef = result.references.find((r) => r.kind === 'virtualtype-name');
      expect(nameRef).toBeDefined();
      expect(nameRef!.fqcn).toBe('VaultPaymentDefaultValueHandler');

      const typeRef = result.references.find((r) => r.kind === 'virtualtype-type');
      expect(typeRef).toBeDefined();
      expect(typeRef!.fqcn).toBe('Magento\\Payment\\Gateway\\Config\\ConfigValueHandler');

      expect(result.virtualTypes).toHaveLength(1);
      expect(result.virtualTypes[0].name).toBe('VaultPaymentDefaultValueHandler');
      expect(result.virtualTypes[0].parentType).toBe(
        'Magento\\Payment\\Gateway\\Config\\ConfigValueHandler',
      );
    });

    it('handles virtualType with FQCN name', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <virtualType name="Magento\\CatalogInventory\\Model\\Indexer\\Stock\\BatchSizeManagement" type="Magento\\Framework\\Indexer\\BatchSizeManagement">
    </virtualType>
</config>`;
      const result = parseDiXml(xml, ctx());
      const nameRef = result.references.find((r) => r.kind === 'virtualtype-name');
      expect(nameRef!.fqcn).toBe(
        'Magento\\CatalogInventory\\Model\\Indexer\\Stock\\BatchSizeManagement',
      );
    });
  });

  describe('context propagation', () => {
    it('propagates area and module to all references', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <preference for="Magento\\Store\\Api\\StoreManagerInterface" type="Magento\\Store\\Model\\StoreManager" />
</config>`;
      const result = parseDiXml(
        xml,
        ctx({ area: 'frontend', module: 'Magento_Store', moduleOrder: 5 }),
      );

      for (const ref of result.references) {
        expect(ref.area).toBe('frontend');
        expect(ref.module).toBe('Magento_Store');
        expect(ref.moduleOrder).toBe(5);
      }
    });
  });

  describe('column positions', () => {
    it('tracks accurate column positions for preference for attribute', () => {
      // Use a precise XML string where we can count characters
      const xml = `<?xml version="1.0"?>
<config>
    <preference for="FooInterface" type="FooImpl" />
</config>`;
      const result = parseDiXml(xml, ctx());
      const forRef = result.references.find((r) => r.kind === 'preference-for')!;
      // '    <preference for="' = 21 chars, so value starts at column 21
      expect(forRef.column).toBe(21);
      // 'FooInterface' = 12 chars
      expect(forRef.endColumn).toBe(33);
    });

    it('tracks accurate column positions for argument-object text', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <type name="Foo">
        <arguments>
            <argument name="bar" xsi:type="object">Bar\\Baz</argument>
        </arguments>
    </type>
</config>`;
      const result = parseDiXml(xml, ctx());
      const argRef = result.references.find((r) => r.kind === 'argument-object')!;
      expect(argRef.fqcn).toBe('Bar\\Baz');
      // The text content 'Bar\Baz' position in the line
      const line = xml.split('\n')[4];
      const col = line.indexOf('Bar\\Baz');
      expect(argRef.column).toBe(col);
    });
  });

  describe('multiple elements', () => {
    it('parses a complex di.xml with all element types', () => {
      const xml = `<?xml version="1.0"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="urn:magento:framework:ObjectManager/etc/config.xsd">
    <preference for="Magento\\Vault\\Model\\VaultPaymentInterface" type="Magento\\Vault\\Model\\Method\\Vault"/>
    <type name="Magento\\Checkout\\Block\\Checkout\\LayoutProcessor">
        <plugin name="ProcessPaymentVaultConfiguration" type="Magento\\Vault\\Plugin\\PaymentVaultConfigurationProcess"/>
    </type>
    <type name="Magento\\Vault\\Model\\Ui\\VaultConfigProvider">
        <arguments>
            <argument name="session" xsi:type="object">Magento\\Customer\\Model\\Session</argument>
        </arguments>
    </type>
    <virtualType name="VaultPaymentDefaultValueHandler" type="Magento\\Payment\\Gateway\\Config\\ConfigValueHandler">
        <arguments>
            <argument name="configInterface" xsi:type="object">Magento\\Payment\\Gateway\\Config\\Config</argument>
        </arguments>
    </virtualType>
</config>`;
      const result = parseDiXml(xml, ctx());

      // 2 from preference + 2 type-names + 1 plugin + 2 argument-objects + 2 virtualtype = 9
      expect(result.references.length).toBe(9);
      expect(result.virtualTypes).toHaveLength(1);

      const kinds = result.references.map((r) => r.kind);
      expect(kinds.filter((k) => k === 'preference-for')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'preference-type')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'type-name')).toHaveLength(2);
      expect(kinds.filter((k) => k === 'plugin-type')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'argument-object')).toHaveLength(2);
      expect(kinds.filter((k) => k === 'virtualtype-name')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'virtualtype-type')).toHaveLength(1);
    });
  });

  describe('error handling', () => {
    it('returns partial results for malformed XML', () => {
      const xml = `<?xml version="1.0"?>
<config>
    <preference for="Foo\\Bar" type="Foo\\Baz" />
    <broken element here
    <preference for="Another\\Interface" type="Another\\Impl" />
</config>`;
      const result = parseDiXml(xml, ctx());
      // Should at least get the first preference
      expect(result.references.length).toBeGreaterThanOrEqual(2);
    });
  });
});
