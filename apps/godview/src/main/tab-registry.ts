import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import {
  replaceRestoreWorkspaceSession,
  restoreWorkspaceSessionIds,
  type RestoreWorkspaceDocument,
} from '../restore-snapshot.js';

export interface GodviewTabRecord<Window extends object> {
  id: string;
  groupId: string;
  window: Window;
  sessionIds: Set<string>;
  activeCwd: string | undefined;
  /** Last complete workspace document received from this renderer. */
  workspace: RestoreWorkspaceDocument | undefined;
  /** One-shot document injected before a restored renderer mounts Ghosttea. */
  pendingRestoreWorkspace: RestoreWorkspaceDocument | undefined;
}

/** Tracks native tab creation order and the terminal sessions attached to each window viewport. */
export class GodviewTabRegistry<Window extends object> {
  readonly #byWindow = new Map<Window, GodviewTabRecord<Window>>();

  add(
    window: Window,
    id: string,
    groupId: string,
    restoreWorkspace?: RestoreWorkspaceDocument,
  ): GodviewTabRecord<Window> {
    const record = {
      id,
      groupId,
      window,
      sessionIds: new Set<string>(),
      activeCwd: undefined,
      workspace: restoreWorkspace,
      pendingRestoreWorkspace: restoreWorkspace,
    };
    this.#byWindow.set(window, record);
    return record;
  }

  get(window: Window): GodviewTabRecord<Window> | undefined {
    return this.#byWindow.get(window);
  }

  delete(window: Window): GodviewTabRecord<Window> | undefined {
    const record = this.#byWindow.get(window);
    this.#byWindow.delete(window);
    return record;
  }

  records(): GodviewTabRecord<Window>[] {
    return [...this.#byWindow.values()];
  }

  group(groupId: string): GodviewTabRecord<Window>[] {
    return this.records().filter((record) => record.groupId === groupId);
  }

  updateSessions(
    window: Window,
    sessionIds: readonly string[],
    workspace?: RestoreWorkspaceDocument,
  ): { sessionsChanged: boolean; workspaceChanged: boolean; detachedSessionIds: string[] } {
    const record = this.#byWindow.get(window);
    if (!record) return { sessionsChanged: false, workspaceChanged: false, detachedSessionIds: [] };
    const nextSessions = new Set(sessionIds);
    const removedSessionIds = [...record.sessionIds].filter((id) => !nextSessions.has(id));
    const sessionsChanged =
      nextSessions.size !== record.sessionIds.size || [...nextSessions].some((id) => !record.sessionIds.has(id));
    const workspaceChanged = workspace !== undefined && JSON.stringify(workspace) !== JSON.stringify(record.workspace);
    record.sessionIds = nextSessions;
    if (workspace !== undefined) {
      record.workspace = workspace;
      // Receipt of a complete document is the acknowledgement that the
      // renderer durably seeded its local workspace. Until then, keep serving
      // the startup document across renderer crashes/reloads.
      record.pendingRestoreWorkspace = undefined;
    }
    return {
      sessionsChanged,
      workspaceChanged,
      detachedSessionIds: this.unreferencedSessionIds(removedSessionIds),
    };
  }

  unreferencedSessionIds(sessionIds: Iterable<string>): string[] {
    return [...new Set(sessionIds)].filter(
      (sessionId) => !this.records().some((record) => record.sessionIds.has(sessionId)),
    );
  }

  updateActiveCwd(window: Window, cwd: string | undefined): void {
    const record = this.#byWindow.get(window);
    if (record) record.activeCwd = cwd;
  }

  /**
   * Replace a dead PTY everywhere it is mounted and queue that same complete
   * document for renderer crash/reload recovery. Returns the affected views.
   */
  replaceSession(originSessionId: string, replacement: Pick<SessionSummary, 'id' | 'cwd'>): GodviewTabRecord<Window>[] {
    const affected: GodviewTabRecord<Window>[] = [];
    for (const record of this.#byWindow.values()) {
      const mounted = record.sessionIds.has(originSessionId);
      const documented = Boolean(
        record.workspace && restoreWorkspaceSessionIds(record.workspace).includes(originSessionId),
      );
      if (!mounted && !documented) continue;
      if (mounted) {
        record.sessionIds.delete(originSessionId);
        record.sessionIds.add(replacement.id);
      }
      if (record.workspace && documented) {
        const workspace = replaceRestoreWorkspaceSession(record.workspace, originSessionId, replacement);
        record.workspace = workspace;
        record.pendingRestoreWorkspace = workspace;
      }
      affected.push(record);
    }
    return affected;
  }

  queueRestoreWorkspace(window: Window, workspace: RestoreWorkspaceDocument): void {
    const record = this.#byWindow.get(window);
    if (!record) return;
    record.workspace = workspace;
    record.pendingRestoreWorkspace = workspace;
  }

  takeRestoreWorkspace(window: Window): RestoreWorkspaceDocument | undefined {
    const record = this.#byWindow.get(window);
    return record?.pendingRestoreWorkspace;
  }

  tabAt(window: Window, oneBasedIndex: number): GodviewTabRecord<Window> | undefined {
    const current = this.#byWindow.get(window);
    if (!current) return undefined;
    const group = this.group(current.groupId);
    if (!group.length) return undefined;
    return group[Math.min(Math.max(oneBasedIndex, 1), group.length) - 1];
  }
}
