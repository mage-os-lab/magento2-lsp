import { describe, it, expect } from 'vitest';
import { extractPhpClass } from '../../src/utils/phpNamespace';

describe('extractPhpClass', () => {
  it('extracts a simple class with namespace', () => {
    const content = `<?php

namespace Magento\\Store\\Model;

class StoreManager
{
}
`;
    const result = extractPhpClass(content);
    expect(result).toEqual({
      namespace: 'Magento\\Store\\Model',
      name: 'StoreManager',
      fqcn: 'Magento\\Store\\Model\\StoreManager',
      kind: 'class',
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
    expect(result).toEqual({
      namespace: 'Magento\\Store\\Api',
      name: 'StoreManagerInterface',
      fqcn: 'Magento\\Store\\Api\\StoreManagerInterface',
      kind: 'interface',
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
    expect(result).toEqual({
      namespace: 'Magento\\Framework',
      name: 'AbstractModel',
      fqcn: 'Magento\\Framework\\AbstractModel',
      kind: 'class',
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
    expect(result).toEqual({
      namespace: 'App\\Traits',
      name: 'Loggable',
      fqcn: 'App\\Traits\\Loggable',
      kind: 'trait',
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
    expect(result).toEqual({
      namespace: 'App\\Enums',
      name: 'Status',
      fqcn: 'App\\Enums\\Status',
      kind: 'enum',
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
    expect(result).toEqual({
      namespace: '',
      name: 'GlobalClass',
      fqcn: 'GlobalClass',
      kind: 'class',
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
    expect(result).toEqual({
      namespace: 'Magento\\Store\\Model',
      name: 'StoreManager',
      fqcn: 'Magento\\Store\\Model\\StoreManager',
      kind: 'class',
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
    expect(result).toEqual({
      namespace: 'App\\Services',
      name: 'PaymentService',
      fqcn: 'App\\Services\\PaymentService',
      kind: 'class',
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
