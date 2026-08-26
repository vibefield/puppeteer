import { describe, expect, it } from 'vitest';
import type { AgentSessionInfo } from '../protocol.js';
import { agentColor, classifyTerminalStatus, projectLabel, providerLabel } from './agent-status.js';

const info = {
  agent: 'codex',
  sessionId: 'native-1',
  runtimeSessionId: 'session-1',
  workspace: { mode: 'direct', root: '/project/godview', sourcePath: '/project/godview' },
  session: { exited: false },
} as AgentSessionInfo;

describe('Godview agent status', () => {
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

  it('assigns a stable per-session relationship color', () => {
    expect(agentColor('session-1')).toBe(agentColor('session-1'));
    expect(agentColor('session-1')).not.toBe(agentColor('session-2'));
  });
});
