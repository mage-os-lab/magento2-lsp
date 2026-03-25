import { describe, it, expect } from 'vitest';
import { parseWebapiXml, WebapiXmlParseContext } from '../../src/indexer/webapiXmlParser';

const defaultContext: WebapiXmlParseContext = {
  file: '/vendor/test/module-foo/etc/webapi.xml',
  module: 'Test_Foo',
};

describe('parseWebapiXml', () => {
  it('extracts service class and method from a basic route', () => {
    const xml = `<?xml version="1.0"?>
<routes>
    <route url="/V1/customers/:customerId" method="GET">
        <service class="Magento\\Customer\\Api\\CustomerRepositoryInterface" method="getById"/>
        <resources>
            <resource ref="Magento_Customer::manage"/>
        </resources>
    </route>
</routes>`;
    const result = parseWebapiXml(xml, defaultContext);

    const serviceClass = result.references.find((r) => r.kind === 'service-class');
    expect(serviceClass).toBeDefined();
    expect(serviceClass!.value).toBe('Magento\\Customer\\Api\\CustomerRepositoryInterface');
    expect(serviceClass!.fqcn).toBe('Magento\\Customer\\Api\\CustomerRepositoryInterface');
    expect(serviceClass!.routeUrl).toBe('/V1/customers/:customerId');
    expect(serviceClass!.httpMethod).toBe('GET');

    const serviceMethod = result.references.find((r) => r.kind === 'service-method');
    expect(serviceMethod).toBeDefined();
    expect(serviceMethod!.value).toBe('getById');
    expect(serviceMethod!.methodName).toBe('getById');
    expect(serviceMethod!.fqcn).toBe('Magento\\Customer\\Api\\CustomerRepositoryInterface');
    expect(serviceMethod!.routeUrl).toBe('/V1/customers/:customerId');
    expect(serviceMethod!.httpMethod).toBe('GET');

    const resource = result.references.find((r) => r.kind === 'resource-ref');
    expect(resource).toBeDefined();
    expect(resource!.value).toBe('Magento_Customer::manage');
    expect(resource!.routeUrl).toBe('/V1/customers/:customerId');
    expect(resource!.httpMethod).toBe('GET');
  });

  it('extracts multiple routes', () => {
    const xml = `<?xml version="1.0"?>
<routes>
    <route url="/V1/customers" method="POST">
        <service class="Magento\\Customer\\Api\\CustomerRepositoryInterface" method="save"/>
        <resources>
            <resource ref="Magento_Customer::manage"/>
        </resources>
    </route>
    <route url="/V1/customers/:customerId" method="DELETE">
        <service class="Magento\\Customer\\Api\\CustomerRepositoryInterface" method="deleteById"/>
        <resources>
            <resource ref="Magento_Customer::manage"/>
        </resources>
    </route>
</routes>`;
    const result = parseWebapiXml(xml, defaultContext);

    const serviceClasses = result.references.filter((r) => r.kind === 'service-class');
    expect(serviceClasses).toHaveLength(2);
    expect(serviceClasses[0].httpMethod).toBe('POST');
    expect(serviceClasses[0].methodName).toBe('save');
    expect(serviceClasses[1].httpMethod).toBe('DELETE');
    expect(serviceClasses[1].methodName).toBe('deleteById');
  });

  it('handles self and anonymous resource refs', () => {
    const xml = `<?xml version="1.0"?>
<routes>
    <route url="/V1/customers/me" method="GET">
        <service class="Magento\\Customer\\Api\\CustomerRepositoryInterface" method="getById"/>
        <resources>
            <resource ref="self"/>
        </resources>
    </route>
    <route url="/V1/store/storeViews" method="GET">
        <service class="Magento\\Store\\Api\\StoreRepositoryInterface" method="getList"/>
        <resources>
            <resource ref="anonymous"/>
        </resources>
    </route>
</routes>`;
    const result = parseWebapiXml(xml, defaultContext);

    const resources = result.references.filter((r) => r.kind === 'resource-ref');
    expect(resources).toHaveLength(2);
    expect(resources[0].value).toBe('self');
    expect(resources[1].value).toBe('anonymous');
  });

  it('normalizes leading backslash on service class FQCNs', () => {
    const xml = `<?xml version="1.0"?>
<routes>
    <route url="/V1/test" method="GET">
        <service class="\\Vendor\\Module\\Api\\TestInterface" method="get"/>
        <resources><resource ref="anonymous"/></resources>
    </route>
</routes>`;
    const result = parseWebapiXml(xml, defaultContext);

    const serviceClass = result.references.find((r) => r.kind === 'service-class');
    expect(serviceClass!.value).toBe('Vendor\\Module\\Api\\TestInterface');
    expect(serviceClass!.fqcn).toBe('Vendor\\Module\\Api\\TestInterface');
  });

  it('tracks accurate column positions for service class', () => {
    const xml = `<?xml version="1.0"?>
<routes>
    <route url="/V1/test" method="GET">
        <service class="Vendor\\Module\\Api\\TestInterface" method="get"/>
        <resources><resource ref="anonymous"/></resources>
    </route>
</routes>`;
    const result = parseWebapiXml(xml, defaultContext);
    const serviceClass = result.references.find((r) => r.kind === 'service-class');
    const line = xml.split('\n')[3];
    const col = line.indexOf('Vendor\\Module\\Api\\TestInterface');
    expect(serviceClass!.column).toBe(col);
    expect(serviceClass!.endColumn).toBe(col + 'Vendor\\Module\\Api\\TestInterface'.length);
  });

  it('tracks accurate column positions for service method', () => {
    const xml = `<?xml version="1.0"?>
<routes>
    <route url="/V1/test" method="GET">
        <service class="Vendor\\Module\\Api\\TestInterface" method="getById"/>
        <resources><resource ref="anonymous"/></resources>
    </route>
</routes>`;
    const result = parseWebapiXml(xml, defaultContext);
    const serviceMethod = result.references.find((r) => r.kind === 'service-method');
    const line = xml.split('\n')[3];
    const col = line.indexOf('getById');
    expect(serviceMethod!.column).toBe(col);
    expect(serviceMethod!.endColumn).toBe(col + 'getById'.length);
  });

  it('tracks accurate column positions for resource ref', () => {
    const xml = `<?xml version="1.0"?>
<routes>
    <route url="/V1/test" method="GET">
        <service class="Vendor\\Module\\Api\\TestInterface" method="get"/>
        <resources>
            <resource ref="Vendor_Module::manage"/>
        </resources>
    </route>
</routes>`;
    const result = parseWebapiXml(xml, defaultContext);
    const resource = result.references.find((r) => r.kind === 'resource-ref');
    const line = xml.split('\n')[5];
    const col = line.indexOf('Vendor_Module::manage');
    expect(resource!.column).toBe(col);
    expect(resource!.endColumn).toBe(col + 'Vendor_Module::manage'.length);
  });

  it('propagates context to all references', () => {
    const xml = `<?xml version="1.0"?>
<routes>
    <route url="/V1/test" method="GET">
        <service class="Vendor\\Api\\TestInterface" method="get"/>
        <resources><resource ref="Vendor_Module::manage"/></resources>
    </route>
</routes>`;
    const ctx: WebapiXmlParseContext = {
      file: '/test/webapi.xml',
      module: 'My_Module',
    };
    const result = parseWebapiXml(xml, ctx);
    for (const ref of result.references) {
      expect(ref.file).toBe('/test/webapi.xml');
      expect(ref.module).toBe('My_Module');
    }
  });

  it('uppercases HTTP method', () => {
    const xml = `<?xml version="1.0"?>
<routes>
    <route url="/V1/test" method="get">
        <service class="Vendor\\Api\\TestInterface" method="get"/>
        <resources><resource ref="anonymous"/></resources>
    </route>
</routes>`;
    const result = parseWebapiXml(xml, defaultContext);
    for (const ref of result.references) {
      expect(ref.httpMethod).toBe('GET');
    }
  });

  it('ignores service elements outside a route', () => {
    const xml = `<?xml version="1.0"?>
<routes>
    <service class="Vendor\\Api\\TestInterface" method="get"/>
    <route url="/V1/test" method="GET">
        <service class="Vendor\\Api\\TestInterface" method="get"/>
        <resources><resource ref="anonymous"/></resources>
    </route>
</routes>`;
    const result = parseWebapiXml(xml, defaultContext);
    // Only the service inside the route should be captured
    const serviceClasses = result.references.filter((r) => r.kind === 'service-class');
    expect(serviceClasses).toHaveLength(1);
  });

  it('handles malformed XML gracefully', () => {
    const xml = `<?xml version="1.0"?>
<routes>
    <route url="/V1/test" method="GET">
        <service class="Vendor\\Api\\TestInterface" method="get"/>
        <resources><resource ref="anonymous"/>
    <!-- missing closing tags -->`;
    const result = parseWebapiXml(xml, defaultContext);
    // Should return partial results without throwing
    expect(result.references.length).toBeGreaterThan(0);
  });

  it('handles multiline service tag', () => {
    const xml = `<?xml version="1.0"?>
<routes>
    <route url="/V1/test" method="GET">
        <service
            class="Vendor\\Api\\TestInterface"
            method="get"/>
        <resources><resource ref="anonymous"/></resources>
    </route>
</routes>`;
    const result = parseWebapiXml(xml, defaultContext);
    const serviceClass = result.references.find((r) => r.kind === 'service-class');
    expect(serviceClass).toBeDefined();
    expect(serviceClass!.value).toBe('Vendor\\Api\\TestInterface');

    const serviceMethod = result.references.find((r) => r.kind === 'service-method');
    expect(serviceMethod).toBeDefined();
    expect(serviceMethod!.value).toBe('get');
  });
});
