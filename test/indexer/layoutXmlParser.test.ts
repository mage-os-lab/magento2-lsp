import { describe, it, expect } from 'vitest';
import { parseLayoutXml, extractModuleName } from '../../src/indexer/layoutXmlParser';

describe('extractModuleName', () => {
  it('extracts module from standard block class', () => {
    expect(extractModuleName('Magento\\Catalog\\Block\\Product\\View')).toBe('Magento_Catalog');
  });

  it('extracts module from vendor block class', () => {
    expect(extractModuleName('Hyva\\Theme\\Block\\CurrentProduct')).toBe('Hyva_Theme');
  });

  it('returns empty for class without Block namespace', () => {
    expect(extractModuleName('Magento\\Catalog\\Model\\Product')).toBe('');
  });

  it('returns empty for empty string', () => {
    expect(extractModuleName('')).toBe('');
  });
});

describe('parseLayoutXml', () => {
  describe('block class', () => {
    it('extracts block class attribute', () => {
      const xml = `<?xml version="1.0"?>
<page>
    <body>
        <block class="Magento\\Catalog\\Block\\Product\\View" name="product.info" template="Magento_Catalog::product/view.phtml" />
    </body>
</page>`;
      const result = parseLayoutXml(xml, '/test/layout.xml');
      const blockClass = result.references.find((r) => r.kind === 'block-class');
      expect(blockClass).toBeDefined();
      expect(blockClass!.value).toBe('Magento\\Catalog\\Block\\Product\\View');
    });
  });

  describe('template identifier', () => {
    it('extracts full template identifier with module prefix', () => {
      const xml = `<?xml version="1.0"?>
<page>
    <body>
        <block class="Magento\\Catalog\\Block\\Product\\View" name="product.info" template="Magento_Catalog::product/view.phtml" />
    </body>
</page>`;
      const result = parseLayoutXml(xml, '/test/layout.xml');
      const tmpl = result.references.find((r) => r.kind === 'block-template');
      expect(tmpl).toBeDefined();
      expect(tmpl!.value).toBe('Magento_Catalog::product/view.phtml');
      expect(tmpl!.resolvedTemplateId).toBe('Magento_Catalog::product/view.phtml');
    });

    it('resolves short template path using block class', () => {
      const xml = `<?xml version="1.0"?>
<page>
    <body>
        <block class="Magento\\Catalog\\Block\\Product\\View" name="product.info" template="product/view.phtml" />
    </body>
</page>`;
      const result = parseLayoutXml(xml, '/test/layout.xml');
      const tmpl = result.references.find((r) => r.kind === 'block-template');
      expect(tmpl).toBeDefined();
      expect(tmpl!.value).toBe('product/view.phtml');
      expect(tmpl!.resolvedTemplateId).toBe('Magento_Catalog::product/view.phtml');
    });

    it('keeps short path unresolved when block has no class', () => {
      const xml = `<?xml version="1.0"?>
<page>
    <body>
        <block name="product.info" template="product/view.phtml" />
    </body>
</page>`;
      const result = parseLayoutXml(xml, '/test/layout.xml');
      const tmpl = result.references.find((r) => r.kind === 'block-template');
      expect(tmpl).toBeDefined();
      expect(tmpl!.resolvedTemplateId).toBe('product/view.phtml');
    });
  });

  describe('referenceBlock template', () => {
    it('extracts template from referenceBlock', () => {
      const xml = `<?xml version="1.0"?>
<page>
    <body>
        <referenceBlock name="breadcrumbs" template="Magento_Catalog::product/breadcrumbs.phtml" />
    </body>
</page>`;
      const result = parseLayoutXml(xml, '/test/layout.xml');
      const tmpl = result.references.find((r) => r.kind === 'refblock-template');
      expect(tmpl).toBeDefined();
      expect(tmpl!.value).toBe('Magento_Catalog::product/breadcrumbs.phtml');
    });
  });

  describe('argument object', () => {
    it('extracts object argument (ViewModel)', () => {
      const xml = `<?xml version="1.0"?>
<page>
    <body>
        <block class="Magento\\Catalog\\Block\\Product\\View" name="product.info">
            <arguments>
                <argument name="viewModel" xsi:type="object">Magento\\Catalog\\ViewModel\\Product</argument>
            </arguments>
        </block>
    </body>
</page>`;
      const result = parseLayoutXml(xml, '/test/layout.xml');
      const obj = result.references.find((r) => r.kind === 'argument-object');
      expect(obj).toBeDefined();
      expect(obj!.value).toBe('Magento\\Catalog\\ViewModel\\Product');
    });

    it('ignores string arguments', () => {
      const xml = `<?xml version="1.0"?>
<page>
    <body>
        <block class="Magento\\Theme\\Block\\Html" name="test">
            <arguments>
                <argument name="css_class" xsi:type="string">product</argument>
            </arguments>
        </block>
    </body>
</page>`;
      const result = parseLayoutXml(xml, '/test/layout.xml');
      const objs = result.references.filter((r) => r.kind === 'argument-object');
      expect(objs).toHaveLength(0);
    });
  });

  describe('complex layout', () => {
    it('parses a layout with multiple element types', () => {
      const xml = `<?xml version="1.0"?>
<page xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <body>
        <referenceBlock name="breadcrumbs" template="Magento_Catalog::product/breadcrumbs.phtml">
            <arguments>
                <argument name="viewModel" xsi:type="object">Magento\\Catalog\\ViewModel\\Product\\Breadcrumbs</argument>
            </arguments>
        </referenceBlock>
        <block class="Magento\\Catalog\\Block\\Product\\View" name="product.info" template="Magento_Catalog::product/view/form.phtml">
            <block class="Magento\\Catalog\\Block\\Product\\View" name="product.info.addtocart" template="Magento_Catalog::product/view/addtocart.phtml"/>
        </block>
    </body>
</page>`;
      const result = parseLayoutXml(xml, '/test/layout.xml');

      const kinds = result.references.map((r) => r.kind);
      expect(kinds.filter((k) => k === 'block-class')).toHaveLength(2);
      expect(kinds.filter((k) => k === 'block-template')).toHaveLength(2);
      expect(kinds.filter((k) => k === 'refblock-template')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'argument-object')).toHaveLength(1);
    });
  });

  describe('block and container names', () => {
    it('extracts block name attribute', () => {
      const xml = `<?xml version="1.0"?>
<page><body>
    <block class="Foo\\Block\\Bar" name="product.info" />
</body></page>`;
      const result = parseLayoutXml(xml, '/test/layout.xml');
      const ref = result.references.find((r) => r.kind === 'block-name');
      expect(ref).toBeDefined();
      expect(ref!.value).toBe('product.info');
      expect(ref!.blockClass).toBe('Foo\\Block\\Bar');
    });

    it('extracts container name attribute', () => {
      const xml = `<?xml version="1.0"?>
<page><body>
    <container name="content" label="Main Content Area" htmlTag="div" />
</body></page>`;
      const result = parseLayoutXml(xml, '/test/layout.xml');
      const ref = result.references.find((r) => r.kind === 'container-name');
      expect(ref).toBeDefined();
      expect(ref!.value).toBe('content');
      expect(ref!.containerLabel).toBe('Main Content Area');
    });

    it('extracts referenceBlock name attribute', () => {
      const xml = `<?xml version="1.0"?>
<page><body>
    <referenceBlock name="product.info" remove="true" />
</body></page>`;
      const result = parseLayoutXml(xml, '/test/layout.xml');
      const ref = result.references.find((r) => r.kind === 'reference-block');
      expect(ref).toBeDefined();
      expect(ref!.value).toBe('product.info');
    });

    it('extracts referenceContainer name attribute', () => {
      const xml = `<?xml version="1.0"?>
<page><body>
    <referenceContainer name="content">
        <block class="Foo\\Block\\Bar" name="test" />
    </referenceContainer>
</body></page>`;
      const result = parseLayoutXml(xml, '/test/layout.xml');
      const ref = result.references.find((r) => r.kind === 'reference-container');
      expect(ref).toBeDefined();
      expect(ref!.value).toBe('content');
    });

    it('emits block-name without blockClass when class attribute is absent', () => {
      const xml = `<?xml version="1.0"?>
<page><body>
    <block name="no.class.block" template="Module::template.phtml" />
</body></page>`;
      const result = parseLayoutXml(xml, '/test/layout.xml');
      const ref = result.references.find((r) => r.kind === 'block-name');
      expect(ref).toBeDefined();
      expect(ref!.value).toBe('no.class.block');
      expect(ref!.blockClass).toBeUndefined();
    });
  });

  describe('column positions', () => {
    it('tracks accurate positions for block class', () => {
      const xml = `<?xml version="1.0"?>
<page>
    <block class="Foo\\Block\\Bar" name="test" />
</page>`;
      const result = parseLayoutXml(xml, '/test/layout.xml');
      const ref = result.references.find((r) => r.kind === 'block-class')!;
      const line = xml.split('\n')[2];
      const col = line.indexOf('Foo\\Block\\Bar');
      expect(ref.column).toBe(col);
    });
  });
});
