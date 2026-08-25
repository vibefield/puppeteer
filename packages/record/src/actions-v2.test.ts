import { describe, expect, it } from 'vitest';
import {
  createOwnActionRecordId,
  normalizeOwnActionV2Input,
  type OwnActionV2Input,
  type OwnActionV2InputFor,
} from './actions-v2.js';

function allocation(
  overrides: Partial<OwnActionV2InputFor<'run.allocated'>> = {},
): OwnActionV2InputFor<'run.allocated'> {
  return {
    type: 'run.allocated',
    recordId: createOwnActionRecordId('run-1', 'run.allocated'),
    runtimeRunId: 'run-1',
    runtimeEpoch: 1,
    effectiveAt: '2026-08-16T20:00:00.000Z',
    quality: 'exact',
    completeness: 'complete',
    providerId: 'claude',
    operation: 'create',
    externalRefs: [{ namespace: 'vibefield', kind: 'project', id: 'project-1' }],
    ...overrides,
  };
}

describe('v2 own-action schema', () => {
  it('derives stable opaque record ids from run and semantic action identity', () => {
    expect(createOwnActionRecordId('run-1', 'workspace:one:finalized')).toBe(
      createOwnActionRecordId('run-1', 'workspace:one:finalized'),
    );
    expect(createOwnActionRecordId('run-1', 'workspace:one:finalized')).not.toBe(
      createOwnActionRecordId('run-2', 'workspace:one:finalized'),
    );
    expect(createOwnActionRecordId('run-1', 'workspace:one:finalized')).toMatch(/^own:[0-9a-f]{64}$/);
  });

  it('records observed and effective clocks independently with explicit quality and completeness', () => {
    const record = normalizeOwnActionV2Input(allocation(), '2026-08-16T20:00:01.000Z');
    expect(record).toMatchObject({
      schemaVersion: 2,
      observedAt: '2026-08-16T20:00:01.000Z',
      effectiveAt: '2026-08-16T20:00:00.000Z',
      quality: 'exact',
      completeness: 'complete',
      evidence: [],
    });
  });

  it('allowlists schema fields so arbitrary secrets cannot ride a v2 record', () => {
    const unsafe = {
      ...allocation(),
      token: 'credential-token',
      environment: { AUTH_TOKEN: 'credential-token' },
      rawDiff: 'secret source contents',
      remoteUrl: 'https://user:password@example.invalid/repo.git',
    } as unknown as OwnActionV2Input;
    const persisted = JSON.stringify(normalizeOwnActionV2Input(unsafe, '2026-08-16T20:00:01.000Z'));
    expect(persisted).not.toContain('credential-token');
    expect(persisted).not.toContain('secret source contents');
    expect(persisted).not.toContain('password');
    expect(persisted).not.toContain('environment');
  });

  it('persists bounded workspace facts while stripping local paths and raw evidence', () => {
    const fingerprint = { algorithm: 'hmac-sha256' as const, value: 'a'.repeat(64) };
    const summary = {
      total: 1,
      added: 0,
      modified: 1,
      deleted: 0,
      renamed: 0,
      copied: 0,
      unmerged: 0,
      untracked: 0,
      other: 0,
    };
    const unsafe = {
      type: 'workspace.finalized',
      recordId: createOwnActionRecordId('run-1', 'workspace:one:finalized'),
      runtimeRunId: 'run-1',
      runtimeEpoch: 1,
      quality: 'strong',
      completeness: 'complete',
      workspaceInstanceId: 'workspace-one',
      initialCommit: 'a1',
      finalCommit: 'b2',
      filesTouchedCount: 1,
      insertions: 4,
      deletions: 2,
      retained: false,
      outcome: 'complete',
      trigger: 'unclassified-exit',
      cleanupOutcome: 'removed',
      git: {
        state: 'attached',
        headCommit: 'b2',
        headRef: 'refs/heads/chopsticks/workspace-one',
        index: summary,
        worktree: summary,
        conflicts: 0,
        indexFingerprint: fingerprint,
        worktreeFingerprint: fingerprint,
        rawDiff: 'private source',
      },
      reachableCommits: {
        relation: 'fast-forward',
        initialCommit: 'a1',
        finalCommit: 'b2',
        commits: ['b2'],
        totalCount: 1,
        truncated: false,
      },
      filesFingerprint: fingerprint,
      interference: [{ kind: 'known-concurrent-claim', observedAt: '2026-08-16T20:00:00.000Z', count: 1 }],
      knownConcurrentClaims: 1,
      filesTouched: ['/private/repository/credential.ts'],
      repository: { remoteUrl: 'https://user:password@example.invalid/private.git' },
    } as unknown as OwnActionV2Input;

    const record = normalizeOwnActionV2Input(unsafe, '2026-08-16T20:00:01.000Z');
    expect(record).toMatchObject({
      type: 'workspace.finalized',
      outcome: 'complete',
      trigger: 'unclassified-exit',
      cleanupOutcome: 'removed',
      reachableCommits: { relation: 'fast-forward', commits: ['b2'] },
      filesFingerprint: fingerprint,
      interference: [{ kind: 'known-concurrent-claim', count: 1 }],
    });
    const persisted = JSON.stringify(record);
    expect(persisted).not.toContain('/private/repository');
    expect(persisted).not.toContain('private source');
    expect(persisted).not.toContain('password');
    expect(persisted).not.toContain('remoteUrl');
  });

  it('rejects unbounded or internally inconsistent reachable commit lists', () => {
    const base = {
      type: 'workspace.finalized' as const,
      recordId: createOwnActionRecordId('run-1', 'workspace:one:finalized'),
      runtimeRunId: 'run-1',
      runtimeEpoch: 1,
      quality: 'strong' as const,
      completeness: 'complete' as const,
      workspaceInstanceId: 'workspace-one',
      filesTouchedCount: 0,
      insertions: 0,
      deletions: 0,
      retained: false,
    };
    expect(() =>
      normalizeOwnActionV2Input(
        {
          ...base,
          reachableCommits: {
            relation: 'fast-forward',
            commits: Array.from({ length: 1_025 }, (_, index) => `commit-${index}`),
            totalCount: 1_025,
            truncated: false,
          },
        },
        '2026-08-16T20:00:01.000Z',
      ),
    ).toThrow(/at most 1024/);
    expect(() =>
      normalizeOwnActionV2Input(
        {
          ...base,
          reachableCommits: {
            relation: 'fast-forward',
            commits: ['b2'],
            totalCount: 2,
            truncated: false,
          },
        },
        '2026-08-16T20:00:01.000Z',
      ),
    ).toThrow(/inconsistent/);
  });

  it('rejects prompt persistence that bypasses the recorder policy gate', () => {
    expect(() =>
      normalizeOwnActionV2Input(
        {
          type: 'injection.receipt',
          recordId: createOwnActionRecordId('run-1', 'injection:one'),
          runtimeRunId: 'run-1',
          runtimeEpoch: 1,
          quality: 'exact',
          completeness: 'complete',
          injectionId: 'injection-one',
          promptByteLength: 6,
          promptPersistence: 'body',
          promptBody: 'secret',
          outcome: 'confirmed',
        },
        '2026-08-16T20:00:01.000Z',
      ),
    ).toThrow(/configured recorder policy/);
  });
});
