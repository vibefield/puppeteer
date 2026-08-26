import { describe, expect, it } from 'vitest';
import { ClaudeUsageReconciler, type ClaudeUsageEvidence } from './usage-reconciler.js';

function evidence(
  source: 'native-telemetry' | 'native-transcript',
  actor: Partial<ClaudeUsageEvidence['publication']> = {},
  usageId = 'request-1',
): ClaudeUsageEvidence {
  return {
    event: {
      type: 'usage:tokens-used',
      usageId,
      boundary: 'response',
      canonical: true,
      totalTokens: 100,
      meterTokens: 20,
    },
    publication: { source, timestamp: '2026-08-25T00:00:00.000Z', ...actor },
  };
}

describe('ClaudeUsageReconciler', () => {
  it('keeps OTLP totals while accepting a later exact transcript actor correction', () => {
    const reconciler = new ClaudeUsageReconciler();
    const provisional = reconciler.accept(
      'otel',
      evidence('native-telemetry', { actorKey: 'workflow:researcher', actorRole: 'child' }),
    );
    const corrected = reconciler.accept(
      'transcript',
      evidence('native-transcript', { agentId: 'worker-1', agentType: 'researcher' }),
    );

    expect(provisional?.publication).toMatchObject({ actorKey: 'workflow:researcher' });
    expect(corrected).toMatchObject({
      event: { totalTokens: 100 },
      publication: { source: 'native-telemetry', agentId: 'worker-1', agentType: 'researcher' },
    });
    expect(
      reconciler.accept('transcript', evidence('native-transcript', { agentId: 'worker-1', agentType: 'researcher' })),
    ).toBeUndefined();
  });

  it('preserves exact transcript attribution when OTLP arrives second', () => {
    const reconciler = new ClaudeUsageReconciler();
    reconciler.accept('transcript', evidence('native-transcript', { agentId: 'worker-1' }));

    const corrected = reconciler.accept(
      'otel',
      evidence('native-telemetry', { actorKey: 'workflow:researcher', actorRole: 'child' }),
    );

    expect(corrected?.publication).toMatchObject({ source: 'native-telemetry', agentId: 'worker-1' });
  });

  it('bounds retained request claims for indefinitely running sessions', () => {
    const reconciler = new ClaudeUsageReconciler({ maxClaims: 1 });
    expect(reconciler.accept('otel', evidence('native-telemetry', {}, 'request-1'))).toBeDefined();
    expect(reconciler.accept('otel', evidence('native-telemetry', {}, 'request-2'))).toBeDefined();
    // The oldest claim was evicted, so seeing it again is a new bounded claim.
    expect(reconciler.accept('otel', evidence('native-telemetry', {}, 'request-1'))).toBeDefined();
  });

  it('rejects an invalid claim bound', () => {
    expect(() => new ClaudeUsageReconciler({ maxClaims: 0 })).toThrow(RangeError);
  });
});
