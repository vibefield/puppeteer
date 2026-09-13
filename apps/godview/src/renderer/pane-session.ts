import type { SessionSummary } from '@vibecook/ghosttea-protocol';

function usableCwd(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export interface PaneSessionCwdSources {
  agent?: string | undefined;
  process?: string | undefined;
  fallback?: string | undefined;
}

/** Resolve a split from live agent/process cwd before terminal metadata and stable launch fallbacks. */
export function paneSessionLaunchSource(
  selected: SessionSummary,
  refreshedSessions: readonly SessionSummary[],
  cwd: PaneSessionCwdSources = {},
): { session: SessionSummary; cwd?: string } {
  const refreshed = refreshedSessions.find((session) => session.id === selected.id) ?? selected;
  const resolvedCwd =
    usableCwd(cwd.agent) ??
    usableCwd(cwd.process) ??
    usableCwd(refreshed.cwd) ??
    usableCwd(selected.cwd) ??
    usableCwd(cwd.fallback);
  return { session: refreshed, ...(resolvedCwd ? { cwd: resolvedCwd } : {}) };
}
