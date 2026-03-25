import { describe, it, expect, beforeEach } from 'vitest';
import { AclIndex } from '../../src/index/aclIndex';
import { AclResource } from '../../src/indexer/types';

function makeResource(overrides: Partial<AclResource> = {}): AclResource {
  return {
    id: 'Magento_Customer::manage',
    title: 'All Customers',
    parentId: 'Magento_Customer::customer',
    hierarchyPath: ['Magento_Backend::admin', 'Magento_Customer::customer', 'Magento_Customer::manage'],
    file: '/vendor/magento/module-customer/etc/acl.xml',
    line: 5,
    column: 26,
    endColumn: 50,
    module: 'Magento_Customer',
    ...overrides,
  };
}

describe('AclIndex', () => {
  let index: AclIndex;

  beforeEach(() => {
    index = new AclIndex();
  });

  it('adds and retrieves resources by ID', () => {
    const res = makeResource();
    index.addFile(res.file, [res]);

    expect(index.getResource('Magento_Customer::manage')).toBe(res);
    expect(index.getAllResources('Magento_Customer::manage')).toEqual([res]);
  });

  it('returns undefined for unknown resource ID', () => {
    expect(index.getResource('Unknown::resource')).toBeUndefined();
    expect(index.getAllResources('Unknown::resource')).toEqual([]);
  });

  it('stores multiple definitions for the same resource ID from different files', () => {
    const res1 = makeResource({ file: '/module-a/etc/acl.xml', module: 'Module_A' });
    const res2 = makeResource({ file: '/module-b/etc/acl.xml', module: 'Module_B' });

    index.addFile(res1.file, [res1]);
    index.addFile(res2.file, [res2]);

    const all = index.getAllResources('Magento_Customer::manage');
    expect(all).toHaveLength(2);
    // getResource returns the first one added
    expect(index.getResource('Magento_Customer::manage')).toBe(res1);
  });

  it('removes all resources for a file', () => {
    const file = '/vendor/test/etc/acl.xml';
    const res1 = makeResource({ id: 'A::one', file });
    const res2 = makeResource({ id: 'B::two', file });
    index.addFile(file, [res1, res2]);

    expect(index.getResource('A::one')).toBeDefined();
    expect(index.getResource('B::two')).toBeDefined();

    index.removeFile(file);

    expect(index.getResource('A::one')).toBeUndefined();
    expect(index.getResource('B::two')).toBeUndefined();
    expect(index.getFileCount()).toBe(0);
  });

  it('only removes resources from the specified file', () => {
    const res1 = makeResource({ id: 'Shared::res', file: '/file-a.xml', module: 'A' });
    const res2 = makeResource({ id: 'Shared::res', file: '/file-b.xml', module: 'B' });

    index.addFile('/file-a.xml', [res1]);
    index.addFile('/file-b.xml', [res2]);

    index.removeFile('/file-a.xml');

    expect(index.getAllResources('Shared::res')).toHaveLength(1);
    expect(index.getResource('Shared::res')!.module).toBe('B');
  });

  it('finds resource at cursor position', () => {
    const file = '/test/acl.xml';
    const res = makeResource({ file, line: 3, column: 10, endColumn: 35 });
    index.addFile(file, [res]);

    // Cursor within range
    expect(index.getResourceAtPosition(file, 3, 10)).toBe(res);
    expect(index.getResourceAtPosition(file, 3, 20)).toBe(res);
    expect(index.getResourceAtPosition(file, 3, 34)).toBe(res);

    // Cursor outside range
    expect(index.getResourceAtPosition(file, 3, 9)).toBeUndefined();
    expect(index.getResourceAtPosition(file, 3, 35)).toBeUndefined();
    expect(index.getResourceAtPosition(file, 4, 10)).toBeUndefined();

    // Wrong file
    expect(index.getResourceAtPosition('/other.xml', 3, 10)).toBeUndefined();
  });

  it('returns all resource IDs', () => {
    index.addFile('/a.xml', [
      makeResource({ id: 'A::one', file: '/a.xml' }),
      makeResource({ id: 'A::two', file: '/a.xml' }),
    ]);
    index.addFile('/b.xml', [
      makeResource({ id: 'B::three', file: '/b.xml' }),
    ]);

    const ids = index.getAllResourceIds();
    expect(ids).toContain('A::one');
    expect(ids).toContain('A::two');
    expect(ids).toContain('B::three');
  });

  it('reports correct file count', () => {
    expect(index.getFileCount()).toBe(0);

    index.addFile('/a.xml', [makeResource({ file: '/a.xml' })]);
    expect(index.getFileCount()).toBe(1);

    index.addFile('/b.xml', [makeResource({ file: '/b.xml' })]);
    expect(index.getFileCount()).toBe(2);

    index.removeFile('/a.xml');
    expect(index.getFileCount()).toBe(1);
  });

  it('clears all data', () => {
    index.addFile('/a.xml', [makeResource({ file: '/a.xml' })]);
    index.addFile('/b.xml', [makeResource({ file: '/b.xml' })]);

    index.clear();

    expect(index.getFileCount()).toBe(0);
    expect(index.getResource('Magento_Customer::manage')).toBeUndefined();
  });

  it('returns resources for a file', () => {
    const file = '/test/acl.xml';
    const resources = [
      makeResource({ id: 'A::one', file }),
      makeResource({ id: 'A::two', file }),
    ];
    index.addFile(file, resources);

    expect(index.getResourcesForFile(file)).toEqual(resources);
    expect(index.getResourcesForFile('/nonexistent.xml')).toEqual([]);
  });
});
