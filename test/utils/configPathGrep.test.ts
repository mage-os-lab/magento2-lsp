import { describe, it, expect } from 'vitest';
import { createScopeConfigRegex } from '../../src/utils/configPathGrep';

describe('createScopeConfigRegex', () => {
  it('matches scopeConfig->getValue with single-quoted path', () => {
    const re = createScopeConfigRegex();
    const line = "$this->scopeConfig->getValue('catalog/review/active')";
    const match = re.exec(line);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('catalog/review/active');
  });

  it('matches scopeConfig->getValue with double-quoted path', () => {
    const re = createScopeConfigRegex();
    const line = '$this->scopeConfig->getValue("payment/account/active")';
    const match = re.exec(line);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('payment/account/active');
  });

  it('matches _scopeConfig property name', () => {
    const re = createScopeConfigRegex();
    const line = "$this->_scopeConfig->getValue('web/secure/base_url')";
    const match = re.exec(line);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('web/secure/base_url');
  });

  it('matches isSetFlag calls', () => {
    const re = createScopeConfigRegex();
    const line = "$this->scopeConfig->isSetFlag('catalog/frontend/flat_catalog_product')";
    const match = re.exec(line);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('catalog/frontend/flat_catalog_product');
  });

  it('matches with whitespace around parenthesis', () => {
    const re = createScopeConfigRegex();
    const line = "$this->scopeConfig->getValue( 'tax/calculation/based_on' )";
    const match = re.exec(line);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('tax/calculation/based_on');
  });

  it('does not match single-segment paths', () => {
    const re = createScopeConfigRegex();
    const line = "$this->scopeConfig->getValue('general')";
    const match = re.exec(line);
    expect(match).toBeNull();
  });

  it('returns a fresh regex each call (no shared lastIndex state)', () => {
    const re1 = createScopeConfigRegex();
    const line = "$this->scopeConfig->getValue('a/b/c')";
    re1.exec(line);
    // A second fresh regex should match from the start, not from re1's lastIndex
    const re2 = createScopeConfigRegex();
    const match = re2.exec(line);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('a/b/c');
  });
});
