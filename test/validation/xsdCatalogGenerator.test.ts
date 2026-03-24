import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { generateXsdCatalog } from '../../src/validation/xsdCatalogGenerator';
import { ModuleInfo } from '../../src/indexer/types';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

const modules: ModuleInfo[] = [
  {
    name: 'Test_Foo',
    path: path.join(FIXTURE_ROOT, 'vendor/test/module-foo'),
    order: 0,
  },
];

describe('generateXsdCatalog', () => {
  it('generates catalog with URNs found in root XSD', () => {
    // config.xsd includes a redefine to urn:magento:framework:Data/etc/argument/types.xsd
    const rootXsd = path.join(
      FIXTURE_ROOT,
      'vendor/magento/framework/ObjectManager/etc/config.xsd',
    );
    const catalog = generateXsdCatalog(rootXsd, FIXTURE_ROOT, modules);

    expect(catalog).toContain('xmlns="urn:oasis:names:tc:entity:xmlns:xml:catalog"');
    expect(catalog).toContain('urn:magento:framework:Data/etc/argument/types.xsd');
    expect(catalog).toContain('file://');
    expect(catalog).toContain('Data/etc/argument/types.xsd');
  });

  it('generates empty catalog for XSD with no URN includes', () => {
    // events.xsd has no xs:include/xs:redefine with URNs
    const rootXsd = path.join(
      FIXTURE_ROOT,
      'vendor/magento/framework/Event/etc/events.xsd',
    );
    const catalog = generateXsdCatalog(rootXsd, FIXTURE_ROOT, modules);

    expect(catalog).toContain('<catalog');
    // Should have no <uri> entries
    expect(catalog).not.toContain('<uri ');
  });
});
