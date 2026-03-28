import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { Range } from 'vscode-languageserver';
import { handleInlayHint } from '../../src/handlers/inlayHint';
import { ProjectManager, ProjectContext } from '../../src/project/projectManager';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('handleInlayHint', () => {
  let project: ProjectContext;

  beforeAll(async () => {
    const pm = new ProjectManager();
    project = (await pm.ensureProject(FIXTURE_ROOT))!;
  });

  function getProject(): ProjectContext | undefined {
    return project;
  }

  /** Build InlayHintParams for the full file (line 0 to 9999). */
  function makeParams(filePath: string, startLine = 0, endLine = 9999) {
    return {
      textDocument: { uri: URI.file(filePath).toString() },
      range: Range.create(startLine, 0, endLine, 0),
    };
  }

  // --- Basic routing ---

  it('returns null for non-PHP/non-phtml files', () => {
    const diXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
    const result = handleInlayHint(makeParams(diXml), getProject);
    expect(result).toBeNull();
  });

  it('returns null for classes without plugins', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'app/code/Custom/Bar/Model/Bar.php');
    const result = handleInlayHint(makeParams(phpFile), getProject);
    expect(result).toBeNull();
  });

  // --- Plugin hints ---

  it('returns inlay hints with correct labels for plugin counts', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/Foo.php');
    const result = handleInlayHint(makeParams(phpFile), getProject);
    expect(result).not.toBeNull();

    // Should have the same content as codeLens: class-level + method-level + webapi
    const labels = result!.map((h) => h.label);
    expect(labels).toContain('1 plugin');
    expect(labels.filter((l) => l === '1 plugin')).toHaveLength(4); // class + 3 methods
  });

  it('returns inlay hints for plugin target methods', () => {
    const pluginFile = path.join(
      FIXTURE_ROOT,
      'app/code/Custom/Bar/Plugin/FooPlugin.php',
    );
    const result = handleInlayHint(makeParams(pluginFile), getProject);
    expect(result).not.toBeNull();

    const labels = result!.map((h) => h.label);
    expect(labels).toContain('→ Test\\Foo\\Api\\FooInterface::save');
    expect(labels).toContain('→ Test\\Foo\\Api\\FooInterface::getName');
    expect(labels).toContain('→ Test\\Foo\\Api\\FooInterface::load');
  });

  // --- Hint properties ---

  it('all hints have paddingLeft for visual separation', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/Foo.php');
    const result = handleInlayHint(makeParams(phpFile), getProject);
    expect(result).not.toBeNull();
    for (const hint of result!) {
      expect(hint.paddingLeft).toBe(true);
    }
  });

  it('all hints have a tooltip matching the label', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/Foo.php');
    const result = handleInlayHint(makeParams(phpFile), getProject);
    expect(result).not.toBeNull();
    for (const hint of result!) {
      expect(hint.tooltip).toBe(hint.label);
    }
  });

  // --- Range filtering ---

  it('filters hints to the requested range', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/Foo.php');

    // Full file — should have hints
    const allHints = handleInlayHint(makeParams(phpFile), getProject);
    expect(allHints).not.toBeNull();
    expect(allHints!.length).toBeGreaterThan(0);

    // Range covering only the first few lines (before any class/method declarations)
    const emptyRange = handleInlayHint(makeParams(phpFile, 0, 2), getProject);
    expect(emptyRange).toBeNull();
  });

  // --- Magic method hints ---

  it('shows magic method hints for interface-gap calls', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/CustomerSession.php');
    const result = handleInlayHint(makeParams(phpFile), getProject);
    expect(result).not.toBeNull();
    const labels = result!.map((h) => h.label);
    expect(labels).toContain('→ DataObject::getData');
    expect(labels).toContain('→ DataObject::setData');
  });

  it('shows __call hints for true magic method calls', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/CustomerSession.php');
    const result = handleInlayHint(makeParams(phpFile), getProject);
    expect(result).not.toBeNull();
    const labels = result!.map((h) => h.label);
    expect(labels).toContain('→ SessionManager::__call');
  });
});
