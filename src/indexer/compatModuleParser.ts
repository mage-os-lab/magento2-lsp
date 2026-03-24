/**
 * Parser for Hyvä compatibility module registrations in di.xml files.
 *
 * Hyvä's magento2-compat-module-fallback extension allows compatibility modules
 * to override templates automatically (without layout XML) by registering in di.xml:
 *
 *   <type name="Hyva\CompatModuleFallback\Model\CompatModuleRegistry">
 *     <arguments>
 *       <argument name="compatModules" xsi:type="array">
 *         <item name="some_key" xsi:type="array">
 *           <item name="original_module" xsi:type="string">Orig_Module</item>
 *           <item name="compat_module" xsi:type="string">Hyva_OrigModule</item>
 *         </item>
 *       </argument>
 *     </arguments>
 *   </type>
 *
 * This parser extracts those original_module → compat_module mappings from di.xml.
 * It only needs to scan etc/frontend/di.xml files since compat module fallback
 * only operates in the frontend area.
 */

import * as sax from 'sax';
import { getAttr, installErrorHandler } from '../utils/saxHelpers';

export interface CompatModuleMapping {
  originalModule: string;
  compatModule: string;
}

/**
 * Parse a di.xml file and extract Hyvä compat module registrations.
 *
 * Uses a SAX parser to find <type name="...CompatModuleRegistry"> elements,
 * then extracts the original_module/compat_module pairs from nested <item> arguments.
 *
 * Returns an empty array if the file contains no compat module registrations.
 */
export function parseCompatModuleRegistrations(
  xmlContent: string,
): CompatModuleMapping[] {
  const results: CompatModuleMapping[] = [];
  const parser = sax.parser(true, { position: true, trim: false });

  // Track nesting depth to know when we're inside the CompatModuleRegistry type.
  // State machine:
  //   0 = outside everything
  //   1 = inside <type name="...CompatModuleRegistry">
  //   2 = inside <argument name="compatModules">
  //   3 = inside a mapping <item> (the outer array item containing original_module/compat_module)
  //   4 = inside a leaf <item name="original_module|compat_module"> collecting text
  let state = 0;
  let currentMapping: Partial<CompatModuleMapping> = {};
  let currentItemName = '';
  let textBuffer = '';

  parser.onopentag = (tag) => {
    const tagName = tag.name.toLowerCase();

    if (state === 0 && tagName === 'type') {
      const name = getAttr(tag, 'name');
      // Match on suffix to handle both full FQCN and short name
      if (name && name.endsWith('CompatModuleRegistry')) {
        state = 1;
      }
    } else if (state === 1 && tagName === 'argument') {
      const name = getAttr(tag, 'name');
      if (name === 'compatModules') {
        state = 2;
      }
    } else if (state === 2 && tagName === 'item') {
      // Outer <item> — a single mapping entry (contains original_module + compat_module)
      state = 3;
      currentMapping = {};
    } else if (state === 3 && tagName === 'item') {
      // Inner <item name="original_module|compat_module"> with string value
      const name = getAttr(tag, 'name');
      if (name === 'original_module' || name === 'compat_module') {
        state = 4;
        currentItemName = name;
        textBuffer = '';
      }
    }
  };

  parser.ontext = (text) => {
    if (state === 4) {
      textBuffer += text;
    }
  };

  parser.oncdata = (cdata) => {
    if (state === 4) {
      textBuffer += cdata;
    }
  };

  parser.onclosetag = (tagName) => {
    const name = tagName.toLowerCase();

    if (state === 4 && name === 'item') {
      // Finished reading a leaf item — store the value
      const value = textBuffer.trim();
      if (currentItemName === 'original_module') {
        currentMapping.originalModule = value;
      } else if (currentItemName === 'compat_module') {
        currentMapping.compatModule = value;
      }
      state = 3;
    } else if (state === 3 && name === 'item') {
      // Finished a mapping entry — emit if both fields present
      if (currentMapping.originalModule && currentMapping.compatModule) {
        results.push({
          originalModule: currentMapping.originalModule,
          compatModule: currentMapping.compatModule,
        });
      }
      state = 2;
    } else if (state === 2 && name === 'argument') {
      state = 1;
    } else if (state === 1 && name === 'type') {
      state = 0;
    }
  };

  installErrorHandler(parser);

  parser.write(xmlContent).close();

  return results;
}

