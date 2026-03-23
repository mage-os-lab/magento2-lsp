import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IndexCache } from '../../src/cache/indexCache';
import { DiReference, VirtualTypeDecl } from '../../src/indexer/types';

function makeRef(fqcn: string): DiReference {
  return {
    fqcn,
    kind: 'type-name',
    file: '/test/di.xml',
    line: 0,
    column: 0,
    endColumn: 10,
    area: 'global',
    module: 'Test_Module',
    moduleOrder: 0,
  };
}

function makeVt(name: string): VirtualTypeDecl {
  return {
    name,
    parentType: 'Parent\\Class',
    file: '/test/di.xml',
    line: 0,
    column: 0,
    area: 'global',
    module: 'Test_Module',
    moduleOrder: 0,
  };
}

describe('IndexCache', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magento-di-lsp-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('save and load round-trip', () => {
    const cache = new IndexCache(tmpDir);
    cache.setDiEntry('/test/di.xml', 12345.678, [makeRef('Foo\\Bar')], [makeVt('VFoo')]);
    cache.save();

    const cache2 = new IndexCache(tmpDir);
    expect(cache2.load()).toBe(true);

    const entry = cache2.getDiEntry('/test/di.xml', 12345.678);
    expect(entry).toBeDefined();
    expect(entry!.references).toHaveLength(1);
    expect(entry!.references[0].fqcn).toBe('Foo\\Bar');
    expect(entry!.virtualTypes).toHaveLength(1);
    expect(entry!.virtualTypes[0].name).toBe('VFoo');
  });

  it('returns undefined for changed mtime', () => {
    const cache = new IndexCache(tmpDir);
    cache.setDiEntry('/test/di.xml', 12345.678, [makeRef('Foo')], []);
    cache.save();

    const cache2 = new IndexCache(tmpDir);
    cache2.load();

    expect(cache2.getDiEntry('/test/di.xml', 99999.0)).toBeUndefined();
  });

  it('discards cache on version mismatch', () => {
    // Write a cache with wrong version
    const cachePath = path.join(tmpDir, '.magento-di-lsp-cache.json');
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ version: 999, files: { '/test.xml': { mtimeMs: 0, references: [], virtualTypes: [] } } }),
    );

    const cache = new IndexCache(tmpDir);
    expect(cache.load()).toBe(false);
    expect(cache.getDiEntry('/test.xml', 0)).toBeUndefined();
  });

  it('returns false when no cache file exists', () => {
    const cache = new IndexCache(tmpDir);
    expect(cache.load()).toBe(false);
  });

  it('prunes deleted files', () => {
    const cache = new IndexCache(tmpDir);
    cache.setDiEntry('/a.xml', 100, [makeRef('A')], []);
    cache.setDiEntry('/b.xml', 200, [makeRef('B')], []);
    cache.setDiEntry('/c.xml', 300, [makeRef('C')], []);

    cache.pruneDiFiles(new Set(['/a.xml', '/c.xml']));

    expect(cache.getDiEntry('/a.xml', 100)).toBeDefined();
    expect(cache.getDiEntry('/b.xml', 200)).toBeUndefined();
    expect(cache.getDiEntry('/c.xml', 300)).toBeDefined();
  });

  it('removeEntry removes a single entry', () => {
    const cache = new IndexCache(tmpDir);
    cache.setDiEntry('/a.xml', 100, [makeRef('A')], []);
    cache.removeEntry('/a.xml');
    expect(cache.getDiEntry('/a.xml', 100)).toBeUndefined();
  });

  it('getCachedFilePaths returns all cached paths', () => {
    const cache = new IndexCache(tmpDir);
    cache.setDiEntry('/a.xml', 100, [], []);
    cache.setDiEntry('/b.xml', 200, [], []);
    expect(cache.getCachedFilePaths().sort()).toEqual(['/a.xml', '/b.xml']);
  });

  it('handles corrupted cache file gracefully', () => {
    const cachePath = path.join(tmpDir, '.magento-di-lsp-cache.json');
    fs.writeFileSync(cachePath, 'not valid json{{{');

    const cache = new IndexCache(tmpDir);
    expect(cache.load()).toBe(false);
  });
});
