import { existsSync, mkdtempSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createActionRecorder } from './recorder.js';
import { createOwnActionRecordId, type OwnActionV2InputFor } from './actions-v2.js';

function tmpLog(): string {
  return join(mkdtempSync(join(tmpdir(), 'record-')), 'own-actions.jsonl');
}

function finalizedRecord(runtimeRunId = 'run-1'): OwnActionV2InputFor<'workspace.finalized'> {
  return {
    type: 'workspace.finalized',
    recordId: createOwnActionRecordId(runtimeRunId, 'workspace:workspace-1:finalized'),
    runtimeRunId,
    runtimeEpoch: 1,
    effectiveAt: '2026-08-16T20:00:00.000Z',
    quality: 'exact',
    completeness: 'complete',
    workspaceInstanceId: 'workspace-1',
    initialCommit: 'abc123',
    finalCommit: 'def456',
    filesTouchedCount: 2,
    insertions: 4,
    deletions: 1,
    retained: false,
  };
}

describe('createActionRecorder', () => {
  it('provides stable local and cross-install opaque keyed digests without exposing key material', async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'record-install-one-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'record-install-two-'));
    const firstPath = join(firstRoot, 'own-actions.jsonl');
    const canonicalValue = '/Users/example/private/repository/.git';
    const first = createActionRecorder({ path: firstPath });
    const firstDigest = await first.keyedDigest('workspace:repository', canonicalValue);
    const restartedDigest = await createActionRecorder({ path: firstPath }).keyedDigest(
      'workspace:repository',
      canonicalValue,
    );
    const otherDigest = await createActionRecorder({ path: join(secondRoot, 'own-actions.jsonl') }).keyedDigest(
      'workspace:repository',
      canonicalValue,
    );

    expect(firstDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(restartedDigest).toBe(firstDigest);
    expect(otherDigest).not.toBe(firstDigest);
    expect(existsSync(join(firstRoot, 'installation.key'))).toBe(true);
    expect(existsSync(firstPath)).toBe(false);
  });

  it('domain-separates installation-keyed digests', async () => {
    const recorder = createActionRecorder({ path: tmpLog() });
    expect(await recorder.keyedDigest('workspace:repository', 'same')).not.toBe(
      await recorder.keyedDigest('workspace:files-touched', 'same'),
    );
  });

  it('stamps ts and round-trips typed actions through read()', async () => {
    const recorder = createActionRecorder({ path: tmpLog(), now: () => new Date('2026-07-13T00:00:00.000Z') });
    await recorder.record({
      type: 'injection',
      sessionId: 's-1',
      text: 'do the thing',
      outcome: 'confirmed',
      turnId: 'p-1',
    });
    await recorder.record({
      type: 'workspace-final',
      sessionId: 's-1',
      mode: 'worktree',
      branch: 'chopsticks/ab12',
      filesTouched: ['a.ts', 'b.ts'],
      retained: true,
    });

    const actions = await recorder.read();
    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual({
      ts: '2026-07-13T00:00:00.000Z',
      type: 'injection',
      sessionId: 's-1',
      text: 'do the thing',
      outcome: 'confirmed',
      turnId: 'p-1',
    });
    expect(actions[1]).toMatchObject({ type: 'workspace-final', retained: true, filesTouched: ['a.ts', 'b.ts'] });
  });

  it('serializes concurrent records without interleaving (one line each)', async () => {
    const recorder = createActionRecorder({ path: tmpLog() });
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        recorder.record({ type: 'session-exit', sessionId: `s-${i}`, exitCode: i, reason: 'completed' }),
      ),
    );
    const actions = await recorder.read();
    expect(actions).toHaveLength(50);
    expect(new Set(actions.map((a) => (a as { sessionId: string }).sessionId)).size).toBe(50);
  });

  it('creates the parent directory on first write', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'record-')), 'nested', 'deep', 'own-actions.jsonl');
    const recorder = createActionRecorder({ path });
    await recorder.record({ type: 'policy-conflict', sessionId: 's', code: 'WORKSPACE_CONFLICT', message: 'busy' });
    expect(existsSync(path)).toBe(true);
    expect(await recorder.read()).toHaveLength(1);
  });

  it('read() returns [] for a log that does not exist yet', async () => {
    const recorder = createActionRecorder({ path: tmpLog() });
    expect(await recorder.read()).toEqual([]);
  });

  it('a write failure surfaces on onError, never throwing into the caller', async () => {
    const errors: Error[] = [];
    // A path whose parent is a FILE, not a directory: mkdir will fail.
    const fileAsParent = tmpLog();
    const recorder = createActionRecorder({ path: fileAsParent });
    await recorder.record({ type: 'session-exit', sessionId: 's', exitCode: 0, reason: 'completed' }); // creates the file
    const broken = createActionRecorder({ path: join(fileAsParent, 'child.jsonl'), onError: (e) => errors.push(e) });
    await expect(
      broken.record({ type: 'session-exit', sessionId: 's', exitCode: 0, reason: 'completed' }),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('skips a repeated v2 finalization after recorder reconstruction', async () => {
    const path = tmpLog();
    const first = createActionRecorder({ path, now: () => new Date('2026-08-16T20:00:01.000Z') });
    await expect(first.recordV2(finalizedRecord())).resolves.toMatchObject({ status: 'appended' });

    const restarted = createActionRecorder({ path, now: () => new Date('2026-08-16T20:01:00.000Z') });
    await expect(restarted.recordV2(finalizedRecord())).resolves.toMatchObject({ status: 'duplicate' });
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(await restarted.read()).toHaveLength(1);
  });

  it('reads mixed v1/v2 JSONL as a tagged migration union', async () => {
    const recorder = createActionRecorder({ path: tmpLog() });
    await recorder.record({ type: 'session-exit', sessionId: 'legacy-native', exitCode: 0, reason: 'completed' });
    await recorder.recordV2(finalizedRecord());

    expect((await recorder.readTagged()).map((entry) => entry.version)).toEqual(['v1', 'v2']);
    expect((await recorder.read()).map((entry) => entry.type)).toEqual(['session-exit', 'workspace.finalized']);
  });

  it('deduplicates physical at-least-once lines by recordId on read', async () => {
    const path = tmpLog();
    const recorder = createActionRecorder({ path });
    await recorder.recordV2(finalizedRecord());
    const line = await readFile(path, 'utf8');
    await appendFile(path, line, 'utf8');

    expect(await recorder.read()).toHaveLength(1);
  });

  it('rejects a conflicting semantic payload for an existing record id', async () => {
    const recorder = createActionRecorder({ path: tmpLog() });
    const first = finalizedRecord();
    await recorder.recordV2(first);
    await expect(recorder.recordV2({ ...first, filesTouchedCount: 99 })).resolves.toMatchObject({ status: 'failed' });
    expect(recorder.status()).toMatchObject({ readiness: 'degraded', failureCount: 1 });
    expect(await recorder.read()).toHaveLength(1);
  });

  it('persists injection metadata without prompt bodies or guessable digests by default', async () => {
    const path = tmpLog();
    const recorder = createActionRecorder({ path });
    await recorder.recordInjection({
      type: 'injection.receipt',
      recordId: createOwnActionRecordId('run-1', 'injection:one'),
      runtimeRunId: 'run-1',
      runtimeEpoch: 1,
      quality: 'exact',
      completeness: 'complete',
      injectionId: 'injection-one',
      prompt: 'credential-token and private prompt',
      outcome: 'confirmed',
    });

    const contents = await readFile(path, 'utf8');
    expect(contents).not.toContain('credential-token');
    expect(contents).not.toContain('private prompt');
    expect(contents).not.toContain('promptDigest');
    expect(await recorder.read()).toEqual([
      expect.objectContaining({
        type: 'injection.receipt',
        promptByteLength: 35,
        promptPersistence: 'metadata-only',
      }),
    ]);
  });

  it('supports explicit keyed-digest and bounded body policies', async () => {
    const keyed = createActionRecorder({
      path: tmpLog(),
      injectionPersistence: { mode: 'keyed-digest', key: new Uint8Array(32).fill(7) },
    });
    await keyed.recordInjection({
      type: 'injection.receipt',
      recordId: createOwnActionRecordId('run-1', 'injection:keyed'),
      runtimeRunId: 'run-1',
      runtimeEpoch: 1,
      quality: 'exact',
      completeness: 'complete',
      injectionId: 'injection-keyed',
      prompt: 'private',
      outcome: 'confirmed',
    });
    expect(await keyed.read()).toEqual([
      expect.objectContaining({
        promptPersistence: 'keyed-digest',
        promptDigest: { algorithm: 'hmac-sha256', value: expect.stringMatching(/^[0-9a-f]{64}$/) },
      }),
    ]);
    expect(JSON.stringify(await keyed.read())).not.toContain('private');

    const body = createActionRecorder({ path: tmpLog(), injectionPersistence: { mode: 'body', maxBytes: 3 } });
    await body.recordInjection({
      type: 'injection.receipt',
      recordId: createOwnActionRecordId('run-1', 'injection:body'),
      runtimeRunId: 'run-1',
      runtimeEpoch: 1,
      quality: 'exact',
      completeness: 'complete',
      injectionId: 'injection-body',
      prompt: 'four',
      outcome: 'confirmed',
    });
    expect(await body.read()).toEqual([
      expect.objectContaining({ promptPersistence: 'body-too-large', completeness: 'partial' }),
    ]);
  });

  it('returns failed v2 receipts and publishes sticky degradation without throwing', async () => {
    const fileAsParent = tmpLog();
    const seed = createActionRecorder({ path: fileAsParent });
    await seed.record({ type: 'session-exit', sessionId: 's', exitCode: 0, reason: 'completed' });
    const statuses: string[] = [];
    const broken = createActionRecorder({
      path: join(fileAsParent, 'child.jsonl'),
      onStatus: (status) => statuses.push(status.readiness),
    });

    await expect(broken.recordV2(finalizedRecord())).resolves.toMatchObject({ status: 'failed' });
    expect(broken.status()).toMatchObject({ readiness: 'degraded', failureCount: 1 });
    expect(statuses).toEqual(['degraded']);
  });
});
