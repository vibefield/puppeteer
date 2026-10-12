import { describe, expect, it } from 'vitest';
import { safeParseAgentEvent } from '@vibefield/puppeteer-core';
import { KimiWorkspaceNormalizer } from './workspace.js';

describe('KimiWorkspaceNormalizer', () => {
  it('maps exact Edit arguments as intent and closes them from the matching result', () => {
    const normalizer = new KimiWorkspaceNormalizer();
    const proposed = normalizer.call({
      type: 'tool.call',
      toolCallId: 'call-1',
      name: 'Edit',
      args: { path: '/repo/a.ts', old_string: 'old', new_string: 'new', replace_all: true },
    });
    const applied = normalizer.result(
      { type: 'tool.result', toolCallId: 'call-1', result: { isError: false, output: 'ok' } },
      true,
    );

    expect(proposed).toEqual({
      type: 'workspace:file-operation',
      toolCallId: 'call-1',
      phase: 'proposed',
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
              replaceAll: true,
            },
          ],
        },
      ],
    });
    expect(applied).toMatchObject({ phase: 'applied' });
    expect(applied && safeParseAgentEvent(applied.type, applied).success).toBe(true);
  });

  it('preserves append semantics and does not emit an uncorrelated result', () => {
    const normalizer = new KimiWorkspaceNormalizer();
    const proposed = normalizer.call({
      toolCallId: 'call-2',
      name: 'Write',
      args: { path: '/repo/log.txt', content: 'next\n', mode: 'append' },
    });
    expect(proposed).toMatchObject({
      changes: [{ details: [{ representation: 'write', basis: 'tool-input', mode: 'append' }] }],
    });
    expect(normalizer.result({ toolCallId: 'unknown', result: { isError: false } }, true)).toBeUndefined();
    expect(normalizer.result({ toolCallId: 'call-2', result: { isError: true } }, true)).toMatchObject({
      phase: 'failed',
    });
  });

  it('preserves empty write and replacement strings', () => {
    const normalizer = new KimiWorkspaceNormalizer();
    expect(
      normalizer.call({ toolCallId: 'empty-write', name: 'Write', args: { path: '/repo/empty', content: '' } }),
    ).toMatchObject({ changes: [{ details: [{ representation: 'write', content: '' }] }] });
    expect(
      normalizer.call({
        toolCallId: 'empty-replacement',
        name: 'Edit',
        args: { path: '/repo/a', old_string: 'remove', new_string: '' },
      }),
    ).toMatchObject({ changes: [{ details: [{ representation: 'replacement', newText: '' }] }] });
  });
});
