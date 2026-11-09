import { execFile } from 'node:child_process';
import { statSync, watch, type FSWatcher } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { AgentGitState } from '@vibefield/puppeteer-core';

const execFileAsync = promisify(execFile);
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const WATCHER_TOPOLOGY_REFRESH_MS = 5 * 60_000;
/** Bound on the attach → verify → re-attach loop when refs keep moving underneath it. */
const WATCHER_ATTACH_ATTEMPTS = 3;

async function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Git reports paths with forward slashes on every platform, Windows included,
 * so its output never matches a Node-derived path byte-for-byte until it is
 * rewritten to the platform separator. `resolve` does that and anchors the
 * relative forms `--git-path` can return, so it replaces the absolute check.
 */
function fromGitPath(cwd: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  return resolve(cwd, value);
}

/** Resolve branch/head facts for any directory, including worktrees, unborn branches, and detached HEADs. */
export async function resolveGitState(cwd: string): Promise<AgentGitState | null> {
  const metadata = await git(cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
  const [toplevel, gitDir, commonDir] = metadata?.split(/\r?\n/) ?? [];
  if (!toplevel) return null;
  // `root` is public in AgentGitState, so it must carry platform separators
  // like every other path the runtime hands out.
  const root = resolve(cwd, toplevel);

  const [branch, headSha] = await Promise.all([
    git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(cwd, ['rev-parse', '--verify', 'HEAD']),
  ]);
  const absoluteGitDir = fromGitPath(cwd, gitDir);
  const absoluteCommonDir = fromGitPath(cwd, commonDir);
  const [canonicalGitDir, canonicalCommonDir] = await Promise.all([
    absoluteGitDir ? realpath(absoluteGitDir).catch(() => absoluteGitDir) : undefined,
    absoluteCommonDir ? realpath(absoluteCommonDir).catch(() => absoluteCommonDir) : undefined,
  ]);

  return {
    root,
    branch: branch ?? null,
    headSha: headSha ?? null,
    detached: branch === undefined && headSha !== undefined,
    ...(canonicalGitDir && canonicalCommonDir ? { worktree: canonicalGitDir !== canonicalCommonDir } : {}),
  };
}

export interface GitStateObserver {
  setCwd(cwd: string): void;
  refresh(): void;
  stop(): void;
}

export interface GitStateObserverOptions {
  cwd: string;
  onChange: (state: AgentGitState | null) => void;
  onError?: (error: Error) => void;
  pollIntervalMs?: number;
}

const stableState = (state: AgentGitState | null): string => JSON.stringify(state);

/** What a path is, for planning watches; `undefined` when it is missing or unreachable. */
export type GitPathProbe = (path: string) => 'file' | 'directory' | undefined;

/** The paths one `git rev-parse` names for a watch plan, each resolved against the observed cwd. */
export interface GitWatchPaths {
  gitDir: string;
  commonDir: string;
  headPath: string;
  /** The branch ref HEAD points at; absent when HEAD is detached. */
  branchPath?: string | undefined;
  packedRefsPath: string;
}

/** One fs.watch target. A `name` watch is a directory heard only for the entry of that name. */
export interface PlannedWatch {
  target: string;
  name?: string;
}

const isStrictlyInside = (directory: string, path: string): boolean => {
  const fromDirectory = relative(directory, path);
  return (
    fromDirectory !== '' &&
    fromDirectory !== '..' &&
    !fromDirectory.startsWith(`..${sep}`) &&
    !isAbsolute(fromDirectory)
  );
};

/**
 * The files whose change can move what an observer reports, and nothing busier. Exported for its tests; the
 * package index does not export it.
 *
 * - HEAD, when it is a file.
 * - The branch ref HEAD points at, when it is a file. While it is not (an unborn branch, or a ref that lives only in
 *   packed-refs), its directory, heard only for the ref's own name, so a fresh repository's first commit is seen at
 *   once and a session does not wake for other branches. Only a DIRECTORY strictly inside `<commonDir>/refs/`: a
 *   reftable repository's refs/heads is a file, and a nested branch whose directory does not exist yet is the poll's.
 * - packed-refs only when it exists, never its parent: its appearance (pack-refs, gc) moves no ref.
 * - reftable's tables.list, best effort: the common stack's and, in a linked worktree, the worktree's own (its HEAD
 *   among its refs). reftable rewrites tables.list on every ref update.
 *
 * No target is ever the git directory or the common directory: git makes and renames index.lock there on every
 * status, add and commit by any agent or editor. Such an entry is dropped, never thrown.
 */
export function planGitWatches(paths: GitWatchPaths, probe: GitPathProbe): PlannedWatch[] {
  const planned: PlannedWatch[] = [];
  if (probe(paths.headPath) === 'file') planned.push({ target: paths.headPath });
  if (paths.branchPath !== undefined) {
    const parent = dirname(paths.branchPath);
    if (probe(paths.branchPath) === 'file') planned.push({ target: paths.branchPath });
    else if (isStrictlyInside(join(paths.commonDir, 'refs'), parent) && probe(parent) === 'directory') {
      planned.push({ target: parent, name: basename(paths.branchPath) });
    }
  }
  if (probe(paths.packedRefsPath) === 'file') planned.push({ target: paths.packedRefsPath });
  const tableLists = [join(paths.commonDir, 'reftable', 'tables.list')];
  if (paths.gitDir !== paths.commonDir) tableLists.push(join(paths.gitDir, 'reftable', 'tables.list'));
  for (const tableList of tableLists) if (probe(tableList) === 'file') planned.push({ target: tableList });
  return planned.filter(({ target }) => target !== paths.gitDir && target !== paths.commonDir);
}

/** A `name` watch hears only its own entry; an event that names nothing is relevant. Exported for its tests. */
export function isRelevantWatchEvent(planned: PlannedWatch, filename: string | null): boolean {
  return planned.name === undefined || filename === null || filename === planned.name;
}

const probeGitPath: GitPathProbe = (path) => {
  try {
    const stats = statSync(path);
    if (stats.isFile()) return 'file';
    if (stats.isDirectory()) return 'directory';
  } catch {
    // Missing, or behind something that is not a directory: nothing to watch there.
  }
  return undefined;
};

/**
 * Watches the files that carry a repository's HEAD and branch, and polls as the correctness fallback. The watches
 * (`planGitWatches`): HEAD; the branch ref, or its directory heard only for the ref's name while the ref has no loose
 * file; packed-refs when it exists; reftable's tables.list. A missing packed-refs is never watched through its
 * parent: that parent is the git directory, the busiest one git has (index.lock on every status, add and commit), and
 * packed-refs appearing moves no ref. The poll covers what the plan leaves out or a watcher misses: a nested branch
 * whose directory does not exist yet, an atomic replacement between rebuilds, network filesystems, and a repository
 * created after observation begins.
 */
export function createGitStateObserver(options: GitStateObserverOptions): GitStateObserver {
  let cwd = resolve(options.cwd);
  let generation = 0;
  let stopped = false;
  let running = false;
  let queued = false;
  let last: string | undefined;
  let watchers: FSWatcher[] = [];
  let watchersInitialized = false;
  let watcherTopologyDirty = true;
  let watcherTopologyRefreshedAt = 0;

  const clearWatchers = (): void => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
  };

  const schedule = (): void => {
    if (stopped) return;
    if (running) {
      queued = true;
      return;
    }
    void refreshNow();
  };

  const scheduleFromWatcher = (): void => {
    // Git commonly replaces refs atomically. Rebuild after a real filesystem
    // event so the observer remains attached to the replacement inode.
    watcherTopologyDirty = true;
    schedule();
  };

  const watchPlanned = (planned: PlannedWatch): void => {
    try {
      const watcher = watch(planned.target, { persistent: false }, (_event, filename) => {
        if (isRelevantWatchEvent(planned, filename)) scheduleFromWatcher();
      });
      watcher.on('error', scheduleFromWatcher);
      watchers.push(watcher);
    } catch {
      // The poller remains the correctness fallback.
    }
  };

  const rebuildWatchers = async (observedCwd: string, observedGeneration: number): Promise<boolean> => {
    const branchRef = await git(observedCwd, ['symbolic-ref', '--quiet', 'HEAD']);
    // `--git-dir`, not `--absolute-git-dir`: at the top level it is spelled as --git-common-dir and --git-path are,
    // where the absolute form is canonicalized (macOS's /var tmpdir reads /private/var there). Below the top level
    // --git-dir alone is absolute and canonical, so a cwd under a symlink still reads gitDir ≠ commonDir: that costs
    // one extra tables.list candidate, and in a reftable repository one duplicate watch, nothing else.
    const gitPaths = await git(observedCwd, [
      'rev-parse',
      '--git-dir',
      '--git-common-dir',
      '--git-path',
      'HEAD',
      '--git-path',
      'packed-refs',
      ...(branchRef ? ['--git-path', branchRef] : []),
    ]);
    const answers = (gitPaths?.split(/\r?\n/) ?? []).map((path) => fromGitPath(observedCwd, path));
    const [gitDir, commonDir, headPath, packedRefsPath, branchPath] = answers;
    if (stopped || generation !== observedGeneration) return false;
    clearWatchers();
    if (gitDir && commonDir && headPath && packedRefsPath) {
      const paths: GitWatchPaths = { gitDir, commonDir, headPath, branchPath, packedRefsPath };
      for (const planned of planGitWatches(paths, probeGitPath)) watchPlanned(planned);
    }
    return true;
  };

  async function refreshNow(): Promise<void> {
    running = true;
    const observedGeneration = generation;
    const observedCwd = cwd;
    try {
      let state = await resolveGitState(observedCwd);
      if (stopped || generation !== observedGeneration) return;
      // A new branch means a different ref file to watch.
      if (stableState(state) !== last) watcherTopologyDirty = true;

      // Attach before announcing. A consumer that reacts to onChange by moving
      // HEAD would otherwise land its change in the gap between "observed" and
      // "watching" and stay invisible until the next poll. Re-resolving after
      // each attach closes the same gap for refs that move mid-attach.
      for (let attempt = 0; attempt < WATCHER_ATTACH_ATTEMPTS; attempt += 1) {
        const topologyStale = Date.now() - watcherTopologyRefreshedAt >= WATCHER_TOPOLOGY_REFRESH_MS;
        if (watchersInitialized && !watcherTopologyDirty && !topologyStale) break;
        watcherTopologyDirty = false;
        if (!(await rebuildWatchers(observedCwd, observedGeneration))) return;
        watchersInitialized = true;
        watcherTopologyRefreshedAt = Date.now();

        const attached = await resolveGitState(observedCwd);
        if (stopped || generation !== observedGeneration) return;
        if (stableState(attached) === stableState(state)) break;
        // The ref moved while we were attaching to it; the watchers may be on
        // replaced inodes, so rebuild against the state we are about to report.
        state = attached;
        watcherTopologyDirty = true;
      }

      const serialized = stableState(state);
      if (serialized !== last) {
        last = serialized;
        options.onChange(state);
      }
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      running = false;
      if (queued && !stopped) {
        queued = false;
        schedule();
      }
    }
  }

  // fs.watch is the fast path. Poll slowly as a correctness fallback for
  // network filesystems, missed atomic replacements, and repositories created
  // after observation begins.
  const poller = setInterval(schedule, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  poller.unref?.();
  schedule();

  return {
    setCwd(nextCwd) {
      const normalized = resolve(nextCwd);
      if (normalized === cwd) return;
      cwd = normalized;
      generation += 1;
      last = undefined;
      clearWatchers();
      watchersInitialized = false;
      watcherTopologyDirty = true;
      watcherTopologyRefreshedAt = 0;
      schedule();
    },
    refresh: schedule,
    stop() {
      if (stopped) return;
      stopped = true;
      generation += 1;
      clearInterval(poller);
      clearWatchers();
    },
  };
}

export interface GitObserverPoolOptions {
  pollIntervalMs?: number | undefined;
}

export interface GitObserverPool {
  /** Join the shared observer for `cwd`. The handle moves, refreshes and leaves this subscriber alone. */
  observe(options: Omit<GitStateObserverOptions, 'pollIntervalMs'>): GitStateObserver;
}

interface GitObserverSubscriber {
  onChange: (state: AgentGitState | null) => void;
  onError?: ((error: Error) => void) | undefined;
}

interface SharedGitObserver {
  observer: GitStateObserver;
  subscribers: Set<GitObserverSubscriber>;
  state: { resolved: false } | { resolved: true; value: AgentGitState | null };
}

/**
 * One git observer per repository cwd, shared by every subscriber there: the runtime's sessions in one checkout
 * hold one set of watches and one poll, not one each. Exported for the runtime; the package index does not export
 * it.
 *
 * The key is the resolved cwd, not the git directory: two worktrees of one repository report different roots and
 * branches. Two spellings of one directory (a symlink) get two observers, which is harmless. A subscriber that joins
 * an observer which has already resolved hears that state on a microtask, never inside its own join, and only if it
 * is still joined then; the observer itself announces only changes. An observer stops when its last subscriber
 * leaves.
 */
export function createGitObserverPool(options: GitObserverPoolOptions = {}): GitObserverPool {
  const shared = new Map<string, SharedGitObserver>();

  const fail = (subscriber: GitObserverSubscriber, error: unknown): void => {
    try {
      subscriber.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // One subscriber's fault stays out of the others' deliveries.
    }
  };

  const deliver = (subscriber: GitObserverSubscriber, state: AgentGitState | null): void => {
    try {
      subscriber.onChange(state);
    } catch (error) {
      fail(subscriber, error);
    }
  };

  const open = (key: string): SharedGitObserver => {
    const entry: SharedGitObserver = {
      subscribers: new Set(),
      state: { resolved: false },
      observer: createGitStateObserver({
        cwd: key,
        ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
        // The observer resolves asynchronously, so `entry` is assigned before either callback can run.
        onChange: (state) => {
          entry.state = { resolved: true, value: state };
          for (const subscriber of [...entry.subscribers]) {
            if (entry.subscribers.has(subscriber)) deliver(subscriber, state);
          }
        },
        onError: (error) => {
          for (const subscriber of [...entry.subscribers]) {
            if (entry.subscribers.has(subscriber)) fail(subscriber, error);
          }
        },
      }),
    };
    shared.set(key, entry);
    return entry;
  };

  return {
    observe(subscription) {
      const subscriber: GitObserverSubscriber = { onChange: subscription.onChange, onError: subscription.onError };
      let joined: { key: string; entry: SharedGitObserver } | undefined;

      const enter = (cwd: string): void => {
        const key = resolve(cwd);
        const entry = shared.get(key) ?? open(key);
        entry.subscribers.add(subscriber);
        const membership = { key, entry };
        joined = membership;
        const known = entry.state;
        if (!known.resolved) return;
        // A newer announcement before this microtask has already reached the subscriber, and a subscriber that has
        // left (or left and come back) by then hears nothing from this join.
        queueMicrotask(() => {
          if (joined === membership && entry.state === known) deliver(subscriber, known.value);
        });
      };

      const leave = (): void => {
        if (!joined) return;
        const { key, entry } = joined;
        joined = undefined;
        entry.subscribers.delete(subscriber);
        if (entry.subscribers.size > 0) return;
        if (shared.get(key) === entry) shared.delete(key);
        entry.observer.stop();
      };

      enter(subscription.cwd);
      return {
        setCwd(nextCwd) {
          if (!joined || resolve(nextCwd) === joined.key) return;
          leave();
          enter(nextCwd);
        },
        refresh() {
          joined?.entry.observer.refresh();
        },
        stop: leave,
      };
    },
  };
}
