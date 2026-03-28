import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { handleDefinition } from '../../src/handlers/definition';
import { handleReferences } from '../../src/handlers/references';
import { handleCodeLens } from '../../src/handlers/codeLens';
import { ProjectManager, ProjectContext } from '../../src/project/projectManager';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('events.xml integration', () => {
  let project: ProjectContext;

  beforeAll(async () => {
    const pm = new ProjectManager();
    project = (await pm.ensureProject(FIXTURE_ROOT))!;
  });

  function getProject(): ProjectContext | undefined {
    return project;
  }
  function noDocText(): undefined { return undefined; }

  describe('definition', () => {
    it('navigates from observer instance in events.xml to PHP class', async () => {
      const eventsXml = path.join(
        FIXTURE_ROOT,
        'vendor/test/module-foo/etc/events.xml',
      );
      // Find the observer instance reference
      const observers = project.indexes.events.getObserversForEvent('test_foo_save_after');
      const obs = observers[0];

      const result = handleDefinition(
        {
          textDocument: { uri: URI.file(eventsXml).toString() },
          position: { line: obs.line, character: obs.column },
        },
        getProject, noDocText,
      );
      expect(result).not.toBeNull();
      const loc = result as { uri: string };
      expect(URI.parse(loc.uri).fsPath).toContain('FooSaveObserver.php');
    });
  });

  describe('references', () => {
    it('from event name in events.xml shows all observers', async () => {
      const eventsXml = path.join(
        FIXTURE_ROOT,
        'vendor/test/module-foo/etc/events.xml',
      );
      const eventRefs = project.indexes.events.getEventNameRefs('test_foo_load_after');
      const eventRef = eventRefs[0];

      const result = await handleReferences(
        {
          textDocument: { uri: URI.file(eventsXml).toString() },
          position: { line: eventRef.line, character: eventRef.column },
          context: { includeDeclaration: true },
        },
        getProject, noDocText,
      );
      expect(result).not.toBeNull();
      // test_foo_load_after has 2 observers
      expect(result!).toHaveLength(2);
    });

    it('from observer instance in events.xml shows all registrations for that class', async () => {
      const eventsXml = path.join(
        FIXTURE_ROOT,
        'vendor/test/module-foo/etc/events.xml',
      );
      const observers = project.indexes.events.getObserversForEvent('test_foo_save_after');
      const obs = observers[0];

      const result = await handleReferences(
        {
          textDocument: { uri: URI.file(eventsXml).toString() },
          position: { line: obs.line, character: obs.column },
          context: { includeDeclaration: true },
        },
        getProject, noDocText,
      );
      expect(result).not.toBeNull();
      expect(result!.length).toBeGreaterThanOrEqual(1);
    });

    it('from PHP observer class declaration shows events.xml refs', async () => {
      const phpFile = path.join(
        FIXTURE_ROOT,
        'vendor/test/module-foo/Observer/FooSaveObserver.php',
      );
      // Line 7 (0-based): "class FooSaveObserver implements ObserverInterface"
      // class name at col 6
      const result = await handleReferences(
        {
          textDocument: { uri: URI.file(phpFile).toString() },
          position: { line: 7, character: 6 },
          context: { includeDeclaration: true },
        },
        getProject, noDocText,
      );
      expect(result).not.toBeNull();
      // Should include the events.xml observer registration
      const xmlResults = result!.filter((r) =>
        URI.parse(r.uri).fsPath.endsWith('events.xml'),
      );
      expect(xmlResults.length).toBeGreaterThanOrEqual(1);
    });

    it('from observer execute() method shows events.xml refs', async () => {
      const phpFile = path.join(
        FIXTURE_ROOT,
        'vendor/test/module-foo/Observer/FooSaveObserver.php',
      );
      // Line 9 (0-based): "    public function execute(Observer $observer): void {}"
      // "execute" at col 20
      const result = await handleReferences(
        {
          textDocument: { uri: URI.file(phpFile).toString() },
          position: { line: 9, character: 20 },
          context: { includeDeclaration: true },
        },
        getProject, noDocText,
      );
      expect(result).not.toBeNull();
      expect(result!.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('codeLens', () => {
    it('shows event name on observer execute() method', async () => {
      const phpFile = path.join(
        FIXTURE_ROOT,
        'vendor/test/module-foo/Observer/FooSaveObserver.php',
      );
      const result = handleCodeLens(
        { textDocument: { uri: URI.file(phpFile).toString() } },
        getProject, noDocText,
      );
      expect(result).not.toBeNull();
      const titles = result!.map((l) => l.command?.title);
      expect(titles).toContain('→ test_foo_save_after');
    });
  });
});
