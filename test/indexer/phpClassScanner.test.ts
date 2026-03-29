import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { scanPhpClasses, scanPhpClassesAsync, deriveClassEntry } from '../../src/indexer/phpClassScanner';
import { buildPsr4Map } from '../../src/project/composerAutoload';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('phpClassScanner', () => {
  const psr4Map = buildPsr4Map(FIXTURE_ROOT);

  describe('scanPhpClasses', () => {
    it('discovers PHP classes from the PSR-4 map', () => {
      const entries = scanPhpClasses(psr4Map);
      expect(entries.length).toBeGreaterThan(0);
    });

    it('includes vendor module classes', () => {
      const entries = scanPhpClasses(psr4Map);
      const fqcns = entries.map(e => e.value);
      expect(fqcns).toContain('Test\\Foo\\Model\\Foo');
    });

    it('includes app/code module classes', () => {
      const entries = scanPhpClasses(psr4Map);
      const fqcns = entries.map(e => e.value);
      expect(fqcns).toContain('Custom\\Bar\\Model\\Bar');
    });

    it('has pre-computed segments for each entry', () => {
      const entries = scanPhpClasses(psr4Map);
      for (const entry of entries) {
        expect(entry.segments.length).toBeGreaterThan(0);
        // Each segment group should have at least one lowercase part
        for (const group of entry.segments) {
          expect(group.length).toBeGreaterThan(0);
          for (const part of group) {
            expect(part).toBe(part.toLowerCase());
          }
        }
      }
    });

    it('does not include duplicate FQCNs', () => {
      const entries = scanPhpClasses(psr4Map);
      const fqcns = entries.map(e => e.value);
      const uniqueFqcns = new Set(fqcns);
      expect(uniqueFqcns.size).toBe(fqcns.length);
    });
  });

  describe('scanPhpClassesAsync', () => {
    it('returns the same results as the sync version', async () => {
      const syncEntries = scanPhpClasses(psr4Map);
      const asyncEntries = await scanPhpClassesAsync(psr4Map);

      const syncFqcns = syncEntries.map(e => e.value).sort();
      const asyncFqcns = asyncEntries.map(e => e.value).sort();
      expect(asyncFqcns).toEqual(syncFqcns);
    });
  });

  describe('deriveClassEntry', () => {
    it('derives a ClassEntry from a PHP file path', () => {
      const filePath = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/Foo.php');
      const entry = deriveClassEntry(filePath, psr4Map);

      expect(entry).toBeDefined();
      expect(entry!.value).toBe('Test\\Foo\\Model\\Foo');
      expect(entry!.segments.length).toBeGreaterThan(0);
    });

    it('returns undefined for files outside PSR-4 paths', () => {
      const entry = deriveClassEntry('/some/random/path.php', psr4Map);
      expect(entry).toBeUndefined();
    });

    it('returns undefined for excluded paths', () => {
      const entry = deriveClassEntry('/some/generated/code/Foo.php', psr4Map);
      expect(entry).toBeUndefined();
    });

    it('returns undefined for non-PHP files', () => {
      const entry = deriveClassEntry('/some/path/file.xml', psr4Map);
      expect(entry).toBeUndefined();
    });
  });
});
