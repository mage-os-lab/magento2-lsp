import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { handleDefinition } from '../../src/handlers/definition';
import { ProjectManager, ProjectContext } from '../../src/project/projectManager';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('handleDefinition', () => {
  let project: ProjectContext;

  beforeAll(async () => {
    const pm = new ProjectManager();
    project = (await pm.ensureProject(FIXTURE_ROOT))!;
  });

  function getProject(filePath: string): ProjectContext | undefined {
    // All fixture files belong to the same project
    return project;
  }

  function makeParams(filePath: string, line: number, character: number) {
    return {
      textDocument: { uri: URI.file(filePath).toString() },
      position: { line, character },
    };
  }

  it('returns null for PHP files without magic method calls at cursor', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/Foo.php');
    const result = handleDefinition(makeParams(phpFile, 4, 6), getProject);
    expect(result).toBeNull();
  });

  // --- PHP magic method definition tests (CustomerSession.php) ---

  const customerSessionFile = path.join(
    FIXTURE_ROOT,
    'vendor/test/module-foo/Model/CustomerSession.php',
  );

  it('navigates from $this->storage->getData() to DataObject::getData', () => {
    // Line 22 (0-based): $customerId = $this->storage->getData('customer_id');
    // "getData" starts at col 38
    const result = handleDefinition(makeParams(customerSessionFile, 22, 40), getProject);
    expect(result).not.toBeNull();
    const loc = result as { uri: string; range: { start: { line: number; character: number } } };
    expect(URI.parse(loc.uri).fsPath).toContain('DataObject.php');
    // getData is declared at line 6
    expect(loc.range.start.line).toBe(6);
  });

  it('navigates from $this->storage->setData() to DataObject::setData', () => {
    // Line 16 (0-based): $this->storage->setData('customer_id', $id);
    // "setData" starts at col 24
    const result = handleDefinition(makeParams(customerSessionFile, 16, 26), getProject);
    expect(result).not.toBeNull();
    const loc = result as { uri: string; range: { start: { line: number; character: number } } };
    expect(URI.parse(loc.uri).fsPath).toContain('DataObject.php');
    // setData is declared at line 11
    expect(loc.range.start.line).toBe(11);
  });

  it('navigates from $this->sessionManager->getCustomerId() to SessionManager::__call', () => {
    // Line 28 (0-based): return $this->sessionManager->getCustomerId();
    // "getCustomerId" starts at col 38
    const result = handleDefinition(makeParams(customerSessionFile, 28, 40), getProject);
    expect(result).not.toBeNull();
    const loc = result as { uri: string; range: { start: { line: number; character: number } } };
    expect(URI.parse(loc.uri).fsPath).toContain('SessionManager.php');
    // __call is declared at line 10
    expect(loc.range.start.line).toBe(10);
  });

  it('returns null for $this->storage->init() (declared on StorageInterface)', () => {
    // Line 33 (0-based): $this->storage->init();
    // "init" starts at col 24
    const result = handleDefinition(makeParams(customerSessionFile, 33, 25), getProject);
    expect(result).toBeNull();
  });

  it('returns null for $this->sessionManager->start() (declared on SessionManager)', () => {
    // Line 34 (0-based): $this->sessionManager->start();
    // "start" starts at col 30
    const result = handleDefinition(makeParams(customerSessionFile, 34, 31), getProject);
    expect(result).toBeNull();
  });

  it('returns null when cursor is not on a reference', () => {
    const diXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
    // Line 0 is the XML declaration — no references there
    const result = handleDefinition(makeParams(diXml, 0, 0), getProject);
    expect(result).toBeNull();
  });

  it('navigates from preference type to PHP class', () => {
    const diXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
    // Line 2 has: <preference for="Test\Foo\Api\FooInterface" type="Test\Foo\Model\Foo" />
    // Find the 'type' attribute position — Test\Foo\Model\Foo
    const refs = project.index.getReferencesForFqcn('Test\\Foo\\Model\\Foo');
    const prefType = refs.find(
      (r) => r.kind === 'preference-type' && r.file === diXml,
    );
    expect(prefType).toBeDefined();

    const result = handleDefinition(
      makeParams(diXml, prefType!.line, prefType!.column),
      getProject,
    );
    expect(result).not.toBeNull();
    // Should point to the PHP file
    const loc = result as { uri: string; range: { start: { line: number } } };
    expect(URI.parse(loc.uri).fsPath).toContain('Foo.php');
  });

  it('navigates from preference for to effective implementation PHP class', () => {
    const diXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
    const refs = project.index.getReferencesForFqcn('Test\\Foo\\Api\\FooInterface');
    const prefFor = refs.find(
      (r) => r.kind === 'preference-for' && r.file === diXml,
    );
    expect(prefFor).toBeDefined();

    const result = handleDefinition(
      makeParams(diXml, prefFor!.line, prefFor!.column),
      getProject,
    );
    expect(result).not.toBeNull();
    const loc = result as { uri: string; range: { start: { line: number } } };
    // Should jump to the implementation class (Test\Foo\Model\Foo)
    expect(URI.parse(loc.uri).fsPath).toContain('Foo.php');
  });

  it('navigates from virtualType reference to its di.xml declaration', () => {
    const diXml = path.join(FIXTURE_ROOT, 'app/code/Custom/Bar/etc/di.xml');
    // Line 2 has: <virtualType name="CustomBarVirtual" type="Test\Foo\Model\Foo">
    const refs = project.index.getReferencesForFqcn('CustomBarVirtual');
    const vtRef = refs.find((r) => r.kind === 'virtualtype-name');
    expect(vtRef).toBeDefined();

    // Now simulate searching for CustomBarVirtual from another di.xml
    // In this fixture, CustomBarVirtual is only declared, not referenced elsewhere.
    // But we can test that getEffectiveVirtualType returns it
    const vt = project.index.getEffectiveVirtualType('CustomBarVirtual');
    expect(vt).toBeDefined();
    expect(vt!.parentType).toBe('Test\\Foo\\Model\\Foo');
  });
});
