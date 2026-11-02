import { useLayoutEffect, useRef } from 'react';

export interface CompletedPaneSession {
  id: string;
  exited: boolean;
  exitOutcome: string | null;
  /** The terminal owner accepted the host's end-session request, even if exit
   * metadata or the agent row was withdrawn before the pane heard it. */
  endedByHost?: boolean | undefined;
}

export interface CompletedAgentPanePorts<Session extends CompletedPaneSession> {
  createShell: (ended: Session) => Promise<Session>;
  /** Compare with the workspace's current attachments, never the active pane. */
  replaceSession: (expectedId: string, shell: Session) => boolean;
  /** Resolves only once the host owns the conditional cleanup obligation. */
  releaseSession: (sessionId: string, condition: 'unused' | 'exited') => void | Promise<unknown>;
  onError: (cause: unknown) => void;
}

/** A clean native agent exit or accepted host termination returns its panes to one fresh shell.
 * The host supplies local managed sessions; monitor liveness is NOT exit evidence.
 * Failed exits without an explicit end keep their diagnostic surface. History is independent of PTY custody. */
export class CompletedAgentPanes<Session extends CompletedPaneSession> {
  private readonly attempts = new Map<string, { cancelled: boolean }>();
  private disposed = false;
  private readonly cleanup = new Map<string, { condition: 'unused' | 'exited'; active: boolean }>();

  update(sessions: readonly Session[], ports: CompletedAgentPanePorts<Session>): void {
    if (this.disposed) return;
    this.retryCleanup(ports);
    const completed = new Map(
      sessions
        .filter((session) => session.endedByHost === true || (session.exited && session.exitOutcome === 'completed'))
        .map((s) => [s.id, s]),
    );
    for (const [id, attempt] of this.attempts) {
      if (completed.has(id)) continue;
      attempt.cancelled = true;
      this.attempts.delete(id);
    }
    for (const [id, session] of completed) {
      if (this.attempts.has(id)) continue;
      const attempt = { cancelled: false };
      this.attempts.set(id, attempt);
      // Record the attempt before starting a birth: repeated metadata and mirrored panes
      // must not create multiple shells. A failure stays visible, without a retry loop.
      void (async () => {
        const shell = await ports.createShell(session);
        let placed = false;
        try {
          placed = !attempt.cancelled && ports.replaceSession(id, shell);
        } catch (cause) {
          // A stale host API or throwing mounter must not orphan the successful birth.
          try {
            await this.release(shell.id, 'unused', ports);
          } catch (releaseCause) {
            throw new AggregateError([cause, releaseCause], 'Pane replacement and shell cleanup failed');
          }
          throw cause;
        }
        if (!placed) {
          await this.release(shell.id, 'unused', ports);
          return;
        }
        // Only release the ended PTY after the replacement has a pane. No history deletion.
        await this.release(id, 'exited', ports);
      })().catch(ports.onError);
    }
  }

  private async release(
    id: string,
    condition: 'unused' | 'exited',
    ports: CompletedAgentPanePorts<Session>,
  ): Promise<void> {
    const receipt = this.cleanup.get(id) ?? { condition, active: false };
    this.cleanup.set(id, receipt);
    if (receipt.active) return;
    receipt.active = true;
    try {
      await ports.releaseSession(id, receipt.condition);
      this.cleanup.delete(id);
    } finally {
      receipt.active = false;
    }
  }

  /** Failed cleanup retries its own obligation, never placement or creation. */
  retryCleanup(ports: CompletedAgentPanePorts<Session>): void {
    for (const [id, receipt] of this.cleanup) {
      if (!receipt.active) void this.release(id, receipt.condition, ports).catch(ports.onError);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const attempt of this.attempts.values()) attempt.cancelled = true;
    this.attempts.clear();
  }
}

/** Runtime-scoped ownership also fences delayed births across unmount and StrictMode replay. */
export function useCompletedAgentPanes<Session extends CompletedPaneSession>(
  owner: object | null,
  sessions: readonly Session[],
  ports: CompletedAgentPanePorts<Session>,
): void {
  const controller = useRef<CompletedAgentPanes<Session> | null>(null);
  useLayoutEffect(() => {
    if (owner === null) return;
    const current = new CompletedAgentPanes<Session>();
    controller.current = current;
    return () => {
      current.dispose();
      controller.current = null;
    };
  }, [owner]);
  useLayoutEffect(() => controller.current?.update(sessions, ports), [owner, sessions, ports]);
}
