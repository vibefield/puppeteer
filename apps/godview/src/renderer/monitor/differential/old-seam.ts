import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import { createAgentMonitorStore } from '@vibecook/puppeteer-monitor';
import {
  EMPTY_UNREAD_LEDGER,
  EMPTY_USAGE_LEDGER,
  reconcileUnread,
  reconcileUsage,
  type ProjectTint,
  type UnreadLedger,
  type UsageLedger,
} from '@vibecook/puppeteer-views';
import type { AgentMonitorRemovedMessage, AgentMonitorStateMessage, AgentSessionInfo } from '../../../protocol.js';
import type { PaneAttachment } from '../../pane-attachments.js';
import type { MonitorAgent } from '../types.js';
import {
  assembleMonitorAgents,
  mergeMonitorTerminals,
  monitorIdentity,
  type MonitorAgentRecord,
  type MonitorTerminalRecord,
} from './old-agents.js';

/**
 * THE OLD SEAM'S PROJECTION, FROZEN (MV-2's differential reference; never edit).
 *
 * `useMonitorAgents.ts` at puppeteer 1afaff7 as a plain stepper: its
 * subscription effect's record bookkeeping (`remember`, `forget`,
 * `updateMonitor`, `removeMonitor`, the store that orders them) and the body of
 * its `agents` memo, statement for statement. The hook read `Date.now()` and a
 * React clock that ticked every 10 s from mount (`nowMs`); here both are given.
 * Its usage persistence is left out: L11 retires it, and it only seeded a
 * resumed conversation from a previous app run, which a differential from an
 * empty start never has.
 */

/** Everything the hook read of the window besides the records. */
export interface OldSeamWindow {
  /** `workspace.sessions`: the sessions this window's panes show. */
  readonly sessions: readonly SessionSummary[];
  readonly activeSessionId?: string | undefined;
  readonly attachments: ReadonlyMap<string, PaneAttachment>;
  readonly identities: ReadonlyMap<string, string>;
  readonly visualIds: ReadonlyMap<string, string>;
  /** The terminals the window created (`createAt`), with their spawn hints. */
  readonly explicit: readonly MonitorTerminalRecord[];
  readonly exited: ReadonlySet<string>;
  readonly closing: ReadonlySet<string>;
  readonly colours: { readonly tint: ProjectTint; readonly neutral: string };
  readonly profileLabels: ReadonlyMap<string, string>;
}

export class OldSeam {
  private readonly current = new Map<string, MonitorAgentRecord>();
  private readonly monitorsByRun = new Map<string, AgentMonitorStateMessage>();
  private readonly removed = new Set<string>();
  private readonly monitorStore = createAgentMonitorStore({ notificationCapacity: 4 });
  private unread: UnreadLedger = EMPTY_UNREAD_LEDGER;
  private visualIds: ReadonlyMap<string, string> = new Map();
  private usage: UsageLedger = EMPTY_USAGE_LEDGER;

  remember(info: AgentSessionInfo): void {
    this.removed.delete(info.runtimeSessionId);
    const existing = this.current.get(info.runtimeSessionId);
    const monitor = this.monitorsByRun.get(info.runtimeRunId);
    const retainedMonitor =
      monitor ?? (existing?.info.runtimeRunId === info.runtimeRunId ? existing.monitor : undefined);
    this.current.set(info.runtimeSessionId, { info, ...(retainedMonitor ? { monitor: retainedMonitor } : {}) });
  }

  forget(runtimeSessionId: string): void {
    this.removed.add(runtimeSessionId);
    this.current.delete(runtimeSessionId);
  }

  private acceptMonitor(message: AgentMonitorStateMessage): boolean {
    if (!this.monitorStore.acceptState(message.state)) return false;
    this.monitorsByRun.set(message.runtimeRunId, message);
    return true;
  }

