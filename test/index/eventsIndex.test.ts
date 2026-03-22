import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { ProjectManager, ProjectContext } from '../../src/project/projectManager';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('EventsIndex', () => {
  let project: ProjectContext;

  beforeAll(async () => {
    const pm = new ProjectManager();
    project = (await pm.ensureProject(FIXTURE_ROOT))!;
  });

  it('indexes events.xml files', () => {
    expect(project.eventsIndex.getFileCount()).toBeGreaterThanOrEqual(1);
  });

  it('finds observers for a given event', () => {
    const observers = project.eventsIndex.getObserversForEvent('test_foo_save_after');
    expect(observers).toHaveLength(1);
    expect(observers[0].fqcn).toBe('Test\\Foo\\Observer\\FooSaveObserver');
    expect(observers[0].observerName).toBe('foo_save_observer');
  });

  it('finds multiple observers for the same event', () => {
    const observers = project.eventsIndex.getObserversForEvent('test_foo_load_after');
    expect(observers).toHaveLength(2);
    const fqcns = observers.map((o) => o.fqcn).sort();
    expect(fqcns).toEqual([
      'Custom\\Bar\\Observer\\BarLoadObserver',
      'Test\\Foo\\Observer\\FooLoadObserver',
    ]);
  });

  it('finds observer registrations by FQCN', () => {
    const refs = project.eventsIndex.getObserversForFqcn(
      'Test\\Foo\\Observer\\FooSaveObserver',
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].eventName).toBe('test_foo_save_after');
  });

  it('returns empty for unknown event', () => {
    expect(
      project.eventsIndex.getObserversForEvent('nonexistent_event'),
    ).toHaveLength(0);
  });

  it('returns empty for unknown FQCN', () => {
    expect(
      project.eventsIndex.getObserversForFqcn('Unknown\\Class'),
    ).toHaveLength(0);
  });

  it('finds event name references', () => {
    const refs = project.eventsIndex.getEventNameRefs('test_foo_save_after');
    expect(refs).toHaveLength(1);
    expect(refs[0].file).toContain('events.xml');
  });

  it('finds reference at cursor position', () => {
    const refs = project.eventsIndex.getEventNameRefs('test_foo_save_after');
    const eventRef = refs[0];

    const found = project.eventsIndex.getReferenceAtPosition(
      eventRef.file,
      eventRef.line,
      eventRef.column,
    );
    expect(found).toBeDefined();
    expect('eventName' in found!).toBe(true);
  });
});
