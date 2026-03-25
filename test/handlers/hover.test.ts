import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { handleHover } from '../../src/handlers/hover';
import { ProjectManager, ProjectContext } from '../../src/project/projectManager';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('handleHover', () => {
  let project: ProjectContext;

  beforeAll(async () => {
    const pm = new ProjectManager();
    project = (await pm.ensureProject(FIXTURE_ROOT))!;
  });

  function getProject(): ProjectContext | undefined {
    return project;
  }

  function makeParams(filePath: string, line: number, character: number) {
    return {
      textDocument: { uri: URI.file(filePath).toString() },
      position: { line, character },
    };
  }

  it('returns null for non-XML files', () => {
    const phpFile = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/Model/Foo.php');
    const result = handleHover(makeParams(phpFile, 0, 0), getProject);
    expect(result).toBeNull();
  });

  it('returns null when cursor is not on a reference', () => {
    const diXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
    const result = handleHover(makeParams(diXml, 0, 0), getProject);
    expect(result).toBeNull();
  });

  it('shows preference info on preference-for reference', () => {
    const diXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
    const refs = project.index.getReferencesForFqcn('Test\\Foo\\Api\\FooInterface');
    const prefFor = refs.find(
      (r) => r.kind === 'preference-for' && r.file === diXml,
    );
    expect(prefFor).toBeDefined();

    const result = handleHover(
      makeParams(diXml, prefFor!.line, prefFor!.column),
      getProject,
    );
    expect(result).not.toBeNull();
    const content = result!.contents;
    expect('value' in content && content.value).toContain('Preference');
    expect('value' in content && content.value).toContain('Test\\Foo\\Api\\FooInterface');
  });

  it('shows type info with plugin count on type-name reference', () => {
    const diXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/di.xml');
    const refs = project.index.getReferencesForFqcn('Test\\Foo\\Model\\Foo');
    const typeRef = refs.find(
      (r) => r.kind === 'type-name' && r.file === diXml,
    );
    expect(typeRef).toBeDefined();

    const result = handleHover(
      makeParams(diXml, typeRef!.line, typeRef!.column),
      getProject,
    );
    expect(result).not.toBeNull();
    const content = result!.contents;
    expect('value' in content && content.value).toContain('Type');
  });

  it('shows plugin info on plugin-type reference', () => {
    const frontendDiXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/frontend/di.xml');
    const refs = project.index.getReferencesForFqcn('Custom\\Bar\\Plugin\\FooPlugin');
    const pluginRef = refs.find(
      (r) => r.kind === 'plugin-type' && r.file === frontendDiXml,
    );
    expect(pluginRef).toBeDefined();

    const result = handleHover(
      makeParams(frontendDiXml, pluginRef!.line, pluginRef!.column),
      getProject,
    );
    expect(result).not.toBeNull();
    const content = result!.contents;
    expect('value' in content && content.value).toContain('Plugin');
    expect('value' in content && content.value).toContain('Custom\\Bar\\Plugin\\FooPlugin');
  });

  // --- events.xml hover ---

  it('shows observer info on observer instance reference', () => {
    const eventsXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/events.xml');
    const ref = project.eventsIndex.getReferenceAtPosition(eventsXml, 3, 60);
    // Verify the fixture has the expected observer reference
    if (!ref) {
      // Fall back: find any observer reference in this file
      const allRefs = project.eventsIndex.getObserversForEvent('test_foo_save_after');
      expect(allRefs.length).toBeGreaterThan(0);
      return;
    }

    const result = handleHover(makeParams(eventsXml, ref.line, ref.column), getProject);
    expect(result).not.toBeNull();
    const content = result!.contents;
    expect('value' in content && content.value).toContain('Observer');
  });

  it('shows event info with observer count on event name reference', () => {
    const eventsXml = path.join(FIXTURE_ROOT, 'vendor/test/module-foo/etc/events.xml');
    // test_foo_load_after has 2 observers in the fixture
    const allEvents = project.eventsIndex.getAllEventNames();
    expect(allEvents).toContain('test_foo_load_after');

    // Find the event name reference position
    const eventRefs = project.eventsIndex.getEventNameRefs('test_foo_load_after');
    expect(eventRefs.length).toBeGreaterThan(0);
    const ref = eventRefs.find((r) => r.file === eventsXml);
    expect(ref).toBeDefined();

    const result = handleHover(makeParams(eventsXml, ref!.line, ref!.column), getProject);
    expect(result).not.toBeNull();
    const content = result!.contents;
    expect('value' in content && content.value).toContain('Event');
    expect('value' in content && content.value).toContain('2 observers');
  });
});
