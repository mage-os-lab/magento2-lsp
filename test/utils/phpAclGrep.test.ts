import { describe, it, expect } from 'vitest';
import { createPhpAclRegex } from '../../src/utils/phpAclGrep';

describe('createPhpAclRegex', () => {
  // --- ADMIN_RESOURCE constant pattern ---

  it('matches const ADMIN_RESOURCE with single-quoted value', () => {
    const re = createPhpAclRegex();
    const line = "    const ADMIN_RESOURCE = 'Magento_Customer::manage';";
    const match = re.exec(line);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('Magento_Customer::manage');
  });

  it('matches const ADMIN_RESOURCE with double-quoted value', () => {
    const re = createPhpAclRegex();
    const line = '    const ADMIN_RESOURCE = "Magento_Sales::sales_order";';
    const match = re.exec(line);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('Magento_Sales::sales_order');
  });

  it('matches ADMIN_RESOURCE with extra whitespace around equals', () => {
    const re = createPhpAclRegex();
    const line = "    const ADMIN_RESOURCE  =  'Magento_Cms::page';";
    const match = re.exec(line);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('Magento_Cms::page');
  });

  // --- isAllowed() call pattern ---

  it('matches ->isAllowed() with single-quoted value', () => {
    const re = createPhpAclRegex();
    const line = "        return $this->_authorization->isAllowed('Magento_Customer::manage');";
    const match = re.exec(line);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('Magento_Customer::manage');
  });

  it('matches ->isAllowed() with double-quoted value', () => {
    const re = createPhpAclRegex();
    const line = '        $this->authorization->isAllowed("Magento_Sales::sales");';
    const match = re.exec(line);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('Magento_Sales::sales');
  });

  it('matches ->isAllowed() with whitespace inside parentheses', () => {
    const re = createPhpAclRegex();
    const line = "        $this->_authorization->isAllowed( 'Magento_Catalog::products' )";
    const match = re.exec(line);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('Magento_Catalog::products');
  });

  // --- Non-matches ---

  it('does not match strings without :: separator (not an ACL resource ID)', () => {
    const re = createPhpAclRegex();
    const line = "    const ADMIN_RESOURCE = 'not_a_resource';";
    const match = re.exec(line);
    expect(match).toBeNull();
  });

  it('does not match isAllowed with non-ACL string', () => {
    const re = createPhpAclRegex();
    const line = "$this->auth->isAllowed('some_value')";
    const match = re.exec(line);
    expect(match).toBeNull();
  });

  // --- Multiple matches on the same line ---

  it('finds multiple matches on one line via exec loop', () => {
    const re = createPhpAclRegex();
    const line = "->isAllowed('A::one') || ->isAllowed('B::two')";
    const matches: string[] = [];
    let m;
    while ((m = re.exec(line)) !== null) {
      matches.push(m[1]);
    }
    expect(matches).toEqual(['A::one', 'B::two']);
  });

  // --- Fresh regex per call (no stale lastIndex) ---

  it('returns a fresh regex each call (no shared lastIndex state)', () => {
    const re1 = createPhpAclRegex();
    const line = "    const ADMIN_RESOURCE = 'Magento_Backend::admin';";
    re1.exec(line);
    // A second fresh regex should match from the start
    const re2 = createPhpAclRegex();
    const match = re2.exec(line);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('Magento_Backend::admin');
  });

  // --- Capture group position (used by handlers for cursor detection) ---

  it('places the ACL resource ID in capture group 1 for ADMIN_RESOURCE', () => {
    const re = createPhpAclRegex();
    const line = "    const ADMIN_RESOURCE = 'Test_Module::resource';";
    const match = re.exec(line);
    expect(match).not.toBeNull();
    // Verify the captured ID can be located within the full match
    const fullMatch = match![0];
    const aclId = match![1];
    const idOffset = fullMatch.indexOf(aclId);
    expect(idOffset).toBeGreaterThan(0);
    // The absolute position in the line
    const absStart = match!.index + idOffset;
    expect(line.slice(absStart, absStart + aclId.length)).toBe('Test_Module::resource');
  });

  it('places the ACL resource ID in capture group 1 for isAllowed', () => {
    const re = createPhpAclRegex();
    const line = "        $this->_authorization->isAllowed('Test_Module::action');";
    const match = re.exec(line);
    expect(match).not.toBeNull();
    const fullMatch = match![0];
    const aclId = match![1];
    const absStart = match!.index + fullMatch.indexOf(aclId);
    expect(line.slice(absStart, absStart + aclId.length)).toBe('Test_Module::action');
  });
});
