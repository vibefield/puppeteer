import { describe, expect, it } from 'vitest';
import type { AgentSessionInfo } from '../protocol.js';
import { classifyTerminalStatus, projectLabel } from './agent-status.js';

const info = {
  provider: { id: 'codex', label: 'Codex' },
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

  it('labels a session from its workspace and falls back to adapter-authored provider metadata', () => {
    expect(projectLabel(info)).toBe('godview');
    expect(projectLabel(info, '/project/godview/packages/app')).toBe('app');
    const providerFallback = {
      ...info,
      workspace: { ...info.workspace, root: '', sourcePath: '' },
      session: { ...info.session, cwd: null },
    };
    expect(projectLabel(providerFallback)).toBe('Codex');
  });
});
