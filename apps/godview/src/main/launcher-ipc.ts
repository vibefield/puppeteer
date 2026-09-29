import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { AgentInstallation, AgentLaunchProvider, AgentProfile } from '@vibecook/puppeteer-core';
import { isOwnActionV2, type OwnActionRecord } from '@vibecook/puppeteer-record';
import type { AgentRuntime, ResumeAgentOptions } from '@vibecook/puppeteer-runtime';
import type {
  CreateAgentSessionResult,
  HistorySearchHit,
  HistorySearchStatus,
  LauncherAgentRow,
  LauncherHistoryStatus,
  LauncherRecentAnswer,
  LauncherRecentRequest,
  LauncherSessionRow,
  LauncherWordHit,
  LauncherWordsAnswer,
  LauncherWordsRequest,
  ProfileDefaults,
  ResumeNativeSessionRequest,
} from '../protocol.js';
import {
  normalizeHistoryQuery,
  type HistoryListedSession,
  type HistoryProject,
  type HistoryRuntime,
  type HistorySearchService,
} from './history-search.js';

/**
 * The empty pane launcher's questions (QL-1), answered in main: the agents a
 * fresh pane offers, the past sessions of the pane's folder, the words lane,
 * and resuming a past conversation by its provider-native id (QL-D10).
 *
 * No provider is named here. The history daemon files sessions under runtime
 * kinds; a launch provider declares the kinds its native sessions go by
 * (`historyKinds`), and that declaration is the whole join.
 */

const DEFAULT_RECENT_LIMIT = 100;
const MAX_RECENT_LIMIT = 500;
/** A folder outside every project is matched by cwd over this many of the newest sessions. */
const UNPROJECTED_SCAN_LIMIT = 500;
const MAX_CWD_CHARS = 4_096;
const RECORDS_TTL_MS = 5_000;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
/**
 * A native session id a resume may carry. It becomes an argv token of the
 * agent's own resume command (`resume <id>`), so it never starts with `-` and
 * holds nothing but letters, digits and `._:-`.
 */
const RESUME_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
/** How long a session main listed stays resumable by the renderer that asked. */
const SERVED_TTL_MS = 30 * 60_000;
/** The most listed sessions main remembers as resumable; the oldest go first. */
const SERVED_LIMIT = 2_000;
/** What a sender that is not a Godview window is told. */
export const NOT_A_GODVIEW = 'only a Godview window may ask the launcher';
const UNTITLED = 'untitled session';

/* ── the file system, as far as a launcher asks it ─────────────────────── */

/**
 * Asynchronous throughout: `recent()` stats a folder per listed session and
 * walks up for `.git`, and none of that may stall main's event loop.
 */
