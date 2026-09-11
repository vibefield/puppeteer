import { describe, expect, it } from 'vitest';
import type { AgentSessionInfo } from '../protocol.js';
import { agentAccent, agentAccentSlot, classifyTerminalStatus, projectLabel } from './agent-status.js';

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

  it('assigns a stable per-session accent slot and resolves it from the palette', () => {
    const accents = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    expect(agentAccentSlot('session-1', accents.length)).toBe(agentAccentSlot('session-1', accents.length));
    expect(agentAccentSlot('session-1', accents.length)).toBeGreaterThanOrEqual(0);
    expect(agentAccentSlot('session-1', accents.length)).toBeLessThan(accents.length);
    expect(agentAccent('session-1', accents)).toBe(accents[agentAccentSlot('session-1', accents.length)]);
    expect(agentAccent('session-1', [])).toBe('currentColor');
  });
});
