import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { detectMagentoRoot } from '../../src/project/detector';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('detectMagentoRoot', () => {
  it('finds Magento root from the root directory itself', () => {
    expect(detectMagentoRoot(FIXTURE_ROOT)).toBe(FIXTURE_ROOT);
  });

  it('finds Magento root from a nested vendor directory', () => {
    const nested = path.join(FIXTURE_ROOT, 'vendor', 'test', 'module-foo', 'Model');
    expect(detectMagentoRoot(nested)).toBe(FIXTURE_ROOT);
  });

  it('finds Magento root from app/code directory', () => {
    const nested = path.join(FIXTURE_ROOT, 'app', 'code', 'Custom', 'Bar');
    expect(detectMagentoRoot(nested)).toBe(FIXTURE_ROOT);
  });

  it('returns undefined when no Magento root is found', () => {
    // Use /tmp which should not contain app/etc/di.xml
    expect(detectMagentoRoot('/tmp')).toBeUndefined();
  });
});
