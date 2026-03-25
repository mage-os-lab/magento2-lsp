import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  resolveActiveModules,
  discoverDiXmlFiles,
  deriveDiXmlContext,
  deriveEventsXmlContext,
  deriveSystemXmlContext,
} from '../../src/project/moduleResolver';
import type { ModuleInfo } from '../../src/indexer/types';

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

// --- Context derivation tests ---

const TEST_MODULES: ModuleInfo[] = [
  { name: 'Vendor_Module', path: '/project/vendor/vendor/module', order: 0 },
  { name: 'Custom_Bar', path: '/project/app/code/Custom/Bar', order: 1 },
];

describe('deriveDiXmlContext', () => {
  it('returns context for root-level app/etc/di.xml', () => {
    const ctx = deriveDiXmlContext('/project/app/etc/di.xml', '/project', TEST_MODULES);
    expect(ctx).toBeDefined();
    expect(ctx!.area).toBe('global');
    expect(ctx!.module).toBe('__root__');
    expect(ctx!.moduleOrder).toBe(-1);
  });

  it('returns context for module global di.xml', () => {
    const ctx = deriveDiXmlContext(
      '/project/vendor/vendor/module/etc/di.xml', '/project', TEST_MODULES,
    );
    expect(ctx).toBeDefined();
    expect(ctx!.area).toBe('global');
    expect(ctx!.module).toBe('Vendor_Module');
    expect(ctx!.moduleOrder).toBe(0);
  });

  it('returns context for module scoped di.xml', () => {
    const ctx = deriveDiXmlContext(
      '/project/vendor/vendor/module/etc/frontend/di.xml', '/project', TEST_MODULES,
    );
    expect(ctx).toBeDefined();
    expect(ctx!.area).toBe('frontend');
    expect(ctx!.module).toBe('Vendor_Module');
  });

  it('returns undefined for non-di.xml files', () => {
    expect(deriveDiXmlContext('/project/vendor/vendor/module/etc/events.xml', '/project', TEST_MODULES))
      .toBeUndefined();
  });

  it('returns undefined for di.xml outside known modules', () => {
    expect(deriveDiXmlContext('/unknown/path/etc/di.xml', '/project', TEST_MODULES))
      .toBeUndefined();
  });
});

describe('deriveEventsXmlContext', () => {
  it('returns context for module global events.xml', () => {
    const ctx = deriveEventsXmlContext(
      '/project/app/code/Custom/Bar/etc/events.xml', TEST_MODULES,
    );
    expect(ctx).toBeDefined();
    expect(ctx!.area).toBe('global');
    expect(ctx!.module).toBe('Custom_Bar');
  });

  it('returns context for module scoped events.xml', () => {
    const ctx = deriveEventsXmlContext(
      '/project/app/code/Custom/Bar/etc/frontend/events.xml', TEST_MODULES,
    );
    expect(ctx).toBeDefined();
    expect(ctx!.area).toBe('frontend');
  });

  it('returns undefined for non-events.xml files', () => {
    expect(deriveEventsXmlContext('/project/app/code/Custom/Bar/etc/di.xml', TEST_MODULES))
      .toBeUndefined();
  });
});

describe('deriveSystemXmlContext', () => {
  it('returns context for main system.xml', () => {
    const ctx = deriveSystemXmlContext(
      '/project/vendor/vendor/module/etc/adminhtml/system.xml', TEST_MODULES,
    );
    expect(ctx).toBeDefined();
    expect(ctx!.module).toBe('Vendor_Module');
  });

  it('returns context for system.xml include partial', () => {
    const ctx = deriveSystemXmlContext(
      '/project/vendor/vendor/module/etc/adminhtml/system/payments.xml', TEST_MODULES,
    );
    expect(ctx).toBeDefined();
    expect(ctx!.module).toBe('Vendor_Module');
  });

  it('returns undefined for non-system XML files', () => {
    expect(deriveSystemXmlContext('/project/vendor/vendor/module/etc/di.xml', TEST_MODULES))
      .toBeUndefined();
  });

  it('returns undefined for system.xml outside known modules', () => {
    expect(deriveSystemXmlContext('/unknown/etc/adminhtml/system.xml', TEST_MODULES))
      .toBeUndefined();
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
