import { describe, it, expect } from 'vitest';
import { resolveVariableTypes } from '../../src/utils/phpTypeResolver';
import { extractPhpClass } from '../../src/utils/phpNamespace';

function resolve(content: string): Map<string, string> {
  const classInfo = extractPhpClass(content);
  if (!classInfo) throw new Error('No class found in content');
  return resolveVariableTypes(content, classInfo);
}

describe('resolveVariableTypes', () => {
  it('resolves $this to current class FQCN', () => {
    const content = `<?php
namespace App\\Model;

class Foo
{
}
`;
    const types = resolve(content);
    expect(types.get('$this')).toBe('App\\Model\\Foo');
  });

  it('resolves constructor promoted properties', () => {
    const content = `<?php
namespace App\\Model;

use Magento\\Framework\\DataObject;

class Foo
{
    public function __construct(
        private DataObject $storage,
        private readonly \\Magento\\Store\\Api\\StoreInterface $store,
    ) {
    }
}
`;
    const types = resolve(content);
    expect(types.get('$this->storage')).toBe('Magento\\Framework\\DataObject');
    expect(types.get('$this->store')).toBe('Magento\\Store\\Api\\StoreInterface');
  });

  it('resolves constructor non-promoted parameters', () => {
    const content = `<?php
namespace App\\Model;

use Magento\\Framework\\DataObject;

class Foo
{
    public function __construct(
        DataObject $data
    ) {
    }
}
`;
    const types = resolve(content);
    expect(types.get('$data')).toBe('Magento\\Framework\\DataObject');
  });

  it('resolves method parameter types', () => {
    const content = `<?php
namespace App\\Model;

use Magento\\Catalog\\Api\\Data\\ProductInterface;

class Foo
{
    public function execute(ProductInterface $product): void
    {
    }
}
`;
    const types = resolve(content);
    expect(types.get('$product')).toBe('Magento\\Catalog\\Api\\Data\\ProductInterface');
  });

  it('resolves @var annotations', () => {
    const content = `<?php
namespace App\\Model;

use Magento\\Catalog\\Model\\Product;

class Foo
{
    public function execute(): void
    {
        /** @var Product $item */
        $item = $this->getProduct();
    }
}
`;
    const types = resolve(content);
    expect(types.get('$item')).toBe('Magento\\Catalog\\Model\\Product');
  });

  it('resolves typed property declarations', () => {
    const content = `<?php
namespace App\\Model;

use Magento\\Framework\\DataObject;

class Foo
{
    private DataObject $storage;
}
`;
    const types = resolve(content);
    expect(types.get('$this->storage')).toBe('Magento\\Framework\\DataObject');
  });

  it('skips builtin types', () => {
    const content = `<?php
namespace App\\Model;

class Foo
{
    public function execute(string $name, int $id): void
    {
    }
}
`;
    const types = resolve(content);
    expect(types.has('$name')).toBe(false);
    expect(types.has('$id')).toBe(false);
  });

  it('resolves unqualified names relative to current namespace', () => {
    const content = `<?php
namespace App\\Model;

class Foo
{
    public function execute(Bar $bar): void
    {
    }
}
`;
    const types = resolve(content);
    expect(types.get('$bar')).toBe('App\\Model\\Bar');
  });

  it('resolves types from method-call assignments with callback', () => {
    const content = `<?php
namespace App\\Model;

use App\\Api\\FactoryInterface;

class Foo
{
    public function __construct(
        private FactoryInterface $factory,
    ) {
    }

    public function execute(): void
    {
        $product = $this->factory->create();
    }
}
`;
    const classInfo = extractPhpClass(content)!;
    const callback = (fqcn: string, method: string): string | undefined => {
      if (fqcn === 'App\\Api\\FactoryInterface' && method === 'create') {
        return 'App\\Model\\Product';
      }
      return undefined;
    };
    const types = resolveVariableTypes(content, classInfo, callback);
    expect(types.get('$product')).toBe('App\\Model\\Product');
  });

  it('does not resolve method-call assignments without callback', () => {
    const content = `<?php
namespace App\\Model;

use App\\Api\\FactoryInterface;

class Foo
{
    public function __construct(
        private FactoryInterface $factory,
    ) {
    }

    public function execute(): void
    {
        $product = $this->factory->create();
    }
}
`;
    const types = resolve(content);
    expect(types.has('$product')).toBe(false);
  });

  it('does not overwrite @var annotation with method-call return type', () => {
    const content = `<?php
namespace App\\Model;

use App\\Api\\FactoryInterface;
use App\\Api\\SpecificProduct;

class Foo
{
    public function __construct(
        private FactoryInterface $factory,
    ) {
    }

    public function execute(): void
    {
        /** @var SpecificProduct $product */
        $product = $this->factory->create();
    }
}
`;
    const classInfo = extractPhpClass(content)!;
    const callback = (_fqcn: string, _method: string) => 'App\\Model\\GenericProduct';
    const types = resolveVariableTypes(content, classInfo, callback);
    expect(types.get('$product')).toBe('App\\Api\\SpecificProduct');
  });
});
