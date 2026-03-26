/**
 * Parser for Magento 2 system.xml files and their include partials.
 *
 * Extracts config path references (section/group/field IDs) and model class
 * references (source_model, backend_model, frontend_model) with precise
 * line/column positions.
 *
 * system.xml structure (main file):
 *   <config>
 *     <system>
 *       <section id="payment">
 *         <label>Payment</label>
 *         <group id="account">
 *           <field id="active">
 *             <label>Enabled</label>
 *             <source_model>Magento\Config\Model\Config\Source\Yesno</source_model>
 *           </field>
 *         </group>
 *       </section>
 *     </system>
 *   </config>
 *
 * Include partial structure:
 *   <include xmlns:xsi="...">
 *     <group id="order_comment">
 *       <field id="enable">...</field>
 *     </group>
 *   </include>
 *
 * Groups can nest arbitrarily deep, producing config paths with 4+ segments.
 */

import * as sax from 'sax';
import { SystemConfigReference, SystemConfigReferenceKind } from './types';
import { normalizeFqcn } from '../utils/fqcnNormalize';
import { findAttributeValuePosition, findTextContentPosition } from '../utils/xmlPositionUtil';
import { getAttr, installErrorHandler } from '../utils/saxHelpers';

export interface SystemXmlParseContext {
  file: string;
  module: string;
}

export interface SystemXmlParseResult {
  references: SystemConfigReference[];
}

/** Tags whose text content is a PHP FQCN. */
const MODEL_TAGS: Record<string, SystemConfigReferenceKind> = {
  source_model: 'source-model',
  backend_model: 'backend-model',
  frontend_model: 'frontend-model',
};

/** Tags that contribute to the config path hierarchy. */
const PATH_TAGS = new Set(['section', 'group', 'field']);

export function parseSystemXml(
  xmlContent: string,
  context: SystemXmlParseContext,
): SystemXmlParseResult {
  const references: SystemConfigReference[] = [];
  const lines = xmlContent.split('\n');

  const parser = sax.parser(true, { position: true, trim: false });

  // Stack-based path tracking for arbitrary nesting depth.
  // Each entry is the `id` attribute of a section/group/field element.
  const pathStack: string[] = [];

  // Track which reference index corresponds to each path stack level,
  // so we can attach <label> text to the parent section/group/field.
  const refIndexStack: (number | undefined)[] = [];

  // Tracks whether each PATH_TAG pushed a real id to pathStack/refIndexStack.
  // Tags without id don't push to those stacks, so we skip the pop on close.
  const hasIdStack: boolean[] = [];

  // True once we're inside <system> (main file) or <include> (partial).
  // Prevents emitting references for wrapper elements.
  let inContent = false;

  let currentTagStartLine = 0;
  let currentTagName = '';
  let collectingText = false;
  let collectedText = '';
  let modelTagKind: SystemConfigReferenceKind | undefined;
  let collectingLabel = false;
  // True when we're inside a <resource> element (ACL resource for a section)
  let collectingResource = false;

  parser.onopentagstart = () => {
    currentTagStartLine = parser.line ?? 0;
  };

  parser.onopentag = (tag) => {
    const tagLine = parser.line ?? 0;
    const tagStartLine = currentTagStartLine;
    const tagName = tag.name.toLowerCase();
    currentTagName = tagName;

    // Enter content mode on <system> or <include>
    if (tagName === 'system' || tagName === 'include') {
      inContent = true;
      return;
    }

    if (!inContent) return;

    if (PATH_TAGS.has(tagName)) {
      const idValue = getAttr(tag, 'id');
      if (idValue) {
        hasIdStack.push(true);
        pathStack.push(idValue);
        const configPath = pathStack.join('/');

        let kind: SystemConfigReferenceKind;
        if (tagName === 'section') kind = 'section-id';
        else if (tagName === 'field') kind = 'field-id';
        else kind = 'group-id';

        const pos = findAttributeValuePosition(lines, tagLine, 'id', tagStartLine);
        if (pos) {
          const refIndex = references.length;
          references.push({
            kind,
            configPath,
            file: context.file,
            line: pos.line,
            column: pos.column,
            endColumn: pos.endColumn,
            module: context.module,
          });
          refIndexStack.push(refIndex);
        } else {
          refIndexStack.push(undefined);
        }
      } else {
        // Tag without id — skip pathStack push to avoid empty path segments.
        // hasIdStack tracks this so onclosetag knows not to pop.
        hasIdStack.push(false);
      }
    } else if (MODEL_TAGS[tagName]) {
      // source_model, backend_model, frontend_model — collect text content
      modelTagKind = MODEL_TAGS[tagName];
      collectingText = true;
      collectedText = '';
    } else if (tagName === 'label') {
      collectingLabel = true;
      collectingText = true;
      collectedText = '';
    } else if (tagName === 'resource' && pathStack.length > 0) {
      // <resource> inside a section — ACL resource ID text content
      collectingResource = true;
      collectingText = true;
      collectedText = '';
    }
  };

  parser.ontext = (text) => {
    if (collectingText) {
      collectedText += text;
    }
  };

  parser.oncdata = (cdata) => {
    if (collectingText) {
      collectedText += cdata;
    }
  };

  parser.onclosetag = (tagName) => {
    const name = tagName.toLowerCase();

    if (name === 'system' || name === 'include') {
      inContent = false;
      return;
    }

    if (collectingResource && name === 'resource') {
      // <resource>Magento_Newsletter::newsletter</resource> — ACL resource for the section
      const trimmed = collectedText.trim();
      if (trimmed) {
        const configPath = pathStack.join('/');
        const pos = findTextContentPosition(lines, currentTagStartLine, trimmed);
        if (pos) {
          references.push({
            kind: 'section-resource',
            configPath,
            aclResourceId: trimmed,
            file: context.file,
            line: pos.line,
            column: pos.column,
            endColumn: pos.endColumn,
            module: context.module,
          });
        }
      }
      collectingResource = false;
      collectingText = false;
      collectedText = '';
      return;
    }

    if (collectingLabel && name === 'label') {
      // Attach label to the most recent section/group/field reference
      const trimmedLabel = collectedText.trim();
      if (trimmedLabel && refIndexStack.length > 0) {
        const refIndex = refIndexStack[refIndexStack.length - 1];
        if (refIndex !== undefined && references[refIndex]) {
          references[refIndex].label = trimmedLabel;
        }
      }
      collectingLabel = false;
      collectingText = false;
      collectedText = '';
      return;
    }

    if (modelTagKind && MODEL_TAGS[name]) {
      const trimmed = collectedText.trim();
      if (trimmed) {
        const fqcn = normalizeFqcn(trimmed);
        const configPath = pathStack.join('/');
        const pos = findTextContentPosition(lines, currentTagStartLine, trimmed);
        if (pos) {
          references.push({
            kind: modelTagKind,
            configPath,
            fqcn,
            file: context.file,
            line: pos.line,
            column: pos.column,
            endColumn: pos.endColumn,
            module: context.module,
          });
        }
      }
      modelTagKind = undefined;
      collectingText = false;
      collectedText = '';
      return;
    }

    if (PATH_TAGS.has(name)) {
      const hadId = hasIdStack.pop();
      if (hadId) {
        pathStack.pop();
        refIndexStack.pop();
      }
    }
  };

  installErrorHandler(parser);

  parser.write(xmlContent).close();

  return { references };
}
