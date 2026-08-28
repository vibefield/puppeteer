import type { WorkspaceEvent, WorkspaceFileChange } from '@vibecook/puppeteer-core';
import { type CategoryNormalization, type CodexNormalizationInput, rec, str } from './types.js';

function normalizeChange(value: unknown): WorkspaceFileChange | undefined {
  const change = rec(value);
  const path = str(change?.path);
  const nativeKind = rec(change?.kind);
  const kindType = str(nativeKind?.type);
  if (!change || !path || !nativeKind || !kindType) return undefined;

  let kind: WorkspaceFileChange['kind'] = 'unknown';
  let newPath: string | undefined;
  if (kindType === 'add') kind = 'create';
  else if (kindType === 'delete') kind = 'delete';
  else if (kindType === 'update') {
    newPath = str(nativeKind.move_path);
    kind = newPath ? 'move' : 'modify';
  }

  const diff = str(change.diff);
  const moveSuffix = newPath ? `\n\nMoved to: ${newPath}` : undefined;
  const updateDiff = moveSuffix && diff?.endsWith(moveSuffix) ? diff.slice(0, -moveSuffix.length) : diff;
  const details: WorkspaceFileChange['details'] =
    diff === undefined
      ? undefined
      : kindType === 'add'
        ? [{ representation: 'content', basis: 'native-file-operation', before: null, after: diff }]
        : kindType === 'delete'
          ? [{ representation: 'content', basis: 'native-file-operation', before: diff, after: null }]
          : kindType === 'update'
            ? [{ representation: 'unified-diff', basis: 'native-file-operation', text: updateDiff ?? '' }]
            : undefined;
  return {
    path,
    kind,
    ...(newPath ? { newPath } : {}),
    ...(details ? { details } : {}),
  };
}

function normalizeChanges(value: unknown): WorkspaceFileChange[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeChange).filter((change): change is WorkspaceFileChange => change !== undefined);
}

/** Codex fileChange items and patch updates -> Core workspace lifecycle. */
export class CodexWorkspaceNormalizer {
  normalize(input: CodexNormalizationInput): CategoryNormalization<WorkspaceEvent> {
    if (input.method === 'item/fileChange/patchUpdated') {
      const toolCallId = str(input.params.itemId);
      const changes = normalizeChanges(input.params.changes);
      return {
        handled: true,
        events:
          toolCallId && changes.length > 0
            ? [
                {
                  type: 'workspace:file-operation',
                  toolCallId,
                  phase: 'in-progress',
                  changes,
                },
              ]
            : [],
      };
    }

    if (input.method !== 'item/started' && input.method !== 'item/completed') {
      return { handled: false, events: [] };
    }
    const item = rec(input.params.item);
    if (str(item?.type) !== 'fileChange') return { handled: false, events: [] };

    const toolCallId = str(item?.id);
    const changes = normalizeChanges(item?.changes);
    if (!toolCallId || changes.length === 0) return { handled: true, events: [] };

    if (input.method === 'item/started') {
      return {
        handled: true,
        events: [
          {
            type: 'workspace:file-operation',
            toolCallId,
            phase: 'in-progress',
            changes,
          },
        ],
      };
    }

    const status = str(item?.status);
    if (status !== 'completed' && status !== 'failed' && status !== 'declined') {
      return { handled: true, events: [] };
    }
    return {
      handled: true,
      events: [
        {
          type: 'workspace:file-operation',
          toolCallId,
          phase: status === 'completed' ? 'applied' : 'failed',
          changes,
        },
      ],
    };
  }
}
