/**
 * Parser for Magento 2 events.xml files.
 *
 * Extracts event names and observer class references with precise line/column positions.
 * Uses the same SAX-based approach as diXmlParser.
 *
 * events.xml structure:
 *   <config>
 *     <event name="catalog_product_save_after">
 *       <observer name="my_observer" instance="Vendor\Module\Observer\MyObserver" />
 *     </event>
 *   </config>
 */

import * as sax from 'sax';
import { EventReference, ObserverReference } from './types';
import { normalizeFqcn } from '../utils/fqcnNormalize';
import { findAttributeValuePosition } from '../utils/xmlPositionUtil';

export interface EventsXmlParseContext {
  file: string;
  area: string;
  module: string;
}

export interface EventsXmlParseResult {
  events: EventReference[];
  observers: ObserverReference[];
}

export function parseEventsXml(
  xmlContent: string,
  context: EventsXmlParseContext,
): EventsXmlParseResult {
  const events: EventReference[] = [];
  const observers: ObserverReference[] = [];
  const lines = xmlContent.split('\n');

  const parser = sax.parser(true, { position: true, trim: false });

  // Track the current event name so we can associate observers with their event
  let currentEventName = '';
  let currentEventLine = 0;
  let currentTagStartLine = 0;

  parser.onopentagstart = () => {
    currentTagStartLine = parser.line ?? 0;
  };

  parser.onopentag = (tag) => {
    const tagLine = parser.line ?? 0;
    const tagStartLine = currentTagStartLine;
    const tagName = tag.name.toLowerCase();

    if (tagName === 'event') {
      const nameAttr = tag.attributes['name'] ?? tag.attributes['NAME'];
      const nameValue = typeof nameAttr === 'string' ? nameAttr : nameAttr?.value;

      if (nameValue) {
        currentEventName = nameValue;
        currentEventLine = tagLine;

        const pos = findAttributeValuePosition(lines, tagLine, 'name', tagStartLine);
        if (pos) {
          events.push({
            eventName: nameValue,
            file: context.file,
            line: pos.line,
            column: pos.column,
            endColumn: pos.endColumn,
            area: context.area,
            module: context.module,
          });
        }
      }
    } else if (tagName === 'observer' && currentEventName) {
      const instanceAttr = tag.attributes['instance'] ?? tag.attributes['INSTANCE'];
      const nameAttr = tag.attributes['name'] ?? tag.attributes['NAME'];

      const instanceValue = typeof instanceAttr === 'string' ? instanceAttr : instanceAttr?.value;
      const nameValue = typeof nameAttr === 'string' ? nameAttr : nameAttr?.value;

      if (instanceValue) {
        const normalized = normalizeFqcn(instanceValue);
        const pos = findAttributeValuePosition(lines, tagLine, 'instance', tagStartLine);
        if (pos) {
          observers.push({
            fqcn: normalized,
            eventName: currentEventName,
            observerName: nameValue ?? '',
            file: context.file,
            line: pos.line,
            column: pos.column,
            endColumn: pos.endColumn,
            area: context.area,
            module: context.module,
          });
        }
      }
    }
  };

  parser.onclosetag = (tagName) => {
    if (tagName.toLowerCase() === 'event') {
      currentEventName = '';
    }
  };

  parser.onerror = () => {
    parser.error = null as unknown as Error;
    parser.resume();
  };

  parser.write(xmlContent).close();

  return { events, observers };
}
