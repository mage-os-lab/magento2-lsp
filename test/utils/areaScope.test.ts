import { describe, it, expect } from 'vitest';
import { isAreaCompatible } from '../../src/utils/areaScope';

describe('isAreaCompatible', () => {
  describe('frontend source', () => {
    it('includes frontend refs', () => {
      expect(isAreaCompatible('frontend', 'frontend')).toBe(true);
    });
    it('excludes adminhtml refs', () => {
      expect(isAreaCompatible('frontend', 'adminhtml')).toBe(false);
    });
    it('includes base refs (base is a universal fallback)', () => {
      expect(isAreaCompatible('frontend', 'base')).toBe(true);
    });
  });

  describe('adminhtml source', () => {
    it('includes adminhtml refs', () => {
      expect(isAreaCompatible('adminhtml', 'adminhtml')).toBe(true);
    });
    it('excludes frontend refs', () => {
      expect(isAreaCompatible('adminhtml', 'frontend')).toBe(false);
    });
    it('includes base refs', () => {
      expect(isAreaCompatible('adminhtml', 'base')).toBe(true);
    });
  });

  describe('base source (affects all areas)', () => {
    it('includes frontend refs', () => {
      expect(isAreaCompatible('base', 'frontend')).toBe(true);
    });
    it('includes adminhtml refs', () => {
      expect(isAreaCompatible('base', 'adminhtml')).toBe(true);
    });
    it('includes base refs', () => {
      expect(isAreaCompatible('base', 'base')).toBe(true);
    });
  });

  describe('undefined areas (safe fallback — always include)', () => {
    it('includes when source area is undefined', () => {
      expect(isAreaCompatible(undefined, 'frontend')).toBe(true);
    });
    it('includes when ref area is undefined', () => {
      expect(isAreaCompatible('frontend', undefined)).toBe(true);
    });
    it('includes when both areas are undefined', () => {
      expect(isAreaCompatible(undefined, undefined)).toBe(true);
    });
  });
});
