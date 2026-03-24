import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveXmlUrn } from '../../src/utils/xmlUrnResolver';
import { ModuleInfo } from '../../src/indexer/types';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

const modules: ModuleInfo[] = [
  {
    name: 'Test_Foo',
    path: path.join(FIXTURE_ROOT, 'vendor/test/module-foo'),
    order: 0,
  },
  {
    name: 'Custom_Bar',
    path: path.join(FIXTURE_ROOT, 'app/code/Custom/Bar'),
    order: 1,
  },
];

describe('resolveXmlUrn', () => {
  // --- Framework URNs ---

  it('resolves framework URN to vendor/magento/framework path', () => {
    const result = resolveXmlUrn(
      'urn:magento:framework:ObjectManager/etc/config.xsd',
      FIXTURE_ROOT,
      modules,
    );
    expect(result).toBe(
      path.join(FIXTURE_ROOT, 'vendor/magento/framework/ObjectManager/etc/config.xsd'),
    );
  });

  it('resolves framework URN with nested path', () => {
    const result = resolveXmlUrn(
      'urn:magento:framework:Data/etc/argument/types.xsd',
      FIXTURE_ROOT,
      modules,
    );
    expect(result).toBe(
      path.join(FIXTURE_ROOT, 'vendor/magento/framework/Data/etc/argument/types.xsd'),
    );
  });

  it('resolves framework-* package URN', () => {
    const result = resolveXmlUrn(
      'urn:magento:framework-message-queue:etc/publisher.xsd',
      FIXTURE_ROOT,
      modules,
    );
    expect(result).toBe(
      path.join(FIXTURE_ROOT, 'vendor/magento/framework-message-queue/etc/publisher.xsd'),
    );
  });

  // --- Module URNs ---

  it('resolves module URN for a vendor module', () => {
    const result = resolveXmlUrn(
      'urn:magento:module:Test_Foo:etc/module_config.xsd',
      FIXTURE_ROOT,
      modules,
    );
    expect(result).toBe(
      path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/module_config.xsd'),
    );
  });

  // --- Edge cases ---

  it('returns undefined for unknown module', () => {
    const result = resolveXmlUrn(
      'urn:magento:module:Unknown_Module:etc/config.xsd',
      FIXTURE_ROOT,
      modules,
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined for non-existent file', () => {
    const result = resolveXmlUrn(
      'urn:magento:framework:Does/Not/Exist.xsd',
      FIXTURE_ROOT,
      modules,
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined for non-URN string', () => {
    const result = resolveXmlUrn('not-a-urn', FIXTURE_ROOT, modules);
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    const result = resolveXmlUrn('', FIXTURE_ROOT, modules);
    expect(result).toBeUndefined();
  });
});
