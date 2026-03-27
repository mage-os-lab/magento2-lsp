import { describe, it, expect } from 'vitest';
import {
  stripGeneratedSuffix,
  resolveSourceFqcn,
  generatedVariants,
} from '../../src/utils/generatedClassResolver';

describe('generatedClassResolver', () => {
  // -----------------------------------------------------------------------
  // stripGeneratedSuffix — single-level strip
  // -----------------------------------------------------------------------
  describe('stripGeneratedSuffix', () => {
    it('strips Factory suffix', () => {
      const result = stripGeneratedSuffix('Magento\\Catalog\\Model\\ProductFactory');
      expect(result).toEqual({
        suffix: 'Factory',
        baseFqcn: 'Magento\\Catalog\\Model\\Product',
      });
    });

    it('strips \\Proxy sub-namespace', () => {
      const result = stripGeneratedSuffix('Magento\\Catalog\\Model\\Product\\Proxy');
      expect(result).toEqual({
        suffix: '\\Proxy',
        baseFqcn: 'Magento\\Catalog\\Model\\Product',
      });
    });

    it('strips \\Interceptor sub-namespace', () => {
      const result = stripGeneratedSuffix('Magento\\Catalog\\Model\\Product\\Interceptor');
      expect(result).toEqual({
        suffix: '\\Interceptor',
        baseFqcn: 'Magento\\Catalog\\Model\\Product',
      });
    });

    it('strips \\ProxyDeferred sub-namespace', () => {
      const result = stripGeneratedSuffix('Magento\\Catalog\\Model\\Product\\ProxyDeferred');
      expect(result).toEqual({
        suffix: '\\ProxyDeferred',
        baseFqcn: 'Magento\\Catalog\\Model\\Product',
      });
    });

    it('strips \\Logger sub-namespace', () => {
      const result = stripGeneratedSuffix('Magento\\Catalog\\Model\\Product\\Logger');
      expect(result).toEqual({
        suffix: '\\Logger',
        baseFqcn: 'Magento\\Catalog\\Model\\Product',
      });
    });

    it('strips SearchResults suffix', () => {
      const result = stripGeneratedSuffix('Magento\\Catalog\\Api\\Data\\ProductSearchResults');
      expect(result).toEqual({
        suffix: 'SearchResults',
        baseFqcn: 'Magento\\Catalog\\Api\\Data\\Product',
      });
    });

    it('strips Mapper suffix', () => {
      const result = stripGeneratedSuffix('Magento\\Sales\\Api\\Data\\OrderMapper');
      expect(result).toEqual({
        suffix: 'Mapper',
        baseFqcn: 'Magento\\Sales\\Api\\Data\\Order',
      });
    });

    it('strips Repository suffix', () => {
      const result = stripGeneratedSuffix('Magento\\Catalog\\Model\\ProductRepository');
      expect(result).toEqual({
        suffix: 'Repository',
        baseFqcn: 'Magento\\Catalog\\Model\\Product',
      });
    });

    it('strips Persistor suffix', () => {
      const result = stripGeneratedSuffix('Magento\\Catalog\\Model\\ProductPersistor');
      expect(result).toEqual({
        suffix: 'Persistor',
        baseFqcn: 'Magento\\Catalog\\Model\\Product',
      });
    });

    it('strips Converter suffix', () => {
      const result = stripGeneratedSuffix('Magento\\Catalog\\Model\\ProductConverter');
      expect(result).toEqual({
        suffix: 'Converter',
        baseFqcn: 'Magento\\Catalog\\Model\\Product',
      });
    });

    it('strips Remote suffix', () => {
      const result = stripGeneratedSuffix('Magento\\Catalog\\Api\\ProductRemote');
      expect(result).toEqual({
        suffix: 'Remote',
        baseFqcn: 'Magento\\Catalog\\Api\\Product',
      });
    });

    // Extension attribute types — special base resolution
    it('strips ExtensionInterface and resolves to base Interface', () => {
      const result = stripGeneratedSuffix('Magento\\Catalog\\Api\\Data\\ProductExtensionInterface');
      expect(result).toEqual({
        suffix: 'ExtensionInterface',
        baseFqcn: 'Magento\\Catalog\\Api\\Data\\ProductInterface',
      });
    });

    it('strips Extension and resolves to base Interface', () => {
      const result = stripGeneratedSuffix('Magento\\Catalog\\Api\\Data\\ProductExtension');
      expect(result).toEqual({
        suffix: 'Extension',
        baseFqcn: 'Magento\\Catalog\\Api\\Data\\ProductInterface',
      });
    });

    it('strips ExtensionInterfaceFactory (single level → ExtensionInterface)', () => {
      const result = stripGeneratedSuffix(
        'Magento\\Catalog\\Api\\Data\\ProductExtensionInterfaceFactory',
      );
      expect(result).toEqual({
        suffix: 'ExtensionInterfaceFactory',
        baseFqcn: 'Magento\\Catalog\\Api\\Data\\ProductExtensionInterface',
      });
    });

    it('returns undefined for non-generated class', () => {
      expect(stripGeneratedSuffix('Magento\\Catalog\\Model\\Product')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(stripGeneratedSuffix('')).toBeUndefined();
    });

    // Ordering: ProxyDeferred must match before Proxy
    it('does not confuse \\ProxyDeferred with \\Proxy', () => {
      const result = stripGeneratedSuffix('Foo\\Bar\\ProxyDeferred');
      expect(result?.suffix).toBe('\\ProxyDeferred');
    });

    // Ordering: ExtensionInterface must match before Extension
    it('does not confuse ExtensionInterface with Extension', () => {
      const result = stripGeneratedSuffix('Foo\\BarExtensionInterface');
      expect(result?.suffix).toBe('ExtensionInterface');
    });
  });

  // -----------------------------------------------------------------------
  // resolveSourceFqcn — recursive resolution
  // -----------------------------------------------------------------------
  describe('resolveSourceFqcn', () => {
    it('resolves simple Factory to base class', () => {
      expect(resolveSourceFqcn('Magento\\Catalog\\Model\\ProductFactory'))
        .toBe('Magento\\Catalog\\Model\\Product');
    });

    it('resolves \\Proxy to base class', () => {
      expect(resolveSourceFqcn('Magento\\Catalog\\Model\\Product\\Proxy'))
        .toBe('Magento\\Catalog\\Model\\Product');
    });

    it('resolves \\Interceptor to base class', () => {
      expect(resolveSourceFqcn('Magento\\Catalog\\Model\\Product\\Interceptor'))
        .toBe('Magento\\Catalog\\Model\\Product');
    });

    it('resolves ExtensionInterface to base Interface', () => {
      expect(resolveSourceFqcn('Magento\\Catalog\\Api\\Data\\ProductExtensionInterface'))
        .toBe('Magento\\Catalog\\Api\\Data\\ProductInterface');
    });

    it('resolves Extension to base Interface', () => {
      expect(resolveSourceFqcn('Magento\\Catalog\\Api\\Data\\ProductExtension'))
        .toBe('Magento\\Catalog\\Api\\Data\\ProductInterface');
    });

    it('resolves ExtensionInterfaceFactory through two levels to base Interface', () => {
      // ExtensionInterfaceFactory → ExtensionInterface → base Interface
      expect(resolveSourceFqcn('Magento\\Catalog\\Api\\Data\\ProductExtensionInterfaceFactory'))
        .toBe('Magento\\Catalog\\Api\\Data\\ProductInterface');
    });

    it('resolves InterfaceFactory through one level', () => {
      // ProductInterfaceFactory → ProductInterface (Factory strip)
      expect(resolveSourceFqcn('Magento\\Catalog\\Api\\Data\\ProductInterfaceFactory'))
        .toBe('Magento\\Catalog\\Api\\Data\\ProductInterface');
    });

    it('returns undefined for non-generated class', () => {
      expect(resolveSourceFqcn('Magento\\Catalog\\Model\\Product')).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // generatedVariants — forward mapping for rename
  // -----------------------------------------------------------------------
  describe('generatedVariants', () => {
    it('returns all simple suffixes for a non-Interface class', () => {
      const variants = generatedVariants('Magento\\Catalog\\Model\\Product');
      const suffixes = variants.map((v) => v.suffix);

      // Should include simple suffixes and sub-namespaces but NOT extension types
      expect(suffixes).toContain('Factory');
      expect(suffixes).toContain('\\Proxy');
      expect(suffixes).toContain('\\Interceptor');
      expect(suffixes).toContain('\\ProxyDeferred');
      expect(suffixes).toContain('\\Logger');
      expect(suffixes).toContain('SearchResults');
      expect(suffixes).toContain('Mapper');
      expect(suffixes).toContain('Remote');

      // Extension types should NOT be included for non-Interface classes
      expect(suffixes).not.toContain('ExtensionInterface');
      expect(suffixes).not.toContain('Extension');
      expect(suffixes).not.toContain('ExtensionInterfaceFactory');
    });

    it('includes Extension variants for Interface classes', () => {
      const variants = generatedVariants('Magento\\Catalog\\Api\\Data\\ProductInterface');
      const suffixes = variants.map((v) => v.suffix);

      expect(suffixes).toContain('ExtensionInterface');
      expect(suffixes).toContain('Extension');
      expect(suffixes).toContain('ExtensionInterfaceFactory');
      // Simple suffixes still included
      expect(suffixes).toContain('Factory');
      expect(suffixes).toContain('\\Proxy');
    });

    it('builds correct generated FQCNs for simple suffixes', () => {
      const variants = generatedVariants('Magento\\Catalog\\Model\\Product');
      const factory = variants.find((v) => v.suffix === 'Factory')!;
      const proxy = variants.find((v) => v.suffix === '\\Proxy')!;
      const interceptor = variants.find((v) => v.suffix === '\\Interceptor')!;

      expect(factory.generatedFqcn).toBe('Magento\\Catalog\\Model\\ProductFactory');
      expect(proxy.generatedFqcn).toBe('Magento\\Catalog\\Model\\Product\\Proxy');
      expect(interceptor.generatedFqcn).toBe('Magento\\Catalog\\Model\\Product\\Interceptor');
    });

    it('builds correct generated FQCNs for Extension types', () => {
      const variants = generatedVariants('Magento\\Catalog\\Api\\Data\\ProductInterface');
      const extIface = variants.find((v) => v.suffix === 'ExtensionInterface')!;
      const ext = variants.find((v) => v.suffix === 'Extension')!;
      const extIfaceFactory = variants.find((v) => v.suffix === 'ExtensionInterfaceFactory')!;

      // ProductInterface → ProductExtensionInterface (strip Interface, add ExtensionInterface)
      expect(extIface.generatedFqcn).toBe('Magento\\Catalog\\Api\\Data\\ProductExtensionInterface');
      // ProductInterface → ProductExtension (strip Interface, add Extension)
      expect(ext.generatedFqcn).toBe('Magento\\Catalog\\Api\\Data\\ProductExtension');
      // ProductInterface → ProductExtensionInterfaceFactory
      expect(extIfaceFactory.generatedFqcn).toBe(
        'Magento\\Catalog\\Api\\Data\\ProductExtensionInterfaceFactory',
      );
    });

    it('buildNewFqcn correctly renames simple suffixes', () => {
      const variants = generatedVariants('Magento\\Catalog\\Model\\Product');
      const factory = variants.find((v) => v.suffix === 'Factory')!;
      const proxy = variants.find((v) => v.suffix === '\\Proxy')!;

      expect(factory.buildNewFqcn('Magento\\Catalog\\Model\\Item')).toBe(
        'Magento\\Catalog\\Model\\ItemFactory',
      );
      expect(proxy.buildNewFqcn('Magento\\Catalog\\Model\\Item')).toBe(
        'Magento\\Catalog\\Model\\Item\\Proxy',
      );
    });

    it('buildNewFqcn correctly renames Extension types', () => {
      const variants = generatedVariants('Magento\\Catalog\\Api\\Data\\ProductInterface');
      const extIface = variants.find((v) => v.suffix === 'ExtensionInterface')!;
      const ext = variants.find((v) => v.suffix === 'Extension')!;
      const extIfaceFactory = variants.find((v) => v.suffix === 'ExtensionInterfaceFactory')!;

      // Rename ProductInterface → ItemInterface
      const newBase = 'Magento\\Catalog\\Api\\Data\\ItemInterface';
      expect(extIface.buildNewFqcn(newBase)).toBe(
        'Magento\\Catalog\\Api\\Data\\ItemExtensionInterface',
      );
      expect(ext.buildNewFqcn(newBase)).toBe('Magento\\Catalog\\Api\\Data\\ItemExtension');
      expect(extIfaceFactory.buildNewFqcn(newBase)).toBe(
        'Magento\\Catalog\\Api\\Data\\ItemExtensionInterfaceFactory',
      );
    });
  });
});
