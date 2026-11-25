/**
 * Keeps a briefed run's MCP servers on its session (2026-11-24, Grok Build 1.0.92).
 *
 * Under a leader, a session's MCP servers are the servers the leader merges from the person's own configuration plus
 * the servers the LAST client to load the session named. The controller names the run's servers on ACP session/new,
 * and the run's leader starts them; then the native viewer joins by `--resume`, its own ACP session/load names the
 * servers the viewer discovers itself, and the leader ends the run's ("Updating MCP servers", and on the controller
 * `_x.ai/mcp/server_status {status: unavailable, reason: config_removed}`). Neither a session plugin folder
 * (`_meta.pluginDirs`: discovered, attaches no server) nor a config overlay on the viewer (`GROK_CONFIG`: its MCP table
 * is dropped) gives the viewer's load the run's servers.
 *
 * So the removal is answered: a short-lived client of the run's own leader loads the session with the run's servers and
 * leaves. The leader puts them back beside the merged ones, which it neither drops nor restarts, and they stay after
 * that client has gone. All of this is read in the isolated live rig (briefing.live.test.ts).
 */

/** The leader's per-server status notification, as adapter-acp hands an extension notification over. */
const SERVER_STATUS = new Set(['_x.ai/mcp/server_status', 'x.ai/mcp/server_status']);

/** A client that keeps loading the session without the run's servers wins after this many puts a minute. */
export const BRIEFED_SERVER_REASSERTS_PER_MINUTE = 5;

export interface BriefedServerKeeperOptions {
  /** The servers the run declared, by name. */
  readonly names: ReadonlySet<string>;
  /** The run's session, once control holds it. */
  sessionId(): string | undefined;
  /** One load of the session that names the run's servers, by a client that then leaves. */
  reassert(): Promise<void>;
  readonly now?: () => number;
}

export interface BriefedServerKeeper {
  /** Every extension notification the controller hears, before normalization. */
  observe(method: string, params: Record<string, unknown>): void;
  /** No put after this; waits for one in flight. */
  dispose(): Promise<void>;
}

export function createBriefedServerKeeper(options: BriefedServerKeeperOptions): BriefedServerKeeper {
  const now = options.now ?? Date.now;
  const recent: number[] = [];
  let inFlight: Promise<void> | undefined;
  let again = false;
  let disposed = false;

  function put(): void {
    if (disposed) return;
    if (inFlight) {
      again = true;
      return;
    }
    const at = now();
    while (recent.length > 0 && at - recent[0]! >= 60_000) recent.shift();
    if (recent.length >= BRIEFED_SERVER_REASSERTS_PER_MINUTE) return;
    recent.push(at);
    inFlight = options
      .reassert()
      .catch(() => undefined)
      .finally(() => {
        inFlight = undefined;
        if (!again) return;
        again = false;
        put();
      });
  }

  return {
    observe(method, params) {
      if (disposed || !SERVER_STATUS.has(method)) return;
      const sessionId = options.sessionId();
      if (sessionId === undefined || params.sessionId !== sessionId) return;
      if (typeof params.name !== 'string' || !options.names.has(params.name)) return;
      if (params.status !== 'unavailable' || params.reason !== 'config_removed') return;
      put();
    },
    async dispose() {
      disposed = true;
      again = false;
      await inFlight;
    },
  };
}
