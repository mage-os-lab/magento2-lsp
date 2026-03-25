import { describe, it, expect } from 'vitest';
import { WebapiIndex } from '../../src/index/webapiIndex';
import { WebapiReference } from '../../src/indexer/types';

function makeRef(overrides: Partial<WebapiReference> & { kind: WebapiReference['kind']; value: string }): WebapiReference {
  return {
    routeUrl: '/V1/test',
    httpMethod: 'GET',
    file: '/test/webapi.xml',
    line: 0,
    column: 0,
    endColumn: 10,
    module: 'Test_Module',
    ...overrides,
  };
}

describe('WebapiIndex', () => {
  it('indexes and retrieves references by FQCN', () => {
    const index = new WebapiIndex();
    const refs: WebapiReference[] = [
      makeRef({ kind: 'service-class', value: 'Vendor\\Api\\TestInterface', fqcn: 'Vendor\\Api\\TestInterface' }),
      makeRef({ kind: 'service-method', value: 'getById', fqcn: 'Vendor\\Api\\TestInterface', methodName: 'getById' }),
    ];
    index.addFile('/test/webapi.xml', refs);

    const result = index.getRefsForFqcn('Vendor\\Api\\TestInterface');
    expect(result).toHaveLength(2);
  });

  it('indexes and retrieves references by method composite key', () => {
    const index = new WebapiIndex();
    const refs: WebapiReference[] = [
      makeRef({ kind: 'service-method', value: 'getById', fqcn: 'Vendor\\Api\\TestInterface', methodName: 'getById' }),
      makeRef({ kind: 'service-method', value: 'save', fqcn: 'Vendor\\Api\\TestInterface', methodName: 'save', httpMethod: 'POST' }),
    ];
    index.addFile('/test/webapi.xml', refs);

    const getByIdRefs = index.getRefsForMethod('Vendor\\Api\\TestInterface', 'getById');
    expect(getByIdRefs).toHaveLength(1);
    expect(getByIdRefs[0].httpMethod).toBe('GET');

    const saveRefs = index.getRefsForMethod('Vendor\\Api\\TestInterface', 'save');
    expect(saveRefs).toHaveLength(1);
    expect(saveRefs[0].httpMethod).toBe('POST');
  });

  it('indexes and retrieves references by ACL resource', () => {
    const index = new WebapiIndex();
    const refs: WebapiReference[] = [
      makeRef({ kind: 'resource-ref', value: 'Vendor_Module::manage' }),
      makeRef({ kind: 'resource-ref', value: 'self', routeUrl: '/V1/me' }),
    ];
    index.addFile('/test/webapi.xml', refs);

    expect(index.getRefsForResource('Vendor_Module::manage')).toHaveLength(1);
    expect(index.getRefsForResource('self')).toHaveLength(1);
    expect(index.getRefsForResource('anonymous')).toEqual([]);
  });

  it('returns empty array for unknown lookups', () => {
    const index = new WebapiIndex();
    expect(index.getRefsForFqcn('Unknown\\Class')).toEqual([]);
    expect(index.getRefsForMethod('Unknown\\Class', 'method')).toEqual([]);
    expect(index.getRefsForResource('Unknown::resource')).toEqual([]);
  });

  it('finds reference at cursor position', () => {
    const index = new WebapiIndex();
    const refs: WebapiReference[] = [
      makeRef({ kind: 'service-class', value: 'Vendor\\Api\\Test', fqcn: 'Vendor\\Api\\Test', line: 3, column: 24, endColumn: 40 }),
      makeRef({ kind: 'service-method', value: 'get', fqcn: 'Vendor\\Api\\Test', methodName: 'get', line: 3, column: 50, endColumn: 53 }),
      makeRef({ kind: 'resource-ref', value: 'self', line: 5, column: 26, endColumn: 30 }),
    ];
    index.addFile('/test/webapi.xml', refs);

    const atClass = index.getReferenceAtPosition('/test/webapi.xml', 3, 30);
    expect(atClass).toBeDefined();
    expect(atClass!.kind).toBe('service-class');

    const atMethod = index.getReferenceAtPosition('/test/webapi.xml', 3, 51);
    expect(atMethod).toBeDefined();
    expect(atMethod!.kind).toBe('service-method');

    const atResource = index.getReferenceAtPosition('/test/webapi.xml', 5, 27);
    expect(atResource).toBeDefined();
    expect(atResource!.kind).toBe('resource-ref');

    const none = index.getReferenceAtPosition('/test/webapi.xml', 10, 0);
    expect(none).toBeUndefined();
  });

  it('removes file entries cleanly', () => {
    const index = new WebapiIndex();
    const refs: WebapiReference[] = [
      makeRef({ kind: 'service-class', value: 'Vendor\\Api\\Test', fqcn: 'Vendor\\Api\\Test' }),
      makeRef({ kind: 'service-method', value: 'get', fqcn: 'Vendor\\Api\\Test', methodName: 'get' }),
      makeRef({ kind: 'resource-ref', value: 'Vendor_Module::manage' }),
    ];
    index.addFile('/test/webapi.xml', refs);

    expect(index.getRefsForFqcn('Vendor\\Api\\Test')).toHaveLength(2);
    expect(index.getRefsForMethod('Vendor\\Api\\Test', 'get')).toHaveLength(1);
    expect(index.getRefsForResource('Vendor_Module::manage')).toHaveLength(1);

    index.removeFile('/test/webapi.xml');

    expect(index.getRefsForFqcn('Vendor\\Api\\Test')).toEqual([]);
    expect(index.getRefsForMethod('Vendor\\Api\\Test', 'get')).toEqual([]);
    expect(index.getRefsForResource('Vendor_Module::manage')).toEqual([]);
    expect(index.getFileCount()).toBe(0);
  });

  it('removeFile only affects the specified file', () => {
    const index = new WebapiIndex();

    index.addFile('/module-a/webapi.xml', [
      makeRef({ kind: 'service-class', value: 'Vendor\\Api\\Test', fqcn: 'Vendor\\Api\\Test', file: '/module-a/webapi.xml', module: 'Module_A' }),
    ]);
    index.addFile('/module-b/webapi.xml', [
      makeRef({ kind: 'service-class', value: 'Vendor\\Api\\Test', fqcn: 'Vendor\\Api\\Test', file: '/module-b/webapi.xml', module: 'Module_B' }),
    ]);

    index.removeFile('/module-a/webapi.xml');

    const result = index.getRefsForFqcn('Vendor\\Api\\Test');
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('Module_B');
  });

  it('handles multiple routes for the same method', () => {
    const index = new WebapiIndex();
    index.addFile('/test/webapi.xml', [
      makeRef({ kind: 'service-method', value: 'getById', fqcn: 'Vendor\\Api\\Test', methodName: 'getById', routeUrl: '/V1/test/:id' }),
      makeRef({ kind: 'service-method', value: 'getById', fqcn: 'Vendor\\Api\\Test', methodName: 'getById', routeUrl: '/V1/test/me', line: 5 }),
    ]);

    const result = index.getRefsForMethod('Vendor\\Api\\Test', 'getById');
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.routeUrl).sort()).toEqual(['/V1/test/:id', '/V1/test/me']);
  });

  it('getRefsForFile returns all references in a file', () => {
    const index = new WebapiIndex();
    const refs: WebapiReference[] = [
      makeRef({ kind: 'service-class', value: 'Vendor\\Api\\Test', fqcn: 'Vendor\\Api\\Test' }),
      makeRef({ kind: 'service-method', value: 'get', fqcn: 'Vendor\\Api\\Test', methodName: 'get' }),
      makeRef({ kind: 'resource-ref', value: 'anonymous' }),
    ];
    index.addFile('/test/webapi.xml', refs);

    expect(index.getRefsForFile('/test/webapi.xml')).toHaveLength(3);
    expect(index.getRefsForFile('/other/file.xml')).toEqual([]);
  });
});
