import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HistoryOriginSource,
  HistorySearchHit,
  HistorySearchReadiness,
  HistorySearchRequest,
  HistorySearchResponse,
  HistorySearchStatus,
  HistorySessionFacts,
} from '../protocol.js';

/**
 * Transcript history for the Find sheet, read from an external loopback daemon
 * (Rosetta's `rosettad`) that indexes every installed agent's own session
 * records. Godview opens no transcript itself: the daemon reads the native
 * logs, and this module only joins its answers to live runs by the
 * provider-native session id both sides already hold. Provider names never
 * appear here; the daemon's runtime kinds pass through as opaque data.
 *
 * Protocols 17 through 20 are supported. Protocol 18 answers one question for a
 * whole set of sessions, widens word fragments, and resolves native ids
 * directly. Protocol 17 has none of that, so the same questions are asked the
 * long way: a time-bounded search filtered here, and a listing of recent
 * sessions filtered here. Protocols 19 (activity) and 20 (authored images)
 * preserve the status, session identity, and search fields consumed here.
 * A non-ready daemon answer is reported as
 * unanswered, never as "no matches", so a sheet can hold what it last showed.
 *
 * The daemon has no authentication; its loopback bind and origin policy are
 * the whole boundary. An origin therefore has to be a loopback http URL and
 * nothing else, wherever it came from.
 */

export const HISTORY_PROTOCOL_MIN = 17;
export const HISTORY_PROTOCOL_MAX = 20;
export const DEFAULT_HISTORY_ORIGIN = 'http://127.0.0.1:4640';
export const HISTORY_ANNOUNCEMENT_SCHEMA = 'rosetta-daemon/1';

const PROTOCOL_HEADER = 'x-rosetta-protocol-version';
const MAX_QUERY_CHARS = 512;
const MAX_LIVE_SESSIONS = 256;
const NATIVE_LOOKUP_CHUNK = 64;
const V17_LIST_LIMIT = 1000;
const V17_SEARCH_LIMIT = 1000;
const DEFAULT_SEARCH_LIMIT = 300;
const MAX_CHILD_LOOKUPS_PER_SEARCH = 32;
const FACTS_TTL_MS = 15_000;
/** A session the daemon has not ingested yet is asked about again sooner than a known one is refreshed. */
const MISS_TTL_MS = 3_000;
const VERSION_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

/* ── origins ───────────────────────────────────────────────────────────── */

/** A loopback http origin and nothing more: no path, credentials, query, or fragment. */
export function validateHistoryOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() !== value || value === '') return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:') return undefined;
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (url.pathname !== '/' && url.pathname !== '') return undefined;
  const port = url.port === '' ? 80 : Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
  return `http://${url.hostname}:${port}`;
}

/** What `rosettad serve --announce` leaves for sibling apps. */
export interface HistoryAnnouncement {
  origin: string;
  pid: number;
  protocolVersion: number;
  db: string;
  startedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseHistoryAnnouncement(text: string): HistoryAnnouncement | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.schema !== HISTORY_ANNOUNCEMENT_SCHEMA) return undefined;
  const origin = validateHistoryOrigin(value.origin);
  const pid = asFiniteNumber(value.pid);
  const protocolVersion = asFiniteNumber(value.protocol_version);
  const db = asString(value.db);
  const startedAt = asFiniteNumber(value.started_at);
  if (!origin || pid === undefined || protocolVersion === undefined || db === undefined || startedAt === undefined) {
    return undefined;
  }
  return { origin, pid, protocolVersion, db, startedAt };
}

/** Mirrors the daemon's own rule for where it announces. */
export function defaultAnnounceDirectory(platform: string, env: NodeJS.ProcessEnv): string | undefined {
  const override = env.ROSETTA_ANNOUNCE_DIR;
  if (override && override.startsWith('/')) return override;
  const home = env.HOME;
  if (!home || !home.startsWith('/')) return undefined;
  if (platform === 'darwin') return join(home, 'Library/Application Support/rosetta/daemons');
  const state =
    env.XDG_STATE_HOME && env.XDG_STATE_HOME.startsWith('/') ? env.XDG_STATE_HOME : join(home, '.local/state');
  return join(state, 'rosetta/daemons');
}

