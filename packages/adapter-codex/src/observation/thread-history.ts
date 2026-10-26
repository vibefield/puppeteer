/**
 * Codex thread history, read the way the app-server now wants it read.
 *
 * Since rust-v0.158.0 (#47900) every full-history hydration — `thread/resume` without
 * `excludeTurns`, and `thread/read` with `includeTurns` — answers with a deprecation notice
 * (0.164.0 census `history-hydration`). The replacement opens the live stream with
 * `thread/resume {threadId, excludeTurns: true}` and pages the turns with `thread/turns/list
 * {itemsView: 'full', sortDirection: 'asc'}` by `nextCursor`. `itemsView` must be `full`: its
 * default, `summary`, is "only a display summary" (the schema's `TurnItemsView`), which in the 0.164.0
 * survey left out a turn's `fileChange` item; and `sortDirection` must be `asc`, because the
 * default is newest first.
 *
 * Both were behind the `experimentalApi` capability until rust-v0.151.0, so 0.150.x and the
 * promoted 0.147.0 refuse them with -32600 "… requires experimentalApi capability" (0.150.0
 * pagination probe). Only that refusal, or a server that does not know the method, selects the
 * deprecated calls, once per connection.
 *
 * A page that fails any other way leaves only the OLDEST turns read, and replaying just those would
 * pass an older answer off as the latest one. So a page the server answered with an error gets one
 * full `thread/read` (on 0.158.0 and later at the cost of one native deprecation notice), and a page
 * it never answered (a timeout, a lost connection) gets no second request. Whatever is still
 * missing is reported as `incomplete`, never presented as the whole history.
 *
 * The walk is bounded (`CODEX_HISTORY_LIMITS`). `nextCursor` is the server's word, and the repeat
 * guard stops only a server that hands back a cursor already followed: one that kept minting new
 * cursors would be paged without end, each page another round trip held in memory before the
 * session can go ready. A history past either limit is kept as far as it was read and reported
 * `incomplete` like any other — no full `thread/read` follows, since that would load the very
 * history the limit refuses. The turn limit holds whichever call supplies the turns: a full
 * `thread/read` after a failed page, and the deprecated calls, keep their oldest `limits.turns` and
 * report the rest missing the same way.
 *
 * Replayed history is what Codex persisted, not what it streamed. Since rust-v0.162.0 (#50427,
 * #50458) a command's `aggregatedOutput` is capped at 64 KiB in persisted history — the first and
 * last 32 743 bytes around `\n... command output truncated for persistence ...\n`, even while the
 * thread is still loaded (probes/codex@0.164.0 Method 4) — and an oversized MCP result becomes a text
 * preview. A replayed `tool:completed` can therefore carry less output than the live one did; Core
 * has no way to mark it yet (findings C8, Known gaps).
 */

import { AppServerError, AppServerRequestTimeoutError, type AppServerClient } from '../transport/app-server-client.js';

/** Which history calls this connection's app-server accepts. */
type CodexHistoryApi = 'paginated' | 'full-hydration';

export interface CodexThreadHistoryRead {
  /** The thread's turns, oldest first, each with every item Codex persisted. */
  readonly turns: readonly unknown[];
  /** `thread.path` from a `thread/read` answer, when the deprecated read supplied the turns. */
  readonly path?: string | undefined;
  /** Set when `turns` is only the oldest part of the history (or none of it): why the rest is missing. */
  readonly incomplete?: { readonly reason: string } | undefined;
}

/** The model and effort a resume starts at, in place of the thread's own. */
export interface CodexResumeOverrides {
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}

const HISTORY_PAGE = { itemsView: 'full', sortDirection: 'asc' } as const;

/** How far one history read walks before it reports the rest missing. */
export interface CodexHistoryLimits {
  /** `thread/turns/list` pages one read requests. */
  readonly pages: number;
  /** Turns one read keeps. */
  readonly turns: number;
}

export const CODEX_HISTORY_LIMITS: CodexHistoryLimits = { pages: 1_000, turns: 10_000 };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/**
 * The refusal that means "this app-server predates paginated history": codex's experimental gate
 * and its unknown-method answer are both -32600 invalid requests; -32601 is JSON-RPC's own
 * method-not-found, which a server that does not serve the method may answer instead.
 */
export function refusesPaginatedHistory(error: unknown): boolean {
  if (!(error instanceof AppServerError)) return false;
  const { code, message } = error.body;
  if (code === -32601) return true;
  return code === -32600 && /requires experimentalApi capability|unknown variant/u.test(message);
}

/** Turns a full-hydration answer carries: a resume's `initialTurnsPage`, else `thread.turns`. */
export function turnsOf(response: Record<string, unknown> | undefined): readonly unknown[] {
  const page = rec(response?.initialTurnsPage);
  if (Array.isArray(page?.data) && page.data.length > 0) return page.data;
  const turns = rec(response?.thread)?.turns;
  return Array.isArray(turns) ? turns : [];
}

