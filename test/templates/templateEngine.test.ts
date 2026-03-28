import { describe, it, expect } from 'vitest';
import { renderTemplate, buildTemplateVariables, TemplateVariables } from '../../src/templates/templateEngine';

function makeVars(overrides: Partial<TemplateVariables> = {}): TemplateVariables {
  return {
    namespace: 'Vendor\\Module\\Model',
    className: 'MyClass',
    fqcn: 'Vendor\\Module\\Model\\MyClass',
    moduleName: 'Vendor_Module',
    year: '2026',
    date: '2026-03-28',
    ...overrides,
  };
}

describe('renderTemplate', () => {
  it('replaces all known variables', () => {
    const template = '{{namespace}} {{className}} {{fqcn}} {{moduleName}} {{year}} {{date}}';
    const result = renderTemplate(template, makeVars());
    expect(result).toBe(
      'Vendor\\Module\\Model MyClass Vendor\\Module\\Model\\MyClass Vendor_Module 2026 2026-03-28',
    );
  });

  it('preserves backslashes in namespace values', () => {
    const template = 'namespace {{namespace}};';
    const result = renderTemplate(template, makeVars());
    expect(result).toBe('namespace Vendor\\Module\\Model;');
  });

  it('leaves unknown placeholders unchanged', () => {
    const template = '{{namespace}} {{unknownVar}}';
    const result = renderTemplate(template, makeVars());
    expect(result).toBe('Vendor\\Module\\Model {{unknownVar}}');
  });

  it('handles template with no placeholders', () => {
    const result = renderTemplate('no placeholders here', makeVars());
    expect(result).toBe('no placeholders here');
  });

  it('handles multiple occurrences of the same variable', () => {
    const template = '{{className}} and {{className}}';
    const result = renderTemplate(template, makeVars());
    expect(result).toBe('MyClass and MyClass');
  });

  it('handles empty template', () => {
    const result = renderTemplate('', makeVars());
    expect(result).toBe('');
  });

  it('renders a realistic PHP class template', () => {
    const template = `<?php

declare(strict_types=1);

namespace {{namespace}};

class {{className}}
{
}
`;
    const result = renderTemplate(template, makeVars());
    expect(result).toContain('namespace Vendor\\Module\\Model;');
    expect(result).toContain('class MyClass');
  });
});

describe('buildTemplateVariables', () => {
  it('splits FQCN into namespace and class name', () => {
    const vars = buildTemplateVariables('Vendor\\Module\\Model\\MyClass', 'Vendor_Module');
    expect(vars.namespace).toBe('Vendor\\Module\\Model');
    expect(vars.className).toBe('MyClass');
    expect(vars.fqcn).toBe('Vendor\\Module\\Model\\MyClass');
    expect(vars.moduleName).toBe('Vendor_Module');
  });

  it('handles FQCN with no namespace separator', () => {
    const vars = buildTemplateVariables('SimpleClass', 'Test_Module');
    expect(vars.namespace).toBe('');
    expect(vars.className).toBe('SimpleClass');
  });

  it('handles deeply nested namespace', () => {
    const vars = buildTemplateVariables(
      'Vendor\\Module\\Model\\ResourceModel\\Product\\Collection',
      'Vendor_Module',
    );
    expect(vars.namespace).toBe('Vendor\\Module\\Model\\ResourceModel\\Product');
    expect(vars.className).toBe('Collection');
  });

  it('sets year and date from current time', () => {
    const vars = buildTemplateVariables('A\\B', 'A_B');
    expect(vars.year).toMatch(/^\d{4}$/);
    expect(vars.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
