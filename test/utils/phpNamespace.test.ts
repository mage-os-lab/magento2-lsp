import { describe, it, expect } from 'vitest';
import { extractPhpClass, extractPhpMethods, getInterceptedMethodName, extractMagicMethodInfo, extractClassWithMagicInfo } from '../../src/utils/phpNamespace';

describe('extractPhpClass', () => {
  it('extracts a simple class with namespace', () => {
    const content = `<?php

namespace Magento\\Store\\Model;

class StoreManager
{
}
`;
    const result = extractPhpClass(content);
    expect(result).toMatchObject({
      namespace: 'Magento\\Store\\Model',
      name: 'StoreManager',
      fqcn: 'Magento\\Store\\Model\\StoreManager',
      kind: 'class',
      parentClass: undefined,
      interfaces: [],
      line: 4,
      column: 6,
      endColumn: 18,
    });
  });

  it('extracts an interface', () => {
    const content = `<?php

namespace Magento\\Store\\Api;

interface StoreManagerInterface
{
}
`;
    const result = extractPhpClass(content);
    expect(result).toMatchObject({
      namespace: 'Magento\\Store\\Api',
      name: 'StoreManagerInterface',
      fqcn: 'Magento\\Store\\Api\\StoreManagerInterface',
      kind: 'interface',
      parentClass: undefined,
      interfaces: [],
      line: 4,
      column: 10,
      endColumn: 31,
    });
  });

  it('extracts an abstract class', () => {
    const content = `<?php

namespace Magento\\Framework;

abstract class AbstractModel
{
}
`;
    const result = extractPhpClass(content);
    expect(result).toMatchObject({
      namespace: 'Magento\\Framework',
      name: 'AbstractModel',
      fqcn: 'Magento\\Framework\\AbstractModel',
      kind: 'class',
      parentClass: undefined,
      interfaces: [],
      line: 4,
      column: 15,
      endColumn: 28,
    });
  });

  it('extracts a trait', () => {
    const content = `<?php

namespace App\\Traits;

trait Loggable
{
}
`;
    const result = extractPhpClass(content);
    expect(result).toMatchObject({
      namespace: 'App\\Traits',
      name: 'Loggable',
      fqcn: 'App\\Traits\\Loggable',
      kind: 'trait',
      parentClass: undefined,
      interfaces: [],
      line: 4,
      column: 6,
      endColumn: 14,
    });
  });

  it('extracts an enum', () => {
    const content = `<?php

namespace App\\Enums;

enum Status
{
}
`;
    const result = extractPhpClass(content);
    expect(result).toMatchObject({
      namespace: 'App\\Enums',
      name: 'Status',
      fqcn: 'App\\Enums\\Status',
      kind: 'enum',
      parentClass: undefined,
      interfaces: [],
      line: 4,
      column: 5,
      endColumn: 11,
    });
  });

  it('extracts class without namespace', () => {
    const content = `<?php

class GlobalClass
{
}
`;
    const result = extractPhpClass(content);
    expect(result).toMatchObject({
      namespace: '',
      name: 'GlobalClass',
      fqcn: 'GlobalClass',
      kind: 'class',
      parentClass: undefined,
      interfaces: [],
      line: 2,
      column: 6,
      endColumn: 17,
    });
  });

  it('handles namespace with braces', () => {
    const content = `<?php

namespace Magento\\Store\\Model {

class StoreManager
{
}

}
`;
    const result = extractPhpClass(content);
    expect(result).toMatchObject({
      namespace: 'Magento\\Store\\Model',
      name: 'StoreManager',
      fqcn: 'Magento\\Store\\Model\\StoreManager',
      kind: 'class',
      parentClass: undefined,
      interfaces: [],
      line: 4,
      column: 6,
      endColumn: 18,
    });
  });

  it('extracts a final class', () => {
    const content = `<?php

namespace App\\Services;

final class PaymentService
{
}
`;
    const result = extractPhpClass(content);
    expect(result).toMatchObject({
      namespace: 'App\\Services',
      name: 'PaymentService',
      fqcn: 'App\\Services\\PaymentService',
      kind: 'class',
      parentClass: undefined,
      interfaces: [],
      line: 4,
      column: 12,
      endColumn: 26,
    });
  });

  it('returns undefined for file with no class', () => {
    const content = `<?php

namespace Magento\\Store;

// Just functions
function helper() {}
`;
    expect(extractPhpClass(content)).toBeUndefined();
  });

  it('returns undefined for empty content', () => {
    expect(extractPhpClass('')).toBeUndefined();
  });

  it('ignores classes in comments', () => {
    // This is a limitation acknowledged by design — we do simple line matching.
    // A line starting with whitespace+class keyword will be detected.
    // But a comment like "// class Foo" would not match because of the leading //.
    const content = `<?php

namespace App;

// class FakeClass

class RealClass
{
}
`;
    const result = extractPhpClass(content);
    expect(result?.name).toBe('RealClass');
  });
});