/** Why a history request failed, without the server's own text. */
function failureReason(error: unknown): string {
  if (error instanceof AppServerError) return `server error ${error.body.code}`;
  if (error instanceof AppServerRequestTimeoutError) return 'request timed out';
  return 'connection lost';
}

export class CodexThreadHistory {
  private current: CodexHistoryApi = 'paginated';
  /** Whether the last resume hydrated every turn, so that its answer is the whole history. */
  private resumeHydrated = false;

  constructor(
    private readonly client: AppServerClient,
    private readonly limits: CodexHistoryLimits = CODEX_HISTORY_LIMITS,
  ) {}

  /** `read` within the turn limit: a longer history keeps its oldest turns and says the rest is missing. */
  private bounded(read: CodexThreadHistoryRead): CodexThreadHistoryRead {
    if (read.turns.length <= this.limits.turns) return read;
    return {
      ...read,
      turns: read.turns.slice(0, this.limits.turns),
      incomplete: read.incomplete ?? { reason: `stopped at ${this.limits.turns} turns` },
    };
  }

  /**
   * Open the thread's live stream without hydrating its history. A server that refuses
   * `excludeTurns` gets the deprecated full resume; every other error is thrown to the caller, whose
   * attach loop already retries a thread that has no rollout yet.
   *
   * `overrides` is the model and effort the resume starts at. Both requests carry them: the
   * app-server applies a resume's overrides when it loads a thread it does not yet hold, and a TUI
   * that joins it later adopts the thread's settings, never its own (C7). Omitted, the request is
   * the thread id alone.
   */
  async resume(
    threadId: string,
    overrides?: CodexResumeOverrides | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    const selection = {
      ...(overrides?.model ? { model: overrides.model } : {}),
      ...(overrides?.effort ? { config: { model_reasoning_effort: overrides.effort } } : {}),
    };
    if (this.current === 'paginated') {
      try {
        const resumed = rec(await this.client.request('thread/resume', { threadId, excludeTurns: true, ...selection }));
        this.resumeHydrated = false;
        return resumed;
      } catch (error) {
        if (!refusesPaginatedHistory(error)) throw error;
        this.current = 'full-hydration';
      }
    }
    const resumed = rec(await this.client.request('thread/resume', { threadId, ...selection }));
    this.resumeHydrated = true;
    return resumed;
  }

  /**
   * Read every turn of the thread, oldest first. Never throws: history enrichment must not prevent
   * live attachment. When the whole history cannot be read, the turns that could be are returned
   * with `incomplete` set.
   */
  async read(threadId: string, resumed: Record<string, unknown> | undefined): Promise<CodexThreadHistoryRead> {
    if (this.current === 'paginated') {
      const turns: unknown[] = [];
      let failure: unknown;
      try {
        const cursors = new Set<string>();
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = rec(
            await this.client.request('thread/turns/list', {
              threadId,
              ...HISTORY_PAGE,
              ...(cursor === undefined ? {} : { cursor }),
            }),
          );
          pages += 1;
          const data = Array.isArray(page?.data) ? page.data : [];
          const room = this.limits.turns - turns.length;
          turns.push(...data.slice(0, room));
          const next = str(page?.nextCursor);
          // An empty page or a cursor already followed ends the walk, so a server cannot loop it.
          cursor = data.length > 0 && next !== undefined && !cursors.has(next) ? next : undefined;
          if (data.length > room || (cursor !== undefined && turns.length === this.limits.turns)) {
            return { turns, incomplete: { reason: `stopped at ${this.limits.turns} turns` } };
          }
          if (cursor !== undefined && pages === this.limits.pages) {
            return { turns, incomplete: { reason: `stopped after ${this.limits.pages} pages` } };
          }
          if (cursor !== undefined) cursors.add(cursor);
        } while (cursor !== undefined);
        return { turns };
      } catch (error) {
        if (refusesPaginatedHistory(error)) this.current = 'full-hydration';
        else failure = error;
      }
      if (failure !== undefined) {
        // The server answered, so it may answer the whole read; the connection stays paginated.
        if (failure instanceof AppServerError) {
          try {
            const read = rec(await this.client.request('thread/read', { threadId, includeTurns: true }));
            const all = rec(read?.thread)?.turns;
            if (Array.isArray(all)) return this.bounded({ turns: all, path: str(rec(read?.thread)?.path) });
          } catch {
            // The pages already read are all there is.
          }
        }
        return { turns, incomplete: { reason: failureReason(failure) } };
      }
    }
    try {
      const read = rec(await this.client.request('thread/read', { threadId, includeTurns: true }));
      return this.bounded({ turns: turnsOf(read ?? resumed), path: str(rec(read?.thread)?.path) });
    } catch (error) {
      // A hydrated resume already carried every turn; one without them leaves nothing to replay.
      return this.bounded({
        turns: turnsOf(resumed),
        ...(this.resumeHydrated ? {} : { incomplete: { reason: failureReason(error) } }),
      });
    }
  }
}
