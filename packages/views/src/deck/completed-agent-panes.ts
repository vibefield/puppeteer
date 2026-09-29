import { useLayoutEffect, useRef } from 'react';

export interface CompletedPaneSession {
  id: string;
  exited: boolean;
  exitOutcome: string | null;
}

export interface CompletedAgentPanePorts<Session extends CompletedPaneSession> {
  createShell: (ended: Session) => Promise<Session>;
  /** Compare with the workspace's current attachments, never the active pane. */
  replaceSession: (expectedId: string, shell: Session) => boolean;
  releaseSession: (sessionId: string) => void | Promise<unknown>;
  onError: (cause: unknown) => void;
}

/** A clean native agent exit returns its attached panes to one fresh shell.
 * The host supplies local managed sessions; monitor liveness is NOT exit evidence.
 * Failed exits keep their diagnostic surface. History is independent of PTY custody. */
export class CompletedAgentPanes<Session extends CompletedPaneSession> {
  private readonly attempts = new Map<string, { cancelled: boolean }>();
  private disposed = false;

  update(sessions: readonly Session[], ports: CompletedAgentPanePorts<Session>): void {
    if (this.disposed) return;
    const completed = new Map(
      sessions.filter((session) => session.exited && session.exitOutcome === 'completed').map((s) => [s.id, s]),
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
        if (attempt.cancelled || !ports.replaceSession(id, shell)) {
          await ports.releaseSession(shell.id);
          return;
        }
        // Only release the ended PTY after the replacement has a pane. No history deletion.
        await ports.releaseSession(id);
      })().catch(ports.onError);
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