export interface AnnounceDirectoryReader {
  list(directory: string): string[];
  read(path: string): string;
  /** Whether the announcing process still exists; a stale file is only a stale file. */
  isAlive(pid: number): boolean;
}

export const NODE_ANNOUNCE_READER: AnnounceDirectoryReader = {
  list: (directory) => {
    try {
      return readdirSync(directory).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
    } catch {
      return [];
    }
  },
  read: (path) => readFileSync(path, 'utf8'),
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
};

/** Live announcements, newest first. Files that fail to parse are ignored. */
export function discoverAnnouncedDaemons(
  directory: string | undefined,
  reader: AnnounceDirectoryReader = NODE_ANNOUNCE_READER,
): HistoryAnnouncement[] {
  if (!directory) return [];
  const found: HistoryAnnouncement[] = [];
  for (const name of reader.list(directory)) {
    let announcement: HistoryAnnouncement | undefined;
    try {
      announcement = parseHistoryAnnouncement(reader.read(join(directory, name)));
    } catch {
      announcement = undefined;
    }
    if (announcement && reader.isAlive(announcement.pid)) found.push(announcement);
  }
  return found.sort((left, right) => right.startedAt - left.startedAt || left.pid - right.pid);
}

export interface HistoryOriginSources {
  configured?: string;
  environment?: string;
  announced: readonly HistoryAnnouncement[];
}

export interface ResolvedHistoryOrigin {
  origin: string;
  source: HistoryOriginSource;
  /** Distinguishes announced processes even when they reuse the same port. */
  generation?: string;
}

/** A setting wins over the environment, which wins over what a daemon announced, which wins over the app default. */
export function resolveHistoryOrigin(sources: HistoryOriginSources): ResolvedHistoryOrigin {
  const configured = validateHistoryOrigin(sources.configured);
  const environment = validateHistoryOrigin(sources.environment);
  const announced = sources.announced.find(
    (candidate) =>
      candidate.protocolVersion >= HISTORY_PROTOCOL_MIN && candidate.protocolVersion <= HISTORY_PROTOCOL_MAX,
  );
  const origin = configured ?? environment ?? announced?.origin ?? DEFAULT_HISTORY_ORIGIN;
  const source = configured ? 'setting' : environment ? 'environment' : announced ? 'announcement' : 'default';
  const process = sources.announced.find((candidate) => candidate.origin === origin);
  return {
    origin,
    source,
    ...(process ? { generation: JSON.stringify([process.pid, process.startedAt, process.db]) } : {}),
  };
}

/* ── requests ──────────────────────────────────────────────────────────── */

/** One line of plain text, bounded; control characters never reach a URL. */
export function normalizeHistoryQuery(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_CHARS);
}

/** Renderer-supplied identities must be opaque labels, never paths or lists. */
export function isHistoryIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\s,/\\\u0000]/.test(value)
  );
}

export function parseHistorySearchRequest(value: unknown): HistorySearchRequest | undefined {
  if (!isRecord(value)) return undefined;
  const query = normalizeHistoryQuery(value.query);
  const ids = Array.isArray(value.nativeSessionIds) ? value.nativeSessionIds : [];
  const nativeSessionIds: string[] = [];
  for (const id of ids) {
    if (!isHistoryIdentifier(id)) return undefined;
    if (!nativeSessionIds.includes(id)) nativeSessionIds.push(id);
    if (nativeSessionIds.length > MAX_LIVE_SESSIONS) return undefined;
  }
  const afterMs = asFiniteNumber(value.afterMs);
  const limit = asFiniteNumber(value.limit);
  return {
    query,
    nativeSessionIds,
    ...(afterMs !== undefined && afterMs > 0 ? { afterMs: Math.floor(afterMs) } : {}),
    ...(limit !== undefined && limit > 0 ? { limit: Math.min(1000, Math.floor(limit)) } : {}),
    ...(typeof value.prefix === 'boolean' ? { prefix: value.prefix } : {}),
  };
}

