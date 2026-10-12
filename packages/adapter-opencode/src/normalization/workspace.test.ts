import { describe, expect, it } from 'vitest';
import { safeParseAgentEvent } from '@vibefield/puppeteer-core';
import { OpenCodeWorkspaceNormalizer } from './workspace.js';

describe('OpenCodeWorkspaceNormalizer', () => {
  it('preserves replacement intent beside the native completed preview', () => {
    const normalizer = new OpenCodeWorkspaceNormalizer(32);
    const input = { filePath: '/repo/a.ts', oldString: 'old', newString: 'new' };
    const running = normalizer.normalizeToolPart({
      type: 'tool',
      tool: 'edit',
      callID: 'call-1',
      state: { status: 'running', input },
    });
    const completed = normalizer.normalizeToolPart({
      type: 'tool',
      tool: 'edit',
      callID: 'call-1',
      state: {
        status: 'completed',
        input,
        metadata: { filediff: { file: '/repo/a.ts', patch: '@@ -1 +1 @@', additions: 1, deletions: 1 } },
      },
    });

    expect(running).toMatchObject({
      type: 'workspace:file-operation',
      phase: 'in-progress',
      changes: [{ details: [{ representation: 'replacement', basis: 'tool-input' }] }],
    });
    expect(completed).toEqual({
      type: 'workspace:file-operation',
      toolCallId: 'call-1',
      phase: 'applied',
      changes: [
        {
          path: '/repo/a.ts',
          kind: 'modify',
          details: [
            {
              representation: 'replacement',
              basis: 'tool-input',
              oldText: 'old',
              newText: 'new',
            },
            {
              representation: 'diff-preview',
              basis: 'tool-result',
              text: '@@ -1 +1 @@',
              completeness: 'complete',
            },
          ],
          additions: 1,
          deletions: 1,
        },
      ],
    });
    expect(completed && safeParseAgentEvent(completed.type, completed).success).toBe(true);
  });

  it('maps apply_patch batches and direct watcher observations without conflating them', () => {
    const normalizer = new OpenCodeWorkspaceNormalizer(32);
    const applied = normalizer.normalizeToolPart({
      type: 'tool',
      tool: 'apply_patch',
      callID: 'call-2',
      state: {
        status: 'completed',
        input: { patchText: 'opaque aggregate patch' },
        metadata: {
          files: [
            { filePath: '/repo/new.ts', type: 'add', patch: 'new patch', additions: 2, deletions: 0 },
            { filePath: '/repo/old.ts', type: 'delete', patch: 'old patch', additions: 0, deletions: 3 },
          ],
        },
      },
    });
    const observed = normalizer.normalizeFileWatcher({
      id: 'evt-1',
      type: 'file.watcher.updated',
      properties: { file: '/repo/old.ts', event: 'unlink' },
    });

    expect(applied).toMatchObject({
      phase: 'applied',
      changes: [
        { kind: 'create', details: [{ representation: 'diff-preview', basis: 'tool-result' }] },
        { kind: 'delete', details: [{ representation: 'diff-preview', basis: 'tool-result' }] },
      ],
    });
    expect(observed).toEqual({
      type: 'workspace:file-changed',
      changes: [{ path: '/repo/old.ts', kind: 'delete' }],
    });
  });

  it('preserves empty replacement and write content', () => {
    const normalizer = new OpenCodeWorkspaceNormalizer(32);

    expect(
      normalizer.normalizeToolPart({
        type: 'tool',
        tool: 'edit',
        callID: 'call-empty-edit',
        state: {
          status: 'running',
          input: { filePath: '/repo/a.ts', oldString: 'remove me', newString: '' },
        },
      }),
    ).toMatchObject({
      changes: [
        {
          details: [{ representation: 'replacement', oldText: 'remove me', newText: '' }],
        },
      ],
    });

    expect(
      normalizer.normalizeToolPart({
        type: 'tool',
        tool: 'write',
        callID: 'call-empty-write',
        state: {
          status: 'running',
          input: { filePath: '/repo/empty.ts', content: '' },
        },
      }),
    ).toMatchObject({
      changes: [
        {
          details: [{ representation: 'write', content: '', mode: 'overwrite' }],
        },
      ],
    });
  });

  it('does not misread generic output truncation as preview truncation and preserves moves', () => {
    const normalizer = new OpenCodeWorkspaceNormalizer(32);
    const event = normalizer.normalizeToolPart({
      type: 'tool',
      tool: 'apply_patch',
      callID: 'call-truncated-output',
      state: {
        status: 'completed',
        input: { patchText: 'aggregate patch' },
        metadata: {
          truncated: true,
          outputPath: '/tmp/model-facing-output',
          files: [
            {
              filePath: '/repo/from.ts',
              movePath: '/repo/to.ts',
              type: 'move',
              patch: 'indentation-normalized preview',
              additions: 1,
              deletions: 1,
            },
          ],
        },
      },
    });

    expect(event).toMatchObject({
      changes: [
        {
          path: '/repo/from.ts',
          kind: 'move',
          newPath: '/repo/to.ts',
          details: [
            {
              representation: 'diff-preview',
              basis: 'tool-result',
              completeness: 'complete',
            },
          ],
        },
      ],
    });
    expect(event && safeParseAgentEvent(event.type, event).success).toBe(true);
  });

  it('does not map an unproven tool alias', () => {
    const normalizer = new OpenCodeWorkspaceNormalizer(32);
    expect(
      normalizer.normalizeToolPart({
        type: 'tool',
        tool: 'patch',
        callID: 'call-unproven',
        state: {
          status: 'completed',
          input: { path: '/repo/a.ts' },
          metadata: { filediff: { file: '/repo/a.ts', patch: 'diff' } },
        },
      }),
    ).toBeUndefined();
  });
});
