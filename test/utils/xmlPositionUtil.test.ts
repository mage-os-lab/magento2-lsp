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
