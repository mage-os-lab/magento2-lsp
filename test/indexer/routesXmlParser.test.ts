import { describe, it, expect } from 'vitest';
import { parseRoutesXml, RoutesXmlParseContext } from '../../src/indexer/routesXmlParser';

const defaultContext: RoutesXmlParseContext = {
  file: '/vendor/test/module-foo/etc/frontend/routes.xml',
  module: 'Test_Foo',
  area: 'frontend',
};

describe('parseRoutesXml', () => {
  it('extracts route-id, route-frontname, and route-module references', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <router id="standard">
        <route id="testfoo" frontName="testfoo">
            <module name="Test_Foo"/>
        </route>
    </router>
</config>`;
    const result = parseRoutesXml(xml, defaultContext);

    expect(result.references).toHaveLength(3);

    const routeId = result.references.find(r => r.kind === 'route-id');
    expect(routeId).toBeDefined();
    expect(routeId!.value).toBe('testfoo');
    expect(routeId!.routerType).toBe('standard');
    expect(routeId!.frontName).toBe('testfoo');

    const frontName = result.references.find(r => r.kind === 'route-frontname');
    expect(frontName).toBeDefined();
    expect(frontName!.value).toBe('testfoo');
    expect(frontName!.routerType).toBe('standard');

    const mod = result.references.find(r => r.kind === 'route-module');
    expect(mod).toBeDefined();
    expect(mod!.value).toBe('Test_Foo');
    expect(mod!.routerType).toBe('standard');
    expect(mod!.frontName).toBe('testfoo');
    expect(mod!.routeId).toBe('testfoo');
  });

  it('captures before and after attributes on module elements', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <router id="standard">
        <route id="catalog" frontName="catalog">
            <module name="Test_Foo" before="Magento_Catalog"/>
        </route>
    </router>
</config>`;
    const result = parseRoutesXml(xml, defaultContext);

    const mod = result.references.find(r => r.kind === 'route-module');
    expect(mod).toBeDefined();
    expect(mod!.value).toBe('Test_Foo');
    expect(mod!.before).toBe('Magento_Catalog');
    expect(mod!.after).toBeUndefined();
  });

  it('handles after attribute on module elements', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <router id="standard">
        <route id="catalog" frontName="catalog">
            <module name="Test_Foo" after="Magento_Catalog"/>
        </route>
    </router>
</config>`;
    const result = parseRoutesXml(xml, defaultContext);

    const mod = result.references.find(r => r.kind === 'route-module');
    expect(mod!.after).toBe('Magento_Catalog');
    expect(mod!.before).toBeUndefined();
  });

  it('extracts multiple routes and modules', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <router id="standard">
        <route id="catalog" frontName="catalog">
            <module name="Magento_Catalog"/>
            <module name="Magento_CatalogSearch" before="Magento_Catalog"/>
        </route>
        <route id="checkout" frontName="checkout">
            <module name="Magento_Checkout"/>
        </route>
    </router>
</config>`;
    const result = parseRoutesXml(xml, defaultContext);

    // 2 routes × (route-id + route-frontname) + 3 modules = 7
    expect(result.references).toHaveLength(7);

    const modules = result.references.filter(r => r.kind === 'route-module');
    expect(modules).toHaveLength(3);
    expect(modules[0].value).toBe('Magento_Catalog');
    expect(modules[0].frontName).toBe('catalog');
    expect(modules[1].value).toBe('Magento_CatalogSearch');
    expect(modules[1].frontName).toBe('catalog');
    expect(modules[2].value).toBe('Magento_Checkout');
    expect(modules[2].frontName).toBe('checkout');
  });

  it('handles admin router type', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <router id="admin">
        <route id="adminhtml" frontName="admin">
            <module name="Magento_Backend"/>
        </route>
    </router>
</config>`;
    const ctx: RoutesXmlParseContext = {
      file: '/vendor/magento/module-backend/etc/adminhtml/routes.xml',
      module: 'Magento_Backend',
      area: 'adminhtml',
    };
    const result = parseRoutesXml(xml, ctx);

    const refs = result.references;
    expect(refs.every(r => r.routerType === 'admin')).toBe(true);
    expect(refs.every(r => r.area === 'adminhtml')).toBe(true);
  });

  it('tracks accurate column positions', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <router id="standard">
        <route id="testfoo" frontName="testfoo">
            <module name="Test_Foo"/>
        </route>
    </router>
</config>`;
    const result = parseRoutesXml(xml, defaultContext);

    const routeId = result.references.find(r => r.kind === 'route-id')!;
    const routeLine = xml.split('\n')[3];
    const idCol = routeLine.indexOf('testfoo');
    expect(routeId.column).toBe(idCol);
    expect(routeId.endColumn).toBe(idCol + 'testfoo'.length);

    const mod = result.references.find(r => r.kind === 'route-module')!;
    const modLine = xml.split('\n')[4];
    const modCol = modLine.indexOf('Test_Foo');
    expect(mod.column).toBe(modCol);
    expect(mod.endColumn).toBe(modCol + 'Test_Foo'.length);
  });

  it('ignores module elements outside route', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <module name="Stray_Module"/>
    <router id="standard">
        <route id="testfoo" frontName="testfoo">
            <module name="Test_Foo"/>
        </route>
    </router>
</config>`;
    const result = parseRoutesXml(xml, defaultContext);

    const modules = result.references.filter(r => r.kind === 'route-module');
    expect(modules).toHaveLength(1);
    expect(modules[0].value).toBe('Test_Foo');
  });

  it('handles route without frontName', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <router id="standard">
        <route id="testfoo">
            <module name="Test_Foo"/>
        </route>
    </router>
</config>`;
    const result = parseRoutesXml(xml, defaultContext);

    // route-id emitted, no route-frontname
    const routeIds = result.references.filter(r => r.kind === 'route-id');
    const frontNames = result.references.filter(r => r.kind === 'route-frontname');
    expect(routeIds).toHaveLength(1);
    expect(frontNames).toHaveLength(0);
  });

  it('propagates context to all references', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <router id="standard">
        <route id="testfoo" frontName="testfoo">
            <module name="Test_Foo"/>
        </route>
    </router>
</config>`;
    const result = parseRoutesXml(xml, defaultContext);

    for (const ref of result.references) {
      expect(ref.file).toBe(defaultContext.file);
      expect(ref.module).toBe(defaultContext.module);
      expect(ref.area).toBe(defaultContext.area);
    }
  });

  it('handles malformed XML gracefully', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <router id="standard">
        <route id="testfoo" frontName="testfoo">
            <module name="Test_Foo"/>
    <!-- missing closing tags -->`;
    const result = parseRoutesXml(xml, defaultContext);
    expect(result.references.length).toBeGreaterThan(0);
  });

  it('handles multiline route tag', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <router id="standard">
        <route
            id="testfoo"
            frontName="testfoo">
            <module name="Test_Foo"/>
        </route>
    </router>
</config>`;
    const result = parseRoutesXml(xml, defaultContext);

    expect(result.references).toHaveLength(3);
    const routeId = result.references.find(r => r.kind === 'route-id');
    expect(routeId!.value).toBe('testfoo');
  });

  it('resets route context between routes', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <router id="standard">
        <route id="first" frontName="first">
            <module name="First_Module"/>
        </route>
        <route id="second" frontName="second">
            <module name="Second_Module"/>
        </route>
    </router>
</config>`;
    const result = parseRoutesXml(xml, defaultContext);

    const modules = result.references.filter(r => r.kind === 'route-module');
    expect(modules[0].frontName).toBe('first');
    expect(modules[0].routeId).toBe('first');
    expect(modules[1].frontName).toBe('second');
    expect(modules[1].routeId).toBe('second');
  });
});
