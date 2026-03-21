import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  resolveActiveModules,
  discoverDiXmlFiles,
} from '../../src/project/moduleResolver';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('resolveActiveModules', () => {
  it('parses config.php and returns active modules', () => {
    const modules = resolveActiveModules(FIXTURE_ROOT);
    const names = modules.map((m) => m.name);
    expect(names).toContain('Test_Foo');
    expect(names).toContain('Custom_Bar');
  });

  it('assigns module order based on position in config.php', () => {
    const modules = resolveActiveModules(FIXTURE_ROOT);
    const testFoo = modules.find((m) => m.name === 'Test_Foo');
    const customBar = modules.find((m) => m.name === 'Custom_Bar');
    expect(testFoo).toBeDefined();
    expect(customBar).toBeDefined();
    // Test_Foo comes before Custom_Bar in config.php
    expect(testFoo!.order).toBeLessThan(customBar!.order);
  });

  it('resolves vendor module path via installed.json', () => {
    const modules = resolveActiveModules(FIXTURE_ROOT);
    const testFoo = modules.find((m) => m.name === 'Test_Foo');
    expect(testFoo).toBeDefined();
    expect(testFoo!.path).toContain(path.join('vendor', 'test', 'module-foo'));
  });

  it('resolves app/code module path by convention', () => {
    const modules = resolveActiveModules(FIXTURE_ROOT);
    const customBar = modules.find((m) => m.name === 'Custom_Bar');
    expect(customBar).toBeDefined();
    expect(customBar!.path).toContain(path.join('app', 'code', 'Custom', 'Bar'));
  });
});

describe('discoverDiXmlFiles', () => {
  it('discovers global and area-specific di.xml files', () => {
    const modules = resolveActiveModules(FIXTURE_ROOT);
    const testFoo = modules.find((m) => m.name === 'Test_Foo')!;
    const files = discoverDiXmlFiles(testFoo.path);

    const areas = files.map((f) => f.area);
    expect(areas).toContain('global');
    expect(areas).toContain('frontend');
  });

  it('returns global di.xml for app/code module', () => {
    const modules = resolveActiveModules(FIXTURE_ROOT);
    const customBar = modules.find((m) => m.name === 'Custom_Bar')!;
    const files = discoverDiXmlFiles(customBar.path);

    expect(files).toHaveLength(1);
    expect(files[0].area).toBe('global');
  });
});
