import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGitState } from '@vibefield/puppeteer-core';

/** Every fs.watch the observer opens, by target, with how many times it was closed. */
const watches = vi.hoisted(() => [] as Array<{ target: string; closes: number }>);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  type Watcher = ReturnType<typeof actual.watch>;
  const watch = (...args: unknown[]): Watcher => {
    const watcher = (actual.watch as (...watchArgs: unknown[]) => Watcher)(...args);
    const record = { target: String(args[0]), closes: 0 };
    watches.push(record);
    const close = watcher.close.bind(watcher);
    watcher.close = () => {
      record.closes += 1;
      close();
    };
    return watcher;
  };
  return { ...actual, watch };
});

import {
  createGitObserverPool,
  createGitStateObserver,
  isRelevantWatchEvent,
  planGitWatches,
  resolveGitState,
  type GitStateObserver,
  type PlannedWatch,
} from './git.js';

const execFileAsync = promisify(execFile);

async function run(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args]);
}

async function commit(cwd: string, message: string, ...args: string[]): Promise<void> {
  await run(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', ...args, '-m', message);
}

async function repo(commitFirst = true): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'puppeteer-git-observer-'));
  // The watch rows below are about loose refs; an older git ignores the key.
  await run(cwd, '-c', 'init.defaultRefFormat=files', 'init', '-b', 'main');
  if (commitFirst) {
    await writeFile(join(cwd, 'README.md'), 'hello\n');
    await run(cwd, 'add', '.');
    await commit(cwd, 'initial');
  }
  return cwd;
}

const liveTargets = (): string[] =>
  watches
    .filter((watch) => watch.closes === 0)
    .map((watch) => watch.target)
    .sort();

const microtask = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

beforeEach(() => {
  watches.length = 0;
});

describe('resolveGitState', () => {
  it('resolves nested cwd, branch, head, detached state, and non-repositories', async () => {
    const cwd = await repo();
    const nested = join(cwd, 'nested');
    await mkdir(nested);
    const onBranch = await resolveGitState(nested);
    expect(onBranch).toMatchObject({ root: await realpath(cwd), branch: 'main', detached: false, worktree: false });
    expect(onBranch?.headSha).toMatch(/^[0-9a-f]{40,64}$/);

    await run(cwd, 'checkout', '--detach');
    expect(await resolveGitState(cwd)).toMatchObject({ root: await realpath(cwd), branch: null, detached: true });

    const outside = await mkdtemp(join(tmpdir(), 'puppeteer-not-git-'));
    expect(await resolveGitState(outside)).toBeNull();
  });

  it('represents an unborn branch without incorrectly calling it detached', async () => {
    const cwd = await repo(false);
    expect(await resolveGitState(cwd)).toMatchObject({
      root: await realpath(cwd),
      branch: 'main',
      headSha: null,
      detached: false,
    });
  });

  it('identifies linked worktrees while resolving their own root and branch', async () => {
    const main = await repo();
    const worktrees = await mkdtemp(join(tmpdir(), 'puppeteer-git-worktrees-'));
    const linked = join(worktrees, 'linked');
    await run(main, 'worktree', 'add', '-b', 'feature/linked', linked);

    expect(await resolveGitState(linked)).toMatchObject({
      root: await realpath(linked),
      branch: 'feature/linked',
      detached: false,
      worktree: true,
    });
  });
});

