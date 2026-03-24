import { describe, it, expect } from 'vitest';
import { parseXmllintErrors, extractSchemaUrn } from '../../src/validation/xsdValidator';

describe('extractSchemaUrn', () => {
  it('extracts URN from xsi:noNamespaceSchemaLocation', () => {
    const xml = `<?xml version="1.0"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="urn:magento:framework:ObjectManager/etc/config.xsd">
</config>`;
    expect(extractSchemaUrn(xml)).toBe('urn:magento:framework:ObjectManager/etc/config.xsd');
  });

  it('extracts module URN', () => {
    const xml = `<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="urn:magento:module:Magento_Catalog:etc/catalog_attributes.xsd">`;
    expect(extractSchemaUrn(xml)).toBe('urn:magento:module:Magento_Catalog:etc/catalog_attributes.xsd');
  });

  it('returns undefined when no URN is present', () => {
    const xml = `<?xml version="1.0"?><config></config>`;
    expect(extractSchemaUrn(xml)).toBeUndefined();
  });
});

describe('parseXmllintErrors', () => {
  it('parses schema validity errors', () => {
    const stderr = `/tmp/test.xml:3: element badtag: Schemas validity error : Element 'badtag': This element is not expected.
/tmp/test.xml fails to validate
`;
    const diagnostics = parseXmllintErrors(stderr, '/tmp/test.xml');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].range.start.line).toBe(2); // 0-based
    expect(diagnostics[0].message).toContain("Element 'badtag'");
    expect(diagnostics[0].source).toBe('magento2-lsp (xsd)');
  });

  it('parses multiple errors', () => {
    const stderr = `/tmp/di.xml:5: element invalid: Schemas validity error : Element 'invalid': This element is not expected.
/tmp/di.xml:10: element wrong: Schemas validity error : Element 'wrong': This element is not expected.
/tmp/di.xml fails to validate
`;
    const diagnostics = parseXmllintErrors(stderr, '/tmp/di.xml');
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].range.start.line).toBe(4);
    expect(diagnostics[1].range.start.line).toBe(9);
  });

  it('returns empty array for valid output', () => {
    const diagnostics = parseXmllintErrors('', '/tmp/test.xml');
    expect(diagnostics).toHaveLength(0);
  });

  it('filters out errors from included XSD files', () => {
    const stderr = `/tmp/included.xsd:1: parser error : some xsd error
/tmp/test.xml:3: element bad: Schemas validity error : Element 'bad': not expected.
`;
    const diagnostics = parseXmllintErrors(stderr, '/tmp/test.xml');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].range.start.line).toBe(2);
  });

  it('handles parser errors', () => {
    const stderr = `/tmp/test.xml:1: parser error : Start tag expected, '<' not found
`;
    const diagnostics = parseXmllintErrors(stderr, '/tmp/test.xml');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("Start tag expected");
  });
});
