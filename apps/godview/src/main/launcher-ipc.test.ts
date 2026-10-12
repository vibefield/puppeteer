import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentInstallation, AgentLaunchProvider, AgentProfile } from '@vibefield/puppeteer-core';
import type { OwnActionRecord } from '@vibefield/puppeteer-record';
import type { HistorySearchStatus } from '../protocol.js';
import type { HistoryListedSession, HistoryProject, HistorySearchService } from './history-search.js';
import {
  NOT_A_GODVIEW,
  createLauncherService,
  gitRootsOf,
  isWithin,
  lastLaunchedByProvider,
  launcherAgents,
  launcherHistoryStatus,
  launcherSessions,
  parseLauncherRecentRequest,
  parseResumeNativeSessionRequest,
  physicalPath,
  registerLauncherIpc,
  resolveLauncherProject,
  type LauncherFs,
  type LauncherServiceOptions,
} from './launcher-ipc.js';

/**
 * A file system of named directories and files; everything else is absent.
 * `links` maps a symlinked prefix to where it points.
 */
function fakeFs(
  directories: readonly string[],
  files: Record<string, string> = {},
  links: Record<string, string> = {},
): LauncherFs {
  const dirs = new Set(directories.map((path) => resolve(path)));
  const contentsByPath = Object.fromEntries(Object.entries(files).map(([path, contents]) => [resolve(path), contents]));
  const targets = Object.entries(links).map(([link, target]) => [resolve(link), resolve(target)] as const);
  const physical = (given: string): string => {
    const path = resolve(given);
    for (const [link, target] of targets) {
      if (path === link || path.startsWith(`${link}${sep}`)) return target + path.slice(link.length);
    }
    return path;
  };
  return {
    isDirectory: async (path) => dirs.has(physical(path)),
    isFile: async (path) => physical(path) in contentsByPath,
    read: async (path) => {
      const contents = contentsByPath[physical(path)];
      if (contents === undefined) throw new Error(`ENOENT: ${path}`);
      return contents;
    },
    realpath: async (path) => {
      const real = physical(path);
      if (!dirs.has(real) && !(real in contentsByPath)) throw new Error(`ENOENT: ${path}`);
      return real;
    },
  };
}

const PROVIDERS: AgentLaunchProvider[] = [
  { id: 'alpha', label: 'Alpha', resume: true, historyKinds: ['alpha-code'] },
  { id: 'beta', label: 'Beta', resume: false, historyKinds: ['beta'] },
  { id: 'gamma', label: 'Gamma', resume: true, historyKinds: ['gamma'] },
  { id: 'wire', label: 'Wire', resume: true },
];

function profile(id: string, provider: string, label: string, dataRoot: string): AgentProfile {
  return { id, provider, label, kind: 'managed', dataRoot, createdAt: '2026-09-01T00:00:00.000Z' } as AgentProfile;
}

function installation(provider: string, active: boolean): AgentInstallation {
  return { provider, active } as AgentInstallation;
}

function allocated(providerId: string, observedAt: string, recordId = `${providerId}:${observedAt}`): OwnActionRecord {
  return {
    schemaVersion: 2,
    recordId,
    runtimeRunId: `run-${recordId}`,
    runtimeEpoch: 1,
    observedAt,
    quality: 'exact',
    completeness: 'complete',
    evidence: [],
    type: 'run.allocated',
    providerId,
    operation: 'create',
    externalRefs: [],
  } as OwnActionRecord;
}

function listed(id: string, extra: Partial<HistoryListedSession> = {}): HistoryListedSession {
  return { id, nativeSessionId: `native-${id}`, runtimeId: 'rt-alpha', updatedAt: 5_000, ...extra };
}

const READY: HistorySearchStatus = {
  reachable: true,
  canonicalReady: true,
  readiness: 'ready',
  checkedAt: '2026-09-28T00:00:00.000Z',
};

