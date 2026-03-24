import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { MagicMethodIndex } from '../../src/index/magicMethodIndex';
import { buildPsr4Map } from '../../src/project/composerAutoload';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('MagicMethodIndex', () => {
  let index: MagicMethodIndex;
  let psr4Map: any;

  beforeAll(() => {
    index = new MagicMethodIndex();
    psr4Map = buildPsr4Map(FIXTURE_ROOT);
  });

  it('returns declared for a physically declared method', () => {
    const result = index.resolveMethod(
      'Test\\Foo\\Model\\DataObject',
      'getData',
      psr4Map,
    );
    expect(result).toEqual({
      kind: 'declared',
      className: 'Test\\Foo\\Model\\DataObject',
      methodName: 'getData',
    });
  });

  it('returns magic for __call when method is not declared', () => {
    const result = index.resolveMethod(
      'Test\\Foo\\Model\\DataObject',
      'getCustomerId',
      psr4Map,
    );
    expect(result).toEqual({
      kind: 'magic',
      className: 'Test\\Foo\\Model\\DataObject',
      methodName: '__call',
    });
  });

  it('returns magic when ancestor has __call', () => {
    // Storage extends DataObject which has __call
    const result = index.resolveMethod(
      'Test\\Foo\\Model\\Storage',
      'getCustomerId',
      psr4Map,
    );
    expect(result).toBeDefined();
    expect(result!.kind).toBe('magic');
    expect(result!.className).toBe('Test\\Foo\\Model\\DataObject');
  });

  it('returns declared when method is on ancestor', () => {
    // Storage extends DataObject which declares getData
    const result = index.resolveMethod(
      'Test\\Foo\\Model\\Storage',
      'getData',
      psr4Map,
    );
    expect(result).toEqual({
      kind: 'declared',
      className: 'Test\\Foo\\Model\\DataObject',
      methodName: 'getData',
    });
  });

  it('returns magic for @method annotated methods', () => {
    // SessionManager has @method string getCustomerId()
    const result = index.resolveMethod(
      'Test\\Foo\\Model\\SessionManager',
      'getCustomerId',
      psr4Map,
    );
    // __call is checked before @method since SessionManager also has __call
    expect(result).toBeDefined();
    expect(result!.kind).toBe('magic');
  });

  it('returns undefined for unresolvable methods', () => {
    // StorageInterface has no __call and no magic methods
    const result = index.resolveMethod(
      'Test\\Foo\\Api\\StorageInterface',
      'getData',
      psr4Map,
    );
    expect(result).toBeUndefined();
  });

  it('returns declared for init() on StorageInterface', () => {
    const result = index.resolveMethod(
      'Test\\Foo\\Api\\StorageInterface',
      'init',
      psr4Map,
    );
    expect(result).toEqual({
      kind: 'declared',
      className: 'Test\\Foo\\Api\\StorageInterface',
      methodName: 'init',
    });
  });

  it('caches resolution results for repeated lookups', () => {
    // Call twice with same args — second should use cache
    const result1 = index.resolveMethod('Test\\Foo\\Model\\DataObject', 'getData', psr4Map);
    const result2 = index.resolveMethod('Test\\Foo\\Model\\DataObject', 'getData', psr4Map);
    expect(result1).toEqual(result2);
  });

  it('returns undefined for non-existent classes', () => {
    const result = index.resolveMethod(
      'Test\\Foo\\Model\\NonExistent',
      'getData',
      psr4Map,
    );
    expect(result).toBeUndefined();
  });

  // --- resolveMethodReturnType tests ---

  it('resolves return type of FooFactory::create() to Test\\Foo\\Model\\Foo', () => {
    const result = index.resolveMethodReturnType(
      'Test\\Foo\\Model\\FooFactory',
      'create',
      psr4Map,
    );
    expect(result).toBe('Test\\Foo\\Model\\Foo');
  });

  it('resolves self return type to the declaring class FQCN', () => {
    // Foo::load() returns self
    const result = index.resolveMethodReturnType(
      'Test\\Foo\\Model\\Foo',
      'load',
      psr4Map,
    );
    expect(result).toBe('Test\\Foo\\Model\\Foo');
  });

  it('returns undefined for builtin return types', () => {
    // Foo::getName() returns string
    const result = index.resolveMethodReturnType(
      'Test\\Foo\\Model\\Foo',
      'getName',
      psr4Map,
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined for void return type', () => {
    // Foo::save() returns void
    const result = index.resolveMethodReturnType(
      'Test\\Foo\\Model\\Foo',
      'save',
      psr4Map,
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined for methods without return type', () => {
    // DataObject::getData() has no return type declaration
    const result = index.resolveMethodReturnType(
      'Test\\Foo\\Model\\DataObject',
      'getData',
      psr4Map,
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined for magic methods (__call)', () => {
    // Calling a method handled by __call — can't determine return type
    const result = index.resolveMethodReturnType(
      'Test\\Foo\\Model\\DataObject',
      'getCustomerId',
      psr4Map,
    );
    expect(result).toBeUndefined();
  });

  it('resolves auto-generated factory create() via naming convention', () => {
    // NonExistentFactory doesn't have a source file, but by Magento convention
    // {ClassName}Factory::create() returns {ClassName}
    const result = index.resolveMethodReturnType(
      'Test\\Foo\\Model\\NonExistentFactory',
      'create',
      psr4Map,
    );
    expect(result).toBe('Test\\Foo\\Model\\NonExistent');
  });

  it('does not apply factory convention for non-create methods', () => {
    const result = index.resolveMethodReturnType(
      'Test\\Foo\\Model\\NonExistentFactory',
      'get',
      psr4Map,
    );
    expect(result).toBeUndefined();
  });
});
