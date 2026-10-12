import { describe, expect, it } from 'vitest';
import { safeParseAgentEvent } from '@vibefield/puppeteer-core';
import { normalizeHermesWorkspace } from './workspace.js';

describe('normalizeHermesWorkspace', () => {
  it('maps the source-defined patch preview without presenting it as a raw diff', () => {
    const event = normalizeHermesWorkspace({
      tool_id: 'tool-1',
      name: 'patch',
      args: { path: '/repo/a.ts' },
      result: { status: 'completed' },
      inline_diff: '  ┊ review diff\na/a.ts → b/a.ts\n… omitted 4 diff line(s)',
    });
    expect(event).toEqual({
      type: 'workspace:file-operation',
      toolCallId: 'tool-1',
      phase: 'applied',
      changes: [
        {
          path: '/repo/a.ts',
          kind: 'unknown',
          details: [
            {
              representation: 'diff-preview',
              basis: 'tool-result',
              text: '  ┊ review diff\na/a.ts → b/a.ts\n… omitted 4 diff line(s)',
              completeness: 'truncated',
            },
          ],
        },
      ],
    });
    expect(event && safeParseAgentEvent(event.type, event).success).toBe(true);
  });

  it('does not infer file semantics for dynamic or unproven tool paths', () => {
    expect(
      normalizeHermesWorkspace({ tool_id: 'tool-1', name: 'terminal', args: { path: '/repo' }, result: {} }),
    ).toBeUndefined();
    expect(
      normalizeHermesWorkspace({
        tool_id: 'tool-1',
        name: 'skill_manage',
        args: { path: 'SKILL.md' },
        inline_diff: 'diff',
      }),
    ).toBeUndefined();
    expect(
      normalizeHermesWorkspace({ tool_id: 'tool-1', name: 'write_file', args: {}, result: {}, inline_diff: 'diff' }),
    ).toBeUndefined();
  });
});
