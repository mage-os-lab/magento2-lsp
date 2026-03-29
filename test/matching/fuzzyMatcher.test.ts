import { describe, it, expect } from 'vitest';
import { createFuzzyMatcher } from '../../src/matching/fuzzyMatcher';
import { computeCharMask, segmentizeFqcn, segmentizeTemplateId } from '../../src/matching/segmentation';
import { ClassEntry, TemplateEntry } from '../../src/matching/types';

// ─── Helpers ───────────────────────────────────────────────────────────────

function classEntry(fqcn: string): ClassEntry {
  return { value: fqcn, segments: segmentizeFqcn(fqcn), charMask: computeCharMask(fqcn) };
}

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

const matcher = createFuzzyMatcher();

// ─── Class matching ────────────────────────────────────────────────────────

describe('fuzzyMatcher — class matching', () => {
  describe('basic subsequence matching', () => {
    it('matches when query chars appear in order', () => {
      const entry = classEntry('Magento\\Catalog\\Model\\Product');
      expect(matcher.matchClass('cmp', entry)).toBeGreaterThan(0);
    });

    it('matches full segment prefixes', () => {
      const entry = classEntry('Magento\\Catalog\\Model\\Product');
      expect(matcher.matchClass('CatModProd', entry)).toBeGreaterThan(0);
    });

    it('matches single-character abbreviations', () => {
      const entry = classEntry('Magento\\Catalog\\Model\\Product');
      expect(matcher.matchClass('MCMP', entry)).toBeGreaterThan(0);
    });

    it('matches with leading backslash stripped', () => {
      const entry = classEntry('Magento\\Catalog\\Model\\Product');
      expect(matcher.matchClass('\\Magento', entry)).toBeGreaterThan(0);
    });

    it('empty query matches everything', () => {
      const entry = classEntry('Magento\\Catalog\\Model\\Product');
      expect(matcher.matchClass('', entry)).toBeGreaterThan(0);
    });
  });

  describe('non-matches', () => {
    it('returns 0 when chars are not all present', () => {
      const entry = classEntry('Magento\\Catalog\\Model\\Product');
      expect(matcher.matchClass('xyz', entry)).toBe(0);
    });

    it('returns 0 when chars are present but not in order', () => {
      // "dc" — both chars exist in "Catalog\Data" but d comes after c
      const entry = classEntry('Magento\\Catalog\\Data');
      expect(matcher.matchClass('dc', entry)).toBe(0);
    });

    it('returns 0 when query is longer than target', () => {
      const entry = classEntry('Foo');
      expect(matcher.matchClass('FooBar', entry)).toBe(0);
    });
  });

  describe('scoring', () => {
    it('contiguous matches score higher than scattered', () => {
      const entry = classEntry('Magento\\Catalog\\Model\\Product');
      const contiguousScore = matcher.matchClass('Catal', entry);
      const scatteredScore = matcher.matchClass('ctlg', entry);
      // "Catal" is contiguous in "Catalog"; "ctlg" is scattered
      expect(contiguousScore).toBeGreaterThan(scatteredScore);
    });

    it('boundary matches score higher than mid-word', () => {
      // "CP" should score higher than "at" because C and P are at segment boundaries
      const entry = classEntry('Magento\\Catalog\\Product');
      const boundaryScore = matcher.matchClass('CP', entry);
      const midWordScore = matcher.matchClass('at', entry);
      expect(boundaryScore).toBeGreaterThan(midWordScore);
    });

    it('prefers boundary match over earlier mid-word match', () => {
      // "p" should match at the boundary "P" in Product, not the "p" in "cap"
      const entry = classEntry('Magento\\Recap\\Product');
      const score = matcher.matchClass('p', entry);
      // A single boundary match scores: MATCH (1) + BOUNDARY (7) = 8
      // A single mid-word match scores: MATCH (1) = 1
      expect(score).toBeGreaterThan(1);
    });

    it('exact prefix match scores highest', () => {
      const entry = classEntry('Magento\\Catalog\\Model\\Product');
      const exactScore = matcher.matchClass('Magento\\Catalog', entry);
      const abbreviatedScore = matcher.matchClass('MC', entry);
      expect(exactScore).toBeGreaterThan(abbreviatedScore);
    });

    it('start-of-string match gets a bonus', () => {
      // Matching "M" at position 0 vs matching "C" at a non-start boundary
      const entry = classEntry('Magento\\Catalog');
      const startScore = matcher.matchClass('M', entry);
      const nonStartScore = matcher.matchClass('C', entry);
      expect(startScore).toBeGreaterThan(nonStartScore);
    });
  });

  describe('bitmask pre-filter', () => {
    it('rejects entries missing required characters via bitmask', () => {
      // "z" is not in "Magento\\Catalog\\Model\\Product"
      const entry = classEntry('Magento\\Catalog\\Model\\Product');
      expect(matcher.matchClass('Productz', entry)).toBe(0);
    });

    it('does not reject entries that have all required characters', () => {
      const entry = classEntry('Magento\\Catalog\\Model\\Product');
      expect(matcher.matchClass('mcp', entry)).toBeGreaterThan(0);
    });
  });

  describe('real-world Magento patterns', () => {
    it('matches abbreviated FQCN', () => {
      const entry = classEntry('Hyva\\Theme\\ViewModel\\Logo\\LogoPathResolver');
      expect(matcher.matchClass('HTVL', entry)).toBeGreaterThan(0);
    });

    it('matches partial namespace', () => {
      const entry = classEntry('Magento\\Framework\\App\\Config\\ScopeConfigInterface');
      expect(matcher.matchClass('ScopeConfig', entry)).toBeGreaterThan(0);
    });

    it('matches across namespace boundaries', () => {
      const entry = classEntry('Magento\\Sales\\Model\\Order\\Item');
      expect(matcher.matchClass('SalesItem', entry)).toBeGreaterThan(0);
    });
  });
});