describe('project resolution (QL-D9)', () => {
  it('finds the git root of a folder, and a worktree’s repository through its commondir', async () => {
    const repo = fakeFs(['/w/app', '/w/app/.git', '/w/app/src']);
    expect(await gitRootsOf('/w/app/src/deep', repo)).toEqual([resolve('/w/app')]);
    const worktree = fakeFs(['/w/app', '/w/app/.git', '/w/app/.git/worktrees/feat', '/w/lanes/feat'], {
      '/w/lanes/feat/.git': 'gitdir: /w/app/.git/worktrees/feat\n',
      '/w/app/.git/worktrees/feat/commondir': '../..\n',
    });
    expect(await gitRootsOf('/w/lanes/feat/pkg', worktree)).toEqual([resolve('/w/lanes/feat'), resolve('/w/app')]);
    expect(await gitRootsOf('/tmp/loose', fakeFs([]))).toEqual([]);
  });

  it('keeps a worktree whose repository moved as its own root', async () => {
    const orphan = fakeFs(['/w/lanes/feat'], { '/w/lanes/feat/.git': 'gitdir: /gone/.git/worktrees/feat' });
    expect(await gitRootsOf('/w/lanes/feat', orphan)).toEqual([resolve('/w/lanes/feat')]);
  });

  const projects: HistoryProject[] = [
    { id: 'p-app', name: 'app', rootPaths: ['/w/app'] },
    { id: 'p-w', name: 'w', rootPaths: ['/w'] },
    { id: 'p-docs', name: 'docs', rootPaths: ['/w/app/docs/'] },
  ];

  it('prefers the project holding the git root, reaching a worktree’s repository when the worktree is unlisted', async () => {
    const worktree = fakeFs(['/w/app', '/w/app/.git', '/w/app/.git/worktrees/feat'], {
      '/w/lanes/feat/.git': 'gitdir: /w/app/.git/worktrees/feat',
      '/w/app/.git/worktrees/feat/commondir': '../..',
    });
    expect((await resolveLauncherProject('/w/lanes/feat/src', projects, worktree))?.id).toBe('p-app');
    const repo = fakeFs(['/w/app/.git']);
    // The git root wins over a longer root path the folder also lies under.
    expect((await resolveLauncherProject('/w/app/docs/guide', projects, repo))?.id).toBe('p-app');
  });

  it('outside a repository takes only a project rooted exactly at the folder — never the longest root above it', async () => {
    const none = fakeFs([]);
    expect((await resolveLauncherProject('/w/app/docs', projects, none))?.id).toBe('p-docs');
    expect((await resolveLauncherProject('/w/app/docs/', projects, none))?.id).toBe('p-docs');
    // Rosetta roots a project at every non-repository cwd, home usually among
    // them: a folder under one is not that project's.
    expect(await resolveLauncherProject('/w/app/docs/guide', projects, none)).toBeUndefined();
    expect(await resolveLauncherProject('/w/other', projects, none)).toBeUndefined();
    const home: HistoryProject = { id: 'p-home', name: 'j', rootPaths: ['/Users/j'] };
    expect(await resolveLauncherProject('/Users/j/scratch', [home], none)).toBeUndefined();
    expect((await resolveLauncherProject('/Users/j', [home], none))?.id).toBe('p-home');
    expect(await resolveLauncherProject('/elsewhere', projects, none)).toBeUndefined();
  });

  it('meets the daemon’s physical roots from a symlinked folder (the fake’s links)', async () => {
    const linked = fakeFs(['/real/app', '/real/app/.git', '/real/app/src'], {}, { '/home/app': '/real/app' });
    expect(await physicalPath('/home/app/src/', linked)).toBe(resolve('/real/app/src'));
    expect(await physicalPath('/home/app/missing', linked)).toBe(resolve('/home/app/missing'));
    expect(await gitRootsOf('/home/app/src', linked)).toEqual([resolve('/real/app')]);
    const real: HistoryProject = { id: 'p-real', name: 'app', rootPaths: ['/real/app'] };
    expect((await resolveLauncherProject('/home/app/src', [real], linked))?.id).toBe('p-real');
    // Outside a repository, the exact root is matched on the physical path too.
    const loose = fakeFs(['/real/notes', '/real/notes/a'], {}, { '/home/notes': '/real/notes' });
    const notes: HistoryProject = { id: 'p-notes', name: 'notes', rootPaths: ['/real/notes'] };
    expect((await resolveLauncherProject('/home/notes', [notes], loose))?.id).toBe('p-notes');
    expect(await resolveLauncherProject('/home/notes/a', [notes], loose)).toBeUndefined();
  });

  it('matches folders by whole path segments', () => {
    expect(isWithin('/w/app/src', '/w/app')).toBe(true);
    expect(isWithin('/w/app', '/w/app/')).toBe(true);
    expect(isWithin('/w/application', '/w/app')).toBe(false);
    expect(isWithin('/anything', '/')).toBe(true);
  });

  it.runIf(process.platform === 'win32')('matches drive roots and mixed Windows separators', () => {
    expect(isWithin('C:\\Work\\App\\src', 'c:/work/app/')).toBe(true);
    expect(isWithin('C:\\Work\\App', 'C:/')).toBe(true);
    expect(isWithin('C:\\Work\\Application', 'C:/Work/App')).toBe(false);
    expect(isWithin('D:\\Work\\App', 'C:/Work/App')).toBe(false);
  });
});

