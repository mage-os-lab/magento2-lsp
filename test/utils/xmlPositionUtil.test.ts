import { describe, it, expect } from 'vitest';
import {
  findAttributeValuePosition,
  findTextContentPosition,
} from '../../src/utils/xmlPositionUtil';

describe('findAttributeValuePosition', () => {
  it('finds attribute value on the same line', () => {
    const lines = [
      '<preference for="Magento\\Store\\Api\\StoreManagerInterface" type="Magento\\Store\\Model\\StoreManager" />',
    ];
    const result = findAttributeValuePosition(lines, 0, 'for');
    expect(result).toEqual({
      line: 0,
      column: 17,
      endColumn: 56,
    });
  });

  it('finds type attribute on the same line', () => {
    const lines = [
      '<preference for="Magento\\Store\\Api\\StoreManagerInterface" type="Magento\\Store\\Model\\StoreManager" />',
    ];
    const result = findAttributeValuePosition(lines, 0, 'type');
    expect(result).toEqual({
      line: 0,
      column: 64,
      endColumn: 96,
    });
  });

  it('finds attribute with single quotes', () => {
    const lines = ["<type name='Magento\\Store\\Model\\Store'>"];
    const result = findAttributeValuePosition(lines, 0, 'name');
    expect(result).toEqual({
      line: 0,
      column: 12,
      endColumn: 37,
    });
  });

  it('finds attribute on a following line', () => {
    const lines = [
      '<preference',
      '    for="Magento\\Store\\Api\\StoreManagerInterface"',
      '    type="Magento\\Store\\Model\\StoreManager" />',
    ];
    const result = findAttributeValuePosition(lines, 0, 'type');
    expect(result).toEqual({
      line: 2,
      column: 10,
      endColumn: 42,
    });
  });

  it('returns undefined when attribute not found', () => {
    const lines = ['<type name="Magento\\Store\\Model\\Store">'];
    const result = findAttributeValuePosition(lines, 0, 'nonexistent');
    expect(result).toBeUndefined();
  });

  it('handles attribute with spaces around equals', () => {
    const lines = ['<type name = "Magento\\Store\\Model\\Store">'];
    const result = findAttributeValuePosition(lines, 0, 'name');
    expect(result).toEqual({
      line: 0,
      column: 14,
      endColumn: 39,
    });
  });

  it('finds attribute before tagLine when tagStartLine is provided', () => {
    // SAX reports tagLine at the closing `>` (line 1), but class= is on line 0
    const lines = [
      '<block class="Magento\\Catalog\\Block\\Product\\View" name="product.detail.page"',
      '       template="Magento_Catalog::product/product-detail-page.phtml">',
    ];
    const result = findAttributeValuePosition(lines, 1, 'class', 0);
    expect(result).toEqual({
      line: 0,
      column: 14,
      endColumn: 48,
    });
  });

  it('finds attribute on tagLine when tagStartLine is earlier', () => {
    const lines = [
      '<block class="Magento\\Catalog\\Block\\Product\\View" name="product.detail.page"',
      '       template="Magento_Catalog::product/product-detail-page.phtml">',
    ];
    const result = findAttributeValuePosition(lines, 1, 'template', 0);
    expect(result).toEqual({
      line: 1,
      column: 17,
      endColumn: 67,
    });
  });

  it('finds attributes on multi-line block with 4+ lines', () => {
    const lines = [
      '<block',
      '    name="catalog.preload.product.gallery"',
      '    class="Magento\\Catalog\\Block\\Product\\View\\Gallery"',
      '    template="Magento_Catalog::page/catalog-preload-product-gallery.phtml"',
      '/>',
    ];
    // SAX would report tagLine=4 (the /> line), tagStartLine=0 (the <block line)
    expect(findAttributeValuePosition(lines, 4, 'class', 0)).toEqual({
      line: 2,
      column: 11,
      endColumn: 53,
    });
    expect(findAttributeValuePosition(lines, 4, 'template', 0)).toEqual({
      line: 3,
      column: 14,
      endColumn: 73,
    });
  });
});

describe('findTextContentPosition', () => {
  it('finds text content on the same line as tag', () => {
    const lines = [
      '        <argument name="session" xsi:type="object">Magento\\Customer\\Model\\Session</argument>',
    ];
    const result = findTextContentPosition(lines, 0, 'Magento\\Customer\\Model\\Session');
    expect(result).toEqual({
      line: 0,
      column: 51,
      endColumn: 81,
    });
  });

  it('finds text content on the next line', () => {
    const lines = [
      '        <argument name="session" xsi:type="object">',
      '            Magento\\Customer\\Model\\Session',
      '        </argument>',
    ];
    const result = findTextContentPosition(lines, 0, 'Magento\\Customer\\Model\\Session');
    expect(result).toEqual({
      line: 1,
      column: 12,
      endColumn: 42,
    });
  });

  it('returns undefined for empty text content', () => {
    const lines = ['<argument name="foo" xsi:type="object"></argument>'];
    const result = findTextContentPosition(lines, 0, '');
    expect(result).toBeUndefined();
  });

  it('returns undefined for whitespace-only text content', () => {
    const lines = ['<argument name="foo" xsi:type="object">   </argument>'];
    const result = findTextContentPosition(lines, 0, '   ');
    expect(result).toBeUndefined();
  });
});
