import { describe, it, expect } from 'vitest';
import { SystemConfigIndex } from '../../src/index/systemConfigIndex';
import { SystemConfigReference } from '../../src/indexer/types';

function makeRef(overrides: Partial<SystemConfigReference> & { configPath: string; kind: SystemConfigReference['kind'] }): SystemConfigReference {
  return {
    file: '/test/system.xml',
    line: 0,
    column: 0,
    endColumn: 10,
    module: 'Test_Module',
    ...overrides,
  };
}

describe('SystemConfigIndex', () => {
  it('indexes and retrieves references by config path', () => {
    const index = new SystemConfigIndex();
    const refs: SystemConfigReference[] = [
      makeRef({ kind: 'field-id', configPath: 'payment/account/active', line: 5, column: 20, endColumn: 26 }),
    ];
    index.addFile('/test/system.xml', refs);

    const result = index.getRefsForPath('payment/account/active');
    expect(result).toHaveLength(1);
    expect(result[0].configPath).toBe('payment/account/active');
  });

  it('indexes and retrieves references by FQCN', () => {
    const index = new SystemConfigIndex();
    const refs: SystemConfigReference[] = [
      makeRef({ kind: 'source-model', configPath: 'payment/account/active', fqcn: 'Magento\\Config\\Model\\Config\\Source\\Yesno' }),
    ];
    index.addFile('/test/system.xml', refs);

    const result = index.getRefsForFqcn('Magento\\Config\\Model\\Config\\Source\\Yesno');
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('source-model');
  });

  it('returns empty array for unknown path', () => {
    const index = new SystemConfigIndex();
    expect(index.getRefsForPath('nonexistent/path')).toEqual([]);
  });

  it('returns empty array for unknown FQCN', () => {
    const index = new SystemConfigIndex();
    expect(index.getRefsForFqcn('Unknown\\Class')).toEqual([]);
  });

  it('finds reference at cursor position', () => {
    const index = new SystemConfigIndex();
    const refs: SystemConfigReference[] = [
      makeRef({ kind: 'section-id', configPath: 'payment', line: 3, column: 21, endColumn: 28 }),
      makeRef({ kind: 'field-id', configPath: 'payment/account/active', line: 5, column: 24, endColumn: 30 }),
    ];
    index.addFile('/test/system.xml', refs);

    const atSection = index.getReferenceAtPosition('/test/system.xml', 3, 25);
    expect(atSection).toBeDefined();
    expect(atSection!.kind).toBe('section-id');

    const atField = index.getReferenceAtPosition('/test/system.xml', 5, 26);
    expect(atField).toBeDefined();
    expect(atField!.kind).toBe('field-id');

    // No reference at unrelated position
    const none = index.getReferenceAtPosition('/test/system.xml', 10, 0);
    expect(none).toBeUndefined();
  });

  it('removes file entries cleanly', () => {
    const index = new SystemConfigIndex();
    const refs: SystemConfigReference[] = [
      makeRef({ kind: 'field-id', configPath: 'payment/account/active' }),
      makeRef({ kind: 'source-model', configPath: 'payment/account/active', fqcn: 'Vendor\\Source' }),
    ];
    index.addFile('/test/system.xml', refs);

    expect(index.getRefsForPath('payment/account/active')).toHaveLength(2);
    expect(index.getRefsForFqcn('Vendor\\Source')).toHaveLength(1);

    index.removeFile('/test/system.xml');

    expect(index.getRefsForPath('payment/account/active')).toEqual([]);
    expect(index.getRefsForFqcn('Vendor\\Source')).toEqual([]);
    expect(index.getFileCount()).toBe(0);
  });

  it('handles multi-module same config path', () => {
    const index = new SystemConfigIndex();

    index.addFile('/module-a/system.xml', [
      makeRef({ kind: 'field-id', configPath: 'payment/account/active', file: '/module-a/system.xml', module: 'Module_A' }),
    ]);
    index.addFile('/module-b/system.xml', [
      makeRef({ kind: 'field-id', configPath: 'payment/account/active', file: '/module-b/system.xml', module: 'Module_B' }),
    ]);

    const result = index.getRefsForPath('payment/account/active');
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.module).sort()).toEqual(['Module_A', 'Module_B']);
  });

  it('removeFile only affects the specified file', () => {
    const index = new SystemConfigIndex();

    index.addFile('/module-a/system.xml', [
      makeRef({ kind: 'field-id', configPath: 'payment/account/active', file: '/module-a/system.xml', module: 'Module_A' }),
    ]);
    index.addFile('/module-b/system.xml', [
      makeRef({ kind: 'field-id', configPath: 'payment/account/active', file: '/module-b/system.xml', module: 'Module_B' }),
    ]);

    index.removeFile('/module-a/system.xml');

    const result = index.getRefsForPath('payment/account/active');
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('Module_B');
  });

  it('getAllConfigPaths returns all indexed paths', () => {
    const index = new SystemConfigIndex();
    index.addFile('/test/system.xml', [
      makeRef({ kind: 'section-id', configPath: 'payment' }),
      makeRef({ kind: 'group-id', configPath: 'payment/account' }),
      makeRef({ kind: 'field-id', configPath: 'payment/account/active' }),
    ]);

    const paths = [...index.getAllConfigPaths()];
    expect(paths).toContain('payment');
    expect(paths).toContain('payment/account');
    expect(paths).toContain('payment/account/active');
  });

  it('getRefsForFile returns all references in a file', () => {
    const index = new SystemConfigIndex();
    const refs: SystemConfigReference[] = [
      makeRef({ kind: 'section-id', configPath: 'payment' }),
      makeRef({ kind: 'field-id', configPath: 'payment/account/active' }),
      makeRef({ kind: 'source-model', configPath: 'payment/account/active', fqcn: 'Vendor\\Source' }),
    ];
    index.addFile('/test/system.xml', refs);

    expect(index.getRefsForFile('/test/system.xml')).toHaveLength(3);
    expect(index.getRefsForFile('/other/file.xml')).toEqual([]);
  });
});
