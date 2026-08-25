import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileCreationRequestRegistry } from './creation-registry.js';

async function registryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'chopsticks-creation-registry-'));
}

describe('file creation request registry', () => {
  it('atomically elects one allocation for concurrent compatible claims', async () => {
    const directory = await registryDirectory();
    const registry = createFileCreationRequestRegistry({ directory });
    const input = {
      creationRequestId: 'request-with-secret-name',
      canonicalFingerprint: '{"agent":"claude","token":"provider-secret"}',
      operation: 'create' as const,
    };

    const [first, second] = await Promise.all([
      registry.claim({ ...input, proposedRuntimeRunId: 'run-one' }),
      registry.claim({ ...input, proposedRuntimeRunId: 'run-two' }),
    ]);

    expect([first.status, second.status].sort()).toEqual(['created', 'existing']);
    expect(first.claim.runtimeRunId).toBe(second.claim.runtimeRunId);
    expect(first.claim.ref).toEqual(second.claim.ref);
    expect(first.claim.ref).toMatchObject({
      claimId: expect.stringMatching(/^[0-9a-f]{64}$/),
      requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const persisted = await Promise.all(
      (await readdir(join(directory, 'claims')))
        .filter((name) => name.endsWith('.json'))
        .map((name) => readFile(join(directory, 'claims', name), 'utf8')),
    );
    expect(persisted.join('\n')).not.toContain('request-with-secret-name');
    expect(persisted.join('\n')).not.toContain('provider-secret');
  });

  it('rejects a conflicting payload without replacing the winning run', async () => {
    const directory = await registryDirectory();
    const registry = createFileCreationRequestRegistry({ directory });
    await registry.claim({
      creationRequestId: 'request-1',
      canonicalFingerprint: '{"cwd":"one"}',
      proposedRuntimeRunId: 'run-one',
      operation: 'create',
    });

    await expect(
      registry.claim({
        creationRequestId: 'request-1',
        canonicalFingerprint: '{"cwd":"two"}',
        proposedRuntimeRunId: 'run-two',
        operation: 'create',
      }),
    ).resolves.toMatchObject({
      status: 'conflict',
      claim: { runtimeRunId: 'run-one', runtimeEpoch: 1, operation: 'create', state: 'allocated' },
    });
  });

  it('survives registry reconstruction and advances epochs with compare-and-set idempotency', async () => {
    const directory = await registryDirectory();
    const first = createFileCreationRequestRegistry({ directory });
    await first.claim({
      creationRequestId: 'request-1',
      canonicalFingerprint: '{}',
      proposedRuntimeRunId: 'run-one',
      operation: 'create',
    });

    const restored = createFileCreationRequestRegistry({ directory });
    await expect(
      restored.claim({
        creationRequestId: 'request-1',
        canonicalFingerprint: '{}',
        proposedRuntimeRunId: 'run-two',
        operation: 'create',
      }),
    ).resolves.toMatchObject({ status: 'existing', claim: { runtimeRunId: 'run-one', runtimeEpoch: 1 } });
    await expect(
      restored.incrementRuntimeEpoch({
        creationRequestId: 'request-1',
        runtimeRunId: 'run-one',
        expectedRuntimeEpoch: 1,
      }),
    ).resolves.toMatchObject({ advanced: true, claim: { runtimeEpoch: 2 } });
    await expect(
      restored.incrementRuntimeEpoch({
        creationRequestId: 'request-1',
        runtimeRunId: 'run-one',
        expectedRuntimeEpoch: 1,
      }),
    ).resolves.toMatchObject({ advanced: false, claim: { runtimeEpoch: 2 } });
  });

  it('persists a bounded terminal outcome and refuses later epoch restoration', async () => {
    const directory = await registryDirectory();
    const registry = createFileCreationRequestRegistry({ directory });
    await registry.claim({
      creationRequestId: 'request-1',
      canonicalFingerprint: '{}',
      proposedRuntimeRunId: 'run-one',
      operation: 'prepare',
    });
    await expect(
      registry.markTerminal({
        creationRequestId: 'request-1',
        runtimeRunId: 'run-one',
        runtimeEpoch: 1,
        outcome: { kind: 'failed', code: 'PREPARATION_ADOPT_FAILED' },
      }),
    ).resolves.toMatchObject({
      applied: true,
      claim: {
        state: 'terminal',
        terminalOutcome: { kind: 'failed', code: 'PREPARATION_ADOPT_FAILED' },
      },
    });
    await expect(
      registry.incrementRuntimeEpoch({
        creationRequestId: 'request-1',
        runtimeRunId: 'run-one',
        expectedRuntimeEpoch: 1,
      }),
    ).rejects.toThrow(/terminal/);
  });

  it('ignores a terminal report from an older runtime epoch', async () => {
    const directory = await registryDirectory();
    const registry = createFileCreationRequestRegistry({ directory });
    await registry.claim({
      creationRequestId: 'request-1',
      canonicalFingerprint: '{}',
      proposedRuntimeRunId: 'run-one',
      operation: 'create',
    });
    await registry.incrementRuntimeEpoch({
      creationRequestId: 'request-1',
      runtimeRunId: 'run-one',
      expectedRuntimeEpoch: 1,
    });

    await expect(
      registry.markTerminal({
        creationRequestId: 'request-1',
        runtimeRunId: 'run-one',
        runtimeEpoch: 1,
        outcome: { kind: 'closed', reason: 'stale-host-exit' },
      }),
    ).resolves.toMatchObject({ applied: false, claim: { runtimeEpoch: 2, state: 'allocated' } });
    await expect(
      registry.markTerminal({
        creationRequestId: 'request-1',
        runtimeRunId: 'run-one',
        runtimeEpoch: 2,
        outcome: { kind: 'closed', reason: 'current-host-exit' },
      }),
    ).resolves.toMatchObject({ applied: true, claim: { runtimeEpoch: 2, state: 'terminal' } });
  });

  it('recovers a lock abandoned by a dead owner without waiting for the stale timeout', async () => {
    const directory = await registryDirectory();
    const registry = createFileCreationRequestRegistry({ directory, lockTimeoutMs: 100, staleLockMs: 60_000 });
    const created = await registry.claim({
      creationRequestId: 'request-with-abandoned-lock',
      canonicalFingerprint: '{}',
      proposedRuntimeRunId: 'run-one',
      operation: 'create',
    });
    if (created.status !== 'created') throw new Error('unexpected claim result');
    const lockPath = join(directory, 'claims', `${created.claim.ref.claimId}.lock`);
    await writeFile(
      lockPath,
      `${JSON.stringify({ token: 'abandoned', pid: 2_147_483_647, createdAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );

    await expect(
      registry.markTerminal({
        creationRequestId: 'request-with-abandoned-lock',
        runtimeRunId: 'run-one',
        runtimeEpoch: 1,
        outcome: { kind: 'failed', code: 'crash' },
      }),
    ).resolves.toMatchObject({ applied: true, claim: { state: 'terminal' } });
  });

  it('does not steal a fresh lock before its owner metadata is readable', async () => {
    const directory = await registryDirectory();
    const registry = createFileCreationRequestRegistry({ directory, lockTimeoutMs: 25, staleLockMs: 60_000 });
    const created = await registry.claim({
      creationRequestId: 'request-with-initializing-lock',
      canonicalFingerprint: '{}',
      proposedRuntimeRunId: 'run-one',
      operation: 'create',
    });
    if (created.status !== 'created') throw new Error('unexpected claim result');
    const lockPath = join(directory, 'claims', `${created.claim.ref.claimId}.lock`);
    await writeFile(lockPath, '', { mode: 0o600 });

    await expect(
      registry.markTerminal({
        creationRequestId: 'request-with-initializing-lock',
        runtimeRunId: 'run-one',
        runtimeEpoch: 1,
        outcome: { kind: 'failed', code: 'crash' },
      }),
    ).rejects.toThrow('timed out acquiring creation request claim lock');
    await expect(readFile(lockPath, 'utf8')).resolves.toBe('');
  });
});
