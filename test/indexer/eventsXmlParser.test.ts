import { describe, it, expect } from 'vitest';
import { parseEventsXml, EventsXmlParseContext } from '../../src/indexer/eventsXmlParser';

const defaultContext: EventsXmlParseContext = {
  file: '/vendor/test/module-foo/etc/events.xml',
  area: 'global',
  module: 'Test_Foo',
};

describe('parseEventsXml', () => {
  it('extracts event names', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <event name="catalog_product_save_after">
        <observer name="my_observer" instance="Vendor\\Module\\Observer\\MyObserver" />
    </event>
</config>`;
    const result = parseEventsXml(xml, defaultContext);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].eventName).toBe('catalog_product_save_after');
    expect(result.events[0].line).toBe(2);
  });

  it('extracts observer instance FQCNs', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <event name="catalog_product_save_after">
        <observer name="my_observer" instance="Vendor\\Module\\Observer\\MyObserver" />
    </event>
</config>`;
    const result = parseEventsXml(xml, defaultContext);
    expect(result.observers).toHaveLength(1);
    expect(result.observers[0].fqcn).toBe('Vendor\\Module\\Observer\\MyObserver');
    expect(result.observers[0].eventName).toBe('catalog_product_save_after');
    expect(result.observers[0].observerName).toBe('my_observer');
    expect(result.observers[0].line).toBe(3);
  });

  it('normalizes leading backslash on instance', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <event name="test_event">
        <observer name="obs" instance="\\Vendor\\Module\\Observer\\Foo" />
    </event>
</config>`;
    const result = parseEventsXml(xml, defaultContext);
    expect(result.observers[0].fqcn).toBe('Vendor\\Module\\Observer\\Foo');
  });

  it('handles multiple events and observers', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <event name="event_one">
        <observer name="obs_a" instance="Vendor\\A" />
    </event>
    <event name="event_two">
        <observer name="obs_b" instance="Vendor\\B" />
        <observer name="obs_c" instance="Vendor\\C" />
    </event>
</config>`;
    const result = parseEventsXml(xml, defaultContext);
    expect(result.events).toHaveLength(2);
    expect(result.observers).toHaveLength(3);
    expect(result.observers[1].eventName).toBe('event_two');
    expect(result.observers[2].eventName).toBe('event_two');
  });

  it('propagates context to all entries', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <event name="test">
        <observer name="obs" instance="Vendor\\Obs" />
    </event>
</config>`;
    const ctx: EventsXmlParseContext = {
      file: '/test/events.xml',
      area: 'frontend',
      module: 'My_Module',
    };
    const result = parseEventsXml(xml, ctx);
    expect(result.events[0].area).toBe('frontend');
    expect(result.events[0].module).toBe('My_Module');
    expect(result.observers[0].area).toBe('frontend');
    expect(result.observers[0].module).toBe('My_Module');
  });

  it('tracks accurate column positions for event name', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <event name="my_event">
    </event>
</config>`;
    const result = parseEventsXml(xml, defaultContext);
    // '    <event name="' = 17 chars to the opening quote, value starts at column 17
    expect(result.events[0].column).toBe(17);
    expect(result.events[0].endColumn).toBe(25); // "my_event" = 8 chars
  });

  it('tracks accurate column positions for observer instance', () => {
    const xml = `<?xml version="1.0"?>
<config>
    <event name="ev">
        <observer name="obs" instance="Foo\\Bar" />
    </event>
</config>`;
    const result = parseEventsXml(xml, defaultContext);
    const obs = result.observers[0];
    expect(obs.fqcn).toBe('Foo\\Bar');
    const line = xml.split('\n')[3];
    const col = line.indexOf('Foo\\Bar');
    expect(obs.column).toBe(col);
  });
});
