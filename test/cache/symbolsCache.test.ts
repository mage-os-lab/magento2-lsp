import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SymbolsCache, computePsr4Hash, computeTemplateSourceHash } from '../../src/cache/symbolsCache';

describe('SymbolsCache', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symbols-cache-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('save and load round-trip', () => {
    it('saves and loads class data', () => {
      const hash = 'abc123';
      const fqcns = ['Magento\\Catalog\\Model\\Product', 'Magento\\Store\\Model\\Store'];

      const cache1 = new SymbolsCache(tmpDir);
      cache1.setClasses(hash, fqcns);
      cache1.save();

      const cache2 = new SymbolsCache(tmpDir);
      expect(cache2.load()).toBe(true);
      expect(cache2.getClasses(hash)).toEqual(fqcns);
    });

    it('saves and loads template data', () => {
      const hash = 'def456';
      const templates = [
        { value: 'Magento_Catalog::product/view.phtml', area: 'frontend', filePath: '/path/view.phtml' },
      ];

      const cache1 = new SymbolsCache(tmpDir);
      cache1.setTemplates(hash, templates);
      cache1.save();

      const cache2 = new SymbolsCache(tmpDir);
      expect(cache2.load()).toBe(true);
      expect(cache2.getTemplates(hash)).toEqual(templates);
    });
  });

  describe('hash mismatch', () => {
    it('returns undefined for classes when hash does not match', () => {
      const cache1 = new SymbolsCache(tmpDir);
      cache1.setClasses('hash1', ['A\\B']);
      cache1.save();

      const cache2 = new SymbolsCache(tmpDir);
      cache2.load();
      expect(cache2.getClasses('different-hash')).toBeUndefined();
    });

    it('returns undefined for templates when hash does not match', () => {
      const cache1 = new SymbolsCache(tmpDir);
      cache1.setTemplates('hash1', [{ value: 'M_C::a.phtml', area: 'frontend', filePath: '/a.phtml' }]);
      cache1.save();

      const cache2 = new SymbolsCache(tmpDir);
      cache2.load();
      expect(cache2.getTemplates('different-hash')).toBeUndefined();
    });
  });

  describe('version mismatch', () => {
    it('rejects cache with wrong version', () => {
      // Write a cache file with a bogus version
      const cachePath = path.join(tmpDir, '.magento2-lsp-symbols-cache.json');
      fs.writeFileSync(cachePath, JSON.stringify({
        version: 999,
        classes: { hash: 'abc', fqcns: ['A\\B'] },
      }));

      const cache = new SymbolsCache(tmpDir);
      expect(cache.load()).toBe(false);
      expect(cache.getClasses('abc')).toBeUndefined();
    });
  });

  describe('missing or corrupt cache', () => {
    it('returns false for load when file does not exist', () => {
      const cache = new SymbolsCache(tmpDir);
      expect(cache.load()).toBe(false);
    });

    it('returns false for load when file is corrupt', () => {
      const cachePath = path.join(tmpDir, '.magento2-lsp-symbols-cache.json');
      fs.writeFileSync(cachePath, 'not valid json');

      const cache = new SymbolsCache(tmpDir);
      expect(cache.load()).toBe(false);
    });
  });

  describe('hash computation', () => {
    it('computePsr4Hash produces consistent hashes', () => {
      const map = [
        { prefix: 'Magento\\Catalog\\', path: '/vendor/magento/module-catalog/' },
      ];
      const hash1 = computePsr4Hash(map);
      const hash2 = computePsr4Hash(map);
      expect(hash1).toBe(hash2);
    });

    it('computePsr4Hash differs when map changes', () => {
      const map1 = [{ prefix: 'A\\', path: '/a/' }];
      const map2 = [{ prefix: 'B\\', path: '/b/' }];
      expect(computePsr4Hash(map1)).not.toBe(computePsr4Hash(map2));
    });

    it('computeTemplateSourceHash produces consistent hashes', () => {
      const hash1 = computeTemplateSourceHash(['/mod1', '/mod2'], ['/theme1']);
      const hash2 = computeTemplateSourceHash(['/mod1', '/mod2'], ['/theme1']);
      expect(hash1).toBe(hash2);
    });

    it('computeTemplateSourceHash differs when sources change', () => {
      const hash1 = computeTemplateSourceHash(['/mod1'], ['/theme1']);
      const hash2 = computeTemplateSourceHash(['/mod1', '/mod2'], ['/theme1']);
      expect(hash1).not.toBe(hash2);
    });
  });
});
