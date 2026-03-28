import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { resolveTemplate } from '../../src/templates/templateResolver';

// Track which files our mock fs "sees" as existing
let mockFiles: Map<string, string>;

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    readFileSync: (filePath: string, encoding: string) => {
      const content = mockFiles.get(path.normalize(filePath));
      if (content !== undefined) return content;
      // Fall through to real fs for built-in templates
      return (actual as any).readFileSync(filePath, encoding);
    },
  };
});

beforeEach(() => {
  mockFiles = new Map();
});

afterEach(() => {
  delete process.env.MAGENTO_LSP_TEMPLATES_DIR;
});

describe('resolveTemplate', () => {
  it('returns built-in template when no overrides configured', () => {
    const content = resolveTemplate('class.php.tpl');
    expect(content).toBeDefined();
    expect(content).toContain('{{namespace}}');
    expect(content).toContain('{{className}}');
  });

  it('returns built-in observer template', () => {
    const content = resolveTemplate('observer.php.tpl');
    expect(content).toBeDefined();
    expect(content).toContain('ObserverInterface');
    expect(content).toContain('{{className}}');
  });

  it('returns built-in phtml template', () => {
    const content = resolveTemplate('template.phtml.tpl');
    expect(content).toBeDefined();
    expect(content).toContain('<?php');
  });

  it('returns undefined for unknown template name', () => {
    const content = resolveTemplate('nonexistent.tpl');
    expect(content).toBeUndefined();
  });

  it('uses project-level override when provided', () => {
    const projectDir = '/my/project/templates';
    mockFiles.set(
      path.normalize(path.join(projectDir, 'class.php.tpl')),
      'PROJECT {{className}}',
    );

    const content = resolveTemplate('class.php.tpl', projectDir);
    expect(content).toBe('PROJECT {{className}}');
  });

  it('uses env var override when set', () => {
    const envDir = '/home/user/.magento-lsp-templates';
    process.env.MAGENTO_LSP_TEMPLATES_DIR = envDir;
    mockFiles.set(
      path.normalize(path.join(envDir, 'class.php.tpl')),
      'ENV {{className}}',
    );

    const content = resolveTemplate('class.php.tpl');
    expect(content).toBe('ENV {{className}}');
  });

  it('project override takes priority over env var', () => {
    const projectDir = '/my/project/templates';
    const envDir = '/home/user/.magento-lsp-templates';
    process.env.MAGENTO_LSP_TEMPLATES_DIR = envDir;

    mockFiles.set(
      path.normalize(path.join(projectDir, 'class.php.tpl')),
      'PROJECT {{className}}',
    );
    mockFiles.set(
      path.normalize(path.join(envDir, 'class.php.tpl')),
      'ENV {{className}}',
    );

    const content = resolveTemplate('class.php.tpl', projectDir);
    expect(content).toBe('PROJECT {{className}}');
  });

  it('falls back to env var when project dir does not have the template', () => {
    const projectDir = '/my/project/templates';
    const envDir = '/home/user/.magento-lsp-templates';
    process.env.MAGENTO_LSP_TEMPLATES_DIR = envDir;

    // Only env has the template, not project dir
    mockFiles.set(
      path.normalize(path.join(envDir, 'class.php.tpl')),
      'ENV {{className}}',
    );

    const content = resolveTemplate('class.php.tpl', projectDir);
    expect(content).toBe('ENV {{className}}');
  });

  it('falls back to built-in when env var dir does not have the template', () => {
    process.env.MAGENTO_LSP_TEMPLATES_DIR = '/some/empty/dir';

    const content = resolveTemplate('class.php.tpl');
    expect(content).toBeDefined();
    expect(content).toContain('{{namespace}}');
  });
});
