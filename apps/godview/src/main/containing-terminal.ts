import type { SessionSummary } from '@vibecook/ghosttea-protocol';

/**
 * Godview's evidence for the spawn-through kit's `resolveTerminal`: the live
 * session whose shell is the launch's parent, else the session whose own pid
 * the launch is (a shell that execs its last command hands its pid on). A pid
 * is self-asserted, so no other session is ever said to contain it.
 */
export function containingTerminalSession(
  sessions: readonly SessionSummary[],
  launch: { pid: number; parentPid: number },
): SessionSummary | undefined {
  const live = sessions.filter((session) => !session.exited && session.pid !== null);
  return live.find((session) => session.pid === launch.parentPid) ?? live.find((session) => session.pid === launch.pid);
}