describe('launcher sessions', () => {
  const runtimes = [
    { id: 'rt-alpha', kind: 'alpha-code', dataRoot: '/home/.alpha-work/' },
    { id: 'rt-beta', kind: 'beta' },
    { id: 'rt-odd', kind: 'unheard-of' },
  ];
  const profiles = [
    profile('alpha:work', 'alpha', 'work', '/home/.alpha-work'),
    profile('gamma:work', 'gamma', 'work', '/home/.alpha-work'),
  ];
  const project: HistoryProject = { id: 'p1', name: 'app', rootPaths: ['/w/app'] };
  const fs = fakeFs(['/w/app', '/w/app/src', '/w/elsewhere']);

  it('joins each row to the provider whose history kinds hold its runtime kind, and to the profile of its data root', async () => {
    const [alpha, beta, odd, flag] = await launcherSessions({
      rows: [
        listed('a', { projectId: 'p1', cwd: '/w/app', title: 'Named' }),
        listed('b', { runtimeId: 'rt-beta', cwd: '/w/app' }),
        listed('c', { runtimeId: 'rt-odd' }),
        listed('d', { nativeSessionId: '-flag', cwd: '/w/app' }),
      ],
      runtimes,
      providers: PROVIDERS,
      profiles,
      project,
      cwds: ['/w/app'],
      fs,
    });
    expect(alpha).toMatchObject({
      key: 'a',
      providerId: 'alpha',
      nativeSessionId: 'native-a',
      profileId: 'alpha:work',
    });
    expect(alpha?.resumable).toBe(true);
    expect(beta).toMatchObject({ providerId: 'beta', resumable: false, unresumable: "can't resume" });
    expect(beta?.profileId).toBeUndefined();
    expect(odd?.providerId).toBeUndefined();
    expect(odd).toMatchObject({ resumable: false, unresumable: "can't resume" });
    // An id that could not ride the resume command's argv is never offered.
    expect(flag).toMatchObject({ providerId: 'alpha', resumable: false, unresumable: "can't resume" });
  });

  it('titles, dates and places each row', async () => {
    const rows = await launcherSessions({
      rows: [
        listed('t', { title: '  ', summary: 'A summary', lastActivityAt: 9_000, projectId: 'p1' }),
        listed('u', { updatedAt: 0, projectId: 'p2', cwd: '/w/app/src' }),
        listed('g', { cwd: '/w/gone', projectId: 'p1' }),
      ],
      runtimes,
      providers: PROVIDERS,
      profiles: [],
      project,
      cwds: ['/w/app'],
      fs,
    });
    expect(rows.map((row) => [row.title, row.lastAt, row.here])).toEqual([
      ['A summary', 9_000, true],
      ['untitled session', undefined, false],
      ['untitled session', 5_000, true],
    ]);
    expect(rows[2]).toMatchObject({ resumable: false, unresumable: 'folder is gone' });
  });

  it('places rows by folder when the pane lies in no project', async () => {
    const rows = await launcherSessions({
      rows: [listed('in', { cwd: '/w/app/src' }), listed('out', { cwd: '/w/elsewhere' }), listed('none')],
      runtimes,
      providers: PROVIDERS,
      profiles: [],
      project: undefined,
      cwds: ['/w/app'],
      fs,
    });
    expect(rows.map((row) => row.here)).toEqual([true, false, false]);
  });
});

