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
 * Two daemon generations are spoken. Protocol 18 answers one question for a
 * whole set of sessions, widens word fragments, and resolves native ids
 * directly. Protocol 17 has none of that, so the same questions are asked the
 * long way: a time-bounded search filtered here, and a listing of recent
 * sessions filtered here. A non-ready daemon answer is reported as
 * unanswered, never as "no matches", so a sheet can hold what it last showed.
 *
 * The daemon has no authentication; its loopback bind and origin policy are
 * the whole boundary. An origin therefore has to be a loopback http URL and
 * nothing else, wherever it came from.
 */

export const HISTORY_PROTOCOL_MIN = 17;
export const HISTORY_PROTOCOL_MAX = 18;
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

/** A setting wins over the environment, which wins over what a daemon announced, which wins over the app default. */
export function resolveHistoryOrigin(sources: HistoryOriginSources): { origin: string; source: HistoryOriginSource } {
  const configured = validateHistoryOrigin(sources.configured);
  if (configured) return { origin: configured, source: 'setting' };
  const environment = validateHistoryOrigin(sources.environment);
  if (environment) return { origin: environment, source: 'environment' };
  const announced = sources.announced.find(
    (candidate) =>
      candidate.protocolVersion >= HISTORY_PROTOCOL_MIN && candidate.protocolVersion <= HISTORY_PROTOCOL_MAX,
  );
  if (announced) return { origin: announced.origin, source: 'announcement' };
  return { origin: DEFAULT_HISTORY_ORIGIN, source: 'default' };
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

function decodeSessionRows(body: unknown): DaemonSessionRow[] {
  if (!isRecord(body) || !Array.isArray(body.sessions)) return [];
  return body.sessions.map(decodeSessionRow).filter((row): row is DaemonSessionRow => row !== undefined);
}

interface DaemonHit {
  timelineId: string;
  sessionId: string;
  kind: string;
  at?: number;
  snippet: string;
}

function decodeHits(body: unknown): DaemonHit[] {
  if (!isRecord(body) || !Array.isArray(body.hits)) return [];
  const hits: DaemonHit[] = [];
  for (const value of body.hits) {
    if (!isRecord(value)) continue;
    const timelineId = asString(value.timeline_id);
    const sessionId = asString(value.session_id);
    if (!timelineId || !sessionId) continue;
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
  /** Resolved on every call, so a daemon that restarts on another port is followed. */
  origin(): { origin: string; source: HistoryOriginSource } | undefined;
  now?: () => number;
  requestTimeoutMs?: number;
}

export interface HistorySearchService {
  status(): Promise<HistorySearchStatus>;
  /** Title, summary, cwd, and canonical ids for live runs, by provider-native id. */
  facts(nativeSessionIds: readonly string[]): Promise<HistorySessionFacts[]>;
  search(request: HistorySearchRequest): Promise<HistorySearchResponse>;
}

type Call = { ok: true; version: number; body: unknown } | { ok: false; failure: string; status?: number };

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
  const versionByOrigin = new Map<string, { version: number; at: number }>();
  const rowsByCanonicalId = new Map<string, DaemonSessionRow>();
  const factsByNativeId = new Map<string, { row?: DaemonSessionRow; at: number }>();

  async function call(path: string): Promise<Call & { origin?: string; source?: HistoryOriginSource }> {
    const resolved = options.origin();
    if (!resolved) return { ok: false, failure: 'no history daemon is configured' };
    const { origin, source } = resolved;
    try {
      const response = await options.fetch(`${origin}${path}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json' },
      });
      const version = Number(response.headers.get(PROTOCOL_HEADER));
      if (!Number.isInteger(version) || version < HISTORY_PROTOCOL_MIN || version > HISTORY_PROTOCOL_MAX) {
        return {
          ok: false,
          origin,
          source,
          failure: `the history daemon speaks protocol ${Number.isNaN(version) ? 'unknown' : version}; this Godview understands ${HISTORY_PROTOCOL_MIN} to ${HISTORY_PROTOCOL_MAX}`,
        };
      }
      versionByOrigin.set(origin, { version, at: now() });
      if (!response.ok) {
        let message = `the history daemon answered ${response.status}`;
        try {
          const body = (await response.json()) as unknown;
          if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
            message = body.error.message;
          }
        } catch {
          // The status line is the message.
        }
        return { ok: false, origin, source, failure: message, status: response.status };
      }
      return { ok: true, origin, source, version, body: (await response.json()) as unknown };
    } catch (error) {
      return { ok: false, origin, source, failure: describeFailure(error) };
    }
  }

  async function protocolVersion(): Promise<number | undefined> {
    const resolved = options.origin();
    if (!resolved) return undefined;
    const known = versionByOrigin.get(resolved.origin);
    if (known && now() - known.at < VERSION_TTL_MS) return known.version;
    const result = await call('/api/status');
    return result.ok ? result.version : undefined;
  }

  function rememberRow(row: DaemonSessionRow): void {
    rowsByCanonicalId.set(row.id, row);
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

  async function status(): Promise<HistorySearchStatus> {
    const checkedAt = new Date(now()).toISOString();
    const result = await call('/api/status');
    if (!result.ok) {
      return {
        ...(result.origin ? { origin: result.origin, source: result.source } : {}),
        reachable: false,
        detail: result.failure,
        checkedAt,
      };
    }
    const body = isRecord(result.body) ? result.body : {};
    const search = decodeSearchState(body.search);
    return {
      origin: result.origin,
      source: result.source,
      reachable: true,
      protocolVersion: result.version,
      capabilities: { sessionScope: result.version >= 18, prefix: result.version >= 18 },
      ...(typeof body.canonical_ready === 'boolean' ? { canonicalReady: body.canonical_ready } : {}),
      ...(search ? { readiness: search.readiness } : {}),
      ...(search?.progress ? { progress: search.progress } : {}),
      checkedAt,
    };
  }

  async function lookupRows(nativeSessionIds: readonly string[]): Promise<Map<string, DaemonSessionRow>> {
    const found = new Map<string, DaemonSessionRow>();
    if (nativeSessionIds.length === 0) return found;
    const version = await protocolVersion();
    if (version === undefined) return found;
    if (version >= 18) {
      for (let start = 0; start < nativeSessionIds.length; start += NATIVE_LOOKUP_CHUNK) {
        const chunk = nativeSessionIds.slice(start, start + NATIVE_LOOKUP_CHUNK);
        const result = await call(
          `/api/sessions?native_session_id=${encodeURIComponent(chunk.join(','))}&limit=${V17_LIST_LIMIT}`,
        );
        if (!result.ok) continue;
        for (const row of decodeSessionRows(result.body)) {
          rememberRow(row);
          // A native id can name a child; the root's own row wins for the join.
          const existing = found.get(row.nativeSessionId);
          if (!existing || (existing.parentSessionId && !row.parentSessionId)) found.set(row.nativeSessionId, row);
        }
      }
      return found;
    }
    const result = await call(`/api/sessions?limit=${V17_LIST_LIMIT}`);
    if (!result.ok) return found;
    const wanted = new Set(nativeSessionIds);
    for (const row of decodeSessionRows(result.body)) {
      rememberRow(row);
      if (wanted.has(row.nativeSessionId)) found.set(row.nativeSessionId, row);
    }
    return found;
  }

  /** Rows for live runs, through a short cache so a keystroke never relists sessions. */
  async function cachedRows(nativeSessionIds: readonly string[]): Promise<Map<string, DaemonSessionRow>> {
    const at = now();
    const stale = nativeSessionIds.filter((id) => {
      const cached = factsByNativeId.get(id);
      return !cached || at - cached.at >= FACTS_TTL_MS;
    });
    if (stale.length > 0) {
      const rows = await lookupRows(stale);
      for (const id of stale) {
        const row = rows.get(id);
        factsByNativeId.set(id, { ...(row ? { row } : {}), at });
      }
    }
    const result = new Map<string, DaemonSessionRow>();
    for (const id of nativeSessionIds) {
      const row = factsByNativeId.get(id)?.row;
      if (row) result.set(id, row);
    }
    return result;
  }

  async function facts(nativeSessionIds: readonly string[]): Promise<HistorySessionFacts[]> {
    const rows = await cachedRows(nativeSessionIds);
    return nativeSessionIds.flatMap((id) => {
      const row = rows.get(id);
      return row ? [factsOf(row)] : [];
    });
  }

  async function rootOf(sessionId: string, budget: { remaining: number }): Promise<DaemonSessionRow | undefined> {
    const known = rowsByCanonicalId.get(sessionId);
    if (known) return known.rootSessionId === known.id ? known : (rowsByCanonicalId.get(known.rootSessionId) ?? known);
    if (budget.remaining <= 0) return undefined;
    budget.remaining -= 1;
    const result = await call(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!result.ok || !isRecord(result.body)) return undefined;
    const row = decodeSessionRow(result.body.session);
    if (!row) return undefined;
    rememberRow(row);
    if (row.rootSessionId === row.id) return row;
    const root = rowsByCanonicalId.get(row.rootSessionId);
    if (root) return root;
    if (budget.remaining <= 0) return row;
    budget.remaining -= 1;
    const rootResult = await call(`/api/sessions/${encodeURIComponent(row.rootSessionId)}`);
    if (rootResult.ok && isRecord(rootResult.body)) {
      const rootRow = decodeSessionRow(rootResult.body.session);
      if (rootRow) {
        rememberRow(rootRow);
        return rootRow;
      }
    }
    return row;
  }

  async function search(request: HistorySearchRequest): Promise<HistorySearchResponse> {
    const query = normalizeHistoryQuery(request.query);
    const current = await status();
    if (!current.reachable || current.protocolVersion === undefined) {
      return { status: current, answered: false, hits: [], clipped: false };
    }
    if (query === '') return { status: current, answered: true, hits: [], clipped: false };

    // The live runs' canonical roots, when the caller scoped to live runs.
    const scoped = request.nativeSessionIds.length > 0;
    const liveRows = scoped ? await cachedRows(request.nativeSessionIds) : new Map<string, DaemonSessionRow>();
    const roots = new Map<string, DaemonSessionRow>();
    for (const row of liveRows.values()) {
      const root = row.rootSessionId === row.id ? row : (rowsByCanonicalId.get(row.rootSessionId) ?? row);
      roots.set(root.id, root);
    }
    if (scoped && roots.size === 0) {
      return {
        status: { ...current, detail: 'none of the live sessions are in the history index yet' },
        answered: true,
        hits: [],
        clipped: false,
      };
    }

    const limit = request.limit ?? DEFAULT_SEARCH_LIMIT;
    const params = new URLSearchParams({ q: query });
    let effectiveLimit = limit;
    if (current.protocolVersion >= 18) {
      if (scoped) params.set('sessions', [...roots.keys()].join(','));
      params.set('prefix', String(request.prefix ?? true));
      params.set('limit', String(limit));
    } else {
      // Protocol 17 knows one session at a time and no prefix: ask once,
      // bounded by the earliest live start, and keep only the sessions asked
      // for. Delegated children cannot be attributed without the expansion.
      if (request.afterMs !== undefined) params.set('after_ts', String(request.afterMs));
      effectiveLimit = scoped ? V17_SEARCH_LIMIT : limit;
      params.set('limit', String(effectiveLimit));
    }
    const result = await call(`/api/search?${params.toString()}`);
    if (!result.ok) {
      return { status: { ...current, detail: result.failure }, answered: false, hits: [], clipped: false };
    }
    const body = isRecord(result.body) ? result.body : {};
    const state = decodeSearchState(body.state);
    const readiness = state?.readiness ?? 'failed';
    const statusNow: HistorySearchStatus = {
      ...current,
      readiness,
      ...(state?.progress ? { progress: state.progress } : {}),
    };
    if (!answers(readiness)) return { status: statusNow, answered: false, hits: [], clipped: false };

    const raw = decodeHits(body);
    const clipped = raw.length >= effectiveLimit;
    const hits: HistorySearchHit[] = [];
    const budget = { remaining: MAX_CHILD_LOOKUPS_PER_SEARCH };
    for (const hit of raw) {
      let root = roots.get(hit.sessionId);
      if (!root) {
        if (scoped && current.protocolVersion < 18) continue;
        root = await rootOf(hit.sessionId, budget);
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
    return { status: statusNow, answered: true, hits, clipped };
  }

  return { status, facts, search };
}
