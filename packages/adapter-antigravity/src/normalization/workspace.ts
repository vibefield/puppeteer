import type { WorkspaceFileChange, WorkspaceFileOperationEvent } from '@vibecook/puppeteer-core';
import type { AntigravityToolFact } from './tool.js';
import { antigravityRecord, antigravityString } from './types.js';
function change(fact: AntigravityToolFact): WorkspaceFileChange | undefined {
  const lower = fact.tool.toLowerCase();
  if (!['write', 'replace', 'edit', 'patch', 'delete', 'move'].some((name) => lower.includes(name))) return undefined;
  const input = antigravityRecord(fact.input);
  const path =
    antigravityString(input?.AbsolutePath) ??
    antigravityString(input?.TargetFile) ??
    antigravityString(input?.path) ??
    antigravityString(input?.filePath);
  if (!path) return undefined;
  const oldText =
    typeof input?.TargetContent === 'string'
      ? input.TargetContent
      : typeof input?.oldText === 'string'
        ? input.oldText
        : typeof input?.old_string === 'string'
          ? input.old_string
          : undefined;
  const newText =
    typeof input?.ReplacementContent === 'string'
      ? input.ReplacementContent
      : typeof input?.newText === 'string'
        ? input.newText
        : typeof input?.new_string === 'string'
          ? input.new_string
          : undefined;
  const content =
    typeof input?.CodeContent === 'string'
      ? input.CodeContent
      : typeof input?.content === 'string'
        ? input.content
        : undefined;
  return {
    path,
    kind: lower.includes('delete')
      ? 'delete'
      : lower.includes('move')
        ? 'move'
        : lower.includes('replace') || lower.includes('edit') || lower.includes('patch')
          ? 'modify'
          : 'unknown',
    ...(oldText !== undefined && newText !== undefined
      ? { details: [{ representation: 'replacement', basis: 'tool-input', oldText, newText }] }
      : content !== undefined
        ? { details: [{ representation: 'write', basis: 'tool-input', content, mode: 'overwrite' }] }
        : {}),
  };
}
export function antigravityWorkspaceOperation(
  fact: AntigravityToolFact,
  phase: 'proposed' | 'applied' | 'failed',
): WorkspaceFileOperationEvent | undefined {
  const item = change(fact);
  return item ? { type: 'workspace:file-operation', toolCallId: fact.id, phase, changes: [item] } : undefined;
}