// ─── Template matching ─────────────────────────────────────────────────────

describe('fuzzyMatcher — template matching', () => {
  describe('basic matching', () => {
    it('matches subsequence in template ID', () => {
      const entry = templateEntry('Magento_Catalog::product/view.phtml');
      expect(matcher.matchTemplate('catprod', entry)).toBeGreaterThan(0);
    });

    it('matches with :: separator', () => {
      const entry = templateEntry('Magento_Catalog::product/view.phtml');
      expect(matcher.matchTemplate('Catalog::product', entry)).toBeGreaterThan(0);
    });

    it('empty query matches everything', () => {
      const entry = templateEntry('Magento_Catalog::product/view.phtml');
      expect(matcher.matchTemplate('', entry)).toBeGreaterThan(0);
    });
  });

  describe('non-matches', () => {
    it('returns 0 when chars not present', () => {
      const entry = templateEntry('Magento_Catalog::product/view.phtml');
      expect(matcher.matchTemplate('xyz', entry)).toBe(0);
    });
  });

  describe('scoring', () => {
    it('boundary matches at :: score well', () => {
      const entry = templateEntry('Magento_Catalog::product/view.phtml');
      // "p" at start of "product" (after ::) should score as a boundary
      const boundaryScore = matcher.matchTemplate('product', entry);
      expect(boundaryScore).toBeGreaterThan(0);
    });

    it('boundary matches at / score well', () => {
      const entry = templateEntry('Magento_Checkout::cart/item/default.phtml');
      // Each path segment start should be a boundary
      const score = matcher.matchTemplate('cid', entry);
      expect(score).toBeGreaterThan(0);
    });
  });

  describe('real-world patterns', () => {
    it('matches module and path abbreviation', () => {
      const entry = templateEntry('Magento_Checkout::cart/item/default.phtml');
      expect(matcher.matchTemplate('Check::cart', entry)).toBeGreaterThan(0);
    });

    it('matches path-only query', () => {
      const entry = templateEntry('Magento_Catalog::product/view.phtml');
      expect(matcher.matchTemplate('view.phtml', entry)).toBeGreaterThan(0);
    });
  });
});
