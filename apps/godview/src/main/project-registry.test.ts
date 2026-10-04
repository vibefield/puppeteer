import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalProjectRoot,
  createProjectRegistry,
  nextProjectSequence,
  parseProjectRegistry,
  projectIdentityStore,
  serializeProjectRegistry,
  type ProjectRecord,
} from './project-registry.js';

const directories: string[] = [];

function registryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'godview-projects-'));
  directories.push(directory);
  return join(directory, 'projects.json');
}

/** Folds like the workspace identity would: a worktree or a subfolder lands on its repository root. */
const fold = async (sourcePath: string): Promise<string> => {
  if (sourcePath.startsWith('/repos/puppeteer')) return '/repos/puppeteer';
  if (sourcePath.startsWith('/worktrees/puppeteer-')) return '/repos/puppeteer';
  return sourcePath;
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('project registry', () => {
  it('deals one sequence per canonical root, in first-seen order, and keeps it for life', async () => {
    const path = registryPath();
    const registry = createProjectRegistry(path, { resolveRoot: fold });
    const puppeteer = await registry.deal('/repos/puppeteer/apps/godview');
    const voyager = await registry.deal('/repos/voyager');
    expect(puppeteer).toEqual({ key: '/repos/puppeteer', name: 'puppeteer', seq: 0 });
    expect(voyager).toEqual({ key: '/repos/voyager', name: 'voyager', seq: 1 });
    // A worktree of the same repository is the same project, told apart by its branch, never by colour.
    expect(await registry.deal('/worktrees/puppeteer-ah-4')).toEqual(puppeteer);
    // The folded answer is now known without asking Git again.
    expect(registry.known('/repos/puppeteer/apps/godview')).toEqual(puppeteer);
    expect(registry.known('/repos/never-seen')).toBeUndefined();

    const reopened = createProjectRegistry(path, { resolveRoot: fold });
    expect(reopened.list().map(({ key, seq }) => ({ key, seq }))).toEqual([
      { key: '/repos/puppeteer', seq: 0 },
      { key: '/repos/voyager', seq: 1 },
    ]);
    expect(await reopened.deal('/repos/voyager')).toEqual(voyager);
    expect(await reopened.deal('/repos/study')).toMatchObject({ seq: 2 });
  });

  it('never re-deals a sequence, so a removed project moves nobody else', () => {
    const records: ProjectRecord[] = [
      { key: '/repos/a', name: 'a', seq: 0, firstSeenAt: '2026-09-11T00:00:00.000Z' },
      { key: '/repos/c', name: 'c', seq: 2, firstSeenAt: '2026-09-11T00:00:00.000Z' },
    ];
    expect(nextProjectSequence(records)).toBe(3);
    expect(nextProjectSequence([])).toBe(0);
  });

  it('shares one deal between agents that start at once in a new folder', async () => {
    const registry = createProjectRegistry(registryPath(), { resolveRoot: fold });
    const [first, second] = await Promise.all([registry.deal('/repos/puppeteer'), registry.deal('/repos/puppeteer')]);
    expect(first).toEqual(second);
    expect(registry.list()).toHaveLength(1);
  });

  it('folds a path that no longer exists to its absolute form instead of refusing a colour', async () => {
    const missing = join(tmpdir(), 'godview-projects-missing', 'folder');
    expect(await canonicalProjectRoot(missing)).toBe(missing);
  });

  it("rejects the deal when the caller's resolver fails, and stays usable for the next one", async () => {
    let failures = 1;
    const registry = createProjectRegistry(registryPath(), {
      resolveRoot: async (sourcePath) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('gone');
        }
        return sourcePath;
      },
    });
    await expect(registry.deal('/gone/folder')).rejects.toThrow('gone');
    expect(await registry.deal('/repos/voyager')).toMatchObject({ key: '/repos/voyager', seq: 0 });
  });

  it('reads tolerantly, dropping records it cannot verify and duplicate sequences', () => {
    const parsed = parseProjectRegistry({
      version: 1,
      projects: [
        { key: '/repos/b', name: 'b', seq: 1, firstSeenAt: '2026-09-11T00:00:00.000Z' },
        { key: '/repos/a', name: 'a', seq: 0, firstSeenAt: '2026-09-11T00:00:00.000Z' },
        { key: 'relative', name: 'x', seq: 2, firstSeenAt: '2026-09-11T00:00:00.000Z' },
        { key: '/repos/dup', name: 'dup', seq: 1, firstSeenAt: '2026-09-11T00:00:00.000Z' },
        { key: '/repos/bad-seq', name: 'bad', seq: -1, firstSeenAt: '2026-09-11T00:00:00.000Z' },
        { key: '/repos/bad-date', name: 'bad', seq: 3, firstSeenAt: 'yesterday' },
        'not a record',
      ],
    });
    expect(parsed.map((record) => record.key)).toEqual(['/repos/a', '/repos/b']);
    expect(parseProjectRegistry({ version: 2, projects: [] })).toEqual([]);
    expect(parseProjectRegistry(null)).toEqual([]);
  });

  it('starts empty on a corrupt file and writes the document back in sequence order', async () => {
    const path = registryPath();
    writeFileSync(path, '{ not json');
    const registry = createProjectRegistry(path, { resolveRoot: fold, now: () => new Date('2026-09-11T01:02:03Z') });
    expect(registry.list()).toEqual([]);
    await registry.deal('/repos/voyager');
    const written = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    expect(written).toEqual({
      version: 1,
      projects: [{ key: '/repos/voyager', name: 'voyager', seq: 0, firstSeenAt: '2026-09-11T01:02:03.000Z' }],
    });
    expect(serializeProjectRegistry(registry.list())).toBe(`${JSON.stringify(written, null, 2)}\n`);
  });
});

describe("the registry as the monitor backend's identity port (L4)", () => {
  it('answers a canonical root with the sequence the registry dealt, and keeps it across a reload', async () => {
    const path = registryPath();
    const registry = createProjectRegistry(path, { resolveRoot: fold });
    await registry.deal('/repos/voyager');
    const { key } = await registry.deal('/worktrees/puppeteer-feat');
    const identity = projectIdentityStore(registry);
    expect(key).toBe('/repos/puppeteer');
    expect(identity.seq('/repos/puppeteer')).toBe(1);
    expect(identity.deal('/repos/puppeteer')).toBe(1);
    expect(identity.seq('/repos/unknown')).toBeUndefined();
    expect(projectIdentityStore(createProjectRegistry(path, { resolveRoot: fold })).seq('/repos/puppeteer')).toBe(1);
  });

  it('deals a new key as a root at once, persisted, and never reuses a sequence', () => {
    const path = registryPath();
    const registry = createProjectRegistry(path, { resolveRoot: fold });
    const identity = projectIdentityStore(registry);
    expect(identity.deal('/repos/a')).toBe(0);
    expect(identity.deal('/repos/b')).toBe(1);
    expect(identity.deal('/repos/a')).toBe(0);
    expect(
      createProjectRegistry(path)
        .list()
        .map((project) => [project.key, project.seq]),
    ).toEqual([
      ['/repos/a', 0],
      ['/repos/b', 1],
    ]);
  });
});
