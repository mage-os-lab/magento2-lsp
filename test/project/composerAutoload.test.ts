import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { buildPsr4Map } from '../../src/project/composerAutoload';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('buildPsr4Map', () => {
  it('builds PSR-4 map from installed.json', () => {
    const map = buildPsr4Map(FIXTURE_ROOT);
    const testFooEntry = map.find((e) => e.prefix === 'Test\\Foo\\');
    expect(testFooEntry).toBeDefined();
    expect(testFooEntry!.path).toContain(
      path.join('vendor', 'test', 'module-foo'),
    );
  });

  it('includes app/code modules by convention', () => {
    const map = buildPsr4Map(FIXTURE_ROOT);
    const customBarEntry = map.find((e) => e.prefix === 'Custom\\Bar\\');
    expect(customBarEntry).toBeDefined();
    expect(customBarEntry!.path).toContain(
      path.join('app', 'code', 'Custom', 'Bar'),
    );
  });

  it('sorts by prefix length descending (longest first)', () => {
    const map = buildPsr4Map(FIXTURE_ROOT);
    for (let i = 1; i < map.length; i++) {
      expect(map[i - 1].prefix.length).toBeGreaterThanOrEqual(
        map[i].prefix.length,
      );
    }
  });
});
