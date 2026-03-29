import { describe, it, expect } from 'vitest';
import {
  splitCamelCase,
  segmentizeFqcn,
  segmentizeTemplateId,
  segmentizeModuleName,
} from '../../src/matching/segmentation';

// ─── splitCamelCase ────────────────────────────────────────────────────────

describe('splitCamelCase', () => {
  it('splits a simple camelCase word', () => {
    expect(splitCamelCase('viewModel')).toEqual(['view', 'model']);
  });

  it('splits PascalCase', () => {
    expect(splitCamelCase('ViewModel')).toEqual(['view', 'model']);
  });

  it('splits multi-word PascalCase', () => {
    expect(splitCamelCase('LogoPathResolver')).toEqual(['logo', 'path', 'resolver']);
  });

  it('handles uppercase acronym followed by lowercase', () => {
    expect(splitCamelCase('HTMLParser')).toEqual(['html', 'parser']);
  });

  it('handles all-uppercase', () => {
    expect(splitCamelCase('HTML')).toEqual(['html']);
  });

  it('handles single lowercase word', () => {
    expect(splitCamelCase('product')).toEqual(['product']);
  });

  it('handles single uppercase letter', () => {
    expect(splitCamelCase('A')).toEqual(['a']);
  });

  it('handles empty string', () => {
    expect(splitCamelCase('')).toEqual(['']);
  });

  it('handles numbers within words', () => {
    expect(splitCamelCase('Base64Encoder')).toEqual(['base64', 'encoder']);
  });

  it('handles single-letter segments', () => {
    expect(splitCamelCase('ATest')).toEqual(['a', 'test']);
  });

  it('handles consecutive single uppercase letters before a word', () => {
    expect(splitCamelCase('ABCDef')).toEqual(['abc', 'def']);
  });

  it('preserves already-lowercase', () => {
    expect(splitCamelCase('catalog')).toEqual(['catalog']);
  });
});

// ─── segmentizeFqcn ────────────────────────────────────────────────────────

describe('segmentizeFqcn', () => {
  it('segments a simple FQCN', () => {
    expect(segmentizeFqcn('Magento\\Catalog\\Model\\Product')).toEqual([
      ['magento'],
      ['catalog'],
      ['model'],
      ['product'],
    ]);
  });

  it('segments FQCN with camelCase parts', () => {
    expect(segmentizeFqcn('Hyva\\Theme\\ViewModel\\Logo\\LogoPathResolver')).toEqual([
      ['hyva'],
      ['theme'],
      ['view', 'model'],
      ['logo'],
      ['logo', 'path', 'resolver'],
    ]);
  });

  it('strips leading backslash', () => {
    expect(segmentizeFqcn('\\Magento\\Catalog\\Model\\Product')).toEqual([
      ['magento'],
      ['catalog'],
      ['model'],
      ['product'],
    ]);
  });

  it('handles single-part FQCN', () => {
    expect(segmentizeFqcn('StoreManager')).toEqual([
      ['store', 'manager'],
    ]);
  });

  it('handles empty string', () => {
    expect(segmentizeFqcn('')).toEqual([]);
  });

  it('handles FQCN with acronyms', () => {
    expect(segmentizeFqcn('Magento\\Framework\\HTTP\\Client')).toEqual([
      ['magento'],
      ['framework'],
      ['http'],
      ['client'],
    ]);
  });
});

// ─── segmentizeModuleName ──────────────────────────────────────────────────

describe('segmentizeModuleName', () => {
  it('segments a standard module name', () => {
    expect(segmentizeModuleName('Magento_Catalog')).toEqual([
      ['magento'],
      ['catalog'],
    ]);
  });

  it('segments a module name with camelCase parts', () => {
    expect(segmentizeModuleName('Hyva_BaseLayoutReset')).toEqual([
      ['hyva'],
      ['base', 'layout', 'reset'],
    ]);
  });

  it('handles empty string', () => {
    expect(segmentizeModuleName('')).toEqual([]);
  });

  it('handles single-part module name', () => {
    expect(segmentizeModuleName('Magento')).toEqual([
      ['magento'],
    ]);
  });
});

// ─── segmentizeTemplateId ──────────────────────────────────────────────────

describe('segmentizeTemplateId', () => {
  it('segments a standard template ID', () => {
    const result = segmentizeTemplateId('Magento_Catalog::product/view.phtml');
    expect(result.moduleSegments).toEqual([['magento'], ['catalog']]);
    expect(result.pathSegments).toEqual(['product', 'view.phtml']);
  });

  it('segments a template ID with hyphens in path', () => {
    const result = segmentizeTemplateId('Magento_Catalog::catalog/product-attribute/example.phtml');
    expect(result.moduleSegments).toEqual([['magento'], ['catalog']]);
    expect(result.pathSegments).toEqual(['catalog', 'product', 'attribute', 'example.phtml']);
  });

  it('segments a template ID with underscores in path', () => {
    const result = segmentizeTemplateId('Magento_Catalog::product/list_item.phtml');
    expect(result.moduleSegments).toEqual([['magento'], ['catalog']]);
    expect(result.pathSegments).toEqual(['product', 'list', 'item.phtml']);
  });

  it('segments a template ID with camelCase module parts', () => {
    const result = segmentizeTemplateId('Hyva_BaseLayoutReset::some/template.phtml');
    expect(result.moduleSegments).toEqual([['hyva'], ['base', 'layout', 'reset']]);
    expect(result.pathSegments).toEqual(['some', 'template.phtml']);
  });

  it('handles template without module prefix', () => {
    const result = segmentizeTemplateId('product/view.phtml');
    expect(result.moduleSegments).toEqual([]);
    expect(result.pathSegments).toEqual(['product', 'view.phtml']);
  });

  it('handles empty path after module', () => {
    const result = segmentizeTemplateId('Magento_Catalog::');
    expect(result.moduleSegments).toEqual([['magento'], ['catalog']]);
    expect(result.pathSegments).toEqual([]);
  });

  it('handles deeply nested path', () => {
    const result = segmentizeTemplateId('Magento_Checkout::cart/item/default.phtml');
    expect(result.moduleSegments).toEqual([['magento'], ['checkout']]);
    expect(result.pathSegments).toEqual(['cart', 'item', 'default.phtml']);
  });
});
