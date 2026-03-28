import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { handleCodeLens } from '../../src/handlers/codeLens';
import { ProjectManager, ProjectContext } from '../../src/project/projectManager';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('handleCodeLens', () => {
  let project: ProjectContext;

  beforeAll(async () => {
    const pm = new ProjectManager();
    project = (await pm.ensureProject(FIXTURE_ROOT))!;
  });

  function getProject(): ProjectContext | undefined {
    return project;
  }

  function makeParams(filePath: string) {
    return {
      textDocument: { uri: URI.file(filePath).toString() },
    };
  }

  it('returns null for non-PHP files', () => {
    const diXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
    const result = handleCodeLens(makeParams(diXml), getProject);
    expect(result).toBeNull();
  });

  it('returns null for classes without plugins', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'app/code/Custom/Bar/Model/Bar.php');
    const result = handleCodeLens(makeParams(phpFile), getProject);
    expect(result).toBeNull();
  });

  it('returns class-level code lens with unique plugin count', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/Foo.php');
    const result = handleCodeLens(makeParams(phpFile), getProject);
    expect(result).not.toBeNull();
    // First lens should be on the class declaration
    const classLens = result![0];
    // All 3 interceptions come from one <plugin> declaration = 1 unique plugin
    expect(classLens.command?.title).toBe('1 plugin');
    expect(classLens.range.start.line).toBe(6); // "class Foo" line (0-based)
  });

  it('returns method-level code lenses for intercepted methods', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/Foo.php');
    const result = handleCodeLens(makeParams(phpFile), getProject);
    expect(result).not.toBeNull();
    // Should have class lens + 3 plugin method lenses (save, getName, load) + 1 webapi lens on save
    expect(result!).toHaveLength(5);

    // Plugin method lenses (skip first which is class-level)
    const pluginLenses = result!.slice(1).filter((l) => l.command?.title.endsWith('plugin'));
    expect(pluginLenses).toHaveLength(3);
    // Webapi lens
    const webapiLenses = result!.filter((l) => l.command?.title.startsWith('POST'));
    expect(webapiLenses).toHaveLength(1);
  });

  it('does not show code lens for non-intercepted methods', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/Foo.php');
    const result = handleCodeLens(makeParams(phpFile), getProject);
    // "delete" method has no plugins — should not get a lens
    const lines = result!.map((l) => l.range.start.line);
    // Line 11 (0-based) is "public function delete()" — should not be in the list
    expect(lines).not.toContain(11);
  });

  it('shows plugin target on plugin before/after/around methods', () => {
    const pluginFile = path.join(
      FIXTURE_ROOT,
      'app/code/Custom/Bar/Plugin/FooPlugin.php',
    );
    const result = handleCodeLens(makeParams(pluginFile), getProject);
    expect(result).not.toBeNull();
    // 3 methods: beforeSave, afterGetName, aroundLoad
    expect(result!).toHaveLength(3);

    const titles = result!.map((l) => l.command?.title);
    expect(titles).toContain('→ Test\\Foo\\Api\\FooInterface::save');
    expect(titles).toContain('→ Test\\Foo\\Api\\FooInterface::getName');
    expect(titles).toContain('→ Test\\Foo\\Api\\FooInterface::load');
  });

  it('returns null for classes that are neither targets nor plugins nor have magic calls', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'app/code/Custom/Bar/Model/Bar.php');
    const result = handleCodeLens(makeParams(phpFile), getProject);
    expect(result).toBeNull();
  });

  // --- Magic method code lenses ---

  it('shows → DataObject::getData for interface-gap method calls', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/CustomerSession.php');
    const result = handleCodeLens(makeParams(phpFile), getProject);
    expect(result).not.toBeNull();
    const titles = result!.map((l) => l.command?.title);
    // $this->storage->getData('customer_id') — StorageInterface has no getData,
    // but Storage extends DataObject which declares getData
    expect(titles).toContain('→ DataObject::getData');
    expect(titles).toContain('→ DataObject::setData');
  });

  it('shows → SessionManager::__call for true magic method calls', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/CustomerSession.php');
    const result = handleCodeLens(makeParams(phpFile), getProject);
    expect(result).not.toBeNull();
    const titles = result!.map((l) => l.command?.title);
    // $this->sessionManager->getCustomerId() — SessionManager has __call
    expect(titles).toContain('→ SessionManager::__call');
  });

  it('does not show magic method lens for methods declared on the interface', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/CustomerSession.php');
    const result = handleCodeLens(makeParams(phpFile), getProject);
    expect(result).not.toBeNull();
    const titles = result!.map((l) => l.command?.title);
    // $this->storage->init() — init is declared on StorageInterface, no lens needed
    expect(titles).not.toContain('→ Storage::init');
    // $this->sessionManager->start() — start is declared on SessionManager, no lens needed
    expect(titles).not.toContain('→ SessionManager::start');
  });
});
