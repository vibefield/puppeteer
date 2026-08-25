import { describe, expect, it } from 'vitest';
import type { AgentSessionInfo, AgentStateMessage } from '../protocol.js';
import { agentColor, classifyTerminalStatus, projectLabel, providerLabel } from './agent-status.js';
import { classifyLegacyAgentStatus, legacyAgentDetail } from './legacy-agent-state.js';

function state(overrides: Partial<AgentStateMessage['state']> = {}): AgentStateMessage {
  return {
    runtimeSessionId: 'session-1',
    observationLevel: 'structured',
    state: {
      lifecycle: 'ready',
      tools: [],
      permissions: [],
      subagents: [],
      tasks: [],
      environment: {},
      counters: { toolsCompleted: 0, toolsFailed: 0, unknownEvents: 0 },
      lastSequence: 0,
      diagnostics: [],
      ...overrides,
    },
  };
}

const info = {
  agent: 'codex',
  sessionId: 'native-1',
  runtimeSessionId: 'session-1',
  workspace: { mode: 'direct', root: '/project/godview', sourcePath: '/project/godview' },
  session: { exited: false },
} as AgentSessionInfo;

describe('Godview agent status', () => {
  it('maps ready, active, and permission states to the three statuses', () => {
    expect(classifyLegacyAgentStatus(state())).toBe('idle');
    expect(classifyLegacyAgentStatus(state({ lifecycle: 'running', activeTurn: { startedAt: 'now' } }))).toBe(
      'working',
    );
    expect(classifyLegacyAgentStatus(state({ permissions: [{ requestId: 'approval' }] }))).toBe('blocked');
  });

  it('drops sessions that reached a terminal lifecycle', () => {
    expect(classifyLegacyAgentStatus(state({ lifecycle: 'failed' }))).toBeUndefined();
    expect(classifyLegacyAgentStatus(state({ lifecycle: 'exited' }))).toBeUndefined();
  });

  it('uses foreground activity for unassigned terminals and keeps unknown activity on the idle fallback', () => {
    expect(classifyTerminalStatus({ kind: 'shell-idle' })).toBe('idle');
    expect(classifyTerminalStatus({ kind: 'foreground-job' })).toBe('working');
    expect(classifyTerminalStatus({ kind: 'unknown' })).toBe('idle');
    expect(classifyTerminalStatus(undefined)).toBe('idle');
  });

  it('labels a session from its workspace and its provider from its kind', () => {
    expect(projectLabel(info)).toBe('godview');
    expect(projectLabel(info, '/project/godview/packages/app')).toBe('app');
    expect(providerLabel('codex')).toBe('Codex');
    expect(providerLabel('hermes')).toBe('Hermes');
    expect(providerLabel('kimi')).toBe('Kimi');
    expect(providerLabel('opencode')).toBe('OpenCode');
  });

  it('describes what an agent is doing without reading the terminal', () => {
    expect(legacyAgentDetail(undefined, 'working')).toBe('starting');
    expect(legacyAgentDetail(state({ permissions: [{ requestId: 'a', tool: 'Bash' }] }), 'blocked')).toBe(
      'permission · Bash',
    );
    expect(legacyAgentDetail(state({ tools: [{ toolCallId: 't', tool: 'Read', state: 'running' }] }), 'working')).toBe(
      'Read',
    );
    expect(legacyAgentDetail(state({ activeReasoning: { startedAt: 'now' } }), 'working')).toBe('thinking');
  });

  it('assigns a stable per-session relationship color', () => {
    expect(agentColor('session-1')).toBe(agentColor('session-1'));
    expect(agentColor('session-1')).not.toBe(agentColor('session-2'));
  });
});
