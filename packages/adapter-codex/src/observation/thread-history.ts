/**
 * Codex thread history, read the way the app-server now wants it read.
 *
 * Since rust-v0.158.0 (#47900) every full-history hydration — `thread/resume` without
 * `excludeTurns`, and `thread/read` with `includeTurns` — answers with a deprecation notice
 * (0.164.0 census `history-hydration`). The replacement opens the live stream with
 * `thread/resume {threadId, excludeTurns: true}` and pages the turns with `thread/turns/list
 * {itemsView: 'full', sortDirection: 'asc'}` by `nextCursor`. `itemsView` must be `full`: its
 * default, `summary`, drops tool and file-change items; and `sortDirection` must be `asc`, because
 * the default is newest first.
 *
 * Both were behind the `experimentalApi` capability until rust-v0.151.0, so 0.150.x and the
 * promoted 0.147.0 refuse them with -32600 "… requires experimentalApi capability" (0.150.0
 * pagination probe). Only that refusal, or a server that does not know the method, selects the
 * deprecated calls, once per connection. Any other failure is the server's answer and is not
 * retried another way.
 *
 * Replayed history is what Codex persisted, not what it streamed. Since rust-v0.162.0 (#50427,
 * #50458) a command's `aggregatedOutput` is capped at 64 KiB in persisted history — the first and
 * last 32 743 bytes around `\n... command output truncated for persistence ...\n`, even while the
 * thread is still loaded (probes/codex@0.164.0 Method 4) — and an oversized MCP result becomes a text
 * preview. A replayed `tool:completed` can therefore carry less output than the live one did; Core
 * has no way to mark it yet (findings C8, Known gaps).
 */

import { AppServerError, type AppServerClient } from '../transport/app-server-client.js';

/** Which history calls this connection's app-server accepts. */
type CodexHistoryApi = 'paginated' | 'full-hydration';

export interface CodexThreadHistoryRead {
  /** The thread's turns, oldest first, each with every item Codex persisted. */
  readonly turns: readonly unknown[];
  /** `thread.path` from a `thread/read` answer, when the deprecated read supplied the turns. */
  readonly path?: string | undefined;
}

const HISTORY_PAGE = { itemsView: 'full', sortDirection: 'asc' } as const;

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

export class CodexThreadHistory {
  private current: CodexHistoryApi = 'paginated';

  constructor(private readonly client: AppServerClient) {}

  /**
   * Open the thread's live stream without hydrating its history. A server that refuses
   * `excludeTurns` gets the deprecated full resume; every other error is thrown to the caller, whose
   * attach loop already retries a thread that has no rollout yet.
   */
  async resume(threadId: string): Promise<Record<string, unknown> | undefined> {
    if (this.current === 'paginated') {
      try {
        return rec(await this.client.request('thread/resume', { threadId, excludeTurns: true }));
      } catch (error) {
        if (!refusesPaginatedHistory(error)) throw error;
        this.current = 'full-hydration';
      }
    }
    return rec(await this.client.request('thread/resume', { threadId }));
  }

  /**
   * Read every turn of the thread, oldest first. Never throws: history enrichment must not prevent
   * live attachment. When a page fails for any reason but the paginated-history refusal, the pages
   * already read are kept — they are the oldest turns, in order.
   */
  async read(threadId: string, resumed: Record<string, unknown> | undefined): Promise<CodexThreadHistoryRead> {
    if (this.current === 'paginated') {
      const turns: unknown[] = [];
      try {
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = rec(
            await this.client.request('thread/turns/list', {
              threadId,
              ...HISTORY_PAGE,
              ...(cursor === undefined ? {} : { cursor }),
            }),
          );
          const data = Array.isArray(page?.data) ? page.data : [];
          turns.push(...data);
          const next = str(page?.nextCursor);
          // An empty page or a cursor already followed ends the walk, so a server cannot loop it.
          cursor = data.length > 0 && next !== undefined && !cursors.has(next) ? next : undefined;
          if (cursor !== undefined) cursors.add(cursor);
        } while (cursor !== undefined);
        return { turns };
      } catch (error) {
        if (!refusesPaginatedHistory(error)) return { turns };
        this.current = 'full-hydration';
      }
    }
    try {
      const read = rec(await this.client.request('thread/read', { threadId, includeTurns: true }));
      return { turns: turnsOf(read ?? resumed), path: str(rec(read?.thread)?.path) };
    } catch {
      return { turns: turnsOf(resumed) };
    }
  }
}
