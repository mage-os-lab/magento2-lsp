import { describe, it, expect } from 'vitest';
import { normalizeFqcn } from '../../src/utils/fqcnNormalize';

describe('normalizeFqcn', () => {
  it('returns FQCN unchanged when no leading backslash', () => {
    expect(normalizeFqcn('Magento\\Store\\Model\\StoreManager')).toBe(
      'Magento\\Store\\Model\\StoreManager',
    );
  });

  it('strips leading backslash', () => {
    expect(normalizeFqcn('\\Magento\\Store\\Model\\StoreManager')).toBe(
      'Magento\\Store\\Model\\StoreManager',
    );
  });

  it('trims whitespace', () => {
    expect(normalizeFqcn('  Magento\\Store\\Model\\StoreManager  ')).toBe(
      'Magento\\Store\\Model\\StoreManager',
    );
  });

  it('trims whitespace and strips leading backslash', () => {
    expect(normalizeFqcn('  \\Magento\\Store\\Model\\StoreManager  ')).toBe(
      'Magento\\Store\\Model\\StoreManager',
    );
  });

  it('handles single-segment class name', () => {
    expect(normalizeFqcn('DateTime')).toBe('DateTime');
  });

  it('handles single-segment with leading backslash', () => {
    expect(normalizeFqcn('\\DateTime')).toBe('DateTime');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeFqcn('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeFqcn('   ')).toBe('');
  });

  it('strips only the first leading backslash', () => {
    expect(normalizeFqcn('\\\\Double')).toBe('\\Double');
  });
});