describe('history status for the launcher', () => {
  it.each<[string, HistorySearchStatus, boolean, object]>([
    [
      'silent daemon',
      { reachable: false, detail: 'no history daemon is listening', checkedAt: '' },
      false,
      { readiness: 'unreachable', detail: 'no history daemon is listening' },
    ],
    [
      'bad answer',
      { reachable: true, detail: 'invalid', checkedAt: '' },
      false,
      { readiness: 'failed', detail: 'invalid' },
    ],
    [
      'canonical index still reading',
      { ...READY, canonicalReady: false, progress: { done: 3, total: 9 } },
      true,
      { readiness: 'building', progress: { done: 3, total: 9 } },
    ],
    [
      'catching up',
      { ...READY, readiness: 'catching-up', progress: { done: 8, total: 9 } },
      true,
      { readiness: 'catching-up', progress: { done: 8, total: 9 } },
    ],
    [
      'word index failed',
      { ...READY, readiness: 'failed' },
      true,
      { readiness: 'stale', detail: 'word search is not answering' },
    ],
    ['ready', READY, true, { readiness: 'ready' }],
  ])('%s', (_name, status, answered, expected) => {
    expect(launcherHistoryStatus(status, answered)).toEqual(expected);
  });
});

describe('launcher agents', () => {
  it('keeps the newest allocation per provider and ignores everything else', () => {
    const records = [
      allocated('alpha', '2026-09-01T00:00:00.000Z'),
      allocated('alpha', '2026-09-03T00:00:00.000Z'),
      allocated('alpha', '2026-09-02T00:00:00.000Z'),
      allocated('beta', 'not a time'),
      { ...allocated('gamma', '2026-09-04T00:00:00.000Z'), type: 'process.spawned' } as OwnActionRecord,
      { type: 'session.exit', runtimeSessionId: 'x', ts: '2026-09-05T00:00:00.000Z' } as unknown as OwnActionRecord,
    ];
    expect([...lastLaunchedByProvider(records)]).toEqual([['alpha', Date.parse('2026-09-03T00:00:00.000Z')]]);
  });

  it('lists the runtime’s launch providers in its order, saying which are not installed and which profile a launch uses', () => {
    const rows = launcherAgents({
      providers: PROVIDERS,
      distributed: new Set(['alpha', 'beta', 'gamma']),
      installations: [installation('alpha', true), installation('beta', false)],
      lastLaunched: new Map([['gamma', 42]]),
      defaults: { alpha: 'alpha:work', beta: 'gamma:work' },
      profiles: [profile('alpha:work', 'alpha', 'work', '/r'), profile('gamma:work', 'gamma', 'work', '/r')],
    });
    expect(rows).toEqual([
      { providerId: 'alpha', label: 'Alpha', preview: 'Alpha · work', profileId: 'alpha:work' },
      { providerId: 'beta', label: 'Beta', unavailable: 'not installed' },
      { providerId: 'gamma', label: 'Gamma', lastLaunchedAt: 42, unavailable: 'not installed' },
    ]);
  });

  it('calls nothing missing when the installations could not be inspected', () => {
    const rows = launcherAgents({
      providers: PROVIDERS,
      distributed: new Set(['alpha']),
      installations: undefined,
      lastLaunched: new Map(),
      defaults: {},
      profiles: [],
    });
    expect(rows).toEqual([{ providerId: 'alpha', label: 'Alpha' }]);
  });
});

