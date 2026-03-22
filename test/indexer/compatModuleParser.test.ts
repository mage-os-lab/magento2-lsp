import { describe, it, expect } from 'vitest';
import { parseCompatModuleRegistrations } from '../../src/indexer/compatModuleParser';

describe('parseCompatModuleRegistrations', () => {
  it('extracts a single compat module mapping', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <type name="Hyva\\CompatModuleFallback\\Model\\CompatModuleRegistry">
        <arguments>
            <argument name="compatModules" xsi:type="array">
                <item name="hyva_catalog_map" xsi:type="array">
                    <item name="original_module" xsi:type="string">Magento_Catalog</item>
                    <item name="compat_module" xsi:type="string">Hyva_Catalog</item>
                </item>
            </argument>
        </arguments>
    </type>
</config>`;

    const result = parseCompatModuleRegistrations(xml);
    expect(result).toEqual([
      { originalModule: 'Magento_Catalog', compatModule: 'Hyva_Catalog' },
    ]);
  });

  it('extracts multiple compat module mappings', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <type name="Hyva\\CompatModuleFallback\\Model\\CompatModuleRegistry">
        <arguments>
            <argument name="compatModules" xsi:type="array">
                <item name="mollie_payment" xsi:type="array">
                    <item name="original_module" xsi:type="string">Mollie_Payment</item>
                    <item name="compat_module" xsi:type="string">Mollie_HyvaCompatibility</item>
                </item>
                <item name="mollie_subscriptions" xsi:type="array">
                    <item name="original_module" xsi:type="string">Mollie_Subscriptions</item>
                    <item name="compat_module" xsi:type="string">Mollie_HyvaCompatibility</item>
                </item>
            </argument>
        </arguments>
    </type>
</config>`;

    const result = parseCompatModuleRegistrations(xml);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      originalModule: 'Mollie_Payment',
      compatModule: 'Mollie_HyvaCompatibility',
    });
    expect(result[1]).toEqual({
      originalModule: 'Mollie_Subscriptions',
      compatModule: 'Mollie_HyvaCompatibility',
    });
  });

  it('returns empty array for di.xml without compat registrations', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <type name="Magento\\Catalog\\Model\\Product">
        <plugin name="some_plugin" type="Vendor\\Module\\Plugin\\ProductPlugin"/>
    </type>
</config>`;

    const result = parseCompatModuleRegistrations(xml);
    expect(result).toEqual([]);
  });

  it('ignores incomplete mappings (missing compat_module)', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <type name="Hyva\\CompatModuleFallback\\Model\\CompatModuleRegistry">
        <arguments>
            <argument name="compatModules" xsi:type="array">
                <item name="broken" xsi:type="array">
                    <item name="original_module" xsi:type="string">Some_Module</item>
                </item>
            </argument>
        </arguments>
    </type>
</config>`;

    const result = parseCompatModuleRegistrations(xml);
    expect(result).toEqual([]);
  });

  it('handles whitespace in module names', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <type name="Hyva\\CompatModuleFallback\\Model\\CompatModuleRegistry">
        <arguments>
            <argument name="compatModules" xsi:type="array">
                <item name="test" xsi:type="array">
                    <item name="original_module" xsi:type="string">  Test_Module  </item>
                    <item name="compat_module" xsi:type="string">  Hyva_Test  </item>
                </item>
            </argument>
        </arguments>
    </type>
</config>`;

    const result = parseCompatModuleRegistrations(xml);
    expect(result).toEqual([
      { originalModule: 'Test_Module', compatModule: 'Hyva_Test' },
    ]);
  });
});
