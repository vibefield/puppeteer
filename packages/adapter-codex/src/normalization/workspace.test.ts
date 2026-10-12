import { describe, expect, it } from 'vitest';
import { safeParseAgentEvent } from '@vibefield/puppeteer-core';
import { CodexWorkspaceNormalizer } from './workspace.js';

const changes = [
  { path: '/repo/new.ts', kind: { type: 'add' }, diff: 'new\n' },
  { path: '/repo/old.ts', kind: { type: 'delete' }, diff: 'old\n' },
  {
    path: '/repo/from.ts',
    kind: { type: 'update', move_path: '/repo/to.ts' },
    diff: '@@ -1 +1 @@\n-old\n+new\n\nMoved to: /repo/to.ts',
  },
];

describe('CodexWorkspaceNormalizer', () => {
  it('maps the kind-dependent native content/diff encoding without flattening moves', () => {
    const normalizer = new CodexWorkspaceNormalizer();
    const event = normalizer.normalize({
      method: 'item/fileChange/patchUpdated',
      params: { itemId: 'patch-1', changes },
    }).events[0]!;

    expect(event).toEqual({
      type: 'workspace:file-operation',
      toolCallId: 'patch-1',
      phase: 'in-progress',
      changes: [
        {
          path: '/repo/new.ts',
          kind: 'create',
          details: [{ representation: 'content', basis: 'native-file-operation', before: null, after: 'new\n' }],
        },
        {
          path: '/repo/old.ts',
          kind: 'delete',
          details: [{ representation: 'content', basis: 'native-file-operation', before: 'old\n', after: null }],
        },
        {
          path: '/repo/from.ts',
          kind: 'move',
          newPath: '/repo/to.ts',
          details: [
            {
              representation: 'unified-diff',
              basis: 'native-file-operation',
              text: '@@ -1 +1 @@\n-old\n+new',
            },
          ],
        },
      ],
    });
    expect(safeParseAgentEvent(event.type, event).success).toBe(true);
  });

  it('preserves an explicitly empty new file as reported content', () => {
    const normalizer = new CodexWorkspaceNormalizer();
    const event = normalizer.normalize({
      method: 'item/fileChange/patchUpdated',
      params: { itemId: 'empty-file', changes: [{ path: '/repo/empty.ts', kind: { type: 'add' }, diff: '' }] },
    }).events[0];

    expect(event).toMatchObject({
      changes: [
        {
          details: [{ representation: 'content', basis: 'native-file-operation', before: null, after: '' }],
        },
      ],
    });
  });

  it('does not guess the representation of a future unknown change kind', () => {
    const normalizer = new CodexWorkspaceNormalizer();
    const event = normalizer.normalize({
      method: 'item/fileChange/patchUpdated',
      params: {
        itemId: 'future-kind',
        changes: [{ path: '/repo/a.ts', kind: { type: 'future' }, diff: 'opaque' }],
      },
    }).events[0];

    expect(event).toMatchObject({ changes: [{ path: '/repo/a.ts', kind: 'unknown' }] });
    expect((event as { changes: Array<{ details?: unknown }> }).changes[0]?.details).toBeUndefined();
  });

  it('uses the native patch status to distinguish applied and failed operations', () => {
    const normalizer = new CodexWorkspaceNormalizer();
    const completed = normalizer.normalize({
      method: 'item/completed',
      params: { item: { type: 'fileChange', id: 'patch-1', status: 'completed', changes } },
    }).events[0];
    const declined = normalizer.normalize({
      method: 'item/completed',
      params: { item: { type: 'fileChange', id: 'patch-2', status: 'declined', changes } },
    }).events[0];

    expect(completed).toMatchObject({ phase: 'applied' });
    expect(declined).toMatchObject({ phase: 'failed' });
  });
});
