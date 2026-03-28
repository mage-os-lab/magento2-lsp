import { describe, it, expect } from 'vitest';
import { getXmlContextAtPosition, XmlContext } from '../../src/utils/xmlContext';

/**
 * Helper: given XML text with a `|` pipe character marking the cursor position,
 * parse out the text (with `|` removed) and the cursor line/col, then call
 * getXmlContextAtPosition.
 */
function contextAt(textWithCursor: string): XmlContext | undefined {
  const lines = textWithCursor.split('\n');
  let cursorLine = -1;
  let cursorCol = -1;

  for (let i = 0; i < lines.length; i++) {
    const pipeIdx = lines[i].indexOf('|');
    if (pipeIdx !== -1) {
      cursorLine = i;
      cursorCol = pipeIdx;
      // Remove the pipe from this line
      lines[i] = lines[i].substring(0, pipeIdx) + lines[i].substring(pipeIdx + 1);
      break;
    }
  }

  if (cursorLine === -1) {
    throw new Error('Test text must contain a | character to mark cursor position');
  }

  const text = lines.join('\n');
  return getXmlContextAtPosition(text, cursorLine, cursorCol);
}

describe('getXmlContextAtPosition', () => {

  // =========================================================================
  // Attribute value detection
  // =========================================================================
  describe('attribute value detection', () => {

    it('detects cursor at end of partial attribute value', () => {
      const ctx = contextAt('<preference for="Test|"/>');
      expect(ctx).toBeDefined();
      expect(ctx!.kind).toBe('attribute-value');
      expect(ctx!.elementName).toBe('preference');
      expect(ctx!.attributeName).toBe('for');
      expect(ctx!.partialValue).toBe('Test');
    });

    it('detects cursor in empty attribute value', () => {
      const ctx = contextAt('<preference for="|"/>');
      expect(ctx).toBeDefined();
      expect(ctx!.kind).toBe('attribute-value');
      expect(ctx!.elementName).toBe('preference');
      expect(ctx!.attributeName).toBe('for');
      expect(ctx!.partialValue).toBe('');
    });

    it('detects cursor with full FQCN partial', () => {
      const ctx = contextAt('<preference for="Test\\Foo\\Bar|"/>');
      expect(ctx).toBeDefined();
      expect(ctx!.kind).toBe('attribute-value');
      expect(ctx!.attributeName).toBe('for');
      expect(ctx!.partialValue).toBe('Test\\Foo\\Bar');
    });

    it('detects correct attribute when multiple attributes present', () => {
      const ctx = contextAt('<block class="My\\Block" template="Module::path|.phtml"/>');
      expect(ctx).toBeDefined();
      expect(ctx!.kind).toBe('attribute-value');
      expect(ctx!.elementName).toBe('block');
      expect(ctx!.attributeName).toBe('template');
      expect(ctx!.partialValue).toBe('Module::path');
    });

    it('detects attribute in self-closing tag', () => {
      const ctx = contextAt('<preference for="Test" type="Impl|"/>');
      expect(ctx).toBeDefined();
      expect(ctx!.kind).toBe('attribute-value');
      expect(ctx!.elementName).toBe('preference');
      expect(ctx!.attributeName).toBe('type');
      expect(ctx!.partialValue).toBe('Impl');
    });

    it('detects cursor at start of non-empty value', () => {
      const ctx = contextAt('<preference for="|Test\\Foo"/>');
      expect(ctx).toBeDefined();
      expect(ctx!.kind).toBe('attribute-value');
      expect(ctx!.partialValue).toBe('');
    });

    it('handles single-quoted attribute values', () => {
      const ctx = contextAt("<preference for='Test|'/>");
      expect(ctx).toBeDefined();
      expect(ctx!.kind).toBe('attribute-value');
      expect(ctx!.attributeName).toBe('for');
      expect(ctx!.partialValue).toBe('Test');
    });

    it('provides correct valueRange for attribute value', () => {
      //                   0123456789012345678901
      const ctx = contextAt('<preference for="Test|"/>');
      expect(ctx).toBeDefined();
      expect(ctx!.valueRange.line).toBe(0);
      expect(ctx!.valueRange.startCol).toBe(17); // after the opening "
      expect(ctx!.valueRange.endCol).toBe(21);   // before the closing "
    });

    it('provides correct valueRange for empty attribute value', () => {
      const ctx = contextAt('<preference for="|"/>');
      expect(ctx).toBeDefined();
      expect(ctx!.valueRange.startCol).toBe(17);
      expect(ctx!.valueRange.endCol).toBe(17);
    });

    it('detects xsi:type on the same element', () => {
      const ctx = contextAt('<argument xsi:type="object" name="|test"/>');
      expect(ctx).toBeDefined();
      expect(ctx!.xsiType).toBe('object');
    });
  });

  // =========================================================================
  // Multi-line tag detection
  // =========================================================================
  describe('multi-line tags', () => {

    it('finds element name on a previous line', () => {
      const xml = [
        '<preference',
        '    for="Test|"',
        '/>',
      ].join('\n');
      const ctx = contextAt(xml);
      expect(ctx).toBeDefined();
      expect(ctx!.kind).toBe('attribute-value');
      expect(ctx!.elementName).toBe('preference');
      expect(ctx!.attributeName).toBe('for');
      expect(ctx!.partialValue).toBe('Test');
    });

    it('finds element name several lines above', () => {
      const xml = [
        '<block',
        '    class="My\\Block"',
        '    template="Module::path|.phtml"',
        '/>',
      ].join('\n');
      const ctx = contextAt(xml);
      expect(ctx).toBeDefined();
      expect(ctx!.elementName).toBe('block');
      expect(ctx!.attributeName).toBe('template');
    });
  });

  // =========================================================================
  // Text content detection
  // =========================================================================
  describe('text content detection', () => {

    it('detects cursor in text content with xsi:type="object"', () => {
      const ctx = contextAt('<argument xsi:type="object">Some\\Class|</argument>');
      expect(ctx).toBeDefined();
      expect(ctx!.kind).toBe('text-content');
      expect(ctx!.elementName).toBe('argument');
      expect(ctx!.xsiType).toBe('object');
      expect(ctx!.partialValue).toBe('Some\\Class');
    });

    it('detects cursor in source_model text content', () => {
      const ctx = contextAt('<source_model>Some\\Model|</source_model>');
      expect(ctx).toBeDefined();
      expect(ctx!.kind).toBe('text-content');
      expect(ctx!.elementName).toBe('source_model');
      expect(ctx!.partialValue).toBe('Some\\Model');
    });

    it('detects cursor in aclResource text content', () => {
      const ctx = contextAt('<aclResource>Vendor_Module::resource|</aclResource>');
      expect(ctx).toBeDefined();
      expect(ctx!.kind).toBe('text-content');
      expect(ctx!.elementName).toBe('aclResource');
      expect(ctx!.partialValue).toBe('Vendor_Module::resource');
    });

    it('detects empty text content', () => {
      const ctx = contextAt('<argument xsi:type="object">|</argument>');
      expect(ctx).toBeDefined();
      expect(ctx!.kind).toBe('text-content');
      expect(ctx!.elementName).toBe('argument');
      expect(ctx!.partialValue).toBe('');
    });

    it('handles multi-line text content', () => {
      const xml = [
        '<argument xsi:type="object">',
        '    Some\\Class|',
        '</argument>',
      ].join('\n');
      const ctx = contextAt(xml);
      expect(ctx).toBeDefined();
      expect(ctx!.kind).toBe('text-content');
      expect(ctx!.elementName).toBe('argument');
      expect(ctx!.xsiType).toBe('object');
      expect(ctx!.partialValue).toBe('Some\\Class');
    });
  });

  // =========================================================================
  // Parent element detection
  // =========================================================================
  describe('parent element detection', () => {

    it('finds parent element for nested argument', () => {
      const xml = [
        '<type name="My\\Type">',
        '    <arguments>',
        '        <argument xsi:type="object" name="dep">Some\\Class|</argument>',
        '    </arguments>',
        '</type>',
      ].join('\n');
      const ctx = contextAt(xml);
      expect(ctx).toBeDefined();
      expect(ctx!.elementName).toBe('argument');
      expect(ctx!.parentElementName).toBe('arguments');
    });

    it('finds parent for attribute value context', () => {
      const xml = [
        '<type name="My\\Type">',
        '    <plugin name="my_plugin" type="My\\Plugin|"/>',
        '</type>',
      ].join('\n');
      const ctx = contextAt(xml);
      expect(ctx).toBeDefined();
      expect(ctx!.kind).toBe('attribute-value');
      expect(ctx!.elementName).toBe('plugin');
      expect(ctx!.parentElementName).toBe('type');
    });

    it('returns undefined parent for root-level element', () => {
      const ctx = contextAt('<preference for="Test|"/>');
      expect(ctx).toBeDefined();
      expect(ctx!.parentElementName).toBeUndefined();
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  describe('edge cases', () => {

    it('returns undefined when cursor is in a tag name', () => {
      const ctx = contextAt('<prefer|ence for="Test"/>');
      expect(ctx).toBeUndefined();
    });

    it('returns undefined when cursor is in an attribute name', () => {
      const ctx = contextAt('<preference fo|r="Test"/>');
      expect(ctx).toBeUndefined();
    });

    it('returns undefined when cursor is outside tags', () => {
      const ctx = contextAt('  |  ');
      expect(ctx).toBeUndefined();
    });

    it('returns undefined when cursor is in an XML comment', () => {
      const ctx = contextAt('<!-- some |comment -->');
      expect(ctx).toBeUndefined();
    });

    it('returns undefined when cursor is in a multi-line comment', () => {
      const xml = [
        '<!--',
        '  some |comment',
        '-->',
      ].join('\n');
      const ctx = contextAt(xml);
      expect(ctx).toBeUndefined();
    });

    it('returns undefined when cursor is in CDATA', () => {
      const ctx = contextAt('<![CDATA[ some |data ]]>');
      expect(ctx).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      const result = getXmlContextAtPosition('', 0, 0);
      expect(result).toBeUndefined();
    });

    it('returns undefined for invalid line number', () => {
      const result = getXmlContextAtPosition('<preference for="test"/>', 5, 0);
      expect(result).toBeUndefined();
    });

    it('handles tag with namespace prefix', () => {
      const ctx = contextAt('<xsi:argument type="obj|ect"/>');
      expect(ctx).toBeDefined();
      expect(ctx!.elementName).toBe('xsi:argument');
    });

    it('handles attribute value with closing tag on same line', () => {
      const xml = '<argument xsi:type="object">Test|</argument>';
      const ctx = contextAt(xml);
      expect(ctx).toBeDefined();
      expect(ctx!.kind).toBe('text-content');
      expect(ctx!.partialValue).toBe('Test');
    });
  });

  // =========================================================================
  // Nested element handling
  // =========================================================================
  describe('nested elements', () => {

    it('does not confuse child closing tags with parent', () => {
      const xml = [
        '<type name="My\\Type">',
        '    <arguments>',
        '        <argument xsi:type="string" name="a">val</argument>',
        '        <argument xsi:type="object" name="b">|</argument>',
        '    </arguments>',
        '</type>',
      ].join('\n');
      const ctx = contextAt(xml);
      expect(ctx).toBeDefined();
      expect(ctx!.kind).toBe('text-content');
      expect(ctx!.elementName).toBe('argument');
      expect(ctx!.xsiType).toBe('object');
    });

    it('skips self-closing siblings when finding parent', () => {
      const xml = [
        '<type name="My\\Type">',
        '    <plugin name="a" type="A\\Plugin"/>',
        '    <plugin name="b" type="B\\Plugin|"/>',
        '</type>',
      ].join('\n');
      const ctx = contextAt(xml);
      expect(ctx).toBeDefined();
      expect(ctx!.elementName).toBe('plugin');
      expect(ctx!.parentElementName).toBe('type');
    });
  });
});
