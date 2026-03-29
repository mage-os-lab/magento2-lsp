import { describe, it, expect } from 'vitest';
import { createSegmentMatcher } from '../../src/matching/segmentMatcher';
import { computeCharMask, segmentizeFqcn, segmentizeTemplateId } from '../../src/matching/segmentation';
import { ClassEntry, TemplateEntry } from '../../src/matching/types';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Create a ClassEntry from an FQCN string. */
function classEntry(fqcn: string): ClassEntry {
  return { value: fqcn, segments: segmentizeFqcn(fqcn), charMask: computeCharMask(fqcn) };
}

/** Create a TemplateEntry from a template ID string. */
function templateEntry(templateId: string, area = 'frontend'): TemplateEntry {
  const seg = segmentizeTemplateId(templateId);
  return {
    value: templateId,
    area,
    filePath: `/fake/path/${templateId.replace('::', '/')}`,
    moduleSegments: seg.moduleSegments,
    pathSegments: seg.pathSegments,
    charMask: computeCharMask(templateId),
  };
}

const matcher = createSegmentMatcher();

// ─── Class matching ────────────────────────────────────────────────────────

describe('segmentMatcher.matchClass', () => {
  const product = classEntry('Magento\\Catalog\\Model\\Product');
  const logoResolver = classEntry('Hyva\\Theme\\ViewModel\\Logo\\LogoPathResolver');
  const storeManager = classEntry('Magento\\Store\\Model\\StoreManager');
  const viewModel = classEntry('Hyva\\Theme\\ViewModel\\SomeViewModel');

  it('matches CatModProd → Magento\\Catalog\\Model\\Product', () => {
    expect(matcher.matchClass('CatModProd', product)).toBeGreaterThan(0);
  });

  it('matches HTVLLogo → Hyva\\Theme\\ViewModel\\Logo\\LogoPathResolver', () => {
    expect(matcher.matchClass('HTVLLogo', logoResolver)).toBeGreaterThan(0);
  });

  it('matches HyvaThemeViewModel → Hyva\\Theme\\ViewModel\\...', () => {
    expect(matcher.matchClass('HyvaThemeViewModel', viewModel)).toBeGreaterThan(0);
  });

  it('matches camelCase within a single segment', () => {
    // "View" and "Model" both match within the "ViewModel" namespace part
    expect(matcher.matchClass('ViewModel', viewModel)).toBeGreaterThan(0);
  });

  it('matches standard FQCN prefix: Magento\\Catalog\\Model\\Pro', () => {
    expect(matcher.matchClass('Magento\\Catalog\\Model\\Pro', product)).toBeGreaterThan(0);
  });

  it('strips leading backslash: \\Magento\\Catalog matches', () => {
    expect(matcher.matchClass('\\Magento\\Catalog', product)).toBeGreaterThan(0);
  });

  it('View\\ does NOT match ViewModel (terminated segment)', () => {
    // "View\" forces the namespace segment to end — "ViewModel" has "model" left
    expect(matcher.matchClass('View\\', viewModel)).toBe(0);
  });

  it('matches single character segments: H → Hyva', () => {
    expect(matcher.matchClass('H', logoResolver)).toBeGreaterThan(0);
  });

  it('empty query matches everything', () => {
    expect(matcher.matchClass('', product)).toBeGreaterThan(0);
  });

  it('rejects non-matching query', () => {
    expect(matcher.matchClass('Xyz', product)).toBe(0);
  });

  it('rejects query longer than available segments', () => {
    expect(matcher.matchClass('MagentoCatalogModelProductExtra', product)).toBe(0);
  });

  it('scores exact match higher than prefix match', () => {
    const exactScore = matcher.matchClass('Magento\\Catalog\\Model\\Product', product);
    const prefixScore = matcher.matchClass('Magento\\Catalog\\Model\\Pro', product);
    expect(exactScore).toBeGreaterThan(prefixScore);
  });

  it('matches partial namespace part: Cat matches Catalog', () => {
    expect(matcher.matchClass('Cat', product)).toBeGreaterThan(0);
  });

  it('matches across namespace + camelCase boundaries', () => {
    // "ThemeView" → "Theme" matches namespace "Theme", "View" matches camelCase part of "ViewModel"
    expect(matcher.matchClass('ThemeView', viewModel)).toBeGreaterThan(0);
  });

  it('matches Psr\\Log → Psr\\Log\\LoggerInterface', () => {
    const logger = classEntry('Psr\\Log\\LoggerInterface');
    expect(matcher.matchClass('Psr\\Log', logger)).toBeGreaterThan(0);
  });

  it('handles fully qualified match', () => {
    expect(matcher.matchClass('Magento\\Store\\Model\\StoreManager', storeManager)).toBeGreaterThan(0);
  });

  it('matches StorMan → StoreManager', () => {
    expect(matcher.matchClass('StorMan', storeManager)).toBeGreaterThan(0);
  });

  it('handles acronym classes like HTTP\\Client', () => {
    const httpClient = classEntry('Magento\\Framework\\HTTP\\Client');
    expect(matcher.matchClass('HTTP', httpClient)).toBeGreaterThan(0);
    expect(matcher.matchClass('FramHTTP', httpClient)).toBeGreaterThan(0);
  });
});

