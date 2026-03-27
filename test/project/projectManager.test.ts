import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { ProjectManager } from '../../src/project/projectManager';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/magento-root');

describe('ProjectManager', () => {
  it('initializes a project from a Magento root', async () => {
    const pm = new ProjectManager();
    const project = await pm.ensureProject(FIXTURE_ROOT);
    expect(project).toBeDefined();
    expect(project!.root).toBe(FIXTURE_ROOT);
    expect(project!.indexingComplete).toBe(true);
  });

  it('returns the same project for files from the same root', async () => {
    const pm = new ProjectManager();
    await pm.ensureProject(FIXTURE_ROOT);

    const nestedFile = path.join(
      FIXTURE_ROOT,
      'vendor',
      'test',
      'module-foo',
      'Model',
      'Foo.php',
    );
    const project = pm.getProjectForFile(nestedFile);
    expect(project).toBeDefined();
    expect(project!.root).toBe(FIXTURE_ROOT);
  });

  it('returns undefined for files outside any Magento project', () => {
    const pm = new ProjectManager();
    expect(pm.getProjectForFile('/tmp/random/file.php')).toBeUndefined();
  });

  it('indexes di.xml files from the fixture', async () => {
    const pm = new ProjectManager();
    const project = await pm.ensureProject(FIXTURE_ROOT);
    expect(project!.index.getFileCount()).toBeGreaterThanOrEqual(3);
  });

  it('resolves references for classes in fixture di.xml files', async () => {
    const pm = new ProjectManager();
    const project = await pm.ensureProject(FIXTURE_ROOT);
    const refs = project!.index.getReferencesForFqcn('Test\\Foo\\Model\\Foo');
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  it('caches root detection across repeated lookups', async () => {
    const pm = new ProjectManager();
    await pm.ensureProject(FIXTURE_ROOT);

    const nestedFile = path.join(FIXTURE_ROOT, 'vendor', 'test', 'module-foo', 'Model', 'Foo.php');
    const result1 = pm.getProjectForFile(nestedFile);
    const result2 = pm.getProjectForFile(nestedFile);
    expect(result1).toBeDefined();
    expect(result2).toBe(result1);
  });

  it('returns undefined after removeProject purges cache', async () => {
    const pm = new ProjectManager();
    await pm.ensureProject(FIXTURE_ROOT);

    const nestedFile = path.join(FIXTURE_ROOT, 'vendor', 'test', 'module-foo', 'Model', 'Foo.php');
    expect(pm.getProjectForFile(nestedFile)).toBeDefined();

    pm.removeProject(FIXTURE_ROOT);
    expect(pm.getProjectForFile(nestedFile)).toBeUndefined();
  });

  it('reports progress during indexing', async () => {
    const pm = new ProjectManager();
    const events: string[] = [];
    await pm.ensureProject(FIXTURE_ROOT, {
      onBegin: (total) => events.push(`begin:${total}`),
      onProgress: (current, total) => events.push(`progress:${current}/${total}`),
      onEnd: () => events.push('end'),
    });
    expect(events[0]).toMatch(/^begin:\d+$/);
    expect(events[events.length - 1]).toBe('end');
    expect(events.filter((e) => e.startsWith('progress:')).length).toBeGreaterThan(0);
  });
});