export function parseHistoryFactsRequest(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const id of value) {
    if (!isHistoryIdentifier(id)) return undefined;
    if (!ids.includes(id)) ids.push(id);
    if (ids.length > MAX_LIVE_SESSIONS) return undefined;
  }
  return ids;
}

/* ── the daemon's wire, decoded tolerantly ─────────────────────────────── */

interface DaemonSessionRow {
  id: string;
  nativeSessionId: string;
  rootSessionId: string;
  parentSessionId?: string;
  title?: string;
  summary?: string;
  cwd?: string;
  updatedAt: number;
  streamState: string;
}

function decodeSessionRow(value: unknown): DaemonSessionRow | undefined {
  if (!isRecord(value)) return undefined;
  const id = asString(value.id);
  const nativeSessionId = asString(value.native_session_id);
  const rootSessionId = asString(value.root_session_id) ?? id;
  if (!id || !nativeSessionId || !rootSessionId) return undefined;
  const parentSessionId = asString(value.parent_session_id);
  const title = asString(value.title);
  const summary = asString(value.summary);
  const cwd = asString(value.cwd);
  return {
    id,
    nativeSessionId,
    rootSessionId,
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(cwd ? { cwd } : {}),
    updatedAt: asFiniteNumber(value.updated_at) ?? 0,
    streamState: asString(value.stream_state) ?? 'unknown',
  };
}

function decodeSessionRows(body: unknown): DaemonSessionRow[] | undefined {
  if (!isRecord(body) || !Array.isArray(body.sessions)) return undefined;
  const rows: DaemonSessionRow[] = [];
  for (const value of body.sessions) {
    const row = decodeSessionRow(value);
    if (!row) return undefined;
    rows.push(row);
  }
  return rows;
}

interface DaemonHit {
  timelineId: string;
  sessionId: string;
  kind: string;
  at?: number;
  snippet: string;
}

function decodeHits(body: unknown): DaemonHit[] | undefined {
  if (!isRecord(body) || !Array.isArray(body.hits)) return undefined;
  const hits: DaemonHit[] = [];
  for (const value of body.hits) {
    if (!isRecord(value)) return undefined;
    const timelineId = asString(value.timeline_id);
    const sessionId = asString(value.session_id);
    if (!timelineId || !sessionId) return undefined;
    const at = asFiniteNumber(value.at);
    hits.push({
      timelineId,
      sessionId,
      kind: asString(value.kind) ?? 'unknown',
      ...(at !== undefined ? { at } : {}),
      snippet: asString(value.snippet) ?? '',
    });
  }
  return hits;
}

const READINESS: readonly HistorySearchReadiness[] = ['ready', 'building', 'catching-up', 'stale', 'failed'];

interface DaemonSearchState {
  readiness: HistorySearchReadiness;
  progress?: { done: number; total: number };
}

function decodeSearchState(value: unknown): DaemonSearchState | undefined {
  if (!isRecord(value)) return undefined;
  const readiness = asString(value.readiness) as HistorySearchReadiness | undefined;
  if (!readiness || !READINESS.includes(readiness)) return undefined;
  const progress = isRecord(value.progress) ? value.progress : undefined;
  const done = progress ? asFiniteNumber(progress.documents_done) : undefined;
  const total = progress ? asFiniteNumber(progress.documents_total) : undefined;
  return {
    readiness,
    ...(done !== undefined && total !== undefined ? { progress: { done, total } } : {}),
  };
}

/** A daemon answer that may carry hits: ready, or behind but consistent. */
function answers(readiness: HistorySearchReadiness): boolean {
  return readiness === 'ready' || readiness === 'catching-up';
}

/* ── the service ───────────────────────────────────────────────────────── */

export interface HistorySearchServiceOptions {
  fetch: typeof fetch;
  /** Rechecked across awaits; one operation never mixes daemon generations. */
  origin(): ResolvedHistoryOrigin | undefined;
  now?: () => number;
  requestTimeoutMs?: number;
}

export interface HistorySearchService {
  status(): Promise<HistorySearchStatus>;
  /** Title, summary, cwd, and canonical ids for live runs, by provider-native id. */
  facts(nativeSessionIds: readonly string[]): Promise<HistorySessionFacts[]>;
  search(request: HistorySearchRequest): Promise<HistorySearchResponse>;
}

