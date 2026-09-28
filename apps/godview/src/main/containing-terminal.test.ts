import { describe, expect, it } from 'vitest';
import { unknownSessionActivity, type SessionSummary } from '@vibecook/ghosttea-protocol';
import { containingTerminalSession } from './containing-terminal.js';

const shellSession = {
  id: 'terminal-1',
  handle: '1',
  executable: '/bin/zsh',
  cols: 100,
  rows: 30,
  exited: false,
  readWrite: true,
  title: null,
  cwd: '/repo',
  bellCount: 0,
  pid: 123,
  createdAtMs: 1,
  exitCode: null,
  exitSignal: null,
  requestedTermination: null,
  exitOutcome: null,
  ownerId: null,
  persistence: 'terminate-with-app',
  activity: unknownSessionActivity(),
} satisfies SessionSummary;

describe('the terminal that contains a spawn-through launch', () => {
  it('matches a direct shell child and the shell-exec optimization', () => {
    expect(containingTerminalSession([shellSession], { pid: 456, parentPid: 123 })?.id).toBe('terminal-1');
    expect(containingTerminalSession([shellSession], { pid: 123, parentPid: 9 })?.id).toBe('terminal-1');
  });

  it('prefers the parent shell, and never answers for an exited session or one without a pid', () => {
    const exec = { ...shellSession, id: 'terminal-2', pid: 456 };
    expect(containingTerminalSession([exec, shellSession], { pid: 456, parentPid: 123 })?.id).toBe('terminal-1');
    expect(
      containingTerminalSession(
        [
          { ...shellSession, exited: true },
          { ...exec, pid: null },
        ],
        { pid: 456, parentPid: 123 },
      ),
    ).toBeUndefined();
  });
});
