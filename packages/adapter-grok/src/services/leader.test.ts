import { describe, expect, it } from 'vitest';
import { grokLeaderReadinessPath } from './leader.js';

describe('Grok leader readiness', () => {
  it('waits for the Unix socket where the listener is materialized', () => {
    expect(grokLeaderReadinessPath('/tmp/run/leader.sock', 'darwin')).toBe('/tmp/run/leader.sock');
    expect(grokLeaderReadinessPath('/tmp/run/leader.sock', 'linux')).toBe('/tmp/run/leader.sock');
  });

  it('waits for the adjacent process lock when the listener is a Windows named pipe', () => {
    expect(grokLeaderReadinessPath('C:\\Temp\\run\\leader.sock', 'win32')).toBe('C:\\Temp\\run\\leader.lock');
  });
});