  updateMonitor(message: AgentMonitorStateMessage): void {
    if (!this.acceptMonitor(message)) return;
    const terminalSessionId =
      message.terminalSessionId ??
      [...this.current.values()].find((record) => record.info.runtimeRunId === message.runtimeRunId)?.info
        .runtimeSessionId;
    if (!terminalSessionId) return;
    const record = this.current.get(terminalSessionId);
    if (!record || record.info.runtimeRunId !== message.runtimeRunId) return;
    this.current.set(terminalSessionId, { ...record, monitor: message });
  }

  removeMonitor(message: AgentMonitorRemovedMessage): void {
    if (!this.monitorStore.remove({ runtimeRunId: message.runtimeRunId, runtimeEpoch: message.runtimeEpoch })) return;
    this.monitorsByRun.delete(message.runtimeRunId);
    const terminalSessionId =
      message.terminalSessionId ??
      [...this.current.values()].find((record) => record.info.runtimeRunId === message.runtimeRunId)?.info
        .runtimeSessionId;
    if (!terminalSessionId) return;
    this.forget(terminalSessionId);
  }

  /** The `agents` memo at `now` (its `Date.now()`), with the hook's 10 s clock at `nowMs`. */
  project(window: OldSeamWindow, now: number, nowMs: number): readonly MonitorAgent[] {
    const records = new Map(this.current);
    const terminalIdentities = window.identities;
    const visibleTerminals = mergeMonitorTerminals({
      explicit: window.explicit,
      workspaceSessions: window.sessions,
      exitedSessionIds: window.exited,
      closingSessionIds: window.closing,
      identities: terminalIdentities,
    });
    const sessions = new Map(window.sessions.map((session) => [session.id, session] as const));

    const usage = reconcileUsage(
      this.usage,
      [...records.values()].map((record) => {
        const state = record.monitor?.state;
        const nativeSessionId = state?.session.nativeSessionId ?? record.info.nativeSession?.id;
        return {
          id: monitorIdentity(record.info.session.id, terminalIdentities),
          runId: `${state?.runtimeRunId ?? record.info.runtimeRunId}:${state?.runtimeEpoch ?? record.info.runtimeEpoch}`,
          ...(nativeSessionId ? { session: { providerId: record.info.provider.id, nativeSessionId } } : {}),
          ...(state ? { usage: state.usage, revision: state.revision } : {}),
        };
      }),
      now,
    );
    this.usage = usage;
    const assembled = assembleMonitorAgents({
      agents: [...records.values()],
      terminals: visibleTerminals,
      sessions,
      attachments: window.attachments,
      identities: terminalIdentities,
      visualIds: window.visualIds,
      previousVisualIds: this.visualIds,
      nowMs,
      colours: { tint: window.colours.tint, neutral: window.colours.neutral },
      usage: usage.histories,
      ...(window.activeSessionId ? { activeSessionId: window.activeSessionId } : {}),
    });
    this.visualIds = new Map(assembled.map((agent) => [agent.id, agent.visualId ?? agent.id]));
    const ledger = reconcileUnread(
      this.unread,
      assembled.map((agent) => {
        const statusSinceMs = agent.agent ? Date.parse(agent.agent.monitor.statusSince) : Number.NaN;
        return {
          id: agent.id,
          status: agent.status,
          active: agent.active,
          hasAgent: agent.agent !== undefined,
          ...(Number.isFinite(statusSinceMs) ? { statusSinceMs } : {}),
        };
      }),
      now,
    );
    this.unread = ledger;
    return assembled.map((agent) => {
      const unread = ledger.unreadIds.has(agent.id);
      const profileId = agent.agent?.info.profileId;
      const account = profileId ? window.profileLabels.get(profileId) : undefined;
      if (!unread && !account) return agent;
      return {
        ...agent,
        ...(unread ? { unread: true } : {}),
        ...(account && agent.agent ? { agent: { ...agent.agent, account } } : {}),
      };
    });
  }
}
