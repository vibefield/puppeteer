import type { WorkspaceEvent, WorkspaceFileChange } from '@vibecook/puppeteer-core';
import { boundedKimiMapSet, kimiRecord, kimiString } from './types.js';

interface KimiWorkspaceOperation {
  change: WorkspaceFileChange;
}

function operation(tool: string, value: unknown): KimiWorkspaceOperation | undefined {
  const input = kimiRecord(value);
  const path = kimiString(input?.path);
  if (!input || !path) return undefined;
  if (tool.toLowerCase() === 'write') {
    const content = kimiString(input.content);
    const nativeMode = kimiString(input.mode);
    const mode = nativeMode === 'overwrite' || nativeMode === 'append' ? nativeMode : 'unknown';
    return {
      change: {
        path,
        kind: 'unknown',
        ...(content !== undefined
          ? { details: [{ representation: 'write', basis: 'tool-input', content, mode }] as const }
          : {}),
      },
    };
  }
  if (tool.toLowerCase() !== 'edit') return undefined;
  const oldText = kimiString(input.old_string);
  const newText = kimiString(input.new_string);
  return {
    change: {
      path,
      kind: 'modify',
      ...(oldText !== undefined && newText !== undefined
        ? {
            details: [
              {
                representation: 'replacement',
                basis: 'tool-input',
                oldText,
                newText,
                ...(typeof input.replace_all === 'boolean' ? { replaceAll: input.replace_all } : {}),
              },
            ] as const,
          }
        : {}),
    },
  };
}

/** Kimi's exact Write/Edit tool args plus tool results -> workspace lifecycle. */
export class KimiWorkspaceNormalizer {
  private readonly operations = new Map<string, KimiWorkspaceOperation>();

  call(loop: Record<string, unknown>): WorkspaceEvent | undefined {
    const toolCallId = kimiString(loop.toolCallId);
    const tool = kimiString(loop.name);
    if (!toolCallId || !tool) return undefined;
    const pending = operation(tool, loop.args);
    if (!pending) return undefined;
    boundedKimiMapSet(this.operations, toolCallId, pending);
    return {
      type: 'workspace:file-operation',
      toolCallId,
      phase: 'proposed',
      changes: [pending.change],
    };
  }

  result(loop: Record<string, unknown>, emit: boolean): WorkspaceEvent | undefined {
    const toolCallId = kimiString(loop.toolCallId);
    if (!toolCallId) return undefined;
    const pending = this.operations.get(toolCallId);
    this.operations.delete(toolCallId);
    if (!emit || !pending) return undefined;
    return {
      type: 'workspace:file-operation',
      toolCallId,
      phase: kimiRecord(loop.result)?.isError === true ? 'failed' : 'applied',
      changes: [pending.change],
    };
  }
}
