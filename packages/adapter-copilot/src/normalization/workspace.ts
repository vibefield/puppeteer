import type { WorkspaceFileChange, WorkspaceFileOperationEvent } from '@vibefield/puppeteer-core';
import type { CopilotToolFact } from './tool.js';
import { copilotRecord, copilotString } from './types.js';

function toolChange(fact: CopilotToolFact): WorkspaceFileChange | undefined {
  const input = copilotRecord(fact.input);
  const path = copilotString(input?.path) ?? copilotString(input?.filePath) ?? copilotString(input?.fileName);
  if (!path) return undefined;
  const lower = fact.tool.toLowerCase();
  if (!['edit', 'write', 'create', 'patch'].some((name) => lower.includes(name))) return undefined;
  const oldText =
    typeof input?.oldText === 'string'
      ? input.oldText
      : typeof input?.old_string === 'string'
        ? input.old_string
        : undefined;
  const newText =
    typeof input?.newText === 'string'
      ? input.newText
      : typeof input?.new_string === 'string'
        ? input.new_string
        : undefined;
  const content =
    typeof input?.content === 'string'
      ? input.content
      : typeof input?.newFileContents === 'string'
        ? input.newFileContents
        : undefined;
  return {
    path,
    kind: lower.includes('create')
      ? 'create'
      : lower.includes('edit') || lower.includes('patch')
        ? 'modify'
        : 'unknown',
    ...(oldText !== undefined && newText !== undefined
      ? { details: [{ representation: 'replacement', basis: 'tool-input', oldText, newText }] }
      : content !== undefined
        ? { details: [{ representation: 'write', basis: 'tool-input', content, mode: 'overwrite' }] }
        : {}),
  };
}
export function copilotWorkspaceOperation(
  id: string,
  fact: CopilotToolFact,
  phase: 'proposed' | 'in-progress' | 'applied' | 'failed',
): WorkspaceFileOperationEvent | undefined {
  const change = toolChange(fact);
  return change ? { type: 'workspace:file-operation', toolCallId: id, phase, changes: [change] } : undefined;
}
export function normalizeCopilotWorkspace(type: string, data: Record<string, unknown>) {
  if (type !== 'session.workspace_file_changed') return undefined;
  const path = copilotString(data.path);
  if (!path) return [];
  const operation = copilotString(data.operation)?.toLowerCase();
  const kind: WorkspaceFileChange['kind'] =
    operation === 'created' || operation === 'create'
      ? 'create'
      : operation === 'deleted' || operation === 'delete'
        ? 'delete'
        : operation === 'modified' || operation === 'modify'
          ? 'modify'
          : 'unknown';
  return [{ type: 'workspace:file-changed' as const, changes: [{ path, kind }] }];
}
