/*
 * Transcript history, read from an external daemon that indexes every installed
 * agent's own session records (RFC 007). The find sheet joins its answers to
 * live runs by the provider-native session id; nothing here names a provider,
 * and nothing here dials anything: a HOST supplies the port. Godview's port is
 * its main-process client over IPC; VibeField's is its daemon's index doors.
 */

export type HistorySearchReadiness = 'ready' | 'building' | 'catching-up' | 'stale' | 'failed';
export type HistoryOriginSource = 'setting' | 'environment' | 'announcement' | 'default';

export interface HistorySearchStatus {
  origin?: string;
  source?: HistoryOriginSource;
  reachable: boolean;
  protocolVersion?: number;
  /** What this daemon generation can do; older ones are answered the long way. */
  capabilities?: { sessionScope: boolean; prefix: boolean };
  canonicalReady?: boolean;
  readiness?: HistorySearchReadiness;
  progress?: { done: number; total: number };
  /** One sentence for the sheet's foot when something is off. */
  detail?: string;
  checkedAt: string;
}

/** What the history daemon knows about one live run, by its provider-native id. */
export interface HistorySessionFacts {
  nativeSessionId: string;
  sessionId: string;
  rootSessionId: string;
  title?: string;
  summary?: string;
  cwd?: string;
  updatedAt: number;
  streamState: string;
}

export interface HistorySearchRequest {
  query: string;
  /** Provider-native ids of the live runs to scope to; empty means everything the daemon knows. */
  nativeSessionIds: string[];
  /** Earliest live start, so a daemon without session scope narrows by time instead. */
  afterMs?: number;
  limit?: number;
  /** Widen word fragments; on by default where the daemon supports it. */
  prefix?: boolean;
}

/** One transcript row the history daemon matched, attributed to its navigable root
 * when the daemon could name one. */
export interface HistorySearchHit {
  sessionId: string;
  /** The root this row rolls up to; ABSENT when the daemon could not attribute
   * it — a hit is never its own root by default, that would be a guess. */
  rootSessionId?: string;
  /** The root's provider-native id: the join key to a live run. */
  nativeSessionId?: string;
  title?: string;
  timelineId: string;
  /** `user` or `agent`; anything else is shown as itself. */
  kind: string;
  at?: number;
  /** Matches are marked with `[` and `]`. */
  snippet: string;
}

export interface HistorySearchResponse {
  status: HistorySearchStatus;
  /** False when the daemon had no answer; a sheet keeps what it last showed rather than saying "no matches". */
  answered: boolean;
  hits: HistorySearchHit[];
  /** The daemon clipped at its limit, so some sessions may be under-reported. */
  clipped: boolean;
}

/** The three questions the find sheet asks, answered by whichever daemon the host reaches. */
export interface HistoryPort {
  /** Liveness and readiness of the transcript history daemon. */
  status(): Promise<HistorySearchStatus>;
  /** Titles and canonical ids for live runs, by provider-native session id. */
  facts(nativeSessionIds: string[]): Promise<HistorySessionFacts[]>;
  /** Words said or heard in live sessions, joined back to their runs. */
  search(request: HistorySearchRequest): Promise<HistorySearchResponse>;
}
