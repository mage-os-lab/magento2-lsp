import { describe, it, expect, beforeEach } from 'vitest';
import { SymbolIndex } from '../../src/index/symbolIndex';
import { createSegmentMatcher } from '../../src/matching/segmentMatcher';
import { computeCharMask, segmentizeFqcn, segmentizeTemplateId } from '../../src/matching/segmentation';
import { ClassEntry, TemplateEntry } from '../../src/matching/types';

// ─── Helpers ───────────────────────────────────────────────────────────────

function classEntry(fqcn: string): ClassEntry {
  return { value: fqcn, segments: segmentizeFqcn(fqcn), charMask: computeCharMask(fqcn) };
}

function templateEntry(templateId: string, area: string, filePath?: string): TemplateEntry {
  const seg = segmentizeTemplateId(templateId);
  return {
    value: templateId,
    area,
    filePath: filePath ?? `/fake/${area}/${templateId.replace('::', '/')}`,
    moduleSegments: seg.moduleSegments,
    pathSegments: seg.pathSegments,
    charMask: computeCharMask(templateId),
  };
}

const matcher = createSegmentMatcher();

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('SymbolIndex', () => {
  let index: SymbolIndex;

  beforeEach(() => {
    index = new SymbolIndex();
  });

  // ── Class operations ──────────────────────────────────────────────────

  describe('classes', () => {
    it('setClasses populates the index', () => {
      index.setClasses([
        classEntry('Magento\\Catalog\\Model\\Product'),
        classEntry('Magento\\Store\\Model\\Store'),
      ]);
      expect(index.getClassCount()).toBe(2);
    });

    it('matchClasses finds matching entries', () => {
      index.setClasses([
        classEntry('Magento\\Catalog\\Model\\Product'),
        classEntry('Magento\\Store\\Model\\Store'),
        classEntry('Hyva\\Theme\\ViewModel\\Logo'),
      ]);

      const results = index.matchClasses('CatModProd', matcher, 10);
      expect(results).toContain('Magento\\Catalog\\Model\\Product');
      expect(results).not.toContain('Magento\\Store\\Model\\Store');
    });

    it('matchClasses respects limit', () => {
      index.setClasses([
        classEntry('Magento\\Catalog\\Model\\Product'),
        classEntry('Magento\\Catalog\\Model\\ProductRepository'),
        classEntry('Magento\\Catalog\\Model\\ProductLink'),
      ]);

      const results = index.matchClasses('CatModProd', matcher, 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('matchClasses returns empty for no matches', () => {
      index.setClasses([classEntry('Magento\\Catalog\\Model\\Product')]);
      const results = index.matchClasses('Xyz', matcher, 10);
      expect(results).toEqual([]);
    });

    it('addClass adds a single entry', () => {
      index.setClasses([]);
      index.addClass(classEntry('New\\Class\\Here'), '/path/to/Here.php');
      expect(index.getClassCount()).toBe(1);

      const results = index.matchClasses('NewClass', matcher, 10);
      expect(results).toContain('New\\Class\\Here');
    });

    it('removeClass removes by file path', () => {
      index.setClasses([]);
      index.addClass(classEntry('New\\Class\\Here'), '/path/to/Here.php');
      expect(index.getClassCount()).toBe(1);

      index.removeClass('/path/to/Here.php');
      expect(index.getClassCount()).toBe(0);
    });

    it('addClass replaces existing entry for same file', () => {
      index.setClasses([]);
      index.addClass(classEntry('Old\\Name'), '/path/to/File.php');
      index.addClass(classEntry('New\\Name'), '/path/to/File.php');
      expect(index.getClassCount()).toBe(1);

      const results = index.matchClasses('New', matcher, 10);
      expect(results).toContain('New\\Name');
    });

    it('getAllClassFqcns iterates all FQCNs', () => {
      index.setClasses([
        classEntry('A\\B'),
        classEntry('C\\D'),
      ]);

      const fqcns = [...index.getAllClassFqcns()];
      expect(fqcns).toContain('A\\B');
      expect(fqcns).toContain('C\\D');
    });
  });

  // ── Template operations ───────────────────────────────────────────────

  describe('templates', () => {
    it('setTemplates populates the index', () => {
      index.setTemplates([
        templateEntry('Magento_Catalog::product/view.phtml', 'frontend'),
        templateEntry('Magento_Checkout::cart/item.phtml', 'frontend'),
      ]);
      expect(index.getTemplateCount()).toBe(2);
    });

    it('matchTemplates finds matching entries in the correct area', () => {
      index.setTemplates([
        templateEntry('Magento_Catalog::product/view.phtml', 'frontend'),
        templateEntry('Magento_Catalog::product/admin.phtml', 'adminhtml'),
      ]);

      const frontendResults = index.matchTemplates('product/view', 'frontend', matcher, 10);
      expect(frontendResults).toContain('Magento_Catalog::product/view.phtml');
      expect(frontendResults).not.toContain('Magento_Catalog::product/admin.phtml');
    });

    it('matchTemplates includes base-area templates in frontend queries', () => {
      index.setTemplates([
        templateEntry('Magento_Catalog::product/view.phtml', 'frontend'),
        templateEntry('Magento_Catalog::product/base.phtml', 'base'),
      ]);

      const results = index.matchTemplates('product', 'frontend', matcher, 10);
      expect(results).toContain('Magento_Catalog::product/view.phtml');
      expect(results).toContain('Magento_Catalog::product/base.phtml');
    });

    it('matchTemplates includes base-area templates in adminhtml queries', () => {
      index.setTemplates([
        templateEntry('Magento_Catalog::product/base.phtml', 'base'),
      ]);

      const results = index.matchTemplates('product', 'adminhtml', matcher, 10);
      expect(results).toContain('Magento_Catalog::product/base.phtml');
    });

    it('matchTemplates does not include frontend templates in adminhtml queries', () => {
      index.setTemplates([
        templateEntry('Magento_Catalog::product/view.phtml', 'frontend'),
      ]);

      const results = index.matchTemplates('product', 'adminhtml', matcher, 10);
      expect(results).not.toContain('Magento_Catalog::product/view.phtml');
    });

    it('addTemplate adds a single entry', () => {
      index.setTemplates([]);
      index.addTemplate(templateEntry('New_Module::new.phtml', 'frontend', '/path/new.phtml'));
      expect(index.getTemplateCount()).toBe(1);
    });

    it('removeTemplate removes by file path', () => {
      const entry = templateEntry('New_Module::new.phtml', 'frontend', '/path/new.phtml');
      index.setTemplates([]);
      index.addTemplate(entry);
      expect(index.getTemplateCount()).toBe(1);

      index.removeTemplate('/path/new.phtml');
      expect(index.getTemplateCount()).toBe(0);
    });

    it('matchTemplates respects limit', () => {
      index.setTemplates([
        templateEntry('Mod_A::a.phtml', 'frontend'),
        templateEntry('Mod_B::b.phtml', 'frontend'),
        templateEntry('Mod_C::c.phtml', 'frontend'),
      ]);

      // Empty query matches everything
      const results = index.matchTemplates('', 'frontend', matcher, 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });
});