describe('extractPhpMethods', () => {
  it('extracts public methods', () => {
    const content = `<?php

namespace App\\Model;

class Foo
{
    public function save(): void {}
    public function getName(): string {}
}
`;
    const methods = extractPhpMethods(content);
    expect(methods).toHaveLength(2);
    expect(methods[0].name).toBe('save');
    expect(methods[1].name).toBe('getName');
  });

  it('extracts public static methods', () => {
    const content = `<?php
class Foo
{
    public static function create(): self {}
}
`;
    const methods = extractPhpMethods(content);
    expect(methods).toHaveLength(1);
    expect(methods[0].name).toBe('create');
  });

  it('ignores protected and private methods', () => {
    const content = `<?php
class Foo
{
    public function visible(): void {}
    protected function hidden(): void {}
    private function secret(): void {}
}
`;
    const methods = extractPhpMethods(content);
    expect(methods).toHaveLength(1);
    expect(methods[0].name).toBe('visible');
  });

  it('returns correct line and column positions', () => {
    const content = `<?php

class Foo
{
    public function doSomething(): void {}
}
`;
    const methods = extractPhpMethods(content);
    expect(methods).toHaveLength(1);
    expect(methods[0].line).toBe(4);
    expect(methods[0].column).toBe(20);
    expect(methods[0].endColumn).toBe(31);
  });

  it('returns empty array for file with no methods', () => {
    const content = `<?php
class EmptyClass {}
`;
    expect(extractPhpMethods(content)).toHaveLength(0);
  });

  it('extracts return type from method signature', () => {
    const content = `<?php
namespace App\\Model;

use App\\Api\\ProductInterface;

class Factory
{
    public function create(): ProductInterface {}
}
`;
    const methods = extractPhpMethods(content);
    expect(methods).toHaveLength(1);
    expect(methods[0].returnType).toBe('ProductInterface');
  });

  it('returns undefined returnType when no return type declared', () => {
    const content = `<?php
class Foo
{
    public function doSomething() {}
}
`;
    const methods = extractPhpMethods(content);
    expect(methods[0].returnType).toBeUndefined();
  });

  it('strips nullable ? from return type', () => {
    const content = `<?php
class Foo
{
    public function find(): ?Product {}
}
`;
    const methods = extractPhpMethods(content);
    expect(methods[0].returnType).toBe('Product');
  });

  it('extracts self return type', () => {
    const content = `<?php
class Foo
{
    public function withName(): self {}
}
`;
    const methods = extractPhpMethods(content);
    expect(methods[0].returnType).toBe('self');
  });

  it('extracts fully qualified return type', () => {
    const content = `<?php
class Foo
{
    public function get(): \\Magento\\Catalog\\Model\\Product {}
}
`;
    const methods = extractPhpMethods(content);
    expect(methods[0].returnType).toBe('\\Magento\\Catalog\\Model\\Product');
  });

  it('extracts builtin return types as-is', () => {
    const content = `<?php
class Foo
{
    public function save(): void {}
    public function getName(): string {}
}
`;
    const methods = extractPhpMethods(content);
    expect(methods[0].returnType).toBe('void');
    expect(methods[1].returnType).toBe('string');
  });

  it('extracts return type from multi-line method signature', () => {
    const content = `<?php
class Foo
{
    public function create(
        string $name,
        int $id
    ): Product {
        return new Product();
    }
}
`;
    const methods = extractPhpMethods(content);
    expect(methods[0].returnType).toBe('Product');
  });
});

describe('getInterceptedMethodName', () => {
  it('maps beforeSave to save', () => {
    const result = getInterceptedMethodName('beforeSave');
    expect(result).toMatchObject({ prefix: 'before', methodName: 'save' });
  });

  it('maps afterGetName to getName', () => {
    const result = getInterceptedMethodName('afterGetName');
    expect(result).toMatchObject({ prefix: 'after', methodName: 'getName' });
  });

  it('maps aroundLoad to load', () => {
    const result = getInterceptedMethodName('aroundLoad');
    expect(result).toMatchObject({ prefix: 'around', methodName: 'load' });
  });

  it('lowercases only the first letter after the prefix', () => {
    const result = getInterceptedMethodName('beforeGetHTMLContent');
    expect(result).toMatchObject({ prefix: 'before', methodName: 'getHTMLContent' });
  });

  it('returns undefined for non-plugin method names', () => {
    expect(getInterceptedMethodName('save')).toBeUndefined();
    expect(getInterceptedMethodName('execute')).toBeUndefined();
    expect(getInterceptedMethodName('__construct')).toBeUndefined();
  });

  it('returns undefined for prefix-only names', () => {
    expect(getInterceptedMethodName('before')).toBeUndefined();
    expect(getInterceptedMethodName('after')).toBeUndefined();
    expect(getInterceptedMethodName('around')).toBeUndefined();
  });
});