describe('createLauncherService', () => {
  const projects: HistoryProject[] = [{ id: 'p1', name: 'app', rootPaths: ['/w/app'] }];

  function service(
    rows: HistoryListedSession[],
    reachable = true,
    extra: { profiles?: AgentProfile[]; clock?: { now: number } } = {},
  ) {
    const asked: { project?: string; limit: number }[] = [];
    const history: Pick<HistorySearchService, 'catalogue' | 'recent' | 'search'> = {
      catalogue: async () =>
        reachable
          ? { answered: true, status: READY, projects, runtimes: [{ id: 'rt-alpha', kind: 'alpha-code' }] }
          : { answered: false, status: { reachable: false, detail: 'no history daemon is listening', checkedAt: '' } },
      recent: async (request) => {
        asked.push(request);
        return { answered: true, status: READY, sessions: rows };
      },
      search: async (_request, scope) => ({
        status: READY,
        answered: true,
        clipped: false,
        hits: [
          {
            sessionId: 'child',
            rootSessionId: 'a',
            nativeSessionId: 'native-a',
            timelineId: 't',
            kind: `user:${scope?.project ?? 'all'}`,
            snippet: 'the [word]',
          },
        ],
      }),
    };
    const options: LauncherServiceOptions = {
      runtime: {
        launchProviders: () => PROVIDERS,
        distributionProviders: () => [],
        inspectInstallations: async () => [],
        profiles: async () => extra.profiles ?? [],
      },
      profileDefaults: () => ({}),
      readRecords: async () => [],
      history,
      fs: fakeFs(['/w/app', '/w/app/.git', '/w/app/src', '/w/loose', '/w/loose/a']),
      ...(extra.clock ? { now: () => extra.clock!.now } : {}),
    };
    return { launcher: createLauncherService(options), asked };
  }

  it('lists here by the folder’s project and all without one', async () => {
    const { launcher, asked } = service([listed('a', { projectId: 'p1', cwd: '/w/app' })]);
    const here = await launcher.recent({ cwd: '/w/app/src', scope: 'here', limit: 20 });
    expect(asked.at(-1)).toEqual({ project: 'p1', limit: 20 });
    expect(here.status.readiness).toBe('ready');
    expect(here.sessions.map((session) => [session.key, session.here, session.providerId])).toEqual([
      ['a', true, 'alpha'],
    ]);
    await launcher.recent({ cwd: '/w/app', scope: 'all', limit: 30 });
    expect(asked.at(-1)).toEqual({ limit: 30 });
  });

  it('orders by a launch main noted at once, not after the record cache expires', async () => {
    const clock = { now: 1_000 };
    let reads = 0;
    const launcher = createLauncherService({
      runtime: {
        launchProviders: () => PROVIDERS,
        distributionProviders: () => PROVIDERS as never,
        inspectInstallations: async () => undefined as never,
        profiles: async () => [],
      },
      profileDefaults: () => ({}),
      readRecords: async () => {
        reads += 1;
        return [allocated('alpha', '1970-01-01T00:00:00.500Z')];
      },
      history: {
        catalogue: async () => ({ answered: false, status: READY }),
        recent: async () => ({}),
        search: async () => ({}),
      } as never,
      fs: fakeFs([]),
      now: () => clock.now,
    });
    const order = async () => (await launcher.agents()).map((row) => [row.providerId, row.lastLaunchedAt ?? null]);
    expect(await order()).toEqual([
      ['alpha', 500],
      ['beta', null],
      ['gamma', null],
      ['wire', null],
    ]);
    clock.now = 1_200;
    launcher.noteLaunched('gamma');
    expect((await order()).find(([id]) => id === 'gamma')).toEqual(['gamma', 1_200]);
    // The cache was dropped: the record is read again, and the noted launch still counts.
    expect(reads).toBe(2);
  });

  it('lists a loose folder under home by its own cwd, not as home’s project', async () => {
    const asked: { project?: string; limit: number }[] = [];
    const launcher = createLauncherService({
      runtime: {
        launchProviders: () => PROVIDERS,
        distributionProviders: () => [],
        inspectInstallations: async () => [],
        profiles: async () => [],
      },
      profileDefaults: () => ({}),
      readRecords: async () => [],
      history: {
        catalogue: async () => ({
          answered: true,
          status: READY,
          projects: [{ id: 'p-home', name: 'j', rootPaths: ['/w'] }],
          runtimes: [{ id: 'rt-alpha', kind: 'alpha-code' }],
        }),
        recent: async (request) => {
          asked.push(request);
          return {
            answered: true,
            status: READY,
            sessions: [
              listed('mine', { cwd: '/w/loose', projectId: 'p-home' }),
              listed('home', { cwd: '/w', projectId: 'p-home' }),
            ],
          };
        },
        search: async () => ({ answered: true, status: READY, clipped: false, hits: [] }),
      },
      fs: fakeFs(['/w', '/w/loose']),
    });
    const here = await launcher.recent({ cwd: '/w/loose', scope: 'here', limit: 20 });
    expect(asked.at(-1)).toEqual({ limit: 500 });
    expect(here.sessions.map((session) => session.key)).toEqual(['mine']);
  });

  it('matches a folder outside every project by cwd over the newest sessions', async () => {
    const { launcher, asked } = service([
      listed('in', { cwd: '/w/loose/a' }),
      listed('out', { cwd: '/w/app' }),
      listed('in2', { cwd: '/w/loose' }),
    ]);
    const here = await launcher.recent({ cwd: '/w/loose', scope: 'here', limit: 1 });
    expect(asked.at(-1)).toEqual({ limit: 500 });
    expect(here.sessions.map((session) => session.key)).toEqual(['in']);
  });

  it('answers an unreachable daemon with its reason and no rows', async () => {
    const { launcher } = service([], false);
    expect(await launcher.recent({ cwd: '/w/app', scope: 'here' })).toEqual({
      status: { readiness: 'unreachable', detail: 'no history daemon is listening' },
      sessions: [],
    });
  });

  it('scopes the words lane to the folder’s project when asked for here', async () => {
    const { launcher } = service([]);
    const here = await launcher.words({ query: 'word', cwd: '/w/app', scope: 'here' });
    expect(here).toEqual({
      answered: true,
      hits: [{ nativeSessionId: 'native-a', sessionKey: 'a', kind: 'user:p1', snippet: 'the [word]' }],
    });
    const all = await launcher.words({ query: 'word', cwd: '/w/app', scope: 'all' });
    expect(all.hits[0]?.kind).toBe('user:all');
    expect(await launcher.words({ query: '', scope: 'all' })).toEqual({ answered: true, hits: [] });
  });

  it('resumes by native id through the runtime continuation, refusing what cannot resume', async () => {
    const { launcher } = service([listed('n1', { nativeSessionId: 'n1', cwd: '/w/app', projectId: 'p1' })], true, {
      profiles: [profile('alpha:work', 'alpha', 'work', '/r')],
    });
    await launcher.recent({ cwd: '/w/app', scope: 'here' });
    expect(
      await launcher.resumeOptions({
        providerId: 'alpha',
        nativeSessionId: 'n1',
        cwd: '/w/app',
        profileId: 'alpha:work',
      }),
    ).toEqual({
      continuation: { providerId: 'alpha', nativeSessionId: 'n1', implementation: 'native' },
      cwd: '/w/app',
      profile: 'alpha:work',
    });
    expect(await launcher.resumeOptions({ providerId: 'beta', nativeSessionId: 'n1' })).toEqual({
      refused: 'Beta cannot resume a session',
    });
    expect(await launcher.resumeOptions({ providerId: 'zeta', nativeSessionId: 'n1' })).toEqual({
      refused: 'zeta is not an agent this Godview launches',
    });
    expect(await launcher.resumeOptions({ providerId: 'alpha', nativeSessionId: 'n1', cwd: '/w/gone' })).toEqual({
      refused: 'its folder is gone',
    });
  });

  it('resumes only a session its own listing offered, and only for a while', async () => {
    const clock = { now: 1_000_000 };
    const { launcher } = service(
      [
        listed('n1', { nativeSessionId: 'n1', projectId: 'p1' }),
        listed('gone', { nativeSessionId: 'gone', projectId: 'p1', cwd: '/w/gone' }),
      ],
      true,
      { clock },
    );
    const unlisted = 'it is not a session this launcher listed; open the field again';
    // Never listed: a renderer cannot name any conversation it likes.
    expect(await launcher.resumeOptions({ providerId: 'alpha', nativeSessionId: 'n1' })).toEqual({ refused: unlisted });
    await launcher.recent({ cwd: '/w/app', scope: 'here' });
    expect(await launcher.resumeOptions({ providerId: 'alpha', nativeSessionId: 'n1' })).toMatchObject({
      continuation: { nativeSessionId: 'n1' },
    });
    // Listed, but not resumable (its folder is gone): never served.
    expect(await launcher.resumeOptions({ providerId: 'alpha', nativeSessionId: 'gone' })).toEqual({
      refused: unlisted,
    });
    // Listed for alpha, asked for under another resumable provider.
    expect(await launcher.resumeOptions({ providerId: 'gamma', nativeSessionId: 'n1' })).toEqual({ refused: unlisted });
    // Listed too long ago.
    clock.now += 30 * 60_000;
    expect(await launcher.resumeOptions({ providerId: 'alpha', nativeSessionId: 'n1' })).toEqual({ refused: unlisted });
  });

  it('refuses a profile the runtime does not know, or one of another agent', async () => {
    const { launcher } = service([listed('n1', { nativeSessionId: 'n1', projectId: 'p1' })], true, {
      profiles: [profile('alpha:work', 'alpha', 'work', '/r'), profile('gamma:work', 'gamma', 'work', '/r')],
    });
    await launcher.recent({ cwd: '/w/app', scope: 'here' });
    for (const profileId of ['alpha:nobody', 'gamma:work']) {
      expect(
        await launcher.resumeOptions({ providerId: 'alpha', nativeSessionId: 'n1', profileId }),
        profileId,
      ).toEqual({
        refused: 'its profile is not one of Alpha’s',
      });
    }
  });
});

