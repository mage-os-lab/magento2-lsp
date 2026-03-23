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
});