describe('extractPhpClass useImports', () => {
  it('exposes use imports as a map', () => {
    const content = `<?php

namespace App\\Model;

use Magento\\Framework\\DataObject;
use Magento\\Store\\Api\\StoreInterface as Store;

class Foo extends DataObject implements Store
{
}
`;
    const result = extractPhpClass(content);
    expect(result?.useImports).toBeInstanceOf(Map);
    expect(result?.useImports.get('DataObject')).toBe('Magento\\Framework\\DataObject');
    expect(result?.useImports.get('Store')).toBe('Magento\\Store\\Api\\StoreInterface');
  });
});

describe('extractMagicMethodInfo', () => {
  it('detects __call method', () => {
    const content = `<?php
namespace App\\Model;

class Foo
{
    public function __call($method, $args) {}
    public function save(): void {}
}
`;
    const info = extractMagicMethodInfo(content);
    expect(info.hasCall).toBe(true);
    expect(info.declaredMethods).toContain('__call');
    expect(info.declaredMethods).toContain('save');
  });

  it('parses @method annotations', () => {
    const content = `<?php
namespace App\\Model;

/**
 * @method string getName()
 * @method $this setName(string $name)
 * @method static Foo create()
 */
class Foo
{
    public function save(): void {}
}
`;
    const info = extractMagicMethodInfo(content);
    expect(info.hasCall).toBe(false);
    expect(info.docMethods).toEqual(['getName', 'setName', 'create']);
    expect(info.declaredMethods).toEqual(['save']);
  });

  it('returns empty for class without magic methods', () => {
    const content = `<?php
namespace App\\Model;

class Foo
{
    public function save(): void {}
}
`;
    const info = extractMagicMethodInfo(content);
    expect(info.hasCall).toBe(false);
    expect(info.docMethods).toEqual([]);
    expect(info.declaredMethods).toEqual(['save']);
  });

  it('detects both __call and @method', () => {
    const content = `<?php
namespace App\\Model;

/**
 * @method string getCustomerId()
 */
class SessionManager
{
    public function __call($method, $args) {}
    public function start(): void {}
}
`;
    const info = extractMagicMethodInfo(content);
    expect(info.hasCall).toBe(true);
    expect(info.docMethods).toEqual(['getCustomerId']);
    expect(info.declaredMethods).toContain('__call');
    expect(info.declaredMethods).toContain('start');
  });
});

describe('extractClassWithMagicInfo', () => {
  it('extracts class info and magic info in a single pass', () => {
    const content = `<?php
namespace App\\Model;

use Magento\\Framework\\DataObject;

/**
 * @method string getName()
 * @method $this setName(string $name)
 */
class Foo extends DataObject
{
    public function __call($method, $args) {}
    public function save(): void {}
}
`;
    const { classInfo, magicInfo } = extractClassWithMagicInfo(content);

    // Class info
    expect(classInfo).toBeDefined();
    expect(classInfo!.fqcn).toBe('App\\Model\\Foo');
    expect(classInfo!.parentClass).toBe('Magento\\Framework\\DataObject');
    expect(classInfo!.useImports.get('DataObject')).toBe('Magento\\Framework\\DataObject');

    // Magic info
    expect(magicInfo.hasCall).toBe(true);
    expect(magicInfo.docMethods).toEqual(['getName', 'setName']);
    expect(magicInfo.declaredMethods).toContain('__call');
    expect(magicInfo.declaredMethods).toContain('save');
  });

  it('produces same results as separate functions', () => {
    const content = `<?php
namespace App\\Model;

/**
 * @method string getCustomerId()
 */
class SessionManager
{
    public function __call($method, $args) {}
    public function start(): void {}
}
`;
    const combined = extractClassWithMagicInfo(content);
    const separate = extractMagicMethodInfo(content);
    const classInfo = extractPhpClass(content);

    expect(combined.magicInfo.hasCall).toBe(separate.hasCall);
    expect(combined.magicInfo.docMethods).toEqual(separate.docMethods);
    expect(combined.magicInfo.declaredMethods).toEqual(separate.declaredMethods);
    expect(combined.classInfo?.fqcn).toBe(classInfo?.fqcn);
    expect(combined.classInfo?.parentClass).toBe(classInfo?.parentClass);
  });
});