describe('request decoding', () => {
  it('takes absolute folders, known scopes and bounded limits', () => {
    expect(parseLauncherRecentRequest({ scope: 'here', cwd: '/w/app', limit: 9_999 })).toEqual({
      scope: 'here',
      cwd: '/w/app',
      limit: 500,
    });
    expect(parseLauncherRecentRequest({ scope: 'all', cwd: 'relative' })).toEqual({ scope: 'all', limit: 100 });
    expect(parseLauncherRecentRequest({ scope: 'everywhere' })).toBeUndefined();
  });

  it('refuses a resume naming paths, lists, flags or bad ids', () => {
    expect(parseResumeNativeSessionRequest({ providerId: 'alpha', nativeSessionId: 'n-1', cwd: '/w' })).toEqual({
      providerId: 'alpha',
      nativeSessionId: 'n-1',
      cwd: '/w',
    });
    for (const good of ['019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b', 'ses_7Hq2', 'thread.v2:42']) {
      expect(parseResumeNativeSessionRequest({ providerId: 'alpha', nativeSessionId: good })?.nativeSessionId).toBe(
        good,
      );
    }
    for (const bad of [
      // The id is an argv token of the agent's resume command: never a flag.
      { providerId: 'alpha', nativeSessionId: '--dangerously-bypass-approvals-and-sandbox' },
      { providerId: 'alpha', nativeSessionId: '-c' },
      { providerId: 'alpha', nativeSessionId: 'a$(id)' },
      { providerId: 'alpha', nativeSessionId: 'a;b' },
      { providerId: 'alpha', nativeSessionId: 'a=b' },
      { providerId: 'alpha', nativeSessionId: 'ä' },
      { providerId: 'alpha', nativeSessionId: 'x'.repeat(257) },
      { providerId: 'alpha', nativeSessionId: 42 },
      { providerId: '-alpha', nativeSessionId: 'n' },
      { providerId: 'alpha', nativeSessionId: 'n', profileId: '-p' },
      { providerId: 'alpha', nativeSessionId: 'a/b' },
      { providerId: 'alpha', nativeSessionId: 'a,b' },
      { providerId: '../x', nativeSessionId: 'n' },
      { providerId: 'alpha', nativeSessionId: 'n', cwd: 'relative' },
      { providerId: 'alpha', nativeSessionId: 'n', profileId: 'no spaces' },
      'alpha',
    ]) {
      expect(parseResumeNativeSessionRequest(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('the launcher’s channels', () => {
  function channels(owner: boolean) {
    const handlers = new Map<string, (event: unknown, input?: unknown) => Promise<unknown>>();
    const resumed: unknown[] = [];
    registerLauncherIpc(
      {
        handle: (channel: string, handler: (event: unknown, input?: unknown) => Promise<unknown>) =>
          handlers.set(channel, handler),
      } as never,
      {
        ownerOf: () => (owner ? ({} as never) : undefined),
        runtime: {
          launchProviders: () => PROVIDERS,
          distributionProviders: () => [],
          inspectInstallations: async () => [],
          profiles: async () => [],
        },
        profileDefaults: () => ({}),
        readRecords: async () => [],
        history: {
          catalogue: async () => ({ answered: true, status: READY, projects: [], runtimes: [] }),
          recent: async () => ({ answered: true, status: READY, sessions: [] }),
          search: async () => ({ answered: true, status: READY, clipped: false, hits: [] }),
        },
        resume: async (options) => {
          resumed.push(options);
          return { runtimeRunId: 'r', runtimeEpoch: 1, externalRefs: [] } as never;
        },
      },
    );
    const ask = (channel: string, input?: unknown) => handlers.get(channel)!({ sender: {} }, input);
    return { ask, resumed };
  }

  it('tells a sender that is not a Godview window so, on every channel', async () => {
    const { ask, resumed } = channels(false);
    await expect(ask('launcher:agents')).rejects.toThrow(NOT_A_GODVIEW);
    expect(await ask('launcher:recent', { scope: 'all' })).toEqual({
      status: { readiness: 'failed', detail: NOT_A_GODVIEW },
      sessions: [],
    });
    expect(await ask('launcher:words', { scope: 'all', query: 'x' })).toEqual({
      answered: false,
      hits: [],
      refused: NOT_A_GODVIEW,
    });
    expect(await ask('puppeteer:resume-native-session', { providerId: 'alpha', nativeSessionId: 'n' })).toMatchObject({
      error: { code: 'AGENT_NOT_FOUND', message: NOT_A_GODVIEW },
    });
    expect(resumed).toEqual([]);
  });

  it('never hands the runtime a resume its listing did not offer', async () => {
    const { ask, resumed } = channels(true);
    const answer = await ask('puppeteer:resume-native-session', {
      providerId: 'alpha',
      nativeSessionId: '--dangerously-bypass-approvals-and-sandbox',
    });
    expect(answer).toMatchObject({ error: { message: 'the resume request was not understood' } });
    expect(await ask('puppeteer:resume-native-session', { providerId: 'alpha', nativeSessionId: 'n1' })).toMatchObject({
      error: { message: 'it is not a session this launcher listed; open the field again' },
    });
    expect(resumed).toEqual([]);
  });
});

describe('a symlinked pane folder on the real file system', () => {
  const root = mkdtempSync(join(tmpdir(), 'launcher-ipc-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'repo', '.git'), { recursive: true });
  mkdirSync(join(root, 'repo', 'src'));
  symlinkSync(join(root, 'repo'), join(root, 'link'));
  // The daemon records physical roots; the OS temp dir is itself behind a link on macOS.
  const physicalRepo = realpathSync.native(join(root, 'repo'));

  // APFS is case-insensitive: a folder typed in another case is the same folder,
  // and the native realpath answers in the case getcwd (and rosetta) records.
  const shouted = join(root, 'REPO');
  it.skipIf(!existsSync(shouted))('answers in the file system’s own letter case', async () => {
    expect(await physicalPath(join(shouted, 'src'))).toBe(join(physicalRepo, 'src'));
    const project: HistoryProject = { id: 'p-repo', name: 'repo', rootPaths: [physicalRepo] };
    expect((await resolveLauncherProject(join(shouted, 'src'), [project]))?.id).toBe('p-repo');
  });

  it('resolves to the project the daemon filed under the physical root', async () => {
    expect(await gitRootsOf(join(root, 'link', 'src'))).toEqual([physicalRepo]);
    const project: HistoryProject = { id: 'p-repo', name: 'repo', rootPaths: [physicalRepo] };
    expect((await resolveLauncherProject(join(root, 'link', 'src'), [project]))?.id).toBe('p-repo');
  });

  it('lists a session recorded under the physical folder as here, from the linked one', async () => {
    const rows = await launcherSessions({
      rows: [listed('in', { cwd: join(physicalRepo, 'src') }), listed('out', { cwd: tmpdir() })],
      runtimes: [{ id: 'rt-alpha', kind: 'alpha-code' }],
      providers: PROVIDERS,
      profiles: [],
      project: undefined,
      cwds: [join(root, 'link'), await physicalPath(join(root, 'link'))],
    });
    expect(rows.map((row) => [row.key, row.here, row.resumable])).toEqual([
      ['in', true, true],
      ['out', false, true],
    ]);
  });
});
