import { describe, expect, it } from 'vitest';
import { WorkspaceEventSchema, WorkspaceFileChangeDetailSchema } from './workspace.js';

describe('workspace events', () => {
  it('keeps proposed operations distinct from applied mutations', () => {
    expect(
      WorkspaceEventSchema.parse({
        type: 'workspace:file-operation',
        toolCallId: 'edit-1',
        phase: 'proposed',
        changes: [
          {
            path: '/repo/src/index.ts',
            kind: 'modify',
            details: [
              {
                representation: 'replacement',
                basis: 'tool-input',
                oldText: 'const before = true;',
                newText: 'const after = true;',
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ phase: 'proposed', changes: [{ kind: 'modify' }] });

    expect(
      WorkspaceEventSchema.parse({
        type: 'workspace:file-operation',
        toolCallId: 'edit-1',
        phase: 'applied',
        changes: [
          {
            path: '/repo/src/index.ts',
            kind: 'move',
            newPath: '/repo/src/main.ts',
            details: [
              {
                representation: 'unified-diff',
                basis: 'native-file-operation',
                text: '@@ -1 +1 @@',
              },
            ],
            additions: 1,
            deletions: 1,
          },
        ],
      }),
    ).toMatchObject({ phase: 'applied', changes: [{ newPath: '/repo/src/main.ts' }] });
  });

  it('models direct filesystem observations without inventing tool causality', () => {
    expect(
      WorkspaceEventSchema.parse({
        type: 'workspace:file-changed',
        changes: [{ path: '/repo/new.ts', kind: 'create' }],
      }),
    ).toEqual({
      type: 'workspace:file-changed',
      changes: [{ path: '/repo/new.ts', kind: 'create' }],
    });
  });

  it('labels rendered diff previews separately from raw unified diffs', () => {
    expect(
      WorkspaceFileChangeDetailSchema.parse({
        representation: 'diff-preview',
        basis: 'tool-result',
        text: '  ┊ review diff\na/file.ts → b/file.ts',
        completeness: 'truncated',
      }),
    ).toEqual({
      representation: 'diff-preview',
      basis: 'tool-result',
      text: '  ┊ review diff\na/file.ts → b/file.ts',
      completeness: 'truncated',
    });
  });

  it('rejects empty operations, invalid move metadata, missing content sides, and duplicate detail identities', () => {
    expect(
      WorkspaceEventSchema.safeParse({
        type: 'workspace:file-operation',
        toolCallId: 'edit-1',
        phase: 'applied',
        changes: [],
      }).success,
    ).toBe(false);
    expect(
      WorkspaceEventSchema.safeParse({
        type: 'workspace:file-changed',
        changes: [{ path: '/repo/a.ts', kind: 'modify', newPath: '/repo/b.ts' }],
      }).success,
    ).toBe(false);
    expect(
      WorkspaceFileChangeDetailSchema.safeParse({ representation: 'content', basis: 'native-file-operation' }).success,
    ).toBe(false);
    expect(
      WorkspaceEventSchema.safeParse({
        type: 'workspace:file-changed',
        changes: [
          {
            path: '/repo/a.ts',
            kind: 'modify',
            details: [
              { representation: 'write', basis: 'tool-input', content: '', mode: 'overwrite' },
              { representation: 'write', basis: 'tool-input', content: '', mode: 'overwrite' },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