// ─── Template matching ─────────────────────────────────────────────────────

describe('segmentMatcher.matchTemplate', () => {
  const productView = templateEntry('Magento_Catalog::product/view.phtml');
  const productAttr = templateEntry('Magento_Catalog::catalog/product-attribute/example.phtml');
  const hyvaTemplate = templateEntry('Hyva_BaseLayoutReset::some/template.phtml');
  const cartItem = templateEntry('Magento_Checkout::cart/item/default.phtml');

  it('matches list.phtml → any template with list.phtml in path', () => {
    const listTemplate = templateEntry('Magento_Catalog::product/list.phtml');
    expect(matcher.matchTemplate('list.phtml', listTemplate)).toBeGreaterThan(0);
  });

  it('matches HyBa:: → Hyva_BaseLayoutReset::...', () => {
    expect(matcher.matchTemplate('HyBa::', hyvaTemplate)).toBeGreaterThan(0);
  });

  it('matches Cat::pro-attr → Magento_Catalog::catalog/product-attribute/example.phtml', () => {
    expect(matcher.matchTemplate('Cat::pro-attr', productAttr)).toBeGreaterThan(0);
  });

  it('matches module prefix only: Cat:: → Magento_Catalog::...', () => {
    expect(matcher.matchTemplate('Cat::', productView)).toBeGreaterThan(0);
  });

  it('matches path only: product/view → Magento_Catalog::product/view.phtml', () => {
    expect(matcher.matchTemplate('product/view', productView)).toBeGreaterThan(0);
  });

  it('matches path with prefix: cart/item → Magento_Checkout::cart/item/default.phtml', () => {
    expect(matcher.matchTemplate('cart/item', cartItem)).toBeGreaterThan(0);
  });

  it('matches full template ID', () => {
    expect(matcher.matchTemplate('Magento_Catalog::product/view.phtml', productView)).toBeGreaterThan(0);
  });

  it('empty query matches everything', () => {
    expect(matcher.matchTemplate('', productView)).toBeGreaterThan(0);
  });

  it('rejects non-matching module', () => {
    expect(matcher.matchTemplate('Xyz::', productView)).toBe(0);
  });

  it('rejects non-matching path', () => {
    expect(matcher.matchTemplate('nonexistent.phtml', productView)).toBe(0);
  });

  it('matches module with camelCase: BaseLayout matches BaseLayoutReset', () => {
    expect(matcher.matchTemplate('Hyva_BaseLayout::', hyvaTemplate)).toBeGreaterThan(0);
  });

  it('rejects when module matches but path does not', () => {
    expect(matcher.matchTemplate('Cat::xyz', productView)).toBe(0);
  });

  it('matches deeply nested path segments', () => {
    expect(matcher.matchTemplate('cat/pro/exam', productAttr)).toBeGreaterThan(0);
  });

  it('matches with underscore as path separator', () => {
    const underscoreTemplate = templateEntry('Magento_Catalog::product/list_item.phtml');
    expect(matcher.matchTemplate('list_item', underscoreTemplate)).toBeGreaterThan(0);
  });

  it('matches module with underscore separator: Ma_Ca:: → Magento_Catalog::...', () => {
    expect(matcher.matchTemplate('Ma_Ca::', productView)).toBeGreaterThan(0);
  });

  it('matches module with underscore and path: Ma_Ca::product/view → Magento_Catalog::product/view.phtml', () => {
    expect(matcher.matchTemplate('Ma_Ca::product/view', productView)).toBeGreaterThan(0);
  });
});
