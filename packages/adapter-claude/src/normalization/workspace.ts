import type { WorkspaceEvent, WorkspaceFileChange } from '@vibecook/puppeteer-core';
import type { ClaudeHookPayload } from './types.js';
import { claudeBoolean, claudeRecord, claudeString } from './wire.js';

function operationChange(tool: string, input: unknown): WorkspaceFileChange | undefined {
  const body = claudeRecord(input);
  const path = claudeString(body?.file_path);
  if (!body || !path) return undefined;

  if (tool.toLowerCase() === 'write') {
    const content = claudeString(body.content);
    return {
      path,
      kind: 'unknown',
      ...(content !== undefined
        ? {
            details: [
              { representation: 'write' as const, basis: 'tool-input' as const, content, mode: 'overwrite' as const },
            ],
          }
        : {}),
    };
  }
  if (tool.toLowerCase() !== 'edit') return undefined;

  const oldText = claudeString(body.old_string);
  const newText = claudeString(body.new_string);
  return {
    path,
    kind: 'modify',
    ...(oldText !== undefined && newText !== undefined
      ? {
          details: [
            {
              representation: 'replacement' as const,
              basis: 'tool-input' as const,
              oldText,
              newText,
              ...(claudeBoolean(body.replace_all) !== undefined ? { replaceAll: claudeBoolean(body.replace_all) } : {}),
            },
          ],
        }
      : {}),
  };
}

export function normalizeClaudeFileOperation(
  toolCallId: string,
  tool: string,
  input: unknown,
  phase: 'proposed' | 'applied' | 'failed',
): WorkspaceEvent | undefined {
  const change = operationChange(tool, input);
  if (!change) return undefined;
  return {
    type: 'workspace:file-operation',
    toolCallId,
    phase,
    changes: [change],
  };
}

export function normalizeClaudeFileChanged(body: ClaudeHookPayload): WorkspaceEvent | undefined {
  const path = claudeString(body.file_path);
  if (!path) return undefined;
  const nativeKind = claudeString(body.event);
  const kind: WorkspaceFileChange['kind'] =
    nativeKind === 'add'
      ? 'create'
      : nativeKind === 'change'
        ? 'modify'
        : nativeKind === 'unlink'
          ? 'delete'
          : 'unknown';
  return { type: 'workspace:file-changed', changes: [{ path, kind }] };
}