export interface LauncherFs {
  isDirectory(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  /**
   * The physical path, every symlink resolved and in the file system's own
   * letter case; rejects for a path that does not exist.
   */
  realpath(path: string): Promise<string>;
}

export const NODE_LAUNCHER_FS: LauncherFs = {
  isDirectory: (path) =>
    stat(path).then(
      (info) => info.isDirectory(),
      () => false,
    ),
  isFile: (path) =>
    stat(path).then(
      (info) => info.isFile(),
      () => false,
    ),
  read: (path) => readFile(path, 'utf8'),
  // `fs/promises` realpath is the native one (libuv's realpath(3)), which, like
  // `realpathSync.native`, returns APFS's stored case: `/users/j/projects` comes
  // back `/Users/j/Projects`, as getcwd — and so rosetta — records it. The JS
  // `realpathSync` keeps the input's case.
  realpath: (path) => realpath(path),
};

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

/**
 * The physical form of an absolute path, as the history daemon records
 * project roots (rosetta's `root_paths` are real paths): a symlinked pane
 * folder must meet them. A path that does not exist stays as it was.
 */
export async function physicalPath(path: string, fs: LauncherFs = NODE_LAUNCHER_FS): Promise<string> {
  return fs.realpath(path).then(trimSlash, () => trimSlash(resolve(path)));
}

/** `path` is `folder` or lies under it. */
export function isWithin(path: string, folder: string): boolean {
  const inner = trimSlash(path);
  const outer = trimSlash(folder);
  return inner === outer || inner.startsWith(outer === sep ? sep : outer + sep);
}

/**
 * The git roots a folder belongs to, nearest first, as physical paths: the
 * working tree holding `.git`, and — when `.git` is a worktree's file — the
 * repository it was cut from, read through the worktree's own `commondir`.
 * None outside a repository.
 */
export async function gitRootsOf(cwd: string, fs: LauncherFs = NODE_LAUNCHER_FS): Promise<string[]> {
  let folder = await physicalPath(cwd, fs);
  for (;;) {
    const dotGit = join(folder, '.git');
    if (await fs.isDirectory(dotGit)) return [folder];
    if (await fs.isFile(dotGit)) {
      const roots = [folder];
      try {
        const pointer = /^gitdir:\s*(.+)$/mu.exec(await fs.read(dotGit))?.[1]?.trim();
        if (pointer) {
          const gitDir = resolve(folder, pointer);
          const common = await physicalPath(resolve(gitDir, (await fs.read(join(gitDir, 'commondir'))).trim()), fs);
          if (basename(common) === '.git' && dirname(common) !== folder) roots.push(dirname(common));
        }
      } catch {
        // A worktree whose repository moved is still its own root.
      }
      return roots;
    }
    const parent = dirname(folder);
    if (parent === folder) return [];
    folder = parent;
  }
}

/**
 * The pane folder's project (QL-D9): the one whose roots hold the folder's git
 * root (a worktree's or the repository's it was cut from), else one rooted
 * at the folder EXACTLY (as given or as its physical path). Never the
 * longest root the folder lies under: rosetta makes every non-repository
 * cwd a project rooted there, home usually among them, so a prefix match
 * would give any loose folder under ~ home's sessions. None otherwise, and
 * the caller filters sessions by the folder instead.
 */
export async function resolveLauncherProject(
  cwd: string,
  projects: readonly HistoryProject[],
  fs: LauncherFs = NODE_LAUNCHER_FS,
): Promise<HistoryProject | undefined> {
  for (const root of await gitRootsOf(cwd, fs)) {
    const owner = projects.find((project) => project.rootPaths.some((path) => trimSlash(path) === root));
    if (owner) return owner;
  }
  const forms = new Set([trimSlash(cwd), await physicalPath(cwd, fs)]);
  return projects.find((project) => project.rootPaths.some((path) => forms.has(trimSlash(path))));
}

/* ── agents ────────────────────────────────────────────────────────────── */

/** The newest `run.allocated` per provider, in epoch ms: a launch, a prepared launch, or a resume. */
export function lastLaunchedByProvider(records: readonly OwnActionRecord[]): Map<string, number> {
  const latest = new Map<string, number>();
  for (const record of records) {
    if (!isOwnActionV2(record) || record.type !== 'run.allocated') continue;
    const at = Date.parse(record.observedAt);
    if (!Number.isFinite(at)) continue;
    if (at > (latest.get(record.providerId) ?? Number.NEGATIVE_INFINITY)) latest.set(record.providerId, at);
  }
  return latest;
}

export interface LauncherAgentsInput {
  /** The runtime's launch providers, in its own order. */
  providers: readonly AgentLaunchProvider[];
  /** Providers that declare distribution facts: the ones an installation can be found for. */
  distributed: ReadonlySet<string>;
  /** Undefined when inspection failed: then nothing is called missing. */
  installations: readonly AgentInstallation[] | undefined;
  lastLaunched: ReadonlyMap<string, number>;
  defaults: ProfileDefaults;
  profiles: readonly AgentProfile[];
}

/**
 * The launcher's rows: every launch provider an installation can be found for,
 * in the runtime's order (the launcher reorders by last launch). An agent with
 * no active installation says so; a default profile names itself in the
 * preview and is what the launch runs under.
 */
export function launcherAgents(input: LauncherAgentsInput): LauncherAgentRow[] {
  return input.providers.flatMap((provider): LauncherAgentRow[] => {
    if (!input.distributed.has(provider.id)) return [];
    const installed =
      input.installations === undefined ||
      input.installations.some((installation) => installation.provider === provider.id && installation.active);
    const defaultId = input.defaults[provider.id];
    const profile = defaultId
      ? input.profiles.find((candidate) => candidate.id === defaultId && candidate.provider === provider.id)
      : undefined;
    const lastLaunchedAt = input.lastLaunched.get(provider.id);
    return [
      {
        providerId: provider.id,
        label: provider.label,
        ...(lastLaunchedAt !== undefined ? { lastLaunchedAt } : {}),
        ...(installed ? {} : { unavailable: 'not installed' }),
        ...(profile ? { preview: `${provider.label} · ${profile.label}`, profileId: profile.id } : {}),
      },
    ];
  });
}

/* ── history ───────────────────────────────────────────────────────────── */

/**
 * The daemon's state as the launcher words it: a daemon that cannot be reached
 * (or speaks another protocol) is `unreachable`; one that answered badly is
 * `failed`; a list read before the canonical index is whole is `building`. A
 * failing word index does not unmake a whole list, so it reads as `stale`.
 */
export function launcherHistoryStatus(status: HistorySearchStatus, answered: boolean): LauncherHistoryStatus {
  const detail = status.detail ? { detail: status.detail } : {};
  const progress = status.progress ? { progress: status.progress } : {};
  if (!answered) return { readiness: status.reachable ? 'failed' : 'unreachable', ...detail };
  if (status.canonicalReady === false) return { readiness: 'building', ...progress, ...detail };
  const readiness = status.readiness ?? 'ready';
  if (readiness === 'failed') return { readiness: 'stale', detail: status.detail ?? 'word search is not answering' };
  return { readiness, ...progress, ...detail };
}

export interface LauncherSessionsInput {
  rows: readonly HistoryListedSession[];
  runtimes: readonly HistoryRuntime[];
  providers: readonly AgentLaunchProvider[];
  profiles: readonly AgentProfile[];
  /** The pane folder's project; without one, `here` is the folder itself. */
  project: HistoryProject | undefined;
  /** The pane folder, as given and as its physical path (`here` matches either). */
  cwds: readonly string[];
  fs?: LauncherFs;
}

/**
 * Daemon rows as launcher sessions. The provider is the launch provider whose
 * `historyKinds` holds the row's runtime kind; the profile is the one whose
 * data root the daemon read the row from, so a resume binds the account the
 * conversation lives in.
 */
export async function launcherSessions(input: LauncherSessionsInput): Promise<LauncherSessionRow[]> {
  const fs = input.fs ?? NODE_LAUNCHER_FS;
  // One stat per distinct folder, all at once.
  const folders = [...new Set(input.rows.flatMap((row) => (row.cwd === undefined ? [] : [row.cwd])))];
  const present = new Map(
    await Promise.all(folders.map(async (folder) => [folder, await fs.isDirectory(folder)] as const)),
  );
  const runtimes = new Map(input.runtimes.map((runtime) => [runtime.id, runtime] as const));
  const byKind = new Map<string, AgentLaunchProvider>();
  for (const provider of input.providers) {
    for (const kind of provider.historyKinds ?? []) if (!byKind.has(kind)) byKind.set(kind, provider);
  }
  return input.rows.map((row): LauncherSessionRow => {
    const runtime = runtimes.get(row.runtimeId);
    const provider = runtime ? byKind.get(runtime.kind) : undefined;
    const profile =
      provider && runtime?.dataRoot
        ? input.profiles.find(
            (candidate) =>
              candidate.provider === provider.id && trimSlash(candidate.dataRoot) === trimSlash(runtime.dataRoot!),
          )
        : undefined;
    const here = input.project
      ? row.projectId === input.project.id
      : row.cwd !== undefined && input.cwds.some((cwd) => isWithin(row.cwd!, cwd));
    const lastAt = row.lastActivityAt ?? (row.updatedAt > 0 ? row.updatedAt : undefined);
    // An id a resume could not carry as an argv token is not offered at all.
    const unresumable =
      !provider?.resume || !RESUME_ID.test(row.nativeSessionId)
        ? "can't resume"
        : row.cwd !== undefined && present.get(row.cwd) !== true
          ? 'folder is gone'
          : undefined;
    return {
      key: row.id,
      ...(provider ? { providerId: provider.id } : {}),
      nativeSessionId: row.nativeSessionId,
      title: row.title?.trim() || row.summary?.trim() || UNTITLED,
      ...(row.cwd ? { cwd: row.cwd } : {}),
      here,
      ...(lastAt !== undefined ? { lastAt } : {}),
      resumable: unresumable === undefined,
      ...(unresumable ? { unresumable } : {}),
      ...(profile ? { profileId: profile.id } : {}),
    };
  });
}

export function launcherWordHits(hits: readonly HistorySearchHit[]): LauncherWordHit[] {
  return hits.map((hit) => ({
    ...(hit.nativeSessionId ? { nativeSessionId: hit.nativeSessionId } : {}),
    sessionKey: hit.rootSessionId,
    kind: hit.kind,
    snippet: hit.snippet,
  }));
}

/* ── renderer requests, decoded tolerantly ─────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function launcherCwd(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_CWD_CHARS || value.includes('\u0000')) return undefined;
  return isAbsolute(value) ? value : undefined;
}

function launcherLimit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.min(MAX_RECENT_LIMIT, Math.floor(value))
    : DEFAULT_RECENT_LIMIT;
}

export function parseLauncherRecentRequest(value: unknown): LauncherRecentRequest | undefined {
  if (!isRecord(value) || (value.scope !== 'here' && value.scope !== 'all')) return undefined;
  const cwd = launcherCwd(value.cwd);
  return { scope: value.scope, limit: launcherLimit(value.limit), ...(cwd ? { cwd } : {}) };
}

export function parseLauncherWordsRequest(value: unknown): LauncherWordsRequest | undefined {
  const recent = parseLauncherRecentRequest(value);
  if (!recent || !isRecord(value)) return undefined;
  return { ...recent, query: normalizeHistoryQuery(value.query) };
}

export function parseResumeNativeSessionRequest(value: unknown): ResumeNativeSessionRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { providerId, nativeSessionId, profileId } = value;
  if (typeof providerId !== 'string' || !PROVIDER_ID.test(providerId)) return undefined;
  if (typeof nativeSessionId !== 'string' || !RESUME_ID.test(nativeSessionId)) return undefined;
  if (profileId !== undefined && (typeof profileId !== 'string' || !PROFILE_ID.test(profileId))) return undefined;
  if (value.cwd !== undefined && !launcherCwd(value.cwd)) return undefined;
  const cwd = launcherCwd(value.cwd);
  return { providerId, nativeSessionId, ...(cwd ? { cwd } : {}), ...(profileId ? { profileId } : {}) };
}

/* ── the service ───────────────────────────────────────────────────────── */

export interface LauncherServiceOptions {
  runtime: Pick<AgentRuntime, 'launchProviders' | 'distributionProviders' | 'inspectInstallations' | 'profiles'>;
  profileDefaults(): ProfileDefaults;
  /** The own-action record, for each provider's last launch. */
  readRecords(): Promise<readonly OwnActionRecord[]>;
  history: Pick<HistorySearchService, 'catalogue' | 'recent' | 'search'>;
  fs?: LauncherFs;
  now?: () => number;
}

export interface LauncherService {
  agents(): Promise<LauncherAgentRow[]>;
  recent(request: LauncherRecentRequest): Promise<LauncherRecentAnswer>;
  words(request: LauncherWordsRequest): Promise<LauncherWordsAnswer>;
  /**
   * The resume request as the runtime takes it, or the refusal a person reads.
   * Only a session this service listed in a recent `recent()` answer resumes,
   * in an existing folder, under a profile of its own agent.
   */
  resumeOptions(request: ResumeNativeSessionRequest): Promise<ResumeAgentOptions | { refused: string }>;
  /**
   * A launch or a resume was just allocated for this provider (main's own
   * word, not the renderer's): the next `agents()` orders by it at once,
   * rather than after the record cache's few seconds.
   */
  noteLaunched(providerId: string, atMs?: number): void;
}

function servedKey(providerId: string, nativeSessionId: string): string {
  return `${providerId}\u0000${nativeSessionId}`;
}

export function createLauncherService(options: LauncherServiceOptions): LauncherService {
  const fs = options.fs ?? NODE_LAUNCHER_FS;
  const now = options.now ?? Date.now;
  let records: { at: number; value: Promise<Map<string, number>> } | undefined;
  /** Launches main saw allocated since the record was last read. */
  const noted = new Map<string, number>();
  /** The sessions `recent()` listed as resumable, by provider and native id, with when. */
  const served = new Map<string, number>();

  function serve(sessions: readonly LauncherSessionRow[]): void {
    const at = now();
    for (const session of sessions) {
      if (!session.resumable || !session.providerId || !session.nativeSessionId) continue;
      const key = servedKey(session.providerId, session.nativeSessionId);
      served.delete(key);
      served.set(key, at);
    }
    for (const key of served.keys()) {
      if (served.size <= SERVED_LIMIT) break;
      served.delete(key);
    }
  }

  async function lastLaunched(): Promise<Map<string, number>> {
    if (!records || now() - records.at >= RECORDS_TTL_MS) {
      records = {
        at: now(),
        value: options.readRecords().then(lastLaunchedByProvider, () => new Map<string, number>()),
      };
    }
    const read = await records.value;
    if (noted.size === 0) return read;
    const merged = new Map(read);
    for (const [providerId, at] of noted) {
      if (at > (merged.get(providerId) ?? Number.NEGATIVE_INFINITY)) merged.set(providerId, at);
    }
    return merged;
  }

  function noteLaunched(providerId: string, atMs = now()): void {
    noted.set(providerId, Math.max(atMs, noted.get(providerId) ?? Number.NEGATIVE_INFINITY));
    // The record will hold it too; read it afresh next time rather than trust a cache from before.
    records = undefined;
  }

  async function agents(): Promise<LauncherAgentRow[]> {
    const providers = options.runtime.launchProviders();
    const distributed = new Set(options.runtime.distributionProviders().map((provider) => provider.id));
    const [installations, profiles, launched] = await Promise.all([
      options.runtime.inspectInstallations().catch(() => undefined),
      options.runtime.profiles().catch((): AgentProfile[] => []),
      lastLaunched(),
    ]);
    return launcherAgents({
      providers,
      distributed,
      installations,
      lastLaunched: launched,
      defaults: options.profileDefaults(),
      profiles,
    });
  }

  async function recent(request: LauncherRecentRequest): Promise<LauncherRecentAnswer> {
    const catalogue = await options.history.catalogue();
    if (!catalogue.answered) return { status: launcherHistoryStatus(catalogue.status, false), sessions: [] };
    const cwd = request.cwd;
    const project = cwd ? await resolveLauncherProject(cwd, catalogue.projects, fs) : undefined;
    const limit = request.limit ?? DEFAULT_RECENT_LIMIT;
    if (request.scope === 'here' && !cwd) {
      return { status: launcherHistoryStatus(catalogue.status, true), sessions: [] };
    }
    // Outside every project, "here" is the folder: the newest sessions, filtered by cwd.
    const unprojected = request.scope === 'here' && !project;
    const listing = await options.history.recent({
      ...(request.scope === 'here' && project ? { project: project.id } : {}),
      limit: unprojected ? UNPROJECTED_SCAN_LIMIT : limit,
    });
    if (!listing.answered) return { status: launcherHistoryStatus(listing.status, false), sessions: [] };
    const profiles = await options.runtime.profiles().catch((): AgentProfile[] => []);
    const sessions = await launcherSessions({
      rows: listing.sessions,
      runtimes: catalogue.runtimes,
      providers: options.runtime.launchProviders(),
      profiles,
      project,
      cwds: cwd ? [...new Set([cwd, await physicalPath(cwd, fs)])] : [],
      fs,
    });
    const answer = (unprojected ? sessions.filter((session) => session.here) : sessions).slice(0, limit);
    serve(answer);
    return { status: launcherHistoryStatus(listing.status, true), sessions: answer };
  }

  async function words(request: LauncherWordsRequest): Promise<LauncherWordsAnswer> {
    if (request.query === '') return { answered: true, hits: [] };
    let project: HistoryProject | undefined;
    if (request.scope === 'here' && request.cwd) {
      const catalogue = await options.history.catalogue();
      if (catalogue.answered) project = await resolveLauncherProject(request.cwd, catalogue.projects, fs);
    }
    const response = await options.history.search(
      { query: request.query, nativeSessionIds: [], limit: request.limit ?? DEFAULT_RECENT_LIMIT, prefix: true },
      project ? { project: project.id } : undefined,
    );
    return { answered: response.answered, hits: response.answered ? launcherWordHits(response.hits) : [] };
  }

  async function resumeOptions(request: ResumeNativeSessionRequest): Promise<ResumeAgentOptions | { refused: string }> {
    const provider = options.runtime.launchProviders().find((candidate) => candidate.id === request.providerId);
    if (!provider) return { refused: `${request.providerId} is not an agent this Godview launches` };
    if (!provider.resume) return { refused: `${provider.label} cannot resume a session` };
    const listedAt = served.get(servedKey(provider.id, request.nativeSessionId));
    if (listedAt === undefined || now() - listedAt >= SERVED_TTL_MS) {
      return { refused: 'it is not a session this launcher listed; open the field again' };
    }
    if (request.cwd && !(await fs.isDirectory(request.cwd))) return { refused: 'its folder is gone' };
    if (request.profileId) {
      const profiles = await options.runtime.profiles().catch((): AgentProfile[] => []);
      const known = profiles.some((profile) => profile.id === request.profileId && profile.provider === provider.id);
      if (!known) return { refused: `its profile is not one of ${provider.label}’s` };
    }
    return {
      continuation: { providerId: provider.id, nativeSessionId: request.nativeSessionId, implementation: 'native' },
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.profileId ? { profile: request.profileId } : {}),
    };
  }

