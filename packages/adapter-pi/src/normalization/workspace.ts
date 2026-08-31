import type { WorkspaceFileChange, WorkspaceFileOperationEvent } from '@vibecook/puppeteer-core';
import { piRecord, piString } from './types.js';
import type { PiToolFact } from './tool.js';

function changeFor(fact: PiToolFact): WorkspaceFileChange | undefined {
  const input = piRecord(fact.input);
  const path = piString(input?.path);
  if (!path) return undefined;
  const tool = fact.tool.toLowerCase();
  if (tool === 'write') {
    const content = typeof input?.content === 'string' ? input.content : undefined;
    return {
      path,
      kind: 'unknown',
      ...(content !== undefined
        ? { details: [{ representation: 'write', basis: 'tool-input', content, mode: 'overwrite' }] }
        : {}),
    };
  }
  if (tool !== 'edit') return undefined;
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
  return {
    path,
    kind: 'modify',
    ...(oldText !== undefined && newText !== undefined
      ? { details: [{ representation: 'replacement', basis: 'tool-input', oldText, newText }] }
      : {}),
  };
}

export function piWorkspaceOperation(
  toolCallId: string,
  fact: PiToolFact,
  phase: 'proposed' | 'applied' | 'failed',
): WorkspaceFileOperationEvent | undefined {
  const change = changeFor(fact);
  return change ? { type: 'workspace:file-operation', toolCallId, phase, changes: [change] } : undefined;
}