type Failure = { ok: false; failure: string; reachable: boolean };
type Result<T> = { ok: true; value: T } | Failure;
type Call = Result<{ version: number; body: unknown }>;

function failure(message: string, reachable = true): Failure {
  return { ok: false, failure: message, reachable };
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError')
      return 'the history daemon did not answer in time';
    const cause = (error as Error & { cause?: { code?: string } }).cause;
    if (cause?.code === 'ECONNREFUSED') return 'no history daemon is listening';
    return error.message;
  }
  return String(error);
}

export function createHistorySearchService(options: HistorySearchServiceOptions): HistorySearchService {
  const now = options.now ?? Date.now;
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  interface SessionCache {
    canonical: Map<string, DaemonSessionRow>;
    native: Map<string, { row?: DaemonSessionRow; at: number }>;
  }
  interface DaemonContext {
    target: ResolvedHistoryOrigin;
    version?: { value: number; at: number };
    startedAt?: number | null;
    projectionEpoch?: string | null;
    canonicalReady?: boolean;
    search?: DaemonSearchState;
    cache: SessionCache;
  }

  function emptyCache(): SessionCache {
    return { canonical: new Map(), native: new Map() };
  }

  let active: DaemonContext | undefined;

  /** A new selection owns fresh caches; late requests retain only their old context. */
  function selectedDaemon(): DaemonContext | undefined {
    const target = options.origin();
    const origin = validateHistoryOrigin(target?.origin);
    if (!target || !origin) {
      active = undefined;
      return undefined;
    }
    if (!active || active.target.origin !== origin || active.target.generation !== target.generation) {
      active = { target: { ...target, origin }, cache: emptyCache() };
    } else {
      active.target = { ...target, origin };
    }
    return active;
  }

  function invalidated(daemon: DaemonContext, cache?: SessionCache): Failure | undefined {
    if (selectedDaemon() !== daemon) return failure('the history daemon changed during the request; try again', false);
    if (cache && daemon.cache !== cache) return failure('the history index changed during the request; try again');
    return undefined;
  }

  /** A restart or projection rebuild also invalidates identities at an unchanged origin. */
  function observe(daemon: DaemonContext, version: number, body: unknown): void {
    const record = isRecord(body) ? body : {};
    const state = isRecord(record.search) ? record.search : isRecord(record.state) ? record.state : undefined;
    const epoch =
      typeof state?.projection_epoch === 'string' || state?.projection_epoch === null
        ? state.projection_epoch
        : undefined;
    const startedAt = isRecord(record.daemon)
      ? asFiniteNumber(record.daemon.started_at)
      : record.daemon === null
        ? null
        : undefined;
    const changed =
      (daemon.version !== undefined && daemon.version.value !== version) ||
      (epoch !== undefined && daemon.projectionEpoch !== undefined && epoch !== daemon.projectionEpoch) ||
      (startedAt !== undefined && daemon.startedAt !== undefined && startedAt !== daemon.startedAt);
    if (changed) {
      daemon.cache = emptyCache();
      daemon.search = undefined;
      daemon.canonicalReady = undefined;
    }
    daemon.version = { value: version, at: now() };
    if (epoch !== undefined) daemon.projectionEpoch = epoch;
    if (startedAt !== undefined) daemon.startedAt = startedAt;
    if (typeof record.canonical_ready === 'boolean') daemon.canonicalReady = record.canonical_ready;
    const search = decodeSearchState(state);
    if (search) daemon.search = search;
  }

  /** All legs of an operation use the selected origin, never a newly resolved one. */
  async function call(daemon: DaemonContext, path: string, cache?: SessionCache): Promise<Call> {
    const startingCache = cache ?? daemon.cache;
    const obsolete = invalidated(daemon, startingCache);
    if (obsolete) return obsolete;
    try {
      const response = await options.fetch(daemon.target.origin + path, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
        headers: { accept: 'application/json' },
      });
      const superseded = invalidated(daemon, startingCache);
      if (superseded) return superseded;
      const header = response.headers.get(PROTOCOL_HEADER);
      const version = header === null || header.trim() === '' ? Number.NaN : Number(header);
      if (!Number.isInteger(version) || version < HISTORY_PROTOCOL_MIN || version > HISTORY_PROTOCOL_MAX) {
        daemon.version = undefined;
        daemon.cache = emptyCache();
        daemon.search = undefined;
        daemon.canonicalReady = undefined;
        return failure(
          `the history daemon speaks protocol ${Number.isNaN(version) ? 'unknown' : version}; this Godview understands ${HISTORY_PROTOCOL_MIN} to ${HISTORY_PROTOCOL_MAX}`,
          false,
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (response.ok) return failure('the history daemon returned invalid JSON: ' + describeFailure(error));
      }
      const replaced = invalidated(daemon, startingCache);
      if (replaced) return replaced;
      observe(daemon, version, response.ok ? body : undefined);
      const changed = invalidated(daemon, cache);
      if (changed) return changed;
      if (!response.ok) {
        const message = isRecord(body) && isRecord(body.error) ? asString(body.error.message) : undefined;
        return failure(message ?? 'the history daemon answered ' + response.status);
      }
      return { ok: true, value: { version, body } };
    } catch (error) {
      return invalidated(daemon, startingCache) ?? failure(describeFailure(error), false);
    }
  }

  function statusOf(daemon?: DaemonContext, error?: Failure): HistorySearchStatus {
    return {
      ...(daemon ? { origin: daemon.target.origin, source: daemon.target.source } : {}),
      reachable: error ? error.reachable : daemon !== undefined,
      ...(daemon?.version
        ? {
            protocolVersion: daemon.version.value,
            capabilities: { sessionScope: daemon.version.value >= 18, prefix: daemon.version.value >= 18 },
          }
        : {}),
      ...(daemon?.canonicalReady !== undefined ? { canonicalReady: daemon.canonicalReady } : {}),
      ...(daemon?.search ? { readiness: daemon.search.readiness } : {}),
      ...(daemon?.search?.progress ? { progress: daemon.search.progress } : {}),
      ...(error ? { detail: error.failure } : !daemon ? { detail: 'no history daemon is configured' } : {}),
      checkedAt: new Date(now()).toISOString(),
    };
  }

  function unanswered(daemon?: DaemonContext, error?: Failure): HistorySearchResponse {
    return { status: statusOf(daemon, error), answered: false, hits: [], clipped: false };
  }

  async function readStatus(daemon: DaemonContext): Promise<Result<number>> {
    const result = await call(daemon, '/api/status');
    if (!result.ok) return result;
    const { body, version } = result.value;
    if (!isRecord(body) || typeof body.canonical_ready !== 'boolean' || !decodeSearchState(body.search)) {
      return failure('the history daemon returned an invalid status response');
    }
    return { ok: true, value: version };
  }

  async function identity(daemon: DaemonContext): Promise<Result<number>> {
    const known = daemon.version;
    return known && now() - known.at < VERSION_TTL_MS ? { ok: true, value: known.value } : readStatus(daemon);
  }

  async function status(): Promise<HistorySearchStatus> {
    const daemon = selectedDaemon();
    if (!daemon) return statusOf();
    const result = await readStatus(daemon);
    return statusOf(daemon, result.ok ? undefined : result);
  }

  function factsOf(row: DaemonSessionRow): HistorySessionFacts {
    return {
      nativeSessionId: row.nativeSessionId,
      sessionId: row.id,
      rootSessionId: row.rootSessionId,
      ...(row.title ? { title: row.title } : {}),
      ...(row.summary ? { summary: row.summary } : {}),
      ...(row.cwd ? { cwd: row.cwd } : {}),
      updatedAt: row.updatedAt,
      streamState: row.streamState,
    };
  }

  async function lookupRows(
    daemon: DaemonContext,
    cache: SessionCache,
    version: number,
    nativeSessionIds: readonly string[],
  ): Promise<Result<Map<string, DaemonSessionRow>>> {
    const found = new Map<string, DaemonSessionRow>();
    const wanted = new Set(nativeSessionIds);
    const chunkSize = version >= 18 ? NATIVE_LOOKUP_CHUNK : nativeSessionIds.length;
    for (let start = 0; start < nativeSessionIds.length; start += chunkSize) {
      const chunk = nativeSessionIds.slice(start, start + chunkSize);
      const path =
        version >= 18
          ? `/api/sessions?native_session_id=${encodeURIComponent(chunk.join(','))}&limit=${V17_LIST_LIMIT}`
          : `/api/sessions?limit=${V17_LIST_LIMIT}`;
      const result = await call(daemon, path, cache);
      if (!result.ok) return result;
      const rows = decodeSessionRows(result.value.body);
      if (!rows) return failure('the history daemon returned an invalid session list');
      for (const row of rows) {
        if (!wanted.has(row.nativeSessionId)) continue;
        const existing = found.get(row.nativeSessionId);
        // A native id can name a child; the root's own row wins for the join.
        if (!existing || (existing.parentSessionId && !row.parentSessionId)) found.set(row.nativeSessionId, row);
      }
    }
    return { ok: true, value: found };
  }

  /** Failed refreshes retain previous facts and never become cached misses. */
  async function cachedRows(
    daemon: DaemonContext,
    cache: SessionCache,
    version: number,
    nativeSessionIds: readonly string[],
  ): Promise<{ rows: Map<string, DaemonSessionRow>; error?: Failure }> {
    const stale = nativeSessionIds.filter((id) => {
      const cached = cache.native.get(id);
      return !cached || now() - cached.at >= (cached.row ? FACTS_TTL_MS : MISS_TTL_MS);
    });
    let error: Failure | undefined;
    if (stale.length > 0) {
      const result = await lookupRows(daemon, cache, version, stale);
      error = result.ok ? invalidated(daemon, cache) : result;
      if (result.ok && !error) {
        const at = now();
        for (const id of stale) {
          const row = result.value.get(id);
          if (row) cache.canonical.set(row.id, row);
          // A cold projection has not proved that an absent session is missing.
          if (row || daemon.canonicalReady === true) cache.native.set(id, { ...(row ? { row } : {}), at });
        }
      }
    }
    const rows = new Map<string, DaemonSessionRow>();
    for (const id of nativeSessionIds) {
      const row = cache.native.get(id)?.row;
      if (row) rows.set(id, row);
    }
    return { rows, ...(error ? { error } : {}) };
  }

  async function facts(nativeSessionIds: readonly string[]): Promise<HistorySessionFacts[]> {
    const daemon = selectedDaemon();
    if (!daemon || nativeSessionIds.length === 0) return [];
    const who = await identity(daemon);
    const cache = daemon.cache;
    if (who.ok) await cachedRows(daemon, cache, who.value, nativeSessionIds);
    if (invalidated(daemon, cache)) return [];
    return nativeSessionIds.flatMap((id) => {
      const row = cache.native.get(id)?.row;
      return row ? [factsOf(row)] : [];
    });
  }

  async function sessionRow(
    daemon: DaemonContext,
    cache: SessionCache,
    sessionId: string,
    budget: { remaining: number },
  ): Promise<Result<DaemonSessionRow | undefined>> {
    const known = cache.canonical.get(sessionId);
    if (known) return { ok: true, value: known };
    if (budget.remaining <= 0) return { ok: true, value: undefined };
    budget.remaining -= 1;
    const result = await call(daemon, '/api/sessions/' + encodeURIComponent(sessionId), cache);
    if (!result.ok) return result;
    const row = isRecord(result.value.body) ? decodeSessionRow(result.value.body.session) : undefined;
    if (!row || row.id !== sessionId) return failure('the history daemon returned an invalid session');
    cache.canonical.set(row.id, row);
    return { ok: true, value: row };
  }

  async function rootOf(
    daemon: DaemonContext,
    cache: SessionCache,
    sessionId: string,
    budget: { remaining: number },
  ): Promise<Result<DaemonSessionRow | undefined>> {
    const result = await sessionRow(daemon, cache, sessionId, budget);
    if (!result.ok || !result.value || result.value.rootSessionId === result.value.id) return result;
    return sessionRow(daemon, cache, result.value.rootSessionId, budget);
  }

  async function search(request: HistorySearchRequest): Promise<HistorySearchResponse> {
    const daemon = selectedDaemon();
    if (!daemon) return unanswered();
    const who = await identity(daemon);
    if (!who.ok) return unanswered(daemon, who);
    const cache = daemon.cache;
    const version = who.value;
    const query = normalizeHistoryQuery(request.query);
    if (query === '') return { status: statusOf(daemon), answered: true, hits: [], clipped: false };

    const scoped = request.nativeSessionIds.length > 0;
    const live = scoped
      ? await cachedRows(daemon, cache, version, request.nativeSessionIds)
      : { rows: new Map<string, DaemonSessionRow>() };
    if (live.error) return unanswered(daemon, live.error);
    const obsolete = invalidated(daemon, cache);
    if (obsolete) return unanswered(daemon, obsolete);
    const roots = new Map<string, DaemonSessionRow>();
    for (const row of live.rows.values()) {
      const root = row.rootSessionId === row.id ? row : (cache.canonical.get(row.rootSessionId) ?? row);
      roots.set(root.id, root);
    }
    if (scoped && roots.size === 0) {
      // Session lists carry no readiness. Probe before calling an empty list a real answer.
      const checked = await readStatus(daemon);
      if (!checked.ok) return unanswered(daemon, checked);
      const changed = invalidated(daemon, cache);
      if (changed) return unanswered(daemon, changed);
      if (!daemon.canonicalReady || !daemon.search || !answers(daemon.search.readiness)) return unanswered(daemon);
      return {
        status: { ...statusOf(daemon), detail: 'none of the live sessions are in the history index yet' },
        answered: true,
        hits: [],
        clipped: false,
      };
    }

    const limit = request.limit ?? DEFAULT_SEARCH_LIMIT;
    const params = new URLSearchParams({ q: query });
    let effectiveLimit = limit;
    if (version >= 18) {
      if (scoped) params.set('sessions', [...roots.keys()].join(','));
      params.set('prefix', String(request.prefix ?? true));
      params.set('limit', String(limit));
    } else {
      // Protocol 17 cannot scope a set or expand delegated children.
      if (request.afterMs !== undefined) params.set('after_ts', String(request.afterMs));
      effectiveLimit = scoped ? V17_SEARCH_LIMIT : limit;
      params.set('limit', String(effectiveLimit));
    }
    const result = await call(daemon, '/api/search?' + params.toString(), cache);
    if (!result.ok) return unanswered(daemon, result);
    const body = result.value.body;
    const state = isRecord(body) ? decodeSearchState(body.state) : undefined;
    if (!state) return unanswered(daemon, failure('the history daemon returned an invalid search state'));
    if (!answers(state.readiness)) return unanswered(daemon);
    const raw = decodeHits(body);
    if (!raw) return unanswered(daemon, failure('the history daemon returned invalid search hits'));

    let clipped = raw.length >= effectiveLimit;
    const hits: HistorySearchHit[] = [];
    const budget = { remaining: MAX_CHILD_LOOKUPS_PER_SEARCH };
    for (const hit of raw) {
      let root = roots.get(hit.sessionId);
      if (!root) {
        if (scoped && version < 18) continue;
        const resolved = await rootOf(daemon, cache, hit.sessionId, budget);
        if (!resolved.ok) return unanswered(daemon, resolved);
        root = resolved.value;
        if (!root) clipped = true;
        if (scoped && (!root || !roots.has(root.id))) continue;
      }
      hits.push({
        sessionId: hit.sessionId,
        rootSessionId: root?.id ?? hit.sessionId,
        ...(root ? { nativeSessionId: root.nativeSessionId } : {}),
        ...(root?.title ? { title: root.title } : {}),
        timelineId: hit.timelineId,
        kind: hit.kind,
        ...(hit.at !== undefined ? { at: hit.at } : {}),
        snippet: hit.snippet,
      });
    }
    const changed = invalidated(daemon, cache);
    if (changed) return unanswered(daemon, changed);
    return { status: statusOf(daemon), answered: true, hits, clipped };
  }

  return { status, facts, search };
}