  return { agents, recent, words, resumeOptions, noteLaunched };
}

/* ── IPC ───────────────────────────────────────────────────────────────── */

export interface LauncherIpcOptions extends LauncherServiceOptions {
  /** The Godview window that sent the request; undefined for anything else. */
  ownerOf(event: IpcMainInvokeEvent): BrowserWindow | undefined;
  /** Resume through the host's own path, which registers the run and mounts nothing. */
  resume(options: ResumeAgentOptions, owner: BrowserWindow): Promise<CreateAgentSessionResult>;
}

function refusal(message: string, code: 'AGENT_NOT_FOUND' | 'AGENT_SESSION_CREATE_FAILED'): CreateAgentSessionResult {
  return { runtimeRunId: '', runtimeEpoch: 0, externalRefs: [], error: { code, message } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The launcher's four channels; each answers only a Godview window. */
export function registerLauncherIpc(ipc: Pick<IpcMain, 'handle'>, options: LauncherIpcOptions): LauncherService {
  const service = createLauncherService(options);
  const unavailable = (detail: string): LauncherRecentAnswer => ({
    status: { readiness: 'failed', detail },
    sessions: [],
  });
  ipc.handle('launcher:agents', (event): Promise<LauncherAgentRow[]> => {
    // An agent list has no room for a sentence: a stranger's call is rejected with one.
    if (!options.ownerOf(event)) return Promise.reject(new Error(NOT_A_GODVIEW));
    return service.agents();
  });
  ipc.handle('launcher:recent', (event, input: unknown): Promise<LauncherRecentAnswer> => {
    if (!options.ownerOf(event)) return Promise.resolve(unavailable(NOT_A_GODVIEW));
    const request = parseLauncherRecentRequest(input);
    if (!request) return Promise.resolve(unavailable('the request was not understood'));
    return service.recent(request);
  });
  ipc.handle('launcher:words', (event, input: unknown): Promise<LauncherWordsAnswer> => {
    if (!options.ownerOf(event)) return Promise.resolve({ answered: false, hits: [], refused: NOT_A_GODVIEW });
    const request = parseLauncherWordsRequest(input);
    if (!request) return Promise.resolve({ answered: false, hits: [] });
    return service.words(request);
  });
  ipc.handle('puppeteer:resume-native-session', async (event, input: unknown): Promise<CreateAgentSessionResult> => {
    const owner = options.ownerOf(event);
    if (!owner) return refusal(NOT_A_GODVIEW, 'AGENT_NOT_FOUND');
    const request = parseResumeNativeSessionRequest(input);
    if (!request) return refusal('the resume request was not understood', 'AGENT_NOT_FOUND');
    const resume = await service.resumeOptions(request);
    if ('refused' in resume) return refusal(resume.refused, 'AGENT_NOT_FOUND');
    try {
      return await options.resume(resume, owner);
    } catch (error) {
      return refusal(messageOf(error), 'AGENT_SESSION_CREATE_FAILED');
    }
  });
  return service;
}