describe('createGitStateObserver', () => {
  it('observes branch changes and can rebind to another cwd', async () => {
    const first = await repo();
    const second = await repo();
    await run(second, 'checkout', '-b', 'feature');
    const values: Array<string | null> = [];
    let wake: (() => void) | undefined;
    const changed = (): Promise<void> => new Promise((resolve) => (wake = resolve));
    const observer = createGitStateObserver({
      cwd: first,
      // Keep fallback polling out of the test: the branch transition below
      // must be delivered by the Git ref/HEAD watchers.
      pollIntervalMs: 60_000,
      onChange: (state) => {
        values.push(state?.branch ?? null);
        wake?.();
        wake = undefined;
      },
    });
    try {
      await changed();
      expect(values.at(-1)).toBe('main');
      const watched = changed();
      await run(first, 'checkout', '-b', 'watched');
      await watched;
      expect(values.at(-1)).toBe('watched');

      const rebound = changed();
      observer.setCwd(second);
      await rebound;
      expect(values.at(-1)).toBe('feature');
    } finally {
      observer.stop();
    }
  });

  it('delivers a branch change made the instant the first state is announced', async () => {
    const cwd = await repo();
    const branches: Array<string | null> = [];
    let wake: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => (wake = resolve));
    // The strict form of the attach race: the consumer moves HEAD from inside
    // onChange, so any window between observing and watching loses the event
    // until the (disabled) poller would have caught it.
    const observer = createGitStateObserver({
      cwd,
      pollIntervalMs: 60_000,
      onChange: (state) => {
        branches.push(state?.branch ?? null);
        if (branches.length === 1) void run(cwd, 'checkout', '-b', 'reactive');
        else wake?.();
      },
    });
    try {
      await settled;
      expect(branches).toEqual(['main', 'reactive']);
    } finally {
      observer.stop();
    }
  });

  it('never watches the git directory, even when packed-refs is absent', async () => {
    const cwd = await repo();
    expect(existsSync(join(cwd, '.git', 'packed-refs'))).toBe(false);
    const heads: Array<string | null> = [];
    let wake: (() => void) | undefined;
    const changed = (): Promise<void> => new Promise((resolve) => (wake = resolve));
    const observer = createGitStateObserver({
      cwd,
      // The commit below must reach onChange through the HEAD and branch-ref watchers alone.
      pollIntervalMs: 60_000,
      onChange: (state) => {
        heads.push(state?.headSha ?? null);
        wake?.();
        wake = undefined;
      },
    });
    try {
      await changed();
      expect(liveTargets()).toEqual([join(cwd, '.git', 'HEAD'), join(cwd, '.git', 'refs', 'heads', 'main')].sort());

      const committed = changed();
      await commit(cwd, 'next', '--allow-empty');
      await committed;
      expect(heads).toHaveLength(2);
      expect(heads[1]).toMatch(/^[0-9a-f]{40,64}$/);
      expect(heads[1]).not.toBe(heads[0]);
      expect(liveTargets()).not.toContain(join(cwd, '.git'));
    } finally {
      observer.stop();
    }
  });

  it("watches an unborn branch's directory for its own name and still sees the first commit", async () => {
    const cwd = await repo(false);
    const heads: Array<string | null> = [];
    let wake: (() => void) | undefined;
    const changed = (): Promise<void> => new Promise((resolve) => (wake = resolve));
    const observer = createGitStateObserver({
      cwd,
      pollIntervalMs: 60_000,
      onChange: (state) => {
        heads.push(state?.headSha ?? null);
        wake?.();
        wake = undefined;
      },
    });
    try {
      await changed();
      expect(heads).toEqual([null]);
      expect(liveTargets()).toEqual([join(cwd, '.git', 'HEAD'), join(cwd, '.git', 'refs', 'heads')].sort());

      const born = changed();
      await writeFile(join(cwd, 'README.md'), 'hello\n');
      await run(cwd, 'add', '.');
      await commit(cwd, 'initial');
      await born;
      expect(heads.at(-1)).toMatch(/^[0-9a-f]{40,64}$/);
      expect(liveTargets()).not.toContain(join(cwd, '.git'));
    } finally {
      observer.stop();
    }
  });
});

describe('planGitWatches', () => {
  const gitDir = resolve(sep, 'repo', '.git');
  const head = join(gitDir, 'HEAD');
  const heads = join(gitDir, 'refs', 'heads');
  const main = join(heads, 'main');
  const packedRefs = join(gitDir, 'packed-refs');
  const loose = { gitDir, commonDir: gitDir, headPath: head, branchPath: main, packedRefsPath: packedRefs };
  const probe = (entries: Record<string, 'file' | 'directory'>) => (path: string) => entries[path];

  it('gives a missing packed-refs no entry, never its parent', () => {
    const plan = planGitWatches(
      loose,
      probe({ [head]: 'file', [main]: 'file', [heads]: 'directory', [gitDir]: 'directory' }),
    );
    expect(plan).toEqual([{ target: head }, { target: main }]);
  });

  it('watches packed-refs itself when it exists', () => {
    const plan = planGitWatches(loose, probe({ [head]: 'file', [main]: 'file', [packedRefs]: 'file' }));
    expect(plan).toEqual([{ target: head }, { target: main }, { target: packedRefs }]);
  });

  it("gives a missing branch ref under refs/heads its parent, filtered to the ref's name", () => {
    const plan = planGitWatches(loose, probe({ [head]: 'file', [heads]: 'directory' }));
    expect(plan).toEqual([{ target: head }, { target: heads, name: 'main' }]);
  });

  it('gives a missing nested parent no watch: the poll covers it', () => {
    const nested = join(heads, 'feat', 'x');
    const plan = planGitWatches({ ...loose, branchPath: nested }, probe({ [head]: 'file', [heads]: 'directory' }));
    expect(plan).toEqual([{ target: head }]);
  });

  it('gives a refs/heads that is a file (reftable) no watch, and watches tables.list', () => {
    const tables = join(gitDir, 'reftable', 'tables.list');
    const plan = planGitWatches(loose, probe({ [head]: 'file', [heads]: 'file', [tables]: 'file' }));
    expect(plan).toEqual([{ target: head }, { target: tables }]);
  });

  it("watches a linked worktree's own tables.list beside the common one", () => {
    const worktreeDir = join(gitDir, 'worktrees', 'linked');
    const worktreeHead = join(worktreeDir, 'HEAD');
    const commonTables = join(gitDir, 'reftable', 'tables.list');
    const worktreeTables = join(worktreeDir, 'reftable', 'tables.list');
    const plan = planGitWatches(
      { ...loose, gitDir: worktreeDir, headPath: worktreeHead },
      probe({ [worktreeHead]: 'file', [commonTables]: 'file', [worktreeTables]: 'file' }),
    );
    expect(plan).toEqual([{ target: worktreeHead }, { target: commonTables }, { target: worktreeTables }]);
  });

  it('drops a target equal to the git directory or the common directory', () => {
    const commonDir = resolve(sep, 'common', '.git');
    const plan = planGitWatches(
      { gitDir, commonDir, headPath: gitDir, branchPath: join(commonDir, 'main'), packedRefsPath: commonDir },
      probe({ [gitDir]: 'file', [commonDir]: 'file' }),
    );
    expect(plan).toEqual([]);
  });

  it('lets a filtered watch through only for its own name, or an event that names nothing', () => {
    const planned: PlannedWatch = { target: heads, name: 'main' };
    expect(isRelevantWatchEvent(planned, 'index.lock')).toBe(false);
    expect(isRelevantWatchEvent(planned, 'main.lock')).toBe(false);
    expect(isRelevantWatchEvent(planned, 'main')).toBe(true);
    expect(isRelevantWatchEvent(planned, null)).toBe(true);
    expect(isRelevantWatchEvent({ target: head }, 'HEAD.lock')).toBe(true);
  });
});

