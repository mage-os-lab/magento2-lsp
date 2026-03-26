import { describe, it, expect, beforeEach } from 'vitest';
import { RoutesIndex } from '../../src/index/routesIndex';
import { RoutesReference } from '../../src/indexer/types';

function makeRef(overrides: Partial<RoutesReference> = {}): RoutesReference {
  return {
    kind: 'route-module',
    value: 'Test_Foo',
    routerType: 'standard',
    frontName: 'testfoo',
    routeId: 'testfoo',
    area: 'frontend',
    file: '/vendor/test/module-foo/etc/frontend/routes.xml',
    line: 3,
    column: 10,
    endColumn: 18,
    module: 'Test_Foo',
    ...overrides,
  };
}

describe('RoutesIndex', () => {
  let index: RoutesIndex;

  beforeEach(() => {
    index = new RoutesIndex();
  });

  it('adds and retrieves references by frontName', () => {
    const ref = makeRef({ kind: 'route-frontname', value: 'catalog', frontName: 'catalog' });
    index.addFile('/a.xml', [ref]);

    expect(index.getRefsForFrontName('catalog')).toHaveLength(1);
    expect(index.getRefsForFrontName('catalog')[0]).toBe(ref);
    expect(index.getRefsForFrontName('unknown')).toHaveLength(0);
  });

  it('adds and retrieves references by module name', () => {
    const ref = makeRef({ kind: 'route-module', value: 'Magento_Catalog' });
    index.addFile('/a.xml', [ref]);

    expect(index.getRefsForModuleName('Magento_Catalog')).toHaveLength(1);
    expect(index.getRefsForModuleName('Unknown_Module')).toHaveLength(0);
  });

  it('adds and retrieves references by route id', () => {
    const ref = makeRef({ kind: 'route-id', value: 'catalog', routeId: 'catalog' });
    index.addFile('/a.xml', [ref]);

    expect(index.getRefsForRouteId('catalog')).toHaveLength(1);
    expect(index.getRefsForRouteId('unknown')).toHaveLength(0);
  });

  it('aggregates refs across multiple files for the same frontName', () => {
    const ref1 = makeRef({ kind: 'route-module', value: 'Mod_A', frontName: 'catalog', file: '/a.xml' });
    const ref2 = makeRef({ kind: 'route-module', value: 'Mod_B', frontName: 'catalog', file: '/b.xml' });

    index.addFile('/a.xml', [ref1]);
    index.addFile('/b.xml', [ref2]);

    expect(index.getRefsForFrontName('catalog')).toHaveLength(2);
  });

  it('removes file and cleans up all maps', () => {
    const file = '/a.xml';
    const refs = [
      makeRef({ kind: 'route-id', value: 'catalog', routeId: 'catalog', frontName: 'catalog', file }),
      makeRef({ kind: 'route-frontname', value: 'catalog', frontName: 'catalog', routeId: 'catalog', file }),
      makeRef({ kind: 'route-module', value: 'Magento_Catalog', frontName: 'catalog', routeId: 'catalog', file }),
    ];
    index.addFile(file, refs);

    expect(index.getFileCount()).toBe(1);
    index.removeFile('/a.xml');

    expect(index.getFileCount()).toBe(0);
    expect(index.getRefsForFrontName('catalog')).toHaveLength(0);
    expect(index.getRefsForModuleName('Magento_Catalog')).toHaveLength(0);
    expect(index.getRefsForRouteId('catalog')).toHaveLength(0);
  });

  it('getReferenceAtPosition finds the correct ref', () => {
    const ref = makeRef({ line: 3, column: 10, endColumn: 18, file: '/a.xml' });
    index.addFile('/a.xml', [ref]);

    expect(index.getReferenceAtPosition('/a.xml', 3, 10)).toBe(ref);
    expect(index.getReferenceAtPosition('/a.xml', 3, 17)).toBe(ref);
    // Also matches on surrounding quotes (column-1 and endColumn)
    expect(index.getReferenceAtPosition('/a.xml', 3, 9)).toBe(ref);
    expect(index.getReferenceAtPosition('/a.xml', 3, 18)).toBe(ref);
    // Outside the extended range
    expect(index.getReferenceAtPosition('/a.xml', 3, 8)).toBeUndefined();
    expect(index.getReferenceAtPosition('/a.xml', 3, 19)).toBeUndefined();
    expect(index.getReferenceAtPosition('/a.xml', 4, 10)).toBeUndefined();
  });

  it('getRefsForFile returns all refs in a file', () => {
    const refs = [
      makeRef({ kind: 'route-id', value: 'catalog' }),
      makeRef({ kind: 'route-module', value: 'Magento_Catalog' }),
    ];
    index.addFile('/a.xml', refs);

    expect(index.getRefsForFile('/a.xml')).toHaveLength(2);
    expect(index.getRefsForFile('/b.xml')).toHaveLength(0);
  });

  it('clear removes all data', () => {
    index.addFile('/a.xml', [makeRef()]);
    index.addFile('/b.xml', [makeRef({ file: '/b.xml' })]);

    index.clear();

    expect(index.getFileCount()).toBe(0);
    expect(index.getRefsForFrontName('testfoo')).toHaveLength(0);
  });

  it('removeFile is a no-op for unknown files', () => {
    index.removeFile('/nonexistent.xml');
    expect(index.getFileCount()).toBe(0);
  });
});
