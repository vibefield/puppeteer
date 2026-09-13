import { describe, expect, it } from 'vitest';
import { AGENT_MONITOR_SCHEMA_VERSION, type AgentMonitorState } from '@vibecook/puppeteer-core';
import type {
  AcknowledgeAgentFailureRequest,
  AgentMonitorNotificationMessage,
  AgentMonitorRemovedMessage,
  AgentMonitorStateMessage,
  PuppeteerBridge,
} from './protocol.js';

function state(): AgentMonitorState {
  return {
    schemaVersion: AGENT_MONITOR_SCHEMA_VERSION,
    runtimeRunId: 'run-1',
    runtimeEpoch: 2,
    revision: 7,
    status: 'blocked',
    statusSince: '2026-08-17T00:00:00.000Z',
    blockers: [{ id: 'failure-1', kind: 'failure', since: '2026-08-17T00:00:00.000Z' }],
    usage: { samples: [] },
    modes: { execution: 'native-tui' },
    subagentCount: 0,
    subagents: [],

    compaction: { active: false, count: 0 },
    environment: { worktrees: [] },
    session: { nativeSessionId: 'native-1' },
    freshness: { level: 'native-hooks', families: {} },
    alive: false,
  };
}

describe('Godview monitor IPC protocol', () => {
  it('round-trips full state, notification, and removal envelopes as JSON', () => {
    const stateMessage: AgentMonitorStateMessage = {
      runtimeRunId: 'run-1',
      terminalSessionId: 'terminal-1',
      state: state(),
    };
    const notificationMessage: AgentMonitorNotificationMessage = {
      runtimeRunId: 'run-1',
      terminalSessionId: 'terminal-1',
      notification: {
        notificationId: 'notice-1',
        runtimeRunId: 'run-1',
        at: '2026-08-17T00:00:00.000Z',
        type: 'blocked.entered',
      },
    };
    const removedMessage: AgentMonitorRemovedMessage = {
      runtimeRunId: 'run-1',
      terminalSessionId: 'terminal-1',
      runtimeEpoch: 2,
      revision: 7,
    };
    const messages = [stateMessage, notificationMessage, removedMessage];
    expect(JSON.parse(JSON.stringify(messages))).toEqual(messages);
  });

  it('exposes monitor subscriptions and scoped failure acknowledgment', () => {
    const acknowledgment: AcknowledgeAgentFailureRequest = { runtimeRunId: 'run-1', blockerId: 'failure-1' };
    const bridgeMethods: (keyof PuppeteerBridge)[] = [
      'listAgentMonitors',
      'onAgentMonitorState',
      'onAgentMonitorNotification',
      'onAgentMonitorRemoved',
      'acknowledgeAgentFailure',
    ];
    expect(JSON.parse(JSON.stringify({ acknowledgment }))).toEqual({ acknowledgment });
    expect(bridgeMethods).toHaveLength(5);
  });
});