describe('createGitObserverPool', () => {
  it('shares one observer per cwd, replays its state to a joiner, and stops it with the last subscriber', async () => {
    const cwd = await repo();
    const head = join(cwd, '.git', 'HEAD');
    const pool = createGitObserverPool({ pollIntervalMs: 60_000 });
    const firstStates: Array<AgentGitState | null> = [];
    let wake: (() => void) | undefined;
    const resolved = new Promise<void>((resolve) => (wake = resolve));
    const first = pool.observe({
      cwd,
      onChange: (state) => {
        firstStates.push(state);
        wake?.();
      },
    });
    const secondStates: Array<AgentGitState | null> = [];
    let secondWake: (() => void) | undefined;
    let second: GitStateObserver | undefined;
    try {
      await resolved;
      expect(firstStates).toEqual([expect.objectContaining({ branch: 'main' })]);

      second = pool.observe({
        cwd,
        onChange: (state) => {
          secondStates.push(state);
          secondWake?.();
        },
      });
      // Never synchronously inside its own join.
      expect(secondStates).toEqual([]);
      const goneStates: Array<AgentGitState | null> = [];
      const gone = pool.observe({ cwd, onChange: (state) => goneStates.push(state) });
      gone.stop();
      await microtask();
      expect(secondStates).toEqual([firstStates[0]]);
      expect(goneStates).toEqual([]);
      expect(firstStates).toHaveLength(1);
      expect(liveTargets().filter((target) => target === head)).toHaveLength(1);

      second.setCwd(cwd);
      second.setCwd(`${cwd}${sep}`);
      second.setCwd(join(cwd, 'nested', '..'));
      await microtask();
      // One key however it is spelled: no rejoin to replay, and (below) no second observer holding HEAD.
      expect(secondStates).toHaveLength(1);
      const checkedOut = new Promise<void>((resolve) => (secondWake = resolve));
      await run(cwd, 'checkout', '-b', 'moved');
      await checkedOut;
      expect(firstStates.map((state) => state?.branch)).toEqual(['main', 'moved']);
      expect(secondStates.map((state) => state?.branch)).toEqual(['main', 'moved']);
      expect(liveTargets().filter((target) => target === head)).toHaveLength(1);

      first.stop();
      expect(liveTargets()).toContain(head);
      second.stop();
      expect(liveTargets()).toEqual([]);
      expect(watches.length).toBeGreaterThan(0);
      expect(watches.every((watch) => watch.closes === 1)).toBe(true);
    } finally {
      first.stop();
      second?.stop();
    }
  });

  it('moves a subscriber between repositories and hears the new one', async () => {
    const first = await repo();
    const second = await repo();
    await run(second, 'checkout', '-b', 'feature');
    const pool = createGitObserverPool({ pollIntervalMs: 60_000 });
    const branches: Array<string | null> = [];
    let wake: (() => void) | undefined;
    const changed = (): Promise<void> => new Promise((resolve) => (wake = resolve));
    const onChange = (state: AgentGitState | null): void => {
      branches.push(state?.branch ?? null);
      wake?.();
      wake = undefined;
    };
    const held = pool.observe({ cwd: second, onChange: () => undefined });
    const moving = pool.observe({ cwd: first, onChange });
    try {
      await changed();
      expect(branches).toEqual(['main']);
      const moved = changed();
      moving.setCwd(second);
      await moved;
      expect(branches).toEqual(['main', 'feature']);
      // The first repository had one subscriber: its observer stopped with the move.
      expect(liveTargets().some((target) => target.startsWith(join(first, '.git')))).toBe(false);
    } finally {
      moving.stop();
      held.stop();
    }
    expect(liveTargets()).toEqual([]);
  });
});
