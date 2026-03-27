import { describe, it, expect, beforeEach } from 'vitest';
import { DiIndex } from '../../src/index/diIndex';
import { DiReference, VirtualTypeDecl } from '../../src/indexer/types';

function makeRef(overrides: Partial<DiReference>): DiReference {
  return {
    fqcn: 'Default\\Fqcn',
    kind: 'type-name',
    file: '/test/di.xml',
    line: 0,
    column: 0,
    endColumn: 10,
    area: 'global',
    module: 'Test_Module',
    moduleOrder: 0,
    ...overrides,
  };
}

function makeVt(overrides: Partial<VirtualTypeDecl>): VirtualTypeDecl {
  return {
    name: 'DefaultVirtualType',
    parentType: 'Default\\ParentClass',
    file: '/test/di.xml',
    line: 0,
    column: 0,
    area: 'global',
    module: 'Test_Module',
    moduleOrder: 0,
    ...overrides,
  };
}

describe('DiIndex', () => {
  let index: DiIndex;

  beforeEach(() => {
    index = new DiIndex();
  });

  describe('addFile / getReferencesForFqcn', () => {
    it('returns references for a known FQCN', () => {
      const ref = makeRef({ fqcn: 'Magento\\Store\\Model\\StoreManager' });
      index.addFile('/test/di.xml', [ref], []);
      const results = index.getReferencesForFqcn('Magento\\Store\\Model\\StoreManager');
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(ref);
    });

    it('returns empty array for unknown FQCN', () => {
      expect(index.getReferencesForFqcn('Unknown\\Class')).toHaveLength(0);
    });

    it('aggregates references from multiple files', () => {
      const ref1 = makeRef({
        fqcn: 'Shared\\Interface',
        file: '/module-a/etc/di.xml',
        kind: 'preference-for',
      });
      const ref2 = makeRef({
        fqcn: 'Shared\\Interface',
        file: '/module-b/etc/di.xml',
        kind: 'type-name',
      });
      index.addFile('/module-a/etc/di.xml', [ref1], []);
      index.addFile('/module-b/etc/di.xml', [ref2], []);
      expect(index.getReferencesForFqcn('Shared\\Interface')).toHaveLength(2);
    });
  });

  describe('removeFile', () => {
    it('removes references from a file', () => {
      const ref = makeRef({ fqcn: 'Foo\\Bar', file: '/test/di.xml' });
      index.addFile('/test/di.xml', [ref], []);
      expect(index.getReferencesForFqcn('Foo\\Bar')).toHaveLength(1);

      index.removeFile('/test/di.xml');
      expect(index.getReferencesForFqcn('Foo\\Bar')).toHaveLength(0);
    });

    it('only removes references from the specified file', () => {
      const ref1 = makeRef({ fqcn: 'Shared\\Class', file: '/a/di.xml' });
      const ref2 = makeRef({ fqcn: 'Shared\\Class', file: '/b/di.xml' });
      index.addFile('/a/di.xml', [ref1], []);
      index.addFile('/b/di.xml', [ref2], []);

      index.removeFile('/a/di.xml');
      const results = index.getReferencesForFqcn('Shared\\Class');
      expect(results).toHaveLength(1);
      expect(results[0].file).toBe('/b/di.xml');
    });

    it('removes virtual types from the file', () => {
      const vt = makeVt({ name: 'MyVirtualType', file: '/test/di.xml' });
      index.addFile('/test/di.xml', [], [vt]);
      expect(index.getEffectiveVirtualType('MyVirtualType')).toBeDefined();

      index.removeFile('/test/di.xml');
      expect(index.getEffectiveVirtualType('MyVirtualType')).toBeUndefined();
    });
  });

  describe('getReferenceAtPosition', () => {
    it('finds reference at exact position', () => {
      const ref = makeRef({
        fqcn: 'Foo\\Bar',
        file: '/test/di.xml',
        line: 3,
        column: 10,
        endColumn: 20,
      });
      index.addFile('/test/di.xml', [ref], []);

      expect(index.getReferenceAtPosition('/test/di.xml', 3, 10)).toEqual(ref);
      expect(index.getReferenceAtPosition('/test/di.xml', 3, 15)).toEqual(ref);
      expect(index.getReferenceAtPosition('/test/di.xml', 3, 19)).toEqual(ref);
    });

    it('matches on surrounding quote characters', () => {
      const ref = makeRef({
        fqcn: 'Foo\\Bar',
        file: '/test/di.xml',
        line: 3,
        column: 10,
        endColumn: 20,
      });
      index.addFile('/test/di.xml', [ref], []);

      // column-1 is the opening quote, endColumn is the closing quote
      expect(index.getReferenceAtPosition('/test/di.xml', 3, 9)).toEqual(ref);
      expect(index.getReferenceAtPosition('/test/di.xml', 3, 20)).toEqual(ref);
    });

    it('returns undefined for position outside reference and quotes', () => {
      const ref = makeRef({
        fqcn: 'Foo\\Bar',
        file: '/test/di.xml',
        line: 3,
        column: 10,
        endColumn: 20,
      });
      index.addFile('/test/di.xml', [ref], []);

      expect(index.getReferenceAtPosition('/test/di.xml', 3, 8)).toBeUndefined();
      expect(index.getReferenceAtPosition('/test/di.xml', 3, 21)).toBeUndefined();
      expect(index.getReferenceAtPosition('/test/di.xml', 2, 15)).toBeUndefined();
    });

    it('returns undefined for unknown file', () => {
      expect(index.getReferenceAtPosition('/unknown.xml', 0, 0)).toBeUndefined();
    });
  });

  describe('config merging priority', () => {
    describe('module load order (last wins)', () => {
      it('picks the preference from the later module', () => {
        const forRef1 = makeRef({
          fqcn: 'My\\Interface',
          kind: 'preference-for',
          file: '/module-a/etc/di.xml',
          line: 1,
          module: 'Module_A',
          moduleOrder: 0,
          pairedFqcn: 'Impl\\A',
        });
        const typeRef1 = makeRef({
          fqcn: 'Impl\\A',
          kind: 'preference-type',
          file: '/module-a/etc/di.xml',
          line: 1,
          module: 'Module_A',
          moduleOrder: 0,
          pairedFqcn: 'My\\Interface',
        });
        const forRef2 = makeRef({
          fqcn: 'My\\Interface',
          kind: 'preference-for',
          file: '/module-b/etc/di.xml',
          line: 1,
          module: 'Module_B',
          moduleOrder: 5,
          pairedFqcn: 'Impl\\B',
        });
        const typeRef2 = makeRef({
          fqcn: 'Impl\\B',
          kind: 'preference-type',
          file: '/module-b/etc/di.xml',
          line: 1,
          module: 'Module_B',
          moduleOrder: 5,
          pairedFqcn: 'My\\Interface',
        });

        index.addFile('/module-a/etc/di.xml', [forRef1, typeRef1], []);
        index.addFile('/module-b/etc/di.xml', [forRef2, typeRef2], []);

        const effective = index.getEffectivePreferenceType('My\\Interface', 'global');
        expect(effective).toBeDefined();
        expect(effective!.fqcn).toBe('Impl\\B');
        expect(effective!.moduleOrder).toBe(5);
      });
    });

    describe('scoped overrides global', () => {
      it('picks scoped preference over global regardless of module order', () => {
        const forRefGlobal = makeRef({
          fqcn: 'My\\Interface',
          kind: 'preference-for',
          file: '/module-b/etc/di.xml',
          line: 1,
          area: 'global',
          module: 'Module_B',
          moduleOrder: 10,
          pairedFqcn: 'Impl\\Global',
        });
        const typeRefGlobal = makeRef({
          fqcn: 'Impl\\Global',
          kind: 'preference-type',
          file: '/module-b/etc/di.xml',
          line: 1,
          area: 'global',
          module: 'Module_B',
          moduleOrder: 10,
          pairedFqcn: 'My\\Interface',
        });
        const forRefScoped = makeRef({
          fqcn: 'My\\Interface',
          kind: 'preference-for',
          file: '/module-a/etc/frontend/di.xml',
          line: 1,
          area: 'frontend',
          module: 'Module_A',
          moduleOrder: 0,
          pairedFqcn: 'Impl\\Frontend',
        });
        const typeRefScoped = makeRef({
          fqcn: 'Impl\\Frontend',
          kind: 'preference-type',
          file: '/module-a/etc/frontend/di.xml',
          line: 1,
          area: 'frontend',
          module: 'Module_A',
          moduleOrder: 0,
          pairedFqcn: 'My\\Interface',
        });

        index.addFile('/module-b/etc/di.xml', [forRefGlobal, typeRefGlobal], []);
        index.addFile(
          '/module-a/etc/frontend/di.xml',
          [forRefScoped, typeRefScoped],
          [],
        );

        // Asking for frontend area should get the scoped one
        const effective = index.getEffectivePreferenceType(
          'My\\Interface',
          'frontend',
        );
        expect(effective).toBeDefined();
        expect(effective!.fqcn).toBe('Impl\\Frontend');

        // Asking for global area should get the global one
        const globalEffective = index.getEffectivePreferenceType(
          'My\\Interface',
          'global',
        );
        expect(globalEffective).toBeDefined();
        expect(globalEffective!.fqcn).toBe('Impl\\Global');
      });

      it('falls back to global when no scoped preference exists', () => {
        const forRef = makeRef({
          fqcn: 'My\\Interface',
          kind: 'preference-for',
          file: '/module/etc/di.xml',
          line: 1,
          area: 'global',
          module: 'Module_A',
          moduleOrder: 0,
          pairedFqcn: 'Impl\\Default',
        });
        const typeRef = makeRef({
          fqcn: 'Impl\\Default',
          kind: 'preference-type',
          file: '/module/etc/di.xml',
          line: 1,
          area: 'global',
          module: 'Module_A',
          moduleOrder: 0,
          pairedFqcn: 'My\\Interface',
        });

        index.addFile('/module/etc/di.xml', [forRef, typeRef], []);

        // Asking for frontend should fall back to global
        const effective = index.getEffectivePreferenceType(
          'My\\Interface',
          'frontend',
        );
        expect(effective).toBeDefined();
        expect(effective!.fqcn).toBe('Impl\\Default');
      });
    });

    describe('virtualType priority', () => {
      it('picks the virtualType from the later module', () => {
        const vt1 = makeVt({
          name: 'MyVType',
          parentType: 'Parent\\A',
          file: '/module-a/etc/di.xml',
          moduleOrder: 0,
        });
        const vt2 = makeVt({
          name: 'MyVType',
          parentType: 'Parent\\B',
          file: '/module-b/etc/di.xml',
          moduleOrder: 5,
        });

        index.addFile('/module-a/etc/di.xml', [], [vt1]);
        index.addFile('/module-b/etc/di.xml', [], [vt2]);

        const effective = index.getEffectiveVirtualType('MyVType');
        expect(effective).toBeDefined();
        expect(effective!.parentType).toBe('Parent\\B');
      });
    });

    describe('find references returns all (no filtering)', () => {
      it('returns all references regardless of priority', () => {
        const ref1 = makeRef({
          fqcn: 'My\\Interface',
          kind: 'preference-for',
          file: '/module-a/etc/di.xml',
          moduleOrder: 0,
        });
        const ref2 = makeRef({
          fqcn: 'My\\Interface',
          kind: 'preference-for',
          file: '/module-b/etc/di.xml',
          moduleOrder: 5,
        });
        const ref3 = makeRef({
          fqcn: 'My\\Interface',
          kind: 'type-name',
          file: '/module-c/etc/frontend/di.xml',
          area: 'frontend',
          moduleOrder: 3,
        });

        index.addFile('/module-a/etc/di.xml', [ref1], []);
        index.addFile('/module-b/etc/di.xml', [ref2], []);
        index.addFile('/module-c/etc/frontend/di.xml', [ref3], []);

        const all = index.getReferencesForFqcn('My\\Interface');
        expect(all).toHaveLength(3);
      });
    });
  });

  describe('getFileCount', () => {
    it('tracks the number of indexed files', () => {
      expect(index.getFileCount()).toBe(0);
      index.addFile('/a.xml', [makeRef({ file: '/a.xml' })], []);
      expect(index.getFileCount()).toBe(1);
      index.addFile('/b.xml', [makeRef({ file: '/b.xml' })], []);
      expect(index.getFileCount()).toBe(2);
      index.removeFile('/a.xml');
      expect(index.getFileCount()).toBe(1);
    });
  });

  describe('batch mode', () => {
    it('defers rebuildEffective until endBatch', () => {
      index.beginBatch();

      const forRef = makeRef({
        fqcn: 'My\\Interface',
        kind: 'preference-for',
        file: '/a.xml',
        line: 0,
        pairedFqcn: 'My\\Impl',
      });
      const typeRef = makeRef({
        fqcn: 'My\\Impl',
        kind: 'preference-type',
        file: '/a.xml',
        line: 0,
        pairedFqcn: 'My\\Interface',
      });
      index.addFile('/a.xml', [forRef, typeRef], []);

      // During batch mode, effective config is not built yet
      expect(index.getEffectivePreferenceType('My\\Interface', 'global')).toBeUndefined();

      index.endBatch();

      // After endBatch, effective config is available
      const effective = index.getEffectivePreferenceType('My\\Interface', 'global');
      expect(effective).toBeDefined();
      expect(effective!.fqcn).toBe('My\\Impl');
    });

    it('produces same results as non-batch mode', () => {
      // Batch mode
      const batchIndex = new DiIndex();
      batchIndex.beginBatch();
      const refs1 = [
        makeRef({ fqcn: 'A\\Interface', kind: 'preference-for', file: '/a.xml', line: 0, pairedFqcn: 'A\\Impl' }),
        makeRef({ fqcn: 'A\\Impl', kind: 'preference-type', file: '/a.xml', line: 0, pairedFqcn: 'A\\Interface' }),
      ];
      const refs2 = [
        makeRef({ fqcn: 'A\\Interface', kind: 'preference-for', file: '/b.xml', line: 0, moduleOrder: 5, pairedFqcn: 'A\\Impl2' }),
        makeRef({ fqcn: 'A\\Impl2', kind: 'preference-type', file: '/b.xml', line: 0, moduleOrder: 5, pairedFqcn: 'A\\Interface' }),
      ];
      batchIndex.addFile('/a.xml', refs1, []);
      batchIndex.addFile('/b.xml', refs2, []);
      batchIndex.endBatch();

      // Non-batch mode
      const normalIndex = new DiIndex();
      normalIndex.addFile('/a.xml', refs1, []);
      normalIndex.addFile('/b.xml', refs2, []);

      // Both should produce the same effective preference
      const batchResult = batchIndex.getEffectivePreferenceType('A\\Interface', 'global');
      const normalResult = normalIndex.getEffectivePreferenceType('A\\Interface', 'global');
      expect(batchResult?.fqcn).toBe(normalResult?.fqcn);
      expect(batchResult?.fqcn).toBe('A\\Impl2');
    });
  });

  describe('replaceFile', () => {
    it('replaces references for a file', () => {
      const oldRef = makeRef({ fqcn: 'Old\\Class', file: '/a.xml' });
      index.addFile('/a.xml', [oldRef], []);
      expect(index.getReferencesForFqcn('Old\\Class')).toHaveLength(1);

      const newRef = makeRef({ fqcn: 'New\\Class', file: '/a.xml' });
      index.replaceFile('/a.xml', [newRef], []);

      expect(index.getReferencesForFqcn('Old\\Class')).toHaveLength(0);
      expect(index.getReferencesForFqcn('New\\Class')).toHaveLength(1);
      expect(index.getFileCount()).toBe(1);
    });

    it('updates effective config after replacing a preference', () => {
      const forRef = makeRef({
        fqcn: 'My\\Interface',
        kind: 'preference-for',
        file: '/a.xml',
        line: 1,
        pairedFqcn: 'Impl\\Old',
      });
      const typeRef = makeRef({
        fqcn: 'Impl\\Old',
        kind: 'preference-type',
        file: '/a.xml',
        line: 1,
        pairedFqcn: 'My\\Interface',
      });
      index.addFile('/a.xml', [forRef, typeRef], []);
      expect(index.getEffectivePreferenceType('My\\Interface', 'global')?.fqcn).toBe('Impl\\Old');

      const forRef2 = makeRef({
        fqcn: 'My\\Interface',
        kind: 'preference-for',
        file: '/a.xml',
        line: 1,
        pairedFqcn: 'Impl\\New',
      });
      const typeRef2 = makeRef({
        fqcn: 'Impl\\New',
        kind: 'preference-type',
        file: '/a.xml',
        line: 1,
        pairedFqcn: 'My\\Interface',
      });
      index.replaceFile('/a.xml', [forRef2, typeRef2], []);
      expect(index.getEffectivePreferenceType('My\\Interface', 'global')?.fqcn).toBe('Impl\\New');
    });

    it('works on a file that was never added (like addFile)', () => {
      const ref = makeRef({ fqcn: 'Fresh\\Class', file: '/new.xml' });
      index.replaceFile('/new.xml', [ref], []);
      expect(index.getReferencesForFqcn('Fresh\\Class')).toHaveLength(1);
      expect(index.getFileCount()).toBe(1);
    });

    it('produces same results as removeFile + addFile', () => {
      const sharedRefs = [
        makeRef({ fqcn: 'Shared\\Class', file: '/a.xml', kind: 'type-name' }),
      ];
      const oldRefs = [
        makeRef({ fqcn: 'Old\\Class', file: '/a.xml' }),
      ];
      const newRefs = [
        makeRef({ fqcn: 'New\\Class', file: '/a.xml' }),
      ];
      const vt = makeVt({ name: 'MyVt', file: '/a.xml' });

      // Method 1: replaceFile
      const idx1 = new DiIndex();
      idx1.addFile('/a.xml', oldRefs, []);
      idx1.addFile('/b.xml', sharedRefs, []);
      idx1.replaceFile('/a.xml', newRefs, [vt]);

      // Method 2: removeFile + addFile
      const idx2 = new DiIndex();
      idx2.addFile('/a.xml', oldRefs, []);
      idx2.addFile('/b.xml', sharedRefs, []);
      idx2.removeFile('/a.xml');
      idx2.addFile('/a.xml', newRefs, [vt]);

      expect(idx1.getReferencesForFqcn('New\\Class')).toEqual(idx2.getReferencesForFqcn('New\\Class'));
      expect(idx1.getReferencesForFqcn('Old\\Class')).toEqual(idx2.getReferencesForFqcn('Old\\Class'));
      expect(idx1.getEffectiveVirtualType('MyVt')).toEqual(idx2.getEffectiveVirtualType('MyVt'));
      expect(idx1.getFileCount()).toBe(idx2.getFileCount());
    });
  });

  describe('clear', () => {
    it('removes all data', () => {
      index.addFile(
        '/test.xml',
        [makeRef({ fqcn: 'Foo' })],
        [makeVt({ name: 'VFoo' })],
      );
      index.clear();
      expect(index.getReferencesForFqcn('Foo')).toHaveLength(0);
      expect(index.getEffectiveVirtualType('VFoo')).toBeUndefined();
      expect(index.getFileCount()).toBe(0);
    });
  });
});
