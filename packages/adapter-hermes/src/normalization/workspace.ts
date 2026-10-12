import type { WorkspaceEvent } from '@vibefield/puppeteer-core';
import { hermesRecord, hermesString } from './types.js';

/**
 * Hermes exposes a source-defined, bounded ANSI diff preview only on tool
 * completion. Pinned source proves args.path for write_file and patch; dynamic
 * skill_manage path resolution remains unsupported.
 */
export function normalizeHermesWorkspace(payload: Record<string, unknown>): WorkspaceEvent | undefined {
  const toolCallId = hermesString(payload.tool_id);
  const tool = hermesString(payload.name);
  if (tool !== 'write_file' && tool !== 'patch') return undefined;
  const args = hermesRecord(payload.args);
  const path = hermesString(args?.path);
  const diff = hermesString(payload.inline_diff);
  if (!toolCallId || !path || diff === undefined) return undefined;

  const result = hermesRecord(payload.result);
  const resultStatus = hermesString(result?.status);
  const failed =
    resultStatus === 'blocked' ||
    resultStatus === 'failed' ||
    result?.success === false ||
    Boolean(result?.error) ||
    (typeof result?.exit_code === 'number' && result.exit_code !== 0);
  return {
    type: 'workspace:file-operation',
    toolCallId,
    phase: failed ? 'failed' : 'applied',
    changes: [
      {
        path,
        kind: 'unknown',
        details: [
          {
            representation: 'diff-preview',
            basis: 'tool-result',
            text: diff,
            completeness: diff.includes('… omitted ') ? 'truncated' : 'complete',
          },
        ],
      },
    ],
  };
}
