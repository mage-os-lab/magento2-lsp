import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { locatePhpClass, resolveClassFile } from '../../src/indexer/phpClassLocator';
import { buildPsr4Map } from '../../src/project/composerAutoload';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('resolveClassFile', () => {
  const psr4Map = buildPsr4Map(FIXTURE_ROOT);

  it('resolves a vendor module class via PSR-4', () => {
    const file = resolveClassFile('Test\\Foo\\Model\\Foo', psr4Map);
    expect(file).toBeDefined();
    expect(file).toContain(path.join('vendor', 'test', 'module-foo', 'Model', 'Foo.php'));
  });

  it('resolves an app/code class via PSR-4', () => {
    const file = resolveClassFile('Custom\\Bar\\Model\\Bar', psr4Map);
    expect(file).toBeDefined();
    expect(file).toContain(path.join('app', 'code', 'Custom', 'Bar', 'Model', 'Bar.php'));
  });

  it('resolves an interface', () => {
    const file = resolveClassFile('Test\\Foo\\Api\\FooInterface', psr4Map);
    expect(file).toBeDefined();
    expect(file).toContain(path.join('Api', 'FooInterface.php'));
  });

  it('returns undefined for non-existent class', () => {
    const file = resolveClassFile('NonExistent\\Class\\Name', psr4Map);
    expect(file).toBeUndefined();
  });
});

describe('locatePhpClass', () => {
  const psr4Map = buildPsr4Map(FIXTURE_ROOT);

  it('returns file path and class declaration line', () => {
    const loc = locatePhpClass('Test\\Foo\\Model\\Foo', psr4Map);
    expect(loc).toBeDefined();
    expect(loc!.file).toContain('Foo.php');
    expect(loc!.line).toBe(4); // 0-based line of "class Foo"
    expect(loc!.column).toBe(6); // "class " = 6 chars
  });

  it('returns correct line for interface', () => {
    const loc = locatePhpClass('Test\\Foo\\Api\\FooInterface', psr4Map);
    expect(loc).toBeDefined();
    expect(loc!.line).toBe(4);
    expect(loc!.column).toBe(10); // "interface " = 10 chars
  });

  it('returns undefined for non-existent class', () => {
    expect(locatePhpClass('NonExistent\\Foo', psr4Map)).toBeUndefined();
  });
});
